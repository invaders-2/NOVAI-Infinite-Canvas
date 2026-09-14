#!/usr/bin/env python3
"""NOVAI 桌面图标生成工具

从 static/images/logo.svg 生成白底黑 logo、圆角风格的桌面图标
（icon.ico，包含 16/32/48/128/256 多尺寸）。

构建环境要求：
    pip install pygame Pillow

运行：
    python tools/generate-icon.py
"""
import io
import os
import struct
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_PATH = os.path.join(ROOT, "static", "images", "logo.svg")
ICO_PATH = os.path.join(ROOT, "static", "images", "icon.ico")

# 图标参数
CANVAS_SIZE = 1024       # 主画布尺寸
LOGO_PADDING = 80        # logo 到画布边缘的距离
CORNER_RADIUS = 180      # 圆角半径（相对于 1024px）
ICO_SIZES = [16, 32, 48, 128, 256]


def _load_logo_pil() -> Image.Image:
    """用 pygame 加载 SVG 并转成 PIL Image（RGBA）。"""
    import pygame

    pygame.init()
    try:
        with open(SVG_PATH, "r", encoding="utf-8") as f:
            svg = f.read()

        # pygame 的 SVG 加载器需要显式 width/height，否则可能渲染为空
        if '<svg width=' not in svg:
            svg = svg.replace(
                '<svg viewBox="0 0 1024 1024"',
                '<svg width="1024" height="1024" viewBox="0 0 1024 1024"',
            )

        tmp_svg = os.path.join(ROOT, ".tmp_logo_for_icon.svg")
        with open(tmp_svg, "w", encoding="utf-8") as f:
            f.write(svg)

        try:
            surf = pygame.image.load(tmp_svg)
        finally:
            try:
                os.remove(tmp_svg)
            except OSError:
                pass

        pil = Image.frombytes("RGBA", surf.get_size(), pygame.image.tostring(surf, "RGBA"))
        return pil
    finally:
        pygame.quit()


def _build_ico(png_frames: list[bytes], sizes: list[int], output_path: str) -> None:
    """手动组装 PNG-in-ICO（Vista+ 支持，Windows 10/11 原生可用）。"""
    count = len(png_frames)
    header = struct.pack("<HHH", 0, 1, count)
    directory = b""
    data = b""
    data_offset = 6 + count * 16

    for sz, frame in zip(sizes, png_frames):
        # ICO 目录字段：0 表示 256
        w = 0 if sz >= 256 else sz
        h = 0 if sz >= 256 else sz
        directory += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(frame), data_offset)
        data += frame
        data_offset += len(frame)

    with open(output_path, "wb") as f:
        f.write(header + directory + data)


def generate_icon() -> None:
    """生成白底黑 logo 圆角桌面图标。"""
    if not os.path.isfile(SVG_PATH):
        print(f"❌ 未找到 logo SVG: {SVG_PATH}")
        sys.exit(1)

    print(f"Loading {SVG_PATH} ...")
    logo_pil = _load_logo_pil()
    print(f"  SVG rendered size: {logo_pil.size}")

    # 1. 白底画布
    base = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (255, 255, 255, 255))

    # 2. 居中缩放 logo（保持透明通道）
    logo_target = CANVAS_SIZE - LOGO_PADDING * 2
    logo_resized = logo_pil.resize((logo_target, logo_target), Image.LANCZOS)
    base.paste(logo_resized, (LOGO_PADDING, LOGO_PADDING), logo_resized)

    # 3. 应用圆角蒙版（四角透明）
    mask = Image.new("L", (CANVAS_SIZE, CANVAS_SIZE), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, CANVAS_SIZE, CANVAS_SIZE), radius=CORNER_RADIUS, fill=255)
    base.putalpha(mask)

    # 4. 生成各尺寸 PNG 帧
    png_frames = []
    for sz in ICO_SIZES:
        im = base.resize((sz, sz), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)
        png_frames.append(buf.getvalue())
        print(f"  Generated {sz}x{sz}")

    # 5. 写入 ICO
    _build_ico(png_frames, ICO_SIZES, ICO_PATH)
    print(f"✅ Saved {ICO_PATH}")


if __name__ == "__main__":
    generate_icon()
