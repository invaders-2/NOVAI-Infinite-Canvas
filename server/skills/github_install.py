#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 GitHub 受控读取 SKILL.md，不克隆或执行仓库内容。

网络容错（本机 raw.githubusercontent.com / jsDelivr 偶发被 TLS 重置 → SSL EOF）：
- 网络级失败单宿主最多 3 次尝试（退避 0.4s / 0.9s），HTTP 5xx 只重试一次，4xx 不重试；
- 代理：HTTPS_PROXY/HTTP_PROXY 环境变量优先，macOS 没有环境变量时读 scutil --proxy；
- SKILL.md 原文依次尝试 raw → api contents → jsdelivr，全失败才报错并写清试过哪些主机；
- 省 API 配额：分支与路径能确定时只走 raw/jsdelivr；缺分支先猜 main/master，缺路径才查目录树；
- API 被限流（60 次/小时/IP）时降级到 jsDelivr Data API 猜分支 + 枚举 SKILL.md，成功就正常安装；
- 配了「令牌中转」（token_store.github_relay）时全部经中转走，客户端不再读本地令牌也不直连 GitHub。

安全口径：GitHub 链路仍只访问白名单主机的 https，重定向不出白名单；其它 HTTPS 直链要求
主机解析出的所有 IP 都是公网地址、逐跳手动校验重定向（最多 3 跳）；1MB 上限，不执行仓库
内容，绝不把 GitHub 令牌发给非 GitHub 主机。
"""
from __future__ import annotations

import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

import certifi

from server.skills import token_store

MAX_MARKDOWN_BYTES = 1024 * 1024
TIMEOUT_SECONDS = 15
VERIFY_TIMEOUT_SECONDS = 5
RATE_LIMIT_URL = "https://api.github.com/rate_limit"
RELAY_TIMEOUT_SECONDS = 20
_MAX_ATTEMPTS = 3
_RETRY_DELAYS = (0.4, 0.9)
_DEFAULT_BRANCH_GUESSES = ("main", "master")
_ALLOWED_HOSTS = frozenset(("github.com", "raw.githubusercontent.com", "api.github.com",
                            "cdn.jsdelivr.net", "data.jsdelivr.com"))
# 用户直接粘贴、走上面这套 GitHub 专用流程的主机；其余 https 主机走通用直链下载
_GITHUB_URL_HOSTS = frozenset(("github.com", "www.github.com", "raw.githubusercontent.com", "api.github.com"))
_MAX_REDIRECTS = 3
_REDIRECT_CODES = frozenset((301, 302, 303, 307, 308))
# 只给 GitHub 自己回令牌，避免粘贴的 GITHUB_TOKEN 漏给 CDN 或任意直链主机
_TOKEN_HOSTS = frozenset(("raw.githubusercontent.com", "api.github.com"))
_JSON_ACCEPT = "application/vnd.github+json"
_RAW_ACCEPT = "application/vnd.github.raw"
_PROXY_HINT = "请检查网络或代理（TLS 被拦截时也会这样）"
_TOKEN_HINT = "或配置环境变量 NOVAI_GITHUB_TOKEN 提高配额"
_ADDRESS_HINT = "或改用带分支和目录的地址（例如 https://github.com/owner/repo/tree/main/skills/xxx，这种地址不消耗 API 次数）"
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")

_SYSTEM_PROXY = None        # None=未探测，""=直连
_SSL_CONTEXT = None


class GitHubSkillError(ValueError):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


class RateLimitError(GitHubSkillError):
    """api.github.com 配额用尽（429 或 403+remaining=0）：可以先降级 jsDelivr 再决定报错。"""


class RepoNotFoundError(GitHubSkillError):
    """仓库不存在：单独一类，避免被限流降级或网络错误盖住。"""


class RelayUnavailable(GitHubSkillError):
    """令牌中转连不上：单独一类，别伪装成"仓库不存在"。"""

    def __init__(self, relay_url, reason=""):
        detail = "中转服务连不上：%s（请检查中转是否在线）" % relay_url
        if reason:
            detail += "；错误：%s" % reason
        super().__init__(detail, 502)
        self.relay_url = relay_url


class JsdelivrUnavailable(Exception):
    """备用源 jsDelivr 自己连不上（网络级）：降级失败时仍报限流。"""


class HostUnavailable(Exception):
    """当前宿主拿不到应答（网络级失败或 5xx）：可以换备用源再试。"""

    def __init__(self, host, reason, http_status=None):
        super().__init__("%s: %s" % (host, reason))
        self.host = host
        self.reason = reason
        self.http_status = http_status


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


# ---------------------------------------------------------------------------
# 代理 / TLS / 重定向
# ---------------------------------------------------------------------------

def _host_of(url):
    try:
        return (urllib.parse.urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def _assert_allowed_url(url):
    """出站地址只允许白名单主机的 https，且不带账号口令。"""
    try:
        parsed = urllib.parse.urlparse(str(url or ""))
    except ValueError:
        raise GitHubSkillError("拒绝访问非法地址")
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in _ALLOWED_HOSTS or parsed.username or parsed.password:
        raise GitHubSkillError("拒绝访问非白名单地址：%s" % url)


def _scutil_value(text, key):
    match = re.search(r"^\s*%s\s*:\s*(\S+)\s*$" % re.escape(key), text or "", re.MULTILINE)
    return match.group(1) if match else ""


def _parse_scutil_proxy(text):
    """解析 scutil --proxy 输出：只认 Enable=1 且有主机名的 HTTPS/HTTP 代理。"""
    for prefix in ("HTTPS", "HTTP"):
        if _scutil_value(text, prefix + "Enable") != "1":
            continue
        host = _scutil_value(text, prefix + "Proxy")
        if not host:
            continue
        port = _scutil_value(text, prefix + "Port") or ("443" if prefix == "HTTPS" else "80")
        return "http://%s:%s" % (host, port)
    return ""


def _system_proxy():
    """macOS 系统代理；结果模块级缓存，读不到就静默降级为直连。"""
    global _SYSTEM_PROXY
    if _SYSTEM_PROXY is not None:
        return _SYSTEM_PROXY
    proxy = ""
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["scutil", "--proxy"], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, timeout=2)
            proxy = _parse_scutil_proxy(out.stdout.decode("utf-8", "replace"))
        except Exception:
            proxy = ""
    _SYSTEM_PROXY = proxy
    return proxy


def _no_proxy_hit(host):
    raw = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    for item in raw.replace(" ", ",").split(","):
        item = str(item or "").strip().lower().lstrip(".")
        if not item:
            continue
        if item == "*" or host == item or host.endswith("." + item):
            return True
    return False


def _proxy_for(url):
    host = _host_of(url)
    if _no_proxy_hit(host):
        return ""
    for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        value = str(os.environ.get(key) or "").strip()
        if value:
            return value
    return _system_proxy()


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """重定向只能落在白名单主机；跨主机的重定向丢掉令牌。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _assert_allowed_url(newurl)
        request = super().redirect_request(req, fp, code, msg, headers, newurl)
        if request is not None and _host_of(newurl) != _host_of(req.full_url):
            request.remove_header("Authorization")
        return request


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """通用直链：不自动跟随，30x 以 HTTPError 抛回给调用方逐跳校验。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _ssl_context():
    global _SSL_CONTEXT
    if _SSL_CONTEXT is None:
        _SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
    return _SSL_CONTEXT


def _build_opener(url, follow_redirects=True):
    """显式装 ProxyHandler：传空字典即直连，避免 urllib 悄悄用上别的环境代理。"""
    proxy = _proxy_for(url)
    proxies = {"https": proxy, "http": proxy} if proxy else {}
    redirect = _SafeRedirectHandler() if follow_redirects else _NoRedirectHandler()
    return urllib.request.build_opener(
        urllib.request.ProxyHandler(proxies),
        urllib.request.HTTPSHandler(context=_ssl_context()),
        redirect,
    )


def urlopen(request, timeout=TIMEOUT_SECONDS, follow_redirects=True):
    """带代理与重定向校验的 urlopen（测试里 monkeypatch 它模拟网络故障）。"""
    return _build_opener(request.full_url, follow_redirects=follow_redirects).open(
        request, timeout=timeout)


# ---------------------------------------------------------------------------
# 单次请求 / 单宿主重试 / 限流识别
# ---------------------------------------------------------------------------

_NETWORK_ERRORS = (urllib.error.URLError, ssl.SSLError, TimeoutError, ConnectionError,
                   http.client.HTTPException, OSError)


def _describe_network_error(exc):
    reason = getattr(exc, "reason", exc)
    name = type(reason).__name__
    text = str(reason).strip()
    if not text or text == name or text.startswith(name + ":"):
        return name
    return "%s: %s" % (name, text)


def _header_value(headers, name):
    """响应头大小写不敏感读取：HTTPError.headers 是 email.Message，测试里可能是 dict。"""
    if headers is None:
        return ""
    try:
        value = headers.get(name)
    except Exception:
        value = None
    if value is not None:
        return str(value).strip()
    try:
        keys = list(headers.keys())
    except Exception:
        return ""
    for key in keys:
        if str(key).lower() == name.lower():
            try:
                return str(headers[key] or "").strip()
            except Exception:
                return ""
    return ""


def _is_rate_limited(code, headers):
    if code == 429:
        return True
    # 未认证配额用尽时 GitHub 也回 403，只能靠 remaining=0 认出来
    return _header_value(headers, "x-ratelimit-remaining") == "0"


def _rate_limit_error(headers):
    reset = _header_value(headers, "x-ratelimit-reset")
    minutes = 0
    if reset.isdigit():
        seconds = int(reset) - int(time.time())
        minutes = max(1, (seconds + 59) // 60) if seconds > 0 else 1
    if minutes:
        detail = "GitHub API 访问次数已达上限，请等待 %d 分钟后再试；%s；%s" % (
            minutes, _TOKEN_HINT, _ADDRESS_HINT)
    else:
        detail = "GitHub API 访问次数已达上限，请稍后重试；%s；%s" % (_TOKEN_HINT, _ADDRESS_HINT)
    return RateLimitError(detail, 429)


def _request_headers(url, token, accept):
    host = _host_of(url)
    headers = {"User-Agent": "NOVAI-Skill-Installer/1.0"}
    if host in ("cdn.jsdelivr.net", "data.jsdelivr.com"):
        # jsDelivr 不认 GitHub 的媒体类型，别拿奇怪的 Accept 去要文件/清单
        headers["Accept"] = "application/json" if host == "data.jsdelivr.com" else "*/*"
    else:
        headers["Accept"] = accept or _JSON_ACCEPT
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    if token and host in _TOKEN_HOSTS:
        headers["Authorization"] = "Bearer " + token
    return headers


def _request_once(url, token, accept):
    """发一次请求：4xx 直接抛 GitHubSkillError，网络级失败与 5xx 抛 HostUnavailable。"""
    _assert_allowed_url(url)
    request = urllib.request.Request(url, headers=_request_headers(url, token, accept))
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return response.read(MAX_MARKDOWN_BYTES + 1)
    except GitHubSkillError:
        raise
    except urllib.error.HTTPError as exc:
        headers = exc.headers
        try:
            exc.close()
        except Exception:
            pass
        if exc.code in (403, 429) and _is_rate_limited(exc.code, headers):
            raise _rate_limit_error(headers)
        if exc.code == 404:
            raise GitHubSkillError("仓库、分支或 SKILL.md 不存在；私有仓库请配置有效令牌", 404)
        if exc.code in (401, 403):
            raise GitHubSkillError("GitHub 拒绝访问；请检查仓库权限或访问令牌", 403)
        if exc.code == 429:
            raise GitHubSkillError("GitHub 请求过于频繁，请稍后重试", 429)
        if exc.code >= 500:
            raise HostUnavailable(_host_of(url), "HTTP %s" % exc.code, http_status=exc.code)
        raise GitHubSkillError("GitHub 返回 HTTP %s" % exc.code, 502)
    except _NETWORK_ERRORS as exc:
        raise HostUnavailable(_host_of(url), _describe_network_error(exc))


def _request_bytes(url, token, accept=_JSON_ACCEPT):
    """单宿主最多 3 次尝试（退避 0.4s / 0.9s）；5xx 只重试一次，4xx 一次都不重试。"""
    attempts = 0
    server_retried = False
    while True:
        try:
            return _request_once(url, token, accept)
        except HostUnavailable as exc:
            attempts += 1
            if exc.http_status is not None:
                if server_retried:
                    raise
                server_retried = True
            if attempts >= _MAX_ATTEMPTS:
                raise
            time.sleep(_RETRY_DELAYS[attempts - 1])


def _github_api_bytes(url, token, accept=_JSON_ACCEPT):
    """仓库元数据与目录树只走 api.github.com，失败直接给可读报告。"""
    try:
        return _request_bytes(url, token, accept)
    except HostUnavailable as exc:
        raise GitHubSkillError("无法连接 %s：%s；%s" % (exc.host, exc.reason, _PROXY_HINT), 502)


def _parse_json(raw, label):
    if len(raw) > MAX_MARKDOWN_BYTES:
        raise GitHubSkillError("%s 响应超过 1MB 上限" % label, 413)
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise GitHubSkillError("%s 返回了无法解析的数据" % label, 502)


def _json(url, token, accept=_JSON_ACCEPT):
    return _parse_json(_github_api_bytes(url, token, accept), "GitHub")


# ---------------------------------------------------------------------------
# 地址构造 / 原文读取
# ---------------------------------------------------------------------------

def _raw_markdown_url(owner, repo, ref, path):
    return "https://raw.githubusercontent.com/%s/%s/%s/%s" % (
        owner, repo, urllib.parse.quote(ref, safe="/"), urllib.parse.quote(path, safe="/")), _RAW_ACCEPT


def _contents_markdown_url(owner, repo, ref, path):
    # contents 接口对大小写敏感，路径原样用解析/目录树给出的写法
    return "https://api.github.com/repos/%s/%s/contents/%s?ref=%s" % (
        owner, repo, urllib.parse.quote(path, safe="/"),
        urllib.parse.quote(ref, safe="")), _RAW_ACCEPT


def _jsdelivr_markdown_url(owner, repo, ref, path):
    return "https://cdn.jsdelivr.net/gh/%s/%s@%s/%s" % (
        owner, repo, urllib.parse.quote(ref, safe="/"), urllib.parse.quote(path, safe="/")), "*/*"


_MARKDOWN_SOURCES = (_raw_markdown_url, _contents_markdown_url, _jsdelivr_markdown_url)
_PROBE_SOURCES = (_raw_markdown_url, _jsdelivr_markdown_url)


def _github_token():
    """令牌来源统一走 token_store：环境变量优先，其次后台保存的 config.json。"""
    return token_store.active_token()


def _skill_path_candidates(path):
    """用户给的路径可能指 SKILL.md 本身，也可能指技能子目录；两种都试，猜错不花 API 配额。"""
    trimmed = str(path or "").strip().strip("/")
    if not trimmed:
        return []
    if trimmed.split("/")[-1].lower() == "skill.md":
        return [trimmed]
    return [trimmed + "/SKILL.md", trimmed]


def _decode_markdown(raw):
    if len(raw) > MAX_MARKDOWN_BYTES:
        raise GitHubSkillError("SKILL.md 超过 1MB 上限", 413)
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise GitHubSkillError("SKILL.md 必须是 UTF-8 文本")


def _markdown_result(source, ref, path, markdown, source_url):
    return {
        "markdown": markdown,
        "repository": source.repository,
        "ref": ref,
        "path": path,
        "source_url": source_url,
    }


def _not_found_error():
    return GitHubSkillError("仓库、分支或 SKILL.md 不存在；私有仓库请配置有效令牌", 404)


def _repo_not_found_error(source, ref_missing=False):
    """仓库不存在（API 404，或限流时 jsDelivr 也查不到）：别用限流文案盖住这件事。"""
    if ref_missing:
        detail = "仓库不存在或名字不对：%s（分支/标签可能也不对；请确认仓库地址，私有仓库需配置 NOVAI_GITHUB_TOKEN）" % source.repository
    else:
        detail = "仓库不存在或名字不对：%s（请确认仓库地址，私有仓库需配置 NOVAI_GITHUB_TOKEN）" % source.repository
    return RepoNotFoundError(detail, 404)


def _select_skill_path(paths, prefix=""):
    """从文件清单里挑唯一的 SKILL.md；prefix 非空时只看该子目录下。"""
    skills = []
    for item in paths or []:
        path = str(item or "").strip("/")
        if path == "SKILL.md" or path.endswith("/SKILL.md"):
            skills.append(path)
    scope = str(prefix or "").strip("/")
    if scope:
        skills = [item for item in skills if item == scope or item.startswith(scope + "/")]
    if not skills:
        raise GitHubSkillError("仓库中没有 SKILL.md，请指定文件路径", 404)
    if len(skills) > 1:
        raise GitHubSkillError("仓库中有多个 SKILL.md，请用 path 指定一个：%s" % "、".join(skills[:5]))
    return _valid_path(skills[0])


def _unreachable_message(failures):
    tried = "、".join(host for host, _reason in failures) or "无"
    last = failures[-1][1] if failures else "未知错误"
    return "无法获取 SKILL.md：已尝试 %s；最后一次错误：%s；%s" % (tried, last, _PROXY_HINT)


def _probe_markdown(source, ref, paths, token, failures):
    """不碰 api.github.com 的试探：raw 命中就用，raw 网络失败才换 jsdelivr。

    命中返回 (markdown, 源 URL, 实际路径)；只有拿到确定 404 才返回 None（说明路径不对，
    交给上层继续猜或查目录树）；全是网络失败则抛可读错误，不假装“文件不存在”。
    """
    definitive = False
    for path in paths:
        for build in _PROBE_SOURCES:
            target, accept = build(source.owner, source.repo, ref, path)
            try:
                raw = _request_bytes(target, token, accept)
            except HostUnavailable as exc:
                failures.append((exc.host, exc.reason))
                continue
            except GitHubSkillError as exc:
                if exc.status_code == 404:
                    definitive = True
                    break       # 这个路径确实没有，换下一个候选，且不必再问 jsdelivr
                raise
            return _decode_markdown(raw), target, path
    if not definitive:
        raise GitHubSkillError(_unreachable_message(failures), 502)
    return None


def _fetch_markdown(source, ref, path, token):
    """路径已确定：按 raw → api contents → jsdelivr 取原文，全网失败统一报错。"""
    failures = []
    rate_error = None
    for build in _MARKDOWN_SOURCES:
        target, accept = build(source.owner, source.repo, ref, path)
        try:
            raw = _request_bytes(target, token, accept)
        except HostUnavailable as exc:
            failures.append((exc.host, exc.reason))
            continue
        except RateLimitError as exc:
            rate_error = exc        # contents 走的是 API，被限流还有 jsDelivr 可取
            continue
        return _decode_markdown(raw), target
    if rate_error is not None:
        raise rate_error
    raise GitHubSkillError(_unreachable_message(failures), 502)


def check_token(token, timeout=VERIFY_TIMEOUT_SECONDS):
    """只读校验令牌并读回配额：401 抛 GitHubSkillError(400)，其它失败返回 None（不拒绝保存）。

    网络不通 / 限流 / 5xx 都不该让"保存令牌"失败，所以这里只在"令牌确实无效"时抛错。
    """
    _assert_allowed_url(RATE_LIMIT_URL)
    headers = {
        "User-Agent": "NOVAI-Skill-Installer/1.0",
        "Accept": _JSON_ACCEPT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(RATE_LIMIT_URL, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_MARKDOWN_BYTES)
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            exc.close()
        except Exception:
            pass
        if status == 401:
            raise GitHubSkillError("令牌无效或已过期", 400)
        return None
    except _NETWORK_ERRORS:
        return None
    try:
        data = _parse_json(raw, "GitHub")
    except GitHubSkillError:
        return None
    if not isinstance(data, dict):
        return None
    core = (data.get("resources") or {}).get("core") if isinstance(data.get("resources"), dict) else None
    if not isinstance(core, dict):
        core = data.get("rate")
    if not isinstance(core, dict):
        return {}
    return {"limit": core.get("limit"), "remaining": core.get("remaining")}


# ---------------------------------------------------------------------------
# API 侧解析：只在缺分支 / 缺路径时才调用（未认证配额 60 次/小时）
# ---------------------------------------------------------------------------

def _default_branch(source, token):
    try:
        meta = _json("https://api.github.com/repos/%s/%s" % (source.owner, source.repo), token)
    except GitHubSkillError as exc:
        if exc.status_code == 404:
            raise _repo_not_found_error(source)
        raise
    ref = str(meta.get("default_branch") or "").strip()
    if not ref:
        raise GitHubSkillError("无法确定默认分支：%s（可在地址里带上分支，例如 /tree/main/skills/xxx）" % source.repository, 502)
    return ref


def _tree_skill_paths(source, token, ref):
    tree_url = "https://api.github.com/repos/%s/%s/git/trees/%s?recursive=1" % (
        source.owner, source.repo, urllib.parse.quote(ref, safe=""))
    tree = _json(tree_url, token)
    paths = []
    for item in tree.get("tree") or []:
        if item.get("type") != "blob":
            continue
        item_path = str(item.get("path") or "")
        if item_path == "SKILL.md" or item_path.endswith("/SKILL.md"):
            paths.append(item_path)
    return paths


def _jsdelivr_files(source, ref, token):
    """jsDelivr Data API 的文件清单（不消耗 GitHub 配额）；该 ref 取不到返回 None。"""
    url = "https://data.jsdelivr.com/v1/packages/gh/%s/%s@%s?structure=flat" % (
        source.owner, source.repo, urllib.parse.quote(ref, safe="/"))
    try:
        raw = _request_bytes(url, token)
    except HostUnavailable as exc:
        raise JsdelivrUnavailable("%s：%s" % (exc.host, exc.reason))
    except GitHubSkillError as exc:
        if exc.status_code == 404:
            return None
        raise
    data = _parse_json(raw, "jsDelivr")
    files = data.get("files") if isinstance(data, dict) else None
    return [str(item.get("name") or "") for item in files or [] if isinstance(item, dict)]


def _jsdelivr_repo_exists(source, token):
    """jsDelivr 里这个仓库有没有记录：用来区分"仓库不存在"和"分支不对"。"""
    url = "https://data.jsdelivr.com/v1/packages/gh/%s/%s" % (source.owner, source.repo)
    try:
        _request_bytes(url, token)
    except HostUnavailable as exc:
        raise JsdelivrUnavailable("%s：%s" % (exc.host, exc.reason))
    except GitHubSkillError as exc:
        if exc.status_code == 404:
            return False
        raise
    return True


def _resolve_via_jsdelivr(source, token):
    """API 被限流时的降级：用 jsDelivr Data API 猜默认分支 + 枚举 SKILL.md（不耗 GitHub 配额）。"""
    refs = [source.ref] if source.ref else list(_DEFAULT_BRANCH_GUESSES)
    for ref in refs:
        files = _jsdelivr_files(source, ref, token)
        if files is None:
            continue
        return ref, _select_skill_path(files, source.path)
    raise _repo_not_found_error(source, ref_missing=_jsdelivr_repo_exists(source, token))


def _resolve_via_api(source, token):
    """确定分支与 SKILL.md 路径：缺分支查默认分支，缺路径/路径是目录才查目录树。

    api.github.com 限流（未认证 60 次/小时/IP）时降级 jsDelivr Data API，成功就照常安装；
    只有备用源也拿不到时才把限流错误抛给用户。
    """
    try:
        ref = source.ref or _default_branch(source, token)
        paths = _tree_skill_paths(source, token, ref)
    except RateLimitError as exc:
        try:
            return _resolve_via_jsdelivr(source, token)
        except JsdelivrUnavailable:
            raise exc
    return ref, _select_skill_path(paths, source.path)


def _resolve_source(source, token):
    """API 侧解析入口（返回 owner, repo, ref, path），供内部与单测复用。"""
    ref, path = _resolve_via_api(source, token)
    return source.owner, source.repo, ref, path



# ---------------------------------------------------------------------------
# 令牌中转（relay）：客户端只配中转地址，令牌只在中转服务上
# ---------------------------------------------------------------------------

def _relay_auth_error():
    return GitHubSkillError("中转服务拒绝访问：密钥不匹配（请检查中转密钥 RELAY_SECRET）", 403)


def _relay_request(relay_url, secret, path, params):
    """GET 中转 /v1/*：返回 (status, body, 实际 URL)；连不上抛 RelayUnavailable。"""
    target = "%s%s" % (relay_url.rstrip("/"), path)
    query = urllib.parse.urlencode({key: value for key, value in params.items() if value != ""})
    if query:
        target += "?" + query
    headers = {"User-Agent": "NOVAI-Skill-Installer/1.0", "Accept": "*/*"}
    if secret:
        headers["x-relay-token"] = secret          # 只有配了 RELAY_SECRET 才带
    request = urllib.request.Request(target, headers=headers)
    try:
        with urlopen(request, timeout=RELAY_TIMEOUT_SECONDS) as response:
            return response.status, response.read(MAX_MARKDOWN_BYTES + 1), target
    except urllib.error.HTTPError as exc:
        body = b""
        try:
            body = exc.read(MAX_MARKDOWN_BYTES)
        except Exception:
            pass
        try:
            exc.close()
        except Exception:
            pass
        return exc.code, body, target
    except _NETWORK_ERRORS as exc:
        raise RelayUnavailable(relay_url, _describe_network_error(exc))


