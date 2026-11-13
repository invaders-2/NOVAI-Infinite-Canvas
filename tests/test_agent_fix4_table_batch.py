# -*- coding: utf-8 -*-
"""多维表格批量链路审计：create_node(type=batch) 必须有表格、BEAT 改行清旧批量进度、模型读表呈现。

覆盖：
- smart-batch 的 inputs 必须包含表格（以前没有表格也建得出来、还连不上任何东西）；
- BEAT 表格 update_node(rows/append_rows) 后：选中行重置为全部、下游批量节点的旧 journal 清空
  （否则 run_batch 会以为上一批还在跑 / 已跑完，改完的行根本跑不了）；
- read_table 呈现列名 / 行数 / 行号 / 空单元格 / 分页提示；
- batch_generate 的 rows/columns/common_prompt/settings 落库。
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-table-batch-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import read_tools  # noqa: E402


def smart_canvas(nodes=None, connections=None):
    return {"id": "c1", "kind": "smart", "nodes": list(nodes or []),
            "connections": list(connections or [])}


def table_node(node_id="t1", columns=None, rows=None, selected=None):
    return {"id": node_id, "type": "table", "kind": "table",
            "table": {"kind": "table", "version": 1,
                      "columns": list(columns or ["提示词"]),
                      "rows": list(rows or [["a"]]),
                      "selectedRows": list(selected if selected is not None else range(len(rows or [["a"]]))),
                      "mergedGroups": []},
            "tableSelectionInitialized": True}


class SmartBatchCreateTests(unittest.TestCase):
    def test_batch_without_table_input_is_rejected(self):
        canvas = smart_canvas([{"id": "i1", "type": "smart-image", "kind": "image"}])
        with patch.object(main, "load_canvas", new=lambda cid: canvas):
            with self.assertRaises(main.AgentToolError) as ctx:
                main._agent_tool_create_node_validate(
                    {"canvas_id": "c1", "type": "batch", "inputs": ["i1"]})
        self.assertIn("必须有一个多维表格节点", ctx.exception.message)

    def test_batch_with_table_input_passes(self):
        canvas = smart_canvas([table_node()])
        with patch.object(main, "load_canvas", new=lambda cid: canvas):
            norm = main._agent_tool_create_node_validate(
                {"canvas_id": "c1", "type": "batch", "inputs": ["t1"], "media": "video",
                 "settings": {"ratio": "16:9"}})
        self.assertEqual(norm["media"], "video")
        self.assertEqual(norm["inputs"], ["t1"])
        self.assertTrue(norm["settings"])

    def test_batch_with_no_inputs_is_rejected(self):
        canvas = smart_canvas([])
        with patch.object(main, "load_canvas", new=lambda cid: canvas):
            with self.assertRaises(main.AgentToolError) as ctx:
                main._agent_tool_create_node_validate(
                    {"canvas_id": "c1", "type": "batch"})
        self.assertIn("必须把上游表格放进 inputs", ctx.exception.message)


class BeatTableRowsUpdateTests(unittest.TestCase):
    def _canvas(self):
        table = {"id": "t1", "kind": "table",
                 "data": {"gen": {"title": "表格"},
                          "table": {"kind": "table", "version": 1,
                                    "columns": ["提示词"], "rows": [["a"], ["b"]],
                                    "selectedRows": [0]}}}
        batch = {"id": "b1", "kind": "image",
                 "data": {"gen": {"title": "批量"},
                          "batch": {"settings": {"model": "m"}, "journal": {"rows": [
                              {"status": "completed"}, {"status": "completed"}]}}}}
        return {"id": "c1", "kind": "classic", "nodes": [table, batch],
                "connections": [{"id": "e1", "from": "t1", "to": "b1", "kind": "input"}]}

    def test_rows_update_resets_selection_and_downstream_journal(self):
        canvas = self._canvas()
        table = canvas["nodes"][0]
        main._agent_beat_set_table_rows(table, ["提示词"], [["a"], ["b"], ["c"]], canvas=canvas)
        table_data = table["data"]["table"]
        self.assertEqual(table_data["rows"], [["a"], ["b"], ["c"]])
        self.assertEqual(table_data["selectedRows"], [0, 1, 2], "行变了以后默认全选，别按旧下标跑")
        batch_data = canvas["nodes"][1]["data"]["batch"]
        self.assertIsNone(batch_data["journal"], "旧批量进度必须清空，否则改完的行跑不了")
        self.assertEqual(batch_data["settings"], {"model": "m"}, "批量参数保留")

    def test_smart_table_update_node_rewrites_table_payload(self):
        canvas = smart_canvas([table_node(rows=[["a"], ["b"]])])
        args = {"canvas_id": "c1", "node_id": "t1", "rows": [["x"], ["y"], ["z"]],
                "columns": ["提示词"], "smart": True}
        with patch.object(main, "load_canvas", new=lambda cid: canvas), \
                patch.object(main, "_agent_mutate_canvas",
                             new=lambda cid, fn: (fn(canvas), canvas)):
            norm = main._agent_tool_update_node_validate(
                {"canvas_id": "c1", "node_id": "t1", "rows": args["rows"]})
            result = main._agent_tool_update_node_run(dict(norm, smart=True))
        node = canvas["nodes"][0]
        self.assertEqual(node["table"]["rows"], [["x"], ["y"], ["z"]])
        self.assertEqual(node["table"]["selectedRows"], [0, 1, 2])
        self.assertIn("rows", result["changed"])


class ReadTablePresentationTests(unittest.TestCase):
    def test_read_table_returns_columns_rows_and_empty_cells(self):
        canvas = smart_canvas([table_node(rows=[["a", ""], ["b", "c"]],
                                          columns=["提示词", "备注"], selected=[1])])
        payload = read_tools.read_table(canvas, "t1", start=0, limit=20)
        self.assertEqual(payload["columns"], ["提示词", "备注"])
        self.assertEqual(payload["row_count"], 2)
        self.assertEqual(payload["rows"][0], {"row": 1, "cells": ["a", ""]})
        self.assertEqual(payload["rows"][1], {"row": 2, "cells": ["b", "c"]})
        self.assertNotIn("hint", payload)

    def test_read_table_reports_pagination_hint(self):
        canvas = smart_canvas([table_node(rows=[["%d" % i] for i in range(30)])])
        payload = read_tools.read_table(canvas, "t1", start=0, limit=10)
        self.assertEqual(len(payload["rows"]), 10)
        self.assertEqual(payload["rows"][0]["row"], 1)
        self.assertIn("还有 20 行", payload["hint"])


class BeatBatchGenerateRunTests(unittest.TestCase):
    def test_beat_batch_generate_persists_rows_input_modes_and_settings(self):
        canvas = {"id": "c1", "kind": "classic", "nodes": [], "connections": []}
        args = {"canvas_id": "c1", "beat": True, "media": "video", "rows": [["镜头一"], ["镜头二"]],
                "columns": ["提示词"], "common_prompt": "统一白底产品", "run": False,
                "settings": {"ratio": "16:9"}, "inputs": [], "input_modes": {}}
        with patch.object(main, "_agent_mutate_canvas",
                          new=lambda cid, fn: (fn(canvas), canvas)), \
                patch.object(main, "_agent_beat_review_table_result", new=lambda *a, **k: {}):
            result = main._agent_beat_batch_generate_run(args)
        table = next(n for n in canvas["nodes"] if n.get("kind") == "table")
        batch = next(n for n in canvas["nodes"] if n.get("id") == result["batch_node_id"])
        self.assertEqual(table["data"]["table"]["rows"], [["镜头一"], ["镜头二"]])
        self.assertTrue(any(c.get("from") == table["id"] and c.get("to") == batch["id"]
                            for c in canvas["connections"]), "表格要连到批量节点")
        self.assertEqual(result["rows"], 2)
        self.assertEqual(result["kind"], "video")
        self.assertEqual(result["status"], "ready_to_generate")


class RunBatchRowNumbersTests(unittest.TestCase):
    def test_run_batch_row_numbers_and_selection(self):
        canvas = smart_canvas([
            table_node(rows=[["a"], ["b"], ["c"]]),
            {"id": "b1", "type": "smart-batch", "kind": "batch"},
        ], [{"id": "e1", "from": "t1", "to": "b1", "kind": "input"}])
        with patch.object(main, "load_canvas", new=lambda cid: canvas):
            norm = main._agent_tool_run_batch_validate(
                {"canvas_id": "c1", "node_id": "b1", "row_numbers": [1, 3]})
        self.assertEqual(norm["rows"], 2)
        with patch.object(main, "_agent_mutate_canvas",
                          new=lambda cid, fn: (fn(canvas), canvas)):
            result = main._agent_tool_run_batch_run(dict(norm, row_numbers=[1, 3]))
        self.assertEqual(canvas["nodes"][0]["table"]["selectedRows"], [0, 2])
        self.assertEqual(result["rows"], 2)
        self.assertEqual(result["generation_units"], 2)

    def test_table_row_count_respects_selection(self):
        node = table_node(rows=[["a"], ["b"], ["c"]], selected=[0, 2])
        self.assertEqual(main._agent_table_row_count(node), 2)
        node["tableSelectionInitialized"] = False
        self.assertEqual(main._agent_table_row_count(node), 3)


class BatchGenerateValidateTests(unittest.TestCase):
    def test_batch_generate_keeps_rows_columns_prompt_and_settings(self):
        canvas = smart_canvas([])
        with patch.object(main, "load_canvas", new=lambda cid: canvas):
            norm = main._agent_tool_batch_generate_validate(
                {"canvas_id": "c1", "rows": ["场景一", "场景二"], "columns": ["提示词"],
                 "media": "image", "common_prompt": "统一产品：白底杯子",
                 "settings": {"ratio": "1:1"}})
        self.assertEqual(len(norm["rows"]), 2)
        self.assertEqual(norm["columns"], ["提示词"])
        self.assertEqual(norm["common_prompt"], "统一产品：白底杯子")
        self.assertEqual(norm["media"], "image")
        self.assertTrue(norm["run"])

    def test_batch_generate_accepts_object_rows_with_columns(self):
        canvas = smart_canvas([])
        with patch.object(main, "load_canvas", new=lambda cid: canvas):
            norm = main._agent_tool_batch_generate_validate(
                {"canvas_id": "c1",
                 "rows": [{"场景": "雨夜", "文案": "霓虹招牌"},
                          {"场景": "晴天", "文案": "白底产品"}],
                 "columns": ["场景", "文案"], "media": "image",
                 "common_prompt": "统一 3:4 竖版"})
        self.assertEqual(norm["columns"], ["场景", "文案"])
        self.assertEqual(norm["rows"], [["雨夜", "霓虹招牌"], ["晴天", "白底产品"]])
        self.assertEqual(len(norm["rows"]), 2)

    def test_batch_generate_rejects_unknown_media(self):
        canvas = smart_canvas([])
        with patch.object(main, "load_canvas", new=lambda cid: canvas):
            with self.assertRaises(main.AgentToolError) as ctx:
                main._agent_tool_batch_generate_validate(
                    {"canvas_id": "c1", "rows": ["a"], "media": "audio"})
        self.assertIn("media 只能是 image 或 video", ctx.exception.message)


if __name__ == "__main__":
    unittest.main()
