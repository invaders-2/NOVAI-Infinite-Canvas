# -*- coding: utf-8 -*-
"""表格嵌套单元格序列化 + canvas_cli 空命令可用清单 + 非流式总时长兜底。"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-table-nested-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agents import canvas_cli  # noqa: E402


class NestedTableCellTests(unittest.TestCase):
    def test_nested_dict_and_list_cells_become_compact_json(self):
        notes = []
        token = main._AGENT_TABLE_CELL_NOTES.set(notes)
        try:
            columns, rows = main._agent_table_rows_from_args(
                [{"标题": "A", "详情": {"x": 1, "y": [2, 3]}, "标签": [{"k": "v"}]}],
                ["标题", "详情", "标签"])
        finally:
            main._AGENT_TABLE_CELL_NOTES.reset(token)
        self.assertEqual(rows[0][0], "A")
        self.assertEqual(rows[0][1], '{"x":1,"y":[2,3]}')
        self.assertEqual(rows[0][2], '[{"k":"v"}]')
        self.assertTrue(any("嵌套" in note for note in notes))
        self.assertTrue(any("序列化为紧凑 JSON" in note for note in notes))

    def test_execute_step_surfaces_nested_cell_warning(self):
        async def fake_run(args):
            return {"columns": ["a"], "rows": [["x"]]}

        entry = {"description": "table", "schema": {"type": "object", "properties": {}},
                 "validate": lambda args: args, "run": fake_run}
        token = main._AGENT_TABLE_CELL_NOTES.set([])
        try:
            with patch.dict(main.AGENT_TOOLS, {"__test_table": entry}, clear=False):
                result = asyncio.run(main.agent_execute_step("__test_table", {"rows": []}))
        finally:
            main._AGENT_TABLE_CELL_NOTES.reset(token)
        self.assertTrue(result["ok"])

    def test_canvas_cli_empty_command_lists_available_commands(self):
        with self.assertRaises(canvas_cli.CanvasCliError) as ctx:
            canvas_cli._validate({"command": ""})
        self.assertIn("未知命令", ctx.exception.message)
        self.assertIn("可用命令", ctx.exception.message)
        self.assertIn("node.create", ctx.exception.message)
        self.assertIn("batch.generate", ctx.exception.message)


class BatchTableInputsFillTests(unittest.TestCase):
    def test_empty_inputs_filled_with_same_round_table(self):
        results = [{"ok": True, "tool": "create_node",
                    "result": {"node_id": "t1", "kind": "table", "status": "ready_to_generate"}}]
        filled = main._agent_fill_batch_table_inputs(
            "create_node", {"type": "batch", "inputs": []}, results)
        self.assertEqual(filled["inputs"], ["t1"])
        filled2 = main._agent_fill_batch_table_inputs(
            "batch_generate", {"inputs": ["img1"]}, results)
        self.assertEqual(filled2["inputs"], ["t1", "img1"], "保留素材，表格放最前")

    def test_no_table_or_step_refs_untouched(self):
        args = {"type": "batch", "inputs": []}
        self.assertEqual(main._agent_fill_batch_table_inputs("create_node", args, []), args)
        step_args = {"type": "batch", "inputs": [{"step": 0}]}
        self.assertEqual(main._agent_fill_batch_table_inputs("create_node", step_args, []), step_args)

    def test_batch_error_points_to_inputs_example(self):
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_beat_create_table_batch_validate(
                {"inputs": [], "media": "image"}, {"nodes": [], "connections": []}, "c1", "batch")
        self.assertIn("inputs", ctx.exception.message)
        self.assertIn("step", ctx.exception.message)


class NonStreamTotalTimeoutTests(unittest.TestCase):
    def test_total_timeout_covers_slow_non_stream(self):
        async def slow_once(*args, **kwargs):
            await asyncio.sleep(0.2)
            return {"choices": [{"message": {"content": "x"}}]}

        saved = main._AGENT_CHAT_TOTAL_TIMEOUT_SECONDS
        main._AGENT_CHAT_TOTAL_TIMEOUT_SECONDS = 0.05
        try:
            with patch.object(main, "_agent_chat_http_once", new=slow_once):
                started = time.monotonic()
                with self.assertRaises(main.AgentRunError) as ctx:
                    asyncio.run(main._agent_run_chat(
                        {"provider": "p", "base": "https://x", "headers": {},
                         "model": "m", "provider_cfg": {}},
                        [{"role": "user", "content": "hi"}]))
                elapsed = time.monotonic() - started
        finally:
            main._AGENT_CHAT_TOTAL_TIMEOUT_SECONDS = saved
        self.assertEqual(ctx.exception.code, "provider_timeout")
        self.assertIn("总时长超时", ctx.exception.message)
        self.assertLess(elapsed, 0.5)


if __name__ == "__main__":
    unittest.main()
