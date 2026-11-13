from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PIL import Image
from scipy import ndimage

from . import fonts, inpaint, matting, ocr, regions, semantics, text
from .image_io import LoadedImage

ROLE_ORDER = {
    semantics.ROLE_BACKGROUND: 0,
    semantics.ROLE_SCENE: 1,
    semantics.ROLE_DECORATION: 2,
    semantics.ROLE_PROP: 3,
    semantics.ROLE_SUBJECT: 4,
    semantics.ROLE_LOGO: 5,
    semantics.ROLE_TEXT: 6,
}

ROLE_KEYWORDS = {
    semantics.ROLE_TEXT: ("文字", "文本", "标题", "text", "字体", "字"),
    semantics.ROLE_SUBJECT: (
        "主体", "商品", "产品", "物体", "人物", "前景", "object", "product", "subject",
    ),
    semantics.ROLE_DECORATION: ("色块", "底色", "块", "block", "颜色"),
}

COLOR_KEYWORDS = {
    "白": (250, 250, 250),
    "white": (250, 250, 250),
    "黑": (18, 18, 18),
    "black": (18, 18, 18),
    "红": (220, 48, 48),
    "red": (220, 48, 48),
    "蓝": (20, 80, 180),
    "blue": (20, 80, 180),
    "绿": (30, 170, 96),
    "green": (30, 170, 96),
    "黄": (240, 200, 40),
    "yellow": (240, 200, 40),
    "橙": (240, 130, 40),
    "orange": (240, 130, 40),
    "紫": (130, 90, 200),
    "purple": (130, 90, 200),
    "粉": (238, 150, 180),
    "pink": (238, 150, 180),
    "米": (248, 243, 240),
    "cream": (248, 243, 240),
    "灰": (128, 128, 128),
    "gray": (128, 128, 128),
    "金": (240, 190, 60),
    "gold": (240, 190, 60),
}

# 主体面积下限（占画布）：再小就是装饰/噪点，不配单独成层
SUBJECT_RATIO = 0.012
PROP_RATIO = 0.0015
MAX_SUBJECTS = 4
MAX_PROPS = 4
MAX_TEXTS = 12


@dataclass
class Draft:
    name: str
    kind: str
    role: str
    png: Image.Image
    bbox: tuple[int, int, int, int]
    color: str
    area: int
    text: str | None = None
    style: dict | None = None
    confidence: float | None = None
    warnings: list[str] = field(default_factory=list)


def _work_region(selection: dict | None, loaded: LoadedImage) -> np.ndarray:
    work_w, work_h = loaded.work_size
    mask = np.ones((work_h, work_w), dtype=bool)
    if not selection:
        return mask
    x0 = max(0, int(round(selection["x"] / loaded.up_x)))
    y0 = max(0, int(round(selection["y"] / loaded.up_y)))
    x1 = min(work_w, int(round((selection["x"] + selection["w"]) / loaded.up_x)))
    y1 = min(work_h, int(round((selection["y"] + selection["h"]) / loaded.up_y)))
    mask[:] = False
    if x1 > x0 and y1 > y0:
        mask[y0:y1, x0:x1] = True
    return mask


def _hex_to_rgb(value: str) -> np.ndarray:
    value = value.lstrip("#")
    return np.asarray([int(value[index : index + 2], 16) for index in (0, 2, 4)], dtype=np.float32)


def _original_draft(loaded: LoadedImage, rgb: np.ndarray) -> Draft:
    work_w, work_h = loaded.work_size
    rgba = np.dstack([rgb, np.full((work_h, work_w), 255, dtype=np.uint8)])
    return Draft(
        name="原图",
        kind="image",
        role=semantics.ROLE_BACKGROUND,
        png=Image.fromarray(rgba, "RGBA"),
        bbox=(0, 0, loaded.width, loaded.height),
        color=regions.hex_color(regions.dominant_color(rgb, np.ones((work_h, work_w), bool))),
        area=work_w * work_h,
    )


