#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按技能名从 RedSkill（小红书技能库）取回 SKILL.md 正文，零新依赖。

接口（公开、无鉴权）：
    GET https://edith.xiaohongshu.com/api/sns/v1/creator/red_skill/get_skill_bundle?identifier=<id>
    -> {"code": 0, "success": true, "data": {"zip_url", "sha256", "identifier", "version", ...}}

用户只要说一个技能名（redskill:<id> 或裸标识符）就能安装，不再让用户自己找 install.md。
技能正文里常见「读取 references/xxx.md」，而 NOVAI 技能只有一段 markdown 正文，
所以把 references/ 下的 .md 内联追加成附录。

安全口径：
- 接口给的 zip_url 是 http，只升级成 https；最终主机必须是 https 且域名以 .xhscdn.com 结尾；
- 下载后必须与接口声明的 sha256 完全一致，否则拒绝安装；
- 解压只读普通文件，拒绝绝对路径 / .. / 目录穿越 / 符号链接，限制总解压体积防 zip 炸弹；
- 请求头只有 UA + Accept，绝不携带 GitHub 令牌或用户凭据；重定向逐跳按同一规则校验。
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
import zipfile

API_URL = "https://edith.xiaohongshu.com/api/sns/v1/creator/red_skill/get_skill_bundle"
CDN_HOST_SUFFIX = ".xhscdn.com"
MAX_MARKDOWN_BYTES = 1024 * 1024
MAX_BUNDLE_BYTES = 10 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024
MAX_JSON_BYTES = 1024 * 1024
MAX_SKILL_DEPTH = 3
TIMEOUT_SECONDS = 20
_MAX_REDIRECTS = 3
_REDIRECT_CODES = frozenset((301, 302, 303, 307, 308))
_USER_AGENT = "NOVAI-skill-installer/1.0"
_IDENTIFIER_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_PREFIX_RE = re.compile(r"^redskill:(?://)?", re.IGNORECASE)
_NETWORK_ERRORS = (urllib.error.URLError, OSError, ssl.SSLError)

_SSL_CONTEXT = None


class RedSkillError(ValueError):
    """RedSkill 取包/校验失败（消息直接给用户看，status_code 给 HTTP 层用）。"""

    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


def _ssl_context():
    """优先用项目已有依赖 certifi 的 CA（没装 certifi 也不会新增依赖，回退系统默认）。"""
    global _SSL_CONTEXT
    if _SSL_CONTEXT is None:
        try:
            import certifi
            _SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
        except Exception:
            _SSL_CONTEXT = ssl.create_default_context()
    return _SSL_CONTEXT


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """重定向不自动跟，逐跳校验目标主机。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def urlopen(request, timeout=TIMEOUT_SECONDS):
    """带 TLS 校验、不自动跟随重定向的 urlopen（测试里 monkeypatch 它模拟网络）。"""
    opener = urllib.request.build_opener(
        _NoRedirect, urllib.request.HTTPSHandler(context=_ssl_context()))
    return opener.open(request, timeout=timeout)


def parse_redskill_ref(value):
    """redskill:<id> / redskill://<id> / 裸标识符 -> id；URL 或非法串 -> None。"""
    text = str(value or "").strip()
    if not text:
        return None
    match = _PREFIX_RE.match(text)
    if match:
        identifier = text[match.end():].strip()
        return identifier if _IDENTIFIER_RE.match(identifier) else None
    if any(ch in text for ch in "/:?#") or any(ch.isspace() for ch in text):
        return None
    if text.lower().endswith((".md", ".zip", ".json", ".html", ".htm")):
        return None
    return text if _IDENTIFIER_RE.match(text) else None


def _describe_network_error(exc):
    reason = getattr(exc, "reason", None) or exc
    return str(reason or type(exc).__name__)


def _read_api_json(raw):
    if len(raw) > MAX_JSON_BYTES:
        raise RedSkillError("RedSkill 接口返回的数据超过 1MB 上限", 502)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise RedSkillError("RedSkill 接口返回的不是合法 JSON，请稍后重试", 502)
    if not isinstance(payload, dict):
        raise RedSkillError("RedSkill 接口返回格式不对（不是 JSON 对象）", 502)
    return payload


def _api_error_message(identifier, code, msg):
    text = str(msg or "").strip()
    lowered = text.lower()
    if code in (404, 10001) or "不存在" in text or "not found" in lowered or "not exist" in lowered:
        return "RedSkill 上找不到技能：%s（技能名可能写错或已下架；请确认技能标识符）" % identifier, 404
    detail = "（接口返回 code=%s" % code
    if text:
        detail += "，msg=%s" % text[:120]
    detail += "）"
    return "RedSkill 接口返回错误%s，请稍后重试" % detail, 502


