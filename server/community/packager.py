#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区发布包：画布 / 技能 / 提示词。

包结构（<DATA_DIR>/community/packages/<item_id>/）：
    package.json   作品元数据 + payload（画布快照 / 技能定义 / 提示词）
    cover.webp     封面（画布才有；技能 / 提示词由前端用图标占位卡）
    media/         生成结果副本（include_media 时）

对外地址：包里所有媒体地址统一写成 /api/community/public/media/<item_id>/<file>，
别的节点拉包时自己加上作者主机前缀；本机缓存 / 克隆时换成 /api/community/media/... 或本地 uploads。

清洗：画布去掉本机绝对路径（canvas_share.sanitize_local_path）、API Key / provider 配置；
技能去掉 env / key / 本机路径，保留作者署名；提示词只留 name / category / positive / negative。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y。
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import urllib.parse
from typing import Any, Callable, Dict, List, Optional, Tuple

from server.community import store
from server.routes.canvas_share import canvas_snapshot, sanitize_local_path

MAX_PACKAGE_BYTES = 200 * 1024 * 1024
MAX_PACKAGE_JSON_BYTES = 20 * 1024 * 1024
MAX_MEDIA_FILES = 200
MAX_DATA_URL_BYTES = 4096
COVER_MAX_SIDE = 1400
COVER_QUALITY = 82
MEDIA_URL_PREFIX = "/api/community/public/media/"
MEDIA_LOCAL_PREFIX = "/api/community/media/"
MEDIA_KEYS = ("url", "originalUrl", "refUrl", "frame")
MEDIA_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif",
              ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".m4a", ".ogg")
PRIVATE_KEY_RE = re.compile(
    r"(api[_-]?key|^key$|secret|token|password|passwd|credential|base[_-]?url|provider|proxy|env$|headers?$)",
    re.IGNORECASE)
SKILL_FIELDS = ("id", "name", "category", "icon", "description", "tags", "input_schema",
                "deliverables", "skill_prompt", "usage_instruction", "platforms", "scenarios")


class PackageTooLarge(Exception):
    """单包超过上限（200MB）。"""


def _deferred(name: str, default: Any) -> Any:
    from server.routes.deps import deps
    return deps.get(name, default)


def data_dir() -> str:
    return store.data_dir()


def _output_dir() -> str:
    return str(_deferred("OUTPUT_DIR", os.path.join(data_dir(), "output")) or "")


def _assets_dir() -> str:
    return str(_deferred("ASSETS_DIR", os.path.join(data_dir(), "assets")) or "")


def local_path_for_url(url: Any) -> Optional[str]:
    """把 /output/xxx、/assets/xxx 这类站内地址映射回本机文件；解析不到返回 None。"""
    text = str(url or "").strip().split("?", 1)[0].split("#", 1)[0]
    if not text:
        return None
    text = urllib.parse.unquote(text).replace("\\", "/")
    if text.startswith("/output/"):
        root, rel = _output_dir(), text[len("/output/"):]
    elif text.startswith("/assets/"):
        root, rel = _assets_dir(), text[len("/assets/"):]
    else:
        return None
    if not root or not rel:
        return None
    root_abs = os.path.abspath(root)
    path = os.path.abspath(os.path.join(root_abs, rel.lstrip("/")))
    try:
        if os.path.commonpath([root_abs, path]) != root_abs:
            return None
    except ValueError:
        return None
    return path if os.path.isfile(path) else None


def is_media_url(value: Any) -> bool:
    text = str(value or "").strip()
    if not text or text.startswith("data:") or text.startswith("blob:"):
        return False
    if text.startswith(MEDIA_URL_PREFIX) or text.startswith(MEDIA_LOCAL_PREFIX):
        return True
    if text.startswith("/output/") or text.startswith("/assets/"):
        return True
    if text.lower().startswith(("http://", "https://")):
        return True
    return False


def media_filename_of(url: str, item_id: str = "") -> str:
    """作品的媒体地址 → 包内文件名（作者包和本机代理地址两种前缀都认）。"""
    text = str(url or "")
    for prefix in (MEDIA_URL_PREFIX + str(item_id or "") + "/",
                   MEDIA_LOCAL_PREFIX + str(item_id or "") + "/"):
        if item_id and text.startswith(prefix):
            name = text[len(prefix):]
            return name if name else ""
    for prefix in (MEDIA_URL_PREFIX, MEDIA_LOCAL_PREFIX):
        if text.startswith(prefix) and item_id:
            rest = text[len(prefix):]
            if rest.startswith(str(item_id) + "/"):
                return rest[len(item_id) + 1:]
    return media_file_name(text)