def _clean_lines(lines: list[dict], canvas_area: int) -> list[dict]:
    """OCR 多 pass 会反复认出同一行（还会把装饰线读成「SS」「一」），这里统一洗一遍。"""
    kept: list[dict] = []
    for line in sorted(lines, key=lambda item: -item["conf"]):
        content = str(line.get("text") or "").strip()
        if len(content) < 2 and not any(ch.isdigit() for ch in content):
            continue
        if line["w"] * line["h"] > canvas_area * 0.12:
            continue
        duplicate = False
        for other in kept:
            left = max(line["x"], other["x"])
            top = max(line["y"], other["y"])
            right = min(line["x"] + line["w"], other["x"] + other["w"])
            bottom = min(line["y"] + line["h"], other["y"] + other["h"])
            inter = max(0, right - left) * max(0, bottom - top)
            union = line["w"] * line["h"] + other["w"] * other["h"] - inter
            overlap = inter / union if union > 0 else 0.0
            if overlap > 0.5 or (overlap > 0.25 and content == other["text"]):
                duplicate = True
                break
        if not duplicate:
            kept.append(line)
        if len(kept) >= MAX_TEXTS * 2:
            break
    kept.sort(key=lambda item: (item["y"], item["x"]))
    return kept


def _build_text_drafts(
    rgb: np.ndarray,
    loaded: LoadedImage,
    lines: list[dict],
    region_mask: np.ndarray,
) -> tuple[list[Draft], np.ndarray, list[str]]:
    work_h, work_w = rgb.shape[:2]
    drafts: list[Draft] = []
    glyph_mask = np.zeros((work_h, work_w), dtype=bool)
    warnings: list[str] = []
    skipped = 0
    for line in lines:
        center_x = line["x"] + line["w"] / 2
        center_y = line["y"] + line["h"] / 2
        px = min(work_w - 1, max(0, int(center_x)))
        py = min(work_h - 1, max(0, int(center_y)))
        if not region_mask[py, px]:
            continue
        if line["h"] < 9 or line["w"] < 6 or not text.has_content(line["text"]):
            skipped += 1
            continue
        has_alnum = any(ch.isalnum() for ch in line["text"])
        cjk_count = sum(1 for ch in line["text"] if text.is_cjk(ch))
        if not has_alnum and cjk_count < 2:
            skipped += 1
            continue
        matte = text.build_text_matte(rgb, (line["x"], line["y"], line["w"], line["h"]))
        if matte is None:
            skipped += 1
            continue
        if matte["largestRatio"] > 0.45:
            skipped += 1
            continue
        canvas = Image.new("RGBA", (work_w, work_h), (0, 0, 0, 0))
        canvas.paste(Image.fromarray(matte["rgba"], "RGBA"), (matte["x"], matte["y"]))
        matte_alpha = matte["rgba"][..., 3] > 0
        glyph_mask[
            matte["y"] : matte["y"] + matte_alpha.shape[0],
            matte["x"] : matte["x"] + matte_alpha.shape[1],
        ] |= matte_alpha
        bbox = (
            int(round(line["x"] * loaded.up_x)),
            int(round(line["y"] * loaded.up_y)),
            int(round(line["w"] * loaded.up_x)),
            int(round(line["h"] * loaded.up_y)),
        )
        content = line["text"][:24].strip() or "文字"
        family, score = fonts.resolve(line["text"], matte["rgba"][..., 3], matte["density"])
        style = {
            "color": matte["color"],
            "strokeColor": None,
            "strokeWidth": 0,
            "fontFamily": family,
            "fontWeight": text.estimate_font_weight(matte["density"]),
            "fontSize": text.estimate_font_size(
                line["text"], text.ink_height(matte["rgba"]), float(line["w"])
            ),
            "letterSpacing": 0,
            "lineHeight": 1.12,
            "align": text.estimate_align(center_x * loaded.up_x, loaded.width),
            "opacity": 1,
        }
        draft = Draft(
                name=semantics.clean_name(None, semantics.ROLE_TEXT, content),
                kind="text",
                role=semantics.ROLE_TEXT,
                png=canvas,
                bbox=bbox,
                color=matte["color"],
                area=int(line["w"] * line["h"]),
                text=line["text"],
                style=style,
                confidence=round(min(0.99, max(0.0, line["conf"] / 100.0)), 2),
            )
        draft.font_score = score
        drafts.append(draft)
    if skipped:
        warnings.append(f"有 {skipped} 处文字候选被跳过（过小/无有效笔画）")
    return drafts, glyph_mask, warnings