def _fetch_bundle_meta(identifier):
    url = "%s?identifier=%s" % (API_URL, urllib.parse.quote(identifier, safe=""))
    request = urllib.request.Request(url, headers={
        "User-Agent": _USER_AGENT,
        "Accept": "application/json",
    })
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_JSON_BYTES + 1)
    except urllib.error.HTTPError as exc:
        code = exc.code
        try:
            exc.close()
        except Exception:
            pass
        if code == 404:
            raise RedSkillError(
                "RedSkill 上找不到技能：%s（技能名可能写错或已下架；请确认技能标识符）" % identifier, 404)
        raise RedSkillError("RedSkill 接口请求失败（HTTP %s），请稍后重试" % code, 502)
    except _NETWORK_ERRORS as exc:
        raise RedSkillError(
            "无法连接 RedSkill 接口：%s；请检查网络或代理后重试" % _describe_network_error(exc), 502)

    payload = _read_api_json(raw)
    code = payload.get("code", 0)
    try:
        code = int(code)
    except (TypeError, ValueError):
        code = -1
    if code != 0 or payload.get("success") is False:
        message, status = _api_error_message(identifier, code, payload.get("msg"))
        raise RedSkillError(message, status)
    data = payload.get("data")
    if not isinstance(data, dict):
        raise RedSkillError("RedSkill 接口没有返回技能包信息（data 为空），请稍后重试", 502)
    return data


def _secure_zip_url(value):
    raw = str(value or "").strip()
    if not raw:
        raise RedSkillError("RedSkill 接口没有返回技能包下载地址，请稍后重试", 502)
    if raw.lower().startswith("http://"):
        raw = "https://" + raw[len("http://"):]
    try:
        parsed = urllib.parse.urlparse(raw)
        host = (parsed.hostname or "").lower()
    except ValueError:
        raise RedSkillError("RedSkill 返回的技能包下载地址不合法，已拒绝安装", 502)
    if (parsed.scheme != "https" or parsed.username or parsed.password
            or not host.endswith(CDN_HOST_SUFFIX)
            or host == CDN_HOST_SUFFIX.lstrip(".")):
        raise RedSkillError(
            "RedSkill 返回的技能包下载地址不可信（只接受 https 的 *%s 主机）：%s，已拒绝安装"
            % (CDN_HOST_SUFFIX, raw), 502)
    return raw


def _download_bundle(zip_url):
    target = zip_url
    for _hop in range(_MAX_REDIRECTS + 1):
        target = _secure_zip_url(target)
        request = urllib.request.Request(target, headers={
            "User-Agent": _USER_AGENT,
            "Accept": "application/zip, application/octet-stream, */*",
        })
        try:
            with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                raw = response.read(MAX_BUNDLE_BYTES + 1)
                break
        except urllib.error.HTTPError as exc:
            code = exc.code
            location = ""
            try:
                location = exc.headers.get("Location") or "" if exc.headers else ""
            except Exception:
                location = ""
            try:
                exc.close()
            except Exception:
                pass
            if code in _REDIRECT_CODES and location:
                target = urllib.parse.urljoin(target, location)
                continue
            if code == 404:
                raise RedSkillError("技能包下载失败（HTTP 404）：包可能已被清理，请稍后重试", 502)
            raise RedSkillError("技能包下载失败（HTTP %s），请稍后重试" % code, 502)
        except _NETWORK_ERRORS as exc:
            raise RedSkillError(
                "无法下载 RedSkill 技能包：%s；请检查网络或代理后重试" % _describe_network_error(exc), 502)
    else:
        raise RedSkillError("技能包下载重定向超过 %d 跳，已停止" % _MAX_REDIRECTS, 502)
    if len(raw) > MAX_BUNDLE_BYTES:
        raise RedSkillError(
            "RedSkill 技能包超过 10MB 上限（已读取 %d 字节），已拒绝安装" % len(raw), 413)
    return raw


def _verify_sha256(raw, declared):
    expected = str(declared or "").strip().lower()
    if not _SHA256_RE.match(expected):
        raise RedSkillError("RedSkill 接口没有返回有效的 sha256，无法校验技能包完整性，已拒绝安装", 502)
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected:
        raise RedSkillError(
            "技能包校验失败：sha256 与接口声明不一致（接口 %s，实际 %s），已拒绝安装"
            % (expected, actual), 502)
    return actual


