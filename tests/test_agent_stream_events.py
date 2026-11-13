# -*- coding: utf-8 -*-
"""阶段三·1 流式输出：main.py 接线 / 三类事件 / 降级 / 开关关闭。

覆盖：
- 事件契约：reasoning_delta / message_delta / tool_call_delta 的顺序、id（run:round:类型:序号）、round、内容；
- 工具调用：名字先到先发一条（description 空），参数收齐后同 id 再补一条带 description；
- 降级：平台忽略 stream=true（整块 JSON）、流式报错、流式返回空 → 回退非流式并整段补发同样三类事件；
- 被拒后记入 _AGENT_STREAM_DENY，后续轮次不再试流式；
- 开关关闭：不发任何增量事件、仍走 _agent_run_chat_raw、thought 上限保持 300 字；
- 开关打开：thought 上限 1200 字；_agent_run_decide_v2（阶段一路径）同样走流式。
"""
import asyncio
import contextlib
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-agent-stream-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402

RUN_ID = "run_stream_test"


def chat_config(model="stream-model"):
    return {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
            "model": model, "provider_cfg": {"protocol": "openai"}, "think_level": ""}


TOOLS = {
    "create_node": {
        "description": "建节点",
        "schema": {"type": "object",
                   "properties": {"canvas_id": {"type": "string"}, "description": {"type": "string"}},
                   "required": ["canvas_id"]},
    },
}

NATIVE_RAW = {"choices": [{"message": {
    "content": "先看画布",
    "reasoning_content": "我需要先读画布再决定",
    "tool_calls": [{"id": "call_raw", "type": "function",
                    "function": {"name": "create_node",
                                 "arguments": json.dumps({"canvas_id": "c1",
                                                          "description": "新建文本节点"})}}]}}]}


def sse(payload, finish_reason=None):
    choice = {"delta": payload}
    if finish_reason is not None:
        choice["finish_reason"] = finish_reason
    return json.dumps({"choices": [choice]}, ensure_ascii=False)


class FakeResponse:
    def __init__(self, lines=None, body="", status_code=200, content_type="text/event-stream"):
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self._lines = list(lines or [])
        self._body = body

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return self._body.encode("utf-8")

    async def aclose(self):
        return None


class RaisingStream(object):
    def __init__(self, exc):
        self.exc = exc

    async def __aenter__(self):
        raise self.exc

    async def __aexit__(self, *exc_info):
        return False


@contextlib.contextmanager
def run_context(events=None, round_no=1):
    emit = None
    if events is not None:
        def emit(name, data):
            events.append((name, dict(data)))
    tokens = [
        main._AGENT_RUN_ID.set(RUN_ID),
        main._AGENT_RUN_ROUND.set(round_no),
        main._AGENT_RUN_EMIT.set(emit),
        main._AGENT_RUN_STREAM_OUT.set(False),
    ]
    try:
        yield events
    finally:
        main._AGENT_RUN_STREAM_OUT.reset(tokens[3])
        main._AGENT_RUN_EMIT.reset(tokens[2])
        main._AGENT_RUN_ROUND.reset(tokens[1])
        main._AGENT_RUN_ID.reset(tokens[0])


def recorder():
    events = []

    def emit(name, data):
        events.append((name, dict(data)))

    return events, emit


def fake_stream(responses, calls=None):
    @contextlib.asynccontextmanager
    async def _stream(client, url, headers, body, think_fields):
        if calls is not None:
            calls.append(body)
        response = responses.pop(0) if responses else FakeResponse(lines=[])
        yield response, body
    return _stream


def name_of(event):
    return event[0]


def data_of(event):
    return event[1]


