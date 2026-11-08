"""Small, read-only web access tools for the canvas agent."""
from __future__ import annotations

import base64
import html as html_module
import ipaddress
import json
import re
import socket
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urljoin, urlparse

import httpx

from server import net_proxy

# 正文上限 3MB：Pinterest 这类 JS App Shell 页面本身就有 1.2~1.4MB，1MB 会直接读不了
MAX_BODY_BYTES = 3 * 1024 * 1024
MAX_TEXT_CHARS = 20000
MAX_REDIRECTS = 3
# brotlicffi 1.2 + httpx 0.28 的 br 流式解码会抛 DecodingError；读正文只要 gzip/deflate 就够
_ACCEPT_ENCODING = "gzip, deflate"
_PROXY_HINT = "若是被网络限制的站点，可以在「设置 › 网络」或「设置 › 通用 › 画布助手联网」里设置代理"
# 剥完标签的可见文字少于这个数：按 JS 渲染站点处理，改用标题 + 站点描述做摘要
MIN_READABLE_CHARS = 200
_JS_RENDER_NOTE = "这个站点主要靠 JS 渲染，正文脚本不会执行，只能取到页面摘要（标题与站点描述）"
_NO_DESCRIPTION_NOTE = "页面没有提供描述（meta description / og:description / JSON-LD description 都是空的）"

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


