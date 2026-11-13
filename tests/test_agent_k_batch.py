# -*- coding: utf-8 -*-
"""K1~K5 回归：画布记忆进档案/开场、线程持久化卡片与时长、思考型流式放宽、字数自检、节点条目解析。

跑法：NOVAI_DATA_DIR=/tmp/novai-k-batch python3 -m pytest tests/test_agent_k_batch.py -q
写盘用例只在临时数据目录下跑（保护真实数据）。
"""
import asyncio
import contextlib
import io
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-k-batch-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402

STORE = main._agent_memory_store


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


@contextlib.contextmanager
def memory_on():
    old = os.environ.get("NOVAI_AGENT_V2_MEMORY")
    os.environ["NOVAI_AGENT_V2_MEMORY"] = "1"
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("NOVAI_AGENT_V2_MEMORY", None)
        else:
            os.environ["NOVAI_AGENT_V2_MEMORY"] = old


def new_canvas(kind="beat", nodes=None, title="K 验收画布"):
    canvas_id = "k-" + uuid.uuid4().hex[:10]
    main.save_canvas({"id": canvas_id, "title": title, "kind": kind,
                      "updated_at": int(main.time.time() * 1000),
                      "nodes": nodes if nodes is not None else [
                          {"id": "n1", "kind": "text", "x": 0, "y": 0, "text": "占位", "data": {}}],
                      "connections": []})
    return canvas_id


def save_thread(canvas_id, thread):
    doc = main._agent_thread_doc_load(canvas_id)
    doc["threads"] = [thread]
    doc["active_id"] = thread["id"]
    main._agent_thread_doc_save(canvas_id, doc)


class K1CanvasMemoryTests(unittest.TestCase):
    """K1：说「记住 …」→ 长期记忆 + 记忆索引 + 项目档案，新对话开场能拿到；同一句只存一条。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self._memory = memory_on()
        self._memory.__enter__()
        self.canvas_id = new_canvas()

    def tearDown(self):
        self._memory.__exit__(None, None, None)

    def _remember(self, text):
        args = main._agent_tool_remember_validate({"canvas_id": self.canvas_id,
                                                   "items": [text], "scope": "canvas"})
        return main._agent_tool_remember_run(args)

    def test_remember_lands_in_memory_profile_and_index(self):
        result = self._remember("主色是墨绿色")
        self.assertEqual(len(result["memory"]["items"]), 1)
        items = main.agent_memory_load(self.canvas_id, "canvas")
        self.assertEqual([item["text"] for item in items], ["主色是墨绿色"])
        profile = STORE.load_profile(main.AGENT_MEMORY_DIR, self.canvas_id)
        self.assertIn("主色是墨绿色", profile["prefs"], "画布记忆必须进项目档案")
        self.assertIn("主色是墨绿色", STORE.render_profile(profile))
        entries = main._agent_memory_store.MemoryIndex(main.AGENT_MEMORY_DIR).entries()
        sources = {str(row.get("source")) for row in entries if row.get("canvas_id") == self.canvas_id}
        self.assertIn("long_term_memory", sources)
        self.assertIn("canvas_profile", sources)

    def test_same_sentence_twice_stores_one(self):
        self._remember("主色是墨绿色")
        again = self._remember("主色是墨绿色")
        self.assertEqual(again["memory"]["items"], [], "同一句重复发送不能再存一条")
        prefixed = self._remember("记住：主色是墨绿色")
        self.assertEqual(prefixed["memory"]["items"], [], "带「记住：」前缀的同一句也算重复")
        self.assertEqual(len(main.agent_memory_load(self.canvas_id, "canvas")), 1)
        profile = STORE.load_profile(main.AGENT_MEMORY_DIR, self.canvas_id)
        self.assertEqual([item for item in profile["prefs"] if item == "主色是墨绿色"], ["主色是墨绿色"])

    def test_new_conversation_opening_injects_canvas_memory(self):
        self._remember("主色是墨绿色")

        class Ctx(object):
            canvas_id = self.canvas_id
            kind = "canvas"

        opening = main._agent_v2_memory_opening(Ctx(), {"messages": []}, "主色是什么", 128000)
        self.assertIn("墨绿色", opening, "同一张画布的新对话开场要带上记住的内容")
        memory_text = main._agent_v2_memory_text(Ctx(), "主色是什么", 128000)
        self.assertIn("墨绿色", memory_text, "每一轮的记忆段也要带上")

    def test_forget_removes_it_from_profile(self):
        self._remember("主色是墨绿色")
        main.agent_memory_remove(self.canvas_id, "canvas", text="主色是墨绿色")
        profile = STORE.load_profile(main.AGENT_MEMORY_DIR, self.canvas_id)
        self.assertNotIn("主色是墨绿色", profile["prefs"], "忘了之后档案里也不能留着")


class K2ThreadPersistenceTests(unittest.TestCase):
    """K2：思考 / 时长 / 自检 / 待生成方案随线程持久化；批准后不再重复给「执行」。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self.canvas_id = new_canvas()
        self.thread = main._agent_thread_new_thread("对话 1")
        save_thread(self.canvas_id, self.thread)

    def _append(self, record):
        main.agent_thread_append(self.canvas_id, [record], thread_id=self.thread["id"])
        doc = main._agent_thread_doc_load(self.canvas_id)
        return main._agent_thread_find(doc, self.thread["id"])["messages"][-1]

    def test_think_duration_self_check_and_plan_are_persisted(self):
        plan = {"intent": "生成图", "summary": "待生成 1 张", "requires_confirmation": True,
                "kind": "generation", "steps": [{"tool": "run_generation", "args": {"node_id": "n1"}}],
                "nodes": [{"node_id": "n1", "title": "图片1", "kind": "image", "prompt": "产品图"}]}
        saved = self._append({
            "role": "assistant", "text": "节点已经放到画布上了", "run_id": "run_k2",
            "took": 12.6,
            "think": {"lines": ["先看画布", "再建节点"], "kinds": ["thought", "roadmap"], "secs": "12.6"},
            "self_check": {"round": 2, "passed": False,
                           "items": [{"text": "数量：要 2 张，实际 1 个", "ok": False}]},
            "plan": plan,
        })
        self.assertEqual(saved.get("took"), 12.6, "思考时长要落盘（刷新后不能变 0.0s）")
        self.assertEqual(saved.get("think", {}).get("lines"), ["先看画布", "再建节点"])
        self.assertEqual(saved.get("self_check", {}).get("passed"), False)
        self.assertEqual(saved.get("plan", {}).get("kind"), "generation")
        row = main._agent_thread_message_row(saved, "content")
        for key in ("think", "took", "self_check", "plan"):
            self.assertIn(key, row, "对外消息形状要带 %s，前端才能还原" % key)
        self.assertEqual(row["plan"]["steps"][0]["tool"], "run_generation")

    def test_approve_marks_plan_executed(self):
        self._append({"role": "assistant", "text": "待执行", "run_id": "run_k2",
                      "plan": {"requires_confirmation": True, "steps": [{"tool": "run_generation",
                                                                         "args": {"node_id": "n1"}}]}})
        changed = main._agent_thread_mark_plan(self.canvas_id, self.thread["id"], "run_k2", "approved")
        self.assertTrue(changed)
        doc = main._agent_thread_doc_load(self.canvas_id)
        msg = main._agent_thread_find(doc, self.thread["id"])["messages"][-1]
        self.assertNotIn("plan", msg, "批准后不能再给一份可执行的方案")
        self.assertEqual(msg.get("plan_status"), "approved")
        self.assertEqual(main._agent_thread_message_row(msg).get("plan_status"), "approved")


