"""联网搜图 / 反图（视觉模型读图→检索词→图搜）/ 原图下载落库。

契约见 docs/agent-web-image-search.md：
- search_images：多来源（花瓣/堆糖/必应图片/360 图片，尽力站酷）并发聚合，按 original_url 去重；
- find_similar_images：调用方注入「读图」回调（项目现有的看图链路，在 main.py 里），
  本模块只负责检索词 → 图搜 → 合并，绝不自己猜关键词；
- 原图下载：跟随重定向 ≤5、带 UA/Referer、20 秒超时、≤25MB、魔数嗅探、真实宽高，
  长边 < 300px 判「只拿到缩略图」。
"""
from __future__ import annotations

import asyncio
import hashlib
import threading
import html as html_module
import io
import json
import os
import re
import uuid
from collections import OrderedDict
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, urljoin, urlparse, urlunparse

import httpx

from server import net_proxy, web_access

MAX_ITEMS = 24
MAX_IMPORT_URLS = 12
MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
DOWNLOAD_TIMEOUT = 20.0
MAX_DOWNLOAD_REDIRECTS = 5
THUMBNAIL_MAX_SIDE = 300
ORIENTATIONS = ("any", "landscape", "portrait", "square")
BROWSER_UA = web_access.BROWSER_UA

_IMAGE_ACCEPT = "image/avif,image/webp,image/apng,image/png,image/*,*/*;q=0.8"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# 360 图搜对 Referer 很敏感：不带 image.so.com 会返回「访问异常出错」HTML（HTTP 200）
_SO360_REFERER = "https://image.so.com/"
_SO360_ACCEPT = "application/json, text/plain, */*"
_SO360_RETRY_DELAY = 0.3

# ---------------------------------------------------------------------------
# 图片来源：默认 7 站「全网」（国内四站 + 必应国际 + Pinterest + ArtStation）；
# 站酷/昵图/图虫等要么需要登录签名、要么接口没了，明确标注不可用，用户点名时才尝试
# （抓不到就把真实原因写进 note，不假装支持）。
# ---------------------------------------------------------------------------
SOURCE_TIMEOUT = 12.0
# Pinterest 要先 GET 首页拿 cookie 再打资源接口，两次请求，单独放宽一点
PINTEREST_TIMEOUT = SOURCE_TIMEOUT + 8.0
_SOURCE_TIMEOUTS = {"pinterest": PINTEREST_TIMEOUT}
DEFAULT_SOURCES = ("huaban", "duitang", "bing", "360", "bingglobal", "pinterest", "artstation")
ALL_SOURCES = ("huaban", "duitang", "bing", "360", "zcool",
               "bingglobal", "pinterest", "artstation")
SOURCE_LABELS = {
    "huaban": "花瓣", "duitang": "堆糖", "bing": "必应图片", "360": "360 图片", "zcool": "站酷",
    "bingglobal": "必应国际", "pinterest": "Pinterest", "artstation": "ArtStation",
    "nipic": "昵图网", "tuchong": "图虫",
    "xiaohongshu": "小红书", "baidu": "百度图片",
    "unsplash": "Unsplash", "pexels": "Pexels", "pixabay": "Pixabay",
}
# 明确不接的来源 + 原因（会写进工具结果 note，前端/用户能看到真实结论）
UNSUPPORTED_SOURCES = {
    "xiaohongshu": "需要登录并带 x-s/x-t 签名，拿不到原图",
    "baidu": "返回 Forbid spider access（反爬）",
    "unsplash": "匿名接口 401（需要 API key）",
    "pexels": "接口 403（需要 API key）",
    "pixabay": "需要 API key",
    "nipic": "昵图网搜索返回 HTTP 500（反爬/接口变更），本次跳过",
    "tuchong": "图虫搜索接口 404（未开放），本次跳过",
}
_SOURCE_ALIASES = {
    "huaban": "huaban", "花瓣": "huaban", "花瓣网": "huaban",
    "duitang": "duitang", "堆糖": "duitang", "堆糖网": "duitang",
    "bing": "bing", "必应": "bing", "必应图片": "bing", "bing图片": "bing",
    "bingglobal": "bingglobal", "必应国际": "bingglobal", "全网": "bingglobal",
    "global": "bingglobal", "web": "bingglobal", "bing国际": "bingglobal",
    "360": "360", "so": "360", "360图片": "360",
    "zcool": "zcool", "站酷": "zcool", "站酷网": "zcool",
    "nipic": "nipic", "昵图": "nipic", "昵图网": "nipic",
    "tuchong": "tuchong", "图虫": "tuchong", "图虫网": "tuchong",
    "xiaohongshu": "xiaohongshu", "xhs": "xiaohongshu", "小红书": "xiaohongshu", "redbook": "xiaohongshu",
    "pinterest": "pinterest", "p站": "pinterest", "pin站": "pinterest",
    "artstation": "artstation", "a站": "artstation", "美术站": "artstation",
    "artstation.com": "artstation",
    "baidu": "baidu", "百度": "baidu", "百度图片": "baidu",
    "unsplash": "unsplash", "pexels": "pexels", "pixabay": "pixabay",
}

# 已知缩略图 CDN：宁可判「只拿到缩略图」，也不许把缩略图落成原图
# 必应缩略图不止 ts1-4.mm.bing.net：真实形态还有 ts1.explicit.bing.net、tse*.mm.bing.net、
# th.bing.com/th/id/...（后者不带规则时只会被当成「不是图片」拒掉，原因不准确）。
_BING_NET_SUFFIX_RE = re.compile(r"(?:^|\.)bing\.net$", re.I)
_BING_COM_SUFFIX_RE = re.compile(r"(?:^|\.)bing\.com$", re.I)
_SO360_THUMB_HOST_RE = re.compile(r"\.qhimgs\d*\.com$", re.I)


class WebImageSearchError(ValueError):
    """带可读中文原因的失败：工具层/HTTP 层原样转给用户，不兜底。"""


def _image_id(original_url: str) -> str:
    return hashlib.sha1(str(original_url or "").encode("utf-8")).hexdigest()[:12]


def _clean_text(value: Any, limit: int = 120) -> str:
    text = " ".join(html_module.unescape(str(value or "")).split())
    return text[:limit]


