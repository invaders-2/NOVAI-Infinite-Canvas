from __future__ import annotations

from pathlib import Path

from PIL import Image

THUMB_SIZE = 96


def clamp_bbox(bbox, width: int, height: int) -> tuple[int, int, int, int]:
    x, y, w, h = (int(round(float(value))) for value in bbox)
    x = max(0, min(x, width - 1))
    y = max(0, min(y, height - 1))
    w = max(1, min(w, width - x))
    h = max(1, min(h, height - y))
    return x, y, w, h


def make_thumb(layer: Image.Image, bbox, width: int, height: int) -> Image.Image:
    x, y, w, h = clamp_bbox(bbox, width, height)
    crop = layer.crop((x, y, x + w, y + h))
    scale = THUMB_SIZE / max(1, max(crop.size))
    size = (max(1, round(crop.width * scale)), max(1, round(crop.height * scale)))
    return crop.resize(size, Image.LANCZOS)


def save_layer(
    job_dir: Path,
    layer_id: str,
    image: Image.Image,
    bbox,
    width: int,
    height: int,
) -> dict:
    canvas = image if image.size == (width, height) else image.resize((width, height), Image.LANCZOS)
    png_path = job_dir / f"{layer_id}.png"
    canvas.save(png_path, format="PNG", optimize=False)

    thumb_path = job_dir / f"{layer_id}.thumb.png"
    make_thumb(canvas, bbox, width, height).save(thumb_path, format="PNG", optimize=False)

    return {
        "png": png_path.name,
        "thumb": thumb_path.name,
        "pngBytes": png_path.stat().st_size,
    }
