# -*- coding: utf-8 -*-
"""画布助手落点：有 @ 锚点就贴着锚点找空位，没锚点就贴着最近的节点，不许飞到远处。

只调 _agent_beat_place / _agent_free_position 两个纯函数，不碰网络、不碰 3000 端口。
"""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-agent-place-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402


def teardown_module(module):
    shutil.rmtree(_TMP, ignore_errors=True)


def load_tests(loader, tests, pattern):
    """模块级 test_* 函数默认不会被 unittest 收集，这里显式包成 FunctionTestCase。"""
    suite = unittest.TestSuite()
    for name, func in list(globals().items()):
        if name.startswith("test_") and callable(func):
            suite.addTest(unittest.FunctionTestCase(func, description=name))
    return suite


def node(nid, x, y, w=240, h=240, created_at=0):
    return {"id": nid, "type": "smart-image", "kind": "image", "x": x, "y": y, "w": w, "h": h,
            "created_at": created_at}


def canvas_of(*nodes):
    return {"nodes": list(nodes), "connections": []}


def box(x, y, w=240, h=240):
    return (x, y, w, h)


def overlaps(a, b, gap=40):
    return (a[0] < b[0] + b[2] + gap and b[0] < a[0] + a[2] + gap
            and a[1] < b[1] + b[3] + gap and b[1] < a[1] + a[3] + gap)


def assert_clear(canvas, x, y, w, h):
    for n in canvas["nodes"]:
        assert not overlaps(box(x, y, w, h), box(n["x"], n["y"], n["w"], n["h"])), f"新节点压到 {n['id']}"


def test_anchor_side_free_lands_right_of_anchor():
    canvas = canvas_of(node("anchor", 0, 0))
    x, y = main._agent_beat_place(canvas, ["anchor"], 240, 240)
    assert (x, y) == (360, 0)
    assert isinstance(x, int) and isinstance(y, int)


def test_anchor_right_column_occupied_does_not_get_pushed_far_down():
    # 锚点右侧那一列被占满：旧逻辑会一路往下顶到 y=1400，新逻辑应该落在右侧同一高度
    canvas = canvas_of(node("anchor", 0, 0))
    for i in range(5):
        canvas["nodes"].append(node(f"col{i}", 360, i * 280))
    x, y = main._agent_beat_place(canvas, ["anchor"], 240, 240)
    assert (x, y) == (640, 0)
    assert isinstance(x, int) and isinstance(y, int)
    assert_clear(canvas, x, y, 240, 240)


def test_anchor_surrounded_uses_nearby_slot():
    # 正右和右下都占着，落到锚点正下方，仍然贴着锚点
    canvas = canvas_of(node("anchor", 0, 0), node("right", 360, 0), node("right_down", 640, 0))
    x, y = main._agent_beat_place(canvas, ["anchor"], 240, 240)
    assert (x, y) == (360, 280)
    assert_clear(canvas, x, y, 240, 240)


def test_no_anchor_uses_latest_node_not_canvas_right_edge():
    # 最右边有个老节点，最新节点在左边：新节点应该贴着最新节点右侧 160
    canvas = canvas_of(node("old_far", 3000, 0, created_at=1), node("latest", 0, 0, created_at=5000))
    x, y = main._agent_beat_place(canvas, [], 240, 240)
    assert (x, y) == (400, 0)
    assert x < 1000
    assert_clear(canvas, x, y, 240, 240)


def test_no_anchor_latest_right_occupied_stays_near():
    canvas = canvas_of(node("latest", 0, 0, created_at=5000), node("blocker", 400, 0))
    x, y = main._agent_beat_place(canvas, [], 240, 240)
    assert (x, y) == (680, 0)
    assert_clear(canvas, x, y, 240, 240)


def test_empty_canvas_keeps_origin():
    assert main._agent_beat_place(canvas_of(), [], 240, 240) == (0, 0)


def test_free_position_tries_right_before_down():
    canvas = canvas_of(node("x", 0, 0, w=240, h=240))
    assert main._agent_free_position(canvas, 0, 0, 240, 240) == (280, 0)


def test_free_position_never_overlaps_even_when_surrounded():
    # 原点周围 5x5 全占满（远近两圈都没空），逼出兜底分支：不管最后放哪，都不能压在别人身上
    nodes = [node(f"n{dx}_{dy}", dx * 280, dy * 280)
             for dx in range(-2, 3) for dy in range(-2, 3)]
    canvas = canvas_of(*nodes)
    x, y = main._agent_free_position(canvas, 0, 0, 240, 240)
    assert x == 0
    assert_clear(canvas, x, y, 240, 240)
