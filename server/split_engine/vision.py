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

from . import config, inpaint, matting, regions, text
from .heuristic import Draft
from .image_io import LoadedImage

SYSTEM_PROMPT = (
    "You split a flat design image into editable layers. "
    "Always answer with a single JSON object and nothing else."
)

REPLY_SHAPE = (
    '{"layers":[{"name":"...","type":"text"|"image",'
    '"role":"background"|"block"|"object","bbox":[x,y,w,h],'
    '"text":"...", "style":{"color":"#FFFFFF","fontSize":48,"fontWeight":400,'
    '"align":"left|center|right"},"confidence":0.9}]}'
)

# 模型漏给 role 时按名字兜底：这些词只会出现在「要单独抠出来」的主体层上
_OBJECT_NAME_KEYWORDS = (
    "model",
    "person",
    "模特",
    "人物",
    "主体",
    "商品",
    "产品",
    "product",
    "subject",
    "前景",
)

_ROLES = {"background", "block", "object"}

BODY_LIMIT = 900 * 1024
# 网关请求体约 1MB；首次按原图发，超限时降两档再试。
_FALLBACK_TIERS = ((0.78, 82), (0.55, 72))

# 抠图线程最长等这么久：模型异常时宁可退回矩形层，也不能把请求挂死
MATTE_TIMEOUT_SECONDS = 120


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
        f"图片尺寸 {width}x{height} 像素。把画面拆成适合编辑的图层，最多 {max_layers} 层，"
        "背景层放最前（z 最低）。bbox 为图片像素坐标 [x,y,w,h]。"
        "文字层是硬要求：画面里所有可读文字（哪怕很小，如衣角/裙摆上的 logo）都必须单独输出 "
        "type=text 层，给出准确 text 与 style（color/fontSize/fontWeight/align），"
        "不要并入背景层或主体层；role 只对 type=image 的层填写。"
        "图形层 type=image，必须判断 role：background=铺满整幅的背景；"
        "block=纯色块/卡片/装饰这类矩形区域；"
        "object=人物、模特、商品、主体、前景这类独立物体，bbox 只框住它自己"
        "（它会被抠成透明 PNG，框太小会把主体切掉）。"
    )
    if prompt:
        instruction += f"用户要求：{prompt}。"
    if selection:
        instruction += f"只拆分选区 {selection} 内的内容。"
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


def _style(raw: dict | None, fallback_color: str, height: int) -> dict:
    raw = raw or {}
    color = str(raw.get("color") or fallback_color)
    if not re.match(r"^#[0-9A-Fa-f]{6}$", color):
        color = fallback_color
    align = str(raw.get("align") or "center")
    if align not in {"left", "center", "right"}:
        align = "center"
    try:
        font_size = int(raw.get("fontSize") or round(height * 0.8))
    except (TypeError, ValueError):
        font_size = round(height * 0.8)
    try:
        font_weight = int(raw.get("fontWeight") or 400)
    except (TypeError, ValueError):
        font_weight = 400
    return {
        "color": color.upper(),
        "strokeColor": None,
        "strokeWidth": 0,
        "fontFamily": "Inter",
        "fontWeight": max(100, min(900, font_weight)),
        "fontSize": max(8, font_size),
        "letterSpacing": 0,
        "lineHeight": 1.1,
        "align": align,
        "opacity": 1,
    }


def _role(raw, kind: str, index: int, name: str) -> str:
    if kind == "text":
        return "text"
    value = str(raw or "").strip().lower()
    if value in _ROLES:
        return value
    lowered = str(name or "").lower()
    if any(word in lowered for word in _OBJECT_NAME_KEYWORDS):
        return "object"
    # 老模型不返回 role：沿用「返回顺序第 0 层是背景」
    return "background" if index == 0 else "block"


def _paste_rect(canvas: Image.Image, local: np.ndarray, x: int, y: int) -> None:
    h, w = local.shape[:2]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = local
    rgba[..., 3] = 255
    canvas.paste(Image.fromarray(rgba, "RGBA"), (x, y))


