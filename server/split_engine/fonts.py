from __future__ import annotations

"""本地字体识别。

拆分出来的文字层如果只写 "Inter"，用户一改字就会跟原稿完全不同形——
原稿用的多半是本机已经装好的字体。这里枚举本机字体，把 OCR 出来的
文字按字形跟每个候选字体渲染结果比对，挑最像的那一个，写进图层 style。

全程离线：只用 Pillow 渲染，不需要联网，也不依赖字体名先验。
"""

import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import config
from . import text as text_util

CACHE_FILENAME = "split-font-index.json"
CACHE_VERSION = 1
CACHE_TTL_SECONDS = 7 * 24 * 3600

_FACE_EXTS = (".ttf", ".otf", ".ttc", ".otc")
_MAX_TTC_FACES = 12
_SHORTLIST = 14
CANVAS_HEIGHT = 48
CANVAS_MAX_WIDTH = 360

_LOCK = threading.Lock()
_FACES: list["Face"] | None = None
_MATCH_CACHE: dict[tuple, tuple[str, float] | None] = {}
_COVER_CACHE: dict[tuple[str, int, str], bool] = {}


@dataclass
class Face:
    family: str
    style: str
    path: str
    index: int
    weight: int
    italic: bool


def _font_dirs() -> list[str]:
    dirs: list[str] = []
    if sys.platform == "darwin":
        dirs = [
            "/System/Library/Fonts",
            "/System/Library/Fonts/Supplemental",
            "/Library/Fonts",
            os.path.expanduser("~/Library/Fonts"),
        ]
    elif os.name == "nt":
        windir = os.environ.get("WINDIR") or r"C:\Windows"
        dirs = [
            os.path.join(windir, "Fonts"),
            os.path.expanduser(r"~\AppData\Local\Microsoft\Windows\Fonts"),
        ]
    else:
        dirs = [
            "/usr/share/fonts",
            "/usr/local/share/fonts",
            os.path.expanduser("~/.fonts"),
            os.path.expanduser("~/.local/share/fonts"),
        ]
    return [path for path in dirs if os.path.isdir(path)]


def _weight_of(style: str) -> int:
    value = str(style or "").lower()
    if "thin" in value or "hairline" in value:
        return 100
    if "extralight" in value or "ultralight" in value:
        return 200
    if "light" in value:
        return 300
    if "medium" in value:
        return 500
    if "semibold" in value or "demibold" in value:
        return 600
    if "extrabold" in value or "ultrabold" in value:
        return 800
    if "black" in value or "heavy" in value:
        return 900
    if "bold" in value:
        return 700
    return 400


def _scan_faces() -> list[Face]:
    faces: list[Face] = []
    for root in _font_dirs():
        for dirpath, _dirnames, filenames in os.walk(root):
            for filename in filenames:
                if not filename.lower().endswith(_FACE_EXTS):
                    continue
                path = os.path.join(dirpath, filename)
                limit = _MAX_TTC_FACES if filename.lower().endswith((".ttc", ".otc")) else 1
                for index in range(limit):
                    try:
                        font = ImageFont.truetype(path, 18, index=index)
                        family, style = font.getname()
                    except Exception:  # noqa: BLE001 - 坏字体跳过，不影响其它字体
                        break
                    if not family or family.startswith("."):
                        # .Hiragino Sans GB Interface 这类系统隐藏字面在浏览器里叫不出来
                        continue
                    faces.append(
                        Face(
                            family=str(family).strip(),
                            style=str(style or "").strip(),
                            path=path,
                            index=index,
                            weight=_weight_of(style),
                            italic=bool(re.search("italic|oblique", str(style or ""), re.I)),
                        )
                    )
    return faces


def _cache_path() -> Path:
    return config.data_root() / CACHE_FILENAME


