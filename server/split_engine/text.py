from __future__ import annotations

import numpy as np
from scipy import ndimage


def is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x3400 <= code <= 0x4DBF
        or 0x4E00 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0x3000 <= code <= 0x303F
    )


def has_content(text: str) -> bool:
    return any(ch.isalnum() or is_cjk(ch) for ch in text)


def _join(prev: str, word: str) -> str:
    if not prev:
        return word
    if is_cjk(prev[-1]) or is_cjk(word[0]):
        return prev + word
    return prev + " " + word


def _same_line(a: dict, b: dict, max_gap_ratio: float = 1.8, min_overlap: float = 0.5) -> bool:
    overlap = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    if overlap <= min_overlap * min(a["h"], b["h"]):
        return False
    if a["x"] <= b["x"]:
        gap = b["x"] - (a["x"] + a["w"])
    else:
        gap = a["x"] - (b["x"] + b["w"])
    return max(0, gap) <= max_gap_ratio * max(a["h"], b["h"])


def merge_words(words: list[dict]) -> list[dict]:
    if not words:
        return []
    count = len(words)
    parent = list(range(count))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        root_left, root_right = find(left), find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for left in range(count):
        for right in range(left + 1, count):
            if _same_line(words[left], words[right]):
                union(left, right)

    groups: dict[int, list[dict]] = {}
    for index in range(count):
        groups.setdefault(find(index), []).append(words[index])

    lines: list[dict] = []
    for group in groups.values():
        group.sort(key=lambda item: item["x"])
        content = ""
        chars = 0
        weighted_conf = 0.0
        for word in group:
            content = _join(content, word["text"])
            chars += len(word["text"])
            weighted_conf += word["conf"] * len(word["text"])
        content = content.strip()
        if not content:
            continue
        x0 = min(word["x"] for word in group)
        y0 = min(word["y"] for word in group)
        x1 = max(word["x"] + word["w"] for word in group)
        y1 = max(word["y"] + word["h"] for word in group)
        lines.append(
            {
                "x": x0,
                "y": y0,
                "w": x1 - x0,
                "h": y1 - y0,
                "text": content,
                "conf": weighted_conf / max(1, chars),
                "chars": chars,
            }
        )
    lines.sort(key=lambda line: (line["y"], line["x"]))
    return lines


def _iou(a: dict, b: dict) -> float:
    ax1, ay1, ax2, ay2 = a["x"], a["y"], a["x"] + a["w"], a["y"] + a["h"]
    bx1, by1, bx2, by2 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def lines_from_passes(passes: list[dict], duplicate_iou: float = 0.35) -> list[dict]:
    kept: list[dict] = []
    for index, item in enumerate(passes):
        lines = merge_words(item.get("words") or [])
        minimum = float(item.get("minLineConf") or 0.0)
        if minimum:
            lines = [line for line in lines if line["conf"] >= minimum]
        if index == 0:
            kept.extend(lines)
            continue
        for line in lines:
            if any(_iou(line, other) > duplicate_iou for other in kept):
                continue
            center_x = line["x"] + line["w"] / 2
            center_y = line["y"] + line["h"] / 2
            inside = any(
                other["x"] <= center_x <= other["x"] + other["w"]
                and other["y"] <= center_y <= other["y"] + other["h"]
                for other in kept
            )
            if inside:
                continue
            kept.append(line)
    kept.sort(key=lambda line: (line["y"], line["x"]))
    return kept


def dedupe_lines(lines: list[dict]) -> list[dict]:
    kept: list[dict] = []
    for line in sorted(lines, key=lambda item: -item["conf"]):
        if any(_iou(line, other) > 0.7 for other in kept):
            continue
        kept.append(line)
    kept.sort(key=lambda line: (line["y"], line["x"]))
    return kept


def hex_color(rgb) -> str:
    values = [int(round(min(255, max(0, float(channel))))) for channel in rgb]
    return "#{:02X}{:02X}{:02X}".format(*values)


def merge_lines(lines: list[dict]) -> list[dict]:
    """跨 OCR pass 的同一行会各出一段（「限时5」+「-立即抢购」），按行合并后再拆层。"""
    if not lines:
        return []
    return merge_words([dict(line) for line in lines])


def ink_height(rgba) -> float:
    rows = np.flatnonzero((rgba[..., 3] > 24).any(axis=1))
    if rows.size == 0:
        return float(rgba.shape[0])
    return float(rows[-1] - rows[0] + 1)


def estimate_font_size(content: str, ink_h: float, box_w: float) -> int:
    """字号同时受字形高度和行宽约束，避免换成本机字体后字比原稿宽一截。"""
    chars = [ch for ch in str(content or "") if not ch.isspace()]
    if not chars:
        return max(8, int(round(ink_h / 0.8)))
    cjk = sum(1 for ch in chars if is_cjk(ch))
    latin = max(0, len(chars) - cjk)
    by_height = ink_h / 0.8
    em_width = cjk * 1.0 + latin * 0.56
    by_width = (box_w * 0.98) / max(0.8, em_width)
    return max(8, int(round(min(by_height, by_width))))


def estimate_font_weight(density: float) -> int:
    if density >= 0.42:
        return 700
    if density >= 0.30:
        return 600
    if density >= 0.18:
        return 500
    return 400


def guess_font_family(text: str) -> str:
    if any(is_cjk(ch) for ch in text):
        return "Noto Sans SC"
    return "Inter"


def estimate_align(center_x: float, image_width: int) -> str:
    ratio = center_x / max(1, image_width)
    if ratio < 1 / 3:
        return "left"
    if ratio > 2 / 3:
        return "right"
    return "center"


def build_text_matte(rgb: np.ndarray, bbox: tuple[int, int, int, int], pad: int = 2) -> dict | None:
    image_h, image_w = rgb.shape[:2]
    x, y, width, height = (int(round(value)) for value in bbox)
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(image_w, x + width + pad)
    y1 = min(image_h, y + height + pad)
    if x1 - x0 < 3 or y1 - y0 < 3:
        return None

    crop = rgb[y0:y1, x0:x1].astype(np.float32)
    border = np.zeros(crop.shape[:2], dtype=bool)
    ring = min(2, crop.shape[0], crop.shape[1])
    border[:ring, :] = True
    border[-ring:, :] = True
    border[:, :ring] = True
    border[:, -ring:] = True
    background = np.median(crop[border], axis=0)

    diff = np.linalg.norm(crop - background, axis=2)
    low = float(np.percentile(diff, 10))
    high = float(np.percentile(diff, 96))
    span = max(16.0, high - low)
    alpha = np.clip((diff - low - 3.0) / span, 0.0, 1.0)
    alpha = ndimage.gaussian_filter(alpha, sigma=0.6)
    alpha = np.clip(alpha * 1.05, 0.0, 1.0)

    if int((alpha > 0.35).sum()) < 12:
        return None

    strong = alpha > 0.6
    source = crop[strong if strong.any() else alpha > 0.35]
    color = np.median(source, axis=0)

    labels, count = ndimage.label(alpha > 0.5)
    largest_ratio = 0.0
    if count:
        sizes = np.bincount(labels.ravel())[1:]
        largest_ratio = float(sizes.max()) / max(1, alpha.size)

    rgba = np.zeros((crop.shape[0], crop.shape[1], 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(np.round(color), 0, 255).astype(np.uint8)
    rgba[..., 3] = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)

    return {
        "x": x0,
        "y": y0,
        "rgba": rgba,
        "color": hex_color(color),
        "density": float((alpha > 0.5).mean()),
        "largestRatio": largest_ratio,
    }