def _relay_error(status, body):
    message = ""
    try:
        data = json.loads(body.decode("utf-8"))
        if isinstance(data, dict):
            message = str(data.get("error") or data.get("message") or "").strip()
    except Exception:
        message = body[:200].decode("utf-8", "replace").strip()
    if message:
        return GitHubSkillError("中转服务返回 HTTP %s：%s" % (status, message), 502)
    return GitHubSkillError("中转服务返回 HTTP %s" % status, 502)


def _relay_call(relay_url, secret, path, params, source, missing):
    """统一处理 401 / 404 / 其它错误码，返回 body 字节。"""
    status, body, _target = _relay_request(relay_url, secret, path, params)
    if status == 200:
        return body
    if status == 401:
        raise _relay_auth_error()
    if status == 404:
        raise missing
    raise _relay_error(status, body)


def _relay_default_branch(source, relay_url, secret):
    body = _relay_call(relay_url, secret, "/v1/default-branch",
                       {"owner": source.owner, "repo": source.repo},
                       source, _repo_not_found_error(source))
    data = _parse_json(body, "中转")
    branch = str(data.get("branch") or "").strip() if isinstance(data, dict) else ""
    if not branch:
        raise GitHubSkillError("中转服务没有返回默认分支：%s" % source.repository, 502)
    return branch