class K3ThinkingStreamTests(unittest.TestCase):
    """K3：思考型模型首包放宽（按模型能力区分，也可用环境变量调）。"""

    def test_first_byte_timeout_follows_model_capability(self):
        old = main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS
        think_old = main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_THINK_SECONDS
        main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS = 8.0
        main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_THINK_SECONDS = 60.0
        try:
            self.assertEqual(main._agent_stream_first_timeout({"model": "gemini-3.1-pro-preview"}), 60.0)
            self.assertEqual(main._agent_stream_first_timeout({"model": "gpt-4o"}), 8.0)
            self.assertEqual(main._agent_stream_first_timeout({"model": "gpt-4o", "think_level": "high"}), 60.0,
                             "用户选了思考强度也按思考型放宽")
        finally:
            main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS = old
            main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_THINK_SECONDS = think_old


class K4CharCountTests(unittest.TestCase):
    """K4：用户给字数要求时按实际字符数核对，不采信模型自报的数字。"""

    def _text_node(self, text, node_id="n_agent1", title="文案"):
        return {"id": node_id, "kind": "text", "type": "smart-text", "text": text, "created_at": 1,
                "data": {"gen": {"agent": True, "title": title, "prompt": "",
                                 "hist": [{"text": text}], "hi": 0, "params": {}}}}

    def test_parses_char_limits(self):
        parsed = main._agent_instruction_constraints("写一段 30 字以内的文案")
        self.assertEqual(parsed["chars"], [{"max": 30}])
        self.assertEqual(main._agent_instruction_constraints("不超过 200 字")["chars"], [{"max": 200}])
        self.assertEqual(main._agent_instruction_constraints("至少 50 字")["chars"], [{"min": 50}])
        self.assertEqual(main._agent_instruction_constraints("第 30 个字换行")["chars"], [],
                         "「第 N 个字」是位置，不是字数要求")

    def test_checks_real_character_count_not_model_claim(self):
        body = "字" * 50
        snapshot = {"nodes": [self._text_node(body)], "connections": []}
        check = main._agent_run_self_check("写一段 30 字以内的文案", [], [], snapshot, [],
                                           "已经严格控制在 30 字以内了", [])
        self.assertFalse(check["passed"], "实际 50 字要判未通过，不能信回复里自报的 30 字")
        texts = [item["text"] for item in check["items"] if not item["ok"]]
        self.assertTrue(any("实际 50 字" in text for text in texts), texts)
        self.assertTrue(any("30" in text for text in texts))

    def test_short_enough_passes(self):
        snapshot = {"nodes": [self._text_node("字" * 18)], "connections": []}
        check = main._agent_run_self_check("写一段 30 字以内的文案", [], [], snapshot, [], "写好了", [])
        items = [item for item in check["items"] if "字数" in item["text"]]
        self.assertTrue(items and all(item["ok"] for item in items), items)