def _subject_drafts(
    rgb: np.ndarray,
    loaded: LoadedImage,
    foreground: np.ndarray | None,
    region_mask: np.ndarray,
    glyph_mask: np.ndarray,
    warnings: list[str],
) -> tuple[list[Draft], np.ndarray, np.ndarray]:
    """用抠图模型的 alpha 找主体：比按颜色连通域要干净得多。"""
    work_h, work_w = rgb.shape[:2]
    union = np.zeros((work_h, work_w), dtype=np.uint8)
    subject_union = np.zeros((work_h, work_w), dtype=np.uint8)
    drafts: list[Draft] = []
    if foreground is None:
        return drafts, union, subject_union

    alpha = foreground[..., 3].astype(np.float32) / 255.0
    # 抠图模型会把文字笔画也当前景；先按 OCR 字形扣掉，否则字被拆成「道具」
    solid = (alpha > 0.5) & region_mask & ~glyph_mask
    labels, count = ndimage.label(solid)
    if count == 0:
        return drafts, union
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    region_area = max(1, int(region_mask.sum()))

    subjects = 0
    props = 0
    for label in np.argsort(sizes)[::-1]:
        area = int(sizes[label])
        if area < PROP_RATIO * region_area:
            break
        ratio = area / region_area
        component = labels == label
        rows = np.flatnonzero(component.any(axis=1))
        cols = np.flatnonzero(component.any(axis=0))
        box_w = max(1, int(cols[-1] - cols[0] + 1))
        box_h = max(1, int(rows[-1] - rows[0] + 1))
        fill = area / float(box_w * box_h)
        aspect = max(box_w, box_h) / float(min(box_w, box_h))
        # 文字会从色块里被扣掉，fill 天然偏低，所以门槛按 0.72 算
        flat = fill > 0.72 and aspect > 3.2
        if flat:
            # 长条/纯色牌子是「装饰」，不是主体；主体得是有轮廓的物件
            if props >= MAX_PROPS:
                continue
            role = semantics.ROLE_DECORATION
            props += 1
        elif ratio >= SUBJECT_RATIO:
            if subjects >= MAX_SUBJECTS:
                continue
            role = semantics.ROLE_SUBJECT
            subjects += 1
        else:
            if props >= MAX_PROPS:
                continue
            role = semantics.ROLE_PROP
            props += 1

        component = ndimage.binary_fill_holes(component)
        local_alpha = np.where(component, alpha, 0.0)
        alpha_u8 = (np.clip(local_alpha, 0.0, 1.0) * 255).astype(np.uint8)
        if int((alpha_u8 > 160).sum()) < 40:
            continue
        rgba = np.dstack([rgb, alpha_u8])
        rgba[alpha_u8 == 0] = 0
        tight = _alpha_bbox(alpha_u8 > 8)
        if not tight:
            continue
        x, y, w, h = tight
        solid_pixels = alpha_u8 >= 200
        color = regions.hex_color(np.median(rgb[solid_pixels], axis=0)) if solid_pixels.any() else "#FFFFFF"
        # 所有实体层（主体/道具/装饰）都要从背景里挖掉，否则挪走后原地留重影
        np.maximum(union, alpha_u8, out=union)
        if role == semantics.ROLE_SUBJECT:
            np.maximum(subject_union, alpha_u8, out=subject_union)
        drafts.append(
            Draft(
                name=semantics.clean_name(None, role, None, subjects if role == semantics.ROLE_SUBJECT else props),
                kind="image",
                role=role,
                png=Image.fromarray(rgba, "RGBA"),
                bbox=(
                    int(round(x * loaded.up_x)),
                    int(round(y * loaded.up_y)),
                    int(round(w * loaded.up_x)),
                    int(round(h * loaded.up_y)),
                ),
                color=color,
                area=int(area),
            )
        )
    if not drafts:
        warnings.append("本地抠图没有找到主体，已退回色块拆分")
    return drafts, union, subject_union


def _alpha_bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    rows = np.flatnonzero(mask.any(axis=1))
    cols = np.flatnonzero(mask.any(axis=0))
    if rows.size == 0 or cols.size == 0:
        return None
    return (
        int(cols[0]),
        int(rows[0]),
        int(cols[-1] - cols[0] + 1),
        int(rows[-1] - rows[0] + 1),
    )


def _block_drafts(
    rgb: np.ndarray, loaded: LoadedImage, region_mask: np.ndarray, warnings: list[str]
) -> tuple[list[Draft], np.ndarray]:
    """没有抠图模型时的退路：只留最大的 1~2 块纯色区域当「装饰」，别再造一堆碎块。"""
    work_h, work_w = rgb.shape[:2]
    candidates = regions.extract_blocks(rgb, region_mask, max_blocks=2, min_ratio=0.03)
    drafts: list[Draft] = []
    union = np.zeros((work_h, work_w), dtype=np.uint8)
    for index, block in enumerate(candidates, start=1):
        role = semantics.ROLE_DECORATION
        drafts.append(
            Draft(
                name=semantics.clean_name(None, role, None, index),
                kind="image",
                role=role,
                png=regions.build_block_layer(rgb, block, (work_h, work_w)),
                bbox=(
                    int(round(block["bbox"][0] * loaded.up_x)),
                    int(round(block["bbox"][1] * loaded.up_y)),
                    int(round(block["bbox"][2] * loaded.up_x)),
                    int(round(block["bbox"][3] * loaded.up_y)),
                ),
                color=regions.hex_color(block["color"]),
                area=block["area"],
            )
        )
        union[regions.full_mask(block, (work_h, work_w))] = 255
    if not drafts:
        warnings.append("未找到稳定色块，只保留背景与文字层")
    return drafts, union