def _positive_int(value: Any) -> Optional[int]:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _site_of(value: Any) -> str:
    host = (urlparse(str(value or "").strip()).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host[:80]


def _is_http_url(value: Any) -> bool:
    return str(value or "").strip().startswith(("http://", "https://"))


# 对外错误文案统一去掉 "ClassName: " 前缀（实现在 web_access，两个模块共用同一口径）
clean_error_text = web_access.clean_error_text


# 花瓣尺寸后缀：_fw236（236 宽）、_fw658、_sq75（75 方图）… 无后缀才是原图
_HUABAN_THUMB_SUFFIX_RE = re.compile(r"_(?:fw|sq)\d*$", re.I)
_HUABAN_HOST_SUFFIX_RE = re.compile(r"(?:^|\.)huabanimg\.com$", re.I)
_DUITANG_HOST_SUFFIX_RE = re.compile(r"(?:^|\.)dtstatic\.com$", re.I)
_ZCOOL_HOST_SUFFIX_RE = re.compile(r"(?:^|\.)zcool\.cn(\.cn)?$", re.I)


def is_huaban_thumbnail(url: Any) -> bool:
    """花瓣的尺寸变体（_fw236/_fw658/_sq75 …）都是缩略图，无后缀才是原图。"""
    parsed = urlparse(str(url or "").strip())
    host = (parsed.hostname or "").lower()
    if not _HUABAN_HOST_SUFFIX_RE.search(host):
        return False
    return bool(_HUABAN_THUMB_SUFFIX_RE.search(os.path.basename(parsed.path or "").rstrip("/")))


def huaban_original_url(url: Any) -> str:
    """花瓣缩略图 URL → 原图 URL（去掉 _fw236/_fw658/_sq75 这类尺寸后缀）。"""
    text = str(url or "").strip()
    parsed = urlparse(text)
    if not _HUABAN_HOST_SUFFIX_RE.search((parsed.hostname or "").lower()):
        return text
    path = _HUABAN_THUMB_SUFFIX_RE.sub("", parsed.path or "")
    if not path:
        return text
    return urlunparse((parsed.scheme or "https", parsed.netloc, path, "", parsed.query, ""))


def known_thumbnail_reason(url: Any) -> str:
    """已知的缩略图 CDN/路径 → 返回可读原因；不是缩略图返回空串。

    覆盖的真实形态：
    - 必应 ts*/tse* 且落在 bing.net（ts2.mm.bing.net、tse1.mm.bing.net、ts1.explicit.bing.net …）；
    - 必应 *.bing.com 且 path 以 /th/ 开头（th.bing.com/th/id/...）；
    - 360 *.qhimgs*.com 的 t 前缀缩略图；
    - 花瓣 *.huabanimg.com 的 _fw<数字>/_sq<数字> 尺寸变体（无后缀才是原图）；
    - 堆糖 *.dtstatic.com 带 x-image-process=image/resize 缩放参数的地址；
    - 站酷 img.zcool.cn 的 !/small 之类缩放后缀。
    域名规则比「长边 <300px」可靠：这些站的缩略图真实尺寸常见 400-600px，阈值拦不住。"""
    parsed = urlparse(str(url or "").strip())
    host = (parsed.hostname or "").lower()
    path = str(parsed.path or "")
    if not host:
        return ""
    if _BING_NET_SUFFIX_RE.search(host) and host.split(".")[0].startswith("ts"):
        return f"必应缩略图地址（{host}）"
    if _BING_COM_SUFFIX_RE.search(host) and path.lower().startswith("/th/"):
        return f"必应缩略图地址（{host}）"
    if _SO360_THUMB_HOST_RE.search(host):
        name = os.path.basename(path)
        if name[:1].lower() == "t":
            return f"360 缩略图地址（{host}）"
    if is_huaban_thumbnail(parsed.geturl()):
        return f"花瓣缩略图地址（{host}，_fw/_sq 尺寸后缀）"
    if _DUITANG_HOST_SUFFIX_RE.search(host) and "x-image-process" in str(parsed.query or "").lower():
        return f"堆糖缩略图地址（{host}，自带缩放参数）"
    if _ZCOOL_HOST_SUFFIX_RE.search(host) and ("!/" in path):
        return f"站酷缩略图地址（{host}，! 缩放后缀）"
    return ""


def _response_hint(response: Any) -> str:
    """失败原因里带上状态码/字节数/内容开头，方便判断是真限流还是接口改版。"""
    if response is None:
        return "没有响应"
    try:
        body = bytes(getattr(response, "content", b"") or b"")
        status = int(getattr(response, "status_code", 0) or 0)
        head = body[:120].decode("utf-8", errors="replace").replace("\n", " ").strip()
        return f"HTTP {status}，{len(body)} 字节，内容开头：{head}"
    except Exception:
        return "响应无法读取"


def _make_item(original_url: Any, thumb_url: Any = "", title: Any = "",
               width: Any = None, height: Any = None,
               source_page: Any = "", source_site: Any = "",
               source_kind: str = "") -> Optional[Dict[str, Any]]:
    """统一 ImageItem。original_url 必须是 http(s) 原图直链，否则丢弃（不拿缩略图顶上）。"""
    original = str(original_url or "").strip()
    if not _is_http_url(original):
        return None
    thumb = str(thumb_url or "").strip()
    if not _is_http_url(thumb):
        thumb = ""
    page = str(source_page or "").strip()
    site = _clean_text(source_site, 80) or _site_of(page) or _site_of(original)
    return {
        "id": _image_id(original),
        "title": _clean_text(title, 120),
        "original_url": original,
        "thumb_url": thumb,
        "width": _positive_int(width),
        "height": _positive_int(height),
        "source_page": page if _is_http_url(page) else "",
        "source_site": site,
        "source_kind": str(source_kind or "").strip().lower(),
    }


def _orientation_matches(item: Dict[str, Any], orientation: str) -> bool:
    if orientation not in ("landscape", "portrait", "square"):
        return True
    width, height = item.get("width"), item.get("height")
    if not width or not height:
        return True        # 尺寸拿不到时不擅自过滤（契约允许宽高为 null）
    ratio = width / height
    if orientation == "landscape":
        return ratio > 1.05
    if orientation == "portrait":
        return ratio < 0.95
    return 0.95 <= ratio <= 1.05


def _merge_items(groups: List[List[Dict[str, Any]]], limit: int) -> List[Dict[str, Any]]:
    """多引擎 / 多检索词合并：按 original_url 去重，轮转交替取，尽量让每个来源都有代表。
    重复时用信息更全的一份补齐宽高与出处（不覆盖已有的原图直链）。"""
    by_url: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for item in (entry for group in groups for entry in group):
        key = item["original_url"]
        if key not in by_url:
            by_url[key] = dict(item)
            order.append(key)
            continue
        kept = by_url[key]
        for field in ("thumb_url", "width", "height", "source_page", "source_site", "source_kind"):
            if not kept.get(field) and item.get(field):
                kept[field] = item[field]
        if not kept.get("title") and item.get("title"):
            kept["title"] = item["title"]
    picked: List[Dict[str, Any]] = []
    seen = set()
    index = 0
    while len(picked) < limit:
        added = False
        for group in groups:
            if index < len(group):
                key = group[index]["original_url"]
                if key not in seen and key in by_url:
                    seen.add(key)
                    picked.append(by_url[key])
                    if len(picked) >= limit:
                        break
                added = True
        if not added:
            break
        index += 1
    return picked


def _source_timeout(name: str) -> float:
    """单站超时：Pinterest 多一次首页请求，单独放宽。"""
    return _SOURCE_TIMEOUTS.get(str(name or ""), SOURCE_TIMEOUT)


def _reason(exc: BaseException, timeout: float = SOURCE_TIMEOUT) -> str:
    if isinstance(exc, WebImageSearchError):
        return str(exc)
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
        return f"请求超时（超过 {int(timeout)} 秒）"
    if isinstance(exc, httpx.ConnectError):
        return f"连接失败：{exc}"
    if isinstance(exc, httpx.HTTPError):
        return f"网络错误：{exc}"
    return clean_error_text(f"{type(exc).__name__}: {exc}", fallback="联网请求出错，未返回具体原因")


# ---------------------------------------------------------------------------
# 引擎 1：必应国内版图片 async（HTML，a.iusc 的 m 属性里是 JSON）
# ---------------------------------------------------------------------------

class _BingImageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.entries: List[Dict[str, str]] = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        data = dict(attrs)
        classes = set(str(data.get("class") or "").split())
        if "iusc" not in classes:
            return
        raw = str(data.get("m") or "").strip()
        if not raw:
            return
        try:
            meta = json.loads(raw)
        except ValueError:
            return
        if not isinstance(meta, dict):
            return
        self.entries.append({
            "murl": str(meta.get("murl") or ""),
            "turl": str(meta.get("turl") or ""),
            "purl": str(meta.get("purl") or ""),
            "title": str(meta.get("t") or meta.get("desc") or ""),
        })


_BING_ORIENTATION_FILTERS = {
    "landscape": "+filterui:aspect-wide",
    "portrait": "+filterui:aspect-tall",
    "square": "+filterui:aspect-square",
}


async def _search_bing_images(client: httpx.AsyncClient, query: str, count: int,
                              orientation: str) -> List[Dict[str, Any]]:
    params = {"q": query, "first": 1, "count": count, "mkt": "zh-CN", "adlt": "off"}
    if orientation in _BING_ORIENTATION_FILTERS:
        params["qft"] = _BING_ORIENTATION_FILTERS[orientation]
    response = await client.get("https://cn.bing.com/images/async", params=params,
                                headers={"User-Agent": BROWSER_UA,
                                         "Accept": "text/html,application/xhtml+xml",
                                         "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6"})
    response.raise_for_status()
    parser = _BingImageParser()
    parser.feed(web_access.decode_html(response.content, response.headers.get("content-type", "")))
    parser.close()
    items = []
    for entry in parser.entries:
        item = _make_item(entry["murl"], entry["turl"], entry["title"], None, None,
                          entry["purl"], _site_of(entry["purl"]) or _site_of(entry["murl"]),
                          source_kind="bing")
        if item and _orientation_matches(item, orientation):
            items.append(item)
    return items


# ---------------------------------------------------------------------------
# 引擎 2：必应国际 / 全网（www.bing.com + mkt=en-US，HTML 结构与国内版一致）
# www.bing.com 会 302 到 cn.bing.com，mkt 参数保留，所以这里跟随重定向。
# ---------------------------------------------------------------------------

async def _search_bing_global(client: httpx.AsyncClient, query: str, count: int,
                              orientation: str) -> List[Dict[str, Any]]:
    params = {"q": query, "first": 1, "count": count, "mkt": "en-US", "adlt": "off"}
    if orientation in _BING_ORIENTATION_FILTERS:
        params["qft"] = _BING_ORIENTATION_FILTERS[orientation]
    response = await client.get("https://www.bing.com/images/async", params=params,
                                headers={"User-Agent": BROWSER_UA,
                                         "Accept": "text/html,application/xhtml+xml",
                                         "Accept-Language": "en-US,en;q=0.9",
                                         "Referer": "https://www.bing.com/images/"},
                                follow_redirects=True)
    response.raise_for_status()
    parser = _BingImageParser()
    parser.feed(web_access.decode_html(response.content, response.headers.get("content-type", "")))
    parser.close()
    items = []
    for entry in parser.entries:
        item = _make_item(entry["murl"], entry["turl"], entry["title"], None, None,
                          entry["purl"], _site_of(entry["purl"]) or _site_of(entry["murl"]),
                          source_kind="bingglobal")
        if item and _orientation_matches(item, orientation):
            items.append(item)
        if len(items) >= count:
            break
    return items


# ---------------------------------------------------------------------------
# 引擎 3：360 图片（JSON：list[].img 原图 / thumb 缩略图 / width/height / link / site）
# ---------------------------------------------------------------------------

async def _search_360_images(client: httpx.AsyncClient, query: str, count: int,
                             orientation: str) -> List[Dict[str, Any]]:
    params = {"q": query, "pn": 0, "rn": max(10, count)}
    headers = {"User-Agent": BROWSER_UA, "Accept": _SO360_ACCEPT,
               "Accept-Language": "zh-CN,zh;q=0.9", "Referer": _SO360_REFERER}
    payload = None
    last_reason = "未知原因"
    for attempt in (1, 2):
        response = None
        try:
            response = await client.get("https://image.so.com/j", params=params, headers=headers)
            status = int(getattr(response, "status_code", 0) or 0)
            if status >= 400:
                last_reason = f"HTTP {status}"
            else:
                parsed = json.loads(response.text)
                if isinstance(parsed, dict) and isinstance(parsed.get("list"), list):
                    payload = parsed
                    break
                last_reason = "返回结构异常（缺 list 数组）"
        except ValueError:
            last_reason = "返回的不是 JSON（" + _response_hint(response) + "）"
        except httpx.HTTPError as exc:
            last_reason = f"网络错误：{exc}"
        if attempt == 1:
            # 360 的「访问异常出错」页是偶发的：隔 300ms 再试一次，别一次失败就整轮只剩必应
            await asyncio.sleep(_SO360_RETRY_DELAY)
    if payload is None:
        raise WebImageSearchError(f"360 图片检索失败（已重试 1 次）：{last_reason}")
    items = []
    for entry in payload.get("list") or []:
        if not isinstance(entry, dict):
            continue
        item = _make_item(entry.get("img"), entry.get("thumb"), entry.get("title"),
                          entry.get("width"), entry.get("height"),
                          entry.get("link"), entry.get("site") or entry.get("dspurl"),
                          source_kind="360")
        if item and _orientation_matches(item, orientation):
            items.append(item)
    return items


# ---------------------------------------------------------------------------
# 引擎 3：花瓣（JSON：pins[].file.bucket + key → 原图 https://{bucket}.huabanimg.com/{key}）
# ---------------------------------------------------------------------------

async def _search_huaban(client: httpx.AsyncClient, query: str, count: int,
                         orientation: str = "any") -> List[Dict[str, Any]]:
    params = {"q": query, "type": "pins", "limit": max(20, count), "page": 1}
    headers = {"User-Agent": BROWSER_UA, "Accept": "application/json, text/plain, */*",
               "Accept-Language": "zh-CN,zh;q=0.9", "Referer": f"https://huaban.com/search?q={quote(query)}"}
    response = await client.get("https://huaban.com/v3/search", params=params, headers=headers)
    response.raise_for_status()
    try:
        payload = response.json()
    except ValueError as exc:
        raise WebImageSearchError("花瓣返回的不是 JSON（可能被 bot 挑战拦了）") from exc
    pins = payload.get("pins") if isinstance(payload, dict) else None
    if not isinstance(pins, list):
        raise WebImageSearchError("花瓣返回结构异常（缺 pins 数组）")
    items: List[Dict[str, Any]] = []
    for pin in pins:
        if not isinstance(pin, dict):
            continue
        file_info = pin.get("file") if isinstance(pin.get("file"), dict) else {}
        key = str(file_info.get("key") or "").strip()
        bucket = str(file_info.get("bucket") or "").strip()
        if not key or not bucket:
            continue
        # 原图只有 bucket+key；万一 key 带 _fw/_sq 尺寸后缀，先去掉
        original = huaban_original_url(f"https://{bucket}.huabanimg.com/{key}")
        key_only = os.path.basename(urlparse(original).path)
        thumb = f"https://hbimg.huabanimg.com/{key_only}_fw236"
        board = pin.get("board") if isinstance(pin.get("board"), dict) else {}
        title = pin.get("raw_text") or board.get("title") or ""
        page_url = f"https://huaban.com/pins/{pin.get('pin_id')}/" if pin.get("pin_id") else ""
        item = _make_item(original, thumb, title, file_info.get("width"), file_info.get("height"),
                          page_url, "huaban.com", source_kind="huaban")
        if item and _orientation_matches(item, orientation):
            items.append(item)
        if len(items) >= count:
            break
    return items


# ---------------------------------------------------------------------------
# 引擎 4：堆糖（HTML 里的 dtstatic.com 图带 resize 参数，去掉 ? 查询就是原图）
# ---------------------------------------------------------------------------

_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I)
_IMG_ATTR_RE = re.compile(r'([A-Za-z0-9_:.-]+)\s*=\s*"([^"]*)"')
_IMAGE_PATH_EXT_RE = re.compile(r"\.(?:jpe?g|png|webp|gif)$", re.I)