class K5NodeEntryTests(unittest.TestCase):
    """K5：线程摘要的「涉及节点」带真实 id；档案关键节点按条目解析，不出碎片。"""

    def test_summary_request_carries_real_node_ids(self):
        request = STORE.summary_request([{"role": "user", "text": "做海报"}], 0,
                                        node_hint="- 海报图（img_123）\n- 文案（txt_9）")
        prompt = request["messages"][1]["content"]
        self.assertIn("海报图（img_123）", prompt)
        self.assertIn("文案（txt_9）", prompt)
        self.assertIn("标题（节点 id）", request["messages"][0]["content"])

    def test_profile_key_nodes_are_title_plus_id(self):
        thread = {"id": "th1", "title": "对话", "updated_at": 2, "summary_upto": 3,
                  "summary": "【目标】做海报\n【涉及节点】海报图（img_123）、视频1（vid_9）\n"
                             "【已定决策】3:4"}
        profile = STORE.merge_profile(STORE.empty_profile("c"), thread)
        self.assertEqual(profile["key_nodes"], ["海报图（img_123）", "视频1（vid_9）"])

    def test_fragments_never_land_in_profile(self):
        thread = {"id": "th1", "title": "对话", "updated_at": 2, "summary_upto": 3,
                  "summary": "【目标】做海报\n【涉及节点】id\n（无节点\n海报图（无节点id）"}
        profile = STORE.merge_profile(STORE.empty_profile("c"), thread)
        self.assertNotIn("id", profile["key_nodes"])
        self.assertNotIn("（无节点", profile["key_nodes"])
        text = STORE.render_profile(profile)
        self.assertNotIn("（无节点", text)
        self.assertNotIn("关键素材节点：id", text)

    def test_thread_node_hint_uses_canvas_titles(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        canvas_id = new_canvas(nodes=[
            {"id": "img_real_1", "kind": "image", "x": 0, "y": 0, "created_at": 1,
             "text": "产品图", "data": {"gen": {"agent": True, "title": "产品图", "prompt": "白底",
                                                "hist": [], "hi": 0, "params": {}}}}])
        thread = {"id": "th1", "title": "对话", "messages": [
            {"role": "assistant", "text": "建好了",
             "steps": [{"tool": "create_node", "ok": True, "args": {"node_id": "img_real_1"}}]}]}
        hint = main._agent_v2_thread_node_hint(canvas_id, thread)
        self.assertIn("产品图（img_real_1）", hint, hint)

    def test_profile_rebuild_keeps_title_and_id(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        with memory_on():
            canvas_id = new_canvas(nodes=[
                {"id": "img_real_2", "kind": "image", "x": 0, "y": 0, "created_at": 1,
                 "text": "海报", "data": {"gen": {"agent": True, "title": "海报", "prompt": "稿",
                                                  "hist": [], "hi": 0, "params": {}}}}])
            thread = main._agent_thread_new_thread("对话 1")
            thread["summary"] = "【目标】做海报\n【涉及节点】img_real_2"
            thread["summary_upto"] = 1
            thread["messages"] = [{"role": "assistant", "text": "做海报", "at": 1}]
            save_thread(canvas_id, thread)
            main._agent_v2_memory_refresh_profile(canvas_id)
            profile = STORE.load_profile(main.AGENT_MEMORY_DIR, canvas_id)
            self.assertEqual(profile["key_nodes"], ["海报（img_real_2）"], profile["key_nodes"])


class K2ProducerPersistTests(unittest.TestCase):
    """K2：真正跑一轮 producer，待生成方案 / 思考 / 时长要落到线程里（不是只活在前端内存）。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self.canvas_id = new_canvas(nodes=[])
        self.thread = main._agent_thread_new_thread("对话 1")
        save_thread(self.canvas_id, self.thread)

    def _run(self, decisions):
        seq = list(decisions)

        async def fake_decide(chat, messages, canvas_id="", tools_json_text="", tools=None,
                              rebuild_json=None):
            return seq.pop(0) if seq else {"done": True, "message": "完成"}

        req = {"canvas_id": self.canvas_id, "run_id": "run_" + uuid.uuid4().hex[:10],
               "instruction": "出一张白底产品图", "focus": main._agent_run_normalize_focus(None),
               "history": [], "thread_id": self.thread["id"],
               "chat": {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
                        "model": "stub-model", "provider_cfg": {"protocol": "custom"},
                        "think_level": ""},
               "max_steps": 0, "mode": "run", "approved_steps": [], "renderer": "beat",
               "use_thread": True, "enforce_write_confirmation": True}

        async def go():
            queue = asyncio.Queue()
            await main._agent_run_producer(req, queue)
            while not queue.empty():
                queue.get_nowait()

        with patch.dict(os.environ, {"NOVAI_AGENT_V2_CONTEXT": "1"}), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide):
            asyncio.run(go())
        doc = main._agent_thread_doc_load(self.canvas_id)
        return main._agent_thread_find(doc, self.thread["id"])["messages"]

    def test_pending_generation_plan_and_thoughts_are_persisted(self):
        messages = self._run([{
            "thought": "先建一个图片节点，再让用户选模型",
            "steps": [{"tool": "generate_image", "description": "建好待生成的产品图节点",
                       "args": {"canvas_id": self.canvas_id, "prompt": "白底产品图",
                                "ratio": "1:1"}}],
        }])
        assistant = [msg for msg in messages if msg.get("role") == "assistant"]
        self.assertTrue(assistant, "这一轮要写一条助手消息")
        saved = assistant[-1]
        self.assertGreaterEqual(saved.get("took") or 0, 0.0)
        self.assertIn("took", saved, "思考时长要随线程落盘")
        think = saved.get("think") or {}
        self.assertIn("先建一个图片节点", "\n".join(think.get("lines") or []))
        plan = saved.get("plan") or {}
        self.assertEqual(plan.get("kind"), "generation", "待生成卡片要能还原")
        self.assertTrue(plan.get("requires_confirmation"))
        self.assertEqual(plan["steps"][0]["tool"], "run_generation")
        self.assertEqual(plan["steps"][0]["args"]["node_id"], plan["nodes"][0]["node_id"])
        row = main._agent_thread_message_row(saved, "content")
        self.assertTrue(row.get("run_id"), "taskId（run_id）要带回去，刷新后「执行生成」才有目标")
        self.assertTrue(row.get("plan"))


class K3StreamLogAndDeltaTests(unittest.TestCase):
    """K3：流式成功要能出 stage=stream 日志，并且真的逐字发增量事件（面板逐字出字）。"""

    def test_successful_stream_logs_stage_and_emits_deltas(self):
        class Resp(object):
            status_code = 200
            headers = {"content-type": "text/event-stream"}

            async def aiter_lines(self):
                yield 'data: {"choices": [{"delta": {"content": "你"}}]}'
                yield 'data: {"choices": [{"delta": {"content": "好"}}]}'
                yield "data: [DONE]"

        class FakeStream(object):
            async def __aenter__(self):
                return Resp(), {}

            async def __aexit__(self, *args):
                return False

        events = []
        chat_cfg = {"provider": "p", "base": "https://x.invalid/v1", "headers": {},
                    "model": "gemini-3.1-pro-preview", "provider_cfg": {"protocol": "openai"},
                    "think_level": "high"}
        out = io.StringIO()
        token = main._AGENT_RUN_EMIT.set(lambda event, data: events.append((event, data)))
        try:
            with patch.object(main, "chat_stream_with_think", new=lambda *a, **k: FakeStream()), \
                    contextlib.redirect_stdout(out):
                raw = asyncio.run(main._agent_run_stream_chat(
                    chat_cfg, [{"role": "user", "content": "hi"}]))
        finally:
            main._AGENT_RUN_EMIT.reset(token)
        log = out.getvalue()
        self.assertIn("stage=stream", log, "服务日志要能直接看到流式真的用上了")
        self.assertIn("first_byte_ms=", log)
        deltas = "".join(str(data.get("text") or "") for event, data in events
                         if event == "message_delta")
        self.assertIn("你", deltas)
        self.assertIn("好", deltas, "正文要分片逐字下发，不是最后一次性给")
        self.assertIn("你好", str((raw.get("choices") or [{}])[0].get("message", {}).get("content")))


if __name__ == "__main__":
    unittest.main()
