from __future__ import annotations

import numpy as np
from PIL import Image
from scipy import ndimage

from .text import hex_color

COLOR_LIBRARY = {
    "white": (250, 250, 250),
    "black": (18, 18, 18),
    "red": (220, 48, 48),
    "blue": (20, 80, 180),
    "green": (30, 170, 96),
    "yellow": (240, 200, 40),
    "orange": (240, 130, 40),
    "purple": (130, 90, 200),
    "pink": (238, 150, 180),
    "cream": (248, 243, 240),
    "gray": (128, 128, 128),
    "beige": (232, 220, 200),
}


def color_name(rgb) -> str:
    values = np.asarray(rgb, dtype=np.float32)
    best_name, best_distance = "色块", 1e9
    for name, reference in COLOR_LIBRARY.items():
        distance = float(np.linalg.norm(values - np.asarray(reference, dtype=np.float32)))
        if distance < best_distance:
            best_name, best_distance = name, distance
    return best_name


def quantized_indices(rgb: np.ndarray, colors: int = 10) -> tuple[np.ndarray, np.ndarray]:
    quantized = Image.fromarray(rgb).quantize(
        colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    palette = np.asarray(quantized.getpalette(), dtype=np.uint8).reshape(-1, 3)[:colors]
    return np.asarray(quantized), palette


def dominant_color(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    pixels = rgb[mask]
    if pixels.size == 0:
        pixels = rgb.reshape(-1, 3)
    return np.median(pixels, axis=0)


def inpaint_glyphs(rgb: np.ndarray, glyph_mask: np.ndarray) -> np.ndarray:
    if not glyph_mask.any():
        return rgb
    nearest = ndimage.distance_transform_edt(
        glyph_mask, return_distances=False, return_indices=True
    )
    filled = rgb.copy()
    filled[glyph_mask] = rgb[nearest[0][glyph_mask], nearest[1][glyph_mask]]
    return filled


def _fill_small_holes(mask: np.ndarray, region_area: int) -> np.ndarray:
    filled = ndimage.binary_fill_holes(mask)
    holes = filled & ~mask
    if not holes.any():
        return mask
    labels, count = ndimage.label(holes)
    sizes = np.bincount(labels.ravel())
    limit = max(64, int(region_area * 0.004))
    keep = mask.copy()
    for index in range(1, count + 1):
        if sizes[index] < limit:
            keep |= labels == index
    return keep


def extract_blocks(
    rgb: np.ndarray,
    region_mask: np.ndarray,
    max_blocks: int = 3,
    min_ratio: float = 0.02,
) -> list[dict]:
    region_area = max(1, int(region_mask.sum()))
    indices, palette = quantized_indices(rgb)
    blocks: list[dict] = []
    for index in range(len(palette)):
        mask = (indices == index) & region_mask
        if int(mask.sum()) < min_ratio * region_area:
            continue
        labels, count = ndimage.label(mask)
        if count == 0:
            continue
        sizes = np.bincount(labels.ravel())
        slices = ndimage.find_objects(labels)
        for label_index in range(1, count + 1):
            area = int(sizes[label_index])
            if area < min_ratio * region_area:
                continue
            window = slices[label_index - 1]
            if window is None:
                continue
            y_slice, x_slice = window
            component = labels[window] == label_index
            component = _fill_small_holes(component, region_area)
            component = ndimage.binary_dilation(
                component, structure=np.ones((3, 3), dtype=bool), iterations=1
            )
            blocks.append(
                {
                    "mask": component,
                    "offset": (int(x_slice.start), int(y_slice.start)),
                    "area": area,
                    "color": palette[index],
                    "bbox": (
                        int(x_slice.start),
                        int(y_slice.start),
                        int(x_slice.stop - x_slice.start),
                        int(y_slice.stop - y_slice.start),
                    ),
                }
            )
    blocks.sort(key=lambda block: -block["area"])
    return blocks[:max_blocks]


def full_mask(block: dict, shape: tuple[int, int]) -> np.ndarray:
    mask = np.zeros(shape, dtype=bool)
    x, y = block["offset"]
    component = block["mask"]
    mask[y : y + component.shape[0], x : x + component.shape[1]] = component
    return mask


def build_block_layer(rgb: np.ndarray, block: dict, shape: tuple[int, int]) -> Image.Image:
    mask = full_mask(block, shape)
    rgba = np.zeros((shape[0], shape[1], 4), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.where(mask, 255, 0).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def extract_objects(
    rgb: np.ndarray,
    block_masks: list[np.ndarray],
    region_mask: np.ndarray,
    min_ratio: float = 0.005,
    max_objects: int = 8,
) -> list[dict]:
    region_area = max(1, int(region_mask.sum()))
    foreground = region_mask.copy()
    for mask in block_masks:
        foreground &= ~mask

    structure = np.ones((3, 3), dtype=bool)
    foreground = ndimage.binary_opening(foreground, structure=structure, iterations=1)
    foreground = ndimage.binary_closing(foreground, structure=structure, iterations=1)

    labels, count = ndimage.label(foreground)
    if count == 0:
        return []
    sizes = np.bincount(labels.ravel())
    slices = ndimage.find_objects(labels)
    objects: list[dict] = []
    for label_index in range(1, count + 1):
        area = int(sizes[label_index])
        if area < min_ratio * region_area:
            continue
        window = slices[label_index - 1]
        if window is None:
            continue
        y_slice, x_slice = window
        component = labels[window] == label_index
        objects.append(
            {
                "mask": component,
                "offset": (int(x_slice.start), int(y_slice.start)),
                "area": area,
                "bbox": (
                    int(x_slice.start),
                    int(y_slice.start),
                    int(x_slice.stop - x_slice.start),
                    int(y_slice.stop - y_slice.start),
                ),
            }
        )
    objects.sort(key=lambda item: -item["area"])
    return objects[:max_objects]


def build_object_layer(rgb: np.ndarray, item: dict, shape: tuple[int, int]) -> Image.Image:
    mask = full_mask(item, shape)
    mask = ndimage.binary_dilation(mask, structure=np.ones((3, 3), dtype=bool), iterations=1)
    alpha = ndimage.gaussian_filter(mask.astype(np.float32), sigma=0.7)
    rgba = np.zeros((shape[0], shape[1], 4), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def full_region_layer(
    rgb: np.ndarray, region_mask: np.ndarray, shape: tuple[int, int]
) -> Image.Image:
    rgba = np.zeros((shape[0], shape[1], 4), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = np.where(region_mask, 255, 0).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def layer_color(rgb: np.ndarray, mask: np.ndarray) -> str:
    return hex_color(dominant_color(rgb, mask))


def grabcut_cutout(
    rgb: np.ndarray, bbox: tuple[int, int, int, int], iterations: int = 3
) -> np.ndarray | None:
    """抠图模型没命中时（扁平插画/纯色块常见）用 GrabCut 兜底，返回 0~1 alpha。

    只在 bbox 内做，跑得很快；整块都被判成前景（等于没切）或几乎没有前景时返回 None，
    让调用方退回矩形层，避免把背景整片抠进主体层。
    """
    try:
        import cv2
    except Exception:  # noqa: BLE001 - 没有 cv2 就走矩形层
        return None

    image_h, image_w = rgb.shape[:2]
    x, y, w, h = (int(round(value)) for value in bbox)
    x = max(0, min(x, image_w - 2))
    y = max(0, min(y, image_h - 2))
    w = max(2, min(w, image_w - x))
    h = max(2, min(h, image_h - y))

    mask = np.zeros((image_h, image_w), np.uint8)
    background = np.zeros((1, 65), np.float64)
    foreground = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(
            np.ascontiguousarray(rgb),
            mask,
            (x, y, w, h),
            background,
            foreground,
            iterations,
            cv2.GC_INIT_WITH_RECT,
        )
    except Exception:  # noqa: BLE001
        return None

    inside = np.zeros((image_h, image_w), bool)
    inside[y : y + h, x : x + w] = True
    solid = np.isin(mask, (cv2.GC_FGD, cv2.GC_PR_FGD)) & inside
    ratio = float(solid.sum()) / float(w * h)
    if ratio < 0.02 or ratio > 0.97:
        return None

    labels, count = ndimage.label(solid)
    if count == 0:
        return None
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    keep = labels == int(sizes.argmax())
    alpha = ndimage.gaussian_filter(keep.astype(np.float32), 0.8)
    alpha[~inside] = 0.0
    return np.clip(alpha, 0.0, 1.0)