def _relay_list(source, ref, relay_url, secret):
    body = _relay_call(relay_url, secret, "/v1/list",
                       {"owner": source.owner, "repo": source.repo, "ref": ref},
                       source, _repo_not_found_error(source, ref_missing=bool(source.ref)))
    data = _parse_json(body, "中转")
    files = data.get("files") if isinstance(data, dict) else None
    return [str(item) for item in files or []]


def _relay_raw(source, ref, path, relay_url, secret, missing_ok=False):
    status, body, target = _relay_request(relay_url, secret, "/v1/raw",
                                          {"owner": source.owner, "repo": source.repo,
                                           "ref": ref, "path": path})
    if status == 200:
        return _decode_markdown(body), target
    if status == 401:
        raise _relay_auth_error()
    if status == 404:
        if missing_ok:
            return None
        raise _not_found_error()
    raise _relay_error(status, body)


def _fetch_via_relay(source, relay_url, secret):
    """中转模式：默认分支 / SKILL.md 枚举 / 正文全部经中转，本地不读令牌也不直连 GitHub。"""
    ref = source.ref or _relay_default_branch(source, relay_url, secret)
    candidates = _skill_path_candidates(source.path)
    for candidate in candidates:
        hit = _relay_raw(source, ref, candidate, relay_url, secret, missing_ok=True)
        if hit is not None:
            markdown, target = hit
            return _markdown_result(source, ref, candidate, markdown, target)
    if len(candidates) == 1:
        raise _not_found_error()        # 明确给了文件路径却没命中，不用再列目录
    files = _relay_list(source, ref, relay_url, secret)
    path = _select_skill_path(files, source.path)
    markdown, target = _relay_raw(source, ref, path, relay_url, secret)
    return _markdown_result(source, ref, path, markdown, target)


