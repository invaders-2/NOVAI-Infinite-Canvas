# -*- coding: utf-8 -*-
"""阶段三·1：server/agent_core/stream.py 的增量解析单测（纯模块，不 import main）。

覆盖：
- reasoning 与 content 交错、跨 chunk 切在半行也能拼对；
- tool_calls：名字先到、参数跨 chunk 分片拼接，收齐后给 tool_done（含解析好的 args）；
- SSE 前缀 / 注释 / [DONE] / 坏行 / 空块不炸；
- 多个工具调用（index 0/1）各自独立；
- raw() 与非流式 /chat/completions 同形，可直接喂现有决策解析。
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.agent_core import stream  # noqa: E402


def sse(payload, prefix="data: "):
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return prefix + text + "\n\n"


def chunk(delta, finish_reason=None):
    choice = {"delta": delta}
    if finish_reason is not None:
        choice["finish_reason"] = finish_reason
    return sse({"choices": [choice]})


class ReasoningContentTests(unittest.TestCase):
    def test_reasoning_and_content_interleaved_across_chunks(self):
        parser = stream.StreamParser()
        out = []
        out += parser.feed(chunk({"reasoning_content": "先想"}))
        out += parser.feed(chunk({"content": "你好"}))
        out += parser.feed(chunk({"reasoning_content": "，再想"}))
        out += parser.feed(chunk({"content": "，世界"}))
        out += parser.finish()
        self.assertEqual([(item["type"], item["text"]) for item in out], [
            ("reasoning", "先想"), ("content", "你好"),
            ("reasoning", "，再想"), ("content", "，世界")])
        self.assertEqual(parser.reasoning, "先想，再想")
        self.assertEqual(parser.content, "你好，世界")
        self.assertEqual(parser.raw()["choices"][0]["message"]["content"], "你好，世界")
        self.assertEqual(parser.raw()["choices"][0]["message"]["reasoning_content"], "先想，再想")

    def test_reasoning_field_alias_and_array_fragment(self):
        parser = stream.StreamParser()
        out = parser.feed(chunk({"reasoning": [{"text": "甲"}, {"content": "乙"}]}))
        self.assertEqual(out, [{"type": "reasoning", "text": "甲乙"}])

    def test_half_line_is_buffered_until_complete(self):
        whole = chunk({"content": "分片正文"})
        parser = stream.StreamParser()
        cut = len(whole) // 2
        self.assertEqual(parser.feed(whole[:cut]), [], "半行不能解析")
        self.assertEqual(parser.feed(whole[cut:]), [{"type": "content", "text": "分片正文"}])

    def test_sse_noise_is_ignored(self):
        parser = stream.StreamParser()
        out = []
        out += parser.feed(": keep-alive\n\n")
        out += parser.feed("event: message\n")
        out += parser.feed("data: not-json\n\n")
        out += parser.feed("data: {}\n\n")
        out += parser.feed("data: [DONE]\n\n")
        self.assertEqual(out, [])
        self.assertTrue(parser.done)


class ToolCallTests(unittest.TestCase):
    def test_arguments_join_across_chunks_and_finalize_once(self):
        parser = stream.StreamParser()
        out = []
        out += parser.feed(chunk({"tool_calls": [{"index": 0, "id": "call_a",
                                                  "function": {"name": "create_node", "arguments": ""}}]}))
        self.assertEqual(out, [{"type": "tool_call", "index": 0, "id": "call_a", "name": "create_node"}])
        out += parser.feed(chunk({"tool_calls": [{"index": 0,
                                                  "function": {"arguments": '{"canvas_id":"c1",'}}]}))
        self.assertEqual([item["type"] for item in out], ["tool_call"], "参数分片不单独成事件")
        out += parser.feed(chunk({"tool_calls": [{"index": 0,
                                                  "function": {"arguments": '"description":"新建文本节点"}'}}]}))
        out += parser.feed(chunk({}, finish_reason="tool_calls"))
        done = [item for item in out if item["type"] == "tool_done"]
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["name"], "create_node")
        self.assertEqual(done[0]["arguments"], '{"canvas_id":"c1","description":"新建文本节点"}')
        self.assertEqual(done[0]["args"], {"canvas_id": "c1", "description": "新建文本节点"})
        self.assertEqual(parser.finish(), [], "finish_reason 之后 finish() 不能再补一遍")
        message = parser.raw()["choices"][0]["message"]
        self.assertEqual(message["tool_calls"][0]["function"]["name"], "create_node")
        self.assertEqual(message["tool_calls"][0]["id"], "call_a")

    def test_tool_call_without_finish_reason_is_finalized_by_finish(self):
        parser = stream.StreamParser()
        parser.feed(chunk({"tool_calls": [{"index": 0, "id": "x",
                                           "function": {"name": "get_canvas", "arguments": "{}"}}]}))
        done = [item for item in parser.finish() if item["type"] == "tool_done"]
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]["id"], "x")

    def test_two_tool_calls_are_independent(self):
        parser = stream.StreamParser()
        out = []
        out += parser.feed(chunk({"tool_calls": [
            {"index": 0, "id": "a", "function": {"name": "create_node", "arguments": '{"x":'}},
            {"index": 1, "id": "b", "function": {"name": "run_generation", "arguments": ""}}]}))
        out += parser.feed(chunk({"tool_calls": [
            {"index": 0, "function": {"arguments": "1}"}},
            {"index": 1, "function": {"arguments": '{"node_id":"n1"}'}}]}))
        out += parser.finish()
        names = [item["name"] for item in out if item["type"] == "tool_call"]
        self.assertEqual(names, ["create_node", "run_generation"])
        done = {item["index"]: item for item in out if item["type"] == "tool_done"}
        self.assertEqual(done[0]["args"], {"x": 1})
        self.assertEqual(done[1]["args"], {"node_id": "n1"})
        calls = parser.raw()["choices"][0]["message"]["tool_calls"]
        self.assertEqual([call["id"] for call in calls], ["a", "b"])

    def test_arguments_dict_fragment(self):
        parser = stream.StreamParser()
        out = parser.feed(chunk({"tool_calls": [{"index": 0, "id": "d",
                                                  "function": {"name": "create_node",
                                                               "arguments": {"description": "建节点"}}}]}))
        out += parser.finish()
        done = [item for item in out if item["type"] == "tool_done"][0]
        self.assertEqual(done["args"], {"description": "建节点"})


class HelpersTests(unittest.TestCase):
    def test_parse_arguments_tolerates_dirty_values(self):
        self.assertEqual(stream.parse_arguments(""), {})
        self.assertEqual(stream.parse_arguments("not-json"), {})
        self.assertEqual(stream.parse_arguments("[1,2]"), {})
        self.assertEqual(stream.parse_arguments('{"a":1}'), {"a": 1})
        self.assertEqual(stream.parse_arguments({"a": 1}), {"a": 1})

    def test_parse_stream_text_returns_deltas_and_raw(self):
        text = chunk({"reasoning_content": "想"}) + chunk({"content": "说"}) + "data: [DONE]\n\n"
        parsed = stream.parse_stream_text(text)
        self.assertEqual([item["type"] for item in parsed["deltas"]], ["reasoning", "content"])
        self.assertEqual(parsed["raw"]["choices"][0]["message"]["content"], "说")

    def test_empty_stream_has_empty_raw_message(self):
        parser = stream.StreamParser()
        self.assertEqual(parser.feed(""), [])
        self.assertEqual(parser.finish(), [])
        self.assertEqual(parser.raw()["choices"][0]["message"],
                         {"role": "assistant", "content": ""})


if __name__ == "__main__":
    unittest.main()