class StreamEventTests(unittest.TestCase):
    def setUp(self):
        self._stream_deny = set(main._AGENT_STREAM_DENY)
        self._native_deny = set(main._AGENT_NATIVE_DENY)
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_NATIVE_DENY.clear()

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_DENY.update(self._stream_deny)
        main._AGENT_NATIVE_DENY.clear()
        main._AGENT_NATIVE_DENY.update(self._native_deny)

    def test_stream_emits_three_event_types_in_order_with_ids(self):
        lines = [
            sse({"reasoning_content": "先想"}),
            sse({"content": "好的"}),
            sse({"reasoning_content": "，再想"}),
            sse({"tool_calls": [{"index": 0, "id": "call_a",
                                 "function": {"name": "create_node", "arguments": ""}}]}),
            sse({"tool_calls": [{"index": 0,
                                 "function": {"arguments": '{"canvas_id":"c1",'}}]}),
            sse({"tool_calls": [{"index": 0,
                                 "function": {"arguments": '"description":"新建文本节点"}'}}]}),
            sse({"content": "，开始建"}, finish_reason="tool_calls"),
            "data: [DONE]",
        ]
        events, emit = recorder()

        async def go():
            with patch.object(main, "chat_stream_with_think", new=fake_stream([FakeResponse(lines)])):
                return await main._agent_run_decide(chat_config(), "SYS", "用户指令", "c1", "[]", TOOLS)

        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            decision = asyncio.run(go())
        names = [name_of(event) for event in events]
        # C4：正文开头不是 { / 代码围栏 → 一到就发；推理与工具增量也一到就发
        self.assertEqual(names, ["reasoning_delta", "message_delta", "reasoning_delta",
                                 "tool_call_delta", "message_delta", "tool_call_delta"])
        self.assertEqual([data_of(e)["id"] for e in events], [
            RUN_ID + ":1:rd:1", RUN_ID + ":1:md:1", RUN_ID + ":1:rd:2",
            RUN_ID + ":1:tc:0", RUN_ID + ":1:md:2", RUN_ID + ":1:tc:0"])
        self.assertTrue(all(data_of(event)["round"] == 1 for event in events))
        self.assertEqual(data_of(events[0])["text"], "先想")
        self.assertEqual(data_of(events[1])["text"], "好的")
        self.assertEqual(data_of(events[2])["text"], "，再想")
        self.assertEqual(data_of(events[3])["tool"], "create_node")
        self.assertEqual(data_of(events[3])["description"], "", "工具名一到先发一条，描述还没到")
        self.assertEqual(data_of(events[4])["text"], "，开始建")
        self.assertEqual(data_of(events[5])["tool"], "create_node")
        self.assertEqual(data_of(events[5])["description"], "新建文本节点")
        self.assertFalse([event for event in events if name_of(event) == "tool_call_delta"
                          and data_of(event)["description"] == "" and data_of(event)["tool"] != "create_node"])
        self.assertEqual(decision["steps"][0]["tool"], "create_node")
        self.assertEqual(decision["steps"][0]["args"], {"canvas_id": "c1"})
        self.assertEqual(decision["steps"][0]["description"], "新建文本节点")
        self.assertNotIn("p:stream-model", main._AGENT_STREAM_DENY)

    def test_platform_ignores_stream_and_returns_whole_json(self):
        events, _ = recorder()
        body = json.dumps(NATIVE_RAW, ensure_ascii=False)

        async def go():
            with patch.object(main, "chat_stream_with_think",
                              new=fake_stream([FakeResponse(body=body, content_type="application/json")])):
                return await main._agent_run_decide(chat_config(), "SYS", "用户指令", "c1", "[]", TOOLS)

        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            decision = asyncio.run(go())
        self.assertEqual([name_of(event) for event in events],
                         ["reasoning_delta", "message_delta", "tool_call_delta"])
        self.assertEqual(data_of(events[0])["text"], "我需要先读画布再决定")
        self.assertEqual(data_of(events[1])["text"], "先看画布")
        self.assertEqual(data_of(events[2])["description"], "新建文本节点")
        self.assertEqual(decision["steps"][0]["args"], {"canvas_id": "c1"})

    def test_stream_rejected_records_deny_and_bulk_emits_fallback(self):
        events, _ = recorder()
        stream_calls = []

        def rejected(*args, **kwargs):
            stream_calls.append(True)
            return RaisingStream(main.AgentRunError("平台不支持工具参数流", code="provider_http_error"))

        raw_mock = AsyncMock(return_value=NATIVE_RAW)
        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                patch.object(main, "chat_stream_with_think", new=rejected), \
                patch.object(main, "_agent_run_chat_raw", new=raw_mock):
            decision = asyncio.run(main._agent_run_decide(chat_config(), "SYS", "用户指令", "c1", "[]", TOOLS))
        self.assertEqual(len(stream_calls), 1)
        self.assertEqual(raw_mock.await_count, 1)
        self.assertIn("p:stream-model", main._AGENT_STREAM_DENY)
        self.assertEqual([name_of(event) for event in events],
                         ["reasoning_delta", "message_delta", "tool_call_delta"])
        self.assertEqual(data_of(events[2])["description"], "新建文本节点")
        self.assertEqual(decision["steps"][0]["tool"], "create_node")
        # 第二轮回退：已经记过拒绝名单，不再尝试流式，直接整段补发
        events2, _ = recorder()
        raw_mock2 = AsyncMock(return_value=NATIVE_RAW)
        with run_context(events2, round_no=2), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                patch.object(main, "chat_stream_with_think", new=rejected), \
                patch.object(main, "_agent_run_chat_raw", new=raw_mock2):
            asyncio.run(main._agent_run_decide(chat_config(), "SYS", "用户指令", "c1", "[]", TOOLS))
        self.assertEqual(len(stream_calls), 1, "被拉黑之后不该再试流式")
        self.assertEqual([name_of(event) for event in events2],
                         ["reasoning_delta", "message_delta", "tool_call_delta"])
        self.assertEqual(data_of(events2[2])["id"], RUN_ID + ":2:tc:0")

    def test_empty_stream_falls_back_to_raw_once(self):
        events, _ = recorder()
        raw_mock = AsyncMock(return_value=NATIVE_RAW)
        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                patch.object(main, "chat_stream_with_think", new=fake_stream([FakeResponse([])])), \
                patch.object(main, "_agent_run_chat_raw", new=raw_mock):
            decision = asyncio.run(main._agent_run_decide(chat_config(), "SYS", "用户指令", "c1", "[]", TOOLS))
        self.assertIn("p:stream-model", main._AGENT_STREAM_DENY)
        self.assertEqual(raw_mock.await_count, 1)
        self.assertEqual([name_of(event) for event in events],
                         ["reasoning_delta", "message_delta", "tool_call_delta"])
        self.assertEqual(decision["steps"][0]["tool"], "create_node")

    def test_switch_off_emits_nothing_and_keeps_raw_path(self):
        events, _ = recorder()
        raw_mock = AsyncMock(return_value=NATIVE_RAW)
        stream_mock = AsyncMock(side_effect=AssertionError("开关关闭时不能走流式"))
        env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2_STREAM")}
        with run_context(events), patch.dict(os.environ, env, clear=True), \
                patch.object(main, "chat_stream_with_think", new=stream_mock), \
                patch.object(main, "_agent_run_chat_raw", new=raw_mock):
            decision = asyncio.run(main._agent_run_decide(chat_config(), "SYS", "用户指令", "c1", "[]", TOOLS))
        self.assertEqual(events, [], "开关关闭不能发任何增量事件")
        self.assertEqual(raw_mock.await_count, 1)
        self.assertFalse(main._agent_v2_stream_enabled())
        self.assertEqual(decision["steps"][0]["tool"], "create_node")


