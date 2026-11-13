from __future__ import annotations

import base64
import io
import json
import re
import threading

import numpy as np
import requests
from PIL import Image
from scipy import ndimage

from . import config, fonts, inpaint, matting, ocr, regions, semantics, text
from .heuristic import Draft
from .image_io import LoadedImage

SYSTEM_PROMPT = (
    "You are a senior design-layer engineer. You split a flattened artwork into "
    "semantically distinct, independently editable layers. Answer with one JSON "
    "object only, no prose, no markdown."
)

REPLY_SHAPE = (
    '{"layers":['
    '{"name":"主体：模特","role":"subject","bbox":[x,y,w,h],"importance":1,"z":30},'
    '{"name":"背景","role":"background","bbox":[0,0,W,H],"importance":5},'
    '{"name":"标题","type":"text","text":"...","bbox":[x,y,w,h],'
    '"style":{"color":"#FFFFFF","fontSize":48,"fontWeight":700,"align":"left"},'
    '"importance":2}'
    ']}'
)

BODY_LIMIT = 900 * 1024
# 网关请求体约 1MB；首次按原图发，超限时降两档再试。
_FALLBACK_TIERS = ((0.78, 82), (0.55, 72))

# 抠图线程最长等这么久：模型异常时宁可退回矩形层，也不能把请求挂死
MATTE_TIMEOUT_SECONDS = 120
OCR_TIMEOUT_SECONDS = 40


def _encode(image: Image.Image, quality: int = 88) -> str:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=quality)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


def _payload_size(payload: dict) -> int:
    # requests 用默认 json.dumps（ASCII 转义），按同样方式量请求体。
    return len(json.dumps(payload).encode("utf-8"))


def _fit(image: Image.Image, scale: float) -> Image.Image:
    if scale >= 1.0:
        return image
    width, height = image.size
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(size, Image.LANCZOS)


def _instruction(
    width: int, height: int, max_layers: int, prompt: str | None, selection: dict | None
) -> str:
    instruction = (
        f"图片尺寸 {width}x{height} 像素。把这张成品图拆成可独立编辑的语义图层，最多 {max_layers} 层。\n"
        "role 只能是 background / scene / prop / subject / logo / text。\n"
        "硬规则：\n"
        "1) background 只有一层，bbox 必须是整张画布 [0,0,W,H]。\n"
        "2) subject＝人物/模特/商品/产品等画面主角，每个独立对象单独一层，bbox 紧贴轮廓；"
        "画面里有两个人物就出两层，不要合并。\n"
        "3) prop＝可单独移动的道具/配件/装饰物；logo＝品牌标识/徽标；scene＝大面积环境（天空、地面、墙面）。\n"
        "4) text＝每一行/每一段可读文字单独一层，必须同时给 type:\"text\"、text（原文）和 style；"
        "文字绝不能并进图片层，图片层也不要含文字。\n"
        "5) 不要输出：细线、网格、描边、宽或高小于 10px 的窄条、同一区域的重复框、纯色留白。\n"
        "6) name 用简短中文（≤8 字），例如「主体：模特」「标题」「价格」「标识：logo」「背景」。\n"
        "7) importance 1-5，1＝画面主角；z 越大越靠上（背景最小，文字/标识最大）。\n"
        "8) bbox=[x,y,w,h] 像素坐标，必须贴住元素本身，不能留大片空白。\n"
    )
    if prompt:
        instruction += f"用户额外要求：{prompt}。\n"
    if selection:
        instruction += f"只拆分选区 {selection} 内的内容。\n"
    return instruction


