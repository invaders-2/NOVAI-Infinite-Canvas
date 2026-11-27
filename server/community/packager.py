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

import base64
import copy
import hashlib
import json
import os
import re
import shutil
import tempfile
import urllib.parse
from typing import Any, Callable, Dict, List, Optional, Tuple

from server.community import store
from server.routes.canvas_share import canvas_snapshot, sanitize_local_path

# 视频多的画布以前被 200MB 整包上限挡在发布这一步；接收端已改成流式写盘，整包放宽到 2GB，
# 单个媒体文件 500MB（与 transport / canvas_share 的单文件下载上限一致，发得出去就拉得下来）。
MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
MAX_PACKAGE_LABEL = "2GB"
MAX_MEDIA_FILE_BYTES = 500 * 1024 * 1024
MAX_MEDIA_FILE_LABEL = "500MB"
MAX_PACKAGE_JSON_BYTES = 20 * 1024 * 1024
MAX_MEDIA_FILES = 200
MAX_DATA_URL_BYTES = 4096
# 明细只留前 100 条：一次发布最多 MAX_MEDIA_FILES 个素材，剩下的用 truncated 标记
MAX_REPORT_ITEMS = 100
MAX_REPORT_URL_CHARS = 200
REMOTE_MEDIA_TIMEOUT = 30.0
REMOTE_MEDIA_CONNECT_TIMEOUT = 10.0
COVER_MAX_SIDE = 1400
COVER_QUALITY = 82
MEDIA_URL_PREFIX = "/api/community/public/media/"
MEDIA_LOCAL_PREFIX = "/api/community/media/"
# 画布节点真实会存媒体的字段（口径来自 novai-canvas-ui）：
#   CanvasNode.url / originalUrl / refUrl / variants
#   data.gen.hist[].url / frame（视频封面）/ meta.selfSrc（当参考图发出去的那张源图）
#   timeline clips[].url / thumb（时间线片段与缩略图）
#   scene.objects[].url、旧画布 generatedOutputs[].url / poster / thumbnail
# 漏一个就是「画布里有图，但发布时收集不到、别人打开是空白」。
MEDIA_KEYS = ("url", "originalUrl", "refUrl", "frame", "thumb", "poster", "thumbnail",
              "posterUrl", "thumbUrl", "selfSrc", "cover")
MEDIA_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif",
              ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".wav", ".m4a", ".aac", ".ogg")
MEDIA_KIND_BY_EXT = {
    ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
    ".bmp": "image", ".avif": "image",
    ".mp4": "video", ".webm": "video", ".mov": "video", ".m4v": "video",
    ".mp3": "audio", ".wav": "audio", ".m4a": "audio", ".aac": "audio", ".ogg": "audio",
}
# 能拿来当封面的源文件扩展名（与 community.IMAGE_EXTS 同口径；.bin 这种猜不出类型的素材不当封面）
COVER_SOURCE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif")
MEDIA_KIND_LABEL = {"image": "图片", "video": "视频", "audio": "音频", "other": "其它素材"}
MEDIA_KIND_UNIT = {"image": "张", "video": "段", "audio": "段", "other": "个"}
# data: URL 只认这几种（不给 svg 等可执行/可外链的类型开口子）
DATA_MEDIA_EXTS = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/bmp": ".bmp", "image/avif": ".avif",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/x-m4v": ".m4v",
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
    "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg",
}
PRIVATE_KEY_RE = re.compile(
    r"(api[_-]?key|^key$|secret|token|password|passwd|credential|base[_-]?url|provider|proxy|env$|headers?$)",
    re.IGNORECASE)
SKILL_FIELDS = ("id", "name", "category", "icon", "description", "tags", "input_schema",
                "deliverables", "skill_prompt", "usage_instruction", "platforms", "scenarios")


class PackageTooLarge(Exception):
    """单包超过上限（MAX_PACKAGE_LABEL）或单个媒体超过 MAX_MEDIA_FILE_LABEL。"""


