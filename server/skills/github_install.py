#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 GitHub 受控读取 SKILL.md，不克隆或执行仓库内容。"""
from __future__ import annotations

import json
import os
import re
import ssl
import certifi
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

MAX_MARKDOWN_BYTES = 1024 * 1024
TIMEOUT_SECONDS = 15
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


class GitHubSkillError(ValueError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class GitHubSource:
    owner: str
    repo: str
    ref: str
    path: str

    @property
    def repository(self):
        return "%s/%s" % (self.owner, self.repo)


def _valid_part(value, label):
    value = str(value or "").strip()
    if not _NAME_RE.match(value) or value in (".", ".."):
        raise GitHubSkillError("%s 不合法" % label)
    return value


def _valid_path(value):
    path = str(value or "").strip().strip("/")
    if not path or "\\" in path or any(part in ("", ".", "..") for part in path.split("/")):
        raise GitHubSkillError("SKILL.md 路径不合法")
    if len(path) > 512:
        raise GitHubSkillError("SKILL.md 路径最长 512 字符")
    return path


def parse_github_url(url, path="", ref=""):
    raw_url = str(url or "").strip()
    try:
        parsed = urllib.parse.urlparse(raw_url)
    except ValueError:
        raise GitHubSkillError("GitHub 地址不合法")
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise GitHubSkillError("只支持 HTTPS GitHub 地址")
    if host == "www.github.com":
        host = "github.com"
    parts = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
    if host == "raw.githubusercontent.com":
        if len(parts) < 4:
            raise GitHubSkillError("Raw 地址需要包含 owner/repo/ref/path")
        owner, repo, source_ref = parts[:3]
        source_path = "/".join(parts[3:])
    elif host == "github.com":
        if len(parts) < 2:
            raise GitHubSkillError("GitHub 地址需要包含 owner/repo")
        owner, repo = parts[:2]
        if repo.endswith(".git"):
            repo = repo[:-4]
        source_ref = ""
        source_path = ""
        if len(parts) > 2:
            if parts[2] not in ("tree", "blob") or len(parts) < 4:
                raise GitHubSkillError("请提供仓库根地址、/tree/ 或 /blob/ 地址")
            source_ref = parts[3]
            source_path = "/".join(parts[4:])
    else:
        raise GitHubSkillError("只支持 github.com 或 raw.githubusercontent.com 地址")
    owner = _valid_part(owner, "仓库 owner")
    repo = _valid_part(repo, "仓库名")
    final_ref = str(ref or source_ref or "").strip()
    if len(final_ref) > 255 or "\\" in final_ref or final_ref.startswith("/") or ".." in final_ref.split("/"):
        raise GitHubSkillError("Git 分支或标签不合法")
    final_path = str(path or source_path or "").strip()
    if final_path:
        final_path = _valid_path(final_path)
    return GitHubSource(owner=owner, repo=repo, ref=final_ref, path=final_path)


def _request_bytes(url, token):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "NOVAI-Skill-Installer/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    context = ssl.create_default_context(cafile=certifi.where())
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS, context=context) as response:
            return response.read(MAX_MARKDOWN_BYTES + 1)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise GitHubSkillError("仓库、分支或 SKILL.md 不存在；私有仓库请配置有效令牌", 404)
        if exc.code in (401, 403):
            raise GitHubSkillError("GitHub 拒绝访问；请检查仓库权限或访问令牌", 403)
        if exc.code == 429:
            raise GitHubSkillError("GitHub 请求过于频繁，请稍后重试", 429)
        raise GitHubSkillError("GitHub 返回 HTTP %s" % exc.code, 502)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise GitHubSkillError("无法连接 GitHub：%s" % str(reason), 502)


def _json(url, token):
    raw = _request_bytes(url, token)
    if len(raw) > MAX_MARKDOWN_BYTES:
        raise GitHubSkillError("GitHub 响应超过 1MB 上限", 413)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise GitHubSkillError("GitHub 返回了无法解析的数据", 502)


def _resolve_source(source, token):
    ref = source.ref
    if not ref:
        meta = _json("https://api.github.com/repos/%s/%s" % (source.owner, source.repo), token)
        ref = str(meta.get("default_branch") or "").strip()
        if not ref:
            raise GitHubSkillError("无法确定仓库默认分支", 502)
    path = source.path
    if not path:
        tree_url = "https://api.github.com/repos/%s/%s/git/trees/%s?recursive=1" % (
            source.owner, source.repo, urllib.parse.quote(ref, safe=""))
        tree = _json(tree_url, token)
        candidates = [str(item.get("path") or "") for item in tree.get("tree") or []
                      if item.get("type") == "blob" and (item.get("path") == "SKILL.md" or str(item.get("path") or "").endswith("/SKILL.md"))]
        if not candidates:
            raise GitHubSkillError("仓库中没有 SKILL.md，请指定文件路径", 404)
        if len(candidates) > 1:
            raise GitHubSkillError("仓库中有多个 SKILL.md，请用 path 指定一个：%s" % "、".join(candidates[:5]))
        path = candidates[0]
    return source.owner, source.repo, ref, _valid_path(path)


def fetch_skill_markdown(url, path="", ref=""):
    source = parse_github_url(url, path=path, ref=ref)
    token = os.environ.get("NOVAI_GITHUB_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
    owner, repo, final_ref, final_path = _resolve_source(source, token)
    raw_url = "https://raw.githubusercontent.com/%s/%s/%s/%s" % (
        owner, repo, urllib.parse.quote(final_ref, safe="/"), urllib.parse.quote(final_path, safe="/"))
    raw = _request_bytes(raw_url, token)
    if len(raw) > MAX_MARKDOWN_BYTES:
        raise GitHubSkillError("SKILL.md 超过 1MB 上限", 413)
    try:
        markdown = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise GitHubSkillError("SKILL.md 必须是 UTF-8 文本")
    return {
        "markdown": markdown,
        "repository": "%s/%s" % (owner, repo),
        "ref": final_ref,
        "path": final_path,
        "source_url": raw_url,
    }