def _web_proxy() -> Optional[str]:
    """本次请求该用的代理；解析失败按直连处理，绝不让代理配置本身把联网打死。"""
    try:
        return net_proxy.resolve_web_proxy()
    except Exception as exc:
        print(f"[web] 解析联网代理失败，按直连处理：{exc}")
        return None


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
    # 字面量 IP 不管走不走代理都要按内网规则拦（代理不会替我们挡住 127.0.0.1）
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        if not literal.is_global:
            raise WebAccessError("不允许访问本机、内网或保留地址")
        return value
    # 走代理时由代理侧解析域名：本地被污染/被拦截的域名（Pinterest 之类）不该在本地判死
    if _web_proxy():
        return value
    try:
        records = socket.getaddrinfo(host, port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise WebAccessError(f"域名 {host} 解析失败（本地 DNS 查不到这个地址）；{_PROXY_HINT}") from exc
    for record in records:
        address = ipaddress.ip_address(record[4][0])
        if not address.is_global:
            raise WebAccessError("不允许访问本机、内网或保留地址")
    return value


def _client(timeout: float, proxy: Optional[str]) -> httpx.Client:
    options: Dict[str, Any] = {"follow_redirects": False, "timeout": timeout, "trust_env": True}
    options.update(net_proxy.httpx_proxy(proxy))
    return httpx.Client(**options)


def _network_error_text(exc: Exception, url: str, timeout: float) -> str:
    """把 httpx 的底层异常翻成用户能看懂的原因（带域名），别只丢一句「请求超时」。"""
    parsed = urlparse(url)
    host = parsed.netloc or parsed.hostname or url
    detail = clean_error_text(exc)
    lowered = detail.lower()
    if isinstance(exc, httpx.TimeoutException):
        return f"访问 {host} 超时（{timeout:g} 秒内没有响应）"
    if isinstance(exc, httpx.ConnectError):
        dns_signals = ("nodename nor servname", "name or service not known", "getaddrinfo",
                       "name resolution", "no address associated")
        if any(signal in lowered for signal in dns_signals):
            return f"域名 {parsed.hostname or host} 解析失败（DNS 查不到这个地址）"
        return f"连接 {host} 失败：{detail}"
    if isinstance(exc, httpx.DecodingError):
        return f"读取 {host} 的页面内容失败：{detail}"
    return f"访问 {host} 失败：{detail}"


def _download_with(url: str, timeout: float, max_bytes: int,
                   headers: Dict[str, str], proxy: Optional[str]):
    with _client(timeout, proxy) as client:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            with client.stream("GET", current, headers=headers) as response:
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
                        raise WebAccessError(f"网页内容超过 {max_bytes // (1024 * 1024)}MB 安全上限")
                    chunks.append(chunk)
                return b"".join(chunks), content_type, current
        raise WebAccessError("网页重定向次数过多")


def download(url: str, timeout: float = 12.0, max_bytes: int = MAX_BODY_BYTES,
             headers: Optional[Dict[str, str]] = None):
    current = validate_public_url(url)
    request_headers = {"User-Agent": "NOVAI-Canvas-WebReader/1.0",
                       "Accept-Encoding": _ACCEPT_ENCODING}
    if headers:
        request_headers.update(headers)
    proxy = _web_proxy()
    try:
        if proxy:
            try:
                return _download_with(current, timeout, max_bytes, request_headers, proxy)
            except (httpx.ProxyError, httpx.ConnectError) as exc:
                # 代理挂了不该变成用户可见的失败：回退直连一次，日志留痕
                print(f"[web] 联网代理 {proxy} 连接失败（{clean_error_text(exc)}），已回退直连")
        return _download_with(current, timeout, max_bytes, request_headers, None)
    except httpx.HTTPError as exc:
        text = _network_error_text(exc, current, timeout)
        if proxy:
            text += f"（代理 {proxy} 与直连都失败）"
        raise WebAccessError(f"{text}；{_PROXY_HINT}") from exc


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


class _PageSummaryParser(HTMLParser):
    """只收集标题与站点描述（title / meta description / og / twitter / JSON-LD）。"""

    def __init__(self):
        super().__init__()
        self.title = ""
        self.metas: Dict[str, str] = {}
        self.json_ld: List[str] = []
        self._in_title = False
        self._in_ld = False

    def handle_starttag(self, tag, attrs):
        values = {str(key).lower(): (value or "") for key, value in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (values.get("property") or values.get("name") or "").strip().lower()
            content = values.get("content") or ""
            if key and content and key not in self.metas:
                self.metas[key] = content
        elif tag == "script" and "ld+json" in values.get("type", "").lower():
            self._in_ld = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "script":
            self._in_ld = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif self._in_ld:
            self.json_ld.append(data)


def _clean_summary_text(value: Any, limit: int) -> str:
    text = html_module.unescape(str(value or ""))
    return " ".join(text.split())[:limit]


def _json_ld_description(node: Any, depth: int = 0) -> str:
    if depth > 6:
        return ""
    if isinstance(node, dict):
        value = node.get("description")
        if isinstance(value, str) and value.strip():
            return value
        for key in ("@graph", "mainEntity", "itemListElement"):
            child = node.get(key)
            if child:
                found = _json_ld_description(child, depth + 1)
                if found:
                    return found
    elif isinstance(node, list):
        for item in node:
            found = _json_ld_description(item, depth + 1)
            if found:
                return found
    return ""


def extract_page_summary(page: str) -> Dict[str, str]:
    """JS 渲染站点的兜底摘要：标题 + meta description / og / twitter / JSON-LD description。"""
    parser = _PageSummaryParser()
    try:
        parser.feed(str(page or ""))
        parser.close()
    except Exception:
        pass  # 畸形 HTML 不该让「读网页」整段失败
    title = _clean_summary_text(parser.title, 200)
    if not title:
        title = _clean_summary_text(parser.metas.get("og:title") or parser.metas.get("twitter:title"), 200)
    if not title:
        # Pinterest 这种 App Shell 只有站点名，至少让用户知道读到了哪个站
        title = _clean_summary_text(
            parser.metas.get("og:site_name") or parser.metas.get("application-name"), 200)
    description = ""
    for key in ("description", "og:description", "twitter:description"):
        description = _clean_summary_text(parser.metas.get(key), 800)
        if description:
            break
    if not description:
        for block in parser.json_ld:
            try:
                data = json.loads(str(block or "").strip())
            except Exception:
                continue
            description = _clean_summary_text(_json_ld_description(data), 800)
            if description:
                break
    return {"title": title, "description": description}


def readable_text(data: bytes, content_type: str = "text/html") -> str:
    if content_type == "text/html" or content_type == "application/xhtml+xml":
        page = decode_html(data, content_type)
        parser = _TextExtractor()
        parser.feed(page)
        parser.close()
        text = " ".join("".join(parser.parts).split())
        # 剥完标签几乎没字 = 前端框架壳子，正文要靠脚本渲染；用标题 + 站点描述兜底
        if len(text) < MIN_READABLE_CHARS:
            summary = extract_page_summary(page)
            if summary["title"] or summary["description"]:
                parts = [part for part in (summary["title"], summary["description"]) if part]
                parts.append(_JS_RENDER_NOTE)
                if not summary["description"]:
                    parts.append(_NO_DESCRIPTION_NOTE)
                text = "\n".join(parts)
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
        return f"请求超时；{_PROXY_HINT}"
    if isinstance(exc, httpx.HTTPError):
        return f"网络错误：{clean_error_text(exc)}；{_PROXY_HINT}"
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
