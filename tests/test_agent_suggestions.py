# -*- coding: utf-8 -*-
"""阶段四·4：完成时附 2-3 条下一步建议（suggestions）。

覆盖：决策解析（JSON 与原生两条路径）都认 suggestions；done 事件与结论 message 带 2-3 条；
模型没返回时为空数组不报错；开关 NOVAI_AGENT_V2_SUGGESTIONS 关闭时 payload 不带该字段、
提示词也不加这句。
"""
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-suggestions-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from tests.test_agent_autonomy import run_autonomy_producer  # noqa: E402
from tests.test_agent_reflect import new_canvas  # noqa: E402


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def prompt_text():
    return main._agent_run_user_prompt("做一张海报", [], 1, 0, 0, "", mode="run")


class SuggestionParseTests(unittest.TestCase):
    def test_normalize_two_to_three(self):
        self.assertEqual(main._agent_decision_suggestions(
            {"suggestions": ["再出 2 张", "换个比例"]}), ["再出 2 张", "换个比例"])
        self.assertEqual(main._agent_decision_suggestions(
            {"suggestions": [{"text": "补一个细节"}, {"text": ""}, "换个模型"]}),
            ["补一个细节", "换个模型"])
        self.assertEqual(len(main._agent_decision_suggestions(
            {"suggestions": ["a", "b", "c", "d"]})), 3, "最多 3 条")
        self.assertEqual(main._agent_decision_suggestions({}), [])
        self.assertEqual(main._agent_decision_suggestions({"suggestions": None}), [])

    def test_json_path_keeps_suggestions(self):
        parsed = main._agent_run_parse_round(
            '{"done": true, "message": "好了", "suggestions": ["再出 2 张", "换个比例"]}')
        self.assertEqual(parsed["message"], "好了")
        self.assertEqual(main._agent_decision_suggestions(parsed), ["再出 2 张", "换个比例"])

    def test_native_path_keeps_suggestions(self):
        raw = {"choices": [{"message": {"content": '{"done": true, "message": "好了", '
                                                     '"suggestions": ["再来一张", "换个模型"]}'}}]}
        decision = main._agent_decision_from_native(raw, "c1")
        self.assertEqual(main._agent_decision_suggestions(decision), ["再来一张", "换个模型"])


class SuggestionPayloadTests(unittest.TestCase):
    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("suggestions")

    def _done(self, suggestions=None, flag="1"):
        decision = {"done": True, "message": "海报做好了"}
        if suggestions is not None:
            decision["suggestions"] = suggestions
        out = run_autonomy_producer(
            self.canvas_id, [decision], None, autonomy="collab",
            extra_env={"NOVAI_AGENT_V2_SUGGESTIONS": flag})
        messages = [item["data"] for item in out["events"] if item["event"] == "message"]
        return out, messages

    def test_done_and_message_carry_suggestions(self):
        suggestions = ["再出 2 张横版", "换成写实风格"]
        out, messages = self._done(suggestions)
        self.assertEqual(out["done"].get("suggestions"), suggestions)
        self.assertTrue(messages)
        self.assertEqual(messages[0].get("suggestions"), suggestions)

    def test_missing_suggestions_becomes_empty_list(self):
        out, messages = self._done(None)
        self.assertEqual(out["done"].get("suggestions"), [])
        self.assertEqual(messages[0].get("suggestions"), [])

    def test_switch_off_payload_has_no_suggestions_field(self):
        out, messages = self._done(["再出 2 张", "换个比例"], flag="0")
        self.assertNotIn("suggestions", out["done"])
        self.assertNotIn("suggestions", messages[0])

    def test_prompt_mentions_suggestions_only_when_on(self):
        with unittest.mock.patch.dict(os.environ, {"NOVAI_AGENT_V2_SUGGESTIONS": "1"}):
            on_text = prompt_text()
        with unittest.mock.patch.dict(os.environ, {"NOVAI_AGENT_V2_SUGGESTIONS": "0"}):
            off_text = prompt_text()
        self.assertIn("必须", on_text)
        self.assertIn("suggestions", on_text)
        self.assertIn("下一步建议", on_text)
        self.assertIn("空数组", on_text)
        self.assertNotIn("下一步建议", off_text)
        self.assertNotIn("suggestions", off_text)

    def test_output_format_example_requires_suggestions_when_on(self):
        with unittest.mock.patch.dict(os.environ, {"NOVAI_AGENT_V2_SUGGESTIONS": "1"}):
            block = main._agent_output_format_block()
        self.assertIn("suggestions", block)
        self.assertIn("必须", block)
        self.assertIn("空数组", block)
        self.assertIn('"suggestions": [', block, "JSON 输出格式示例要显式带上该字段")
        with unittest.mock.patch.dict(os.environ, {"NOVAI_AGENT_V2_SUGGESTIONS": "0"}):
            self.assertEqual(main._agent_output_format_block(), main._AGENT_OUTPUT_JSON_BLOCK,
                             "开关关闭时输出格式段逐字不变")

    def test_native_suggestions_line_is_parsed_and_stripped_from_message(self):
        raw = {"choices": [{"message": {"content": '海报做好了。\n'
                                                     '{"suggestions": ["再出 2 张", "换个风格"]}'}}]}
        decision = main._agent_decision_from_native(raw, "c1")
        self.assertTrue(decision.get("done"))
        self.assertEqual(main._agent_decision_suggestions(decision), ["再出 2 张", "换个风格"])
        self.assertEqual(decision.get("message"), "海报做好了。", "建议 JSON 行不能留在给用户看的回复里")


if __name__ == "__main__":
    unittest.main()