class MediaIncomplete(Exception):
    """有媒体引用没能打进包，而且调用方没有显式允许部分发布（路由转 422）。

    detail 是给用户看的中文说明；report 是结构化明细（同 package["media"]）。
    """

    def __init__(self, report: Dict[str, Any]) -> None:
        self.report = report
        self.missing = int(report.get("missing") or 0)
        self.packaged = int(report.get("packaged") or 0)
        self.detail = media_incomplete_detail(report)
        super().__init__(self.detail)


def _deferred(name: str, default: Any) -> Any:
    from server.routes.deps import deps
    return deps.get(name, default)


def data_dir() -> str:
    return store.data_dir()


def _output_dir() -> str:
    return str(_deferred("OUTPUT_DIR", os.path.join(data_dir(), "output")) or "")


def _assets_dir() -> str:
    return str(_deferred("ASSETS_DIR", os.path.join(data_dir(), "assets")) or "")


def community_media_ref(url: Any) -> Optional[Tuple[str, str]]:
    """作品的媒体地址 → (item_id, 文件名)；不是就返回 None（作者包和本机代理两种前缀都认）。"""
    text = str(url or "").strip()
    for prefix in (MEDIA_URL_PREFIX, MEDIA_LOCAL_PREFIX):
        if not text.startswith(prefix):
            continue
        rest = text[len(prefix):].split("?", 1)[0].split("#", 1)[0]
        if "/" not in rest:
            return None
        item_id, name = rest.split("/", 1)
        name = urllib.parse.unquote(name)
        if store.valid_item_id(item_id) and store.valid_file_name(name):
            return item_id, name
        return None
    return None


def _community_media_local_path(ref_item_id: str, name: str) -> Optional[str]:
    """自己作品的素材在 packages/<id>/media，别人作品的在本机缓存 cache/<id>/media。"""
    for directory in (store.package_dir(ref_item_id), store.cache_item_dir(ref_item_id)):
        path = os.path.join(directory, "media", name)
        if os.path.isfile(path):
            return path
    return None


def local_path_for_url(url: Any) -> Optional[str]:
    """把站内地址映射回本机文件：/output/xxx、/assets/xxx、/api/community/media/<id>/<file>。
    解析不到返回 None。"""
    text = str(url or "").strip().split("?", 1)[0].split("#", 1)[0]
    if not text:
        return None
    text = urllib.parse.unquote(text).replace("\\", "/")
    ref = community_media_ref(text)
    if ref:
        return _community_media_local_path(ref[0], ref[1])
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


def data_media_info(url: Any) -> Dict[str, Any]:
    """data: URL 的声明信息（不解码）：{kind, ext, mime, error}。"""
    text = str(url or "").strip()
    result: Dict[str, Any] = {"kind": "other", "ext": "", "mime": "", "error": ""}
    if not text.lower().startswith("data:"):
        result["error"] = "不是 data: 地址"
        return result
    head, sep, _payload = text[5:].partition(",")
    if not sep:
        result["error"] = "data: 地址不完整"
        return result
    parts = [part.strip().lower() for part in head.split(";") if part.strip()]
    mime = parts[0] if parts else ""
    result["mime"] = mime
    kind = mime.split("/", 1)[0] if "/" in mime else ""
    if kind not in ("image", "video", "audio"):
        result["error"] = "内嵌 data: 地址不是图片 / 视频 / 音频"
        return result
    result["kind"] = kind
    if "base64" not in parts[1:]:
        result["error"] = "内嵌 data: 地址不是 base64 编码"
        return result
    ext = DATA_MEDIA_EXTS.get(mime, "")
    if not ext:
        result["error"] = "不支持的内嵌素材类型（%s）" % mime
        return result
    result["ext"] = ext
    return result


def media_kind_of(url: Any) -> str:
    """媒体种类：image / video / audio / other（按 data: 声明或扩展名判断）。"""
    text = str(url or "").strip()
    if not text:
        return "other"
    if text.lower().startswith("data:"):
        return str(data_media_info(text).get("kind") or "other")
    path = urllib.parse.urlsplit(text).path or ""
    return MEDIA_KIND_BY_EXT.get(os.path.splitext(path)[1].lower(), "other")


