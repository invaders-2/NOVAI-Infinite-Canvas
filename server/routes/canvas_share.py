#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""局域网画布分享（T49）：链接 + 权限 + 只读快照 + 克隆。

与 M6 的 server/share_links.py（登录态云分享）是两套东西：
- 本模块只服务本机 / 局域网自用，不要求登录；
- 数据落 <DATA_DIR>/canvas_shares.json（原子写），不碰 users.db；
- token 就是访问凭据（24+ 字符），权限三档：view / clone / template（template 含 clone）。

契约：
    POST   /api/canvas-share                      {canvas_id, permission, expires_in_days, owner_name}
                                                  -> {share: {...}}
    GET    /api/canvas-share/by-canvas/{id}       -> {share|null}
    DELETE /api/canvas-share/by-canvas/{id}       -> {ok: true}
    GET    /api/canvas-share/{token}              -> {share, canvas, can_clone, can_save_template}
    POST   /api/canvas-share/{token}/clone        -> {canvas_id, title, copied, failed, skipped}
    POST   /api/canvas-share/localize-media        {urls, share_url} -> {items, copied, failed, skipped}

媒体本地化（T52）：克隆 / 保存模板时把远端媒体下载到本机 <资产上传目录>，
地址改成 /assets/uploads/…（不带 token）。单文件 >50MB 跳过、单请求累计 >200MB 停止、
并发 ≤4、单个超时 10s、总预算 60s；同一 URL 命中已存在文件时直接复用（文件名按 URL 哈希，幂等）。

环境变量：
    NOVAI_SHARE_PAGE_URL  整体覆盖分享页面地址（dev / 反向代理 / 测试用），默认按局域网 IP 拼。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y。