def _load_cache() -> list[Face] | None:
    path = _cache_path()
    try:
        if time.time() - path.stat().st_mtime > CACHE_TTL_SECONDS:
            return None
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("version") != CACHE_VERSION:
        return None
    items = raw.get("faces")
    if not isinstance(items, list) or not items:
        return None
    faces: list[Face] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            faces.append(
                Face(
                    family=str(item["family"]),
                    style=str(item.get("style") or ""),
                    path=str(item["path"]),
                    index=int(item.get("index") or 0),
                    weight=int(item.get("weight") or 400),
                    italic=bool(item.get("italic")),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    return faces or None


def _save_cache(faces: list[Face]) -> None:
    payload = {
        "version": CACHE_VERSION,
        "built": int(time.time()),
        "faces": [asdict(face) for face in faces],
    }
    try:
        _cache_path().write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def faces() -> list[Face]:
    """本机字体面（家庭 + 字重），首次扫描后写索引文件，之后秒开。"""
    global _FACES
    if _FACES is not None:
        return _FACES
    with _LOCK:
        if _FACES is not None:
            return _FACES
        cached = None if os.environ.get("NOVAI_REFRESH_FONTS") else _load_cache()
        if cached is None:
            cached = _scan_faces()
            _save_cache(cached)
        _FACES = cached
        return _FACES


def families() -> list[dict]:
    """给前端字体面板用的本机字体列表（去重、带是否支持中文）。"""
    seen: dict[str, dict] = {}
    for face in faces():
        entry = seen.setdefault(face.family, {"family": face.family, "cjk": False})
        if entry["cjk"]:
            continue
        for ch in "中文测试":
            if _covers(face, ch):
                entry["cjk"] = True
                break
    return sorted(seen.values(), key=lambda item: (not item["cjk"], item["family"].lower()))


def _render(font: ImageFont.FreeTypeFont, content: str) -> Image.Image | None:
    try:
        bbox = font.getbbox(content)
    except Exception:  # noqa: BLE001
        return None
    if not bbox:
        return None
    width = max(1, bbox[2] - bbox[0])
    height = max(1, bbox[3] - bbox[1])
    image = Image.new("L", (width + 12, height + 12), 0)
    ImageDraw.Draw(image).text((6 - bbox[0], 6 - bbox[1]), content, font=font, fill=255)
    return image


def _covers(face: Face, ch: str) -> bool:
    key = (face.path, face.index, ch)
    cached = _COVER_CACHE.get(key)
    if cached is not None:
        return cached
    ok = False
    try:
        font = ImageFont.truetype(face.path, 40, index=face.index)
        glyph = _render(font, ch)
        blank = _render(font, "\ue000")
        if glyph is not None:
            ok = blank is None or glyph.tobytes() != blank.tobytes()
    except Exception:  # noqa: BLE001
        ok = False
    _COVER_CACHE[key] = ok
    return ok


def _tight(image: Image.Image) -> Image.Image | None:
    box = image.getbbox()
    if not box:
        return None
    return image.crop(box)


def _normalize(image: Image.Image | None) -> np.ndarray | None:
    """按高度归一，宽度按原比例保留：字形拉宽/压扁本身就是重要的识别线索。"""
    if image is None:
        return None
    tight = _tight(image)
    if tight is None or tight.width < 2 or tight.height < 2:
        return None
    scale = CANVAS_HEIGHT / float(tight.height)
    width = min(CANVAS_MAX_WIDTH, max(2, int(round(tight.width * scale))))
    resized = tight.resize((width, CANVAS_HEIGHT), Image.BILINEAR)
    canvas = Image.new("L", (CANVAS_MAX_WIDTH, CANVAS_HEIGHT), 0)
    canvas.paste(resized, (0, 0))
    return np.asarray(canvas, dtype=np.float32) / 255.0


def _target(alpha: np.ndarray) -> np.ndarray | None:
    image = Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8), "L")
    return _normalize(image)


def _pick_faces(script_cjk: bool, weight: int) -> list[Face]:
    """每个字体家族最多留 2 个面，避免把 200 个粗细各渲一遍。"""
    grouped: dict[str, list[Face]] = {}
    for face in faces():
        grouped.setdefault(face.family, []).append(face)

    picked: list[Face] = []
    for family_faces in grouped.values():
        family_faces.sort(key=lambda face: (face.italic, abs(face.weight - weight)))
        picked.append(family_faces[0])
        if len(family_faces) > 1 and abs(family_faces[1].weight - weight) < abs(family_faces[0].weight - weight) + 200:
            picked.append(family_faces[1])
    return picked


