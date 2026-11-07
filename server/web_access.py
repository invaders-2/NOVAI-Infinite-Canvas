"""Small, read-only web access tools for the canvas agent."""
from __future__ import annotations

import base64
import html as html_module
import ipaddress
import re
import socket
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urljoin, urlparse

import httpx

MAX_BODY_BYTES = 1024 * 1024
MAX_TEXT_CHARS = 20000
MAX_REDIRECTS = 3

# 搜索页对 UA 很挑：默认的 NOVAI-... UA 会被 360/必应当成爬虫直接给空壳页
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
_SEARCH_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
}


class WebAccessError(ValueError):
    pass


# 对外错误文案不带 "ClassName: " 前缀：前端直接展示，Python 类名只会干扰用户
_CLASS_PREFIX_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception):\s*")


def clean_error_text(message: Any, fallback: str = "") -> str:
    """去掉 "WebAccessError: " 这类类名前缀，只留真实原因（HTTP 状态码/字节数等有用信息保留）。"""
    text = str(message or "").strip()
    cleaned = _CLASS_PREFIX_RE.sub("", text, count=1).strip()
    if cleaned:
        return cleaned
    return str(fallback or "").strip() or text


def validate_public_url(url: str) -> str:
    value = str(url or "").strip()
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise WebAccessError("只允许 http/https 网页地址")
    if parsed.username or parsed.password:
        raise WebAccessError("网页地址不能包含账号或密码")
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local"):
        raise WebAccessError("不允许访问本机或内网地址")
    try:
        port = parsed.port
    except ValueError as exc:
        raise WebAccessError("网页端口无效") from exc
    if port not in (None, 80, 443):
        raise WebAccessError("只允许标准 HTTP/HTTPS 端口")
    try:
        records = socket.getaddrinfo(host, port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise WebAccessError("网页域名无法解析") from exc
    for record in records:
        address = ipaddress.ip_address(record[4][0])
        if not address.is_global:
            raise WebAccessError("不允许访问本机、内网或保留地址")
    return value


def download(url: str, timeout: float = 12.0, max_bytes: int = MAX_BODY_BYTES,
             headers: Optional[Dict[str, str]] = None):
    current = validate_public_url(url)
    request_headers = {"User-Agent": "NOVAI-Canvas-WebReader/1.0"}
    if headers:
        request_headers.update(headers)
    with httpx.Client(follow_redirects=False, timeout=timeout) as client:
        for _ in range(MAX_REDIRECTS + 1):
            response = client.get(current, headers=request_headers)
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location", "")
                if not location:
                    raise WebAccessError("网页重定向缺少目标地址")
                current = validate_public_url(urljoin(current, location))
                continue
            if response.status_code >= 400:
                raise WebAccessError(f"网页返回 HTTP {response.status_code}")
            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if content_type and content_type not in ("text/html", "text/plain", "application/json", "application/xhtml+xml"):
                raise WebAccessError(f"不支持读取 {content_type} 类型内容")
            chunks = []
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise WebAccessError("网页内容超过 1MB 安全上限")
                chunks.append(chunk)
            return b"".join(chunks), content_type, current
        raise WebAccessError("网页重定向次数过多")


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: List[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg"):
            self.skip_depth += 1
        elif tag in ("p", "div", "section", "article", "li", "tr", "br", "h1", "h2", "h3", "h4", "h5", "h6"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self.skip_depth:
            self.skip_depth -= 1
        elif tag in ("p", "div", "section", "article", "li", "tr"):
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(data)


# 中文站常见 GBK/GB2312 页面；按字节声明 + 实际内容挑编码，别让正文变成乱码
_CHARSET_ALIASES = {
    "gb2312": "gb18030",
    "gbk": "gb18030",
    "gb_2312-80": "gb18030",
    "x-gbk": "gb18030",
    "utf8": "utf-8",
}
_CHARSET_RE = re.compile(r"""charset\s*=\s*["']?([A-Za-z0-9_\-]+)""", re.I)


def _charset_from_declaration(data: bytes, content_type: str = "") -> str:
    declared = ""
    match = _CHARSET_RE.search(str(content_type or ""))
    if match:
        declared = match.group(1)
    if not declared:
        head = data[:4096].decode("ascii", errors="ignore")
        match = _CHARSET_RE.search(head)
        if match:
            declared = match.group(1)
    declared = str(declared or "").strip().lower()
    return _CHARSET_ALIASES.get(declared, declared)


def decode_html(data: bytes, content_type: str = "") -> str:
    raw = data or b""
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig", errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    declared = _charset_from_declaration(raw, content_type)
    if declared and declared not in ("utf-8", "ascii"):
        try:
            return raw.decode(declared, errors="replace")
        except LookupError:
            pass
    try:
        return raw.decode("gb18030")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")


# 兼容旧内部调用名
def _decode_html(data: bytes) -> str:
    return decode_html(data)


def readable_text(data: bytes, content_type: str = "text/html") -> str:
    if content_type == "text/html" or content_type == "application/xhtml+xml":
        parser = _TextExtractor()
        parser.feed(decode_html(data, content_type))
        parser.close()
        text = " ".join("".join(parser.parts).split())
    else:
        text = " ".join(decode_html(data, content_type).split())
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS] + "\n…（正文已截断）"
    return text


def fetch_url(url: str) -> Dict[str, Any]:
    data, content_type, final_url = download(url)
    return {"url": final_url, "text": readable_text(data, content_type)}


# ---------------------------------------------------------------------------
# 文本搜索：360 → 必应国内版双引擎（DuckDuckGo 在当前网络下连不通）
# ---------------------------------------------------------------------------

_SO360_BLOCK_SPLIT = re.compile(r'<li class="res-list"', re.S)
_SO360_TITLE_RE = re.compile(r'<h3[^>]*class="res-title"[^>]*>(.*?)</h3>', re.S)
_SO360_ATTR_RE = re.compile(r'(data-mdurl|href)="([^"]*)"', re.S)
_SO360_SNIPPET_RES = (
    re.compile(r'<span class="res-list-summary"[^>]*>(.*?)</span>', re.S),
    re.compile(r'<(?:p|div)[^>]*class="res-desc"[^>]*>(.*?)</(?:p|div)>', re.S),
)
_BING_BLOCK_SPLIT = re.compile(r'<li class="b_algo"', re.S)
_BING_TITLE_RE = re.compile(r'<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', re.S)
_BING_SNIPPET_RE = re.compile(r'<p[^>]*>(.*?)</p>', re.S)


def _strip_tags(value: str) -> str:
    text = re.sub(r"<[^>]+>", "", str(value or ""))
    return " ".join(html_module.unescape(text).split())


def _search_headers() -> Dict[str, str]:
    return dict(_SEARCH_HEADERS)


def _unwrap_bing_redirect(url: str) -> str:
    """必应国内版不少结果包在 cn.bing.com/ck/a?...&u=a1<base64url> 里，取回真实地址。"""
    parsed = urlparse(str(url or ""))
    host = (parsed.hostname or "").lower()
    if not (host == "bing.com" or host.endswith(".bing.com")) or not parsed.path.startswith("/ck/a"):
        return url
    encoded = (parse_qs(parsed.query).get("u") or [""])[0]
    if not encoded.startswith("a1"):
        return url
    payload = encoded[2:]
    try:
        decoded = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode("utf-8")
    except Exception:
        return url
    return decoded if decoded.startswith(("http://", "https://")) else url


def _search_360(query: str, limit: int) -> List[Dict[str, str]]:
    url = "https://www.so.com/s?" + str(httpx.QueryParams({"q": query, "pn": 1}))
    data, content_type, _ = download(url, headers=_search_headers())
    page = decode_html(data, content_type)
    results: List[Dict[str, str]] = []
    for block in _SO360_BLOCK_SPLIT.split(page)[1:]:
        title_match = _SO360_TITLE_RE.search(block)
        if not title_match:
            continue
        attrs = dict((key, value) for key, value in _SO360_ATTR_RE.findall(title_match.group(1)))
        href = html_module.unescape(attrs.get("data-mdurl") or attrs.get("href") or "")
        title = _strip_tags(title_match.group(1))
        if not title or not href:
            continue
        snippet = ""
        for pattern in _SO360_SNIPPET_RES:
            found = pattern.search(block)
            if found:
                snippet = _strip_tags(found.group(1))
                break
        try:
            safe_url = validate_public_url(href)
        except WebAccessError:
            continue
        results.append({"title": title, "url": safe_url, "snippet": snippet})
        if len(results) >= limit:
            break
    return results


def _search_bing(query: str, limit: int) -> List[Dict[str, str]]:
    url = "https://cn.bing.com/search?" + str(httpx.QueryParams({"q": query}))
    data, content_type, _ = download(url, headers=_search_headers())
    page = decode_html(data, content_type)
    results: List[Dict[str, str]] = []
    for block in _BING_BLOCK_SPLIT.split(page)[1:]:
        title_match = _BING_TITLE_RE.search(block)
        if not title_match:
            continue
        href = html_module.unescape(title_match.group(1))
        href = _unwrap_bing_redirect(href)
        title = _strip_tags(title_match.group(2))
        if not title or not href:
            continue
        snippet_match = _BING_SNIPPET_RE.search(block)
        snippet = _strip_tags(snippet_match.group(1)) if snippet_match else ""
        try:
            safe_url = validate_public_url(href)
        except WebAccessError:
            continue
        results.append({"title": title, "url": safe_url, "snippet": snippet})
        if len(results) >= limit:
            break
    return results


def _search_error_text(exc: Exception) -> str:
    if isinstance(exc, WebAccessError):
        return str(exc)
    if isinstance(exc, httpx.TimeoutException):
        return "请求超时"
    if isinstance(exc, httpx.HTTPError):
        return f"网络错误：{exc}"
    return clean_error_text(f"{type(exc).__name__}: {exc}", fallback="搜索出错，未返回具体原因")


def web_search(query: str, limit: int = 5) -> List[Dict[str, str]]:
    text_query = str(query or "").strip()
    if not text_query:
        raise WebAccessError("搜索关键词不能为空")
    try:
        top = max(1, min(int(limit or 5), 10))
    except (TypeError, ValueError):
        top = 5
    failures: List[str] = []
    for name, engine in (("360 搜索", _search_360), ("必应", _search_bing)):
        try:
            results = engine(text_query, top)
        except Exception as exc:
            failures.append(f"{name}：{_search_error_text(exc)}")
            continue
        if results:
            return results[:top]
        failures.append(f"{name}：没有解析到搜索结果")
    raise WebAccessError("网页搜索失败（" + "；".join(failures) + "）")
