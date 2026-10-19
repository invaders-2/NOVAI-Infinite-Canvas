#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""page_import.py —— 从"页面链接"里解析出主图并落地成本地素材。

场景：用户从内嵌浏览器拖进来的是页面链接（Content-Type: text/html），
直接交给 /api/local-assets/import-urls 会报"不是图片或视频资源：text/html"。
本模块先拿到页面 HTML，按 og:image → twitter:image → <link rel="image_src">
→ 页面里尺寸最大的 <img> 的顺序找主图，然后**完全复用** import-urls 的落盘
链路（同样的 deps 帮助函数：类型判定 / 魔数纠扩展 / 命名 / 分类旁车），
返回结构也与 import-urls 一致：{ok, count, files, items}。

安全边界：
- 只接受 http(s)；拒绝 userinfo、非 80/443 端口。
- 页面、图片、以及**每一跳重定向**都做 DNS → IP 校验，拒绝 loopback /
  私网 / link-local / 保留段（用 ipaddress.is_global 判定）。
- 页面响应上限 2MB、总超时 10s；图片上限 15MB、单张超时 20s。
- 不写死任何目标站点，域名白名单只用于"排序优先"，不用于放行。

已知限制（LIMITATIONS）：
- DNS 校验与实际建连之间存在极小 TOCTOU 窗口（低危，本机单用户场景可接受）。
- 有反爬的站点（如花瓣）在服务端抓取会被拦，返回的是验证/错误页；
  此时调用方可把内嵌浏览器里已加载的 HTML 通过 body.html 传进来（仍走同样的
  图片下载与安全校验），见 _looks_like_block_page()。
- 只解析图片（og:video / <video> 不在本期范围）。

