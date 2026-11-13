# -*- coding: utf-8 -*-
"""多表格 rows/columns 校验：不合法时明确报错，绝不静默丢数据。

覆盖：行宽不齐补齐、字符串行、rows 缺失/空行、超过列数上限（以前会被静默截断）、
超长单元格（以前会被静默截断）、奇怪的单元格类型、columns 超过上限（以前会被静默截断）、重名列。
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
    _TMP = tempfile.mkdtemp(prefix="novai-table-validate-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


class TableRowsValidationTests(unittest.TestCase):
    def test_ragged_rows_are_padded_not_dropped(self):
        columns, rows = main._agent_table_rows_from_args([["a"], ["b", "c"]])
        self.assertEqual(columns, ["第1列", "第2列"])
        self.assertEqual(rows, [["a", ""], ["b", "c"]])

    def test_string_rows_become_single_column(self):
        columns, rows = main._agent_table_rows_from_args(["提示词一", "提示词二"])
        self.assertEqual(columns, ["提示词"])
        self.assertEqual(rows, [["提示词一"], ["提示词二"]])

    def test_duplicate_columns_are_renamed_not_lost(self):
        columns, rows = main._agent_table_rows_from_args([["a", "b"]], ["提示词", "提示词"])
        self.assertEqual(columns, ["提示词", "提示词(2)"])
        self.assertEqual(rows, [["a", "b"]])

    def test_missing_rows_raises(self):
        for value in (None, [], "a"):
            with self.assertRaises(main.AgentToolError) as ctx:
                main._agent_table_rows_from_args(value)
            self.assertIn("至少要有一行", ctx.exception.message)

    def test_empty_row_raises(self):
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_table_rows_from_args([["a"], ["", "  "]])
        self.assertIn("第 2 行是空的", ctx.exception.message)

    def test_too_many_cells_raises_instead_of_silent_truncation(self):
        row = ["c%d" % index for index in range(13)]
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_table_rows_from_args([row])
        self.assertIn("超过最多 12 列", ctx.exception.message)

    def test_long_prompt_cell_up_to_8000_is_accepted_without_truncation(self):
        text = "提" * 2500
        columns, rows = main._agent_table_rows_from_args([[text]])
        self.assertEqual(rows[0][0], text, "2500 字的整段提示词要原样保留，不报错也不截断")
        self.assertEqual(len(rows[0][0]), 2500)

    def test_cell_over_8000_raises_instead_of_silent_truncation(self):
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_table_rows_from_args([["x" * 8001]])
        self.assertIn("最多 8000 字", ctx.exception.message)

    def test_complex_cell_is_serialized_to_compact_json(self):
        columns, rows = main._agent_table_rows_from_args([["a", {"b": "c"}]])
        self.assertEqual(columns, ["第1列", "第2列"])
        self.assertEqual(rows, [["a", '{"b":"c"}']])

    def test_number_and_boolean_cells_are_allowed(self):
        columns, rows = main._agent_table_rows_from_args([[1, True, 2.5, None]], ["数量", "启用", "比例", "备注"])
        self.assertEqual(rows, [["1", "True", "2.5", ""]])

    def test_object_rows_without_columns_derive_columns_from_key_order(self):
        columns, rows = main._agent_table_rows_from_args([
            {"场景": "雨夜", "文案": "霓虹招牌"},
            {"场景": "晴天", "文案": "白底产品", "卖点": "轻便"},
        ])
        self.assertEqual(columns, ["场景", "文案", "卖点"])
        self.assertEqual(rows, [["雨夜", "霓虹招牌", ""], ["晴天", "白底产品", "轻便"]])

    def test_object_rows_follow_explicit_columns_and_append_unknown_keys(self):
        columns, rows = main._agent_table_rows_from_args(
            [{"文案": "A", "场景": "雨夜"}, {"场景": "晴天", "文案": "B"}],
            ["场景"])
        self.assertEqual(columns, ["场景", "文案"], "对象里多出来的键要补成新列，不静默丢")
        self.assertEqual(rows, [["雨夜", "A"], ["晴天", "B"]])

    def test_object_keys_beyond_column_limit_name_the_extra_keys(self):
        row = {"k%d" % index: "v" for index in range(13)}
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_table_rows_from_args([row])
        self.assertIn("放不下", ctx.exception.message)
        self.assertIn("k12", ctx.exception.message, "要明确点名放不下的键")

    def test_object_row_with_nested_value_is_serialized(self):
        columns, rows = main._agent_table_rows_from_args([{"场景": {"细节": "雨夜"}}])
        self.assertEqual(columns, ["场景"])
        self.assertEqual(rows, [['{"细节":"雨夜"}']])

    def test_non_string_row_raises(self):
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_table_rows_from_args([123])
        self.assertIn("必须是字符串、单元格数组或对象", ctx.exception.message)

    def test_too_many_columns_raises(self):
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_table_rows_from_args([["a"]], ["c%d" % i for i in range(13)])
        self.assertIn("columns 最多 12 列", ctx.exception.message)


class CreateNodeTableTests(unittest.TestCase):
    def test_create_node_table_uses_validated_rows(self):
        canvas = {"id": "c1", "kind": "smart", "nodes": []}
        with patch.object(main, "load_canvas", new=lambda cid: canvas):
            norm = main._agent_tool_create_node_validate(
                {"canvas_id": "c1", "type": "table", "columns": ["提示词", "备注"],
                 "rows": [["a", ""], ["b", "c"]]})
        self.assertEqual(norm["columns"], ["提示词", "备注"])
        self.assertEqual(norm["rows"], [["a", ""], ["b", "c"]])

    def test_create_node_table_without_rows_raises(self):
        canvas = {"id": "c1", "kind": "smart", "nodes": []}
        with patch.object(main, "load_canvas", new=lambda cid: canvas):
            with self.assertRaises(main.AgentToolError) as ctx:
                main._agent_tool_create_node_validate({"canvas_id": "c1", "type": "table"})
        self.assertIn("rows 至少要有一行", ctx.exception.message)


if __name__ == "__main__":
    unittest.main()