def display_media_url(url: Any) -> str:
    """明细里给人看的地址：截断 + 抹掉作者机器上的完整路径（包里 / 接口里不该泄本机路径）。"""
    text = str(url or "")
    if not text:
        return ""
    lowered = text[:24].lower()
    if lowered.startswith("data:"):
        info = data_media_info(text)
        size = len(text) * 3 // 4
        return "data:%s…（约 %.1fMB）" % (info.get("mime") or "未知类型", size / (1024.0 * 1024.0))
    if lowered.startswith("blob:"):
        return text[:64]
    if re.match(r"^(?:[A-Za-z]:[\\/]|/)", text) and not text.startswith("/output/") \
            and not text.startswith("/assets/") and not text.startswith(MEDIA_URL_PREFIX) \
            and not text.startswith(MEDIA_LOCAL_PREFIX):
        name = text.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
        return "…/" + (name or "文件")
    if len(text) > MAX_REPORT_URL_CHARS:
        return text[:MAX_REPORT_URL_CHARS - 1] + "…"
    return text


def media_plan(url: Any) -> Dict[str, Any]:
    """一个媒体引用能不能打进包：{type, code, reason, kind}。

    type = local（站内文件）/ remote（http 下载）/ data（内嵌解码）/ unsupported；
    code 为空 = 能打包，否则是原因码（明细里按它分类）。
    """
    text = str(url or "").strip()
    kind = media_kind_of(text)
    if not text:
        return {"type": "unsupported", "code": "empty", "reason": "空地址", "kind": kind}
    lowered = text[:12].lower()
    if lowered.startswith("data:"):
        info = data_media_info(text)
        if info.get("error"):
            return {"type": "unsupported", "code": "unsupported_data",
                    "reason": str(info["error"]), "kind": kind}
        return {"type": "data", "code": "", "reason": "", "kind": kind}
    if lowered.startswith("blob:"):
        return {"type": "unsupported", "code": "blob", "kind": kind,
                "reason": "blob: 地址只在本机浏览器里有效，换个设备打不开"}
    if lowered.startswith(("http://", "https://")):
        return {"type": "remote", "code": "", "reason": "", "kind": kind}
    if community_media_ref(text) or text.startswith("/output/") or text.startswith("/assets/"):
        if local_path_for_url(text):
            return {"type": "local", "code": "", "reason": "", "kind": kind}
        return {"type": "unsupported", "code": "file_missing", "kind": kind,
                "reason": "本机找不到这个素材文件（可能已经删了）"}
    if text.startswith("/"):
        return {"type": "unsupported", "code": "outside_mount", "kind": kind,
                "reason": "素材不在 /output、/assets 等对外目录里"}
    return {"type": "unsupported", "code": "relative", "kind": kind,
            "reason": "相对路径定位不到本机文件"}


_MEDIA_EXT_RE = re.compile(
    r"\.(?:png|jpe?g|webp|gif|bmp|avif|svg|mp4|webm|mov|m4v|mp3|wav|m4a|aac|ogg)(?:[?#].*)?$",
    re.IGNORECASE)


def _looks_like_media_path(text: str) -> bool:
    """没协议、不在挂载点里的地址：带媒体扩展名且不是一句话才算引用。

    与 novai-canvas-ui 的 isMediaLine 同一个判断（表格单元格 / 老数据里可能就存了一串路径），
    「把 a.jpg 换成 b.png」这种带空格的说明文字不能当素材。
    """
    if not text or re.search(r"\s", text):
        return False
    clean = text.split("?", 1)[0].split("#", 1)[0]
    return bool(_MEDIA_EXT_RE.search(clean))


