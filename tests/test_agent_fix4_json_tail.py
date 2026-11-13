# -*- coding: utf-8 -*-
"""决策 JSON 解析容错：第一个平衡对象 + 尾随 suggestions 合并 / 尾随文字忽略 / 半截 JSON 仍失败。"""
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
    _TMP = tempfile.mkdtemp(prefix="novai-json-tail-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


class JsonTailParseTests(unittest.TestCase):
    def test_trailing_suggestions_object_is_merged(self):
        parsed = main._agent_run_parse_round(
            '{"done": true, "message": "hi"}\n{"suggestions": ["再出 2 张"]}')
        self.assertTrue(parsed["done"])
        self.assertEqual(parsed["message"], "hi")
        self.assertEqual(main._agent_decision_suggestions(parsed), ["再出 2 张"])

    def test_multiple_trailing_suggestions_merge_without_duplicates(self):
        parsed = main._agent_run_parse_round(
            '{"done": true, "message": "hi", "suggestions": ["A"]}\n'
            '{"suggestions": ["A", "B"]}\n{"suggestions": ["B", "C"]}')
        self.assertEqual(main._agent_decision_suggestions(parsed), ["A", "B", "C"])

    def test_trailing_prose_is_ignored(self):
        parsed = main._agent_run_parse_round(
            '{"done": true, "message": "完成"}\n以上就是结果，有问题随时说。')
        self.assertEqual(parsed["message"], "完成")

    def test_half_json_still_fails(self):
        with self.assertRaises(main.AgentRunError) as ctx:
            main._agent_run_parse_round('{"done": true, "message": "hi"')
        self.assertEqual(ctx.exception.code, "bad_model_json")

    def test_native_path_merges_trailing_suggestions(self):
        raw = {"choices": [{"message": {"content":
                                        '{"done": true, "message": "hi"}\n{"suggestions": ["a"]}'}}]}
        decision = main._agent_decision_from_native(raw, "c1")
        self.assertTrue(decision.get("done"))
        self.assertEqual(decision.get("message"), "hi")
        self.assertEqual(main._agent_decision_suggestions(decision), ["a"])

    def test_native_path_suggestions_only_with_trailing_prose(self):
        raw = {"choices": [{"message": {"content":
                                        '海报做好了。\n{"suggestions": ["再出 2 张"]}\n谢谢'}}]}
        decision = main._agent_decision_from_native(raw, "c1")
        self.assertTrue(decision.get("done"))
        self.assertIn("海报做好了", decision.get("message"))
        self.assertNotIn("suggestions", decision.get("message"), "建议 JSON 不能留在给用户看的回复里")
        self.assertEqual(main._agent_decision_suggestions(decision), ["再出 2 张"])

    def test_native_trailing_prose_after_decision_json(self):
        raw = {"choices": [{"message": {"content":
                                        '{"done": true, "message": "完成"}\n下面是补充说明。'}}]}
        decision = main._agent_decision_from_native(raw, "c1")
        self.assertEqual(decision.get("message"), "完成")


if __name__ == "__main__":
    unittest.main()
