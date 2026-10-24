#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""共享画布的素材读取授权（M5）。

背景：M2 起上传/生成落 ASSETS_DIR/users/{uid}/…，/assets/users/{uid}/… 只允许本人（admin 例外）。
协作画布（M4）里协作者会看到 owner 的图片 URL，需要额外放行：
- 请求者对该 uid 名下的某个画布有 view 权限（owner/admin/editor/viewer，复用 server.perms）；
- 且该画布文档里确实引用了这个具体路径（任意字符串字段；忽略 query/fragment）。

实现是「扫描磁盘画布 + 进程内 45s 缓存」：命中缓存直接返回，未命中才扫一次；
成员变更/画布删除最迟一个 TTL 生效。auth-off 时 middleware 根本不调用这里。
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
from typing import Any, Dict, Optional, Tuple

from server import perms

DEFAULT_TTL_SECONDS = 45.0
CACHE_MAX_ENTRIES = 4096

_canvas_dir = ""
_cache: Dict[Tuple[int, str, int], Tuple[bool, float]] = {}
_lock = threading.Lock()


def set_canvas_dir(path: str) -> None:
    global _canvas_dir
    _canvas_dir = str(path or "")


def ttl_seconds() -> float:
    try:
        value = float(os.environ.get("NOVAI_ASSET_ACL_TTL", "") or DEFAULT_TTL_SECONDS)
    except (TypeError, ValueError):
        value = DEFAULT_TTL_SECONDS
    return max(0.0, value)


def clear_cache() -> None:
    with _lock:
        _cache.clear()


def canonical_asset_path(value: Any) -> str:
    """把 URL/路径归一成 /assets/... 的路径：去 query/fragment、URL decode、绝对 URL 取 path。"""
    text = str(value or "").strip()
    if not text:
        return ""
    text = text.split("?", 1)[0].split("#", 1)[0]
    if text.startswith(("http://", "https://")):
        try:
            text = urllib.parse.urlsplit(text).path
        except ValueError:
            return ""
    return urllib.parse.unquote(text)


def _iter_strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _iter_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_strings(item)


def _canvas_references(doc: Dict[str, Any], target_path: str) -> bool:
    for text in _iter_strings(doc):
        if "/assets/" not in text and "http" not in text:
            continue
        if canonical_asset_path(text) == target_path:
            return True
    return False


def _role_for_canvas(owner_uid: int, user: Dict[str, Any], canvas_id: str, shares: Dict[str, str]) -> Optional[str]:
    if str(user.get("role")) == "admin":
        return "admin"
    if int(user.get("id")) == int(owner_uid):
        return "owner"
    return shares.get(canvas_id)


def _scan(owner_uid: int, asset_path: str, user: Dict[str, Any]) -> bool:
    if not _canvas_dir or not os.path.isdir(_canvas_dir):
        return False
    try:
        names = os.listdir(_canvas_dir)
    except OSError:
        return False
    shares = perms.shared_roles_for_user(int(user["id"]))
    target = canonical_asset_path(asset_path)
    if not target:
        return False
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(_canvas_dir, name)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except Exception:
            continue
        if not isinstance(doc, dict) or doc.get("deleted_at"):
            continue
        if doc.get("owner_id") is None:
            continue
        try:
            if int(doc["owner_id"]) != int(owner_uid):
                continue
        except (TypeError, ValueError):
            continue
        role = _role_for_canvas(owner_uid, user, str(doc.get("id") or name[:-5]), shares)
        if not perms.can(role, "view"):
            continue
        if _canvas_references(doc, target):
            return True
    return False


def can_read_asset(owner_uid: int, asset_path: str, user: Dict[str, Any]) -> bool:
    """非本人/非 admin 的素材读取判定；带 30–60s（默认 45s）进程内缓存。"""
    if not user or not asset_path:
        return False
    viewer_id = int(user.get("id") or 0)
    target = canonical_asset_path(asset_path)
    if not target:
        return False
    key = (int(owner_uid), target, viewer_id)
    now = time.monotonic()
    ttl = ttl_seconds()
    with _lock:
        cached = _cache.get(key)
        if cached is not None and cached[1] > now:
            return cached[0]

    allowed = _scan(int(owner_uid), target, user)
    expires_at = now + ttl
    with _lock:
        if len(_cache) >= CACHE_MAX_ENTRIES:
            # 简单清理：先丢过期项，仍超限就整体清空（极端情况下重新扫描即可）
            expired = [item for item, entry in _cache.items() if entry[1] <= now]
            for item in expired:
                _cache.pop(item, None)
            if len(_cache) >= CACHE_MAX_ENTRIES:
                _cache.clear()
        _cache[key] = (allowed, expires_at)
    return allowed
