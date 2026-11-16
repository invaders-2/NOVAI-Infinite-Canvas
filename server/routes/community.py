#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOVAI 社区（局域网版）路由。

本机接口（前端用）：作品流 / 精选 / 详情 / 发布 / 我的发布 / 克隆 / 点赞 / 收藏 / 举报 / 设置 / 主页背景。
公开接口（局域网其他节点调用，visible=false 时一律 404）：作品列表 / 详情 / 发布包 / 媒体 / 主页 / 事件上报。

统计归作者节点所有：点赞 / 克隆 / 浏览 / 举报都落作者机的 items.json，
别人通过 POST /api/community/public/items/{id}/event 上报，按 account_id 去重。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y。
"""
from __future__ import annotations

import asyncio
import base64
import hmac
import json
import os
import re
import secrets
import threading
import time
import urllib.parse
import uuid
from collections import deque
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from server.community import packager, store, transport
from server.routes.deps import deps

router = APIRouter(prefix="/api/community")

RATE_READ_PER_MIN = 120
RATE_EVENT_PER_MIN = 30
EVENT_DEDUPE_MS = 5 * 60 * 1000
MAX_EVENT_REASON = 80
MAX_ACCOUNT_ID = 64
MAX_PROFILE_COVER_BYTES = 8 * 1024 * 1024
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif")

_RATE_LOCK = threading.Lock()
_RATE: Dict[str, Dict[str, deque]] = {}
_SEEN_LOCK = threading.Lock()
_SEEN: Dict[str, int] = {}


# ---------------------------------------------------------------- 基础

def _account() -> Dict[str, Any]:
    from server.routes.lan_account import load_account
    return load_account()


def _author() -> Dict[str, Any]:
    account = _account()
    return {
        "account_id": str(account.get("id") or ""),
        "nickname": str(account.get("nickname") or "本机用户"),
        "avatar": str(account.get("avatar") or ""),
    }


def _account_code() -> str:
    from server.routes.lan_account import account_code
    return account_code(_account())


def _account_id() -> str:
    return str(_account().get("id") or "")


def _my_items(status: Optional[str] = None) -> List[Dict[str, Any]]:
    items = store.load_items()
    if status:
        return [item for item in items if item.get("status") == status]
    return items


def _published_items() -> List[Dict[str, Any]]:
    return [item for item in _my_items() if item.get("status") == "published"]


def _ensure_visible() -> None:
    if not store.visible():
        raise HTTPException(status_code=404, detail="本机还没有开启局域网社区可见")


def _rate_key(request: Request) -> str:
    host = request.client.host if request.client else ""
    return str(host or "unknown")


def _rate_limit(request: Request, bucket: str, limit: int) -> None:
    now = time.time()
    key = bucket + "|" + _rate_key(request)
    with _RATE_LOCK:
        entry = _RATE.setdefault(key, {"hits": deque(), "limit": limit})
        hits = entry["hits"]
        while hits and now - hits[0] > 60:
            hits.popleft()
        if len(hits) >= limit:
            raise HTTPException(status_code=429, detail="请求太频繁，请稍后再试")
        hits.append(now)


def _rate_read(request: Request) -> None:
    _rate_limit(request, "read", RATE_READ_PER_MIN)


def _rate_event(request: Request) -> None:
    _rate_limit(request, "event", RATE_EVENT_PER_MIN)


def _seen_once(key: str, ttl_ms: int = EVENT_DEDUPE_MS) -> bool:
    """同一个 key 在 ttl 内只算一次（浏览 / 事件的网络层去重）。"""
    now = store.now_ms()
    with _SEEN_LOCK:
        if len(_SEEN) > 4000:
            for stale in [k for k, at in _SEEN.items() if now - at > ttl_ms]:
                _SEEN.pop(stale, None)
        last = _SEEN.get(key)
        if last and now - last < ttl_ms:
            return False
        _SEEN[key] = now
        return True


def _clean_account_id(value: Any) -> str:
    text = re.sub(r"[^0-9a-zA-Z_-]", "", str(value or ""))[:MAX_ACCOUNT_ID]
    return text


def _blocked(me: Dict[str, Any], item: Dict[str, Any]) -> bool:
    author = item.get("author") if isinstance(item.get("author"), dict) else {}
    account_id = str(author.get("account_id") or "")
    return bool(account_id) and account_id in (me.get("blocked_authors") or [])


# ---------------------------------------------------------------- 作品流

def _matches(item: Dict[str, Any], kind: str, category: str, q: str) -> bool:
    if kind and str(item.get("kind") or "") != kind:
        return False
    if category and str(item.get("category") or "") != category:
        return False
    keyword = str(q or "").strip().lower()
    if not keyword:
        return True
    author = item.get("author") if isinstance(item.get("author"), dict) else {}
    haystack = " ".join([
        str(item.get("title") or ""),
        str(item.get("desc") or ""),
        str(item.get("category") or ""),
        " ".join(str(tag) for tag in (item.get("tags") or [])),
        str(author.get("nickname") or ""),
    ]).lower()
    return keyword in haystack


def _sort_items(items: List[Dict[str, Any]], sort: str) -> List[Dict[str, Any]]:
    mode = str(sort or "latest")
    if mode == "hot":
        return sorted(items, key=lambda it: (int((it.get("stats") or {}).get("likes") or 0),
                                            int((it.get("stats") or {}).get("clones") or 0),
                                            int(it.get("updated_at") or 0)), reverse=True)
    if mode == "clones":
        return sorted(items, key=lambda it: (int((it.get("stats") or {}).get("clones") or 0),
                                             int((it.get("stats") or {}).get("likes") or 0),
                                             int(it.get("updated_at") or 0)), reverse=True)
    return sorted(items, key=lambda it: int(it.get("updated_at") or 0), reverse=True)


async def aggregate_items(force: bool = False) -> Dict[str, Any]:
    """本机 + 在线节点 + 缓存（作者离线时 online:false）。"""
    me = store.load_me()
    aggregated = await transport.get_transport().aggregate(force=force)
    remote = aggregated.get("items") or []
    merged: Dict[str, Dict[str, Any]] = {}
    for item in remote:
        item_id = str(item.get("id") or "")
        if not store.valid_item_id(item_id):
            continue
        if _blocked(me, item) or item_id in (me.get("reports") or []):
            continue
        merged[item_id] = item
    for item in transport.load_cached_items():
        item_id = str(item.get("id") or "")
        if not item_id or item_id in merged:
            continue
        if _blocked(me, item) or item_id in (me.get("reports") or []):
            continue
        offline = dict(item)
        offline["online"] = False
        node = transport.node_of(item_id) or {}
        offline.setdefault("node", {"id": node.get("id") or "", "nickname": node.get("nickname") or "",
                                    "avatar": node.get("avatar") or "", "online": False})
        offline["node"] = {**(offline.get("node") or {}), "online": False}
        merged[item_id] = offline
    for item in _published_items():
        public = store.item_public(item, online=True)
        public["node"] = {"id": _account_id(), "nickname": _author()["nickname"],
                          "avatar": _author()["avatar"], "online": True}
        public["mine"] = True
        merged[public["id"]] = public
    return {
        "items": list(merged.values()),
        "nodes": aggregated.get("nodes") or [],
        "creators_online": int(aggregated.get("creators_online") or 0) + (1 if _published_items() else 0),
    }


@router.get("/feed")
async def feed(request: Request, kind: str = "", q: str = "", sort: str = "latest",
               category: str = "") -> Dict[str, Any]:
    _rate_read(request)
    data = await aggregate_items()
    items = [item for item in data["items"] if _matches(item, kind, category, q)]
    items = _sort_items(items, sort)
    counts = {"all": len(data["items"]), "canvas": 0, "skill": 0, "prompt": 0}
    categories: Dict[str, int] = {}
    for item in data["items"]:
        item_kind = str(item.get("kind") or "")
        if item_kind in counts:
            counts[item_kind] += 1
        label = str(item.get("category") or "")
        if label:
            categories[label] = categories.get(label, 0) + 1
    return {
        "items": items,
        "counts": counts,
        "categories": [{"id": key, "count": value} for key, value in categories.items()],
        "creators_online": data["creators_online"],
        "nodes": [{"id": node.get("id"), "nickname": node.get("nickname"), "online": True}
                  for node in data.get("nodes") or []],
    }


@router.get("/featured")
async def featured(request: Request) -> Dict[str, Any]:
    _rate_read(request)
    data = await aggregate_items()
    week_ago = store.now_ms() - 7 * 86400 * 1000
    scored: List[Tuple[int, Dict[str, Any]]] = []
    for item in data["items"]:
        if str(item.get("status") or "published") != "published":
            continue
        stats = item.get("stats") or {}
        likes = int(stats.get("likes") or 0)
        clones = int(stats.get("clones") or 0)
        if not likes and not clones:
            continue
        if int(item.get("created_at") or 0) and int(item.get("created_at") or 0) < week_ago:
            continue
        scored.append((likes + 2 * clones, item))
    scored.sort(key=lambda pair: (pair[0], int(pair[1].get("updated_at") or 0)), reverse=True)
    picked = [item for _score, item in scored[:5]]
    if len(picked) < 4:
        already = {item.get("id") for item in picked}
        latest = _sort_items([item for item in data["items"]
                              if item.get("id") not in already
                              and str(item.get("status") or "published") == "published"], "latest")
        for item in latest:
            if len(picked) >= 4:
                break
            picked.append(item)
    return {"items": picked, "creators_online": data["creators_online"],
            "total": len(data["items"])}


# ---------------------------------------------------------------- 详情

def _local_media_urls(payload: Dict[str, Any], item_id: str) -> Dict[str, Any]:
    """把包里的 /api/community/public/media/<id>/<file> 换成本机 /api/community/media/<id>/<file>。"""
    prefix = packager.MEDIA_URL_PREFIX + item_id + "/"
    local = "/api/community/media/" + item_id + "/"
    mapping: Dict[str, str] = {}

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if key in packager.MEDIA_KEYS and isinstance(item, str) and item.startswith(prefix):
                    mapping[item] = local + item[len(prefix):]
                elif key == "variants" and isinstance(item, list):
                    for entry in item:
                        if isinstance(entry, str) and entry.startswith(prefix):
                            mapping[entry] = local + entry[len(prefix):]
                else:
                    walk(item)
        elif isinstance(value, list):
            for entry in value:
                walk(entry)

    walk(payload)
    return packager._rewrite_strings(payload, mapping) if mapping else payload


async def _prefetch_after_detail(item_id: str, package: Dict[str, Any]) -> None:
    try:
        names = transport.media_names_from_payload(package, item_id)
        if names:
            await transport.prefetch_media(item_id, names)
    except Exception as exc:  # 缓存失败不影响浏览
        print("[Community] 预缓存媒体失败 %s：%s" % (item_id, exc), flush=True)


async def _report_view(item_id: str) -> None:
    try:
        await transport.get_transport().post_event(item_id, {
            "type": "view", "account_id": _account_id()})
    except Exception:
        pass


async def resolve_item(item_id: str, for_clone: bool = False) -> Dict[str, Any]:
    """统一解析：我的 / 在线节点 / 本机缓存。返回 {item, mine, online, package, payload}。"""
    if not store.valid_item_id(item_id):
        raise HTTPException(status_code=400, detail="作品 ID 不合法")
    mine = store.find_item(_my_items(), item_id)
    if mine:
        package = packager.read_package(item_id) or {}
        payload = package.get("payload") if isinstance(package.get("payload"), dict) else {}
        return {"item": store.item_public(mine, online=True), "mine": True, "online": True,
                "package": package, "payload": _local_media_urls(payload, item_id) if payload else {}}

    transport_ref = transport.get_transport()
    body = await transport_ref.item_detail(item_id)
    if body:
        item = body.get("item") if isinstance(body.get("item"), dict) else {}
        if store.valid_item_id(str(item.get("id") or "")):
            transport.remember_cached_item(item)
            package: Dict[str, Any] = {}
            if bool(item.get("allow_clone", True)):
                fetched = await transport_ref.item_package(item_id)
                if fetched:
                    try:
                        package = packager.validate_package(fetched, item_id)
                        packager.save_cached_package(item_id, package, {})
                    except ValueError:
                        package = {}
            payload = body.get("payload") if isinstance(body.get("payload"), dict) else (
                package.get("payload") if isinstance(package.get("payload"), dict) else {})
            if package and not payload:
                payload = package.get("payload") or {}
            if package:
                asyncio.create_task(_prefetch_after_detail(item_id, package))
            if not for_clone:
                asyncio.create_task(_report_view(item_id))
            public = store.item_public(item, online=True)
            return {"item": public, "mine": False, "online": True, "package": package,
                    "payload": _local_media_urls(payload, item_id)}

    cached_package = packager.read_cached_package(item_id) or {}
    cached_meta = next((entry for entry in transport.load_cached_items()
                        if str(entry.get("id") or "") == item_id), None)
    if cached_package and cached_meta:
        item = store.item_public(cached_meta, online=False)
        payload = cached_package.get("payload") if isinstance(cached_package.get("payload"), dict) else {}
        return {"item": item, "mine": False, "online": False, "package": cached_package,
                "payload": _local_media_urls(payload, item_id)}
    raise HTTPException(status_code=404, detail="作品不存在，作者也可能已离线")


@router.get("/items/{item_id}")
async def item_detail(item_id: str, request: Request) -> Dict[str, Any]:
    _rate_read(request)
    resolved = await resolve_item(item_id)
    item = resolved["item"]
    payload = resolved["payload"]
    return {
        "item": item,
        "mine": bool(resolved["mine"]),
        "online": bool(resolved["online"]),
        "payload": payload,
        "summary": _payload_summary(item, payload),
    }


def _payload_summary(item: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    meta = item.get("meta") or {}
    kind = str(item.get("kind") or "canvas")
    if kind == "canvas":
        nodes = payload.get("nodes") if isinstance(payload.get("nodes"), list) else []
        return {"nodes": int(meta.get("nodes") or len(nodes)), "media": int(meta.get("media") or 0),
                "size_bytes": int(meta.get("size_bytes") or 0), "type_label": "画布"}
    if kind == "skill":
        return {"nodes": 0, "media": 0, "size_bytes": int(meta.get("size_bytes") or 0), "type_label": "技能"}
    return {"nodes": 0, "media": 0, "size_bytes": int(meta.get("size_bytes") or 0), "type_label": "提示词"}


# ---------------------------------------------------------------- 媒体 / 封面

def _media_response(path: str, filename: str) -> FileResponse:
    return FileResponse(path, media_type=transport.media_content_type(filename))


def _package_media_path(item_id: str, filename: str) -> Optional[str]:
    text = str(filename or "")
    if not store.valid_file_name(text):
        return None
    path = os.path.join(store.package_dir(item_id), "media", text)
    return path if os.path.isfile(path) else None


def _package_cover_path(item_id: str) -> Optional[str]:
    path = os.path.join(store.package_dir(item_id), "cover.webp")
    return path if os.path.isfile(path) else None


def _cache_cover_path(item_id: str) -> Optional[str]:
    path = os.path.join(store.cache_item_dir(item_id), "cover.webp")
    return path if os.path.isfile(path) else None


async def _serve_media(item_id: str, filename: str, cover: bool = False) -> FileResponse:
    if not store.valid_item_id(item_id):
        raise HTTPException(status_code=400, detail="作品 ID 不合法")
    name = "cover.webp" if cover else filename
    if not store.valid_file_name(name):
        raise HTTPException(status_code=400, detail="文件名不合法")
    mine = store.find_item(_my_items(), item_id)
    if mine:
        path = _package_cover_path(item_id) if cover else _package_media_path(item_id, name)
        if path:
            return _media_response(path, name)
        raise HTTPException(status_code=404, detail="文件不存在")
    cached = transport.cached_media_path(item_id, name) if not cover else None
    if cover:
        cached = _cache_cover_path(item_id)
    if cached:
        return _media_response(cached, name)
    # 作者在线：按需下载并缓存（封面也走这条路）
    content = await transport.get_transport().download_media(item_id, name)
    if not content:
        raise HTTPException(status_code=404, detail="作者离线，素材没有缓存")
    directory = store.cache_item_dir(item_id)
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory if cover else transport.cache_media_dir(item_id), name)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    try:
        with open(target, "wb") as handle:
            handle.write(content)
    except OSError:
        pass
    return _media_response(target, name)


@router.get("/media/{item_id}/{filename}")
async def local_media(item_id: str, filename: str, request: Request) -> FileResponse:
    _rate_read(request)
    return await _serve_media(item_id, filename)


@router.get("/cover/{item_id}")
async def local_cover(item_id: str, request: Request) -> FileResponse:
    _rate_read(request)
    return await _serve_media(item_id, "cover.webp", cover=True)


# ---------------------------------------------------------------- 发布

class PublishRequest(BaseModel):
    kind: str = "canvas"
    source_id: str = ""
    title: str = ""
    desc: str = ""
    tags: List[str] = []
    category: str = ""
    cover: str = ""
    allow_clone: bool = True
    include_media: bool = True
    visible: Optional[bool] = None


class MinePatchRequest(BaseModel):
    title: Optional[str] = None
    desc: Optional[str] = None
    tags: Optional[List[str]] = None
    category: Optional[str] = None
    cover: Optional[str] = None
    allow_clone: Optional[bool] = None
    include_media: Optional[bool] = None
    republish: bool = False


class ReportRequest(BaseModel):
    reason: str = ""


class EventRequest(BaseModel):
    type: str = ""
    account_id: str = ""
    reason: str = ""


class SettingsRequest(BaseModel):
    visible: Optional[bool] = None


class ProfileRequest(BaseModel):
    action: str = ""
    data_url: str = ""
    url: str = ""
    focus_x: Optional[int] = None
    focus_y: Optional[int] = None


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


def _load_skill(skill_id: str) -> Dict[str, Any]:
    from server.skills import registry
    skill = registry.get_skill(skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail="技能不存在")
    return skill


def _load_prompt(item_id: str) -> Dict[str, Any]:
    loader = deps.get("load_prompt_libraries")
    if not callable(loader):
        raise HTTPException(status_code=500, detail="提示词库未就绪")
    data = loader()
    for library in data.get("libraries") or []:
        for entry in library.get("items") or []:
            if str(entry.get("id") or "") == item_id:
                with_lib = dict(entry)
                with_lib["__library_id"] = str(library.get("id") or "")
                return with_lib
    raise HTTPException(status_code=404, detail="提示词不存在")


def _canvas_media_urls(canvas: Dict[str, Any]) -> List[str]:
    """画布里的媒体地址：先按发布口径清洗（绝对路径 → 站内地址）再收集。"""
    snapshot = packager.canvas_snapshot(canvas if isinstance(canvas, dict) else {})
    return packager.collect_canvas_media({"nodes": snapshot.get("nodes") or [],
                                          "connections": snapshot.get("connections") or []})


def _source_preview(kind: str, source_id: str) -> Dict[str, Any]:
    """发布弹窗用：来源名称、节点数、生成结果数、可选的封面候选。"""
    if kind == "canvas":
        canvas = _load_canvas(source_id)
        nodes = canvas.get("nodes") if isinstance(canvas.get("nodes"), list) else []
        media = _canvas_media_urls(canvas)
        covers = [url for url in media
                  if os.path.splitext(str(url).split("?")[0])[1].lower() in IMAGE_EXTS][:4]
        size = 0
        for url in media:
            path = packager.local_path_for_url(url)
            if path:
                try:
                    size += os.path.getsize(path)
                except OSError:
                    pass
        return {
            "kind": "canvas", "source_id": source_id,
            "title": str(canvas.get("title") or "未命名画布"),
            "nodes": len(nodes), "media": len(media), "size_bytes": size,
            "covers": covers, "icon": str(canvas.get("icon") or ""),
        }
    if kind == "skill":
        skill = _load_skill(source_id)
        return {
            "kind": "skill", "source_id": source_id,
            "title": str(skill.get("name") or source_id),
            "nodes": len(skill.get("deliverables") or []), "media": 0, "size_bytes": 0,
            "covers": [], "icon": str(skill.get("icon") or ""),
            "desc": str(skill.get("description") or ""),
        }
    prompt = _load_prompt(source_id)
    return {
        "kind": "prompt", "source_id": source_id,
        "title": str(prompt.get("name") or "提示词"),
        "nodes": 0, "media": 0, "size_bytes": 0, "covers": [],
        "desc": str(prompt.get("positive") or "")[:200],
    }


def _source_payload(kind: str, source_id: str) -> Dict[str, Any]:
    if kind == "canvas":
        return _load_canvas(source_id)
    if kind == "skill":
        return _load_skill(source_id)
    return _load_prompt(source_id)


@router.get("/source")
async def source_info(kind: str, source_id: str, request: Request) -> Dict[str, Any]:
    _rate_read(request)
    if kind not in store.KINDS:
        raise HTTPException(status_code=400, detail="kind 只能是 canvas / skill / prompt")
    return {"source": _source_preview(kind, str(source_id or ""))}


@router.post("/publish")
async def publish(payload: PublishRequest, request: Request) -> Dict[str, Any]:
    kind = str(payload.kind or "").strip().lower()
    if kind not in store.KINDS:
        raise HTTPException(status_code=400, detail="kind 只能是 canvas / skill / prompt")
    source_id = str(payload.source_id or "").strip()
    if not source_id:
        raise HTTPException(status_code=400, detail="缺少 source_id")
    items = store.load_items()
    for item in items:
        if item.get("kind") == kind and str(item.get("source_id") or "") == source_id:
            raise HTTPException(status_code=409, detail="这个来源已经发布过，可以在「我的」里编辑或更新")
    source = _source_payload(kind, source_id)
    preview = _source_preview(kind, source_id)
    author = _author()
    item_id = store._new_item_id(_account_code())
    title = str(payload.title or "").strip() or str(preview.get("title") or "未命名作品")
    options = {
        "title": title[:store.MAX_TITLE],
        "desc": payload.desc,
        "tags": [str(tag).strip()[:store.MAX_TAG_LEN] for tag in (payload.tags or []) if str(tag or "").strip()][:store.MAX_TAGS],
        "category": str(payload.category or "").strip()[:24],
        "cover": str(payload.cover or ""),
        "allow_clone": bool(payload.allow_clone),
        "include_media": bool(payload.include_media),
        "author": author,
        "version": 1,
        "created_at": store.now_ms(),
        "updated_at": store.now_ms(),
    }
    try:
        package = packager.build_package(item_id, kind, source, options)
    except packager.PackageTooLarge as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    now = store.now_ms()
    item = {
        "id": item_id,
        "kind": kind,
        "source_id": source_id,
        "title": options["title"],
        "desc": options["desc"],
        "tags": options["tags"],
        "category": options["category"],
        "cover": str(package.get("cover") or ""),
        "author": author,
        "version": 1,
        "created_at": now,
        "updated_at": now,
        "package_updated_at": now,
        "allow_clone": options["allow_clone"],
        "include_media": options["include_media"],
        "status": "published",
        "meta": package.get("meta") or {},
        "stats": {"likes": 0, "clones": 0, "views": 0, "reports": 0},
        "report_reasons": [],
        "liked_by": [],
        "cloned_by": [],
    }
    items.append(store._normalize_item(item))
    store.save_items(items)
    # 第一次发布顺手打开「在局域网社区中可见」（开关默认关，发布时引导打开）
    if payload.visible is True or not store.visible():
        store.set_visible(True)
    transport.clear_feed_cache()
    saved = store.find_item(store.load_items(), item_id) or item
    return {"item": store.item_public(saved, online=True), "visible": store.visible(),
            "guidance": "已开启「在局域网社区中可见」"}


# ---------------------------------------------------------------- 我的发布

@router.get("/mine")
async def my_items(request: Request, source_id: str = "") -> Dict[str, Any]:
    _rate_read(request)
    items = [_item_with_changes(item) for item in _my_items()]
    items.sort(key=lambda it: int(it.get("updated_at") or 0), reverse=True)
    wanted = str(source_id or "").strip()
    if wanted:
        for item in items:
            if str(item.get("source_id") or "") == wanted:
                return {"item": item, "has_any": True, "visible": store.visible()}
        return {"item": None, "has_any": bool(items), "visible": store.visible()}
    return {"items": items, "visible": store.visible()}


def _item_with_changes(item: Dict[str, Any]) -> Dict[str, Any]:
    public = store.item_public(item, online=True)
    public["source_id"] = str(item.get("source_id") or "")
    public["has_changes"] = False
    public["changed_nodes"] = 0
    try:
        if str(item.get("kind") or "") == "canvas":
            canvas = _load_canvas(str(item.get("source_id") or ""))
            if canvas:
                updated = int(canvas.get("updated_at") or 0)
                public["has_changes"] = updated > int(item.get("package_updated_at") or 0)
                if public["has_changes"]:
                    published = packager.read_package(str(item.get("id") or "")) or {}
                    known = len((published.get("payload") or {}).get("nodes") or [])
                    now_nodes = len(canvas.get("nodes") or [])
                    public["changed_nodes"] = max(1, now_nodes - known)
    except HTTPException:
        public["source_missing"] = True
    except Exception:
        pass
    return public


def _find_mine(item_id: str) -> Dict[str, Any]:
    items = store.load_items()
    item = store.find_item(items, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="你还没有发布这个作品")
    return item


def _apply_patch(item: Dict[str, Any], patch: MinePatchRequest) -> None:
    if patch.title is not None and str(patch.title).strip():
        item["title"] = str(patch.title).strip()[:store.MAX_TITLE]
    if patch.desc is not None:
        item["desc"] = str(patch.desc)[:store.MAX_DESC]
    if patch.tags is not None:
        item["tags"] = [str(tag).strip()[:store.MAX_TAG_LEN] for tag in patch.tags if str(tag or "").strip()][:store.MAX_TAGS]
    if patch.category is not None:
        item["category"] = str(patch.category).strip()[:24]
    if patch.allow_clone is not None:
        item["allow_clone"] = bool(patch.allow_clone)
    if patch.include_media is not None:
        item["include_media"] = bool(patch.include_media)
    item["updated_at"] = store.now_ms()


@router.patch("/mine/{item_id}")
async def patch_mine(item_id: str, payload: MinePatchRequest) -> Dict[str, Any]:
    item = _find_mine(item_id)
    items = store.load_items()
    target = store.find_item(items, item_id) or item
    _apply_patch(target, payload)
    if payload.republish:
        source = _source_payload(str(target.get("kind") or ""), str(target.get("source_id") or ""))
        target["version"] = int(target.get("version") or 1) + 1
        options = {
            "title": target.get("title"),
            "desc": target.get("desc"),
            "tags": target.get("tags"),
            "category": target.get("category"),
            "cover": str(payload.cover or item.get("cover") or ""),
            "allow_clone": bool(target.get("allow_clone")),
            "include_media": bool(target.get("include_media")),
            "author": _author(),
            "version": target["version"],
            "created_at": int(target.get("created_at") or store.now_ms()),
            "updated_at": store.now_ms(),
        }
        try:
            package = packager.build_package(item_id, str(target.get("kind") or ""), source, options)
        except packager.PackageTooLarge as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc
        target["cover"] = str(package.get("cover") or target.get("cover") or "")
        target["meta"] = package.get("meta") or target.get("meta") or {}
        target["package_updated_at"] = store.now_ms()
        target["updated_at"] = store.now_ms()
    elif payload.cover is not None and payload.cover and payload.cover != item.get("cover"):
        cover_url = str(payload.cover)
        path = packager.local_path_for_url(cover_url)
        dest = os.path.join(store.package_dir(item_id), "cover.webp")
        if path and packager._write_cover(path, dest):
            target["cover"] = "cover.webp"
    items = [store._normalize_item(target) if str(entry.get("id")) == item_id else entry for entry in items]
    store.save_items([entry for entry in items if entry])
    transport.clear_feed_cache()
    saved = store.find_item(store.load_items(), item_id) or target
    return {"item": _item_with_changes(saved)}


@router.post("/mine/{item_id}/unlist")
async def unlist_mine(item_id: str) -> Dict[str, Any]:
    _set_status(item_id, "unlisted")
    return {"item": _item_with_changes(_find_mine(item_id))}


@router.post("/mine/{item_id}/relist")
async def relist_mine(item_id: str) -> Dict[str, Any]:
    _set_status(item_id, "published")
    return {"item": _item_with_changes(_find_mine(item_id))}


def _set_status(item_id: str, status: str) -> None:
    items = store.load_items()
    target = store.find_item(items, item_id)
    if not target:
        raise HTTPException(status_code=404, detail="你还没有发布这个作品")
    target["status"] = status
    target["updated_at"] = store.now_ms()
    store.save_items([store._normalize_item(entry) if str(entry.get("id")) == item_id else entry
                      for entry in items])
    transport.clear_feed_cache()


@router.delete("/mine/{item_id}")
async def delete_mine(item_id: str) -> Dict[str, Any]:
    items = store.load_items()
    target = store.find_item(items, item_id)
    if not target:
        raise HTTPException(status_code=404, detail="你还没有发布这个作品")
    store.save_items([entry for entry in items if str(entry.get("id")) != item_id])
    package = store.package_dir(item_id)
    try:
        import shutil
        shutil.rmtree(package, ignore_errors=True)
    except Exception:
        pass
    transport.clear_feed_cache()
    return {"ok": True, "deleted": item_id}


# ---------------------------------------------------------------- 克隆

def _ensure_prompt_library() -> Dict[str, Any]:
    loader = deps.get("load_prompt_libraries")
    saver = deps.get("save_prompt_libraries")
    if not callable(loader) or not callable(saver):
        raise HTTPException(status_code=500, detail="提示词库未就绪")
    data = loader()
    libraries = data.get("libraries") or []
    for library in libraries:
        if str(library.get("id") or "") == "community":
            return library
    library = {
        "id": "community",
        "name": "社区",
        "type": "prompt",
        "categories": [{"id": "community", "name": "社区"}],
        "items": [],
    }
    libraries.append(library)
    data["libraries"] = libraries
    data["active_library_id"] = data.get("active_library_id") or "community"
    saver(data)
    return library


async def _media_bytes(item_id: str, filename: str) -> Tuple[Optional[bytes], str]:
    path = transport.cached_media_path(item_id, filename)
    if path:
        try:
            with open(path, "rb") as handle:
                return handle.read(), transport.media_content_type(filename)
        except OSError:
            return None, transport.media_content_type(filename)
    content = await transport.get_transport().download_media(item_id, filename)
    if not content:
        return None, transport.media_content_type(filename)
    directory = transport.cache_media_dir(item_id)
    try:
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, filename), "wb") as handle:
            handle.write(content)
    except OSError:
        pass
    return content, transport.media_content_type(filename)


async def _clone_canvas(item: Dict[str, Any], package: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    from server.routes.canvas_share import _store_media
    item_id = str(item.get("id") or "")
    mapping: Dict[str, str] = {}
    copied = 0
    failed: List[Dict[str, str]] = []
    for url in packager.collect_canvas_media(payload):
        text = str(url or "")
        filename = packager.media_filename_of(text, item_id)
        content, content_type = await _media_bytes(item_id, filename)
        if not content:
            failed.append({"url": text, "error": "作者离线，素材没有缓存"})
            continue
        ok, local, error = _store_media(text, content, content_type)
        if ok and local:
            mapping[text] = local
            copied += 1
        else:
            failed.append({"url": text, "error": error or "本机落盘失败"})
    new_payload = packager._rewrite_strings(payload, mapping)
    nodes = new_payload.get("nodes") if isinstance(new_payload.get("nodes"), list) else []
    connections = new_payload.get("connections") if isinstance(new_payload.get("connections"), list) else []
    base_title = str(item.get("title") or "画布")[:70]
    new_canvas = None
    maker = deps.get("NEW_CANVAS")
    if callable(maker):
        try:
            new_canvas = maker(base_title + "（克隆）")
        except Exception:
            new_canvas = None
    if not isinstance(new_canvas, dict):
        new_canvas = {
            "id": uuid.uuid4().hex,
            "title": (base_title + "（克隆）")[:80],
            "icon": "",
            "kind": "classic",
            "owner": "",
            "color": "",
            "pinned": False,
            "project": "",
            "created_at": store.now_ms(),
            "updated_at": store.now_ms(),
            "nodes": [],
            "connections": [],
            "viewport": {"x": 0, "y": 0, "scale": 1},
        }
    new_canvas["title"] = (base_title + "（克隆）")[:80]
    new_canvas["nodes"] = nodes
    new_canvas["connections"] = connections
    if isinstance(new_payload.get("settings"), dict) and new_payload.get("settings"):
        new_canvas["settings"] = new_payload.get("settings")
    new_canvas["source"] = {
        "item_id": item_id,
        "version": int(item.get("version") or 1),
        "author": dict(item.get("author") or {}),
    }
    if failed:
        from server.routes.canvas_share import _mark_missing_media
        marked = _mark_missing_media(new_canvas.get("nodes"), failed)
        if marked:
            new_canvas["media_missing"] = marked
        new_canvas["nodes"] = new_canvas.get("nodes") or []
    saver = deps.get("SAVE_CANVAS")
    if not callable(saver):
        raise HTTPException(status_code=500, detail="画布服务未就绪")
    saver(new_canvas)
    return {"kind": "canvas", "target_id": str(new_canvas.get("id") or ""),
            "title": new_canvas.get("title"), "copied": copied, "failed": len(failed),
            "failed_items": failed[:5]}


def _clone_skill(item: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    from server.skills import registry
    definition = dict(payload or {})
    original_id = str(definition.get("id") or "skill")
    base = re.sub(r"[^A-Za-z0-9._-]", "-", original_id)[:56] or "skill"
    new_id = "%s-c%s" % (base, secrets.token_hex(2))
    definition["id"] = new_id
    definition["name"] = str(definition.get("name") or original_id)
    definition["enabled"] = False          # 克隆来的技能默认停用，确认后才启用
    definition["available"] = True
    definition.pop("author", None)
    try:
        skill, _created = registry.import_skill(definition)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"kind": "skill", "target_id": str(skill.get("id") or new_id),
            "title": skill.get("name") or definition["name"], "copied": 0, "failed": 0,
            "needs_enable": True,
            "message": "来自 %s 的技能，确认后启用" % str((item.get("author") or {}).get("nickname") or "对方")}


def _clone_prompt(item: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    loader = deps.get("load_prompt_libraries")
    saver = deps.get("save_prompt_libraries")
    normalize = deps.get("normalize_prompt_library_item")
    if not callable(loader) or not callable(saver):
        raise HTTPException(status_code=500, detail="提示词库未就绪")
    _ensure_prompt_library()
    data = loader()
    library = None
    for entry in data.get("libraries") or []:
        if str(entry.get("id") or "") == "community":
            library = entry
            break
    if library is None:
        raise HTTPException(status_code=500, detail="提示词库未就绪")
    raw = {
        "id": "tpl_%s" % secrets.token_hex(6),
        "name": str(payload.get("name") or item.get("title") or "提示词"),
        "category": "community",
        "positive": str(payload.get("positive") or ""),
        "negative": str(payload.get("negative") or ""),
        "created_at": store.now_ms(),
        "updated_at": store.now_ms(),
    }
    entry = normalize(raw) if callable(normalize) else raw
    library.setdefault("items", []).insert(0, entry)
    categories = library.get("categories") if isinstance(library.get("categories"), list) else []
    if not any(str(cat.get("id")) == "community" for cat in categories):
        categories.append({"id": "community", "name": "社区"})
    library["categories"] = categories
    data["active_library_id"] = str(library.get("id") or "community")
    saver(data)
    return {"kind": "prompt", "target_id": str(entry.get("id") or ""),
            "title": entry.get("name"), "copied": 0, "failed": 0, "library_id": "community"}


def _record_clone(item: Dict[str, Any], result: Dict[str, Any]) -> None:
    def mutate(me: Dict[str, Any]) -> None:
        clones = me.get("clones") or []
        clones = [entry for entry in clones if str(entry.get("item_id")) != str(item.get("id"))]
        clones.insert(0, {
            "item_id": str(item.get("id") or ""),
            "kind": str(item.get("kind") or ""),
            "target_id": str(result.get("target_id") or ""),
            "title": str(item.get("title") or ""),
            "author": dict(item.get("author") or {}),
            "at": store.now_ms(),
        })
        me["clones"] = clones[:store.MAX_CLONES_LOG]
    store.me_update(mutate)


async def _report_clone_to_author(item: Dict[str, Any]) -> None:
    item_id = str(item.get("id") or "")
    author = item.get("author") if isinstance(item.get("author"), dict) else {}
    if not item_id or str(author.get("account_id") or "") == _account_id():
        return
    try:
        await transport.get_transport().post_event(item_id, {
            "type": "clone", "account_id": _account_id()})
    except Exception:
        pass


@router.post("/items/{item_id}/clone")
async def clone_item(item_id: str, request: Request) -> Dict[str, Any]:
    resolved = await resolve_item(item_id, for_clone=True)
    item = resolved["item"]
    if not bool(item.get("allow_clone", True)):
        raise HTTPException(status_code=403, detail="作者没有开放克隆")
    package = resolved.get("package") or {}
    payload = package.get("payload") if isinstance(package.get("payload"), dict) else {}
    if not payload:
        raise HTTPException(status_code=409, detail="作者离线，本机没有完整缓存，暂时不能克隆")
    kind = str(item.get("kind") or "canvas")
    if kind == "canvas":
        result = await _clone_canvas(item, package, payload)
    elif kind == "skill":
        result = _clone_skill(item, payload)
    else:
        result = _clone_prompt(item, payload)
    _record_clone(item, result)
    await _report_clone_to_author(item)
    result["item_id"] = item_id
    result["item"] = item
    return result


# ---------------------------------------------------------------- 点赞 / 收藏 / 举报

@router.post("/items/{item_id}/like")
async def like_item(item_id: str) -> Dict[str, Any]:
    if not store.valid_item_id(item_id):
        raise HTTPException(status_code=400, detail="作品 ID 不合法")
    me = store.load_me()
    likes = list(me.get("likes") or [])
    liked = item_id in likes
    mine = store.find_item(store.load_items(), item_id)
    if mine:
        items = store.load_items()
        target = store.find_item(items, item_id) or mine
        account = _account_id()
        liked_by = [str(value) for value in (target.get("liked_by") or [])]
        stats = dict(target.get("stats") or {})
        if liked:
            if account in liked_by:
                liked_by.remove(account)
            stats["likes"] = max(0, int(stats.get("likes") or 0) - 1)
            likes = [value for value in likes if value != item_id]
        else:
            if account not in liked_by:
                liked_by.append(account)
            stats["likes"] = int(stats.get("likes") or 0) + 1
            likes.append(item_id)
        target["liked_by"] = liked_by
        target["stats"] = stats
        target["updated_at"] = store.now_ms()
        store.save_items([store._normalize_item(entry) if str(entry.get("id")) == item_id else entry
                          for entry in items])
        store.me_update(lambda state: state.__setitem__("likes", likes))
        transport.clear_feed_cache()
        return {"liked": not liked, "stats": stats}
    resolved = await resolve_item(item_id, for_clone=True)
    item = resolved["item"]
    if not resolved["online"]:
        raise HTTPException(status_code=409, detail="作者离线，暂时不能点赞")
    event_type = "unlike" if liked else "like"
    posted = await transport.get_transport().post_event(item_id, {
        "type": event_type, "account_id": _account_id()})
    if not posted:
        raise HTTPException(status_code=502, detail="作者节点没有响应，稍后再试")
    def mutate(state: Dict[str, Any]) -> None:
        current = list(state.get("likes") or [])
        if liked:
            state["likes"] = [value for value in current if value != item_id]
        else:
            current.insert(0, item_id)
            state["likes"] = current
    store.me_update(mutate)
    stats = dict(item.get("stats") or {})
    stats["likes"] = max(0, int(stats.get("likes") or 0) + (-1 if liked else 1))
    return {"liked": not liked, "stats": stats}


@router.post("/items/{item_id}/favorite")
async def favorite_item(item_id: str) -> Dict[str, Any]:
    if not store.valid_item_id(item_id):
        raise HTTPException(status_code=400, detail="作品 ID 不合法")
    me = store.load_me()
    favorites = list(me.get("favorites") or [])
    added = item_id not in favorites
    if added:
        favorites.insert(0, item_id)
    else:
        favorites = [value for value in favorites if value != item_id]
    store.me_update(lambda state: state.__setitem__("favorites", favorites))
    return {"favorited": added, "count": len(favorites)}


@router.post("/items/{item_id}/report")
async def report_item(item_id: str, payload: ReportRequest) -> Dict[str, Any]:
    if not store.valid_item_id(item_id):
        raise HTTPException(status_code=400, detail="作品 ID 不合法")
    reason = str(payload.reason or "").strip()[:MAX_EVENT_REASON] or "其它"
    done = {"hidden": True}

    def mutate(state: Dict[str, Any]) -> None:
        reports = list(state.get("reports") or [])
        if item_id not in reports:
            reports.insert(0, item_id)
        state["reports"] = reports
    store.me_update(mutate)
    transport.clear_feed_cache()
    resolved = None
    try:
        resolved = await resolve_item(item_id, for_clone=True)
    except HTTPException:
        resolved = None
    if resolved and resolved["online"] and not resolved["mine"]:
        try:
            await transport.get_transport().post_event(item_id, {
                "type": "report", "account_id": _account_id(), "reason": reason})
        except Exception:
            pass
    done["reason"] = reason
    return done


# ---------------------------------------------------------------- 我的收藏 / 点赞 / 克隆

async def _items_by_ids(ids: List[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    data = await aggregate_items()
    by_id = {str(item.get("id")): item for item in data["items"]}
    for item_id in ids:
        item = by_id.get(str(item_id))
        if item:
            out.append(item)
    return out


@router.get("/favorites")
async def favorites(request: Request) -> Dict[str, Any]:
    _rate_read(request)
    me = store.load_me()
    return {"items": await _items_by_ids(me.get("favorites") or [])}


@router.get("/likes")
async def likes(request: Request) -> Dict[str, Any]:
    _rate_read(request)
    me = store.load_me()
    return {"items": await _items_by_ids(me.get("likes") or [])}


@router.get("/clones")
async def clones(request: Request) -> Dict[str, Any]:
    _rate_read(request)
    me = store.load_me()
    entries = me.get("clones") or []
    data = await aggregate_items()
    by_id = {str(item.get("id")): item for item in data["items"]}
    items = []
    for entry in entries:
        item_id = str(entry.get("item_id") or "")
        item = dict(by_id.get(item_id) or {})
        if not item:
            item = {
                "id": item_id, "kind": str(entry.get("kind") or ""),
                "title": str(entry.get("title") or ""), "author": dict(entry.get("author") or {}),
                "online": False, "stats": {}, "meta": {}, "tags": [],
            }
        item["clone"] = entry
        items.append(item)
    return {"items": items}


# ---------------------------------------------------------------- 设置 / 主页背景

@router.get("/settings")
async def get_settings() -> Dict[str, Any]:
    return {"visible": store.visible()}


@router.put("/settings")
async def put_settings(payload: SettingsRequest) -> Dict[str, Any]:
    if payload.visible is None:
        raise HTTPException(status_code=400, detail="缺少 visible")
    store.set_visible(bool(payload.visible))
    transport.clear_feed_cache()
    return {"visible": store.visible()}


def _profile_cover_url(profile: Dict[str, Any], public: bool = False) -> str:
    if not profile.get("cover"):
        return ""
    stamp = int(profile.get("updated_at") or 0)
    base = "/api/community/public/profile/cover" if public else "/api/community/profile-cover"
    return base + "?t=" + str(stamp)


def _profile_stats() -> Dict[str, Any]:
    items = _published_items()
    likes = sum(int((item.get("stats") or {}).get("likes") or 0) for item in items)
    clones = sum(int((item.get("stats") or {}).get("clones") or 0) for item in items)
    views = sum(int((item.get("stats") or {}).get("views") or 0) for item in items)
    try:
        from server.routes.lan_account import load_friends
        friends = len(load_friends())
    except Exception:
        friends = 0
    return {"items": len(items), "likes": likes, "clones": clones, "views": views, "friends": friends}


@router.get("/profile")
async def get_profile(request: Request) -> Dict[str, Any]:
    _rate_read(request)
    profile = store.load_profile()
    me = store.load_me()
    return {
        "profile": {
            "cover": profile.get("cover") or "",
            "cover_url": _profile_cover_url(profile),
            "focus_x": int(profile.get("focus_x") or 50),
            "focus_y": int(profile.get("focus_y") or 50),
            "default": not bool(profile.get("cover")),
        },
        "stats": _profile_stats(),
        "visible": store.visible(),
        "favorites": len(me.get("favorites") or []),
        "likes": len(me.get("likes") or []),
        "clones": len(me.get("clones") or []),
        "author": _author(),
    }


def _decode_data_url(data_url: str) -> Tuple[Optional[bytes], str]:
    text = str(data_url or "")
    match = re.match(r"^data:image/(png|jpeg|jpg|webp|gif|bmp|avif);base64,(.+)$", text, re.IGNORECASE | re.DOTALL)
    if not match:
        return None, ""
    ext = {"jpeg": ".jpg", "jpg": ".jpg", "png": ".png", "webp": ".webp", "gif": ".gif",
           "bmp": ".bmp", "avif": ".avif"}.get(match.group(1).lower(), ".png")
    try:
        raw = base64.b64decode(match.group(2), validate=False)
    except Exception:
        return None, ""
    if not raw or len(raw) > MAX_PROFILE_COVER_BYTES:
        return None, ext
    return raw, ext


@router.put("/profile")
async def put_profile(payload: ProfileRequest) -> Dict[str, Any]:
    action = str(payload.action or "").strip().lower()
    profile = store.load_profile()
    directory = store.profile_media_dir()
    if action == "reset":
        old = profile.get("cover")
        store.save_profile({"cover": "", "focus_x": 50, "focus_y": 50})
        if old:
            try:
                os.remove(os.path.join(directory, old))
            except OSError:
                pass
        return {"profile": {"cover": "", "cover_url": "", "focus_x": 50, "focus_y": 50, "default": True}}
    if action in ("focus", "position"):
        if payload.focus_x is None and payload.focus_y is None:
            raise HTTPException(status_code=400, detail="缺少焦点位置")
        profile["focus_x"] = max(0, min(100, int(payload.focus_x if payload.focus_x is not None else profile.get("focus_x") or 50)))
        profile["focus_y"] = max(0, min(100, int(payload.focus_y if payload.focus_y is not None else profile.get("focus_y") or 50)))
        saved = store.save_profile({k: profile.get(k) for k in ("cover", "focus_x", "focus_y")})
        return {"profile": {"cover": saved.get("cover") or "", "cover_url": _profile_cover_url(saved),
                            "focus_x": saved.get("focus_x"), "focus_y": saved.get("focus_y"),
                            "default": not bool(saved.get("cover"))}}
    content: Optional[bytes] = None
    ext = ".png"
    if action == "upload":
        content, ext = _decode_data_url(payload.data_url)
        if content is None:
            raise HTTPException(status_code=400, detail="图片读不出来，换一张试试")
    elif action == "asset":
        path = packager.local_path_for_url(payload.url)
        if not path:
            raise HTTPException(status_code=400, detail="素材不存在")
        try:
            with open(path, "rb") as handle:
                content = handle.read()
        except OSError as exc:
            raise HTTPException(status_code=400, detail="素材读取失败") from exc
        ext = os.path.splitext(path)[1].lower() or ".png"
    else:
        raise HTTPException(status_code=400, detail="action 只能是 upload / asset / focus / reset")
    if not content or len(content) > MAX_PROFILE_COVER_BYTES:
        raise HTTPException(status_code=413, detail="背景图太大（上限 8MB）")
    os.makedirs(directory, exist_ok=True)
    filename = "cover-%d%s" % (store.now_ms(), ext if ext in IMAGE_EXTS else ".png")
    previous = profile.get("cover")
    with open(os.path.join(directory, filename), "wb") as handle:
        handle.write(content)
    saved = store.save_profile({"cover": filename, "focus_x": profile.get("focus_x") or 50,
                                "focus_y": profile.get("focus_y") or 50})
    if previous and previous != filename:
        try:
            os.remove(os.path.join(directory, previous))
        except OSError:
            pass
    return {"profile": {"cover": saved.get("cover") or "", "cover_url": _profile_cover_url(saved),
                        "focus_x": saved.get("focus_x"), "focus_y": saved.get("focus_y"),
                        "default": False}}


@router.get("/profile-cover")
async def profile_cover(request: Request) -> FileResponse:
    profile = store.load_profile()
    name = str(profile.get("cover") or "")
    if not store.valid_file_name(name):
        raise HTTPException(status_code=404, detail="还没有设置背景图")
    path = os.path.join(store.profile_media_dir(), name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="背景图不存在")
    return _media_response(path, name)


# ---------------------------------------------------------------- 别人看主页（本机代理）

@router.get("/author/{item_id}")
async def author_page(item_id: str, request: Request) -> Dict[str, Any]:
    _rate_read(request)
    if not store.valid_item_id(item_id):
        raise HTTPException(status_code=400, detail="作品 ID 不合法")
    transport_ref = transport.get_transport()
    body = await transport_ref.author_profile(item_id)
    if body:
        profile = body.get("profile") if isinstance(body.get("profile"), dict) else {}
        items = [item for item in (body.get("items") or []) if isinstance(item, dict)]
        author = body.get("author") if isinstance(body.get("author"), dict) else {}
        for item in items:
            if isinstance(item, dict):
                transport.remember_cached_item(item)
                transport.remember_item_node(str(item.get("id") or ""), transport.node_of(item_id) or {})
        return {
            "author": author,
            "profile": {
                "cover_url": ("/api/community/author-cover?item_id=" + urllib.parse.quote(item_id))
                if profile.get("has_cover") else "",
                "focus_x": int(profile.get("focus_x") or 50),
                "focus_y": int(profile.get("focus_y") or 50),
                "default": not bool(profile.get("has_cover")),
            },
            "stats": body.get("stats") or {},
            "items": items,
            "online": True,
            "mine": False,
        }
    meta = next((item for item in transport.load_cached_items()
                 if str(item.get("id") or "") == item_id), None)
    if not meta:
        raise HTTPException(status_code=404, detail="作者离线，也没有缓存")
    author = meta.get("author") or {}
    account_id = str(author.get("account_id") or "")
    same = [item for item in transport.load_cached_items()
            if str((item.get("author") or {}).get("account_id") or "") == account_id]
    return {
        "author": author,
        "profile": {"cover_url": "", "focus_x": 50, "focus_y": 50, "default": True},
        "stats": {"items": len(same),
                  "likes": sum(int((it.get("stats") or {}).get("likes") or 0) for it in same),
                  "clones": sum(int((it.get("stats") or {}).get("clones") or 0) for it in same),
                  "views": sum(int((it.get("stats") or {}).get("views") or 0) for it in same),
                  "friends": 0},
        "items": same,
        "online": False,
        "mine": False,
    }


@router.get("/author-cover")
async def author_cover(item_id: str, request: Request) -> FileResponse:
    node = transport.node_of(item_id)
    if not node:
        raise HTTPException(status_code=404, detail="作者离线")
    status, content = await transport._fetch_bytes(
        "GET", str(node.get("base") or "") + "/api/community/public/profile/cover",
        str(node.get("token") or ""), timeout=transport.PROFILE_TIMEOUT)
    if status != 200 or not content:
        raise HTTPException(status_code=404, detail="对方没有设置背景图")
    from fastapi.responses import Response
    return Response(content=content, media_type="image/webp")


# ---------------------------------------------------------------- 公开接口（给局域网其它节点）

def lan_api_public_without_token(path: Any, method: Any = "GET") -> bool:
    """社区公开接口要能被局域网里的其它 NOVAI 直接读到（对方没有本机口令）。

    放行之后由路由自己把门：visible=false 一律 404；读接口只读发布包；
    POST 事件要 X-NOVAI-Friend-Token（对方的 UDP 广播里带着，等于确认「它是同网段的 NOVAI」）。
    """
    value = str(path or "").rstrip("/") or "/"
    verb = str(method or "GET").upper()
    if verb in ("GET", "HEAD") and value.startswith("/api/community/public/"):
        return True
    if verb == "POST" and value.startswith("/api/community/public/items/") and value.endswith("/event"):
        return True
    return False


@router.get("/public/items")
async def public_items(request: Request) -> Dict[str, Any]:
    _rate_read(request)
    _ensure_visible()
    items = [store.item_public(item, online=True) for item in _published_items()]
    items.sort(key=lambda it: int(it.get("updated_at") or 0), reverse=True)
    return {"author": _author(), "items": items}


@router.get("/public/items/{item_id}")
async def public_item(item_id: str, request: Request) -> Dict[str, Any]:
    _rate_read(request)
    _ensure_visible()
    item = store.find_item(_my_items(), item_id)
    if not item or item.get("status") != "published":
        raise HTTPException(status_code=404, detail="作品不存在")
    package = packager.read_package(item_id) or {}
    payload = package.get("payload") if isinstance(package.get("payload"), dict) else {}
    return {"item": store.item_public(item, online=True), "payload": payload,
            "package_url": "/api/community/public/items/" + item_id + "/package"}


@router.get("/public/items/{item_id}/package")
async def public_package(item_id: str, request: Request) -> Dict[str, Any]:
    _rate_read(request)
    _ensure_visible()
    item = store.find_item(_my_items(), item_id)
    if not item or item.get("status") != "published":
        raise HTTPException(status_code=404, detail="作品不存在")
    if not bool(item.get("allow_clone", True)):
        raise HTTPException(status_code=403, detail="作者没有开放克隆")
    package = packager.read_package(item_id)
    if not package:
        raise HTTPException(status_code=404, detail="发布包不存在")
    return JSONResponse(content={"package": package})


@router.get("/public/items/{item_id}/cover")
async def public_cover(item_id: str, request: Request) -> FileResponse:
    _rate_read(request)
    _ensure_visible()
    item = store.find_item(_my_items(), item_id)
    if not item or item.get("status") != "published":
        raise HTTPException(status_code=404, detail="作品不存在")
    path = _package_cover_path(item_id)
    if not path:
        raise HTTPException(status_code=404, detail="没有封面")
    return _media_response(path, "cover.webp")


@router.get("/public/media/{item_id}/{filename}")
async def public_media(item_id: str, filename: str, request: Request) -> FileResponse:
    _rate_read(request)
    _ensure_visible()
    if not store.valid_item_id(item_id):
        raise HTTPException(status_code=400, detail="作品 ID 不合法")
    if not store.valid_file_name(filename):
        raise HTTPException(status_code=400, detail="文件名不合法")
    item = store.find_item(_my_items(), item_id)
    if not item or item.get("status") != "published":
        raise HTTPException(status_code=404, detail="作品不存在")
    path = _package_media_path(item_id, filename)
    if not path:
        raise HTTPException(status_code=404, detail="文件不存在")
    return _media_response(path, filename)


@router.get("/public/profile")
async def public_profile(request: Request) -> Dict[str, Any]:
    _rate_read(request)
    _ensure_visible()
    profile = store.load_profile()
    items = [store.item_public(item, online=True) for item in _published_items()]
    return {
        "author": _author(),
        "profile": {
            "focus_x": int(profile.get("focus_x") or 50),
            "focus_y": int(profile.get("focus_y") or 50),
            "has_cover": bool(profile.get("cover")),
        },
        "stats": _profile_stats(),
        "items": items,
    }


@router.get("/public/profile/cover")
async def public_profile_cover(request: Request) -> FileResponse:
    _rate_read(request)
    _ensure_visible()
    profile = store.load_profile()
    name = str(profile.get("cover") or "")
    if not store.valid_file_name(name):
        raise HTTPException(status_code=404, detail="还没有设置背景图")
    path = os.path.join(store.profile_media_dir(), name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="背景图不存在")
    return _media_response(path, name)


def _apply_event(item: Dict[str, Any], event_type: str, account_id: str, reason: str) -> bool:
    """改写作品统计（作者节点）。返回是否有变化。"""
    stats = dict(item.get("stats") or {})
    account = _clean_account_id(account_id)
    changed = False
    if event_type == "like":
        liked_by = [str(value) for value in (item.get("liked_by") or [])]
        if account and account not in liked_by:
            liked_by.append(account)
            stats["likes"] = int(stats.get("likes") or 0) + 1
            item["liked_by"] = liked_by
            changed = True
    elif event_type == "unlike":
        liked_by = [str(value) for value in (item.get("liked_by") or [])]
        if account and account in liked_by:
            liked_by.remove(account)
            stats["likes"] = max(0, int(stats.get("likes") or 0) - 1)
            item["liked_by"] = liked_by
            changed = True
    elif event_type == "clone":
        cloned_by = [str(value) for value in (item.get("cloned_by") or [])]
        if account and account not in cloned_by:
            cloned_by.append(account)
            stats["clones"] = int(stats.get("clones") or 0) + 1
            item["cloned_by"] = cloned_by
            changed = True
    elif event_type == "view":
        if account:
            if not _seen_once("view|" + str(item.get("id")) + "|" + account):
                return False
        stats["views"] = int(stats.get("views") or 0) + 1
        changed = True
    elif event_type == "report":
        reported_by = [str(value) for value in (item.get("reported_by") or [])]
        if account and account not in reported_by:
            reported_by.append(account)
            item["reported_by"] = reported_by
            reasons = list(item.get("report_reasons") or [])
            reasons.append(str(reason or "其它")[:MAX_EVENT_REASON])
            item["report_reasons"] = reasons[-store.MAX_REPORT_REASONS:]
            stats["reports"] = int(stats.get("reports") or 0) + 1
            changed = True
    item["stats"] = stats
    return changed


@router.post("/public/items/{item_id}/event")
async def public_event(item_id: str, payload: EventRequest, request: Request,
                       x_novai_friend_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    _rate_event(request)
    _ensure_visible()
    expected = str(_account().get("token") or "")
    given = str(x_novai_friend_token or "")
    if not expected or not given or not hmac.compare_digest(given, expected):
        raise HTTPException(status_code=403, detail="事件凭据无效")
    event_type = str(payload.type or "").strip().lower()
    if event_type not in ("like", "unlike", "clone", "view", "report"):
        raise HTTPException(status_code=400, detail="事件类型不支持")
    items = store.load_items()
    item = store.find_item(items, item_id)
    if not item or item.get("status") != "published":
        raise HTTPException(status_code=404, detail="作品不存在")
    _apply_event(item, event_type, payload.account_id, payload.reason)
    store.save_items(items)
    transport.clear_feed_cache()
    return {"ok": True, "stats": dict(item.get("stats") or {})}