def _background_draft(
    rgb: np.ndarray,
    loaded: LoadedImage,
    hole_alpha: np.ndarray,
    warnings: list[str],
) -> Draft:
    work_h, work_w = rgb.shape[:2]
    filled = None
    if hole_alpha.any() and inpaint.enabled():
        filled, reason = inpaint.fill_background(rgb, hole_alpha > 0)
        if reason:
            warnings.append(reason)
    base = rgb if filled is None else filled
    rgba = np.dstack([base, np.full((work_h, work_w), 255, dtype=np.uint8)])
    if filled is None and hole_alpha.any():
        rgba[..., 3] = 255 - hole_alpha
    return Draft(
        name="背景",
        kind="image",
        role=semantics.ROLE_BACKGROUND,
        png=Image.fromarray(rgba, "RGBA"),
        bbox=(0, 0, loaded.width, loaded.height),
        color=regions.hex_color(regions.dominant_color(rgb, np.ones((work_h, work_w), bool))),
        area=work_w * work_h,
    )


def _erase_text_from_layer(draft: Draft, mask: np.ndarray) -> None:
    """装饰块/道具里原本印着的字要抹掉：文字层会重新排版，留着原字就是双影。"""
    if draft.kind != "image" or draft.role not in {
        semantics.ROLE_DECORATION,
        semantics.ROLE_PROP,
        semantics.ROLE_SCENE,
    }:
        return
    rgba = np.asarray(draft.png)
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        return
    alpha = rgba[..., 3] > 0
    hit = mask & alpha
    if not hit.any():
        return
    rest = alpha & ~mask
    source = rgba[rest] if rest.any() else rgba[alpha]
    if source.size == 0:
        return
    color = np.median(source[:, :3], axis=0).astype(np.uint8)
    cleaned = rgba.copy()
    cleaned[hit, :3] = color
    draft.png = Image.fromarray(cleaned, "RGBA")


def _drop_embedded_text(
    text_drafts: list[Draft], subject_alpha: np.ndarray, loaded: LoadedImage
) -> list[Draft]:
    """整行文字都落在主体身上（商品标签/瓶身文字）时不再单独出层：
    拆成两层会让「移动主体」时文字留在原地，看起来像没拆干净。"""
    keep: list[Draft] = []
    for draft in text_drafts:
        x, y, w, h = draft.bbox
        x0 = max(0, int(round(x / loaded.up_x)))
        y0 = max(0, int(round(y / loaded.up_y)))
        x1 = min(subject_alpha.shape[1], int(round((x + w) / loaded.up_x)))
        y1 = min(subject_alpha.shape[0], int(round((y + h) / loaded.up_y)))
        patch = subject_alpha[y0:y1, x0:x1]
        if patch.size and float((patch > 128).mean()) > 0.85:
            continue
        keep.append(draft)
    return keep


def _prompt_filter(drafts: list[Draft], prompt: str) -> tuple[list[Draft], list[str]]:
    lowered = prompt.lower()
    roles = {role for role, words in ROLE_KEYWORDS.items() if any(word in lowered for word in words)}
    colors = [
        np.asarray(reference, dtype=np.float32)
        for key, reference in COLOR_KEYWORDS.items()
        if key in lowered
    ]
    if not roles and not colors:
        return drafts, []
    kept = [draft for draft in drafts if not roles or draft.role in roles]
    if colors:
        kept = [
            draft
            for draft in kept
            if any(
                float(np.linalg.norm(_hex_to_rgb(draft.color) - reference)) < 95.0
                for reference in colors
            )
        ]
    if len(kept) < 2:
        return drafts, ["自定义描述未匹配到足够图层，已回退为完整结构"]
    return kept, []


def _order(drafts: list[Draft]) -> list[Draft]:
    def sort_key(draft: Draft):
        if draft.role == semantics.ROLE_TEXT:
            return (ROLE_ORDER.get(draft.role, 6), 0, draft.bbox[1], draft.bbox[0])
        return (ROLE_ORDER.get(draft.role, 2), -draft.area, draft.bbox[1], draft.bbox[0])

    return sorted(drafts, key=sort_key)


