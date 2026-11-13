# -*- coding: utf-8 -*-
"""C4 / C5 / C6 / D1 / D2：流式实时性、JSON 模式流式、think 标签、看图提示恢复、recall 限制。

C4：正文开头不是 { / 代码围栏 → 第一条 message_delta 立即发（不等流结束）。
C5：JSON 分支也走流式；reasoning 实时；message 字段增量发；平台不支持时整段补发。
C6：<think> / <thinking> 段落转 reasoning_delta，不进 message_delta（跨分片也正确）。
D1：挂图那一轮之后 ctx.vision_mode_direct 恢复，后续轮不再提示「用户消息里附了图片」。
D2：记忆开关开、运行上下文没有可见画布集合时，recall(scope=all) 只查本次运行画布。
"""
import asyncio
import contextlib
import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-agent-fix3-stream-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import stream as stream_parser  # noqa: E402
from tests.test_agent_reflect import new_canvas, run_producer  # noqa: E402
from tests.test_agent_stream_events import (FakeResponse, RaisingStream, fake_stream,  # noqa: E402
                                            recorder, run_context, sse)

STORE = main._agent_memory_store


def stream_chat(model="gpt-4o-mini"):
    return {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
            "model": model, "provider_cfg": {"protocol": "openai"}, "think_level": ""}


def json_chat(model="json-mode-model"):
    return {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
            "model": model, "provider_cfg": {"protocol": "custom"}, "think_level": ""}


TOOLS = {
    "create_node": {
        "description": "建节点",
        "schema": {"type": "object", "properties": {"canvas_id": {"type": "string"}}},
    },
}


class SlowResponse(object):
    """C4：慢速 SSE —— 每 0.1 秒吐一个正文分片。"""

    def __init__(self, pieces, delay=0.1):
        self._pieces = list(pieces)
        self._delay = delay
        self.status_code = 200
        self.headers = {"content-type": "text/event-stream"}

    async def aiter_lines(self):
        for piece in self._pieces:
            await asyncio.sleep(self._delay)
            yield sse({"content": piece})

    async def aread(self):
        return b""

    async def aclose(self):
        return None


class RealtimeDeltaTests(unittest.TestCase):
    """C4：纯文字回复要实时发，不能攒到流结束。"""

    def setUp(self):
        main._AGENT_STREAM_DENY.clear()

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()

    def test_first_message_delta_arrives_immediately_and_stays_spread(self):
        pieces = ["字%d" % index for index in range(30)]
        events = []
        started_at = [0.0]

        def recording_emit(name, data):
            events.append((name, dict(data), time.monotonic() - started_at[0]))

        async def go2():
            started_at[0] = time.monotonic()
            with patch.object(main, "chat_stream_with_think",
                              new=fake_stream([SlowResponse(pieces, delay=0.1)])):
                return await main._agent_run_stream_chat(stream_chat(), [{"role": "user", "content": "hi"}])

        async def go3():
            return await go2()

        with run_context([]), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            tokens = [
                main._AGENT_RUN_ID.set("run_realtime"),
                main._AGENT_RUN_ROUND.set(1),
                main._AGENT_RUN_EMIT.set(recording_emit),
                main._AGENT_RUN_STREAM_OUT.set(False),
            ]
            try:
                asyncio.run(go3())
            finally:
                main._AGENT_RUN_STREAM_OUT.reset(tokens[3])
                main._AGENT_RUN_EMIT.reset(tokens[2])
                main._AGENT_RUN_ROUND.reset(tokens[1])
                main._AGENT_RUN_ID.reset(tokens[0])
        deltas = [(name, data, at) for name, data, at in events if name == "message_delta"]
        self.assertEqual(len(deltas), 30, "每个正文分片都要发一条 message_delta")
        first_at = deltas[0][2]
        last_at = deltas[-1][2]
        self.assertLess(first_at, 0.5, "首条 message_delta 应在 0.5 秒内发出，实际 %.3fs" % first_at)
        self.assertGreater(last_at - first_at, 1.5, "时间戳要分散，不能集中在流结束（%.3fs..%.3fs）"
                           % (first_at, last_at))
        self.assertEqual("".join(data["text"] for _n, data, _t in deltas), "".join(pieces))


