# -*- coding: utf-8 -*-
"""修复清单 A2 / A3 / A4 / A6 的 main.py 接线回归（不动 server/agent_core 纯模块）。

A2 view_image：步骤成功后收集 result 里的 view_images，下一轮用 _agent_image_payload_url 转成 image_url
               挂到最后一条 user 消息；看不了图的模型走 _agent_run_vision_setup 转述、描述写进这条结果；
               图只进那一轮、不进转录。
A3 非 BEAT 画布：use_v2_context 增加 BEAT 条件，旧智能画布 / 经典画布继续旧路径——
               验收：CONTEXT=1 时旧智能画布的系统提示词与开关关闭时逐字一致。
A4 只开 CONTEXT 不开 READ_TOOLS：map_mode=False，发给模型的消息里不出现 read_node / search_canvas。
A6 producer：CONTEXT=1 下用打桩模型跑通 JSON 模式与原生模式各一次；
               _agent_run_decide_v2 原生被拒回退时用非原生方式重新组装消息再发（不发 tool 角色消息）。
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-fix-main-wiring-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402

IMAGE_URL = "https://example.invalid/fix-main-poster.png"


@contextlib.contextmanager
def flags(**kwargs):
    """临时改 NOVAI_AGENT_V2_* / NOVAI_AGENT_NATIVE_TOOLS 等开关，退出还原。"""
    keys = {}
    for key, value in kwargs.items():
        if key in ("CONTEXT", "TRANSCRIPT", "READ_TOOLS", "MEMORY"):
            name = "NOVAI_AGENT_V2_" + key
        elif key.startswith("NOVAI_"):
            name = key
        else:
            name = "NOVAI_AGENT_" + key
        keys[name] = value
    old = {name: os.environ.get(name) for name in keys}
    try:
        for name, value in keys.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = str(value)
        yield
    finally:
        for name, value in old.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def chat_config(model="gpt-4o", protocol="custom"):
    return {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
            "model": model, "provider_cfg": {"protocol": protocol}, "think_level": ""}


def beat_canvas(canvas_id, title="修复验收画布"):
    return {"id": canvas_id, "title": title, "kind": "beat",
            "updated_at": int(main.time.time() * 1000),
            "nodes": [{"id": "img1", "kind": "image", "x": 0, "y": 0,
                       "data": {"gen": {"title": "海报", "prompt": "冷蓝色调海报",
                                        "hist": [{"url": IMAGE_URL}], "hi": 0}}}],
            "connections": []}


def smart_canvas(canvas_id, title="旧智能画布"):
    return {"id": canvas_id, "title": title, "kind": "smart",
            "updated_at": int(main.time.time() * 1000),
            "nodes": [{"id": "p1", "type": "smart-prompt", "title": "提示词", "x": 0, "y": 0,
                       "prompt": "黄昏海边", "images": [], "image_urls": []}],
            "connections": []}


def make_req(canvas_id, chat=None, renderer="", thread_id=""):
    return {"canvas_id": canvas_id, "run_id": "run_" + uuid.uuid4().hex[:12],
            "instruction": "看看现在的效果再改一版", "focus": main._agent_run_normalize_focus(None),
            "history": [], "thread_id": thread_id, "chat": chat or chat_config(),
            "max_steps": 0, "mode": "run", "approved_steps": [], "renderer": renderer,
            "use_thread": False, "enforce_write_confirmation": True}


def parse_events(chunks):
    events = []
    for chunk in chunks:
        if not isinstance(chunk, str):
            continue
        event = data = None
        for line in chunk.split("\n"):
            if line.startswith("event: "):
                event = line[len("event: "):].strip()
            elif line.startswith("data: "):
                data = json.loads(line[len("data: "):])
        if event:
            events.append({"event": event, "data": data})
    return events


def run_producer(req, bus=None):
    """跑一次真实 producer：给了 bus 就返回 bus，否则返回解析好的事件列表。"""
    if bus is not None:
        async def go_bus():
            await main._agent_run_producer(req, None, bus=bus)
        return asyncio.run(go_bus())

    async def go():
        queue = asyncio.Queue()
        await main._agent_run_producer(req, queue)
        chunks = []
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                break
            chunks.append(item)
        return chunks
    return parse_events(asyncio.run(go()))


def new_bus(req):
    return main._agent_run_bus_new(req["run_id"], req["canvas_id"])


def image_parts(messages):
    """消息列表里的 image_url 内容块（判断「这一轮有没有真的附图」）。"""
    out = []
    for message in messages or []:
        content = message.get("content")
        if isinstance(content, list):
            out.extend(item for item in content
                       if isinstance(item, dict) and item.get("type") == "image_url")
    return out


def last_user_content(messages):
    for message in reversed(messages or []):
        if message.get("role") == "user":
            return message.get("content")
    return None


def flat_text(messages):
    parts = []
    for message in messages or []:
        content = message.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    parts.append(str(item.get("text") or ""))
        else:
            parts.append(str(content or ""))
    return "\n".join(parts)


def temp_data_dir():
    """写盘用例只在临时数据目录里跑（macOS 的 /tmp 会软链到 /private/tmp，两种写法都认）。"""
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


class ViewImageWiringTests(unittest.TestCase):
    """A2：view_image 只登记「下一轮看这张图」，图只进那一轮、不进转录。"""

    @classmethod
    def setUpClass(cls):
        cls.canvas_id = "c-fixmain-vision-" + uuid.uuid4().hex[:8]
        main.save_canvas(beat_canvas(cls.canvas_id))

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        if main._agent_read_tools is None:
            self.skipTest("server/agent_core/read_tools 不可用")
        self._saved_tools = dict(main.AGENT_TOOLS)
        self._saved_free = set(main.AGENT_RUN_STEP_FREE_TOOLS)
        self._saved_free_tools = set(main.AGENT_FREE_TOOLS)
        main.AGENT_TOOLS.update(main._agent_v2_read_tool_entries())
        main.AGENT_RUN_STEP_FREE_TOOLS |= set(main._agent_read_tools.READ_TOOL_NAMES)
        main.AGENT_FREE_TOOLS |= set(main._agent_read_tools.READ_TOOL_NAMES)
        self._vision_deny = set(main._AGENT_VISION_DENY)

    def tearDown(self):
        main.AGENT_TOOLS.clear()
        main.AGENT_TOOLS.update(self._saved_tools)
        main.AGENT_RUN_STEP_FREE_TOOLS.clear()
        main.AGENT_RUN_STEP_FREE_TOOLS.update(self._saved_free)
        main.AGENT_FREE_TOOLS.clear()
        main.AGENT_FREE_TOOLS.update(self._saved_free_tools)
        main._AGENT_VISION_DENY.clear()
        main._AGENT_VISION_DENY.update(self._vision_deny)

    def _run(self, chat, decisions):
        rounds, decisions = [], list(decisions)

        async def fake_decide(chat_arg, messages, canvas_id, tools_json_text="", tools=None,
                              rebuild_json=None):
            rounds.append([dict(message) for message in messages])
            return decisions.pop(0) if decisions else {"done": True, "message": "完成"}

        req = make_req(self.canvas_id, chat=chat, renderer="beat")
        bus = new_bus(req)
        with flags(CONTEXT="1"), patch.object(main, "_agent_run_decide_v2", new=fake_decide):
            run_producer(req, bus)
        return rounds, bus

    def test_view_image_attached_only_to_the_next_round(self):
        decisions = [
            {"thought": "看看这张图", "steps": [{"tool": "view_image", "args": {"node_id": "img1"}}]},
            {"thought": "再看下画布", "steps": [{"tool": "get_canvas", "args": {"canvas_id": self.canvas_id}}]},
            {"done": True, "message": "看完了"},
        ]
        rounds, bus = self._run(chat_config("gpt-4o"), decisions)
        self.assertGreaterEqual(len(rounds), 3, "至少要有「看图」和「之后」两轮")
        second = last_user_content(rounds[1])
        self.assertIsInstance(second, list, "下一轮最后一条 user 消息要变成 content 数组")
        urls = [item["image_url"]["url"] for item in image_parts(rounds[1])]
        self.assertIn(IMAGE_URL, urls, "view_image 登记的图要真的挂进下一轮")
        self.assertEqual(image_parts(rounds[2]), [], "图只进下一轮，后面几轮不能再带")
        transcript = bus.get("transcript")
        self.assertIsNotNone(transcript, "CONTEXT=1 应该建了运行转录")
        for entry in transcript.results():
            text = str(entry.get("text") or "")
            # 转录里可以留图片地址，但绝不能出现「图片内容块 / base64」——那是只该进那一轮消息的东西
            self.assertNotIn('"type": "image_url"', text, "图片消息不能进转录")
            self.assertNotIn("data:image", text, "图片数据不能进转录")
            self.assertNotIn("base64", text, "图片数据不能进转录")

    def test_old_path_also_attaches_the_image_next_round(self):
        """没开 CONTEXT 的旧路径同样要接上 view_image：下一轮最后一条 user 消息变 content 数组。"""
        decisions = [
            {"steps": [{"tool": "view_image",
                        "args": {"canvas_id": self.canvas_id, "node_id": "img1"}}]},
            {"done": True, "message": "看完了"},
        ]
        seen = []

        async def fake_decide(chat, system, user_content, canvas_id, tools_json_text="", tools=None):
            seen.append((system, user_content))
            return decisions.pop(0) if decisions else {"done": True, "message": "完成"}

        req = make_req(self.canvas_id, chat=chat_config("gpt-4o"), renderer="beat")
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_CONTEXT": "0"}), \
                patch.object(main, "_agent_run_decide", new=fake_decide):
            run_producer(req)
        self.assertGreaterEqual(len(seen), 2)
        second = seen[1][1]
        self.assertIsInstance(second, list, "旧路径也要把图挂到下一轮的 user 消息上")
        urls = [item["image_url"]["url"] for item in second
                if isinstance(item, dict) and item.get("type") == "image_url"]
        self.assertIn(IMAGE_URL, urls)

    def test_non_vision_model_gets_caption_written_into_the_result(self):
        async def fake_captions(images, exclude_key="", failures=None):
            return ([{"label": image["label"], "caption": "一张冷蓝色调的海报"}
                     for image in images], "fake-vision")

        decisions = [
            {"thought": "看看这张图", "steps": [{"tool": "view_image", "args": {"node_id": "img1"}}]},
            {"done": True, "message": "看完了"},
        ]
        with patch.object(main, "_agent_caption_images", new=fake_captions):
            rounds, bus = self._run(chat_config("deepseek-chat"), decisions)
        text = flat_text(rounds[-1])
        self.assertIn("一张冷蓝色调的海报", text, "看不了图的模型要拿到文字转述")
        self.assertEqual(image_parts(rounds[-1]), [], "看不了图的模型不能收到图片内容块")
        transcript = bus.get("transcript")
        results = [str(entry.get("text") or "") for entry in transcript.results()]
        self.assertTrue(any("一张冷蓝色调的海报" in item for item in results),
                        "转述描述要写进这条步骤结果（转录里能看到）")


class CanvasKindPathTests(unittest.TestCase):
    """A3 / A4：只有 BEAT 用上下文引擎；只开 CONTEXT 时不能出现读工具的痕迹。"""

    @classmethod
    def setUpClass(cls):
        cls.beat_id = "c-fixmain-beat-" + uuid.uuid4().hex[:8]
        cls.smart_id = "c-fixmain-smart-" + uuid.uuid4().hex[:8]
        main.save_canvas(beat_canvas(cls.beat_id, title="BEAT 验收"))
        main.save_canvas(smart_canvas(cls.smart_id))

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")

    def _run_legacy(self, canvas_id, context_flag):
        seen = {}

        async def fake_decide(chat, system, user_content, canvas_id_arg, tools_json_text="", tools=None):
            seen["system"], seen["user"] = system, user_content
            return {"done": True, "message": "完成"}

        async def not_engine(*args, **kwargs):
            raise AssertionError("旧智能画布不该走上下文引擎")

        req = make_req(canvas_id, chat=chat_config(), renderer="")
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_CONTEXT": "1" if context_flag else "0"}), \
                patch.object(main, "_agent_run_decide", new=fake_decide), \
                patch.object(main, "_agent_run_decide_v2", new=not_engine):
            run_producer(req)
        return seen

    def test_smart_canvas_prompt_is_identical_with_context_on(self):
        off = self._run_legacy(self.smart_id, False)
        on = self._run_legacy(self.smart_id, True)
        self.assertTrue(off.get("system"))
        self.assertEqual(on["system"], off["system"], "旧智能画布的系统提示词必须逐字一致")
        self.assertEqual(on["user"], off["user"])

    def test_beat_canvas_uses_context_engine(self):
        seen = {}

        async def fake_decide_v2(chat, messages, canvas_id, tools_json_text="", tools=None,
                                 rebuild_json=None):
            seen["messages"] = messages
            return {"done": True, "message": "完成"}

        async def not_legacy(*args, **kwargs):
            raise AssertionError("BEAT 画布不该走旧的单段提示词路径")

        req = make_req(self.beat_id, chat=chat_config(), renderer="beat")
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_CONTEXT": "1"}), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide_v2), \
                patch.object(main, "_agent_run_decide", new=not_legacy):
            run_producer(req)
        self.assertIn("messages", seen, "BEAT 画布开了 CONTEXT 就要用消息列表")

    def test_context_only_never_mentions_read_tools(self):
        seen = {}

        async def fake_decide_v2(chat, messages, canvas_id, tools_json_text="", tools=None,
                                 rebuild_json=None):
            seen["messages"] = messages
            return {"done": True, "message": "完成"}

        req = make_req(self.beat_id, chat=chat_config(), renderer="beat")
        with flags(CONTEXT="1", READ_TOOLS="0"), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide_v2):
            run_producer(req)
        self.assertFalse(main._agent_v2_read_tools_enabled())
        flat = flat_text(seen["messages"])
        self.assertNotIn("read_node", flat)
        self.assertNotIn("search_canvas", flat)
        self.assertIn("画布快照摘要", flat,
                      "没开读工具时环境状态要用旧的完整摘要，不是画布地图")
        self.assertNotIn("地图只有每个节点的一行概要", flat, "没开读工具时不能出画布地图")


class ProducerRoundTripTests(unittest.TestCase):
    """A6：CONTEXT=1 下 JSON 模式与原生模式各真跑通一次 producer。"""

    @classmethod
    def setUpClass(cls):
        cls.canvas_id = "c-fixmain-prod-" + uuid.uuid4().hex[:8]
        main.save_canvas(beat_canvas(cls.canvas_id))

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")

    def test_json_mode_round_trip(self):
        calls = []

        async def fake_chat(chat, messages):
            calls.append(messages)
            if len(calls) == 1:
                return json.dumps({"thought": "先看画布",
                                   "steps": [{"tool": "get_canvas",
                                              "args": {"canvas_id": self.canvas_id}}]})
            return json.dumps({"done": True, "message": "看完了"})

        async def no_native(*args, **kwargs):
            raise AssertionError("JSON 模式不该走原生工具调用")

        req = make_req(self.canvas_id, chat=chat_config(), renderer="beat")
        with flags(CONTEXT="1", NATIVE_TOOLS="0"), \
                patch.object(main, "_agent_run_chat", new=fake_chat), \
                patch.object(main, "_agent_run_chat_raw", new=no_native):
            events = run_producer(req)
        steps = [item for item in events if item["event"] == "step_result"]
        self.assertTrue(steps, "没有 step_result 事件")
        self.assertTrue(steps[0]["data"]["ok"], steps[0]["data"])
        self.assertEqual(steps[0]["data"]["tool"], "get_canvas")
        done = next(item for item in events if item["event"] == "done")["data"]
        self.assertEqual(done["status"], "ok", done)
        self.assertTrue(calls, "打桩模型没被调用")

    def test_native_mode_round_trip(self):
        responses = [
            {"choices": [{"message": {"content": "先看画布", "tool_calls": [
                {"id": "call_1", "type": "function",
                 "function": {"name": "get_canvas",
                              "arguments": json.dumps({"canvas_id": self.canvas_id})}}]}}]},
            {"choices": [{"message": {"content": "看完了"}}]},
        ]
        seen = {}

        async def fake_raw(chat, messages, tools=None):
            seen.setdefault("tools", tools)
            return responses.pop(0)

        async def no_json(*args, **kwargs):
            raise AssertionError("原生调用成功时不该回退到 JSON")

        req = make_req(self.canvas_id, chat=chat_config("native-model", protocol="openai"),
                       renderer="beat")
        with flags(CONTEXT="1", NATIVE_TOOLS="1"), \
                patch.object(main, "_agent_run_chat_raw", new=fake_raw), \
                patch.object(main, "_agent_run_chat", new=no_json):
            events = run_producer(req)
        steps = [item for item in events if item["event"] == "step_result"]
        self.assertTrue(steps, "原生 tool_calls 没有变成可执行步骤")
        self.assertTrue(steps[0]["data"]["ok"], steps[0]["data"])
        self.assertEqual(steps[0]["data"]["tool"], "get_canvas")
        self.assertTrue(seen.get("tools"), "原生模式必须把工具定义发给平台")
        done = next(item for item in events if item["event"] == "done")["data"]
        self.assertEqual(done["status"], "ok", done)


class DecideV2NativeFallbackTests(unittest.TestCase):
    """A6：原生工具被平台拒绝 → 用非原生方式重新组装消息再发，不能带 tool 角色消息。"""

    def setUp(self):
        self._native_deny = set(main._AGENT_NATIVE_DENY)

    def tearDown(self):
        main._AGENT_NATIVE_DENY.clear()
        main._AGENT_NATIVE_DENY.update(self._native_deny)

    def _native_messages(self):
        return [
            {"role": "system", "content": "你是助手"},
            {"role": "user", "content": "做海报"},
            {"role": "assistant", "content": "先看画布", "tool_calls": [
                {"id": "call_1_0", "type": "function",
                 "function": {"name": "get_canvas", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call_1_0", "content": "画布结果"},
            {"role": "user", "content": "当前环境状态"},
        ]

    def _run(self, rebuild_json):
        sent = {}

        async def fake_raw(*args, **kwargs):
            raise main.AgentRunError("平台不认 tools", code="provider_http_error")

        async def fake_chat(chat, messages):
            sent["messages"] = messages
            return json.dumps({"done": True, "message": "改用 JSON 了"})

        chat = chat_config("reject-model", protocol="openai")
        with patch.object(main, "_agent_run_chat_raw", new=fake_raw), \
                patch.object(main, "_agent_run_chat", new=fake_chat):
            decision = asyncio.run(main._agent_run_decide_v2(
                chat, self._native_messages(), "c1", "[]", {}, rebuild_json=rebuild_json))
        return decision, sent["messages"]

    def test_fallback_reassembles_non_native_messages(self):
        json_messages = [
            {"role": "system", "content": "你是助手"},
            {"role": "user", "content": "做海报"},
            {"role": "user", "content": "执行结果：画布结果"},
            {"role": "user", "content": "当前环境状态"},
        ]
        calls = []

        async def rebuild():
            calls.append(True)
            return [dict(message) for message in json_messages]

        decision, sent = self._run(rebuild)
        self.assertEqual(decision.get("message"), "改用 JSON 了")
        self.assertTrue(calls, "原生回退必须重新组装消息")
        self.assertEqual(sent, json_messages)
        self.assertEqual([m for m in sent if m.get("role") == "tool"], [])
        self.assertEqual([m for m in sent if m.get("tool_calls")], [])
        self.assertIn("p:reject-model", main._AGENT_NATIVE_DENY,
                      "平台拒绝带 tools 后要记下来，后续同一模型不再试原生")

    def test_fallback_without_rebuild_strips_tool_roles(self):
        decision, sent = self._run(None)
        self.assertEqual(decision.get("message"), "改用 JSON 了")
        self.assertEqual([m for m in sent if m.get("role") == "tool"], [],
                         "没有重新组装时也绝不能把 tool 角色消息原样再发")
        self.assertEqual([m for m in sent if m.get("tool_calls")], [])
        self.assertTrue(any("画布结果" in str(m.get("content")) for m in sent),
                        "工具结果要以纯文本形式带上，不能丢")


if __name__ == "__main__":
    unittest.main()