def _html_img_attrs(page: str, host_keyword: str) -> List[Dict[str, str]]:
    found: List[Dict[str, str]] = []
    for tag in _IMG_TAG_RE.findall(page or ""):
        attrs = dict(_IMG_ATTR_RE.findall(tag))
        src = str(attrs.get("src") or attrs.get("data-src") or "").strip()
        if not src or (host_keyword and host_keyword not in src):
            continue
        attrs["src"] = src
        found.append(attrs)
    return found


async def _search_duitang(client: httpx.AsyncClient, query: str, count: int,
                          orientation: str = "any") -> List[Dict[str, Any]]:
    response = await client.get("https://www.duitang.com/search/", params={"kw": query, "type": "feed"},
                                headers={"User-Agent": BROWSER_UA, "Accept": "text/html,application/xhtml+xml",
                                         "Accept-Language": "zh-CN,zh;q=0.9"})
    response.raise_for_status()
    page = web_access.decode_html(response.content, response.headers.get("content-type", ""))
    items: List[Dict[str, Any]] = []
    for attrs in _html_img_attrs(page, "dtstatic.com"):
        thumb = attrs["src"]
        lowered = thumb.lower()
        if any(part in lowered for part in ("/avatar/", "/icons/", "/people/", "favicon")):
            continue
        original = thumb.split("?", 1)[0]
        if not _IMAGE_PATH_EXT_RE.search(urlparse(original).path):
            continue
        page_url = (f"https://www.duitang.com/blog/?id={attrs['data-rootid']}"
                    if attrs.get("data-rootid") else "")
        item = _make_item(original, thumb, attrs.get("alt") or "", None, None, page_url,
                          "duitang.com", source_kind="duitang")
        if item and _orientation_matches(item, orientation):
            items.append(item)
        if len(items) >= count:
            break
    return items