class ThinkTagTests(unittest.TestCase):
    """C6：<think> 段落转 reasoning，跨分片正确。"""

    def test_think_tags_split_across_chunks(self):
        def content_sse(text):
            return "data: " + json.dumps({"choices": [{"delta": {"content": text}}]},
                                         ensure_ascii=False) + "\n\n"

        parser = stream_parser.StreamParser()
        deltas = []
        for piece in ["<think>", "我先", "想想", "</think>", "答案", "是 42"]:
            deltas.extend(parser.feed(content_sse(piece)))
        deltas.extend(parser.finish())
        content = "".join(item["text"] for item in deltas if item["type"] == "content")
        reasoning = "".join(item["text"] for item in deltas if item["type"] == "reasoning")
        self.assertEqual(content, "答案是 42")
        self.assertEqual(reasoning, "我先想想")
        self.assertNotIn("<think>", content)

    def test_partial_tag_across_chunks(self):
        def content_sse(text):
            return "data: " + json.dumps({"choices": [{"delta": {"content": text}}]},
                                         ensure_ascii=False) + "\n\n"

        parser = stream_parser.StreamParser()
        deltas = []
        for piece in ["<thi", "nk>隐", "藏</thi", "nk>可见"]:
            deltas.extend(parser.feed(content_sse(piece)))
        deltas.extend(parser.finish())
        content = "".join(item["text"] for item in deltas if item["type"] == "content")
        reasoning = "".join(item["text"] for item in deltas if item["type"] == "reasoning")
        self.assertEqual(content, "可见")
        self.assertEqual(reasoning, "隐藏")


class JsonModeStreamTests(unittest.TestCase):
    """C5：JSON 分支也走流式。"""

    def setUp(self):
        main._AGENT_STREAM_DENY.clear()

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()

    def _lines(self, pieces, reasoning=None):
        lines = []
        if reasoning:
            lines.append(sse({"reasoning_content": reasoning}))
        for piece in pieces:
            lines.append(sse({"content": piece}))
        lines.append(sse({"content": ""}, finish_reason="stop"))
        return lines

    def test_json_branch_streams_message_field_without_json_noise(self):
        reply = json.dumps({"thought": "先想一下", "done": True, "message": "最终回复"},
                           ensure_ascii=False)
        pieces = [reply[:10], reply[10:25], reply[25:]]
        events, _ = recorder()

        async def go():
            with patch.object(main, "chat_stream_with_think",
                              new=fake_stream([FakeResponse(self._lines(pieces, "先推理"))])):
                return await main._agent_run_decide(json_chat(), "SYS", "用户指令", "c1", "[]", TOOLS)

        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            decision = asyncio.run(go())
        message_deltas = [data["text"] for name, data in events if name == "message_delta"]
        reasoning_deltas = [data["text"] for name, data in events if name == "reasoning_delta"]
        self.assertEqual("".join(message_deltas), "最终回复")
        self.assertNotIn("{", "".join(message_deltas))
        self.assertNotIn('"', "".join(message_deltas))
        self.assertIn("先推理", "".join(reasoning_deltas))
        self.assertTrue(decision.get("done"))
        self.assertEqual(decision.get("message"), "最终回复")

    def test_json_branch_falls_back_to_whole_return_with_events(self):
        reply = json.dumps({"thought": "先想", "done": True, "message": "最终回复"},
                           ensure_ascii=False)
        raw = {"choices": [{"message": {"content": reply, "reasoning_content": "整段推理"}}]}
        events, _ = recorder()

        def rejected(*args, **kwargs):
            return RaisingStream(main.AgentRunError("不支持流式", code="provider_http_error"))

        async def go():
            with patch.object(main, "chat_stream_with_think", new=rejected), \
                    patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw)):
                return await main._agent_run_decide(json_chat(), "SYS", "用户指令", "c1", "[]", TOOLS)

        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            decision = asyncio.run(go())
        message_deltas = [data["text"] for name, data in events if name == "message_delta"]
        reasoning_deltas = [data["text"] for name, data in events if name == "reasoning_delta"]
        self.assertEqual("".join(message_deltas), "最终回复")
        self.assertEqual("".join(reasoning_deltas), "整段推理")
        self.assertEqual(decision.get("message"), "最终回复")