def is_media_url(value: Any) -> bool:
    """收集口径：这串东西是不是一个「媒体引用」（能不能真打进包另看 media_plan）。

    这里故意收得宽：data:/blob:/挂载点外的绝对路径 / 相对路径 都算引用——它们打不进包时要
    记成 missing 让作者看见（原来的实现直接当非媒体丢掉，于是画布 168 个节点发出去全空白）。
    """
    text = str(value or "").strip()
    if not text:
        return False
    lowered = text[:16].lower()
    if lowered.startswith("data:") or lowered.startswith("blob:"):
        return True
    if lowered.startswith(("http://", "https://")):
        return True
    if text.startswith(MEDIA_URL_PREFIX) or text.startswith(MEDIA_LOCAL_PREFIX):
        return True
    if text.startswith("/output/") or text.startswith("/assets/"):
        return True
    return _looks_like_media_path(text)


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


# 克隆 / 分享克隆写进去的「素材缺失」提示：既是给人看的，也不是能渲染的引用。
# 收集与改写都要跳过这棵子树，否则重新发布时又把这些死链当素材找一遍。
SKIP_SUBTREE_KEYS = ("mediaMissing",)


def _is_media_slot(key: str) -> bool:
    """这个字段名是不是「放媒体的地方」（variants 是地址数组，其余是单个地址）。"""
    return key in MEDIA_KEYS or key == "variants"


def _is_media_ref(key: str, text: Any) -> bool:
    if not isinstance(text, str):
        return False
    if _is_media_slot(key):
        return is_media_url(text)
    # 字段名认不出来也收：社区自己的媒体地址（/api/community/…/media/<id>/<file>）不看字段名，
    # 克隆来的画布、表格单元格里可能只存了一串地址，漏掉就等于一个死链留在包里。
    return community_media_ref(text) is not None


def _walk_strings(value: Any, key: str = "", found: Optional[List[str]] = None) -> List[str]:
    if found is None:
        found = []
    if isinstance(value, dict):
        for item_key, item in value.items():
            if item_key in SKIP_SUBTREE_KEYS:
                continue
            if isinstance(item, str):
                if _is_media_ref(str(item_key), item):
                    found.append(item)
            else:
                _walk_strings(item, str(item_key), found)
    elif isinstance(value, list):
        for entry in value:
            if isinstance(entry, str):
                if _is_media_ref(key, entry):
                    found.append(entry)
            else:
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
    """按地址替换字符串（不看字段名：收集口径是 key + 社区媒体地址兜底，改写必须一致）。"""
    if isinstance(value, dict):
        return {key: (item if key in SKIP_SUBTREE_KEYS else _rewrite_strings(item, mapping))
                for key, item in value.items()}
    if isinstance(value, list):
        return [_rewrite_strings(item, mapping) for item in value]
    if isinstance(value, str):
        return mapping.get(value, value)
    return value


def strip_private(value: Any, key: str = "", keep_media_data: bool = False) -> Any:
    """递归去掉 API Key / provider 配置 / 超长 data URL，保留结构。

    keep_media_data=True 时，媒体字段里的 data: URL 原样留着（发布时解码进包、换成包内地址）；
    非媒体字段的超长 data: 仍然清空（提示词、日志里贴的大段 base64 没理由进包）。
    """
    if isinstance(value, dict):
        out: Dict[str, Any] = {}
        for item_key, item in value.items():
            if PRIVATE_KEY_RE.search(str(item_key)):
                continue
            out[item_key] = strip_private(item, str(item_key), keep_media_data)
        return out
    if isinstance(value, list):
        return [strip_private(item, key, keep_media_data) for item in value]
    if isinstance(value, str):
        if value.startswith("data:") and len(value) > MAX_DATA_URL_BYTES:
            if keep_media_data and _is_media_slot(key) and not data_media_info(value).get("error"):
                return value
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
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac",
        ".ogg": "audio/ogg",
    }
    return mapping.get(ext, "application/octet-stream")