# ---------------------------------------------------------------------------
# 引擎 5：站酷（尽力而为：页面能抓就解析，抓不到直接报真实原因）
# 实测 img.zcool.cn 原图直连带 Referer 也是 403，所以不放进默认来源。
# ---------------------------------------------------------------------------

async def _search_zcool(client: httpx.AsyncClient, query: str, count: int,
                        orientation: str = "any") -> List[Dict[str, Any]]:
    response = await client.get("https://www.zcool.com.cn/search/content", params={"word": query},
                                headers={"User-Agent": BROWSER_UA, "Accept": "text/html,application/xhtml+xml",
                                         "Accept-Language": "zh-CN,zh;q=0.9"})
    if response.status_code >= 400:
        raise WebImageSearchError(f"站酷搜索返回 HTTP {response.status_code}")
    page = web_access.decode_html(response.content, response.headers.get("content-type", ""))
    items: List[Dict[str, Any]] = []
    for attrs in _html_img_attrs(page, "img.zcool.cn"):
        thumb = attrs["src"]
        # 站酷缩略图常带 !/small 之类缩放后缀，去掉拿原图
        original = re.sub(r"!/[^?#]*$", "", thumb)
        if not _IMAGE_PATH_EXT_RE.search(urlparse(original).path):
            continue
        item = _make_item(original, thumb, attrs.get("alt") or "", None, None,
                          "https://www.zcool.com.cn/", "zcool.com.cn", source_kind="zcool")
        if item and _orientation_matches(item, orientation):
            items.append(item)
        if len(items) >= count:
            break
    if not items:
        raise WebImageSearchError("站酷图片需要登录/签名（img.zcool.cn 直连 403），搜索页没返回原图")
    return items


# ---------------------------------------------------------------------------
# 引擎 6：Pinterest（需要代理；先 GET 首页拿 cookie，再打 BaseSearchResource）
# 实测缺 X-APP-VERSION / X-Pinterest-PWS-Handler / x-csrftoken 任一个都会 403。
# ---------------------------------------------------------------------------

_PINTEREST_HOME = "https://www.pinterest.com/"
_PINTEREST_RESOURCE = "https://www.pinterest.com/resource/BaseSearchResource/get/"
_PINTEREST_HEADERS = {
    "Accept": "application/json, text/javascript, */*, q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "X-Pinterest-AppState": "active",
    "X-APP-VERSION": "a1a7a7a",
    "X-Pinterest-PWS-Handler": "www/[username]/[slug].js",
}
PINTEREST_PROXY_NOTE = "Pinterest 在当前网络不可达，需要代理（设置 › 通用 › 画布助手联网 › 联网代理）"


def _cookie_value(client: Any, response: Any, name: str) -> str:
    """cookie 优先从本次响应、其次从共享 client 的 cookie jar 取（首页可能 302）。"""
    for jar in (getattr(response, "cookies", None), getattr(client, "cookies", None)):
        if jar is None:
            continue
        try:
            value = jar.get(name)
        except Exception:
            value = None
        if value:
            return str(value)
    return ""