class VisionModeRestoreTests(unittest.TestCase):
    """D1：挂图只影响那一轮，之后不再提示「用户消息里附了图片」。"""

    def setUp(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_VISION_DENY.clear()

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_VISION_DENY.clear()

    def test_vision_hint_disappears_after_the_attached_round(self):
        canvas_id = new_canvas("d1-vision")
        decisions = [
            {"steps": [{"tool": "view_image", "args": {"node_id": "img1"}}]},
            {"steps": [{"tool": "get_canvas", "args": {"canvas_id": canvas_id}}]},
            {"done": True, "message": "好了"},
        ]
        messages_seen = []
        pending = list(decisions)

        async def fake_decide(chat, messages, cid, tools_json_text="", tools=None, rebuild_json=None):
            messages_seen.append([dict(message) for message in messages])
            return pending.pop(0) if pending else {"done": True, "message": "完成"}

        async def execute(tool, args):
            if tool == "view_image":
                return {"ok": True, "tool": tool, "message": "执行成功",
                        "result": {"view_images": [{"url": "https://example.invalid/a.png",
                                                    "label": "海报"}]}}
            return {"ok": True, "tool": tool, "message": "执行成功",
                    "result": {"status": "queued_on_canvas", "node_id": "img1", "kind": "image"}}

        view_entry = {"description": "看图", "schema": {"type": "object", "properties": {}},
                      "validate": lambda args: args, "run": lambda args: {},
                      "mutates_canvas": False}
        tools_map = dict(main.AGENT_TOOLS)
        tools_map["view_image"] = view_entry
        req = {"canvas_id": canvas_id, "run_id": "run_d1_" + uuid.uuid4().hex[:8],
               "instruction": "看看这张图", "focus": main._agent_run_normalize_focus(None),
               "history": [], "thread_id": "", "chat": json_chat("gpt-4o-mini"),
               "max_steps": 0, "mode": "run", "approved_steps": [], "renderer": "beat",
               "use_thread": False, "enforce_write_confirmation": True}
        bus = main._agent_run_bus_new(req["run_id"], canvas_id)

        async def go():
            await main._agent_run_producer(req, None, bus=bus)

        env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2")}
        env["NOVAI_AGENT_V2_CONTEXT"] = "1"
        with patch.dict(os.environ, env, clear=True), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide), \
                patch.object(main, "agent_execute_step", new=execute), \
                patch.object(main._CanvasRunContext, "tools", new=lambda self: tools_map), \
                patch.object(main._CanvasRunContext, "wait_canvas_results",
                             new=AsyncMock(return_value=[])), \
                patch.object(main._CanvasRunContext, "confirmation_needed",
                             new=lambda self, steps, confirmed=False: {"needed": False, "tools": []}), \
                patch.object(main, "_agent_beat_review", new=AsyncMock(return_value=None)), \
                patch.object(main, "_agent_v2_memory_schedule", new=lambda *a, **k: None):
            with contextlib.redirect_stdout(__import__("io").StringIO()):
                asyncio.run(go())
        texts = ["\n".join(str(message.get("content") or "") for message in messages)
                 for messages in messages_seen]
        self.assertGreaterEqual(len(texts), 3, texts)
        self.assertIn("用户消息里附了图片", texts[1], "挂图的那一轮要有看图提示")
        self.assertNotIn("用户消息里附了图片", texts[2], "挂图那一轮之后不能再提示")


class RecallScopeWithoutAllowedTests(unittest.TestCase):
    """D2：运行上下文没有可见画布集合时，scope=all 只能查本次运行画布。"""

    def setUp(self):
        self._index_path = None
        if not hasattr(self, "canvas_id"):
            self.canvas_id = "c-d2-mine-" + uuid.uuid4().hex[:8]
            self.other_id = "c-d2-other-" + uuid.uuid4().hex[:8]
        self._memory_old = os.environ.get("NOVAI_AGENT_V2_MEMORY")
        os.environ["NOVAI_AGENT_V2_MEMORY"] = "1"
        self._index_path = os.path.join(main.AGENT_MEMORY_DIR, STORE.INDEX_FILENAME)
        if os.path.exists(self._index_path):
            os.remove(self._index_path)
        STORE.MemoryIndex(main.AGENT_MEMORY_DIR).add([
            STORE.make_entry("message", "乙的私人秘方 冷蓝配方", canvas_id=self.other_id,
                             canvas_title="乙的画布", thread_id="tb", thread_title="乙的对话",
                             ts=1700000300),
        ])

    def tearDown(self):
        main._AGENT_RUN_ALLOWED_CANVASES.set(None)
        main._AGENT_RUN_CANVAS_ID.set("")
        if self._index_path and os.path.exists(self._index_path):
            os.remove(self._index_path)
        if self._memory_old is None:
            os.environ.pop("NOVAI_AGENT_V2_MEMORY", None)
        else:
            os.environ["NOVAI_AGENT_V2_MEMORY"] = self._memory_old

    def test_all_scope_without_allowed_set_is_limited_to_run_canvas(self):
        main._AGENT_RUN_CANVAS_ID.set(self.canvas_id)
        main._AGENT_RUN_ALLOWED_CANVASES.set(None)
        payload = main._agent_v2_recall_run({"query": "私人秘方", "scope": "all",
                                             "canvas_id": self.canvas_id, "thread_id": "",
                                             "limit": 5})
        self.assertEqual(payload["count"], 0, "没传可见画布集合时不能翻到其它画布")


if __name__ == "__main__":
    unittest.main()