class ThoughtLimitTests(unittest.TestCase):
    def test_thought_limit_is_300_off_and_1200_on(self):
        content = "想" * 5000
        raw = {"choices": [{"message": {"content": content, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "create_node", "arguments": "{}"}}]}}]}
        env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2_STREAM")}
        with patch.dict(os.environ, env, clear=True):
            off = main._agent_decision_from_native(raw, "c1", TOOLS)
            self.assertEqual(len(off["thought"]), 300)
            self.assertEqual(len(main._agent_decision_thought(off)), 300)
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            on = main._agent_decision_from_native(raw, "c1", TOOLS)
            self.assertEqual(len(on["thought"]), 1200)
            self.assertEqual(len(main._agent_decision_thought(on)), 1200)

    def test_reasoning_stays_out_of_thought(self):
        raw = {"choices": [{"message": {"content": "先看画布", "reasoning_content": "英文长推理 " * 200,
                                        "tool_calls": [{"id": "c1", "type": "function",
                                                        "function": {"name": "create_node",
                                                                     "arguments": "{}"}}]}}]}
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            decision = main._agent_decision_from_native(raw, "c1", TOOLS)
        self.assertEqual(decision["reasoning"].strip(), ("英文长推理 " * 200).strip())
        thought = main._agent_decision_thought(decision)
        self.assertNotIn("英文长推理", thought, "原生推理单独走 reasoning_delta，不混进 thought")