def _object_keep(alpha: np.ndarray, bbox: tuple[int, int, int, int]) -> np.ndarray | None:
    """本层要保留的 alpha：框内 mask 作种子，再补全与它连通的整个主体。

    vision 的 bbox 是目测框，实测比主体小（把脚切在框外）；直接 matte∩bbox 会把人锯断，
    整幅照搬又会把另一个主体也塞进这一层，所以按连通域取「框里那个主体」的全部像素。
    框内连一个实心像素都没有（模型抠偏/漏检）时返回 None，由调用方退回矩形层。
    """
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
    """背景里要抹掉的文字区域（u8，255=抹掉）：文字 bbox 整块 + matte + bbox 外的同行文字。

    文字层会再叠一遍，背景里留着原字就是「保存后重影」，所以文字像素必须一起补掉。
    不能只靠 matte：抗锯齿/描边/发光像素会漏（实测鞋海报标题 bbox 只有实际宽度的一半，
    matte 也只盖住半行）；bbox 外扩一圈整块补掉，再用同文字色的高对比像素把溢出部分捞回来。
    """
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

    # 溢出 bbox 的同一行文字：文字色 + 局部高对比（平滑背景/渐变不会被选中）
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
            # 只认字块尺寸的连通域：大块（背景高光/物体）不要
            if area < 40 or ch < 6 or ch > h * 1.5 or cw > h * 4:
                continue
            glyphs |= labels == index
    if glyphs.any():
        # vision 的 bbox 可能只框住半行（实测标题 450 vs 实际 738），把检测到的整行文字
        # 外接框也整块补掉：字形描边、发光、阴影一起吃进去，边缘才干净（只补字形会留残字）。
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
    """背景层：主体/文字位置默认挖成透明洞；补背景可用时改成补好的不透明底图。

    不挖洞/不补洞的话，把主体层挪走时原地还留着一份一模一样的主体，用户会认为根本没分开。
    补洞后背景是一张能直接继续用的完整底图（Lovart 效果），挖洞版则靠叠回原图保持一致。
    """
    item = entry["item"]
    x, y, w, h = entry["bbox"]
    work_h, work_w = rgb.shape[:2]
    local = rgb[y : y + h, x : x + w]
    color = (
        regions.hex_color(np.median(local.reshape(-1, 3), axis=0)) if local.size else "#FFFFFF"
    )
    base = rgb if filled_rgb is None else filled_rgb
    rgba = np.dstack([base, np.full((work_h, work_w), 255, dtype=np.uint8)])
    if filled_rgb is None and hole_alpha.any():
        rgba[..., 3] = 255 - hole_alpha
    return Draft(
        name=str(item.get("name") or f"图层 {entry['index'] + 1}")[:24],
        kind="image",
        role="background",
        png=Image.fromarray(rgba, "RGBA"),
        bbox=(
            int(round(x * up_x)),
            int(round(y * up_y)),
            int(round(w * up_x)),
            int(round(h * up_y)),
        ),
        color=color,
        area=w * h,
    )


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

    # 编辑器对拆分请求只有 30s：vision 接口本身 5~20s，抠图还要 10~17s，
    # 串行会顶到超时。两者互不依赖，所以先并行跑抠图，拿到图层后再决定用不用它。
    matte_holder: dict = {}

    def run_matte() -> None:
        try:
            matte_holder["value"] = matting.foreground_rgba(loaded)
        except Exception as exc:  # noqa: BLE001 - 线程里的异常不能冒到请求
            matte_holder["value"] = (None, "抠图推理异常（%s）" % str(exc)[:160])

    matte_thread = threading.Thread(target=run_matte, name="split-matte", daemon=True)
    matte_thread.start()

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

    selected = [item for item in items if isinstance(item, dict)][:max_layers]
    entries: list[dict] = []
    for index, item in enumerate(selected):
        kind = "text" if str(item.get("type")) == "text" else "image"
        x, y, w, h = _bbox(item.get("bbox"), sent_w, sent_h)
        if (sent_w, sent_h) != (work_w, work_h):
            x, y, w, h = _bbox(
                [
                    x * work_w / sent_w,
                    y * work_h / sent_h,
                    w * work_w / sent_w,
                    h * work_h / sent_h,
                ],
                work_w,
                work_h,
            )
        entries.append(
            {
                "index": index,
                "item": item,
                "kind": kind,
                "role": _role(item.get("role"), kind, index, item.get("name")),
                "bbox": (x, y, w, h),
            }
        )

    # 没有主体层就不用抠图结果（并行算出来的那份直接丢弃）
    matte_rgba = None
    matte_reason = ""
    if any(entry["role"] == "object" for entry in entries):
        matte_thread.join(MATTE_TIMEOUT_SECONDS)
        if matte_thread.is_alive():
            matte_reason = "抠图推理超过 %ds 未返回" % MATTE_TIMEOUT_SECONDS
        else:
            matte_rgba, matte_reason = matte_holder.get("value", (None, "抠图没有返回结果"))

    drafts: list[Draft] = []
    background_entries: list[dict] = []
    object_warnings: list[str] = []
    # 背景挖洞用：主体层 + 文字层 alpha 的并集（u8，保证 图层 + 背景 = 255）
    object_union = np.zeros((work_h, work_w), dtype=np.uint8)
    text_union = np.zeros((work_h, work_w), dtype=np.uint8)
    for entry in entries:
        if entry["role"] == "background":
            # 要等所有主体 mask 都算完才知道挖哪些洞，先记下来最后建层
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
        if kind == "text":
            matte = text.build_text_matte(rgb, (x, y, w, h))
            if matte:
                layer_canvas.paste(Image.fromarray(matte["rgba"], "RGBA"), (matte["x"], matte["y"]))
                color = matte["color"]
                np.maximum(
                    text_union, _text_removal_mask(rgb, matte, (x, y, w, h)), out=text_union
                )
            else:
                _paste_rect(layer_canvas, local, x, y)
            layer_text = str(item.get("text") or item.get("name") or "").strip() or None
            style = _style(item.get("style"), color, int(round(h * loaded.up_y)))
            try:
                confidence = round(min(0.99, max(0.0, float(item.get("confidence") or 0.8))), 2)
            except (TypeError, ValueError):
                confidence = 0.8
        elif role == "object" and matte_rgba is not None:
            keep = _object_keep(matte_rgba[..., 3].astype(np.float32) / 255.0, (x, y, w, h))
            if keep is None:
                _paste_rect(layer_canvas, local, x, y)
                object_warnings.append(
                    "主体层「%s」抠图未命中（模型没在该区域找到主体），已按矩形拆分"
                    % str(item.get("name") or "主体")
                )
            else:
                alpha_u8 = np.where(keep > 0, matte_rgba[..., 3], 0).astype(np.uint8)
                object_union = np.maximum(object_union, alpha_u8)
                rgba = matte_rgba.copy()
                rgba[..., 3] = alpha_u8
                rgba[alpha_u8 == 0] = 0
                layer_canvas = Image.fromarray(rgba, "RGBA")
                solid = alpha_u8 >= 200
                if solid.any():
                    color = regions.hex_color(np.median(rgb[solid], axis=0))
                tight = _alpha_bbox(alpha_u8.astype(np.float32) / 255.0)
                if tight:
                    x, y, w, h = tight
        else:
            _paste_rect(layer_canvas, local, x, y)

        bbox_orig = (
            int(round(x * loaded.up_x)),
            int(round(y * loaded.up_y)),
            int(round(w * loaded.up_x)),
            int(round(h * loaded.up_y)),
        )
        drafts.append(
            Draft(
                name=str(item.get("name") or layer_text or f"图层 {entry['index'] + 1}")[:24],
                kind=kind,
                role=role,
                png=layer_canvas,
                bbox=bbox_orig,
                color=color,
                area=w * h,
                text=layer_text,
                style=style,
                confidence=confidence,
            )
        )

    # 背景放在最后建（要等主体/文字 mask 齐），再排到 z 最低
    hole_alpha = np.maximum(object_union, text_union)
    filled_rgb = None
    inpaint_warnings: list[str] = []
    if background_entries and hole_alpha.any() and inpaint.enabled():
        # 主体和文字都要从背景里补掉：主体挪走后原地要是能继续用的底图，文字否则会叠成重影
        filled_rgb, inpaint_reason = inpaint.fill_background(rgb, hole_alpha > 0)
        if inpaint_reason:
            inpaint_warnings.append(inpaint_reason)
    for entry in background_entries:
        drafts.append(
            _background_layer(
                entry, rgb, loaded.up_x, loaded.up_y, hole_alpha, filled_rgb
            )
        )

    if len(drafts) < 2:
        raise RuntimeError("vision 返回图层不足 2 层")
    # 背景层必须压在最下面：模型可能把背景放在返回列表的任意位置
    drafts.sort(key=lambda draft: 0 if draft.role == "background" else 1)
    warnings = ["vision 引擎结果依赖所接模型，生成质量可能不稳定"]
    if matte_reason:
        warnings.append("本地抠图模型不可用（%s），主体层已按矩形拆分" % matte_reason)
    warnings.extend(object_warnings)
    warnings.extend(inpaint_warnings)
    if (sent_w, sent_h) != (work_w, work_h):
        warnings.append(
            "参考图已压缩到 %dx%d（质量 %d）以适配接口请求体上限" % (sent_w, sent_h, quality)
        )
    return drafts, warnings, "vision"