"""
from __future__ import annotations

import asyncio
import copy
import hashlib
import os
import re
import secrets
import socket
import tempfile
import threading
import time
import urllib.parse
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from server.routes.deps import deps

router = APIRouter(prefix="/api/canvas-share")

SHARE_FILE_NAME = "canvas_shares.json"
SHARE_VERSION = 1
VALID_PERMISSIONS = ("view", "clone", "template")
VALID_EXPIRES_IN_DAYS = (0, 1, 7, 30)
DEFAULT_OWNER_NAME = "本机用户"
TOKEN_BYTES = 24

# 媒体本地化预算（T52）：单个 10s / 单文件 50MB / 单请求累计 200MB / 总预算 60s / 并发 4
MEDIA_TIMEOUT_SECONDS = 10.0
MEDIA_MAX_FILE_BYTES = 50 * 1024 * 1024
MEDIA_MAX_TOTAL_BYTES = 200 * 1024 * 1024
MEDIA_BUDGET_SECONDS = 60.0
MEDIA_CONCURRENCY = 4
MEDIA_MAX_URLS = 200
MEDIA_PATH_RE = re.compile(r"^/(?:output|assets|apps)/")
MEDIA_STRING_KEYS = ("url", "originalUrl", "refUrl", "frame")

_LOCK = threading.Lock()


class ShareCreateRequest(BaseModel):
    canvas_id: str = ""
    permission: str = "view"
    expires_in_days: int = 7
    owner_name: str = ""


class LocalizeMediaRequest(BaseModel):
    urls: List[str] = []
    share_url: str = ""


# ---------------------------------------------------------------- 路径与读写

def data_dir() -> str:
    bound = deps.get("DATA_DIR")
    if bound:
        return str(bound)
    root = os.environ.get("NOVAI_DATA_DIR") or os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(root, "data")


def store_path() -> str:
    return os.path.join(data_dir(), SHARE_FILE_NAME)


def _write_atomic(path: str, data: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            import json as _json
            _json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def load_store() -> Dict[str, Any]:
    try:
        with open(store_path(), "r", encoding="utf-8") as handle:
            raw = __import__("json").load(handle)
    except (OSError, ValueError):
        return {"version": SHARE_VERSION, "shares": []}
    shares = raw.get("shares") if isinstance(raw, dict) else raw
    if not isinstance(shares, list):
        return {"version": SHARE_VERSION, "shares": []}
    cleaned = [item for item in shares if isinstance(item, dict) and str(item.get("token") or "")]
    return {"version": SHARE_VERSION, "shares": cleaned}


def save_store(store: Dict[str, Any]) -> None:
    _write_atomic(store_path(), store)


def now_ms() -> int:
    return int(time.time() * 1000)


def is_expired(share: Optional[Dict[str, Any]], now: Optional[int] = None) -> bool:
    if not share:
        return False
    expires_at = int(share.get("expires_at") or 0)
    return bool(expires_at) and expires_at <= (now_ms() if now is None else int(now))


def permission_allows(share: Optional[Dict[str, Any]], need: str) -> bool:
    if not share:
        return False
    permission = str(share.get("permission") or "view")
    if permission not in VALID_PERMISSIONS:
        permission = "view"
    if need == "view":
        return True
    if need == "clone":
        return permission in ("clone", "template")
    if need == "template":
        return permission == "template"
    return False


# ---------------------------------------------------------------- 记录查询

def get_share(token: str) -> Optional[Dict[str, Any]]:
    wanted = str(token or "")
    if not wanted:
        return None
    for item in load_store().get("shares", []):
        if str(item.get("token")) == wanted:
            return item
    return None


def find_share_for_canvas(canvas_id: str) -> Optional[Dict[str, Any]]:
    wanted = str(canvas_id or "")
    if not wanted:
        return None
    for item in load_store().get("shares", []):
        if str(item.get("canvas_id")) == wanted:
            return item
    return None


def _new_token() -> str:
    random_part = secrets.token_urlsafe(TOKEN_BYTES).replace("-", "").replace("_", "")
    # token_urlsafe(24) 约 32 字符，已满足 24+；再拼一段时间尾巴，方便人工看出新旧
    return (random_part + str(int(time.time() * 1000)))[:48]


def upsert_share(canvas_id: str, title: str = "", permission: str = "view",
                 expires_in_days: int = 7, owner_name: str = DEFAULT_OWNER_NAME,
                 now: Optional[int] = None) -> Dict[str, Any]:
    """创建或更新一张画布的分享记录；有效期内 token 保持不变。"""
    canvas_key = str(canvas_id or "")
    if not canvas_key:
        raise ValueError("canvas_id required")
    permission = str(permission or "view").strip().lower()
    if permission not in VALID_PERMISSIONS:
        raise ValueError("permission must be view/clone/template")
    days = int(expires_in_days or 0)
    if days not in VALID_EXPIRES_IN_DAYS:
        raise ValueError("expires_in_days must be 0/1/7/30")
    stamp = now_ms() if now is None else int(now)
    expires_at = 0 if days == 0 else stamp + days * 86400000
    display_name = (str(owner_name or "").strip() or DEFAULT_OWNER_NAME)[:40]
    with _LOCK:
        store = load_store()
        shares = store.get("shares", [])
        current = next((item for item in shares if str(item.get("canvas_id")) == canvas_key), None)
        if current is None:
            current = {
                "token": _new_token(),
                "canvas_id": canvas_key,
                "created_at": stamp,
            }
            shares.append(current)
        current.update({
            "title": str(title or current.get("title") or "")[:80],
            "permission": permission,
            "expires_at": expires_at,
            "owner_name": display_name,
        })
        store["shares"] = shares
        save_store(store)
        return copy.deepcopy(current)


def revoke_share(canvas_id: str) -> bool:
    canvas_key = str(canvas_id or "")
    if not canvas_key:
        return False
    with _LOCK:
        store = load_store()
        shares = store.get("shares", [])
        kept = [item for item in shares if str(item.get("canvas_id")) != canvas_key]
        if len(kept) == len(shares):
            return False
        store["shares"] = kept
        save_store(store)
        return True


# ---------------------------------------------------------------- 地址与快照

def _lan_ip() -> str:
    env_ip = os.environ.get("NOVAI_LAN_IP", "").strip()
    if env_ip:
        return env_ip
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return str(sock.getsockname()[0])
    except Exception:
        return ""
    finally:
        sock.close()


def page_url_base(request: Request) -> str:
    override = os.environ.get("NOVAI_SHARE_PAGE_URL", "").strip()
    if override:
        return override.rstrip("&?")
    port = os.environ.get("NOVAI_PORT", "").strip() or str(request.url.port or 3000)
    ip = _lan_ip()
    if ip:
        return "http://%s:%s/static/canvas.html" % (ip, port)
    return str(request.base_url).rstrip("/") + "/static/canvas.html"


def share_url(share: Dict[str, Any], request: Request) -> str:
    base = page_url_base(request)
    url = base + ("&" if "?" in base else "?") + "share=" + urllib.parse.quote(str(share.get("token") or ""))
    lan_auth_enabled = deps.get("LAN_AUTH_ENABLED")
    load_lan_token = deps.get("LOAD_LAN_TOKEN")
    if callable(lan_auth_enabled) and callable(load_lan_token):
        try:
            if lan_auth_enabled():
                token = str(load_lan_token() or "")
                if token:
                    url += "&token=" + urllib.parse.quote(token)
        except Exception:
            pass
    return url


def share_payload(share: Dict[str, Any], request: Request) -> Dict[str, Any]:
    return {
        "token": str(share.get("token") or ""),
        "canvas_id": str(share.get("canvas_id") or ""),
        "title": str(share.get("title") or ""),
        "url": share_url(share, request),
        "permission": str(share.get("permission") or "view"),
        "can_clone": permission_allows(share, "clone"),
        "can_save_template": permission_allows(share, "template"),
        "expires_at": int(share.get("expires_at") or 0),
        "created_at": int(share.get("created_at") or 0),
        "owner_name": str(share.get("owner_name") or DEFAULT_OWNER_NAME),
    }


def _path_mounts() -> List[Tuple[str, str]]:
    """本机目录 → 对外 URL 前缀（output / assets 是 Web 挂载点，其余按项目根拍平）。"""
    mounts: List[Tuple[str, str]] = []
    for key, mount in (
        ("ASSET_LIBRARY_DIR", "/assets/library"),
        ("OUTPUT_DIR", "/output"),
        ("ASSETS_DIR", "/assets"),
        ("BASE_DIR", ""),
    ):
        value = deps.get(key)
        if isinstance(value, str) and value:
            mounts.append((value.replace("\\", "/").rstrip("/"), mount))
    return sorted(mounts, key=lambda item: len(item[0]), reverse=True)


_ABSOLUTE_PATH = re.compile(r"^(?:file://)?(?:[A-Za-z]:[\\/]|/)")


def sanitize_local_path(value: str, mounts: Optional[List[Tuple[str, str]]] = None) -> str:
    """把快照里的本机绝对路径转成对外的相对 URL（/output/xxx、/assets/xxx）。"""
    if not isinstance(value, str) or not value:
        return value
    if value.startswith("data:") or value.startswith("blob:") or value.lower().startswith("http://") or value.lower().startswith("https://"):
        return value
    if not _ABSOLUTE_PATH.match(value):
        return value
    path = value[len("file://"):] if value.startswith("file://") else value
    path = path.replace("\\", "/")
    for prefix, mount in mounts if mounts is not None else _path_mounts():
        normalized = prefix.rstrip("/")
        if not normalized:
            continue
        rest = ""
        if path == normalized:
            rest = ""
        elif path.startswith(normalized + "/"):
            rest = path[len(normalized) + 1:]
        else:
            continue
        if mount:
            return mount + ("/" + rest if rest else "")
        return "/" + rest if rest else "/"
    return value


def _sanitize_value(value: Any, mounts: List[Tuple[str, str]]) -> Any:
    if isinstance(value, str):
        return sanitize_local_path(value, mounts)
    if isinstance(value, list):
        return [_sanitize_value(item, mounts) for item in value]
    if isinstance(value, dict):
        return {key: _sanitize_value(item, mounts) for key, item in value.items()}
    return value


def canvas_snapshot(canvas: Dict[str, Any]) -> Dict[str, Any]:
    mounts = _path_mounts()
    return {
        "title": str(canvas.get("title") or "未命名画布"),
        "icon": str(canvas.get("icon") or ""),
        "nodes": _sanitize_value(canvas.get("nodes") if isinstance(canvas.get("nodes"), list) else [], mounts),
        "connections": _sanitize_value(canvas.get("connections") if isinstance(canvas.get("connections"), list) else [], mounts),
        "settings": _sanitize_value(canvas.get("settings") if isinstance(canvas.get("settings"), dict) else {}, mounts),
    }



# ---------------------------------------------------------------- 媒体本地化（T52）

def _canonical_media_url(url: str) -> str:
    """去掉 token 参数后的稳定 key：同一个资源换一次口令仍复用同一份本地文件。"""
    try:
        parsed = urllib.parse.urlsplit(str(url or ""))
    except ValueError:
        return str(url or "")
    pairs = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True) if k != "token"]
    query = urllib.parse.urlencode(pairs)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, ""))


def _with_media_token(url: str, token: str) -> str:
    """下载 /output、/assets、/apps 这类数据面时，把对方的局域网口令补在 query 上。"""
    if not token:
        return url
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return url
    if not MEDIA_PATH_RE.match(parsed.path):
        return url
    pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    if any(key == "token" for key, _ in pairs):
        return url
    pairs.append(("token", token))
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(pairs), ""))


def _is_http_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlsplit(str(url or ""))
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.hostname)


def _share_lan_token(share_url: str) -> str:
    try:
        query = urllib.parse.urlsplit(str(share_url or "")).query
    except ValueError:
        return ""
    value = urllib.parse.parse_qs(query).get("token", [""])[0]
    return str(value or "")


def _local_host_names() -> set:
    names = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}
    ip = _lan_ip()
    if ip:
        names.add(ip)
    return names


def _is_local_url(url: str, request: Optional[Request]) -> bool:
    """同主机 + 同端口才算本机（同机起两个实例、端口不同仍算远端）。"""
    try:
        parsed = urllib.parse.urlsplit(str(url or ""))
    except ValueError:
        return False
    if str(parsed.hostname or "") not in _local_host_names():
        return False
    request_port = 0
    if request is not None:
        try:
            request_port = int(request.url.port or 0)
        except (TypeError, ValueError):
            request_port = 0
    if not request_port:
        try:
            request_port = int(os.environ.get("NOVAI_PORT", "0") or 0)
        except ValueError:
            request_port = 0
    if not request_port:
        request_port = 80 if parsed.scheme == "http" else 443
    url_port = int(parsed.port or (80 if parsed.scheme == "http" else 443))
    return url_port == request_port


def _local_path_of(url: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(str(url or ""))
    except ValueError:
        return ""
    pairs = [(k, v) for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True) if k != "token"]
    query = urllib.parse.urlencode(pairs)
    return (parsed.path or "/") + (("?" + query) if query else "")


def _node_media_urls(nodes: Any) -> List[str]:
    """只收真正的媒体字段（url/originalUrl/refUrl/frame/variants），不碰提示词文本。"""
    found: List[str] = []

    def walk(value: Any, key: str = "") -> None:
        if isinstance(value, dict):
            for item_key, item in value.items():
                if item_key in MEDIA_STRING_KEYS and isinstance(item, str):
                    if _is_http_url(item):
                        found.append(item)
                elif item_key == "variants" and isinstance(item, list):
                    for entry in item:
                        if isinstance(entry, str) and _is_http_url(entry):
                            found.append(entry)
                else:
                    walk(item, item_key)
        elif isinstance(value, list):
            for entry in value:
                walk(entry, key)

    walk(nodes)
    unique: List[str] = []
    seen = set()
    for url in found:
        canonical = _canonical_media_url(url)
        if canonical in seen:
            continue
        seen.add(canonical)
        unique.append(url)
    return unique


def _rewrite_media(value: Any, mapping: Dict[str, str]) -> Any:
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key, item in value.items():
            if key in MEDIA_STRING_KEYS and isinstance(item, str):
                out[key] = mapping.get(item, item)
            elif key == "variants" and isinstance(item, list):
                out[key] = [mapping.get(entry, entry) if isinstance(entry, str) else entry for entry in item]
            else:
                out[key] = _rewrite_media(item, mapping)
        return out
    if isinstance(value, list):
        return [_rewrite_media(item, mapping) for item in value]
    return value


def _media_fail(url: str, error: str) -> Dict[str, Any]:
    return {"url": url, "local": "", "ok": False, "error": error, "size": 0}


def _media_target(url: str) -> Tuple[str, str]:
    """URL → (落盘文件名, 内容类型兜底)。文件名按 URL 哈希，重复克隆命中同一份文件。"""
    parsed = urllib.parse.urlsplit(url)
    raw_name = urllib.parse.unquote(os.path.basename(parsed.path or "")) or "media"
    stem = os.path.splitext(raw_name)[0]
    stem = re.sub(r"[^0-9A-Za-z一-鿿._-]+", "_", stem).strip("._")[:60] or "media"
    digest = hashlib.sha1(_canonical_media_url(url).encode("utf-8")).hexdigest()[:12]
    return "up_" + digest + "_" + stem, parsed.path or ""


def _uploads_dir() -> Tuple[str, str]:
    safe_folder = deps.get("_local_upload_safe_folder")
    if callable(safe_folder):
        folder_rel, folder_abs = safe_folder("")
        return str(folder_rel or ""), str(folder_abs)
    bound = deps.get("LOCAL_UPLOAD_DIR")
    root = bound() if callable(bound) else bound
    root = str(root or os.path.join(data_dir(), "assets", "uploads"))
    return "", root


def _store_media(url: str, content: bytes, content_type: str) -> Tuple[bool, str, str]:
    """把媒体写进 /assets/uploads，返回 (ok, 本地 url, 错误)。已存在则直接复用（幂等）。"""
    stem, name_path = _media_target(url)
    kind = None
    ext = ""
    kind_ext = deps.get("_local_upload_kind_ext")
    if callable(kind_ext):
        kind, ext = kind_ext(name_path, content_type)
    if kind not in ("image", "video", "audio"):
        sniff = deps.get("_sniff_image_ext_bytes")
        real = sniff(content[:16]) if callable(sniff) and content else ""
        if real:
            kind, ext = "image", real
    if kind not in ("image", "video", "audio"):
        return False, "", "不是图片 / 视频 / 音频资源"
    folder_rel, folder_abs = _uploads_dir()
    try:
        os.makedirs(folder_abs, exist_ok=True)
    except OSError:
        return False, "", "本机落盘目录不可写"
    filename = stem + (ext or ".bin")
    path = os.path.join(folder_abs, filename)
    rel_name = (folder_rel.rstrip("/") + "/" + filename).lstrip("/") if folder_rel else filename
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return True, _local_upload_url(rel_name), ""
    try:
        with open(path, "wb") as handle:
            handle.write(content)
    except OSError:
        return False, "", "本机落盘失败"
    return True, _local_upload_url(rel_name), ""


def _cached_media_local(url: str) -> str:
    """落地文件名由 URL 决定：URL 自带扩展名时，文件已存在就直接复用（不下载）。"""
    stem, name_path = _media_target(url)
    kind_ext = deps.get("_local_upload_kind_ext")
    if not callable(kind_ext):
        return ""
    try:
        kind, ext = kind_ext(name_path, "")
    except Exception:
        return ""
    if kind not in ("image", "video", "audio") or not ext:
        return ""
    folder_rel, folder_abs = _uploads_dir()
    filename = stem + ext
    path = os.path.join(folder_abs, filename)
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        rel_name = (folder_rel.rstrip("/") + "/" + filename).lstrip("/") if folder_rel else filename
        return _local_upload_url(rel_name)
    return ""


def _local_upload_url(rel_name: str) -> str:
    item_builder = deps.get("_local_upload_item")
    if callable(item_builder):
        try:
            item = item_builder(rel_name)
            if isinstance(item, dict) and item.get("url"):
                return str(item["url"])
        except Exception:
            pass
    return "/assets/uploads/" + urllib.parse.quote(str(rel_name).lstrip("/"), safe="/")


async def _download_media(client: "httpx.AsyncClient", url: str, token: str,
                         max_bytes: int = MEDIA_MAX_FILE_BYTES) -> Tuple[bool, bytes, str, str]:
    """下载单个媒体：返回 (ok, 字节, content-type, 错误)。max_bytes 同时受单文件与剩余总预算约束。"""
    limit = max(1, min(MEDIA_MAX_FILE_BYTES, int(max_bytes or MEDIA_MAX_FILE_BYTES)))
    target = _with_media_token(url, token)
    headers = {"X-NOVAI-Token": token} if token else {}
    try:
        async with client.stream("GET", target, headers=headers, follow_redirects=True) as response:
            if response.status_code == 401:
                return False, b"", "", "对方口令失效"
            if response.status_code >= 400:
                return False, b"", "", "对方资源不可用（HTTP %s）" % response.status_code
            length = 0
            try:
                length = int(response.headers.get("content-length") or 0)
            except (TypeError, ValueError):
                length = 0
            if length > limit:
                return False, b"", "", "文件过大（超过 50MB）" if limit >= MEDIA_MAX_FILE_BYTES else "超过本次 200MB 下载上限"
            content = bytearray()
            async for chunk in response.aiter_bytes():
                if not chunk:
                    continue
                content.extend(chunk)
                if len(content) > limit:
                    return False, b"", "", "文件过大（超过 50MB）" if limit >= MEDIA_MAX_FILE_BYTES else "超过本次 200MB 下载上限"
            content_type = str(response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
            return True, bytes(content), content_type, ""
    except httpx.TimeoutException:
        return False, b"", "", "下载超时（超过 10 秒）"
    except Exception:
        return False, b"", "", "下载失败"


def _local_lan_token() -> str:
    """本机自己的局域网口令：服务端 clone 要取自己 /output 上的绝对地址时用。"""
    enabled = deps.get("LAN_AUTH_ENABLED")
    loader = deps.get("LOAD_LAN_TOKEN")
    if callable(enabled) and callable(loader):
        try:
            return str(loader() or "") if enabled() else ""
        except Exception:
            return ""
    return ""


async def localize_media_urls(urls: List[str], share_url: str = "", request: Optional[Request] = None,
                              lan_token: str = "") -> Dict[str, Any]:
    """把一组远端媒体地址复制到本机，返回逐条结果与 copied/failed/skipped 计数。"""
    token = _share_lan_token(share_url) or str(lan_token or "")
    results: List[Dict[str, Any]] = []
    pending: List[str] = []
    seen = set()
    skipped = 0
    for raw in (urls or [])[:MEDIA_MAX_URLS]:
        url = str(raw or "").strip()
        if not url or url.startswith("data:") or url.startswith("blob:"):
            skipped += 1
            continue
        if not _is_http_url(url):
            skipped += 1
            continue
        canonical = _canonical_media_url(url)
        if canonical in seen:
            continue
        seen.add(canonical)
        if _is_local_url(url, request):
            local = _local_path_of(url)
            results.append({"url": url, "local": local, "ok": True, "error": "", "size": 0, "cached": True})
            continue
        cached_local = _cached_media_local(url)
        if cached_local:
            results.append({"url": url, "local": cached_local, "ok": True, "error": "", "size": 0, "cached": True})
        else:
            pending.append(url)

    if pending:
        ssl_context = deps.get("_SSL_CONTEXT", True)
        trust_env = bool(deps.get("_TRUST_ENV", False))
        timeout = httpx.Timeout(MEDIA_TIMEOUT_SECONDS, connect=MEDIA_TIMEOUT_SECONDS)
        semaphore = asyncio.Semaphore(MEDIA_CONCURRENCY)
        budget = {"bytes": 0}

        async def handle(url: str) -> Dict[str, Any]:
            async with semaphore:
                remaining = MEDIA_MAX_TOTAL_BYTES - budget["bytes"]
                if remaining <= 0:
                    return _media_fail(url, "超过本次 200MB 下载上限")
                try:
                    async with httpx.AsyncClient(http2=False, verify=ssl_context, trust_env=trust_env, timeout=timeout) as client:
                        ok, content, content_type, error = await asyncio.wait_for(
                            _download_media(client, url, token, remaining), MEDIA_TIMEOUT_SECONDS + 2)
                except asyncio.TimeoutError:
                    return _media_fail(url, "下载超时（超过 10 秒）")
                except Exception:
                    return _media_fail(url, "下载失败")
                if not ok:
                    return _media_fail(url, error)
                budget["bytes"] += len(content)
                stored, local, store_error = _store_media(url, content, content_type)
                if not stored:
                    return _media_fail(url, store_error or "本机落盘失败")
                return {"url": url, "local": local, "ok": True, "error": "", "size": len(content), "cached": False}

        tasks = [asyncio.create_task(handle(url)) for url in pending]
        done, still = await asyncio.wait(tasks, timeout=MEDIA_BUDGET_SECONDS)
        for task in still:
            task.cancel()
        by_url: Dict[str, Dict[str, Any]] = {}
        for task in done:
            try:
                item = task.result()
            except Exception:
                continue
            by_url[item["url"]] = item
        for task, url in zip(tasks, pending):
            item = by_url.get(url)
            if item is None:
                item = _media_fail(url, "超出 60 秒总预算，未完成")
            results.append(item)

    order = {_canonical_media_url(str(url)): index for index, url in enumerate(urls or [])}
    results.sort(key=lambda item: order.get(_canonical_media_url(str(item.get("url") or "")), 10 ** 9))
    copied = sum(1 for item in results if item.get("ok"))
    failed = sum(1 for item in results if not item.get("ok"))
    return {"items": results, "copied": copied, "failed": failed, "skipped": skipped}


# ---------------------------------------------------------------- 接口

def _load_canvas(canvas_id: str) -> Dict[str, Any]:
    loader = deps.get("LOAD_CANVAS")
    if not callable(loader):
        raise HTTPException(status_code=500, detail="画布服务未就绪")
    try:
        return loader(canvas_id)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=404, detail="画布不存在") from exc


def _active_share(token: str) -> Dict[str, Any]:
    share = get_share(token)
    if not share:
        raise HTTPException(status_code=404, detail="分享链接无效或已被撤销")
    if is_expired(share):
        raise HTTPException(status_code=410, detail="分享链接已过期")
    return share


@router.get("/by-canvas/{canvas_id}")
async def get_share_for_canvas(canvas_id: str, request: Request) -> Dict[str, Any]:
    share = find_share_for_canvas(canvas_id)
    if not share or is_expired(share):
        return {"share": None}
    return {"share": share_payload(share, request)}


@router.post("")
async def create_share(payload: ShareCreateRequest, request: Request) -> Dict[str, Any]:
    canvas_key = str(payload.canvas_id or "").strip()
    if not canvas_key:
        raise HTTPException(status_code=400, detail="缺少画布 ID")
    permission = str(payload.permission or "view").strip().lower()
    if permission not in VALID_PERMISSIONS:
        raise HTTPException(status_code=400, detail="permission 只能是 view/clone/template")
    if int(payload.expires_in_days) not in VALID_EXPIRES_IN_DAYS:
        raise HTTPException(status_code=400, detail="expires_in_days 只能是 0/1/7/30")
    canvas = _load_canvas(canvas_key)
    require_access = deps.get("REQUIRE_CANVAS_ACCESS")
    if callable(require_access):
        require_access(canvas, request, "manage")
    owner_name = str(request.cookies.get("novai_local_name") or "").strip()
    if not owner_name:
        user = None
        request_user = deps.get("REQUEST_AUTH_USER")
        if callable(request_user):
            try:
                user = request_user(request)
            except Exception:
                user = None
        owner_name = str((user or {}).get("username") or payload.owner_name or DEFAULT_OWNER_NAME)
    share = upsert_share(
        canvas_key,
        title=str(canvas.get("title") or ""),
        permission=permission,
        expires_in_days=int(payload.expires_in_days),
        owner_name=owner_name,
    )
    return {"share": share_payload(share, request)}


@router.delete("/by-canvas/{canvas_id}")
async def delete_share(canvas_id: str, request: Request) -> Dict[str, Any]:
    share = find_share_for_canvas(canvas_id)
    if share:
        require_access = deps.get("REQUIRE_CANVAS_ACCESS")
        if callable(require_access):
            require_access(_load_canvas(canvas_id), request, "manage")
    revoke_share(canvas_id)
    return {"ok": True}


@router.post("/localize-media")
async def localize_media(payload: LocalizeMediaRequest, request: Request) -> Dict[str, Any]:
    """克隆 / 存模板前把远端媒体取到本机（前端调用）。返回逐条结果与计数，失败不回滚已成功的部分。"""
    urls = [str(item or "") for item in (payload.urls or [])][:MEDIA_MAX_URLS]
    return await localize_media_urls(urls, share_url=str(payload.share_url or ""), request=request)


@router.get("/{token}")
async def get_shared_canvas(token: str, request: Request) -> Dict[str, Any]:
    share = _active_share(token)
    canvas = _load_canvas(str(share.get("canvas_id") or ""))
    snapshot = canvas_snapshot(canvas)
    return {
        "share": {
            "token": str(share.get("token") or ""),
            "permission": str(share.get("permission") or "view"),
            "can_clone": permission_allows(share, "clone"),
            "can_save_template": permission_allows(share, "template"),
            "expires_at": int(share.get("expires_at") or 0),
            "created_at": int(share.get("created_at") or 0),
            "owner_name": str(share.get("owner_name") or DEFAULT_OWNER_NAME),
        },
        "title": snapshot["title"],
        "canvas": snapshot,
        "can_clone": permission_allows(share, "clone"),
        "can_save_template": permission_allows(share, "template"),
    }


@router.post("/{token}/clone")
async def clone_shared_canvas(token: str, request: Request) -> Dict[str, Any]:
    share = _active_share(token)
    if not permission_allows(share, "clone"):
        raise HTTPException(status_code=403, detail="这个分享只允许查看，不能克隆")
    canvas = _load_canvas(str(share.get("canvas_id") or ""))
    save_canvas = deps.get("SAVE_CANVAS")
    if not callable(save_canvas):
        raise HTTPException(status_code=500, detail="画布服务未就绪")
    clone = copy.deepcopy(canvas)
    base_title = str(canvas.get("title") or "画布")[:70]
    clone["id"] = uuid.uuid4().hex
    clone["title"] = (base_title + " 副本")[:80]
    clone["created_at"] = now_ms()
    clone.pop("deleted_at", None)
    clone.pop("owner_id", None)
    nodes = clone.get("nodes") if isinstance(clone.get("nodes"), list) else []
    media = await localize_media_urls(_node_media_urls(nodes), share_url="", request=request, lan_token=_local_lan_token())
    mapping = {item["url"]: item["local"] for item in media.get("items", []) if item.get("ok") and item.get("local")}
    if mapping:
        clone["nodes"] = _rewrite_media(clone.get("nodes"), mapping)
    save_canvas(clone)
    return {
        "canvas_id": str(clone["id"]),
        "title": clone["title"],
        "copied": int(media.get("copied") or 0),
        "failed": int(media.get("failed") or 0),
        "skipped": int(media.get("skipped") or 0),
    }