class V2DecideStreamTests(unittest.TestCase):
    def setUp(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_NATIVE_DENY.clear()

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_NATIVE_DENY.clear()

    def test_v2_decide_also_streams(self):
        lines = [sse({"reasoning_content": "阶段一推理"}),
                 sse({"content": "做海报"}),
                 sse({"tool_calls": [{"index": 0, "id": "call_v2",
                                      "function": {"name": "create_node",
                                                   "arguments": '{"canvas_id":"c1","description":"建节点"}'}}]}),
                 sse({}, finish_reason="tool_calls")]
        events, _ = recorder()
        messages = [{"role": "system", "content": "SYS"}, {"role": "user", "content": "做海报"}]

        async def go():
            with patch.object(main, "chat_stream_with_think", new=fake_stream([FakeResponse(lines)])):
                return await main._agent_run_decide_v2(chat_config(), messages, "c1", "[]", TOOLS)

        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            decision = asyncio.run(go())
        self.assertEqual([name_of(event) for event in events],
                         ["reasoning_delta", "message_delta", "tool_call_delta", "tool_call_delta"])
        self.assertEqual(decision["steps"][0]["tool"], "create_node")
        self.assertEqual(decision["steps"][0]["description"], "建节点")




class JsonDecisionContentTests(unittest.TestCase):
    """缺陷 1：决策 JSON 不能被当成「回复正文」流进气泡（message_delta 只能承载给用户看的话）。"""

    def setUp(self):
        self._stream_deny = set(main._AGENT_STREAM_DENY)
        self._native_deny = set(main._AGENT_NATIVE_DENY)
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_NATIVE_DENY.clear()

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_DENY.update(self._stream_deny)
        main._AGENT_NATIVE_DENY.clear()
        main._AGENT_NATIVE_DENY.update(self._native_deny)

    def _run(self, chat=None):
        events, _ = recorder()
        decision = {"thought": "先看画布", "steps": [
            {"tool": "create_node", "args": {"canvas_id": "c1", "description": "建节点"}}]}
        text = json.dumps(decision, ensure_ascii=False)
        lines = [sse({"reasoning_content": "先想一下"}),
                 sse({"content": text[:30]}),
                 sse({"content": text[30:]}),
                 sse({"content": ""}, finish_reason="stop")]
        seen_stream = []

        async def go():
            with patch.object(main, "chat_stream_with_think",
                              new=fake_stream([FakeResponse(lines)], calls=seen_stream)), \
                    patch.object(main, "_agent_run_chat_raw",
                                 new=AsyncMock(side_effect=AssertionError("这条用例不该走非流式"))):
                return await main._agent_run_decide(chat or chat_config(), "SYS", "用户指令",
                                                    "c1", "[]", TOOLS)

        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            result = asyncio.run(go())
        return events, result

    def test_json_decision_emits_no_message_delta(self):
        events, decision = self._run()
        names = [name_of(event) for event in events]
        self.assertIn("reasoning_delta", names, "reasoning_delta 保留")
        self.assertNotIn("message_delta", names, "决策 JSON 绝不能当回复正文流出去")
        self.assertEqual(decision["steps"][0]["tool"], "create_node")
        self.assertEqual(decision["steps"][0]["args"]["canvas_id"], "c1")

    def test_plain_native_answer_still_streams_message_delta(self):
        """没有工具调用的正常自然语言回答仍要发 message_delta（不是把正文一律掐掉）。"""
        events, _ = recorder()
        lines = [sse({"content": "这是"}), sse({"content": "一句人话回复"}, finish_reason="stop")]

        async def go():
            with patch.object(main, "chat_stream_with_think", new=fake_stream([FakeResponse(lines)])), \
                    patch.object(main, "_agent_run_chat_raw",
                                 new=AsyncMock(side_effect=AssertionError("这条用例不该走非流式"))):
                return await main._agent_run_decide(chat_config(), "SYS", "用户指令", "c1", "[]", TOOLS)

        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            decision = asyncio.run(go())
        names = [name_of(event) for event in events]
        self.assertEqual(names, ["message_delta", "message_delta"])
        self.assertEqual(data_of(events[0])["text"] + data_of(events[1])["text"], "这是一句人话回复")
        self.assertEqual(decision.get("message"), "这是一句人话回复")
        self.assertTrue(decision.get("done"))

    def test_non_stream_json_fallback_skips_message_delta_for_decision(self):
        """整段降级（平台不支持流式）同样不能把决策 JSON 当回复发出去。"""
        events, _ = recorder()
        raw = {"choices": [{"message": {
            "content": json.dumps({"thought": "先看", "steps": [
                {"tool": "create_node", "args": {"canvas_id": "c1"}}]}),
            "reasoning_content": "想一下"}}]}

        def rejected(*args, **kwargs):
            return RaisingStream(main.AgentRunError("不支持流式", code="provider_http_error"))

        with run_context(events), patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                patch.object(main, "chat_stream_with_think", new=rejected), \
                patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw)):
            decision = asyncio.run(main._agent_run_decide(chat_config(), "SYS", "用户指令",
                                                          "c1", "[]", TOOLS))
        names = [name_of(event) for event in events]
        self.assertIn("reasoning_delta", names)
        self.assertNotIn("message_delta", names)
        self.assertEqual(decision["steps"][0]["tool"], "create_node")


