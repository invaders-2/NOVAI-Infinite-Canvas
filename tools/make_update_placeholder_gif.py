#!/usr/bin/env python3
"""生成更新说明里用的占位演示 GIF：右下角更新卡片滑入 + 两个按钮（发版时替换成真实录屏）。

用法：python3 tools/make_update_placeholder_gif.py [版本号]   # 默认 2.0.07
输出：static/updates/<版本号>/update-card.gif
"""
import math
import os
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_VERSION = "2.0.07"
VERSION = DEFAULT_VERSION

W, H = 800, 450          # 成片尺寸（16:9）
SS = 2                   # 先按 2 倍画再缩，文字和圆角才有足够的抗锯齿
FRAMES, SLIDE, DELAY = 30, 15, 90
CARD_X, CARD_Y, CARD_W, CARD_H, CARD_R = 452, 300, 320, 122, 14

BG = (20, 20, 22)
CARD = (34, 34, 39)
TITLE = (245, 245, 247)
SUB = (154, 154, 164)
ACCENT = (58, 122, 246)
ACCENT_TEXT = (255, 255, 255)
GHOST = (46, 46, 52)
GHOST_TEXT = (214, 214, 220)

# 为什么不是一个字体：这台 macOS 没有 /System/Library/Fonts/PingFang.ttc，得按顺序退到其它系统中文黑体
FONT_CANDIDATES = [
    ("/System/Library/Fonts/PingFang.ttc", 0),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
    ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Songti.ttc", 0),
    ("/System/Library/Fonts/Helvetica.ttc", 0),
]
_fonts = {}


def px(value):
    return int(round(value * SS))


def box(x, y, w, h):
    return (px(x), px(y), px(x + w), px(y + h))


def load_font(size):
    key = px(size)
    if key in _fonts:
        return _fonts[key]
    for path, index in FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        for idx in {index, 0, 1, 2}:
            try:
                font = ImageFont.truetype(path, key, index=idx)
                if font.getbbox("新版本已就绪")[2] > key:
                    _fonts[key] = font
                    return font
            except Exception:
                continue
    _fonts[key] = ImageFont.load_default()
    return _fonts[key]


def draw_down_arrow(draw, x, y, color, width):
    draw.line((px(x), px(y - 4), px(x), px(y + 3)), fill=color, width=width)
    draw.line((px(x - 3.5), px(y + 0.5), px(x), px(y + 4), px(x + 3.5), px(y + 0.5)), fill=color, width=width, joint="curve")


def card_layer():
    layer = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    draw.rounded_rectangle(box(CARD_X, CARD_Y, CARD_W, CARD_H), radius=px(CARD_R), fill=CARD + (255,))

    draw.rounded_rectangle(box(472, 324, 30, 30), radius=px(9), fill=ACCENT + (255,))
    draw_down_arrow(draw, 487, 339, ACCENT_TEXT + (255,), 2 * SS)

    draw.text((px(512), px(321)), "新版本已就绪", font=load_font(20), fill=TITLE + (255,))
    draw.text((px(512), px(351)), "%s 已下载完成" % VERSION, font=load_font(13), fill=SUB + (255,))

    draw.rounded_rectangle(box(472, 382, 96, 30), radius=px(9), fill=ACCENT + (255,))
    draw.text((px(492), px(390)), "立即重启", font=load_font(14), fill=ACCENT_TEXT + (255,))
    draw.rounded_rectangle(box(580, 382, 64, 30), radius=px(9), fill=GHOST + (255,))
    draw.text((px(597), px(390)), "稍后", font=load_font(14), fill=GHOST_TEXT + (255,))
    return layer


def with_sheen(layer, center_x):
    mask = Image.new("L", layer.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box(CARD_X, CARD_Y, CARD_W, CARD_H), radius=px(CARD_R), fill=255)
    band = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(band)
    half = px(52)
    for offset in range(-half, half + 1):
        alpha = int(40 * (1 - abs(offset) / half))
        draw.line((center_x + offset, 0, center_x + offset, layer.size[1]), fill=(255, 255, 255, alpha))
    band.putalpha(ImageChops.multiply(band.split()[3], mask))
    out = layer.copy()
    out.alpha_composite(band)
    return out


def ease_out(p):
    return 1 - (1 - p) ** 3


def render(progress, sheen_x=None):
    base = Image.new("RGBA", (W * SS, H * SS), BG + (255,))
    layer = card_layer()
    if sheen_x is not None:
        layer = with_sheen(layer, sheen_x)
    offset = int(round((1 - progress) * 36 * SS))

    shadow = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    shadow.putalpha(layer.split()[3].filter(ImageFilter.GaussianBlur(px(9))).point(lambda a: int(a * 0.45 * progress)))
    base.alpha_composite(shadow, (0, offset + px(6)))

    faded = layer.copy()
    faded.putalpha(layer.split()[3].point(lambda a: int(a * progress)))
    base.alpha_composite(faded, (0, offset))
    return base.convert("RGB").resize((W, H), Image.LANCZOS)


def main():
    global VERSION
    if len(sys.argv) > 1:
        VERSION = sys.argv[1].strip() or DEFAULT_VERSION

    # 为什么滑入结束后还要扫一道高光：完全相同的相邻帧会被 GIF 优化合并，帧数掉到 24 以下
    frames = []
    for i in range(FRAMES):
        progress = ease_out(min(1.0, (i + 1) / SLIDE))
        sheen_x = None
        if i >= SLIDE - 1:
            step = (i - SLIDE + 1) / float(FRAMES - SLIDE)
            sheen_x = px(CARD_X - 60 + step * (CARD_W + 120))
        frames.append(render(progress, sheen_x))

    out = os.path.join(ROOT, "static", "updates", VERSION, "update-card.gif")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    # 为什么逐帧自适应调色板：共用一份调色板会把高光渐变压成一条条竖带
    gif_frames = [f.convert("P", palette=Image.Palette.ADAPTIVE, colors=256) for f in frames]
    gif_frames[0].save(out, save_all=True, append_images=gif_frames[1:], duration=DELAY, loop=0, optimize=True, disposal=1)
    print("wrote %s (%d frames, %.0f KB)" % (out, len(gif_frames), os.path.getsize(out) / 1024))


if __name__ == "__main__":
    main()