# ---------------------------------------------------------------------------
# 任意 HTTPS 直链：正文就是 SKILL.md（不走 GitHub 解析，也不带任何令牌）
# ---------------------------------------------------------------------------

def is_github_url(url):
    """用户粘贴的是不是 GitHub 专用流程的地址；其余主机走通用直链下载。"""
    return _host_of(url) in _GITHUB_URL_HOSTS


def _is_public_ip(ip):
    """公网地址判定：loopback / private / link_local / multicast / reserved / unspecified 全拒。"""
    for flag in ("is_loopback", "is_private", "is_link_local", "is_multicast",
                 "is_reserved", "is_unspecified"):
        if getattr(ip, flag, False):
            return False
    return bool(getattr(ip, "is_global", True))


def _public_https_target(url):
    """校验一个跳转目标：https、无账号口令、有主机名；返回 (host, port)。"""
    raw = str(url or "").strip()
    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        raise GitHubSkillError("地址不合法：%s" % raw, 400)
    scheme = (parsed.scheme or "").lower()
    if scheme == "http":
        raise GitHubSkillError("只支持 HTTPS 直链：请把链接里的 http:// 改成 https:// 再试", 400)
    if scheme != "https":
        label = "%s://" % scheme if scheme else "无协议"
        raise GitHubSkillError("只支持 HTTPS 直链（不支持 %s 链接）：%s" % (label, raw), 400)
    if parsed.username or parsed.password:
        raise GitHubSkillError("地址里不能带用户名或密码（凭据会随请求发出）：%s" % raw, 400)
    host = (parsed.hostname or "").strip().lower()
    if not host:
        raise GitHubSkillError("地址缺少主机名：%s" % raw, 400)
    try:
        port = parsed.port or 443
    except ValueError:
        raise GitHubSkillError("地址端口不合法：%s" % raw, 400)
    return host, port