def media_file_name(url: str) -> str:
    """媒体文件在包里的名字：URL 哈希 + 干净扩展名，保证可复现且不会撞名。"""
    text = str(url or "").strip()
    parsed = urllib.parse.urlsplit(text)
    base = urllib.parse.unquote(os.path.basename(parsed.path or "")) or "media"
    stem, ext = os.path.splitext(base)
    stem = re.sub(r"[^0-9A-Za-z\u4e00-\u9fa5._-]+", "_", stem).strip("._")[:48] or "media"
    ext = ext.lower()
    if ext not in MEDIA_EXTS:
        ext = ".bin"
    digest = hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()[:10]
    return "%s-%s%s" % (stem, digest, ext)


def _walk_strings(value: Any, key: str = "", found: Optional[List[str]] = None) -> List[str]:
    if found is None:
        found = []
    if isinstance(value, dict):
        for item_key, item in value.items():
            if item_key in MEDIA_KEYS and isinstance(item, str):
                if is_media_url(item):
                    found.append(item)
            elif item_key == "variants" and isinstance(item, list):
                for entry in item:
                    if isinstance(entry, str) and is_media_url(entry):
                        found.append(entry)
            else:
                _walk_strings(item, item_key, found)
    elif isinstance(value, list):
        for entry in value:
            _walk_strings(entry, key, found)
    return found


def collect_canvas_media(payload: Dict[str, Any]) -> List[str]:
    """收集画布快照里的全部媒体地址（去重，保持出现顺序）。"""
    seen = set()
    out: List[str] = []
    for url in _walk_strings(payload):
        canonical = str(url)
        if canonical in seen:
            continue
        seen.add(canonical)
        out.append(canonical)
    return out


def _rewrite_strings(value: Any, mapping: Dict[str, str]) -> Any:
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for key, item in value.items():
            if key in MEDIA_KEYS and isinstance(item, str):
                out[key] = mapping.get(item, item)
            elif key == "variants" and isinstance(item, list):
                out[key] = [mapping.get(entry, entry) if isinstance(entry, str) else entry for entry in item]
            else:
                out[key] = _rewrite_strings(item, mapping)
        return out
    if isinstance(value, list):
        return [_rewrite_strings(item, mapping) for item in value]
    if isinstance(value, str):
        return mapping.get(value, value)
    return value


def strip_private(value: Any, key: str = "") -> Any:
    """递归去掉 API Key / provider 配置 / 超长 data URL，保留结构。"""
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for item_key, item in value.items():
            if PRIVATE_KEY_RE.search(str(item_key)):
                continue
            out[item_key] = strip_private(item, str(item_key))
        return out
    if isinstance(value, list):
        return [strip_private(item, key) for item in value]
    if isinstance(value, str):
        if value.startswith("data:") and len(value) > MAX_DATA_URL_BYTES:
            return ""
        return value
    return value


def sanitize_skill(skill: Dict[str, Any], author: Dict[str, Any]) -> Dict[str, Any]:
    """技能定义：只留可移植字段，去 env / key / 本机路径，保留作者署名。"""
    source = skill if isinstance(skill, dict) else {}
    out: Dict[str, Any] = {}
    for field in SKILL_FIELDS:
        if field not in source:
            continue
        out[field] = strip_private(copy.deepcopy(source.get(field)), field)
    out["id"] = str(out.get("id") or "").strip()
    out["name"] = str(out.get("name") or out["id"] or "技能").strip()
    out["author"] = {
        "account_id": str((author or {}).get("account_id") or ""),
        "nickname": str((author or {}).get("nickname") or ""),
    }
    # 字符串里残留的本机绝对路径一并抹掉（技能正文里偶尔贴了 /Users/xxx/...）
    def scrub(value: Any) -> Any:
        if isinstance(value, str):
            fixed = sanitize_local_path(value)
            if fixed.startswith("/output/") or fixed.startswith("/assets/"):
                return fixed
            if re.match(r"^(?:[A-Za-z]:[\\/]|/)", value):
                return ""
            return fixed
        if isinstance(value, dict):
            return {k: scrub(v) for k, v in value.items()}
        if isinstance(value, list):
            return [scrub(item) for item in value]
        return value
    return scrub(out)