def _pinterest_pin_item(pin: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(pin, dict):
        return None
    images = pin.get("images") if isinstance(pin.get("images"), dict) else {}
    orig = images.get("orig") if isinstance(images.get("orig"), dict) else {}
    original = str(orig.get("url") or "").strip()
    if not original:
        return None
    thumb_info = images.get("236x") if isinstance(images.get("236x"), dict) else {}
    thumb = str(thumb_info.get("url") or "").strip() or original
    pin_id = pin.get("id") or pin.get("node_id") or ""
    page = str(pin.get("link") or "").strip()
    if not page and pin_id:
        page = f"https://www.pinterest.com/pin/{pin_id}/"
    title = pin.get("title") or pin.get("grid_title") or pin.get("auto_alt_text") or ""
    # domain 常是「Uploaded by user」这类文案而不是域名，只有真域名才拿来当来源站点
    domain = str(pin.get("domain") or "").strip()
    site = domain if ("." in domain and " " not in domain) else _site_of(original)
    return _make_item(original, thumb, title, orig.get("width"), orig.get("height"),
                      page, site, source_kind="pinterest")


async def _search_pinterest(client: httpx.AsyncClient, query: str, count: int,
                            orientation: str = "any") -> List[Dict[str, Any]]:
    if not net_proxy.resolve_web_proxy():
        # 没代理时直连必然超时：调用方会提前跳过，这里兜底不浪费 12 秒
        raise WebImageSearchError(PINTEREST_PROXY_NOTE)
    home = await client.get(_PINTEREST_HOME,
                            headers={"User-Agent": BROWSER_UA,
                                     "Accept": "text/html,application/xhtml+xml",
                                     "Referer": _PINTEREST_HOME})
    csrf = _cookie_value(client, home, "csrftoken")
    if not csrf:
        raise WebImageSearchError(
            f"Pinterest 没有拿到 csrftoken（首页 HTTP {getattr(home, 'status_code', '?')}），可能被限流")
    body = {"options": {"query": query, "scope": "pins", "page_size": max(24, count),
                        "bookmarks": []},
            "context": {}}
    url = (_PINTEREST_RESOURCE
           + "?source_url=" + quote(f"/search/pins/?q={query}", safe="/")
           + "&data=" + quote(json.dumps(body, separators=(",", ":")), safe=""))
    headers = dict(_PINTEREST_HEADERS)
    headers.update({"User-Agent": BROWSER_UA, "x-csrftoken": csrf,
                    "Referer": f"https://www.pinterest.com/search/pins/?q={quote(query)}"})
    response = await client.get(url, headers=headers)
    if response.status_code >= 400:
        raise WebImageSearchError(
            f"Pinterest 搜索返回 HTTP {response.status_code}（可能被限制，稍后重试或换代理）")
    try:
        payload = response.json()
    except ValueError as exc:
        raise WebImageSearchError("Pinterest 返回的不是 JSON（" + _response_hint(response) + "）") from exc
    resource = payload.get("resource_response") if isinstance(payload, dict) else None
    data = resource.get("data") if isinstance(resource, dict) else None
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        raise WebImageSearchError("Pinterest 返回结构异常（缺 resource_response.data.results）")
    items: List[Dict[str, Any]] = []
    for pin in results:
        item = _pinterest_pin_item(pin)
        if item and _orientation_matches(item, orientation):
            items.append(item)
        if len(items) >= count:
            break
    return items


# ---------------------------------------------------------------------------
# 引擎 7：ArtStation（JSON API；per_page 必填，不给返回 400）
# 原图把封面里的 /smaller_square/ 换成 /large/（实测 200，约 1MB）。
# ---------------------------------------------------------------------------

_ARTSTATION_API = "https://www.artstation.com/api/v2/search/projects.json"
ARTSTATION_PROXY_NOTE = "ArtStation 在当前网络不可达，需要代理（设置 › 通用 › 画布助手联网 › 联网代理）"

# 需要代理才能访问的来源 → 无代理时直接跳过并写 note（别让直连超时拖慢整轮）
_PROXY_REQUIRED_SOURCES = {
    "pinterest": PINTEREST_PROXY_NOTE,
    "artstation": ARTSTATION_PROXY_NOTE,
}


def artstation_original_url(cover_url: Any) -> str:
    """smaller_square 封面 → large 原图；没有该路径段就原样返回。"""
    text = str(cover_url or "").strip()
    if "/smaller_square/" in text:
        return text.replace("/smaller_square/", "/large/")
    return text


def _artstation_cover(project: Dict[str, Any]) -> str:
    cover = str(project.get("smaller_square_cover_url") or "").strip()
    if cover:
        return cover
    icons = project.get("icons") if isinstance(project.get("icons"), dict) else {}
    best, best_width = "", -1
    for value in icons.values():
        if not isinstance(value, dict):
            continue
        url = str(value.get("url") or "").strip()
        if not url:
            continue
        width = _positive_int(value.get("width")) or 0
        if width > best_width:
            best, best_width = url, width
    return best


async def _search_artstation(client: httpx.AsyncClient, query: str, count: int,
                             orientation: str = "any") -> List[Dict[str, Any]]:
    if not net_proxy.resolve_web_proxy():
        # 和 Pinterest 一样：没代理直连会超时，调用方会提前跳过，这里兜底
        raise WebImageSearchError(ARTSTATION_PROXY_NOTE)
    params = {"query": query, "page": 1, "per_page": max(20, count)}   # per_page 必填
    response = await client.get(_ARTSTATION_API, params=params,
                                headers={"User-Agent": BROWSER_UA,
                                         "Accept": "application/json",
                                         "Referer": "https://www.artstation.com/"})
    if response.status_code >= 400:
        raise WebImageSearchError(
            f"ArtStation 搜索返回 HTTP {response.status_code}（per_page 必填；也可能被限流）")
    try:
        payload = response.json()
    except ValueError as exc:
        raise WebImageSearchError("ArtStation 返回的不是 JSON（" + _response_hint(response) + "）") from exc
    projects = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(projects, list):
        raise WebImageSearchError("ArtStation 返回结构异常（缺 data 数组）")
    items: List[Dict[str, Any]] = []
    for project in projects:
        if not isinstance(project, dict):
            continue
        cover = _artstation_cover(project)
        if not cover:
            continue
        item = _make_item(artstation_original_url(cover), cover, project.get("title"),
                          None, None, project.get("url"), "artstation.com",
                          source_kind="artstation")
        if item and _orientation_matches(item, orientation):
            items.append(item)
        if len(items) >= count:
            break
    return items


def _client_kwargs(verify: Any, trust_env: Any, timeout: float) -> Dict[str, Any]:
    options: Dict[str, Any] = {"http2": False, "timeout": timeout, "follow_redirects": False,
                               # 本机 brotlicffi 1.2 + httpx 0.28 解 br 会报错；搜索/图片只要 gzip 就够
                               "headers": {"Accept-Encoding": "gzip, deflate"}}
    if verify is not None:
        options["verify"] = verify
    if trust_env is not None:
        options["trust_env"] = trust_env
    # 搜图/下原图走和读网页同一套代理（系统代理或设置页自定义）；没有代理时显式关掉 env 代理
    options.update(net_proxy.httpx_proxy(net_proxy.resolve_web_proxy()))
    return options


def normalize_sources(sources: Any) -> List[str]:
    """把 sources 参数归一成已知来源名列表（支持中英文名）；不认识的直接报错，让模型别乱写。

    不传 / 空 → 默认全网七站（花瓣、堆糖、必应图片、360、必应国际、Pinterest、ArtStation）。
    已知但不可用的来源（小红书/百度等）保留在结果里，由调用方写进 note。"""
    if sources is None or sources == [] or sources == "":
        return list(DEFAULT_SOURCES)
    if isinstance(sources, str):
        raw_values = [part for part in re.split(r"[,，\s]+", sources) if part]
    elif isinstance(sources, (list, tuple, set)):
        raw_values = list(sources)
    else:
        raise WebImageSearchError("sources 必须是图片来源数组")
    resolved: List[str] = []
    for raw in raw_values:
        key = str(raw or "").strip().lower()
        if not key:
            continue
        name = _SOURCE_ALIASES.get(key)
        if not name:
            allowed = "、".join(f"{SOURCE_LABELS[item]}（{item}）" for item in DEFAULT_SOURCES)
            raise WebImageSearchError(f"不支持的图片来源：{raw}（可用：{allowed}；也可写中文名）")
        if name not in resolved:
            resolved.append(name)
    return resolved or list(DEFAULT_SOURCES)


def _source_adapters() -> Dict[str, Any]:
    """来源名 → 适配器函数（动态取引用，便于测试替换）。"""
    return {
        "huaban": _search_huaban,
        "duitang": _search_duitang,
        "bing": _search_bing_images,
        "360": _search_360_images,
        "zcool": _search_zcool,
        "bingglobal": _search_bing_global,
        "pinterest": _search_pinterest,
        "artstation": _search_artstation,
    }


async def search_images(query: str, count: int = 24, orientation: str = "any",
                        sources: Any = None, verify: Any = None,
                        trust_env: Any = None) -> Dict[str, Any]:
    """多来源图片搜索：默认全网七站并发、默认取 24 条（7 站轮转，每站至少 3 条），单站失败不影响其它站。

    Pinterest 需要代理：没有代理时直接跳过并写 note，不浪费一次 12 秒超时。
    返回 {engine:"multi", query, sources:{来源:条数}, note?, items}；某站失败的真实原因写进 note。
    """
    text_query = str(query or "").strip()
    if not text_query:
        raise WebImageSearchError("搜索关键词不能为空")
    try:
        top = max(1, min(int(count or 24), MAX_ITEMS))
    except (TypeError, ValueError):
        top = 24
    mode = str(orientation or "any").strip().lower()
    if mode not in ORIENTATIONS:
        mode = "any"
    requested = normalize_sources(sources)
    notes: List[str] = []
    tasks: List[Tuple[str, Any]] = []
    adapters = _source_adapters()
    # 只在确实要搜需要代理的站时才探测代理（设置读取有成本），没代理就跳过别等超时
    proxy_available = True
    if any(name in _PROXY_REQUIRED_SOURCES for name in requested):
        proxy_available = bool(net_proxy.resolve_web_proxy())
    for name in requested:
        label = SOURCE_LABELS.get(name, name)
        if name in UNSUPPORTED_SOURCES:
            notes.append(f"{label}：{UNSUPPORTED_SOURCES[name]}（未接入，已跳过）")
            continue
        if name in _PROXY_REQUIRED_SOURCES and not proxy_available:
            notes.append(_PROXY_REQUIRED_SOURCES[name])
            continue
        adapter = adapters.get(name)
        if adapter is None:
            notes.append(f"{label}：未接入，已跳过")
            continue
        tasks.append((name, adapter))
    groups: List[List[Dict[str, Any]]] = []
    if tasks:
        async with httpx.AsyncClient(**_client_kwargs(verify, trust_env, DOWNLOAD_TIMEOUT)) as client:
            results = await asyncio.gather(
                *[asyncio.wait_for(adapter(client, text_query, top, mode), timeout=_source_timeout(name))
                  for name, adapter in tasks],
                return_exceptions=True)
        for (name, _adapter), result in zip(tasks, results):
            label = SOURCE_LABELS.get(name, name)
            if isinstance(result, BaseException):
                notes.append(f"{label}：{_reason(result, _source_timeout(name))}")
                continue
            items = result or []
            if items:
                groups.append(items)
            else:
                notes.append(f"{label}：没有搜到原图")
    merged = _merge_items(groups, top) if groups else []
    counts: Dict[str, int] = {}
    for item in merged:
        kind = str(item.get("source_kind") or "")
        if kind:
            counts[kind] = counts.get(kind, 0) + 1
    result: Dict[str, Any] = {"engine": "multi", "query": text_query,
                              "sources": counts, "items": merged}
    if not merged:
        detail = "；".join(notes) if notes else "所有来源都没有结果"
        result["note"] = f"没有搜到可用的原图（{detail}）"
    elif notes:
        result["note"] = "部分来源失败或跳过（" + "；".join(notes) + "）"
    return result


async def find_similar_images(image_url: str, count: int = 24,
                              describe: Optional[Any] = None,
                              verify: Any = None, trust_env: Any = None) -> Dict[str, Any]:
    """反图：describe(image_url) 由 main.py 注入（项目现有看图链路），返回
    {"description": 画面描述, "queries": [3~5 组检索词]}。拿不到图必须抛错，不猜关键词。"""
    source = str(image_url or "").strip()
    if not source:
        raise WebImageSearchError("图片地址不能为空")
    if not callable(describe):
        raise WebImageSearchError("反图需要视觉模型读图，但当前没有可用的看图链路")
    vision = await describe(source)
    if not isinstance(vision, dict):
        raise WebImageSearchError("视觉模型没有返回可用的读图结果")
    description = _clean_text(vision.get("description"), 400)
    queries: List[str] = []
    for raw in vision.get("queries") or []:
        cleaned = " ".join(str(raw or "").split())
        if cleaned and cleaned not in queries:
            queries.append(cleaned[:80])
    queries = queries[:5]
    if not queries:
        raise WebImageSearchError("视觉模型读到了图，但没有给出可用的检索词（它可能没按格式返回）")
    try:
        top = max(1, min(int(count or 24), MAX_ITEMS))
    except (TypeError, ValueError):
        top = 24
    failures: List[str] = []
    groups: List[List[Dict[str, Any]]] = []
    engines: List[str] = []
    for term in queries:
        try:
            found = await search_images(term, top, "any", verify=verify, trust_env=trust_env)
        except Exception as exc:
            failures.append(f"{term}：{_reason(exc)}")
            continue
        if found.get("items"):
            groups.append(found["items"])
            engines.append(str(found.get("engine") or ""))
        else:
            failures.append(f"{term}：没有搜到原图")
    items = _merge_items(groups, top) if groups else []
    engine_name = "merged" if len(set(engines)) > 1 or len(engines) > 1 else (engines[0] if engines else "")
    if engine_name == "multi":      # search_images 现在返回 multi，反图契约里该字段仍是 bing|360|merged
        engine_name = "merged"
    result: Dict[str, Any] = {
        "engine": engine_name,
        "query": queries[0],
        "queries": queries,
        "description": description,
        "items": items,
    }
    if not items:
        detail = "；".join(failures) if failures else "所有检索词都没有结果"
        result["note"] = f"没有搜到相似图片（{detail}）"
    elif failures:
        result["note"] = "部分检索词没搜到（" + "；".join(failures) + "）"
    return result


# ---------------------------------------------------------------------------
# 原图下载 / 落盘
# ---------------------------------------------------------------------------

def sniff_image_ext(data: bytes) -> str:
    """按魔数认真实图片类型（扩展名/Content-Type 都可能骗人）。只认图片。"""
    raw = data or b""
    if raw.startswith(_PNG_MAGIC):
        return ".png"
    if raw.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if raw.startswith(b"BM") and len(raw) > 14:
        return ".bmp"
    if len(raw) >= 12 and raw[4:8] == b"ftyp" and raw[8:12] in (b"avif", b"avis"):
        return ".avif"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    return ""


def image_size(data: bytes) -> Tuple[Optional[int], Optional[int]]:
    """真实宽高（Pillow 是现有依赖，不解码像素只读头部）。认不出返回 (None, None)。"""
    try:
        from PIL import Image
    except Exception as exc:  # pragma: no cover - 依赖缺失时给出真实原因
        raise WebImageSearchError(f"读取图片尺寸失败：Pillow 不可用（{clean_error_text(exc)}）") from exc
    try:
        with Image.open(io.BytesIO(data)) as img:
            width, height = img.size
    except Exception:
        return None, None
    return (width if width > 0 else None), (height if height > 0 else None)


def _origin(url: str) -> str:
    parsed = urlparse(str(url or ""))
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}"