def _prompt_for(canvas_id, chat=None, history=""):
    """用真实的 _CanvasRunContext 构造系统提示词；chat 给了就放进运行上下文。"""
    token = main._AGENT_RUN_CHAT.set(chat) if chat is not None else None
    try:
        ctx = main._CanvasRunContext({"canvas_id": canvas_id, "instruction": "做一张海报",
                                      "focus": main._agent_run_normalize_focus(None)})
        snapshot = json.loads(json.dumps(main.load_canvas(canvas_id)))
        return ctx.build_system_prompt(snapshot, "[]", history)
    finally:
        if token is not None:
            main._AGENT_RUN_CHAT.reset(token)


class NativeOutputPromptTests(unittest.TestCase):
    """缺陷 2：确实走原生工具时，BEAT 的输出格式段换成「直接调用工具」；JSON 模式逐字不变。"""

    @classmethod
    def setUpClass(cls):
        cls.beat_id = "c-native-prompt-" + uuid.uuid4().hex[:8]
        main.save_canvas({"id": cls.beat_id, "title": "提示词分支验收", "kind": "classic",
                          "updated_at": int(main.time.time() * 1000),
                          "nodes": [{"id": "n1", "kind": "text", "x": 0, "y": 0,
                                     "text": "冷蓝色调", "data": {}}],
                          "connections": []})

    def setUp(self):
        root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
        candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
        if not any(root == item or root.startswith(item + os.sep) for item in candidates):
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")

    def test_native_beat_prompt_swaps_the_output_format_section(self):
        native = {"provider": "p", "model": "gpt-4o-mini", "provider_cfg": {"protocol": "openai"},
                  "base": "http://x", "headers": {}}
        prompt = _prompt_for(self.beat_id, native, "")
        self.assertIn("直接调用工具", prompt)
        self.assertNotIn("# 输出格式：只返回 JSON", prompt)
        self.assertIn("不要输出 JSON", prompt)
        prefix_prompt = _prompt_for(self.beat_id, native, "")
        self.assertIn("直接调用工具", prefix_prompt)

    def test_json_mode_prompt_keeps_the_original_json_section(self):
        plain = _prompt_for(self.beat_id, None, "")
        json_mode = _prompt_for(self.beat_id, {"provider": "p", "model": "m",
                                               "provider_cfg": {"protocol": "custom"},
                                               "base": "http://x", "headers": {}}, "")
        self.assertIn("# 输出格式：只返回 JSON", plain)
        self.assertNotIn("直接调用工具", plain)
        self.assertEqual(json_mode, plain, "非原生链路（JSON 模式）的系统提示词必须逐字不变")

    def test_output_format_block_selector(self):
        self.assertIs(main._agent_output_format_block(), main._AGENT_OUTPUT_JSON_BLOCK)
        token = main._AGENT_RUN_CHAT.set({"provider": "p", "model": "m",
                                          "provider_cfg": {"protocol": "openai"},
                                          "base": "http://x", "headers": {}})
        try:
            self.assertIs(main._agent_output_format_block(), main._AGENT_OUTPUT_NATIVE_BLOCK)
        finally:
            main._AGENT_RUN_CHAT.reset(token)


