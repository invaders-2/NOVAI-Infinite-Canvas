# -*- coding: utf-8 -*-
"""修复清单 A5 / B1 / B2 / B3 / B4 的 main.py 接线回归（不动 server/agent_core 纯模块）。

A5 历史：开关打开时把线程全部消息交给引擎（不被 20 条 / 16000 字截断），传 thread_summary 与 summary_upto；
         build.history_dropped > 0 时运行结束触发线程摘要更新。
B1 接线：线程摘要写回用 memory_store 新的「实际覆盖到第几条」，不用 len(messages)。
B2 档案：按当前存在的线程重建「各对话做过什么」；删对话 / 清空对话后刷新档案并更新索引条目。
B3 recall 权限：运行开始把发起人可见画布集合放进运行上下文；recall 传 allowed_canvases，
                模型自己给的 canvas_id 也要过同一套校验，没权限回落本次运行画布。
B4 摘要调用：调模型前清空 think_level。
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-fix-main-memory-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

STORE = main._agent_memory_store
CLIENT = TestClient(main.app)
SUMMARY_TEXT = "【目标】做一套冷蓝色调海报\n【已定决策】3:4 竖版，冷蓝色调\n【已完成】第 3 条里定下的东西：MSG03"


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


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def new_canvas_id(prefix):
    canvas_id = "c-%s-%s" % (prefix, uuid.uuid4().hex[:10])
    main.save_canvas({"id": canvas_id, "title": "修复验收-" + prefix, "kind": "beat",
                      "updated_at": int(main.time.time() * 1000),
                      "nodes": [{"id": "n1", "kind": "text", "x": 0, "y": 0,
                                 "text": "冷蓝色调海报", "data": {}}],
                      "connections": []})
    return canvas_id


def save_threads(canvas_id, threads):
    doc = main._agent_thread_doc_load(canvas_id)
    doc["threads"] = list(threads)
    doc["active_id"] = threads[0]["id"] if threads else ""
    main._agent_thread_doc_save(canvas_id, doc)


def make_thread(title, count=2, summary="", summary_upto=0, text_prefix="MSG"):
    thread = main._agent_thread_new_thread(title)
    thread["messages"] = [
        {"role": "user" if index % 2 else "assistant",
         "text": "第%02d条：%s%02d 的内容" % (index, text_prefix, index),
         "at": 1700000000 + index} for index in range(1, count + 1)]
    if summary:
        thread["summary"] = summary
        thread["summary_upto"] = summary_upto
    return thread


def reload_thread(canvas_id, thread_id):
    return main._agent_thread_find(main._agent_thread_doc_load(canvas_id), thread_id)


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


def run_producer(req):
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


def flat_text(messages):
    parts = []
    for message in messages or []:
        content = message.get("content")
        if isinstance(content, list):
            parts.extend(str(item.get("text") or "") for item in content if isinstance(item, dict))
        else:
            parts.append(str(content or ""))
    return "\n".join(parts)


def producer_req(canvas_id, thread_id="", allowed=None):
    return {"canvas_id": canvas_id, "run_id": "run_" + uuid.uuid4().hex[:12],
            "instruction": "接着把海报做完", "focus": main._agent_run_normalize_focus(None),
            "history": [], "thread_id": thread_id,
            "chat": {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
                     "model": "stub-model", "provider_cfg": {"protocol": "custom"},
                     "think_level": "high"},
            "max_steps": 0, "mode": "run", "approved_steps": [], "renderer": "beat",
            "use_thread": True, "allowed_canvases": allowed,
            "enforce_write_confirmation": True}


class ThreadHistoryWiringTests(unittest.TestCase):
    """A5：摘要覆盖前 40 条的线程 → 模型收到「摘要 + 之后原文」，全程没被 20 条截断。"""

    @classmethod
    def setUpClass(cls):
        cls.canvas_id = new_canvas_id("history")

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")

    def test_summary_plus_messages_after_upto(self):
        thread = make_thread("长对话", count=60, summary=SUMMARY_TEXT, summary_upto=40)
        save_threads(self.canvas_id, [thread])
        rounds = []

        async def fake_decide(chat, messages, canvas_id, tools_json_text="", tools=None,
                              rebuild_json=None):
            rounds.append(messages)
            return {"done": True, "message": "看完了"}

        req = producer_req(self.canvas_id, thread_id=thread["id"])
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_CONTEXT": "1"}), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide):
            run_producer(req)
        self.assertTrue(rounds, "模型没有被调用")
        flat = flat_text(rounds[0])
        self.assertIn("这条对话较早的内容摘要", flat)
        self.assertIn("第 3 条里定下的东西：MSG03", flat,
                      "摘要覆盖的内容要能被模型看到（第 3 条里定下的东西在摘要里）")
        self.assertIn("MSG41", flat, "摘要之后的原文要带进上下文")
        self.assertIn("MSG60", flat, "最后一条必须在")
        self.assertNotIn("MSG01", flat, "已经被摘要覆盖的原文不该再重复进上下文")
        self.assertNotIn("MSG39", flat, "已经被摘要覆盖的原文不该再重复进上下文")

    def test_full_thread_messages_bypass_20_item_truncation(self):
        thread = make_thread("长对话", count=60, summary=SUMMARY_TEXT, summary_upto=40)
        self.assertEqual(len(main._agent_thread_history(thread)), 20,
                         "没开上下文引擎时保持原来的 20 条截断")
        self.assertEqual(len(main._agent_thread_history_all(thread)), 60,
                         "开了上下文引擎要拿到线程全部消息")

    def test_history_dropped_triggers_forced_summary(self):
        captured = {}

        class FakeBuild(object):
            messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
            used = 1
            actions = []
            needs_summary = 0
            history_dropped = 7

        async def fake_round_context(**kwargs):
            return "s", FakeBuild()

        async def fake_decide(chat, messages, canvas_id, tools_json_text="", tools=None,
                              rebuild_json=None):
            return {"done": True, "message": "完成"}

        def fake_schedule(canvas_id, thread_id, chat, force_summary=False):
            captured["force_summary"] = force_summary

        req = producer_req(self.canvas_id)
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_CONTEXT": "1", "NOVAI_AGENT_V2_MEMORY": "1"}), \
                patch.object(main, "_agent_v2_round_context", new=fake_round_context), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide), \
                patch.object(main, "_agent_v2_memory_schedule", new=fake_schedule):
            run_producer(req)
        self.assertTrue(captured.get("force_summary"),
                        "history_dropped > 0 时运行结束必须强制更新一次线程摘要")


class ThreadSummaryUpdateTests(unittest.TestCase):
    """B1 / B4：摘要写回用实际覆盖下标，调用前清空思考强度。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self._memory = memory_on()
        self._memory.__enter__()
        self.canvas_id = new_canvas_id("summary")

    def tearDown(self):
        self._memory.__exit__(None, None, None)

    def _run(self, thread, chat=None):
        save_threads(self.canvas_id, [thread])
        captured = {}

        async def fake_chat(chat_arg, messages):
            captured["chat"] = dict(chat_arg)
            captured["messages"] = messages
            return SUMMARY_TEXT

        with patch.object(main, "_agent_run_chat", new=fake_chat):
            asyncio.run(main._agent_v2_memory_update(
                self.canvas_id, thread["id"], chat or {"provider": "p", "model": "m",
                                                       "think_level": "high"}))
        return captured

    def test_summary_upto_is_actual_coverage_not_message_count(self):
        thread = main._agent_thread_new_thread("超长对话")
        thread["messages"] = [{"role": "user" if i % 2 else "assistant",
                               "text": "第%d条：" % i + ("字" * 1500), "at": 1700000000 + i}
                              for i in range(1, 38)]
        captured = self._run(thread)
        expected = STORE.summary_request(thread["messages"], 0, previous="")["upto"]
        saved = reload_thread(self.canvas_id, thread["id"])
        self.assertGreater(expected, 0)
        self.assertLess(expected, 37, "37 条 × 1500 字一次装不下，不能全标成已覆盖")
        self.assertEqual(saved.get("summary_upto"), expected,
                         "写回的下标必须是 memory_store 实际覆盖到的下标")
        self.assertNotEqual(saved.get("summary_upto"), len(thread["messages"]))
        self.assertTrue(saved.get("summary"))
        self.assertEqual(len(captured["messages"]), 2)

    def test_summary_call_clears_think_level_only_for_this_call(self):
        thread = make_thread("普通对话", count=8, summary="", summary_upto=0)
        chat = {"provider": "p", "model": "m", "think_level": "high"}
        captured = self._run(thread, chat=chat)
        self.assertEqual(captured["chat"].get("think_level"), "",
                         "摘要整理不该带思考强度")
        self.assertEqual(chat.get("think_level"), "high", "调用方的 chat 配置不能被改掉")

    def test_force_summary_updates_even_below_threshold(self):
        thread = make_thread("只多一条", count=3, summary="【目标】旧摘要", summary_upto=2)
        save_threads(self.canvas_id, [thread])
        # 模拟运行结束时 history_dropped > 0：摘要更新的「强制」开关走运行上下文
        token = main._AGENT_V2_FORCE_SUMMARY.set(True)
        try:
            with patch.object(main, "_agent_run_chat", new=AsyncMock(return_value=SUMMARY_TEXT)):
                asyncio.run(main._agent_v2_memory_update(self.canvas_id, thread["id"],
                                                         {"provider": "p", "model": "m"}))
        finally:
            main._AGENT_V2_FORCE_SUMMARY.reset(token)
        saved = reload_thread(self.canvas_id, thread["id"])
        self.assertEqual(saved.get("summary_upto"), 3,
                         "强制摘要要跳过条数门槛，把新的一条也覆盖掉")


    def test_schedule_passes_force_through_run_context(self):
        """运行结束的「强制摘要」经运行上下文传给后台任务，后台任务签名保持原样。"""
        thread = make_thread("普通对话", count=2)
        save_threads(self.canvas_id, [thread])
        seen = {}

        async def fake_update(canvas_id, thread_id, chat):
            seen["force"] = main._AGENT_V2_FORCE_SUMMARY.get()

        async def go():
            with patch.object(main, "_agent_v2_memory_update", new=fake_update):
                main._agent_v2_memory_schedule(self.canvas_id, thread["id"],
                                               {"provider": "p", "model": "m"},
                                               force_summary=True)
                await asyncio.sleep(0.05)

        asyncio.run(go())
        self.assertTrue(seen.get("force"), "后台摘要任务要能看到强制开关")