async def fetch_image(client: httpx.AsyncClient, url: str, referer: str = "",
                      max_bytes: int = MAX_DOWNLOAD_BYTES) -> Dict[str, Any]:
    """下载原图并校验：重定向 ≤5、超时由 client 控制、≤max_bytes、必须是真图片、返回真实宽高。"""
    current = web_access.validate_public_url(url)
    headers = {"User-Agent": BROWSER_UA, "Accept": _IMAGE_ACCEPT}
    if referer:
        headers["Referer"] = referer
    for _ in range(MAX_DOWNLOAD_REDIRECTS + 1):
        async with client.stream("GET", current, headers=headers) as response:
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location", "")
                if not location:
                    raise WebImageSearchError("原图重定向缺少目标地址")
                current = web_access.validate_public_url(urljoin(current, location))
                continue
            if response.status_code >= 400:
                raise WebImageSearchError(f"下载原图失败：HTTP {response.status_code}")
            content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            declared = _positive_int(response.headers.get("content-length"))
            if declared and declared > max_bytes:
                raise WebImageSearchError(f"原图超过 {max_bytes // (1024 * 1024)}MB 上限")
            chunks: List[bytes] = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise WebImageSearchError(f"原图超过 {max_bytes // (1024 * 1024)}MB 上限")
                chunks.append(chunk)
            data = b"".join(chunks)
            final_url = str(response.url)
        if not data:
            raise WebImageSearchError("下载到的原图是空文件")
        ext = sniff_image_ext(data)
        if not ext:
            raise WebImageSearchError(f"下载到的不是图片（Content-Type: {content_type or '未知'}）")
        width, height = image_size(data)
        return {"data": data, "ext": ext, "final_url": final_url,
                "content_type": content_type, "width": width, "height": height}
    raise WebImageSearchError(f"原图下载重定向次数过多（超过 {MAX_DOWNLOAD_REDIRECTS} 次）")


