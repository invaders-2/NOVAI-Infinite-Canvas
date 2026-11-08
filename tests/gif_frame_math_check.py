#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GIF 帧拼版数学：APIMart gpt-image-2.6 家族「size 是每帧像素」的整版四条约束。

跑法：
    cd NOVAI-v16 && NOVAI_DATA_DIR=/tmp/novai-gif-check ./venv/bin/python tests/gif_frame_math_check.py

覆盖：
  1. 8 种比例 × 6 种帧数：normalize_gif_frame_size 收敛后，
     整版单边 ≤3840 / 总像素 ≤8294400 / 比例 ≤3:1，每帧两边 16 的倍数，宽高比偏差 ≤1%；
  2. max_gif_frame_size 的返回值同样要满足上面四条（生产链路用的是 normalize，两者同一份数学）；
  3. 1536x2048 + 9 帧（现场 bug 尺寸）的收敛值，逐条打印四条约束；
  4. 帧数/帧间隔的默认与夹取、空/auto 尺寸、比例名换算。
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("NOVAI_DATA_DIR", tempfile.mkdtemp(prefix="novai-gif-frame-check-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402

MAX_EDGE = 3840
MAX_PIXELS = 8_294_400
FRAME_COUNTS = (2, 4, 8, 9, 12, 16)
# 参考像素都取大尺寸、16 对齐、比例精确，保证每条都真的走收敛而不是原样返回
RATIO_SIZES = {
    "1:1": (4096, 4096),
    "3:4": (3072, 4096),
    "4:3": (4096, 3072),
    "16:9": (4096, 2304),
    "9:16": (2304, 4096),
    "21:9": (4032, 1728),
    "3:1": (3840, 1280),
    "1:3": (1280, 3840),
}
FAILURES = []


def record(ok, label, detail=""):
    print(("[PASS] " if ok else "[FAIL] ") + label + ((" :: " + detail) if detail else ""))
    if not ok:
        FAILURES.append(label)


def sheet_limits(frame_width, frame_height, frame_count, frame_ratio):
    """返回 (cols, rows, 整版宽, 整版高, 拼版比例) 并核对四条约束，返回问题列表。"""
    cols, rows = main.gif_frame_layout(frame_count, frame_ratio)
    sheet_width, sheet_height = cols * frame_width, rows * frame_height
    problems = []
    if sheet_width > MAX_EDGE or sheet_height > MAX_EDGE:
        problems.append(f"单边超限 {sheet_width}x{sheet_height}")
    if sheet_width * sheet_height > MAX_PIXELS:
        problems.append(f"总像素超限 {sheet_width * sheet_height}")
    sheet_ratio = sheet_width / float(sheet_height)
    if sheet_ratio > 3 or sheet_ratio < 1 / 3.0:
        problems.append(f"拼版比例越界 {sheet_ratio:.3f}")
    if frame_width % 16 or frame_height % 16:
        problems.append(f"每帧不是 16 的倍数 {frame_width}x{frame_height}")
    if frame_width < 64 or frame_height < 64:
        problems.append(f"每帧小于 64 {frame_width}x{frame_height}")
    return cols, rows, sheet_width, sheet_height, sheet_ratio, problems


def check_frame_size(label, size, frame_count, user_ratio):
    frame_width, frame_height = main.parse_size_pair(size)
    cols, rows, sheet_width, sheet_height, sheet_ratio, problems = sheet_limits(
        frame_width, frame_height, frame_count, user_ratio)
    ratio_drift = abs((frame_width / float(frame_height)) / user_ratio - 1)
    if ratio_drift > 0.01:
        problems.append(f"宽高比偏差 {ratio_drift * 100:.2f}% > 1%")
    record(not problems, label,
           f"{size} -> 拼版 {cols}x{rows} = {sheet_width}x{sheet_height}"
           f"（{sheet_width * sheet_height} 像素，比例 {sheet_ratio:.3f}，偏差 {ratio_drift * 100:.2f}%）"
           + ("；" + "；".join(problems) if problems else ""))


def main_check():
    print("== 1. normalize_gif_frame_size：8 种比例 × 6 种帧数 ==")
    for ratio_label, (base_width, base_height) in RATIO_SIZES.items():
        user_ratio = base_width / float(base_height)
        for frame_count in FRAME_COUNTS:
            size = main.normalize_gif_frame_size(f"{base_width}x{base_height}", frame_count)
            check_frame_size(f"{ratio_label} × {frame_count} 帧", size, frame_count, user_ratio)

    print("\n== 2. max_gif_frame_size：同一矩阵，四条约束 + 16 对齐 ==")
    for ratio_label, (base_width, base_height) in RATIO_SIZES.items():
        user_ratio = base_width / float(base_height)
        for frame_count in FRAME_COUNTS:
            frame_width, frame_height = main.max_gif_frame_size(base_width, base_height, frame_count)
            check_frame_size(f"{ratio_label} × {frame_count} 帧 max", f"{frame_width}x{frame_height}",
                             frame_count, user_ratio)

    print("\n== 3. 现场尺寸 1536x2048 + 9 帧 ==")
    bug_size = main.normalize_gif_frame_size("1536x2048", 9)
    frame_width, frame_height = main.parse_size_pair(bug_size)
    cols, rows, sheet_width, sheet_height, sheet_ratio, problems = sheet_limits(
        frame_width, frame_height, 9, 1536 / 2048.0)
    print(f"实际每帧：{bug_size}（期望 832x1104）")
    print(f"拼版布局：{cols} 列 × {rows} 行 = {sheet_width}x{sheet_height}")
    checks = [
        (sheet_width <= MAX_EDGE and sheet_height <= MAX_EDGE,
         f"单边 ≤3840：{sheet_width}x{sheet_height}"),
        (sheet_width * sheet_height <= MAX_PIXELS,
         f"总像素 ≤8294400：{sheet_width * sheet_height}"),
        (1 / 3.0 <= sheet_ratio <= 3, f"拼版比例 ≤3:1：{sheet_ratio:.3f}"),
        (frame_width % 16 == 0 and frame_height % 16 == 0,
         f"每帧两边 16 的倍数：{frame_width} / {frame_height}"),
    ]
    for ok, label in checks:
        record(ok, "  1536x2048 约束 :: " + label)
    record(bug_size == "832x1104", "  收敛值等于 832x1104", bug_size)
    record(not problems, "  四条约束总检", "；".join(problems) or "全部满足")
    max_frame = main.max_gif_frame_size(1536, 2048, 9)
    record(max_frame == (832, 1104), "  max_gif_frame_size(1536, 2048, 9)", str(max_frame))

    print("\n== 4. 帧数 / 帧间隔 / 空尺寸 / 比例名 ==")
    count_cases = [(0, 9), (1, 2), (9, 9), (16, 16), (99, 16), ("bad", 9)]
    for value, expected in count_cases:
        actual = main.gif_frame_count(value)
        record(actual == expected, f"帧数 {value!r} -> {actual}", f"期望 {expected}")
    duration_cases = [(0, 200), (5, 20), (23, 20), (25, 30), (200, 200), (1234, 1230)]
    for value, expected in duration_cases:
        actual = main.gif_frame_duration(value)
        record(actual == expected, f"帧间隔 {value!r}ms -> {actual}", f"期望 {expected}")
    caps_gif = main.apimart_image_model_caps("gpt-image-2.6-flare").get("gif_frames") or {}
    record(caps_gif == {"min": 2, "max": 16, "default": 9, "durationDefault": 200},
           "能力表 gif_frames 默认值", str(caps_gif))
    for raw, expected in (("", "512x512"), ("auto", "512x512"), ("AUTO", "512x512")):
        actual = main.normalize_gif_frame_size(raw, 9)
        record(actual == expected, f"空/auto 尺寸 {raw!r} -> {actual}", f"期望 {expected}")
    for ratio_label in ("1:1", "3:4", "4:3", "16:9", "9:16", "21:9", "3:1", "1:3"):
        size = main.normalize_gif_frame_size(ratio_label, 9)
        width, height = main.parse_size_pair(size)
        record(bool(width and height and width % 16 == 0 and height % 16 == 0),
               f"比例名 {ratio_label} 换算 -> {size}", "两边 16 的倍数")

    print()
    if FAILURES:
        print(f"[FAIL] 共 {len(FAILURES)} 项未通过")
        for label in FAILURES:
            print("  - " + label)
        return 1
    print("[PASS] 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main_check())