def _remove_quiet(path: str) -> None:
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def _ensure_package_room(file_size: int, total_bytes: int, label: str) -> None:
    """单个素材 / 累计总量超限一律抛 PackageTooLarge（沿用原来 413 的口径，不静默丢）。"""
    if file_size > MAX_MEDIA_FILE_BYTES:
        raise PackageTooLarge(
            "单个素材超过 %s（%s 太大）。可以关掉「包含生成结果」只发工作流结构，"
            "或者先压缩 / 删掉这个大视频再发布。" % (MAX_MEDIA_FILE_LABEL, label))
    if file_size + total_bytes > MAX_PACKAGE_BYTES:
        raise PackageTooLarge(
            "发布包超过 %s（加上 %s 后超了）。可以关掉「包含生成结果」只发工作流结构，"
            "或者先删掉画布里的大视频再发布。" % (MAX_PACKAGE_LABEL, label))


_IMAGE_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"BM", ".bmp"),
)


def _ext_from_bytes(head: bytes) -> str:
    """远端素材没有扩展名时，按文件头猜一个（否则 /public/media 会以 octet-stream 下发）。"""
    if not head:
        return ""
    for magic, ext in _IMAGE_MAGIC:
        if head.startswith(magic):
            return ext
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return ".wav"
    if head[:4] == b"OggS":
        return ".ogg"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return ".webm"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        return ".mov" if brand in (b"qt  ",) else ".mp4"
    if head[:3] == b"ID3":
        return ".mp3"
    if head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return ".mp3"
    return ""


def _fetch_remote_media(url: str, dest_path: str, max_bytes: int) -> str:
    """把 http(s) 素材流式写到 dest_path，返回错误说明（空串 = 成功）；超限抛 PackageTooLarge。

    测试 / 特殊传输可以用 deps 注入 COMMUNITY_REMOTE_FETCH(url, dest_path, max_bytes)，
    约定同样：返回错误说明，成功写盘返回空串。
    """
    hook = _deferred("COMMUNITY_REMOTE_FETCH", None)
    if callable(hook):
        result = hook(url, dest_path, max_bytes)
        return str(result or "")
    try:
        import httpx
    except Exception:
        return "服务端缺少 httpx，下载不了远程素材"
    timeout = httpx.Timeout(REMOTE_MEDIA_TIMEOUT, connect=REMOTE_MEDIA_CONNECT_TIMEOUT)
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            with client.stream("GET", url, headers={"Accept": "*/*"}) as response:
                if response.status_code != 200:
                    return "远端返回 HTTP %d" % int(response.status_code)
                try:
                    declared = int(response.headers.get("content-length") or 0)
                except (TypeError, ValueError):
                    declared = 0
                if declared > max_bytes:
                    raise PackageTooLarge(
                        "单个素材超过 %s（远程素材太大）。可以关掉「包含生成结果」只发工作流结构。"
                        % MAX_MEDIA_FILE_LABEL)
                received = 0
                with open(dest_path, "wb") as handle:
                    for chunk in response.iter_bytes(256 * 1024):
                        if not chunk:
                            continue
                        received += len(chunk)
                        if received > max_bytes:
                            raise PackageTooLarge(
                                "单个素材超过 %s（远程素材太大）。可以关掉「包含生成结果」只发工作流结构。"
                                % MAX_MEDIA_FILE_LABEL)
                        handle.write(chunk)
    except PackageTooLarge:
        _remove_quiet(dest_path)
        raise
    except Exception as exc:
        _remove_quiet(dest_path)
        return "下载失败：%s" % (str(exc) or exc.__class__.__name__)
    if not os.path.isfile(dest_path) or os.path.getsize(dest_path) <= 0:
        _remove_quiet(dest_path)
        return "远端素材是空的"
    return ""


