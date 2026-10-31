"""Small, read-only web access tools for the canvas agent."""
from __future__ import annotations

import ipaddress
import socket
from html.parser import HTMLParser
from typing import Any, Dict, List
from urllib.parse import parse_qs, urljoin, urlparse

import httpx

MAX_BODY_BYTES = 1024 * 1024
MAX_TEXT_CHARS = 20000
MAX_REDIRECTS = 3


class WebAccessError(ValueError):
    pass


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


def download(url: str, timeout: float = 12.0, max_bytes: int = MAX_BODY_BYTES):
    current = validate_public_url(url)
    with httpx.Client(follow_redirects=False, timeout=timeout) as client:
        for _ in range(MAX_REDIRECTS + 1):
            response = client.get(current, headers={"User-Agent": "NOVAI-Canvas-WebReader/1.0"})
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


class _SearchExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items: List[Dict[str, str]] = []
        self.current: Dict[str, str] = {}
        self.capture = ""
        self.href = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set(attrs.get("class", "").split())
        if tag == "a" and "result__a" in classes:
            self.current = {"title": "", "url": attrs.get("href", ""), "snippet": ""}
            self.capture = "title"
        elif "result__snippet" in classes and self.current:
            self.capture = "snippet"

    def handle_data(self, data):
        if self.current and self.capture:
            self.current[self.capture] += data

    def handle_endtag(self, tag):
        if tag == "a" and self.capture == "title":
            self.capture = ""
        elif self.capture == "snippet":
            self.capture = ""
            if self.current.get("title") and self.current.get("url"):
                self.items.append(self.current)
            self.current = {}


def _decode_html(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")


def readable_text(data: bytes, content_type: str = "text/html") -> str:
    if content_type == "text/html" or content_type == "application/xhtml+xml":
        parser = _TextExtractor()
        parser.feed(_decode_html(data))
        parser.close()
        text = " ".join("".join(parser.parts).split())
    else:
        text = " ".join(_decode_html(data).split())
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS] + "\n…（正文已截断）"
    return text


def fetch_url(url: str) -> Dict[str, Any]:
    data, content_type, final_url = download(url)
    return {"url": final_url, "text": readable_text(data, content_type)}


def web_search(query: str, limit: int = 5) -> List[Dict[str, str]]:
    text_query = str(query or "").strip()
    if not text_query:
        raise WebAccessError("搜索关键词不能为空")
    url = "https://html.duckduckgo.com/html/?" + str(httpx.QueryParams({"q": text_query}))
    data, _, _ = download(url)
    parser = _SearchExtractor()
    parser.feed(_decode_html(data))
    parser.close()
    results = []
    for item in parser.items:
        href = item["url"]
        if href.startswith("/"):
            href = urljoin("https://html.duckduckgo.com", href)
        redirect = urlparse(href)
        if redirect.path == "/l/":
            href = parse_qs(redirect.query).get("uddg", [href])[0]
        try:
            safe_url = validate_public_url(href)
        except WebAccessError:
            continue
        results.append({"title": " ".join(item["title"].split()), "url": safe_url,
                        "snippet": " ".join(item["snippet"].split())})
        if len(results) >= max(1, min(int(limit or 5), 10)):
            break
    return results
