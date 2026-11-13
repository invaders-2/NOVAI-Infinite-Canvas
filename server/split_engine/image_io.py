from __future__ import annotations

import base64
import binascii
import io
import re
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .errors import SplitError

MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000
MIN_SIDE = 16
MAX_LONG_SIDE = 3000

_DATA_URL_RE = re.compile(r"^data:([^,]*?),(.*)$", re.S | re.I)


@dataclass
class LoadedImage:
    work: Image.Image
    width: int
    height: int
    up_x: float
    up_y: float
    warnings: list[str] = field(default_factory=list)

    @property
    def work_size(self) -> tuple[int, int]:
        return self.work.size


def _decode(payload: str) -> bytes:
    if not isinstance(payload, str) or not payload.strip():
        raise SplitError("INVALID_ARGS", "image 不能为空")
    data = payload.strip()
    match = _DATA_URL_RE.match(data)
    if match:
        meta, body = match.group(1), match.group(2)
        if "base64" not in meta.lower():
            raise SplitError("INVALID_IMAGE", "dataURL 必须是 base64 编码")
        data = body
    data = re.sub(r"\s+", "", data)
    if len(data) > MAX_BYTES * 4 // 3 + 4096:
        raise SplitError("TOO_LARGE", f"图片超过 {MAX_BYTES // (1024 * 1024)}MB 上限", 413)
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SplitError("INVALID_IMAGE", f"base64 解码失败: {exc}") from exc
    if len(raw) > MAX_BYTES:
        raise SplitError("TOO_LARGE", f"图片超过 {MAX_BYTES // (1024 * 1024)}MB 上限", 413)
    if not raw:
        raise SplitError("INVALID_IMAGE", "图片数据为空")
    return raw


def load_image(payload: str) -> LoadedImage:
    raw = _decode(payload)
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except UnidentifiedImageError as exc:
        raise SplitError("INVALID_IMAGE", "无法识别图片格式，请上传 PNG/JPEG/WebP") from exc
    except (OSError, ValueError) as exc:
        raise SplitError("INVALID_IMAGE", f"图片已损坏或无法解析: {exc}") from exc

    image = ImageOps.exif_transpose(image)
    width, height = image.size
    if width < MIN_SIDE or height < MIN_SIDE:
        raise SplitError(
            "INVALID_IMAGE", f"图片太小（{width}×{height}），长宽至少 {MIN_SIDE}px"
        )
    if width * height > MAX_PIXELS:
        raise SplitError("TOO_LARGE", f"图片像素超过 {MAX_PIXELS} 上限（{width}×{height}）", 413)

    warnings: list[str] = []
    source = image.convert("RGBA")
    alpha = np.asarray(source.getchannel("A"))
    if alpha.size and float((alpha < 250).mean()) > 0.01:
        canvas = Image.new("RGBA", source.size, (255, 255, 255, 255))
        source = Image.alpha_composite(canvas, source)
        warnings.append("输入包含透明通道，已按白底合成后分析")

    work_width, work_height = source.size
    if max(work_width, work_height) > MAX_LONG_SIDE:
        ratio = MAX_LONG_SIDE / max(work_width, work_height)
        work_size = (max(1, round(work_width * ratio)), max(1, round(work_height * ratio)))
        work = source.resize(work_size, Image.LANCZOS)
        warnings.append(f"图片超过 {MAX_LONG_SIDE}px，已等比缩放到 {work_size[0]}×{work_size[1]} 分析")
    else:
        work = source

    return LoadedImage(
        work=work,
        width=work_width,
        height=work_height,
        up_x=work_width / work.width,
        up_y=work_height / work.height,
        warnings=warnings,
    )