def _resolve_public_host(host, port):
    """解析主机名；所有 IP 必须都是公网地址，解析失败给可读错误。返回校验过的地址列表。"""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError) as exc:
        raise GitHubSkillError("无法解析主机名 %s：%s（请检查链接里的域名和本机网络/DNS）"
                               % (host, _describe_network_error(exc)), 502)
    addresses = [str(info[4][0] or "").strip() for info in infos if info[4] and info[4][0]]
    if not addresses:
        raise GitHubSkillError("无法解析主机名 %s：没有返回任何地址" % host, 502)
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address.split("%")[0])
        except ValueError:
            raise GitHubSkillError("主机 %s 解析出的地址不合法：%s" % (host, address), 502)
        if not _is_public_ip(ip):
            raise GitHubSkillError("拒绝访问内网或保留地址：%s 解析到 %s（只允许公网地址）"
                                   % (host, address), 400)
    return addresses


def _direct_headers():
    """直链请求头：只放 UA 和 Accept，任何令牌都不带。"""
    return {"User-Agent": "NOVAI-Skill-Installer/1.0", "Accept": "text/plain, */*"}


def _fetch_direct_markdown(url):
    """GET 任意 https 直链的 SKILL.md 原文；重定向手动逐跳校验，最多 3 跳。"""
    target = str(url or "").strip()
    hops = 0
    while True:
        host, port = _public_https_target(target)
        _resolve_public_host(host, port)
        try:
            request = urllib.request.Request(target, headers=_direct_headers())
        except ValueError as exc:
            raise GitHubSkillError("地址不合法：%s（%s）" % (target, exc), 400)
        try:
            with urlopen(request, timeout=TIMEOUT_SECONDS, follow_redirects=False) as response:
                raw = response.read(MAX_MARKDOWN_BYTES + 1)
                break
        except urllib.error.HTTPError as exc:
            code = exc.code
            location = _header_value(exc.headers, "Location")
            try:
                exc.close()
            except Exception:
                pass
            if code in _REDIRECT_CODES and location:
                hops += 1
                if hops > _MAX_REDIRECTS:
                    raise GitHubSkillError("重定向超过 %d 跳，已停止（请直接填最终地址）"
                                           % _MAX_REDIRECTS, 400)
                target = urllib.parse.urljoin(target, location)
                continue
            if code == 404:
                raise GitHubSkillError("该地址不存在（HTTP 404）：请确认链接是否写对、文件是否已被删除", 404)
            if code in (401, 403):
                raise GitHubSkillError("该地址拒绝访问（HTTP %s）：可能需要登录或没有公开访问权限" % code, 403)
            if code >= 500:
                raise GitHubSkillError("该地址的服务器出错（HTTP %s），请稍后重试" % code, 502)
            raise GitHubSkillError("该地址返回 HTTP %s" % code, 502)
        except GitHubSkillError:
            raise
        except _NETWORK_ERRORS as exc:
            raise GitHubSkillError("无法下载 SKILL.md：%s；%s"
                                   % (_describe_network_error(exc), _PROXY_HINT), 502)
    markdown = _decode_markdown(raw)
    return {
        "markdown": markdown,
        "repository": host,
        "ref": "",
        "path": "",
        "source_url": target,
    }