def _decode_data_bytes(url: str, max_bytes: int) -> bytes:
    """解码 data: URL（只认 DATA_MEDIA_EXTS 里的类型）。超限抛 PackageTooLarge。"""
    info = data_media_info(url)
    if info.get("error"):
        raise ValueError(str(info["error"]))
    _head, _sep, payload = url[5:].partition(",")
    payload = "".join(payload.split())
    estimated = (len(payload) * 3) // 4
    _ensure_package_room(estimated, 0, "内嵌素材 约%.1fMB" % (estimated / (1024.0 * 1024.0)))
    try:
        raw = base64.b64decode(payload, validate=False)
    except Exception as exc:
        raise ValueError("base64 解不开") from exc
    if not raw:
        raise ValueError("解出来是空文件")
    if len(raw) > max_bytes:
        _ensure_package_room(len(raw), 0, "内嵌素材 %.1fMB" % (len(raw) / (1024.0 * 1024.0)))
    return raw


def _sniff_media_name(target: str, filename: str) -> str:
    """下载 / 解码出来的文件扩展名不确定时按文件头补一个，返回最终文件名。"""
    if not filename.endswith(".bin"):
        return filename
    try:
        with open(target, "rb") as handle:
            head = handle.read(16)
    except OSError:
        return filename
    ext = _ext_from_bytes(head)
    if not ext:
        return filename
    better = filename[:-4] + ext
    if not store.valid_file_name(better):
        return filename
    try:
        os.replace(target, os.path.join(os.path.dirname(target), better))
    except OSError:
        return filename
    return better


def _collect_media_into_package(item_id: str, media_dir: str, urls: List[str]) -> Tuple[
        Dict[str, str], List[Dict[str, Any]], int, Dict[str, str]]:
    """把能打包的引用落进 media/。

    返回 (地址改写映射, 缺失明细, 落盘文件数, 原始引用 → 落盘文件路径)。
    最后那项给封面用：远程 / data: 素材在 staging 里已经有真文件，但此时
    /api/community/public/media/<item_id>/<file> 还没 promote 到最终包目录，解析不出路径。
    四类引用：站内文件（/output、/assets、社区媒体）/ http(s) 下载 / data: 解码 / 其它记缺失。
    单个或累计超限抛 PackageTooLarge；其余失败记原因（code + 中文 reason），不静默丢。
    """
    mapping: Dict[str, str] = {}
    missing: List[Dict[str, Any]] = []
    written: set = set()
    local_files: Dict[str, str] = {}
    total_bytes = 0

    def fail(url: str, code: str, reason: str) -> None:
        missing.append({"url": display_media_url(url), "raw": url, "code": code,
                        "reason": reason, "kind": media_kind_of(url)})

    for index, url in enumerate(urls):
        if index >= MAX_MEDIA_FILES:
            fail(url, "too_many", "单次发布最多打包 %d 个素材" % MAX_MEDIA_FILES)
            continue
        plan = media_plan(url)
        if plan["code"]:
            fail(url, str(plan["code"]), str(plan["reason"] or "打不进包"))
            continue
        filename = ""
        file_size = 0
        try:
            if plan["type"] == "local":
                source_path = local_path_for_url(url)
                if not source_path:
                    fail(url, "file_missing", "本机找不到这个素材文件（可能已经删了）")
                    continue
                file_size = os.path.getsize(source_path)
                _ensure_package_room(file_size, total_bytes, os.path.basename(source_path))
                filename = media_file_name(url)
                target = os.path.join(media_dir, filename)
                try:
                    shutil.copyfile(source_path, target)
                except OSError:
                    # 复制到一半失败：清掉半截文件，别让一个没人引用的残文件占体积
                    _remove_quiet(target)
                    raise
                file_size = os.path.getsize(target)
            elif plan["type"] == "data":
                info = data_media_info(url)
                raw = _decode_data_bytes(url, MAX_MEDIA_FILE_BYTES)
                file_size = len(raw)
                _ensure_package_room(file_size, total_bytes,
                                     "内嵌素材 %.1fMB" % (file_size / (1024.0 * 1024.0)))
                filename = "data-%s%s" % (
                    hashlib.sha1(url.encode("utf-8", "ignore")).hexdigest()[:10],
                    str(info.get("ext") or ".bin"))
                with open(os.path.join(media_dir, filename), "wb") as handle:
                    handle.write(raw)
            else:
                filename = media_file_name(url)
                target = os.path.join(media_dir, filename)
                error = _fetch_remote_media(url, target, MAX_MEDIA_FILE_BYTES)
                if error:
                    fail(url, "remote_failed", error)
                    continue
                file_size = os.path.getsize(target)
                _ensure_package_room(file_size, total_bytes, os.path.basename(target))
                filename = _sniff_media_name(target, filename)
                file_size = os.path.getsize(os.path.join(media_dir, filename))
        except PackageTooLarge:
            raise
        except ValueError as exc:
            fail(url, "data_decode", "内嵌素材解码失败：%s" % (str(exc) or "格式不对"))
            continue
        except OSError:
            fail(url, "write_failed", "读取或写入素材失败")
            continue
        total_bytes += file_size
        written.add(filename)
        local_files[url] = os.path.join(media_dir, filename)
        mapping[url] = MEDIA_URL_PREFIX + item_id + "/" + filename
    return mapping, missing, len(written), local_files


