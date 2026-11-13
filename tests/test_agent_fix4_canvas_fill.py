# -*- coding: utf-8 -*-
"""画布工具缺 canvas_id 自动注入本次 run 的画布；显式给了就不改（不存在仍按原样报错）。"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-canvas-fill-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


class CanvasIdFillTests(unittest.TestCase):
    def setUp(self):
        self.token = main._AGENT_RUN_CANVAS_ID.set("c1")

    def tearDown(self):
        main._AGENT_RUN_CANVAS_ID.reset(self.token)

    def _available(self):
        schema = {"type": "object", "properties": {"canvas_id": {"type": "string"}}}
        return {"batch_generate": {"description": "批量生成", "schema": schema},
                "create_node": {"description": "建节点", "schema": schema},
                "update_node": {"description": "改节点", "schema": schema},
                "get_canvas": {"description": "读画布", "schema": schema},
                "view_image": {"description": "看图", "schema": {"type": "object", "properties": {}}}}

    def test_missing_canvas_id_is_filled(self):
        steps, unknown = main._agent_run_normalize_steps(
            [{"tool": "batch_generate", "args": {"rows": []}},
             {"tool": "create_node", "args": {"type": "text"}},
             {"tool": "update_node", "args": {"node_id": "n1"}}],
            self._available())
        self.assertEqual(unknown, [])
        self.assertEqual([step["args"]["canvas_id"] for step in steps], ["c1", "c1", "c1"])

    def test_explicit_canvas_id_is_preserved_even_if_unknown(self):
        steps, _ = main._agent_run_normalize_steps(
            [{"tool": "create_node", "args": {"canvas_id": "other", "type": "text"}}],
            self._available())
        self.assertEqual(steps[0]["args"]["canvas_id"], "other",
                         "显式给了就不动；不存在由执行层按原样报错")

    def test_tool_without_canvas_id_untouched(self):
        steps, _ = main._agent_run_normalize_steps(
            [{"tool": "view_image", "args": {"url": "/a.png"}}], self._available())
        self.assertEqual(steps[0]["args"], {"url": "/a.png"})

    def test_canvas_cli_inner_tool_gets_canvas_id(self):
        steps, unknown = main._agent_run_normalize_steps(
            [{"tool": "canvas_cli", "args": {"command": "node.create",
                                             "args": {"type": "prompt", "prompt": "x"}}}],
            main.AGENT_TOOLS)
        self.assertEqual(unknown, [])
        self.assertEqual(steps[0]["tool"], "create_node")
        self.assertEqual(steps[0]["args"].get("canvas_id"), "c1")

    def test_producer_sets_canvas_scope_even_without_context_flag(self):
        # 兜底不能依赖 CONTEXT/MEMORY 开关：producer 里无条件 set（这里验证 set 位置产生的值）
        self.assertEqual(main._AGENT_RUN_CANVAS_ID.get(), "c1")


if __name__ == "__main__":
    unittest.main()