class ProducerStreamEventTests(unittest.TestCase):
    """真跑一次 producer：增量事件确实走现有 emit（bus）下发，id 带 run/round。"""

    @classmethod
    def setUpClass(cls):
        cls.canvas_id = "c-stream-" + uuid.uuid4().hex[:8]
        main.save_canvas({"id": cls.canvas_id, "title": "流式验收画布", "kind": "beat",
                          "updated_at": int(main.time.time() * 1000),
                          "nodes": [{"id": "n1", "kind": "text", "x": 0, "y": 0,
                                     "text": "冷蓝色调", "data": {}}],
                          "connections": []})

    def setUp(self):
        root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
        candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
        if not any(root == item or root.startswith(item + os.sep) for item in candidates):
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_NATIVE_DENY.clear()

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_NATIVE_DENY.clear()

    def test_producer_publishes_deltas_through_bus(self):
        first = [sse({"reasoning_content": "先看画布"}),
                 sse({"content": "查一下"}),
                 sse({"tool_calls": [{"index": 0, "id": "call_p",
                                      "function": {"name": "get_canvas",
                                                   "arguments": json.dumps({"canvas_id": self.canvas_id})}}]}),
                 sse({}, finish_reason="tool_calls")]
        second = [sse({"content": "看完了"}, finish_reason="stop")]
        responses = [FakeResponse(first), FakeResponse(second)]
        req = {"canvas_id": self.canvas_id, "run_id": "run_stream_producer_" + uuid.uuid4().hex[:6],
               "instruction": "看看画布", "focus": main._agent_run_normalize_focus(None),
               "history": [], "thread_id": "", "chat": chat_config(), "max_steps": 0,
               "mode": "run", "approved_steps": [], "renderer": "beat",
               "use_thread": False, "enforce_write_confirmation": True}
        bus = main._agent_run_bus_new(req["run_id"], self.canvas_id)

        async def go():
            await main._agent_run_producer(req, None, bus=bus)

        env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2")}
        with patch.dict(os.environ, env, clear=True), \
                patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                patch.object(main, "chat_stream_with_think", new=fake_stream(responses)):
            asyncio.run(go())
        published = [(item["name"], item["data"]) for item in bus.get("events") or []]
        names = [name for name, _data in published]
        self.assertIn("reasoning_delta", names)
        self.assertIn("message_delta", names)
        self.assertIn("tool_call_delta", names)
        deltas = [(name, data) for name, data in published
                  if name in ("reasoning_delta", "message_delta", "tool_call_delta")]
        self.assertTrue(deltas)
        for name, data in deltas:
            self.assertTrue(str(data.get("id") or "").startswith(req["run_id"] + ":"),
                            "%s 的 id 要带 run_id: %r" % (name, data))
            self.assertIn(data.get("round"), (1, 2))
            if name == "tool_call_delta":
                self.assertEqual(data.get("tool"), "get_canvas")
        done = next(data for name, data in published if name == "done")
        self.assertEqual(done["status"], "ok", done)


if __name__ == "__main__":
    unittest.main()