def sanitize_prompt(item: Dict[str, Any]) -> Dict[str, Any]:
    source = item if isinstance(item, dict) else {}
    return {
        "name": str(source.get("name") or "提示词")[:60],
        "category": str(source.get("category") or "custom")[:40],
        "positive": str(source.get("positive") or "")[:8000],
        "negative": str(source.get("negative") or "")[:4000],
    }


def _write_cover(source_path: str, dest_path: str) -> bool:
    try:
        from PIL import Image, ImageOps
    except Exception:
        return False
    try:
        with Image.open(source_path) as image:
            image.load()
            frame = ImageOps.exif_transpose(image) if hasattr(ImageOps, "exif_transpose") else image
            frame.thumbnail((COVER_MAX_SIDE, COVER_MAX_SIDE), Image.LANCZOS)
            if frame.mode not in ("RGB", "RGBA"):
                frame = frame.convert("RGBA" if "A" in frame.getbands() else "RGB")
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            frame.save(dest_path, format="WEBP", quality=COVER_QUALITY)
        return os.path.isfile(dest_path) and os.path.getsize(dest_path) > 0
    except Exception:
        return False


def package_media_path(item_id: str, filename: str) -> str:
    return os.path.join(store.package_dir(item_id), "media", filename)


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                continue
    return total


def _clear_dir(path: str) -> None:
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path, exist_ok=True)


def _media_content_type(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    mapping = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif",
        ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
    }
    return mapping.get(ext, "application/octet-stream")