def _limit(drafts: list[Draft], max_layers: int) -> tuple[list[Draft], list[str]]:
    if len(drafts) <= max_layers:
        return _order(drafts), []

    background = [draft for draft in drafts if draft.role == semantics.ROLE_BACKGROUND][:1]
    subjects = sorted(
        (draft for draft in drafts if draft.role == semantics.ROLE_SUBJECT), key=lambda draft: -draft.area
    )
    texts = sorted(
        (draft for draft in drafts if draft.role == semantics.ROLE_TEXT), key=lambda draft: -draft.area
    )
    logos = sorted(
        (draft for draft in drafts if draft.role == semantics.ROLE_LOGO), key=lambda draft: -draft.area
    )
    others = sorted(
        (
            draft
            for draft in drafts
            if draft.role
            not in {semantics.ROLE_BACKGROUND, semantics.ROLE_SUBJECT, semantics.ROLE_TEXT, semantics.ROLE_LOGO}
        ),
        key=lambda draft: -draft.area,
    )

    slots = max(0, max_layers - len(background))
    keep = background + subjects[:slots]
    slots = max(0, max_layers - len(keep))
    keep += texts[:slots]
    slots = max(0, max_layers - len(keep))
    keep += logos[:slots]
    slots = max(0, max_layers - len(keep))
    keep += others[:slots]
    return _order(keep), ["图层数超过上限，已优先保留背景/主体/文字，保留前 %d 层" % len(keep)]


def split(
    loaded: LoadedImage,
    mode: str,
    prompt: str | None,
    selection: dict | None,
    max_layers: int,
    ocr_available: bool,
) -> tuple[list[Draft], list[str], str]:
    rgb = np.asarray(loaded.work.convert("RGB"))
    work_h, work_w = rgb.shape[:2]
    region_mask = _work_region(selection, loaded)
    warnings: list[str] = []

    lines: list[dict] = []
    if ocr_available:
        passes, ocr_warnings = ocr.ocr_passes(loaded.work)
        warnings.extend(ocr_warnings)
        if passes:
            lines = text.lines_from_passes(passes)
        lines = text.merge_lines(lines)
        lines = _clean_lines(lines, work_w * work_h)
        if not lines:
            warnings.append("未识别到文字，已跳过文字层")
    else:
        warnings.append("未检测到 tesseract 或语言包，已跳过文字层")

    text_drafts, glyph_mask, text_warnings = _build_text_drafts(rgb, loaded, lines, region_mask)
    warnings.extend(text_warnings)
    if text_drafts:
        # 逐行匹配会得到「一行一个字体」；按语种分别投票统一成主字体
        applied = fonts.harmonize(text_drafts)
        if applied:
            labels = [("中文" if key == "cjk" else "英文") + "「%s」" % value for key, value in applied.items()]
            warnings.append("文字字体识别：" + "、".join(labels))
    glyph_mask = ndimage.binary_dilation(glyph_mask, iterations=2)

    foreground, matte_reason = matting.foreground_rgba(loaded)
    if foreground is None and matte_reason:
        warnings.append("本地抠图模型不可用（%s），已退回色块拆分" % matte_reason)

    object_drafts, hole_union, subject_union = _subject_drafts(
        rgb, loaded, foreground, region_mask, glyph_mask, warnings
    )
    if not object_drafts:
        object_drafts, block_union = _block_drafts(rgb, loaded, region_mask, warnings)
        hole_union = np.maximum(hole_union, block_union)

    hole_alpha = np.maximum(hole_union, glyph_mask.astype(np.uint8) * 255)
    background = _background_draft(rgb, loaded, hole_alpha, warnings)

    text_drafts = _drop_embedded_text(text_drafts, subject_union, loaded)
    if glyph_mask.any():
        clean_mask = ndimage.binary_dilation(glyph_mask, iterations=2)
        for draft in object_drafts:
            _erase_text_from_layer(draft, clean_mask)

    drafts: list[Draft] = [background]
    drafts.extend(object_drafts)
    drafts.extend(text_drafts)

    if mode == "custom" and prompt:
        drafts, filter_warnings = _prompt_filter(drafts, prompt)
        warnings.extend(filter_warnings)

    if len(drafts) < 2:
        warnings.append("可拆分出的图层不足 2 层，已回退为原图整层")
        return [_original_draft(loaded, rgb)], warnings, "heuristic"

    limited, limit_warnings = _limit(drafts, max_layers)
    warnings.extend(limit_warnings)
    semantics.ensure_unique(limited)
    return limited, warnings, "heuristic"
