#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区数据落盘（局域网版）。

目录约定（全部在 <DATA_DIR>/community/ 下，原子写，照 lan_account._write_atomic）：
    items.json              我发布的作品元数据 + 统计
    me.json                 收藏 / 点过赞的 / 克隆记录 / 屏蔽作者 / 已举报 / 局域网可见开关
    profile.json            主页背景图（文件名 + 焦点位置）
    packages/<item_id>/     package.json + cover.webp + media/
    cache/<item_id>/        别人作品的元数据 + 封面 + 打开过详情的完整包
    profile/                主页背景图本体

统计归作者节点所有：liked_by / cloned_by 记在本机 items.json 里做去重，不对外下发。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y。
"""
from __future__ import annotations

import copy
import json
import os
import re
import secrets
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional

from server.routes.deps import deps

COMMUNITY_DIR = "community"
ITEMS_FILE = "items.json"
ME_FILE = "me.json"
PROFILE_FILE = "profile.json"
PACKAGES_DIR = "packages"
CACHE_DIR = "cache"
PROFILE_DIR = "profile"
SCHEMA_VERSION = 1
KINDS = ("canvas", "skill", "prompt")
STATUSES = ("published", "unlisted")
REPORT_REASONS = ("与描述不符", "内容不适合局域网", "疑似抄袭", "包含隐私信息", "其它")
MAX_REPORT_REASONS = 20
MAX_TAGS = 8
MAX_TAG_LEN = 16
MAX_TITLE = 60
MAX_DESC = 400
MAX_ITEMS = 2000
MAX_CLONES_LOG = 500
MAX_BLOCKED = 200

# <作者账号码 6 位>-<随机 6 位>；账号码历史上出现过字母码，整体放宽到字母数字
ITEM_ID_RE = re.compile(r"^[A-Za-z0-9]{4,12}-[A-Za-z0-9]{4,12}$")
# 与 packager.media_file_name() 允许的字符集保持一致（基本汉字），否则包里写完的中文名素材自己都取不出来
FILE_RE = re.compile(r"^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5._-]{0,80}$")
CATEGORY_RE = re.compile(r"^[A-Za-z0-9\u4e00-\u9fa5 _-]{0,24}$")

_LOCK = threading.RLock()


def data_dir() -> str:
    bound = deps.get("DATA_DIR")
    if bound:
        return str(bound)
    root = os.environ.get("NOVAI_DATA_DIR") or os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(root, "data")


def now_ms() -> int:
    return int(time.time() * 1000)


def community_dir() -> str:
    return os.path.join(data_dir(), COMMUNITY_DIR)


def items_path() -> str:
    return os.path.join(community_dir(), ITEMS_FILE)


def me_path() -> str:
    return os.path.join(community_dir(), ME_FILE)


def profile_path() -> str:
    return os.path.join(community_dir(), PROFILE_FILE)


def packages_dir() -> str:
    return os.path.join(community_dir(), PACKAGES_DIR)


def cache_dir() -> str:
    return os.path.join(community_dir(), CACHE_DIR)


def profile_media_dir() -> str:
    return os.path.join(community_dir(), PROFILE_DIR)


def package_dir(item_id: str) -> str:
    clean = str(item_id or "")
    if not ITEM_ID_RE.match(clean):
        raise ValueError("作品 ID 不合法")
    return os.path.join(packages_dir(), clean)


def cache_item_dir(item_id: str) -> str:
    clean = str(item_id or "")
    if not ITEM_ID_RE.match(clean):
        raise ValueError("作品 ID 不合法")
    return os.path.join(cache_dir(), clean)


def valid_item_id(value: Any) -> bool:
    return bool(ITEM_ID_RE.match(str(value or "")))


def valid_file_name(value: Any) -> bool:
    text = str(value or "")
    return bool(FILE_RE.match(text)) and ".." not in text


def _write_atomic(path: str, data: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
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


def _read_json(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return copy.deepcopy(default)


# ---------------------------------------------------------------- 作品列表

def _new_item_id(account_code: str) -> str:
    code = re.sub(r"[^A-Za-z0-9]", "", str(account_code or ""))[:12] or "000000"
    return "%s-%s" % (code, secrets.token_hex(3))


MAX_MEDIA_REPORT_ITEMS = 100


def _normalize_media_report(raw: Any) -> Dict[str, Any]:
    """发布包的素材打包明细：白名单取值，挡掉对端塞进来的超大 items。"""
    source = raw if isinstance(raw, dict) else {}
    items: List[Dict[str, str]] = []
    for entry in source.get("items") or []:
        if not isinstance(entry, dict):
            continue
        items.append({
            "url": str(entry.get("url") or "")[:200],
            "reason": str(entry.get("reason") or "")[:120],
            "code": str(entry.get("code") or "")[:40],
            "kind": str(entry.get("kind") or "other")[:12],
        })
        if len(items) >= MAX_MEDIA_REPORT_ITEMS:
            break
    kinds = source.get("kinds") if isinstance(source.get("kinds"), dict) else {}
    codes = source.get("codes") if isinstance(source.get("codes"), dict) else {}
    return {
        "packaged": max(0, int(source.get("packaged") or 0)),
        "missing": max(0, int(source.get("missing") or 0)),
        "total": max(0, int(source.get("total") or 0)),
        "include_media": bool(source.get("include_media", True)),
        "truncated": bool(source.get("truncated", False)),
        "items": items,
        "kinds": {str(key)[:12]: max(0, int(value or 0)) for key, value in list(kinds.items())[:8]},
        "codes": {str(key)[:40]: max(0, int(value or 0)) for key, value in list(codes.items())[:16]},
    }


def _normalize_item(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    item_id = str(raw.get("id") or "")
    if not ITEM_ID_RE.match(item_id):
        return None
    kind = str(raw.get("kind") or "canvas")
    if kind not in KINDS:
        return None
    author = raw.get("author") if isinstance(raw.get("author"), dict) else {}
    stats = raw.get("stats") if isinstance(raw.get("stats"), dict) else {}
    meta = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
    tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
    reasons = raw.get("report_reasons") if isinstance(raw.get("report_reasons"), list) else []
    liked_by = raw.get("liked_by") if isinstance(raw.get("liked_by"), list) else []
    cloned_by = raw.get("cloned_by") if isinstance(raw.get("cloned_by"), list) else []
    media_report = raw.get("media_report") if isinstance(raw.get("media_report"), dict) else {}
    status = str(raw.get("status") or "published")
    if status not in STATUSES:
        status = "published"
    created = int(raw.get("created_at") or now_ms())
    return {
        "id": item_id,
        "kind": kind,
        "source_id": str(raw.get("source_id") or ""),
        "title": str(raw.get("title") or "未命名作品")[:MAX_TITLE],
        "desc": str(raw.get("desc") or "")[:MAX_DESC],
        "tags": [str(tag)[:MAX_TAG_LEN] for tag in tags if str(tag or "").strip()][:MAX_TAGS],
        "category": str(raw.get("category") or "")[:24],
        "cover": str(raw.get("cover") or ""),
        "author": {
            "account_id": str(author.get("account_id") or ""),
            "nickname": str(author.get("nickname") or "本机用户")[:40],
            "avatar": str(author.get("avatar") or "")[:200000],
        },
        "version": max(1, int(raw.get("version") or 1)),
        "created_at": created,
        "updated_at": int(raw.get("updated_at") or created),
        "package_updated_at": int(raw.get("package_updated_at") or raw.get("updated_at") or created),
        "allow_clone": bool(raw.get("allow_clone", True)),
        "include_media": bool(raw.get("include_media", True)),
        "status": status,
        "meta": {
            "nodes": int(meta.get("nodes") or 0),
            "media": int(meta.get("media") or 0),
            "size_bytes": int(meta.get("size_bytes") or 0),
        },
        # 发布时素材打包明细（packaged / missing / 缺失原因）；允许部分发布才有 missing>0
        "media_report": _normalize_media_report(media_report),
        "stats": {
            "likes": max(0, int(stats.get("likes") or 0)),
            "clones": max(0, int(stats.get("clones") or 0)),
            "views": max(0, int(stats.get("views") or 0)),
            "reports": max(0, int(stats.get("reports") or 0)),
        },
        "report_reasons": [str(reason)[:80] for reason in reasons][-MAX_REPORT_REASONS:],
        "liked_by": [str(value) for value in liked_by][-2000:],
        "cloned_by": [str(value) for value in cloned_by][-2000:],
        "reported_by": [str(value) for value in (raw.get("reported_by") or [])][-2000:],
    }


def load_items() -> List[Dict[str, Any]]:
    raw = _read_json(items_path(), None)
    items = raw.get("items") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    cleaned: List[Dict[str, Any]] = []
    for entry in items:
        item = _normalize_item(entry)
        if item:
            cleaned.append(item)
    return cleaned


def save_items(items: List[Dict[str, Any]]) -> None:
    with _LOCK:
        payload = {"version": SCHEMA_VERSION, "items": (items or [])[:MAX_ITEMS]}
        _write_atomic(items_path(), payload)


def find_item(items: List[Dict[str, Any]], item_id: str) -> Optional[Dict[str, Any]]:
    wanted = str(item_id or "")
    for item in items or []:
        if item.get("id") == wanted:
            return item
    return None


def item_public(item: Dict[str, Any], online: bool = True) -> Dict[str, Any]:
    """对外（前端 / 其它节点）字段：去掉 liked_by / cloned_by / source_id 这类本机信息。"""
    if not isinstance(item, dict):
        return {}
    out = {
        "id": str(item.get("id") or ""),
        "kind": str(item.get("kind") or "canvas"),
        "title": str(item.get("title") or ""),
        "desc": str(item.get("desc") or ""),
        "tags": list(item.get("tags") or []),
        "category": str(item.get("category") or ""),
        "cover": str(item.get("cover") or ""),
        "author": dict(item.get("author") or {}),
        "version": int(item.get("version") or 1),
        "created_at": int(item.get("created_at") or 0),
        "updated_at": int(item.get("updated_at") or 0),
        "package_updated_at": int(item.get("package_updated_at") or 0),
        "allow_clone": bool(item.get("allow_clone", True)),
        "meta": dict(item.get("meta") or {}),
        "stats": dict(item.get("stats") or {}),
        "status": str(item.get("status") or "published"),
        "report_reasons": list(item.get("report_reasons") or []),
        "online": bool(online),
    }
    return out


# ---------------------------------------------------------------- 我（收藏 / 点赞 / 克隆记录 / 屏蔽 / 开关）

def default_me() -> Dict[str, Any]:
    return {
        "version": SCHEMA_VERSION,
        "visible": False,
        "favorites": [],
        "likes": [],
        "clones": [],
        "blocked_authors": [],
        "reports": [],
    }


def load_me() -> Dict[str, Any]:
    raw = _read_json(me_path(), None)
    if not isinstance(raw, dict):
        return default_me()
    base = default_me()
    base["visible"] = bool(raw.get("visible", False))
    for key in ("favorites", "likes", "blocked_authors", "reports"):
        values = raw.get(key)
        base[key] = [str(value) for value in values] if isinstance(values, list) else []
    clones = raw.get("clones")
    base["clones"] = [entry for entry in clones if isinstance(entry, dict)][-MAX_CLONES_LOG:] if isinstance(clones, list) else []
    return base


def save_me(me: Dict[str, Any]) -> None:
    with _LOCK:
        _write_atomic(me_path(), me)


def me_update(mutator) -> Dict[str, Any]:
    """读-改-写一把锁，避免并发点赞互相覆盖。mutator(me) 直接原地改。"""
    with _LOCK:
        me = load_me()
        mutator(me)
        save_me(me)
        return me


def visible() -> bool:
    return bool(load_me().get("visible"))


def set_visible(value: bool) -> Dict[str, Any]:
    return me_update(lambda me: me.__setitem__("visible", bool(value)))


# ---------------------------------------------------------------- 主页背景

def default_profile() -> Dict[str, Any]:
    return {"version": SCHEMA_VERSION, "cover": "", "focus_x": 50, "focus_y": 50, "updated_at": 0}


def load_profile() -> Dict[str, Any]:
    raw = _read_json(profile_path(), None)
    base = default_profile()
    if not isinstance(raw, dict):
        return base
    cover = str(raw.get("cover") or "")
    base["cover"] = cover if valid_file_name(cover) else ""
    try:
        base["focus_x"] = max(0, min(100, int(raw.get("focus_x", 50))))
        base["focus_y"] = max(0, min(100, int(raw.get("focus_y", 50))))
    except (TypeError, ValueError):
        pass
    base["updated_at"] = int(raw.get("updated_at") or 0)
    return base


def save_profile(profile: Dict[str, Any]) -> Dict[str, Any]:
    base = default_profile()
    base.update({key: profile.get(key) for key in ("cover", "focus_x", "focus_y") if key in profile})
    try:
        base["focus_x"] = max(0, min(100, int(base.get("focus_x") or 50)))
        base["focus_y"] = max(0, min(100, int(base.get("focus_y") or 50)))
    except (TypeError, ValueError):
        base["focus_x"], base["focus_y"] = 50, 50
    cover = str(base.get("cover") or "")
    base["cover"] = cover if valid_file_name(cover) else ""
    base["updated_at"] = now_ms()
    with _LOCK:
        _write_atomic(profile_path(), base)
    return base