def _parse_json(content: str) -> dict:
    cleaned = content.strip()
    cleaned = re.sub("^" + "`" * 3 + "(?:json)?", "", cleaned).strip()
    cleaned = re.sub("`" * 3 + "$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except ValueError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise


def _bbox(raw, width: int, height: int) -> tuple[int, int, int, int]:
    values = [int(round(float(value))) for value in (raw or [])][:4]
    if len(values) != 4:
        raise ValueError("bbox 无效")
    x, y, w, h = values
    x = max(0, min(x, width - 1))
    y = max(0, min(y, height - 1))
    w = max(1, min(w, width - x))
    h = max(1, min(h, height - y))
    return x, y, w, h


def _iou(a: tuple, b: tuple) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    left = max(ax, bx)
    top = max(ay, by)
    right = min(ax + aw, bx + bw)
    bottom = min(ay + ah, by + bh)
    inter = max(0, right - left) * max(0, bottom - top)
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _style(
    raw, fallback_color: str, ink_height: float, font_family: str, content: str, box_w: float
) -> dict:
    raw = raw or {}
    color = str(raw.get("color") or fallback_color)
    if not re.match(r"^#[0-9A-Fa-f]{6}$", color):
        color = fallback_color
    align = str(raw.get("align") or "left")
    if align not in {"left", "center", "right"}:
        align = "left"
    try:
        font_size = int(raw.get("fontSize") or 0)
    except (TypeError, ValueError):
        font_size = 0
    if font_size <= 0:
        # 同时按字形高度和行宽估字号：换成本机字体后字宽不会明显跑偏
        font_size = text.estimate_font_size(content, ink_height, box_w)
    try:
        font_weight = int(raw.get("fontWeight") or 400)
    except (TypeError, ValueError):
        font_weight = 400
    return {
        "color": color.upper(),
        "strokeColor": None,
        "strokeWidth": 0,
        "fontFamily": font_family,
        "fontWeight": max(100, min(900, font_weight)),
        "fontSize": max(8, font_size),
        "letterSpacing": 0,
        "lineHeight": 1.12,
        "align": align,
        "opacity": 1,
    }


def _paste_rect(canvas: Image.Image, local: np.ndarray, x: int, y: int) -> None:
    h, w = local.shape[:2]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = local
    rgba[..., 3] = 255
    canvas.paste(Image.fromarray(rgba, "RGBA"), (x, y))


def _object_keep(alpha: np.ndarray, bbox: tuple[int, int, int, int]) -> np.ndarray | None:
    """本层要保留的 alpha：框内 mask 作种子，再补全与它连通的整个主体。"""
    x, y, w, h = bbox
    seeds = np.zeros(alpha.shape, dtype=bool)
    seeds[y : y + h, x : x + w] = alpha[y : y + h, x : x + w] > 0.5
    if not seeds.any():
        return None
    labels, _ = ndimage.label(alpha > 0)
    keep = np.isin(labels, np.unique(labels[seeds]))
    return np.where(keep, alpha, 0.0)


def _alpha_bbox(alpha: np.ndarray) -> tuple[int, int, int, int] | None:
    rows = np.flatnonzero(alpha.any(axis=1))
    cols = np.flatnonzero(alpha.any(axis=0))
    if rows.size == 0 or cols.size == 0:
        return None
    return (
        int(cols[0]),
        int(rows[0]),
        int(cols[-1] - cols[0] + 1),
        int(rows[-1] - rows[0] + 1),
    )


TEXT_BBOX_MARGIN = 8
_TEXT_INK_GAP = 90
_TEXT_EDGE_THRESHOLD = 35


def _text_removal_mask(
    rgb: np.ndarray, matte: dict, bbox: tuple[int, int, int, int]
) -> np.ndarray:
    """背景里要抹掉的文字区域（u8，255=抹掉）：文字 bbox 整块 + matte + bbox 外的同行文字。"""
    import cv2

    work_h, work_w = rgb.shape[:2]
    x, y, w, h = (int(round(value)) for value in bbox)
    mask = np.zeros((work_h, work_w), np.uint8)
    margin = TEXT_BBOX_MARGIN
    mask[
        max(0, y - margin) : min(work_h, y + h + margin),
        max(0, x - margin) : min(work_w, x + w + margin),
    ] = 255

    alpha = matte["rgba"][..., 3]
    patch_h, patch_w = alpha.shape[:2]
    seed = np.zeros((work_h, work_w), bool)
    seed[matte["y"] : matte["y"] + patch_h, matte["x"] : matte["x"] + patch_w] = alpha > 0

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    high_pass = cv2.absdiff(gray, cv2.medianBlur(gray, 31))
    ink_hex = str(matte.get("color") or "#FFFFFF")
    ink = np.asarray(
        [int(ink_hex[1:3], 16), int(ink_hex[3:5], 16), int(ink_hex[5:7], 16)], np.float32
    )
    color_gap = np.linalg.norm(rgb.astype(np.float32) - ink, axis=2)
    pad_x = max(24, int(w * 0.9))
    pad_y = max(16, int(h * 0.6))
    window = np.zeros((work_h, work_w), bool)
    window[
        max(0, y - pad_y) : min(work_h, y + h + pad_y),
        max(0, x - pad_x) : min(work_w, x + w + pad_x),
    ] = True
    candidates = (high_pass > _TEXT_EDGE_THRESHOLD) & (color_gap < _TEXT_INK_GAP) & window
    glyphs = seed.copy()
    if candidates.any():
        count, labels, stats, _ = cv2.connectedComponentsWithStats(
            candidates.astype(np.uint8), connectivity=8
        )
        for index in range(1, count):
            area = int(stats[index, cv2.CC_STAT_AREA])
            ch = int(stats[index, cv2.CC_STAT_HEIGHT])
            cw = int(stats[index, cv2.CC_STAT_WIDTH])
            if area < 40 or ch < 6 or ch > h * 1.5 or cw > h * 4:
                continue
            glyphs |= labels == index
    if glyphs.any():
        rows = np.flatnonzero(glyphs.any(axis=1))
        cols = np.flatnonzero(glyphs.any(axis=0))
        if rows.size and cols.size:
            pad = margin + 2
            mask[
                max(0, int(rows[0]) - pad) : min(work_h, int(rows[-1]) + pad + 1),
                max(0, int(cols[0]) - pad) : min(work_w, int(cols[-1]) + pad + 1),
            ] = 255
        grown = cv2.dilate(glyphs.astype(np.uint8), np.ones((9, 9), np.uint8)) * 255
        np.maximum(mask, grown, out=mask)
    return mask


def _background_layer(
    entry: dict,
    rgb: np.ndarray,
    up_x: float,
    up_y: float,
    hole_alpha: np.ndarray,
    filled_rgb: np.ndarray | None,
) -> Draft:
    """背景层：铺满整张画布；主体/文字位置补成完整底图，补不了就挖透明洞。"""
    work_h, work_w = rgb.shape[:2]
    color = regions.hex_color(np.median(rgb.reshape(-1, 3), axis=0)) if rgb.size else "#FFFFFF"
    base = rgb if filled_rgb is None else filled_rgb
    rgba = np.dstack([base, np.full((work_h, work_w), 255, dtype=np.uint8)])
    if filled_rgb is None and hole_alpha.any():
        rgba[..., 3] = 255 - hole_alpha
    return Draft(
        name="背景",
        kind="image",
        role="background",
        png=Image.fromarray(rgba, "RGBA"),
        bbox=(0, 0, int(round(work_w * up_x)), int(round(work_h * up_y))),
        color=color,
        area=work_w * work_h,
    )


def _sanitize(items: list, width: int, height: int, max_layers: int) -> list[dict]:
    """模型返回的框先洗干净：去窄条/去重复/补背景，避免拆出一堆碎块。"""
    canvas_area = float(width * height)
    entries: list[dict] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        declared = str(item.get("type") or "").strip().lower()
        role = semantics.canonical_role(
            item.get("role"), "text" if declared == "text" else "image", index, item.get("name")
        )
        # 模型经常只给 role=text 不给 type；按 role 判文字层，否则会被当矩形裁出来
        kind = "text" if declared == "text" or role == semantics.ROLE_TEXT else "image"
        try:
            x, y, w, h = _bbox(item.get("bbox"), width, height)
        except (TypeError, ValueError):
            continue
        if kind == "text":
            if h < 5 or w < 8:
                continue
            content = str(item.get("text") or "").strip()
            if content:
                item = dict(item)
                item["text"] = content[:200]
        else:
            ratio = (w * h) / canvas_area
            long_side, short_side = max(w, h), min(w, h)
            if role != semantics.ROLE_BACKGROUND and (ratio < 0.0012 or short_side < 10):
                continue
            # 细线/描边/分隔条不是图层
            if role in {semantics.ROLE_PROP, semantics.ROLE_DECORATION} and long_side / max(1, short_side) > 16:
                continue
        entries.append(
            {
                "index": index,
                "item": item,
                "kind": kind,
                "role": role,
                "bbox": (x, y, w, h),
            }
        )

    # 去重：同一块区域只留一个；文字按内容+位置去重
    kept: list[dict] = []
    for entry in sorted(entries, key=lambda item: -item["bbox"][2] * item["bbox"][3]):
        duplicate = False
        for other in kept:
            if other["kind"] != entry["kind"]:
                continue
            overlap = _iou(entry["bbox"], other["bbox"])
            if overlap > 0.55:
                duplicate = True
                break
            if entry["kind"] == "text" and overlap > 0.3:
                if str(entry["item"].get("text")) == str(other["item"].get("text")):
                    duplicate = True
                    break
        if not duplicate:
            kept.append(entry)

    # 背景永远只有一层、永远铺满画布
    backgrounds = [entry for entry in kept if entry["role"] == semantics.ROLE_BACKGROUND]
    if backgrounds:
        primary = backgrounds[0]
        primary["bbox"] = (0, 0, width, height)
        kept = [entry for entry in kept if entry["role"] != semantics.ROLE_BACKGROUND]
        kept.insert(0, primary)
    else:
        kept.insert(
            0,
            {
                "index": -1,
                "item": {"role": semantics.ROLE_BACKGROUND, "name": "背景"},
                "kind": "image",
                "role": semantics.ROLE_BACKGROUND,
                "bbox": (0, 0, width, height),
            },
        )

    # 超上限时先丢装饰，再丢小道具；主体和文字保到最后
    def weight(entry: dict) -> tuple:
        role = entry["role"]
        area = entry["bbox"][2] * entry["bbox"][3]
        if role == semantics.ROLE_BACKGROUND:
            return (5, 0)
        if role == semantics.ROLE_TEXT:
            return (4, area)
        if role == semantics.ROLE_SUBJECT:
            return (3, area)
        if role == semantics.ROLE_LOGO:
            return (2, area)
        if role == semantics.ROLE_PROP:
            return (1, area)
        return (0, area)

    if len(kept) > max_layers:
        kept.sort(key=lambda entry: -weight(entry)[0])
        kept = kept[:max_layers]
    return kept


def _match_ocr_line(bbox: tuple, lines: list[dict]) -> dict | None:
    x, y, w, h = bbox
    center = (x + w / 2, y + h / 2)
    best = None
    best_score = 0.0
    for line in lines:
        line_bbox = (line["x"], line["y"], line["w"], line["h"])
        score = _iou(bbox, line_bbox)
        inside = (
            line["x"] <= center[0] <= line["x"] + line["w"]
            and line["y"] <= center[1] <= line["y"] + line["h"]
        )
        if inside:
            score += 0.35
        if score > best_score:
            best, best_score = line, score
    return best if best_score >= 0.25 else None


def split(
    loaded: LoadedImage,
    mode: str,
    prompt: str | None,
    selection: dict | None,
    max_layers: int,
) -> tuple[list[Draft], list[str], str]:
    cfg = config.vision_config()
    if not (cfg["base_url"] and cfg["api_key"] and cfg["model"]):
        raise RuntimeError("vision 引擎未配置（SPLIT_VISION_BASE_URL / API_KEY / MODEL）")

    work = loaded.work
    work_w, work_h = work.size
    rgb = np.asarray(work.convert("RGB"))
    payload = None
    sent_w, sent_h = work_w, work_h
    scale, quality = 1.0, 88
    for scale, quality in ((1.0, 88),) + _FALLBACK_TIERS:
        sent = _fit(work, scale)
        sent_w, sent_h = sent.size
        candidate = {
            "model": cfg["model"],
            "temperature": 0.2,
            "stream": False,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": _instruction(sent_w, sent_h, max_layers, prompt, selection)
                            + " 返回格式："
                            + REPLY_SHAPE,
                        },
                        {"type": "image_url", "image_url": {"url": _encode(sent, quality)}},
                    ],
                },
            ],
        }
        if _payload_size(candidate) <= BODY_LIMIT:
            payload = candidate
            break
    if payload is None:
        raise RuntimeError(
            "参考图已压缩到 %dx%d 仍超过接口 %dKB 请求体上限，请换用更小的原图（建议长边 ≤ 2000px）"
            % (sent_w, sent_h, BODY_LIMIT // 1024)
        )

    # 抠图和 OCR 互不依赖，跟视觉模型并行跑；拿到图层后再决定用不用
    matte_holder: dict = {}

    def run_matte() -> None:
        try:
            matte_holder["value"] = matting.foreground_rgba(loaded)
        except Exception as exc:  # noqa: BLE001 - 线程里的异常不能冒到请求
            matte_holder["value"] = (None, "抠图推理异常（%s）" % str(exc)[:160])

    ocr_holder: dict = {}

    def run_ocr() -> None:
        try:
            if not ocr.is_available():
                ocr_holder["value"] = ([], [])
                return
            passes, ocr_warnings = ocr.ocr_passes(work)
            ocr_holder["value"] = (text.lines_from_passes(passes), ocr_warnings)
        except Exception as exc:  # noqa: BLE001
            ocr_holder["value"] = ([], ["OCR 识别异常（%s）" % str(exc)[:120]])

    matte_thread = threading.Thread(target=run_matte, name="split-matte", daemon=True)
    ocr_thread = threading.Thread(target=run_ocr, name="split-ocr", daemon=True)
    matte_thread.start()
    ocr_thread.start()

    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    response = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {cfg['api_key']}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=90,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"vision 接口 {response.status_code}: {response.text[:200]}")
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    parsed = _parse_json(content)
    items = parsed.get("layers") if isinstance(parsed, dict) else None
    if not isinstance(items, list) or not items:
        raise RuntimeError("vision 返回缺少 layers")

    # 模型给的是发送尺寸的坐标，先换算回 work 尺寸再做校验
    raw_items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            x, y, w, h = _bbox(item.get("bbox"), sent_w, sent_h)
        except (TypeError, ValueError):
            continue
        if (sent_w, sent_h) != (work_w, work_h):
            x, y, w, h = _bbox(
                [x * work_w / sent_w, y * work_h / sent_h, w * work_w / sent_w, h * work_h / sent_h],
                work_w,
                work_h,
            )
        copied = dict(item)
        copied["bbox"] = [x, y, w, h]
        raw_items.append(copied)

    entries = _sanitize(raw_items, work_w, work_h, max_layers)

    ocr_lines: list[dict] = []
    ocr_warnings: list[str] = []
    if any(entry["kind"] == "text" for entry in entries):
        ocr_thread.join(OCR_TIMEOUT_SECONDS)
        if ocr_thread.is_alive():
            ocr_warnings.append("OCR 超过 %ds 未返回，文字位置改用模型框" % OCR_TIMEOUT_SECONDS)
        else:
            ocr_lines, ocr_warnings = ocr_holder.get("value", ([], []))
            ocr_lines = text.merge_lines(ocr_lines)

    matte_rgba = None
    matte_reason = ""
    if any(semantics.is_object_role(entry["role"]) for entry in entries):
        matte_thread.join(MATTE_TIMEOUT_SECONDS)
        if matte_thread.is_alive():
            matte_reason = "抠图推理超过 %ds 未返回" % MATTE_TIMEOUT_SECONDS
        else:
            matte_rgba, matte_reason = matte_holder.get("value", (None, "抠图没有返回结果"))

    drafts: list[Draft] = []
    background_entries: list[dict] = []
    warnings: list[str] = []
    object_union = np.zeros((work_h, work_w), dtype=np.uint8)
    subject_union = np.zeros((work_h, work_w), dtype=np.uint8)
    text_union = np.zeros((work_h, work_w), dtype=np.uint8)
    text_font_scores: list[float] = []

    for entry in entries:
        if entry["role"] == semantics.ROLE_BACKGROUND:
            background_entries.append(entry)
            continue
        item = entry["item"]
        kind = entry["kind"]
        role = entry["role"]
        x, y, w, h = entry["bbox"]
        local = rgb[y : y + h, x : x + w]
        color = (
            regions.hex_color(np.median(local.reshape(-1, 3), axis=0))
            if local.size
            else "#FFFFFF"
        )
        layer_canvas = Image.new("RGBA", (work_w, work_h), (0, 0, 0, 0))
        layer_text = None
        style = None
        confidence = None
        draft_name = None
        draft_font = None
        draft_font_score = 0.0
        glyph_only = False

        if kind == "text":
            content_text = str(item.get("text") or "").strip()
            line = _match_ocr_line((x, y, w, h), ocr_lines)
            if line is not None:
                # OCR 的框比模型的目测框准，位置以它为准；内容仍以模型识别为主
                x, y, w, h = line["x"], line["y"], line["w"], line["h"]
                if not content_text:
                    content_text = line["text"]
            matte = text.build_text_matte(rgb, (x, y, w, h))
            if matte is None and line is not None:
                matte = text.build_text_matte(
                    rgb,
                    (line["x"], line["y"], line["w"], line["h"]),
                    4,
                )
            if matte is None:
                warnings.append("文字「%s」没检测到笔画，已跳过" % (content_text[:10] or "未识别"))
                continue
            layer_canvas.paste(Image.fromarray(matte["rgba"], "RGBA"), (matte["x"], matte["y"]))
            color = matte["color"]
            np.maximum(text_union, _text_removal_mask(rgb, matte, (x, y, w, h)), out=text_union)
            layer_text = content_text or None
            if not content_text:
                # 视觉模型和 OCR 都没读出字：保留字形当作「文字图形」图片层，至少视觉不丢
                tight = _alpha_bbox(matte["rgba"][..., 3].astype(np.float32) / 255.0)
                if tight:
                    x = matte["x"] + tight[0]
                    y = matte["y"] + tight[1]
                    w, h = tight[2], tight[3]
                kind = "image"
                role = semantics.ROLE_LOGO
                draft_name = "文字图形"
                glyph_only = True
            else:
                ink_height = text.ink_height(matte["rgba"])
                family, font_score = fonts.resolve(
                    content_text, matte["rgba"][..., 3], matte["density"]
                )
                text_font_scores.append(font_score)
                draft_font = family
                draft_font_score = font_score
                style = _style(item.get("style"), color, ink_height, family, content_text, float(w))
                try:
                    confidence = round(
                        min(
                            0.99,
                            max(
                                0.0,
                                float(item.get("confidence") or (0.55 + 0.4 * font_score)),
                            ),
                        ),
                        2,
                    )
                except (TypeError, ValueError):
                    confidence = 0.8
                draft_name = semantics.clean_name(None, semantics.ROLE_TEXT, content_text)

        elif semantics.is_object_role(role):
            keep = None
            if matte_rgba is not None:
                keep = _object_keep(matte_rgba[..., 3].astype(np.float32) / 255.0, (x, y, w, h))
            if keep is None:
                keep = regions.grabcut_cutout(rgb, (x, y, w, h))
            if keep is not None:
                alpha_u8 = np.where(keep > 0.02, (keep * 255.0), 0).astype(np.uint8)
                if matte_rgba is not None:
                    src = matte_rgba.copy()
                    src[..., 3] = alpha_u8
                else:
                    src = np.dstack([rgb, alpha_u8])
                src[alpha_u8 == 0] = 0
                layer_canvas = Image.fromarray(src, "RGBA")
                solid = alpha_u8 >= 200
                if solid.any():
                    color = regions.hex_color(np.median(rgb[solid], axis=0))
                tight = _alpha_bbox(alpha_u8.astype(np.float32) / 255.0)
                if tight:
                    x, y, w, h = tight
                # 主体/道具都要从背景挖掉：挪走后原位是补好的底图，不是重影
                np.maximum(object_union, alpha_u8, out=object_union)
                if role == semantics.ROLE_SUBJECT:
                    np.maximum(subject_union, alpha_u8, out=subject_union)
            else:
                _paste_rect(layer_canvas, local, x, y)
                warnings.append(
                    "「%s」没能自动抠出来，已按矩形拆分（可在编辑器里再修）" % (item.get("name") or "图层")
                )
            draft_name = semantics.clean_name(item.get("name"), role, None, len(drafts) + 1)

        else:
            _paste_rect(layer_canvas, local, x, y)
            draft_name = semantics.clean_name(item.get("name"), role, None, len(drafts) + 1)

        draft = Draft(
                name=draft_name or semantics.clean_name(None, role, layer_text),
                kind=kind,
                role=role,
                png=layer_canvas,
                bbox=(
                    int(round(x * loaded.up_x)),
                    int(round(y * loaded.up_y)),
                    int(round(w * loaded.up_x)),
                    int(round(h * loaded.up_y)),
                ),
                color=color,
                area=w * h,
                text=layer_text,
                style=style,
                confidence=confidence,
            )
        if draft_font:
            draft.font_score = draft_font_score
        if glyph_only:
            draft.glyph_only = True
        drafts.append(draft)

    # 同一张稿子统一字体，避免逐行各认一套导致排版很乱
    text_only = [draft for draft in drafts if draft.kind == "text"]
    if text_only:
        applied = fonts.harmonize(text_only)
        if applied:
            labels = [("中文" if key == "cjk" else "英文") + "「%s」" % value for key, value in applied.items()]
            warnings.append("文字字体识别：" + "、".join(labels))

    # 文字整行落在主体身上（商品标签等）：不单独出层，否则移动主体时文字留在原地
    if subject_union.any():
        kept: list[Draft] = []
        for draft in drafts:
            if draft.kind != "text":
                kept.append(draft)
                continue
            x, y, w, h = draft.bbox
            x0 = max(0, int(round(x / loaded.up_x)))
            y0 = max(0, int(round(y / loaded.up_y)))
            x1 = min(work_w, int(round((x + w) / loaded.up_x)))
            y1 = min(work_h, int(round((y + h) / loaded.up_y)))
            patch = subject_union[y0:y1, x0:x1]
            if patch.size and float((patch > 128).mean()) > 0.85:
                continue
            kept.append(draft)
        drafts = kept

    # 装饰块/道具里印着的原字也抹掉，否则文字层重排在旁边会看成双影
    if text_union.any():
        clean_mask = ndimage.binary_dilation(text_union > 40, iterations=2)
        for draft in drafts:
            if draft.kind != "image" or getattr(draft, "glyph_only", False):
                continue
            if draft.role not in {
                semantics.ROLE_DECORATION,
                semantics.ROLE_PROP,
                semantics.ROLE_SCENE,
            }:
                continue
            rgba = np.asarray(draft.png)
            if rgba.ndim != 3 or rgba.shape[2] != 4:
                continue
            alpha = rgba[..., 3] > 0
            hit = clean_mask & alpha
            if not hit.any():
                continue
            rest = alpha & ~clean_mask
            source = rgba[rest] if rest.any() else rgba[alpha]
            if source.size == 0:
                continue
            color = np.median(source[:, :3], axis=0).astype(np.uint8)
            cleaned = rgba.copy()
            cleaned[hit, :3] = color
            draft.png = Image.fromarray(cleaned, "RGBA")

    hole_alpha = np.maximum(object_union, text_union)
    filled_rgb = None
    inpaint_warnings: list[str] = []
    if background_entries and hole_alpha.any() and inpaint.enabled():
        filled_rgb, inpaint_reason = inpaint.fill_background(rgb, hole_alpha > 0)
        if inpaint_reason:
            inpaint_warnings.append(inpaint_reason)
    for entry in background_entries:
        drafts.append(_background_layer(entry, rgb, loaded.up_x, loaded.up_y, hole_alpha, filled_rgb))

    if len(drafts) < 2:
        raise RuntimeError("vision 返回图层不足 2 层")

    # 背景压底；其余按角色层级排（场景 < 装饰 < 道具 < 主体 < 标识 < 文字）
    drafts.sort(key=lambda draft: (semantics.z_for(draft.role), -draft.area))
    semantics.ensure_unique(drafts)

    result_warnings = ["vision 引擎结果依赖所接模型，生成质量可能不稳定"]
    if matte_reason:
        result_warnings.append("本地抠图模型不可用（%s），主体层已按矩形拆分" % matte_reason)
    if ocr_warnings:
        result_warnings.extend(ocr_warnings)
    result_warnings.extend(warnings)
    result_warnings.extend(inpaint_warnings)
    if text_font_scores:
        matched = sum(1 for score in text_font_scores if score >= 0.45)
        result_warnings.append(
            "字体识别：%d/%d 个文字层匹配到本机字体" % (matched, len(text_font_scores))
        )
    if (sent_w, sent_h) != (work_w, work_h):
        result_warnings.append(
            "参考图已压缩到 %dx%d（质量 %d）以适配接口请求体上限" % (sent_w, sent_h, quality)
        )
    return drafts, result_warnings, "vision"