class ProfileRebuildTests(unittest.TestCase):
    """B2：删掉的对话不能继续留在画布档案（正文 + 索引）里。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self._memory = memory_on()
        self._memory.__enter__()
        self.canvas_id = new_canvas_id("profile")
        self._index_path = os.path.join(main.AGENT_MEMORY_DIR, STORE.INDEX_FILENAME)
        if os.path.exists(self._index_path):
            os.remove(self._index_path)

    def tearDown(self):
        if os.path.exists(self._index_path):
            os.remove(self._index_path)
        self._memory.__exit__(None, None, None)

    def _seed(self):
        keep = make_thread("保留的对话", count=2,
                           summary="【目标】ZZKEPTZZ 保留的方案\n【已定决策】ZZKEPTSTYLE 冷蓝色调")
        doomed = make_thread("要删的对话", count=2,
                             summary="【目标】ZZDELETEDZZ 要删的方案\n【已定决策】ZZDELETEDSTYLE 暖橙色")
        keep["updated_at"], doomed["updated_at"] = 1700000100, 1700000200
        save_threads(self.canvas_id, [keep, doomed])
        main._agent_v2_memory_refresh_profile(self.canvas_id)
        return keep, doomed

    def _profile_text(self):
        resp = CLIENT.get("/api/agent/profile/%s" % self.canvas_id)
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()["text"]

    def test_delete_thread_rebuilds_profile_and_index(self):
        keep, doomed = self._seed()
        text = self._profile_text()
        self.assertIn("保留的对话", text)
        self.assertIn("要删的对话", text)
        self.assertIn("ZZDELETEDZZ", text)
        self.assertIn("ZZDELETEDSTYLE", text)

        resp = CLIENT.delete("/api/agent/threads/%s" % doomed["id"],
                             params={"canvas_id": self.canvas_id})
        self.assertEqual(resp.status_code, 200, resp.text)

        text = self._profile_text()
        self.assertNotIn("要删的对话", text, "删掉的对话标题不能再出现在档案正文里")
        self.assertNotIn("ZZDELETEDZZ", text, "删掉的对话内容不能再出现在档案正文里")
        self.assertNotIn("ZZDELETEDSTYLE", text, "删掉的对话定过的风格也不能留在档案正文里")
        self.assertIn("保留的对话", text)
        self.assertIn("ZZKEPTZZ", text)
        found = main._agent_v2_recall_search("ZZDELETEDZZ", scope="canvas",
                                             canvas_id=self.canvas_id)
        self.assertEqual(found["count"], 0, "删掉的对话也不能再被 recall 搜到")

    def test_clear_threads_rebuilds_empty_profile(self):
        self._seed()
        resp = CLIENT.delete("/api/agent/thread/%s" % self.canvas_id)
        self.assertEqual(resp.status_code, 200, resp.text)
        text = self._profile_text()
        self.assertNotIn("保留的对话", text)
        self.assertNotIn("ZZKEPTZZ", text)
        self.assertNotIn("ZZDELETEDZZ", text)
        self.assertEqual(text, "", "对话都删了，档案正文也不该再留着删掉的内容")
        payload = main._agent_v2_recall_search("ZZKEPTZZ", scope="canvas",
                                               canvas_id=self.canvas_id)
        self.assertEqual(payload["count"], 0)


class RecallPermissionTests(unittest.TestCase):
    """B3：运行上下文里的可见画布集合同时约束 recall 的 scope=all 与模型给的 canvas_id。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self._memory = memory_on()
        self._memory.__enter__()
        self.canvas_id = new_canvas_id("acl-mine")
        self.other_id = new_canvas_id("acl-other")
        self._index_path = os.path.join(main.AGENT_MEMORY_DIR, STORE.INDEX_FILENAME)
        if os.path.exists(self._index_path):
            os.remove(self._index_path)
        STORE.MemoryIndex(main.AGENT_MEMORY_DIR).add([
            STORE.make_entry("message", "用户：乙的私人秘方 冷蓝配方", canvas_id=self.other_id,
                             canvas_title="乙的画布", thread_id="tb", thread_title="乙的对话",
                             ts=1700000300),
        ])

    def tearDown(self):
        main._AGENT_RUN_ALLOWED_CANVASES.set(None)
        main._AGENT_RUN_CANVAS_ID.set("")
        if os.path.exists(self._index_path):
            os.remove(self._index_path)
        self._memory.__exit__(None, None, None)

    def _run_recall(self, allowed):
        main._AGENT_RUN_CANVAS_ID.set(self.canvas_id)
        main._AGENT_RUN_ALLOWED_CANVASES.set(allowed)
        return main._agent_v2_recall_run({"query": "私人秘方", "scope": "all",
                                          "canvas_id": self.canvas_id, "thread_id": "",
                                          "limit": 5})

    def test_all_scope_cannot_see_canvas_outside_allowed_set(self):
        payload = self._run_recall([self.canvas_id])
        self.assertEqual(payload["count"], 0, "用户甲的运行里不能搜到用户乙私有画布的内容")
        # D2：没传可见画布集合（None）时也只查本次运行画布，不再当成"不限制"
        payload = self._run_recall(None)
        self.assertEqual(payload["count"], 0, "没传限制时同样不能翻到其它画布")
        payload = self._run_recall([self.canvas_id, self.other_id])
        self.assertEqual(payload["count"], 1, "把那张画布显式放进可见集合时能命中（证明隔离来自权限集合）")

    def test_validate_falls_back_when_model_asks_for_other_canvas(self):
        main._AGENT_RUN_CANVAS_ID.set(self.canvas_id)
        main._AGENT_RUN_ALLOWED_CANVASES.set([self.canvas_id])
        self.assertEqual(main._agent_v2_recall_validate(
            {"query": "海报", "scope": "canvas", "canvas_id": self.other_id})["canvas_id"],
            self.canvas_id, "没权限的画布要回落本次运行画布")
        main._AGENT_RUN_ALLOWED_CANVASES.set([self.canvas_id, self.other_id])
        self.assertEqual(main._agent_v2_recall_validate(
            {"query": "海报", "scope": "canvas", "canvas_id": self.other_id})["canvas_id"],
            self.other_id, "有权限的画布照常尊重模型的选择")

    def test_producer_puts_allowed_canvases_into_run_context(self):
        seen = {}

        async def fake_decide(chat, messages, canvas_id, tools_json_text="", tools=None,
                              rebuild_json=None):
            seen["allowed"] = main._AGENT_RUN_ALLOWED_CANVASES.get()
            return {"done": True, "message": "完成"}

        req = producer_req(self.canvas_id, allowed=[self.canvas_id])
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_MEMORY": "1",
                                     "NOVAI_AGENT_V2_CONTEXT": "1"}), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide), \
                patch.object(main, "_agent_v2_memory_schedule", new=lambda *a, **k: None):
            run_producer(req)
        self.assertEqual(seen.get("allowed"), [self.canvas_id],
                         "运行开始时要把发起人可见画布集合放进运行上下文")


if __name__ == "__main__":
    unittest.main()