def match(text: str, alpha: np.ndarray, density: float = 0.0) -> tuple[str, float] | None:
    """返回 (字体族, 置信度 0~1)；对不上返回 None。"""
    content = " ".join(str(text or "").split())
    if not content or alpha is None:
        return None
    key = (content[:24], int(alpha.shape[1]) // 8, int(alpha.shape[0]) // 8, round(density, 2))
    if key in _MATCH_CACHE:
        return _MATCH_CACHE[key]

    target = _target(alpha)
    if target is None:
        _MATCH_CACHE[key] = None
        return None

    script_cjk = any(text_util.is_cjk(ch) for ch in content)
    weight = text_util.estimate_font_weight(density)
    candidates = [
        face
        for face in _pick_faces(script_cjk, weight)
        if not script_cjk or _covers(face, next(ch for ch in content if text_util.is_cjk(ch)))
    ]
    if not candidates:
        _MATCH_CACHE[key] = None
        return None

    # 第一轮：小字号粗筛，只留最像的十几个，避免每个字重都做全尺寸渲染
    shortlist: list[tuple[float, Face]] = []
    for face in candidates:
        try:
            font = ImageFont.truetype(face.path, 26, index=face.index)
        except Exception:  # noqa: BLE001
            continue
        normalized = _normalize(_render(font, content))
        if normalized is None:
            continue
        shortlist.append((float(np.abs(normalized - target).mean()), face))
    shortlist.sort(key=lambda item: item[0])
    shortlist = shortlist[:_SHORTLIST]

    best: tuple[float, Face] | None = None
    for _coarse, face in shortlist:
        try:
            font = ImageFont.truetype(face.path, 64, index=face.index)
        except Exception:  # noqa: BLE001
            continue
        normalized = _normalize(_render(font, content))
        if normalized is None:
            continue
        shape_error = float(np.abs(normalized - target).mean())
        weight_error = abs(face.weight - weight) / 600.0
        score = shape_error + weight_error * 0.35
        if best is None or score < best[0]:
            best = (score, face)
    if best is None:
        _MATCH_CACHE[key] = None
        return None

    score, face = best
    confidence = round(max(0.0, min(0.99, 1.0 - score * 2.4)), 2)
    result = (face.family, confidence)
    _MATCH_CACHE[key] = result
    return result


def dominant(votes: list[tuple[str, float, float]]) -> str | None:
    """一张稿子通常只用 1~2 套字体：按文字面积加权投票，取最可信的那一个。"""
    table: dict[str, float] = {}
    for family, score, area in votes:
        if not family:
            continue
        table[family] = table.get(family, 0.0) + float(area) * max(0.15, float(score))
    if not table:
        return None
    return max(table.items(), key=lambda item: item[1])[0]


def harmonize(drafts) -> dict[str, str]:
    """按语种分别统一字体：中文一套、英文一套，不要把书法字体套到英文上。"""
    groups: dict[str, list] = {}
    for draft in drafts:
        content = str(getattr(draft, "text", "") or "")
        if not content:
            continue
        script = "cjk" if any(text_util.is_cjk(ch) for ch in content) else "latin"
        groups.setdefault(script, []).append(draft)

    applied: dict[str, str] = {}
    for script, items in groups.items():
        family = dominant(
            [
                (
                    (item.style or {}).get("fontFamily"),
                    getattr(item, "font_score", 0.0),
                    item.area,
                )
                for item in items
            ]
        )
        if not family:
            continue
        for item in items:
            if item.style:
                item.style["fontFamily"] = family
        applied[script] = family
    return applied


def default_family(text: str) -> str:
    """识别不出来时按语种给一个本机大概率有的字体。"""
    if any(text_util.is_cjk(ch) for ch in text):
        if sys.platform == "darwin":
            return "PingFang SC"
        if os.name == "nt":
            return "Microsoft YaHei"
        return "Noto Sans CJK SC"
    if sys.platform == "darwin":
        return "Helvetica Neue"
    if os.name == "nt":
        return "Arial"
    return "DejaVu Sans"


def resolve(text: str, alpha: np.ndarray, density: float = 0.0) -> tuple[str, float]:
    """图层用的最终字体：识别成功用识别结果，失败按语种兜底。"""
    result = match(text, alpha, density)
    if result and result[1] >= 0.45:
        return result
    return (default_family(text), 0.0)