def _sanitize_base(name: str, fallback: str = "web-image") -> str:
    base = os.path.splitext(os.path.basename(str(name or "").strip()))[0]
    base = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "_", base).strip(" ._")
    return base[:40] or fallback


def save_image_file(data: bytes, ext: str, dest_dir: str, base_name: str = "") -> Tuple[str, str]:
    """落盘到素材库目录（文件名沿用 local-assets 的 up_<hex12>_<名字> 惯例）。返回 (文件名, 绝对路径)。"""
    os.makedirs(dest_dir, exist_ok=True)
    filename = f"up_{uuid.uuid4().hex[:12]}_{_sanitize_base(base_name)}{ext}"
    path = os.path.join(dest_dir, filename)
    with open(path, "wb") as handle:
        handle.write(data)
    return filename, path


def local_image_url(url_prefix: str, filename: str) -> str:
    prefix = str(url_prefix or "").rstrip("/")
    return f"{prefix}/{quote(str(filename or ''), safe='')}"


def _normalize_import_entries(values: Any) -> List[Dict[str, str]]:
    """import 入参归一：兼容 urls=[\"https://…\"] 与 items=[{url, source_page}]（items 优先由调用方决定）。
    source_page 只用来取 origin 当 Referer，应对防盗链。"""
    entries: List[Dict[str, str]] = []
    for raw in values or []:
        if isinstance(raw, dict):
            url = str(raw.get("url") or "").strip()
            page = str(raw.get("source_page") or "").strip()
        else:
            url, page = str(raw or "").strip(), ""
        if url:
            entries.append({"url": url, "source_page": page if _is_http_url(page) else ""})
    return entries


async def import_images(urls: Any, dest_dir: str, url_prefix: str, name: str = "",
                        verify: Any = None, trust_env: Any = None) -> Dict[str, Any]:
    """逐条下载外链原图并落库。urls 可以是纯地址数组，也可以是 [{url, source_page}]。
    失败绝不静默：每条都带真实 error + machine-readable code。"""
    entries = _normalize_import_entries(urls)
    if not entries:
        raise WebImageSearchError("需要提供至少 1 个原图地址（urls 或 items）")
    if len(entries) > MAX_IMPORT_URLS:
        raise WebImageSearchError(f"一次最多导入 {MAX_IMPORT_URLS} 张图片")
    items: List[Dict[str, Any]] = []
    async with httpx.AsyncClient(**_client_kwargs(verify, trust_env, DOWNLOAD_TIMEOUT)) as client:
        for entry in entries:
            items.append(await _import_one(client, entry["url"], dest_dir, url_prefix, name,
                                           source_page=entry["source_page"]))
    return {"items": items}


async def _fetch_original_with_fallback(client: httpx.AsyncClient, url: str,
                                            referer: str) -> Dict[str, Any]:
    """ArtStation /large/ 个别 404 时退回 /smaller_square/ 再下一次（其它错误原样抛）。"""
    try:
        return await fetch_image(client, url, referer=referer)
    except WebImageSearchError as exc:
        if "/large/" not in url or "HTTP 404" not in str(exc):
            raise
        fallback = url.replace("/large/", "/smaller_square/", 1)
        return await fetch_image(client, fallback, referer=referer)


