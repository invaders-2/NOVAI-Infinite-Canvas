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
