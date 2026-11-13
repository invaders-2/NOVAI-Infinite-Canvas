from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from PIL import Image
from scipy import ndimage

from . import ocr, regions, text
from .image_io import LoadedImage

ROLE_ORDER = {"background": 0, "block": 1, "object": 2, "text": 3}

ROLE_KEYWORDS = {
    "text": ("文字", "文本", "标题", "text", "字体", "字"),
    "object": ("主体", "商品", "产品", "物体", "人物", "前景", "object", "product", "subject"),
    "block": ("色块", "背景", "底色", "块", "block", "background", "颜色"),
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
    image = Image.fromarray(rgba, "RGBA")
    return Draft(
        name="原图",
        kind="image",
        role="background",
        png=image,
        bbox=(0, 0, loaded.width, loaded.height),
        color=regions.hex_color(regions.dominant_color(rgb, np.ones((work_h, work_w), bool))),
        area=work_w * work_h,
    )


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
        style = {
            "color": matte["color"],
            "strokeColor": None,
            "strokeWidth": 0,
            "fontFamily": text.guess_font_family(line["text"]),
            "fontWeight": text.estimate_font_weight(matte["density"]),
            "fontSize": max(8, int(round(line["h"] * loaded.up_y * 0.8))),
            "letterSpacing": 0,
            "lineHeight": 1.1,
            "align": text.estimate_align(center_x * loaded.up_x, loaded.width),
            "opacity": 1,
        }
        drafts.append(
            Draft(
                name=content,
                kind="text",
                role="text",
                png=canvas,
                bbox=bbox,
                color=matte["color"],
                area=int(line["w"] * line["h"]),
                text=line["text"],
                style=style,
                confidence=round(min(0.99, max(0.0, line["conf"] / 100.0)), 2),
            )
        )
    if skipped:
        warnings.append(f"有 {skipped} 处文字候选被跳过（过小/无有效笔画）")
    return drafts, glyph_mask, warnings


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
        if draft.role == "text":
            return (ROLE_ORDER[draft.role], 0, draft.bbox[1], draft.bbox[0])
        return (ROLE_ORDER[draft.role], -draft.area, draft.bbox[1], draft.bbox[0])

    return sorted(drafts, key=sort_key)


def _limit(drafts: list[Draft], max_layers: int) -> tuple[list[Draft], list[str]]:
    if len(drafts) <= max_layers:
        return _order(drafts), []

    background = [draft for draft in drafts if draft.role == "background"][:1]
    texts = sorted(
        (draft for draft in drafts if draft.role == "text"), key=lambda draft: -draft.area
    )
    images = sorted(
        (draft for draft in drafts if draft.role not in {"background", "text"}),
        key=lambda draft: -draft.area,
    )
    slots = max(0, max_layers - len(background))

    keep_texts = texts[:slots]
    keep_images = images[: max(0, slots - len(keep_texts))]
    if len(keep_texts) < min(2, len(texts)) and keep_images:
        needed = min(2, len(texts)) - len(keep_texts)
        keep_texts = texts[: min(slots, len(keep_texts) + needed)]
        keep_images = keep_images[: max(0, slots - len(keep_texts))]

    keep = background + keep_images + keep_texts
    return _order(keep), [f"图层数超过上限，优先保留文字层，已保留前 {len(keep)} 层"]


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
        if not lines:
            warnings.append("未识别到文字，已跳过文字层")
    else:
        warnings.append("未检测到 tesseract 或语言包，已跳过文字层")

    text_drafts, glyph_mask, text_warnings = _build_text_drafts(
        rgb, loaded, lines, region_mask
    )
    warnings.extend(text_warnings)

    glyph_mask = ndimage.binary_dilation(glyph_mask, iterations=2)
    layer_rgb = regions.inpaint_glyphs(rgb, glyph_mask)
    block_candidates = regions.extract_blocks(
        layer_rgb, region_mask, max_blocks=3, min_ratio=0.02
    )
    drafts: list[Draft] = []
    block_masks: list[np.ndarray] = []
    background_color = regions.dominant_color(rgb, region_mask)

    if block_candidates:
        for index, block in enumerate(block_candidates):
            full_mask = regions.full_mask(block, (work_h, work_w))
            block_masks.append(full_mask)
            if index == 0:
                name, role = "背景", "background"
            else:
                name, role = f"色块 {index}", "block"
            drafts.append(
                Draft(
                    name=name,
                    kind="image",
                    role=role,
                    png=regions.build_block_layer(layer_rgb, block, (work_h, work_w)),
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
    else:
        ys, xs = np.nonzero(region_mask)
        if len(xs) == 0:
            ys = np.asarray([0])
            xs = np.asarray([0])
        drafts.append(
            Draft(
                name="背景",
                kind="image",
                role="background",
                png=regions.full_region_layer(layer_rgb, region_mask, (work_h, work_w)),
                bbox=(
                    int(xs.min() * loaded.up_x),
                    int(ys.min() * loaded.up_y),
                    int((xs.max() - xs.min() + 1) * loaded.up_x),
                    int((ys.max() - ys.min() + 1) * loaded.up_y),
                ),
                color=regions.hex_color(background_color),
                area=int(region_mask.sum()),
            )
        )
        warnings.append("未找到稳定的色块，已将整幅作为背景层")

    if block_candidates:
        objects = regions.extract_objects(
            layer_rgb, block_masks, region_mask, max_objects=8
        )
        for index, item in enumerate(objects, start=1):
            component = item["mask"]
            full = np.zeros((work_h, work_w), dtype=bool)
            offset_x, offset_y = item["offset"]
            full[
                offset_y : offset_y + component.shape[0],
                offset_x : offset_x + component.shape[1],
            ] = component
            drafts.append(
                Draft(
                    name=f"主体 {index}",
                    kind="image",
                    role="object",
                    png=regions.build_object_layer(layer_rgb, item, (work_h, work_w)),
                    bbox=(
                        int(round(item["bbox"][0] * loaded.up_x)),
                        int(round(item["bbox"][1] * loaded.up_y)),
                        int(round(item["bbox"][2] * loaded.up_x)),
                        int(round(item["bbox"][3] * loaded.up_y)),
                    ),
                    color=regions.layer_color(layer_rgb, full),
                    area=item["area"],
                )
            )

    drafts.extend(text_drafts)

    if mode == "custom" and prompt:
        drafts, filter_warnings = _prompt_filter(drafts, prompt)
        warnings.extend(filter_warnings)

    if len(drafts) < 2:
        warnings.append("可拆分出的图层不足 2 层，已回退为原图整层")
        return [_original_draft(loaded, rgb)], warnings, "heuristic"

    limited, limit_warnings = _limit(drafts, max_layers)
    warnings.extend(limit_warnings)
    return limited, warnings, "heuristic"