Python 3.9 约束：注解只用 Optional/List/Dict/Tuple，禁止 X | Y。
"""
from __future__ import annotations

import asyncio
import base64
import html as html_module
import ipaddress
import os
import re
import socket
import urllib.parse
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.routes import assets as assets_routes
from server.routes.deps import deps

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------- 常量

PAGE_MAX_BYTES = 2 * 1024 * 1024          # 页面 HTML 上限 2MB
PAGE_TIMEOUT_SECONDS = 10.0               # 页面总超时 10s
MEDIA_MAX_BYTES = 15 * 1024 * 1024        # 单张图片上限 15MB
MEDIA_TIMEOUT_SECONDS = 20.0
MAX_REDIRECTS = 5
MAX_IMAGES_CAP = 6
MAX_IMG_TAGS = 400                        # 单个页面最多解析的 <img> 数（防超大页 CPU 打满）
SMALL_EDGE = 200                          # 小于 200px 视为图标/头像

BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# 只用于"排序优先"，不是放行名单
PREFERRED_IMAGE_DOMAINS = (
    "pinimg.com",
    "huabanimg.com",
    "huaban.com",
    "xhscdn.com",
)

# 这些站点的 og:image 经常是品牌 logo，页面里又有大图 → auto 模式优先取大图
SITE_PREFERS_LARGEST_HOSTS = (
    "xiaohongshu.com",
    "pinterest.com",
    "huaban.com",
)
LARGE_IMG_EDGE = 400                      # 大图门槛：max(width, height) >= 400
PREFER_VALUES = ("og", "largest", "auto")

# og:image 也可能指向品牌图/默认图；命中这些特征且有别的候选时跳过它
_BRAND_ASSET_RE = re.compile(
    r"(?:^|[/._-])(?:logo|avatar|icon|brand|favicon|sprite|watermark|qrcode"
    r"|default[-_]?(?:avatar|cover|share)|share[-_]?(?:default|logo))(?:[/._-]|$)",
    re.IGNORECASE,
)
_BRAND_FILE_HINTS = (
    "xiaohongshu-logo",
    "xiaohongshu_logo",
    "xhs-logo",
    "xhs_logo",
    "red-logo",
    "redlogo",
    "brand-logo",
    "official-logo",
)

_OG_KEYS = ("og:image", "og:image:url", "og:image:secure_url")
_TWITTER_KEYS = ("twitter:image", "twitter:image:src")
_JUNK_URL_RE = re.compile(
    r"(?:^|[/._-])(?:avatar|icon|logo|favicon|sprite|emoji|badge|qrcode|qrcode|placeholder"
    r"|blank|spacer|pixel|loading|lazy|default)(?:[/._-]|$)",
    re.IGNORECASE,
)
_BLOCK_MARKERS = (
    "异常访问",
    "出错了-花瓣网",
    "access denied",
    "just a moment",
    "attention required",
    "cf-chl",
    "__jsl",
    "eo_bot",
    "请开启javascript",
    "验证码",
    "are you a robot",
    "captcha",
)


# ---------------------------------------------------------------- 错误类型

class PageImportError(Exception):
    """带错误码的可读异常，handler 会翻成对应 HTTP 状态码 + 中文 detail。"""

    CODES = {
        "unsafe_url": 400,
        "fetch_failed": 502,
        "too_large": 413,
        "not_html": 415,
        "blocked": 422,
        "no_image": 422,
        "download_failed": 502,
        "bad_request": 400,
    }

    def __init__(self, message: str, code: str = "fetch_failed") -> None:
        super().__init__(message)
        self.message = message
        self.code = code if code in self.CODES else "fetch_failed"

    @property
    def status_code(self) -> int:
        return self.CODES[self.code]


# ---------------------------------------------------------------- 请求/响应模型

class PageImportRequest(BaseModel):
    url: str = ""
    folder: str = ""
    name: str = ""
    # 可选：调用方（内嵌浏览器 / 桌面壳）已经拿到页面 HTML 时直接传进来，
    # 避免服务端被反爬拦；图片仍由服务端下载并做安全校验。
    html: str = ""
    base_url: str = ""
    max_images: int = 1
    # 'og' 永远先信 og:image；'largest' 永远取页面里最大的 <img>；
    # 'auto'（默认）在 xiaohongshu/pinterest/huaban 这类 og 常是品牌图的站点上取大图，其余站点维持 og 优先。
    prefer: str = "auto"
    classify: bool = False
    provider: str = "comfly"
    model: str = ""
    ms_model: str = ""
    prompt: str = ""


# ---------------------------------------------------------------- 依赖读取（main 未 bind 时给默认值，方便单测）

def _ssl_context() -> Any:
    return deps.get("_SSL_CONTEXT", True)


def _trust_env() -> bool:
    return bool(deps.get("_TRUST_ENV", False))


def _new_http_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    # 与 import-urls 相同的 httpx 配置；follow_redirects 手动做，才能逐跳做 SSRF 校验
    return httpx.AsyncClient(
        http2=False,
        verify=_ssl_context(),
        trust_env=_trust_env(),
        timeout=timeout,
        follow_redirects=False,
        headers={
            "User-Agent": BROWSER_UA,
            "Accept": "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )


# ---------------------------------------------------------------- URL / SSRF 校验

def _private_host_allowlist() -> Tuple[str, ...]:
    """仅测试用：NOVAI_PAGE_IMPORT_PRIVATE_HOSTS=127.0.0.1,localhost 允许本地夹具服务。

    列进去的主机会被放行私网 IP 与任意端口（夹具服务通常跑在 3198 这类端口）。
    默认空 → 一律拒绝私网、只允许 80/443。生产/CI 不要设置。
    """
    raw = os.environ.get("NOVAI_PAGE_IMPORT_PRIVATE_HOSTS", "")
    return tuple(part.strip().lower() for part in raw.split(",") if part.strip())


def split_public_url(raw: str) -> Tuple[str, str, Optional[int]]:
    """同步校验 scheme/userinfo/端口/host 形态，返回 (normalized_url, host, port)。

    不做 DNS 解析，便于单测；DNS/IP 校验在 assert_public_url() 里。
    """
    text = str(raw or "").strip()
    if not text:
        raise PageImportError("缺少页面地址", "bad_request")
    parsed = urllib.parse.urlsplit(text)
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise PageImportError("只支持 http(s) 链接", "unsafe_url")
    if parsed.username or parsed.password:
        raise PageImportError("链接里不允许带账号密码", "unsafe_url")
    try:
        port = parsed.port
    except ValueError:
        raise PageImportError("链接端口不合法", "unsafe_url")
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise PageImportError("链接里没有有效域名", "unsafe_url")
    if port not in (None, 80, 443) and host not in _private_host_allowlist():
        raise PageImportError("只允许访问 80/443 端口的公开链接", "unsafe_url")
    if not re.match(r"^[a-z0-9._:\[\]-]+$", host):
        raise PageImportError("链接域名不合法", "unsafe_url")
    return text, host, port


def ip_is_public(value: str) -> bool:
    """True 表示公网可访问地址。loopback/私网/link-local/保留段都返回 False。"""
    try:
        ip = ipaddress.ip_address(str(value or "").split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    try:
        return bool(ip.is_global)
    except Exception:
        return False


def _resolved_ips(host: str) -> List[str]:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, OSError, UnicodeError):
        return []
    ips: List[str] = []
    for info in infos:
        address = info[4][0] if len(info) > 4 else ""
        if address and address not in ips:
            ips.append(address)
    return ips


def _assert_ips_public(host: str, ips: List[str]) -> None:
    if not ips:
        raise PageImportError(f"解析不到域名地址：{host}", "fetch_failed")
    for address in ips:
        if not ip_is_public(address):
            if host in _private_host_allowlist():
                continue
            raise PageImportError(
                "这个链接指向内网/本机地址，出于安全考虑不允许访问",
                "unsafe_url",
            )


async def assert_public_url(raw: str) -> Tuple[str, str, Optional[int]]:
    normalized, host, port = split_public_url(raw)
    # IP 字面量直接判定，避免多一次 DNS
    try:
        ipaddress.ip_address(host.strip("[]"))
        literal = host.strip("[]")
        _assert_ips_public(host, [literal])
        return normalized, host, port
    except ValueError:
        pass
    ips = await asyncio.to_thread(_resolved_ips, host)
    _assert_ips_public(host, ips)
    return normalized, host, port


# ---------------------------------------------------------------- 抓取（逐跳校验）

async def _read_limited(response: httpx.Response, max_bytes: int, too_large_message: str) -> bytes:
    chunks: List[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        if not chunk:
            continue
        total += len(chunk)
        if total > max_bytes:
            raise PageImportError(too_large_message, "too_large")
        chunks.append(chunk)
    return b"".join(chunks)


async def fetch_limited(
    client: httpx.AsyncClient,
    url: str,
    max_bytes: int,
    timeout_seconds: float,
    too_large_message: str,
    failure_label: str,
) -> Dict[str, Any]:
    """逐跳跟随重定向，每一跳都做公网校验；正文有硬上限。"""
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        try:
            current, _host, _port = await assert_public_url(current)
        except PageImportError:
            raise
        try:
            request = client.build_request("GET", current)
            response = await asyncio.wait_for(
                client.send(request, stream=True, follow_redirects=False),
                timeout=timeout_seconds,
            )
        except asyncio.TimeoutError:
            raise PageImportError(f"{failure_label}：请求超时（{int(timeout_seconds)}s）", "fetch_failed")
        except httpx.TimeoutException:
            raise PageImportError(f"{failure_label}：请求超时（{int(timeout_seconds)}s）", "fetch_failed")
        except httpx.HTTPError as exc:
            raise PageImportError(f"{failure_label}：{_short_error(exc)}", "fetch_failed")
        try:
            status = response.status_code
            if status in (301, 302, 303, 307, 308):
                location = response.headers.get("location") or ""
                await response.aclose()
                if not location:
                    raise PageImportError(f"{failure_label}：重定向缺少目标地址", "fetch_failed")
                current = urllib.parse.urljoin(current, location)
                continue
            if status >= 400:
                await response.aclose()
                raise PageImportError(f"{failure_label}：HTTP {status}", "fetch_failed")
            content_type = (response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
            try:
                content = await asyncio.wait_for(
                    _read_limited(response, max_bytes, too_large_message),
                    timeout=timeout_seconds,
                )
            except asyncio.TimeoutError:
                raise PageImportError(f"{failure_label}：读取超时（{int(timeout_seconds)}s）", "fetch_failed")
            except httpx.TimeoutException:
                raise PageImportError(f"{failure_label}：读取超时（{int(timeout_seconds)}s）", "fetch_failed")
            except httpx.HTTPError as exc:
                raise PageImportError(f"{failure_label}：{_short_error(exc)}", "fetch_failed")
            return {
                "content": content,
                "content_type": content_type,
                "url": current,
                "status": status,
            }
        finally:
            await response.aclose()
    raise PageImportError(f"{failure_label}：重定向次数过多", "fetch_failed")


def _short_error(exc: Exception) -> str:
    text = str(exc or "").strip().replace("\n", " ")
    return text[:160] if text else type(exc).__name__


# ---------------------------------------------------------------- HTML 解析

class _PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.metas: List[Tuple[str, str]] = []
        self.image_src_links: List[str] = []
        self.base_href = ""
        self.images: List[Dict[str, str]] = []
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        attrs_map: Dict[str, str] = {}
        for key, value in attrs or []:
            if key:
                attrs_map[str(key).strip().lower()] = value if value is not None else ""
        if tag == "meta":
            meta_key = (
                attrs_map.get("property")
                or attrs_map.get("name")
                or attrs_map.get("itemprop")
                or ""
            ).strip().lower()
            content = (attrs_map.get("content") or "").strip()
            if meta_key and content:
                self.metas.append((meta_key, content))
        elif tag == "link":
            rel = (attrs_map.get("rel") or "").strip().lower()
            href = (attrs_map.get("href") or "").strip()
            if href and "image_src" in rel:
                self.image_src_links.append(href)
        elif tag == "base":
            href = (attrs_map.get("href") or "").strip()
            if href and not self.base_href:
                self.base_href = href
        elif tag == "img":
            if len(self.images) < MAX_IMG_TAGS:
                self.images.append(attrs_map)
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:  # type: ignore[override]
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:  # type: ignore[override]
        if self._in_title and data:
            self.title += data


def _parse_dimension(value: str) -> int:
    match = re.match(r"^\s*(\d+)", str(value or ""))
    return int(match.group(1)) if match else 0


def _srcset_candidates(value: str) -> List[Tuple[str, int]]:
    """把 srcset 拆成 [(url, width)]；没有 w 描述符时用位置当权重。"""
    out: List[Tuple[str, int]] = []
    for index, part in enumerate(str(value or "").split(",")):
        piece = part.strip()
        if not piece:
            continue
        bits = piece.split()
        url = bits[0].strip()
        if not url:
            continue
        width = 0
        if len(bits) > 1:
            match = re.match(r"^(\d+)(?:w|W)$", bits[1])
            if match:
                width = int(match.group(1))
        if not width:
            match = re.match(r"^(\d+(?:\.\d+)?)(?:x|X)$", bits[1]) if len(bits) > 1 else None
            width = int(float(match.group(1)) * 1000) if match else index
        out.append((url, width))
    return out


def _absolute_image_url(base_url: str, raw: str) -> str:
    text = html_module.unescape(str(raw or "")).strip().strip('"').strip("'")
    if not text:
        return ""
    if text.startswith("//"):
        text = urllib.parse.urlsplit(base_url).scheme + ":" + text
    try:
        absolute = urllib.parse.urljoin(base_url, text)
    except ValueError:
        return ""
    parsed = urllib.parse.urlsplit(absolute)
    if (parsed.scheme or "").lower() not in ("http", "https"):
        return ""
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def _host_from_url(url: str) -> str:
    try:
        return (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _is_preferred_host(host: str) -> bool:
    if not host:
        return False
    return any(host == domain or host.endswith("." + domain) for domain in PREFERRED_IMAGE_DOMAINS)


def _site_prefers_largest(host: str) -> bool:
    """页面 host 是否属于"og:image 常是品牌图、应优先取大图"的站点。"""
    value = str(host or "").lower()
    if not value:
        return False
    return any(value == domain or value.endswith("." + domain) for domain in SITE_PREFERS_LARGEST_HOSTS)


def _looks_like_brand_image(url: str) -> bool:
    """og:image 是不是品牌图 / 默认分享图（logo、avatar、brand、小红书官方品牌图等）。"""
    text = str(url or "").strip()
    if not text:
        return False
    path = urllib.parse.unquote(urllib.parse.urlsplit(text).path or "")
    if _BRAND_ASSET_RE.search(path):
        return True
    filename = os.path.basename(path).lower()
    if filename and any(hint in filename for hint in _BRAND_FILE_HINTS):
        return True
    return False


def _candidate_is_large(candidate: Dict[str, Any]) -> bool:
    """尺寸 >= 400px 的 <img>（width/height 属性或 srcset 描述符估算）。"""
    width = int(candidate.get("width") or 0)
    height = int(candidate.get("height") or 0)
    return max(width, height) >= LARGE_IMG_EDGE


def _candidate_size_key(candidate: Dict[str, Any]) -> tuple:
    """取最大图用的排序键：有尺寸的优先，其次面积大的，最后 DOM 靠后的（拿不到尺寸时放宽用）。"""
    width = int(candidate.get("width") or 0)
    height = int(candidate.get("height") or 0)
    return (
        1 if (width or height) else 0,
        int(candidate.get("area") or 0),
        int(candidate.get("order") or 0),
    )


def _picked_label(candidate: Optional[Dict[str, Any]], as_largest: bool = False) -> str:
    """page.picked：给前端日志诊断用，取值 og / largest / image_src / img。"""
    if as_largest:
        return "largest"
    if not candidate:
        return ""
    raw_priority = candidate.get("priority")
    priority = 3 if raw_priority is None else int(raw_priority)
    if priority in (0, 1):
        return "og"
    if priority == 2:
        return "image_src"
    return "img"


def _looks_like_junk(url: str, alt: str = "", css: str = "") -> bool:
    lowered = str(url or "").lower()
    path = urllib.parse.urlsplit(lowered).path
    if path.endswith((".svg", ".ico")):
        return True
    if _JUNK_URL_RE.search(path):
        return True
    blob = " ".join([str(alt or ""), str(css or "")]).strip()
    if blob and re.search(r"(?:头像|图标|logo|icon|avatar)", blob, re.IGNORECASE):
        return True
    return False


def _is_hard_junk(url: str) -> bool:
    """无论来源都必须挡掉的格式：svg / ico（不能当画布素材）。"""
    return urllib.parse.urlsplit(str(url or "").lower()).path.endswith((".svg", ".ico"))


def _make_candidate(
    url: str,
    priority: int,
    order: int,
    width: int = 0,
    height: int = 0,
    alt: str = "",
    strict_junk: bool = True,
) -> Optional[Dict[str, Any]]:
    # <img> 要防图标/头像/logo；og:image / twitter:image 是站点指定的分享图，
    # 即使文件名带 logo 也照用（只挡 .svg/.ico 这类明确不能当素材的格式）
    if not url:
        return None
    if _looks_like_junk(url, alt) and (strict_junk or _is_hard_junk(url)):
        return None
    host = _host_from_url(url)
    return {
        "url": url,
        "priority": priority,          # 0 og:image / 1 twitter / 2 image_src / 3 <img>
        "order": order,
        "width": width,
        "height": height,
        "area": width * height,
        "alt": alt,
        "host": host,
        "preferred": _is_preferred_host(host),
        # 只有 og:image 需要标记品牌图（品牌 logo 在站点分享图里很常见）
        "brand": priority == 0 and _looks_like_brand_image(url),
    }


def parse_page_images(
    html_text: str,
    base_url: str,
    max_images: int = 1,
    prefer: str = "auto",
) -> Dict[str, Any]:
    """解析 HTML 里的主图候选，按优先级返回。纯函数，方便单测。

    prefer：
    - 'og'      永远先信 og:image / twitter:image；
    - 'largest' 永远取页面里面积最大的 <img>（没有 <img> 才回退 meta）；
    - 'auto'    xiaohongshu / pinterest / huaban 这类站点（og 常是品牌图）且存在
                >=400px 的 <img> 时取最大 <img>，其余情况维持 og 优先。
    og:image 命中品牌图特征且还有别的候选时会被跳过（见 _looks_like_brand_image）。
    """

    parser = _PageParser()
    try:
        parser.feed(str(html_text or ""))
        parser.close()
    except Exception:
        # 半截 HTML 也尽量用已经解析出来的部分
        pass

    # <base href> 会改变相对地址的解析基准（不少老站/图床页用它）
    if parser.base_href:
        base_url = _absolute_image_url(base_url, parser.base_href) or base_url

    candidates: List[Dict[str, Any]] = []
    seen: set = set()
    order = 0

    def add(candidate: Optional[Dict[str, Any]]) -> None:
        nonlocal order
        order += 1
        if not candidate:
            return
        key = candidate["url"].split("#", 1)[0]
        if key in seen:
            return
        seen.add(key)
        candidates.append(candidate)

    for meta_key, content in parser.metas:
        if meta_key in _OG_KEYS:
            add(_make_candidate(_absolute_image_url(base_url, content), 0, order, strict_junk=False))
        elif meta_key in _TWITTER_KEYS:
            add(_make_candidate(_absolute_image_url(base_url, content), 1, order, strict_junk=False))

    for href in parser.image_src_links:
        add(_make_candidate(_absolute_image_url(base_url, href), 2, order, strict_junk=False))

    for attrs in parser.images:
        raw = (
            attrs.get("src")
            or attrs.get("data-src")
            or attrs.get("data-original")
            or attrs.get("data-lazy-src")
            or ""
        )
        width = _parse_dimension(attrs.get("width", ""))
        height = _parse_dimension(attrs.get("height", ""))
        srcset = attrs.get("srcset") or attrs.get("data-srcset") or ""
        srcset_items = _srcset_candidates(srcset)
        if srcset_items:
            best_url, best_width = max(srcset_items, key=lambda item: item[1])
            if best_width and not raw:
                raw = best_url
            elif best_width > (width or 0):
                raw = best_url
                width = best_width
        absolute = _absolute_image_url(base_url, raw)
        if not absolute:
            continue
        # 声明尺寸小于 200px 的 <img> 视为图标/头像/logo
        if (width and width < SMALL_EDGE) or (height and height < SMALL_EDGE):
            continue
        add(_make_candidate(
            absolute,
            3,
            order,
            width=width,
            height=height,
            alt=attrs.get("alt", ""),
        ))

    def _sort_key(item: Dict[str, Any]) -> tuple:
        return (
            int(item["priority"]),
            0 if item["preferred"] else 1,
            -int(item["area"] or 0),
            int(item["order"]),
        )

    candidates.sort(key=_sort_key)

    # 品牌图兜底过滤：og:image 命中 logo/avatar/brand，且页面里还有别的候选 → 跳过它
    has_non_brand = any(not (item["priority"] == 0 and item.get("brand")) for item in candidates)
    if has_non_brand:
        candidates = [item for item in candidates if not (item["priority"] == 0 and item.get("brand"))]

    prefer_mode = str(prefer or "auto").strip().lower()
    if prefer_mode not in PREFER_VALUES:
        prefer_mode = "auto"
    page_host = _host_from_url(base_url)
    img_candidates = [item for item in candidates if item["priority"] == 3]
    large_imgs = [item for item in img_candidates if _candidate_is_large(item)]

    pick: Optional[Dict[str, Any]] = None
    picked = ""
    if prefer_mode == "largest" and img_candidates:
        # 显式要最大图：有尺寸的按面积，拿不到尺寸的按 DOM 顺序靠后放宽
        pick = max(large_imgs or img_candidates, key=_candidate_size_key)
        picked = "largest"
    elif prefer_mode == "auto" and _site_prefers_largest(page_host) and large_imgs:
        # 分享图常是品牌 logo 的站点：有 >=400px 的 <img> 就取其中最大的
        pick = max(large_imgs, key=_candidate_size_key)
        picked = "largest"
    elif candidates:
        pick = candidates[0]
        picked = _picked_label(pick)

    if pick is not None:
        candidates = [pick] + [item for item in candidates if item is not pick]

    limit = max(1, min(MAX_IMAGES_CAP, int(max_images or 1)))
    return {
        "title": re.sub(r"\s+", " ", parser.title or "").strip()[:200],
        "candidates": candidates[:limit],
        "candidate_total": len(candidates),
        "picked": picked,
    }


def _looks_like_block_page(html_text: str, content_type: str = "") -> bool:
    """反爬验证页识别：花瓣/加速乐/Cloudflare 这类"HTTP 200 + 错误页"。"""
    text = str(html_text or "")
    lowered = text.lower()
    for marker in _BLOCK_MARKERS:
        if marker in lowered:
            return True
    if len(text) < 2048 and "<img" not in lowered and "html" in (content_type or "html"):
        return True
    return False


def _page_title_slug(title: str) -> str:
    text = re.sub(r"[\r\n\t]+", " ", str(title or ""))
    text = re.sub(r"[\s\-_|·—–/\\:：]+", "_", text)
    text = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "", text)
    text = text.strip("._-")
    return text[:60]


def _data_url(content: bytes, content_type: str) -> str:
    encoded = base64.b64encode(content).decode("ascii")
    return "data:{};base64,{}".format(content_type or "application/octet-stream", encoded)


def _decode_html(raw: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------- 落盘（复用 import-urls）

async def _persist_items(
    payload: PageImportRequest,
    media_items: List[Dict[str, str]],
) -> Dict[str, Any]:
    """把已下载好的字节交给 /api/local-assets/import-urls 的同一个 handler 落盘。

    走 base64(data) 通道，类型判定 / 魔数纠扩展 / 命名 / 分类旁车全部复用老逻辑，
    不重复实现一遍。
    """
    request_payload = assets_routes.LocalAssetUrlImportRequest(
        items=[
            assets_routes.LocalAssetUrlImportItem(
                url=item.get("url", ""),
                name=item.get("name", ""),
                data=item.get("data", ""),
                content_type=item.get("content_type", ""),
            )
            for item in media_items
        ],
        folder=payload.folder or "",
        classify=bool(payload.classify),
        provider=payload.provider or "comfly",
        model=payload.model or "",
        ms_model=payload.ms_model or "",
        prompt=payload.prompt or "",
    )
    return await assets_routes.import_local_assets_from_urls(request_payload)


# ---------------------------------------------------------------- 端点

@router.post("/local-assets/import-from-page")
async def import_assets_from_page(payload: PageImportRequest):
    """页面链接 → 主图 → 落盘。返回结构与 import-urls 一致。"""
    try:
        return await _import_from_page(payload)
    except PageImportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message)


async def _import_from_page(payload: PageImportRequest) -> Dict[str, Any]:
    page_url = (payload.url or "").strip()
    base_url = (payload.base_url or page_url).strip()
    if not base_url:
        raise PageImportError("缺少页面地址", "bad_request")
    prefer = str(payload.prefer or "auto").strip().lower()
    if prefer not in PREFER_VALUES:
        raise PageImportError("prefer 只能是 og / largest / auto", "bad_request")

    inline_html = payload.html or ""
    if len(inline_html.encode("utf-8")) > PAGE_MAX_BYTES:
        raise PageImportError("传入的页面 HTML 超过 2MB，已放弃解析", "too_large")

    html_text = ""
    final_url = base_url
    page_content_type = "text/html"
    page_source = "fetch"

    if inline_html.strip():
        normalized, _host, _port = await assert_public_url(base_url)
        final_url = normalized
        html_text = inline_html
        page_source = "html"
    else:
        await assert_public_url(page_url)
        timeout = httpx.Timeout(connect=8.0, read=PAGE_TIMEOUT_SECONDS, write=10.0, pool=5.0)
        async with _new_http_client(timeout) as client:
            try:
                page = await asyncio.wait_for(
                    fetch_limited(
                        client,
                        page_url,
                        PAGE_MAX_BYTES,
                        PAGE_TIMEOUT_SECONDS,
                        "页面超过 2MB，已放弃解析",
                        "打开页面失败",
                    ),
                    timeout=PAGE_TIMEOUT_SECONDS + 2.0,
                )
            except asyncio.TimeoutError:
                raise PageImportError("打开页面超时（10s）", "fetch_failed")
        final_url = page["url"]
        page_content_type = page["content_type"] or ""
        content = page["content"]

        # 拖进来的其实就是图片/视频直链：直接落盘，报文与 import-urls 一致
        if page_content_type.startswith(("image/", "video/")):
            return await _import_direct_media(payload, final_url, content, page_content_type)

        if page_content_type and not (
            page_content_type.startswith("text/") or "html" in page_content_type or "xml" in page_content_type
        ):
            raise PageImportError(f"这个链接不是网页（{page_content_type}），请直接拖入图片", "not_html")
        html_text = _decode_html(content)

    parsed = parse_page_images(html_text, final_url, payload.max_images or 1, prefer)
    candidates = parsed["candidates"]
    if not candidates:
        if _looks_like_block_page(html_text, page_content_type):
            raise PageImportError(
                "目标页面被网站的反爬机制拦住了（返回的是验证页/错误页）。"
                "请在应用内嵌浏览器里打开该页面后再拖入，或稍后重试。",
                "blocked",
            )
        raise PageImportError(
            "页面里没有找到可用的图片（可能是登录墙、懒加载或纯文字页）",
            "no_image",
        )

    downloaded: List[Dict[str, str]] = []
    failures: List[Dict[str, str]] = []
    timeout = httpx.Timeout(connect=8.0, read=MEDIA_TIMEOUT_SECONDS, write=10.0, pool=5.0)
    async with _new_http_client(timeout) as client:
        for candidate in candidates:
            image_url = candidate["url"]
            display_name = payload.name or _page_title_slug(parsed.get("title", "")) or ""
            try:
                media = await asyncio.wait_for(
                    fetch_limited(
                        client,
                        image_url,
                        MEDIA_MAX_BYTES,
                        MEDIA_TIMEOUT_SECONDS,
                        "图片超过 15MB，已跳过",
                        "下载图片失败",
                    ),
                    timeout=MEDIA_TIMEOUT_SECONDS + 2.0,
                )
            except PageImportError as exc:
                failures.append({"url": image_url, "error": exc.message})
                continue
            except asyncio.TimeoutError:
                failures.append({"url": image_url, "error": "下载图片超时"})
                continue
            content_type = media["content_type"] or ""
            if not content_type.startswith("image/"):
                failures.append({"url": image_url, "error": f"下载到的不是图片（{content_type or '未知类型'}）"})
                continue
            name = display_name or urllib.parse.unquote(
                os.path.basename(urllib.parse.urlsplit(image_url).path) or "page-image"
            )
            downloaded.append(
                {
                    "url": media["url"],
                    "name": name,
                    "data": _data_url(media["content"], content_type),
                    "content_type": content_type,
                }
            )

    if not downloaded:
        reason = failures[0]["error"] if failures else "未知原因"
        raise PageImportError(f"页面里找到图片，但下载失败：{reason}", "download_failed")

    persisted = await _persist_items(payload, downloaded)
    persisted_items = list(persisted.get("items") or [])
    merged_items: List[Dict[str, Any]] = []
    persisted_index = 0
    for candidate in candidates:
        image_url = candidate["url"]
        failed = next((item for item in failures if item["url"] == image_url), None)
        if failed:
            merged_items.append({"url": image_url, "ok": False, "file": "", "error": failed["error"]})
            continue
        if persisted_index < len(persisted_items):
            merged_items.append(persisted_items[persisted_index])
            persisted_index += 1
    for leftover in persisted_items[persisted_index:]:
        merged_items.append(leftover)

    return {
        "ok": True,
        "count": int(persisted.get("count") or 0),
        "files": persisted.get("files") or [],
        "items": merged_items,
        "page": {
            "url": final_url,
            "title": parsed.get("title") or "",
            "source": page_source,
            "image_total": parsed.get("candidate_total") or 0,
            # 这次按哪条规则挑的主图：og / largest / image_src / img
            "picked": parsed.get("picked") or "",
        },
    }


async def _import_direct_media(
    payload: PageImportRequest,
    media_url: str,
    content: bytes,
    media_type: str,
) -> Dict[str, Any]:
    if not content:
        raise PageImportError("链接内容为空", "download_failed")
    if len(content) > MEDIA_MAX_BYTES:
        raise PageImportError("图片超过 15MB，已跳过", "too_large")
    kind = "视频" if media_type.startswith("video/") else "图片"
    name = payload.name or urllib.parse.unquote(
        os.path.basename(urllib.parse.urlsplit(media_url).path) or "page-media"
    )
    persisted = await _persist_items(
        payload,
        [{
            "url": media_url,
            "name": name,
            "data": _data_url(content, media_type),
            "content_type": media_type,
        }],
    )
    return {
        "ok": True,
        "count": int(persisted.get("count") or 0),
        "files": persisted.get("files") or [],
        "items": persisted.get("items") or [],
        "page": {
            "url": media_url,
            "title": name,
            "source": "direct-" + kind,
            "image_total": 1,
            # 直链本身就是主图，没有解析/挑选步骤
            "picked": "",
        },
    }