async def _import_one(client: httpx.AsyncClient, url: str, dest_dir: str,
                      url_prefix: str, name: str, source_page: str = "") -> Dict[str, Any]:
    item: Dict[str, Any] = {"source_url": url, "ok": False, "url": "", "width": None,
                            "height": None, "bytes": 0, "error": "", "code": "", "detail": ""}
    if not _is_http_url(url):
        item.update({"error": "只支持 http(s) 原图链接", "code": "invalid_url"})
        return item
    thumb_reason = known_thumbnail_reason(url)
    if thumb_reason:
        # 已知缩略图 CDN：直接拒绝，连下载都不做（省流量，也避免把缩略图落成原图）
        item.update({"error": "只拿到缩略图", "code": "thumbnail_only", "detail": thumb_reason})
        return item
    try:
        info = await _fetch_original_with_fallback(client, url, _origin(source_page) or _origin(url))
    except WebImageSearchError as exc:
        message = str(exc)
        if "MB 上限" in message:
            code = "too_large"
        elif message.startswith("下载到的不是图片"):
            code = "not_image"
        else:
            code = "download_failed"
        item.update({"error": message, "code": code})
        return item
    except httpx.TimeoutException:
        item.update({"error": f"下载原图超时（{int(DOWNLOAD_TIMEOUT)} 秒）", "code": "timeout"})
        return item
    except httpx.HTTPError as exc:
        item.update({"error": f"下载原图失败：{exc}", "code": "download_failed"})
        return item
    except Exception as exc:
        item.update({"error": clean_error_text(f"{type(exc).__name__}: {exc}", fallback="下载原图失败"),
                     "code": "download_failed"})
        return item
    final_reason = known_thumbnail_reason(info.get("final_url"))
    if final_reason and str(info.get("final_url") or "") != str(url):
        item.update({"error": "只拿到缩略图", "code": "thumbnail_only",
                     "detail": "下载时跳转到了缩略图地址：" + final_reason})
        return item
    width, height = info["width"], info["height"]
    if not width or not height:
        item.update({"error": "读不出图片真实尺寸（文件可能损坏）", "code": "not_image"})
        return item
    if max(width, height) < THUMBNAIL_MAX_SIDE:
        item.update({"error": "只拿到缩略图", "code": "thumbnail_only",
                     "detail": f"真实尺寸只有 {width}x{height}（长边小于 {THUMBNAIL_MAX_SIDE}px）"})
        return item
    base = name or os.path.splitext(os.path.basename(urlparse(url).path))[0]
    filename, _path = save_image_file(info["data"], info["ext"], dest_dir, base)
    item.update({"ok": True, "url": local_image_url(url_prefix, filename),
                 "width": width, "height": height, "bytes": len(info["data"]),
                 "error": "", "code": ""})
    return item


# ---------------------------------------------------------------------------
# 缩略图代理：浏览器 <img> 的 Referer 不受控（花瓣带 Referer 直接反爬 567 HTML），
# 所以卡片预览走服务端代理——不带 Referer 拉图、可选缩放、LRU 缓存。
# ---------------------------------------------------------------------------

THUMB_PROXY_MAX_BYTES = 8 * 1024 * 1024
THUMB_PROXY_DEFAULT_WIDTH = 480
THUMB_PROXY_MIN_WIDTH = 200
THUMB_PROXY_MAX_WIDTH = 1200
_THUMB_CACHE_LIMIT = 200
_THUMB_CACHE_BYTES_LIMIT = 64 * 1024 * 1024
_EXT_CONTENT_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".bmp": "image/bmp", ".webp": "image/webp", ".avif": "image/avif",
}
_thumb_cache: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_thumb_cache_bytes = 0
_THUMB_CACHE_LOCK = threading.Lock()


def clamp_thumb_width(value: Any) -> int:
    try:
        width = int(value)
    except (TypeError, ValueError):
        width = THUMB_PROXY_DEFAULT_WIDTH
    return max(THUMB_PROXY_MIN_WIDTH, min(width, THUMB_PROXY_MAX_WIDTH))


def clear_thumb_cache() -> None:
    global _thumb_cache_bytes
    with _THUMB_CACHE_LOCK:
        _thumb_cache.clear()
        _thumb_cache_bytes = 0


def _thumb_cache_get(key: str) -> Optional[Dict[str, Any]]:
    with _THUMB_CACHE_LOCK:
        entry = _thumb_cache.get(key)
        if entry is None:
            return None
        _thumb_cache.move_to_end(key)          # LRU：命中的挪到末尾
        return dict(entry)


def _thumb_cache_put(key: str, entry: Dict[str, Any]) -> None:
    global _thumb_cache_bytes
    data_size = len(entry.get("data") or b"")
    with _THUMB_CACHE_LOCK:
        old = _thumb_cache.pop(key, None)
        if old is not None:
            _thumb_cache_bytes -= len(old.get("data") or b"")
        _thumb_cache[key] = dict(entry)
        _thumb_cache_bytes += data_size
        while _thumb_cache and (len(_thumb_cache) > _THUMB_CACHE_LIMIT
                                or _thumb_cache_bytes > _THUMB_CACHE_BYTES_LIMIT):
            _old_key, old_entry = _thumb_cache.popitem(last=False)
            _thumb_cache_bytes -= len(old_entry.get("data") or b"")
        if _thumb_cache_bytes < 0:
            _thumb_cache_bytes = 0


def _scale_image_for_thumb(data: bytes, ext: str, width: int) -> Dict[str, Any]:
    """按长边等比缩到 width 并转 JPEG；缩不了（Pillow 失败/本来就不大）就原样返回。"""
    original_type = _EXT_CONTENT_TYPES.get(ext, "application/octet-stream")
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            src_w, src_h = img.size
            if not src_w or not src_h:
                raise ValueError("图片尺寸为 0")
            if max(src_w, src_h) <= width:
                return {"data": data, "content_type": original_type,
                        "width": src_w, "height": src_h, "scaled": False}
            ratio = width / float(max(src_w, src_h))
            target = (max(1, int(round(src_w * ratio))), max(1, int(round(src_h * ratio))))
            resized = img.convert("RGB").resize(target, Image.LANCZOS)
            buffer = io.BytesIO()
            resized.save(buffer, format="JPEG", quality=85, optimize=True)
            out = buffer.getvalue()
            if not out:
                raise ValueError("缩放后为空")
            return {"data": out, "content_type": "image/jpeg",
                    "width": target[0], "height": target[1], "scaled": True}
    except Exception:
        return {"data": data, "content_type": original_type,
                "width": None, "height": None, "scaled": False}


async def fetch_thumb_bytes(url: str, width: Any = THUMB_PROXY_DEFAULT_WIDTH,
                            verify: Any = None, trust_env: Any = None) -> Dict[str, Any]:
    """服务端代理取缩略图：不带 Referer 下载（≤8MB、只认图片），按 width 等比缩放并转 JPEG。

    返回 {data, content_type, width, height, scaled, cache}；地址不合法/不是图片/超限抛错。"""
    target = str(url or "").strip()
    if not target:
        raise WebImageSearchError("缺少图片地址（url）")
    web_access.validate_public_url(target)          # 内网/本机/非标准端口在这里就被挡住
    size = clamp_thumb_width(width)
    cache_key = f"{size}|{target}"
    cached = _thumb_cache_get(cache_key)
    if cached is not None:
        cached["cache"] = True
        return cached
    async with httpx.AsyncClient(**_client_kwargs(verify, trust_env, DOWNLOAD_TIMEOUT)) as client:
        info = await fetch_image(client, target, referer="", max_bytes=THUMB_PROXY_MAX_BYTES)
    scaled = _scale_image_for_thumb(info["data"], info["ext"], size)
    result = {
        "data": scaled["data"],
        "content_type": scaled["content_type"],
        "width": scaled["width"] or info.get("width"),
        "height": scaled["height"] or info.get("height"),
        "scaled": bool(scaled["scaled"]),
        "cache": False,
    }
    _thumb_cache_put(cache_key, result)
    return result