def _media_report(mapping: Dict[str, str], missing: List[Dict[str, Any]],
                  include_media: bool) -> Dict[str, Any]:
    """打包结果明细：packaged / missing 按引用计数，kinds / codes 按原因分类。"""
    kinds: Dict[str, int] = {}
    codes: Dict[str, int] = {}
    for entry in missing:
        kind = str(entry.get("kind") or "other")
        kinds[kind] = kinds.get(kind, 0) + 1
        code = str(entry.get("code") or "unknown")
        codes[code] = codes.get(code, 0) + 1
    items = [{"url": str(entry.get("url") or ""), "reason": str(entry.get("reason") or ""),
              "code": str(entry.get("code") or ""), "kind": str(entry.get("kind") or "other")}
             for entry in missing[:MAX_REPORT_ITEMS]]
    packaged = len(mapping)
    return {
        "packaged": packaged,
        "missing": len(missing),
        "total": packaged + len(missing),
        "include_media": bool(include_media),
        "truncated": len(missing) > MAX_REPORT_ITEMS,
        "items": items,
        "kinds": kinds,
        "codes": codes,
    }


def media_incomplete_detail(report: Dict[str, Any]) -> str:
    """422 的中文说明：多少张图 / 多少段视频没进包 + 两条出路（给前端直接展示）。"""
    kinds = report.get("kinds") if isinstance(report.get("kinds"), dict) else {}
    parts: List[str] = []
    for kind in ("image", "video", "audio", "other"):
        count = int(kinds.get(kind) or 0)
        if count:
            parts.append("%d %s%s" % (count, MEDIA_KIND_UNIT.get(kind, "个"),
                                     MEDIA_KIND_LABEL.get(kind, "素材")))
    missing = int(report.get("missing") or 0)
    listed = "、".join(parts) if parts else "%d 个素材" % missing
    return ("这次发布有 %d 个素材没能打进发布包（%s）。"
            "可以选择「不含素材发布」只发工作流结构，或者选择「仍然发布」带缺失素材发布"
            "（别人打开会缺少这些素材）。" % (missing, listed))