def _archive_entries(archive):
    """校验 zip 条目安全性，返回 {规范化相对路径: ZipInfo}；不读内容。"""
    entries = {}
    for info in archive.infolist():
        name = str(info.filename or "").replace("\\", "/")
        if not name or name.endswith("/"):
            continue
        if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
            raise RedSkillError("技能包不安全：条目 %r 使用了绝对路径，已拒绝安装" % name, 422)
        parts = [part for part in name.split("/") if part not in ("", ".")]
        if not parts or any(part == ".." for part in parts):
            raise RedSkillError("技能包不安全：条目 %r 含有上级目录（..），已拒绝安装" % name, 422)
        mode = (info.external_attr >> 16) & 0o170000
        if mode == 0o120000:
            raise RedSkillError("技能包不安全：条目 %r 是符号链接，已拒绝安装" % name, 422)
        if mode not in (0, 0o100000):
            raise RedSkillError("技能包不安全：条目 %r 不是普通文件，已拒绝安装" % name, 422)
        normalized = "/".join(parts)
        if normalized in entries:
            raise RedSkillError("技能包格式异常：条目 %r 重复出现，已拒绝安装" % normalized, 422)
        entries[normalized] = info
    return entries


def _read_bundle(raw):
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except (zipfile.BadZipFile, OSError):
        raise RedSkillError("技能包校验失败：下载到的不是有效的 zip 包", 502)
    with archive:
        entries = _archive_entries(archive)
        total = 0
        for info in entries.values():
            total += int(info.file_size or 0)
            if total > MAX_UNCOMPRESSED_BYTES:
                raise RedSkillError(
                    "技能包解压后超过 20MB 上限（疑似异常压缩包），已拒绝安装", 413)
        files = {}
        for name, info in entries.items():
            try:
                files[name] = archive.read(info)
            except Exception as exc:
                raise RedSkillError("技能包解压失败：%s（%s）" % (name, exc), 422)
    return files


def _find_skill_md(files):
    candidates = [name for name in files if name.rsplit("/", 1)[-1].lower() == "skill.md"]
    root = [name for name in candidates if "/" not in name]
    if root:
        return root[0]
    shallow = [name for name in candidates if len(name.split("/")) - 1 <= MAX_SKILL_DEPTH]
    if len(shallow) == 1:
        return shallow[0]
    if len(shallow) > 1:
        raise RedSkillError(
            "技能包里有多份 SKILL.md，无法确定用哪个：%s" % "、".join(sorted(shallow)[:5]), 422)
    if candidates:
        raise RedSkillError(
            "技能包里的 SKILL.md 目录层级超过 %d 层，已拒绝安装：%s"
            % (MAX_SKILL_DEPTH, sorted(candidates)[0]), 422)
    listing = "、".join(sorted(files)[:5]) or "（空包）"
    raise RedSkillError("技能包里没有 SKILL.md（RedSkill 技能包不完整）；包内文件：%s" % listing, 422)


def _decode_text(raw, label):
    if len(raw) > MAX_MARKDOWN_BYTES:
        raise RedSkillError("%s 超过 1MB 上限" % label, 413)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise RedSkillError("%s 不是 UTF-8 文本，已拒绝安装" % label, 422)


def _build_markdown(files, skill_path):
    markdown = _decode_text(files[skill_path], "SKILL.md")
    head = skill_path.rsplit("/", 1)[0] if "/" in skill_path else ""
    base = head + "/" if head else ""
    prefix = base + "references/"
    references = sorted(
        name for name in files
        if name.startswith(prefix) and name.lower().endswith(".md"))
    parts = [markdown.rstrip("\n")]
    for name in references:
        content = _decode_text(files[name], name)
        if not content.strip():
            continue
        parts.append("\n\n---\n\n## 附录：%s（随技能包内联）\n\n%s"
                     % (name[len(base):], content.strip("\n")))
    combined = "\n".join(parts) + "\n"
    if len(combined.encode("utf-8")) > MAX_MARKDOWN_BYTES:
        raise RedSkillError("技能正文（含 references 附录）超过 1MB 上限，已拒绝安装", 413)
    return combined


def fetch_skill_bundle(identifier):
    """按技能名取包并返回 {markdown, identifier, version, sha256, bundle_files, source_url}。"""
    identifier = str(identifier or "").strip()
    if not _IDENTIFIER_RE.match(identifier):
        raise RedSkillError(
            "RedSkill 技能名不合法：%r（只能用小写字母、数字、- 和 _，以字母或数字开头，最长 64 位）"
            % identifier, 400)
    data = _fetch_bundle_meta(identifier)
    declared_identifier = str(data.get("identifier") or "").strip()
    if declared_identifier and declared_identifier != identifier:
        raise RedSkillError(
            "RedSkill 接口返回的技能标识不一致（请求 %s，返回 %s），已拒绝安装"
            % (identifier, declared_identifier), 502)
    zip_url = _secure_zip_url(data.get("zip_url"))
    raw = _download_bundle(zip_url)
    digest = _verify_sha256(raw, data.get("sha256"))
    files = _read_bundle(raw)
    skill_path = _find_skill_md(files)
    markdown = _build_markdown(files, skill_path)
    return {
        "markdown": markdown,
        "identifier": identifier,
        "version": str(data.get("version") or "").strip(),
        "sha256": digest,
        "bundle_files": sorted(files),
        "source_url": zip_url,
    }