def build_package(item_id: str, kind: str, source: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
    """生成发布包并落盘，返回 package.json 的内容（含 meta）。

    画布：source 是画布 JSON；技能：source 是技能定义；提示词：source 是提示词条目。
    options: title / desc / tags / category / cover / allow_clone / include_media / author / version /
             created_at / updated_at
    """
    if kind not in store.KINDS:
        raise ValueError("kind 只能是 canvas / skill / prompt")
    dest = store.package_dir(item_id)
    media_dir = os.path.join(dest, "media")
    _clear_dir(dest)
    media_count = 0
    total_bytes = 0
    cover_written = ""

    if kind == "canvas":
        payload: Dict[str, Any] = canvas_snapshot(source if isinstance(source, dict) else {})
        payload = strip_private(payload)
        include_media = bool(options.get("include_media", True))
        urls = collect_canvas_media(payload)
        mapping: Dict[str, str] = {}
        if include_media:
            os.makedirs(media_dir, exist_ok=True)
            for url in urls[:MAX_MEDIA_FILES]:
                source_path = local_path_for_url(url)
                if not source_path:
                    continue
                filename = media_file_name(url)
                target = os.path.join(media_dir, filename)
                try:
                    if os.path.getsize(source_path) + total_bytes > MAX_PACKAGE_BYTES:
                        raise PackageTooLarge(
                            "发布包超过 200MB（%s 太大）。可以关掉「包含生成结果」只发工作流结构，"
                            "或者先删掉画布里的大视频再发布。" % os.path.basename(source_path))
                    shutil.copyfile(source_path, target)
                    total_bytes += os.path.getsize(target)
                    mapping[url] = MEDIA_URL_PREFIX + item_id + "/" + filename
                    media_count += 1
                except PackageTooLarge:
                    raise
                except OSError:
                    continue
        if mapping:
            payload = _rewrite_strings(payload, mapping)
        nodes = payload.get("nodes") if isinstance(payload.get("nodes"), list) else []
        # 封面：优先用发布弹窗选的图，其次用包里第一张图片
        cover_source = str(options.get("cover") or "")
        cover_path = local_path_for_url(cover_source) if cover_source else None
        if not cover_path:
            for url in urls:
                candidate = local_path_for_url(url)
                if candidate and os.path.splitext(candidate)[1].lower() in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif"):
                    cover_path = candidate
                    break
        if cover_path and _write_cover(cover_path, os.path.join(dest, "cover.webp")):
            cover_written = "cover.webp"
        meta = {"nodes": len(nodes), "media": media_count, "size_bytes": 0}
    elif kind == "skill":
        payload = sanitize_skill(source, options.get("author") or {})
        meta = {"nodes": 0, "media": 0, "size_bytes": 0}
    else:
        payload = sanitize_prompt(source)
        meta = {"nodes": 0, "media": 0, "size_bytes": 0}

    package = {
        "schema": store.SCHEMA_VERSION,
        "item_id": item_id,
        "kind": kind,
        "version": max(1, int(options.get("version") or 1)),
        "title": str(options.get("title") or "未命名作品")[:store.MAX_TITLE],
        "desc": str(options.get("desc") or "")[:store.MAX_DESC],
        "tags": list(options.get("tags") or [])[:store.MAX_TAGS],
        "category": str(options.get("category") or "")[:24],
        "cover": cover_written,
        "author": dict(options.get("author") or {}),
        "allow_clone": bool(options.get("allow_clone", True)),
        "include_media": bool(options.get("include_media", True)),
        "created_at": int(options.get("created_at") or store.now_ms()),
        "updated_at": int(options.get("updated_at") or store.now_ms()),
        "meta": meta,
        "payload": payload,
    }
    encoded = json.dumps(package, ensure_ascii=False)
    if len(encoded.encode("utf-8")) > MAX_PACKAGE_JSON_BYTES:
        shutil.rmtree(dest, ignore_errors=True)
        raise PackageTooLarge("发布包元数据超过 20MB，请减少画布里的内嵌图片后重试")
    # 第一次写盘先估体积（媒体文件已落盘），写完按实际目录大小回填一次
    meta["size_bytes"] = _dir_size(dest) + len(encoded.encode("utf-8"))
    package["meta"] = meta
    _write_package_json(dest, package)
    meta["size_bytes"] = _dir_size(dest)
    package["meta"] = meta
    _write_package_json(dest, package)
    return package


def _write_package_json(dest: str, package: Dict[str, Any]) -> None:
    os.makedirs(dest, exist_ok=True)
    path = os.path.join(dest, "package.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(package, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def read_package(item_id: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(store.package_dir(item_id), "package.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def read_cached_package(item_id: str) -> Optional[Dict[str, Any]]:
    path = os.path.join(store.cache_item_dir(item_id), "package.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def validate_package(package: Any, item_id: str) -> Dict[str, Any]:
    """别的节点发来的包：校验 schema / 类型 / 体积，不合法抛 ValueError。"""
    if not isinstance(package, dict):
        raise ValueError("发布包格式不对")
    if int(package.get("schema") or 0) != store.SCHEMA_VERSION:
        raise ValueError("发布包版本不支持")
    if str(package.get("item_id") or "") != item_id:
        raise ValueError("发布包与作品 ID 不匹配")
    kind = str(package.get("kind") or "")
    if kind not in store.KINDS:
        raise ValueError("发布包类型不支持")
    payload = package.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("发布包缺少内容")
    if len(json.dumps(package, ensure_ascii=False).encode("utf-8")) > MAX_PACKAGE_JSON_BYTES:
        raise ValueError("发布包超过 20MB")
    return package


def save_cached_package(item_id: str, package: Dict[str, Any],
                        media_files: Optional[Dict[str, bytes]] = None) -> str:
    """把别的节点的包落到 cache/<id>/，媒体写 media/，返回缓存目录。"""
    dest = store.cache_item_dir(item_id)
    os.makedirs(dest, exist_ok=True)
    media_dir = os.path.join(dest, "media")
    # 只清包本体和媒体，保留 meta.json（作者离线时列表要靠它）
    try:
        os.remove(os.path.join(dest, "package.json"))
    except OSError:
        pass
    shutil.rmtree(media_dir, ignore_errors=True)
    os.makedirs(media_dir, exist_ok=True)
    for name, content in (media_files or {}).items():
        if not store.valid_file_name(name):
            continue
        with open(os.path.join(media_dir, name), "wb") as handle:
            handle.write(content)
    cached = dict(package)
    payload = copy.deepcopy(package.get("payload") or {})
    if isinstance(payload, dict):
        cached["payload"] = payload
    _write_package_json(dest, cached)
    return dest