def build_package(item_id: str, kind: str, source: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
    """生成发布包并落盘，返回 package.json 的内容（含 meta）。

    画布：source 是画布 JSON；技能：source 是技能定义；提示词：source 是提示词条目。
    options: title / desc / tags / category / cover / allow_clone / include_media / allow_partial /
             author / version / created_at / updated_at

    include_media=True 时：站内文件直接复制、http(s) 下载、data: 解码，四类引用都真正落进
    media/ 并改写成 /api/community/public/media/<item_id>/<file>；打不进包的记进 media 明细。
    allow_partial=False（默认）&& 有缺失 → 抛 MediaIncomplete（路由转 422）；
    allow_partial=True → 缺失引用清空，明细落进 package["media"] 与 item.media_report。

    先在 packages/ 下的临时目录里建包，成功才换上去：中途抛错（超限 / 素材不全）不会把
    重新发布时上一版还好好的包清空。
    """
    if kind not in store.KINDS:
        raise ValueError("kind 只能是 canvas / skill / prompt")
    final_dest = store.package_dir(item_id)
    staging = _staging_dir(final_dest, item_id)
    try:
        package = _build_package_into(staging, item_id, kind, source, options)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    _promote_package(staging, final_dest)
    return package


def _staging_dir(final_dest: str, item_id: str) -> str:
    parent = os.path.dirname(final_dest)
    os.makedirs(parent, exist_ok=True)
    return tempfile.mkdtemp(prefix=".build-%s-" % item_id, dir=parent)


def _promote_package(staging: str, final_dest: str) -> None:
    if os.path.isdir(final_dest):
        shutil.rmtree(final_dest, ignore_errors=True)
    os.replace(staging, final_dest)


def _build_package_into(dest: str, item_id: str, kind: str,
                        source: Dict[str, Any], options: Dict[str, Any]) -> Dict[str, Any]:
    media_dir = os.path.join(dest, "media")
    _clear_dir(dest)
    media_count = 0
    media_report: Dict[str, Any] = {"packaged": 0, "missing": 0, "total": 0,
                                    "include_media": bool(options.get("include_media", True)),
                                    "truncated": False, "items": [], "kinds": {}, "codes": {}}
    cover_written = ""

    if kind == "canvas":
        include_media = bool(options.get("include_media", True))
        allow_partial = bool(options.get("allow_partial", False))
        payload: Dict[str, Any] = canvas_snapshot(source if isinstance(source, dict) else {})
        # include_media=False 时仍然清掉超长 data: URL：只发工作流结构还带着几十 MB base64，
        # package.json 会直接撞 20MB 上限，等于连结构都发不出去。
        payload = strip_private(payload, "", keep_media_data=include_media)
        urls = collect_canvas_media(payload)
        # 原始引用 → staging 里的落盘文件（封面候选要用：远程 / data: 素材只有这里有真文件）
        local_files: Dict[str, str] = {}
        if not include_media:
            media_report = _media_report({}, [], False)
            media_report["total"] = len(urls)
        elif urls:
            os.makedirs(media_dir, exist_ok=True)
            mapping, missing, media_count, local_files = _collect_media_into_package(
                item_id, media_dir, urls)
            if mapping:
                payload = _rewrite_strings(payload, mapping)
            # 一致性校验：改写完仍然不在包前缀下的引用，一律算缺失（改写口径漏了会在这里暴露）
            prefix = MEDIA_URL_PREFIX + item_id + "/"
            known = set(str(entry.get("raw") or "") for entry in missing)
            for url in collect_canvas_media(payload):
                if url.startswith(prefix) or url in known:
                    continue
                known.add(url)
                missing.append({"url": display_media_url(url), "raw": url, "code": "not_packaged",
                                "reason": "发布包里没有这个素材", "kind": media_kind_of(url)})
            media_report = _media_report(mapping, missing, True)
            if missing:
                if not allow_partial:
                    raise MediaIncomplete(media_report)
                # 部分发布：打不进包的引用一律清空，绝不把作者机器上的死链发给别人
                payload = _rewrite_strings(payload, {entry["raw"]: "" for entry in missing})
        else:
            media_report = _media_report({}, [], True)
        nodes = payload.get("nodes") if isinstance(payload.get("nodes"), list) else []
        # 封面：优先用发布弹窗选的图，其次用画布里第一张图片
        # 两条路都试：站内原始地址直接解析；远程 / data: / 已打包的素材用 staging 里的落盘文件
        # （此时 /api/community/public/media/<id>/<file> 还没 promote，按包内地址解析不出来）
        cover_source = str(options.get("cover") or "")
        cover_path = (local_path_for_url(cover_source) or local_files.get(cover_source)) if cover_source else None
        if not cover_path:
            for url in urls:
                candidate = local_path_for_url(url) or local_files.get(url)
                if candidate and os.path.splitext(candidate)[1].lower() in COVER_SOURCE_EXTS:
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
        "media": media_report,
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