def fetch_skill_markdown(url, path="", ref=""):
    if not is_github_url(url):
        return _fetch_direct_markdown(url)
    source = parse_github_url(url, path=path, ref=ref)
    relay_url = token_store.relay_url()
    if relay_url:
        return _fetch_via_relay(source, relay_url, token_store.relay_secret())
    token = _github_token()
    candidates = _skill_path_candidates(source.path)
    file_only = len(candidates) == 1
    failures = []

    # 1) 分支已知：raw / jsdelivr 直接试，正常安装完全不消耗 API 配额
    if source.ref and candidates:
        hit = _probe_markdown(source, source.ref, candidates, token, failures)
        if hit:
            markdown, source_url, hit_path = hit
            return _markdown_result(source, source.ref, hit_path, markdown, source_url)
        if file_only:
            raise _not_found_error()

    # 2) 缺分支但有路径：先猜 main / master，命中就不用查 API
    if not source.ref and candidates:
        for guessed_ref in _DEFAULT_BRANCH_GUESSES:
            hit = _probe_markdown(source, guessed_ref, candidates, token, failures)
            if hit:
                markdown, source_url, hit_path = hit
                return _markdown_result(source, guessed_ref, hit_path, markdown, source_url)
        if file_only:
            final_ref = _default_branch(source, token)
            markdown, source_url = _fetch_markdown(source, final_ref, candidates[0], token)
            return _markdown_result(source, final_ref, candidates[0], markdown, source_url)

    # 3) 还缺信息（或给的是子目录）：查目录树定位 SKILL.md，再取原文
    final_ref, final_path = _resolve_via_api(source, token)
    markdown, source_url = _fetch_markdown(source, final_ref, final_path, token)
    return _markdown_result(source, final_ref, final_path, markdown, source_url)
