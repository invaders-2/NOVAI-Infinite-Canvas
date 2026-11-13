# -*- coding: utf-8 -*-
"""L1~L5 回归（返工批）：记忆 HTTP 入口统一、流式超时按运行、失败记录只进明细、档案只收真实节点、首条消息不被冲掉。

跑法：NOVAI_DATA_DIR=/tmp/novai-l-batch python3 -m pytest tests/test_agent_l_batch.py -q
写盘用例只在临时数据目录下跑（保护真实数据）；L1 从 HTTP 入口打进去，不直接调内部函数。
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-l-batch-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

STORE = main._agent_memory_store
CLIENT = TestClient(main.app)


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


def new_beat_canvas(nodes=None, title="L 验收画布"):
    canvas_id = "l-" + uuid.uuid4().hex[:10]
    main.save_canvas({"id": canvas_id, "title": title, "kind": "beat",
                      "updated_at": int(main.time.time() * 1000),
                      "nodes": nodes if nodes is not None else [], "connections": []})
    return canvas_id


def new_thread(canvas_id):
    doc = main._agent_thread_doc_load(canvas_id)
    thread = main._agent_thread_new_thread("对话 1")
    doc["threads"] = [thread]
    doc["active_id"] = thread["id"]
    main._agent_thread_doc_save(canvas_id, doc)
    return thread["id"]


def thread_messages(canvas_id, thread_id):
    doc = main._agent_thread_doc_load(canvas_id)
    return main._agent_thread_find(doc, thread_id)["messages"]


class L1MemoryHttpEntryTests(unittest.TestCase):
    """L1：面板里「记住：…」的 HTTP 入口（POST /api/memories）走同一套记忆逻辑。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self._memory = memory_on()
        self._memory.__enter__()
        self.canvas_id = new_beat_canvas()
        self.thread_id = new_thread(self.canvas_id)
        self.body = {"content": "主色是墨绿色", "scope": "global",
                     "canvas_id": self.canvas_id, "thread_id": self.thread_id,
                     "conversation_id": self.canvas_id,
                     "user_text": "记住：主色是墨绿色"}

    def tearDown(self):
        # 同一个临时数据目录里还有别的测试：把这次写的长期记忆删干净（全局记忆会影响它们）
        try:
            for item in (CLIENT.get("/api/memories").json().get("memories") or []):
                if str(item.get("content") or "") in ("主色是墨绿色", "这张画布主色是墨绿色"):
                    CLIENT.delete("/api/memories/" + str(item.get("id")), params={"canvas_id": self.canvas_id})
        finally:
            self._memory.__exit__(None, None, None)

    def test_panel_remember_twice_stores_one_and_reaches_index_profile_thread(self):
        first = CLIENT.post("/api/memories", json=self.body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertFalse(first.json().get("deduplicated"))
        second = CLIENT.post("/api/memories", json=self.body)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertTrue(second.json().get("deduplicated"), "同一句第二次要判重复")
        self.assertTrue(second.json().get("reply"), "服务端要给出与线程一致的回复文案")

        # memory_library 只有 1 条
        library = CLIENT.get("/api/memories").json().get("memories") or []
        self.assertEqual(len([m for m in library if m.get("content") == "主色是墨绿色"]), 1, library)

        # 记忆索引里有它
        entries = STORE.MemoryIndex(main.AGENT_MEMORY_DIR).entries()
        hits = [row for row in entries if "墨绿色" in str(row.get("text") or "") and row.get("canvas_id") == self.canvas_id]
        self.assertTrue(hits, "索引里要能搜到这条画布记忆")
        self.assertTrue(any("墨绿色" in str(row.get("text") or "") for row in entries),
                        "长期记忆索引里也要能搜到")

        # 项目档案 prefs 里有它
        profile = CLIENT.get("/api/agent/profile/" + self.canvas_id).json()
        self.assertIn("主色是墨绿色", profile["profile"].get("prefs") or [])
        self.assertIn("墨绿色", profile.get("text") or "")

        # 这一轮对话进线程（用户原话 + 服务端回复）
        messages = CLIENT.get("/api/agent/threads/%s/messages" % self.thread_id,
                              params={"canvas_id": self.canvas_id}).json()["messages"]
        texts = [str(m.get("content") or "") for m in messages]
        self.assertIn("记住：主色是墨绿色", texts)
        self.assertTrue(any("记住了" in text for text in texts), texts)

        # 新对话开场注入：问「主色是什么」时模型能拿到墨绿色
        class Ctx(object):
            canvas_id = self.canvas_id
            kind = "canvas"

        opening = main._agent_v2_memory_opening(Ctx(), {"messages": []}, "主色是什么", 128000)
        self.assertIn("墨绿色", opening)

    def test_conversation_scope_also_lands_in_profile(self):
        body = dict(self.body, scope="conversation", content="这张画布主色是墨绿色")
        self.assertEqual(CLIENT.post("/api/memories", json=body).status_code, 200)
        profile = CLIENT.get("/api/agent/profile/" + self.canvas_id).json()
        self.assertIn("这张画布主色是墨绿色", profile["profile"].get("prefs") or [])

    def test_delete_removes_it_from_profile(self):
        made = CLIENT.post("/api/memories", json=self.body).json()
        memory_id = made["memory"]["id"]
        self.assertEqual(CLIENT.delete("/api/memories/" + memory_id,
                                       params={"canvas_id": self.canvas_id}).status_code, 200)
        profile = CLIENT.get("/api/agent/profile/" + self.canvas_id).json()
        self.assertNotIn("主色是墨绿色", profile["profile"].get("prefs") or [])


class L2RunScopedStreamTests(unittest.TestCase):
    """L2：一次运行里流式空等只出现第 1 轮；下一次运行再试流式；心跳按运行总耗时走。"""

    def setUp(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        main._AGENT_STREAM_OFF_RUNS.clear()
        self._saved = (main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS,
                       main._AGENT_STREAM_IDLE_TIMEOUT_SECONDS,
                       main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS,
                       main._AGENT_HEARTBEAT_SECONDS)
        main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS = 0.05
        main._AGENT_STREAM_IDLE_TIMEOUT_SECONDS = 0.05
        main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS = 1.0

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        main._AGENT_STREAM_OFF_RUNS.clear()
        (main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS,
         main._AGENT_STREAM_IDLE_TIMEOUT_SECONDS,
         main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS,
         main._AGENT_HEARTBEAT_SECONDS) = self._saved

    def test_three_idle_rounds_only_first_logs_stream_idle(self):
        class IdleHang:
            status_code = 200
            headers = {"content-type": "text/event-stream"}

            async def aiter_lines(self):
                yield 'data: {"choices": [{"delta": {"content": "x"}}]}'
                await asyncio.sleep(10)
                if False:
                    yield ""

        class CM:
            async def __aenter__(self):
                return IdleHang(), {}

            async def __aexit__(self, *args):
                return False

        chat_cfg = {"provider": "p", "base": "https://x.invalid/v1", "headers": {},
                    "model": "gpt-4o", "provider_cfg": {"protocol": "openai"}}
        raw = {"choices": [{"message": {"content": "ok"}}]}
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
                patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                patch.object(main, "chat_stream_with_think", new=lambda *a, **k: CM()), \
                patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw)):
            async def go():
                main._AGENT_STREAM_OFF_RUNS.clear()      # 一次运行的开始
                for _ in range(3):
                    await main._agent_raw_with_stream(chat_cfg, [{"role": "user", "content": "hi"}], None)
            asyncio.run(go())
        log = out.getvalue()
        self.assertEqual(log.count("kind=stream_idle"), 1, log)

    def test_timeout_survives_heartbeat_child_task(self):
        """决策跑在心跳包出来的子任务里：子任务里标了「流式已超时」，父任务后面的轮次要能看到。"""
        class Hang:
            status_code = 200
            headers = {"content-type": "text/event-stream"}

            async def aiter_lines(self):
                await asyncio.sleep(10)
                if False:
                    yield ""

        attempts = []

        class CM:
            def __init__(self):
                attempts.append(1)

            async def __aenter__(self):
                return Hang(), {}

            async def __aexit__(self, *args):
                return False

        chat_cfg = {"provider": "p", "base": "https://x.invalid/v1", "headers": {},
                    "model": "gpt-4o", "provider_cfg": {"protocol": "openai"}}
        raw = {"choices": [{"message": {"content": "ok"}}]}

        async def decide_once():
            with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                    patch.object(main, "chat_stream_with_think", new=lambda *a, **k: CM()), \
                    patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw)):
                await main._agent_raw_with_stream(chat_cfg, [{"role": "user", "content": "hi"}], None)

        async def go():
            token = main._AGENT_RUN_ID.set("run_l2_child")
            try:
                main._agent_stream_run_reset()
                for round_no in range(1, 4):
                    await main._agent_run_with_heartbeat(decide_once(), lambda *a: None,
                                                         "run_l2_child", round_no, "non_stream")
                return main._agent_stream_run_disabled()
            finally:
                main._AGENT_RUN_ID.reset(token)

        disabled = asyncio.run(go())
        self.assertTrue(disabled, "子任务里标的超时必须能影响本运行后面的轮次")
        self.assertEqual(len(attempts), 1, "同一次运行后面两轮不该再试流式")

    def test_heartbeat_elapsed_is_total_run_time_not_per_round(self):
        """「已 N 秒」按运行总耗时走：两次不同轮次的心跳必须越来越大，且与真实耗时差 < 2 秒。"""
        main._AGENT_HEARTBEAT_SECONDS = 0.05
        events = []

        async def slow():
            await asyncio.sleep(0.3)
            return {"done": True, "message": "ok"}

        async def go():
            started = time.monotonic() - 10.0        # 模拟运行已经跑了 10 秒
            token = main._AGENT_RUN_STARTED_AT.set(started)
            try:
                await main._agent_run_with_heartbeat(slow(), lambda event, data: events.append((event, data)),
                                                     "run_l2", 1, "non_stream")
                await main._agent_run_with_heartbeat(slow(), lambda event, data: events.append((event, data)),
                                                     "run_l2", 2, "non_stream")
            finally:
                main._AGENT_RUN_STARTED_AT.reset(token)

        asyncio.run(go())
        beats = [int(data.get("elapsed_ms") or 0) for event, data in events if event == "heartbeat"]
        self.assertGreaterEqual(len(beats), 4, beats)
        self.assertEqual(beats, sorted(beats), "心跳耗时只能往前走，不能每轮归零")
        self.assertGreater(beats[0], 9000, "第一次心跳就该是运行总耗时（约 10 秒）")
        self.assertLess(abs(beats[0] - 10000), 2000, "心跳计时与实际耗时相差不超过 2 秒")


class L3FailureDetailOnlyTests(unittest.TestCase):
    """L3：模型失败记录只进运行明细，不进回复正文和线程摘要。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self.canvas_id = new_beat_canvas(nodes=[])
        self.thread_id = new_thread(self.canvas_id)

    def _run_with_first_round_failure(self):
        state = {"round": 0}

        async def fake_decide(chat, messages, canvas_id="", tools_json_text="", tools=None,
                              rebuild_json=None):
            state["round"] += 1
            if state["round"] == 1:
                raise main.AgentRunError("模型 90 秒未响应（非流式总时长超时）", code="provider_timeout")
            return {"thought": "重新来", "done": True, "message": "海报做好了"}

        req = {"canvas_id": self.canvas_id, "run_id": "run_" + uuid.uuid4().hex[:10],
               "instruction": "做一张海报", "focus": main._agent_run_normalize_focus(None),
               "history": [], "thread_id": self.thread_id,
               "chat": {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
                        "model": "stub-model", "provider_cfg": {"protocol": "custom"}, "think_level": ""},
               "max_steps": 0, "mode": "run", "approved_steps": [], "renderer": "beat",
               "use_thread": True, "enforce_write_confirmation": True}
        events = []

        async def go():
            queue = asyncio.Queue()
            await main._agent_run_producer(req, queue)
            while not queue.empty():
                item = queue.get_nowait()
                if item is None:
                    break
                for line in str(item).split("\n"):
                    if line.startswith("data: "):
                        try:
                            payload = json.loads(line[len("data: "):])
                        except Exception:
                            continue
                        events.append(payload)

        with patch.dict(os.environ, {"NOVAI_AGENT_V2_CONTEXT": "1"}), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide):
            asyncio.run(go())
        return events

    def test_reply_and_summary_have_no_failure_record(self):
        events = self._run_with_first_round_failure()
        done = next((item for item in reversed(events) if item.get("event") == "done"
                     or ("status" in item and "message" in item and "changes" in item)), {})
        self.assertNotIn("失败记录", str(done.get("message") or ""), done)
        self.assertTrue(done.get("failures"), "失败明细要在运行明细里")
        self.assertTrue(any("模型调用失败" in str(item) or "未响应" in str(item) for item in done["failures"]),
                        done.get("failures"))

        messages = thread_messages(self.canvas_id, self.thread_id)
        reply = "\n".join(str(m.get("text") or "") for m in messages)
        self.assertNotIn("失败记录", reply, "线程里给用户看的回复不能带内部失败话术")

        # 线程摘要的提示词同样不能带「失败记录」（摘要由线程消息拼出来）
        request = STORE.summary_request([{"role": m.get("role"), "text": m.get("text")} for m in messages], 0)
        self.assertNotIn("失败记录", request["messages"][1]["content"])


class L4ProfileNodesAndProgressTests(unittest.TestCase):
    """L4：关键节点只收真实画布节点（带 id），阶段名不算；有待生成节点时进度不能写「都已完成」。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self._memory = memory_on()
        self._memory.__enter__()
        self.text_node = {"id": "txt_real_1", "kind": "text", "x": 0, "y": 0, "created_at": 1,
                          "text": "海报文案：一杯好咖啡", "data": {"gen": {"agent": True, "title": "文案",
                                                                        "prompt": "", "hist": [{"text": "海报文案：一杯好咖啡"}], "hi": 0, "params": {}}}}
        self.image_node = {"id": "img_real_2", "kind": "image", "x": 300, "y": 0, "created_at": 2,
                           "text": "海报", "data": {"gen": {"agent": True, "title": "海报", "prompt": "白底咖啡海报",
                                                           "hist": [], "hi": 0, "params": {"ratio": "3:4"}},
                                                    "agentPending": True}}
        self.canvas_id = new_beat_canvas(nodes=[self.text_node, self.image_node])
        self.thread_id = new_thread(self.canvas_id)
        doc = main._agent_thread_doc_load(self.canvas_id)
        thread = main._agent_thread_find(doc, self.thread_id)
        thread["summary"] = ("【目标】做一张咖啡海报\n【已定决策】3:4 竖版\n【已完成】文案写好了\n"
                             "【涉及节点】海报设计、文案（txt_real_1）、海报（img_real_2）、id\n"
                             "【未决事项】等生成")
        thread["summary_upto"] = 1
        thread["roadmap"] = [{"stage": "海报", "generations": 1}]
        thread["messages"] = [{"role": "assistant", "text": "海报节点建好了", "at": 1,
                               "steps": [{"tool": "generate_image", "ok": True, "args": {}}]}]
        main._agent_thread_doc_save(self.canvas_id, doc)

    def tearDown(self):
        self._memory.__exit__(None, None, None)

    def test_key_nodes_only_real_canvas_nodes_with_ids(self):
        main._agent_v2_memory_refresh_profile(self.canvas_id)
        profile = STORE.load_profile(main.AGENT_MEMORY_DIR, self.canvas_id)
        nodes = profile["key_nodes"]
        self.assertEqual(len(nodes), 2, nodes)
        self.assertIn("文案（txt_real_1）", nodes)
        self.assertIn("海报（img_real_2）", nodes)
        self.assertNotIn("海报设计", json.dumps(nodes, ensure_ascii=False), "方案阶段名不能当节点")
        self.assertNotIn("id", [item.lower() for item in nodes], "碎片不能进档案")

    def test_progress_says_pending_not_all_done(self):
        main._agent_v2_memory_refresh_profile(self.canvas_id)
        profile = STORE.load_profile(main.AGENT_MEMORY_DIR, self.canvas_id)
        progress = str(profile.get("progress") or "")
        self.assertIn("待生成", progress)
        self.assertIn("海报", progress)
        self.assertNotIn("都已完成", progress, "还有待生成节点时不能写都已完成")


class M1SummaryNodesFromToolResultsTests(unittest.TestCase):
    """M1：本轮建/改过的节点从工具执行结果取，写进摘要【涉及节点】和档案 key_nodes。

    模型在摘要里写「无节点 id」也不采信：服务端用真实工具结果覆盖这一段。"""

    SUMMARY = ("【目标】做一张咖啡海报\n【已定决策】3:4 竖版\n【已完成】文案与海报节点都建好了\n"
               "【涉及节点】无节点 id\n【未决事项】等用户点执行生成\n【用户纠正】无\n【记忆候选】无")

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self._memory = memory_on()
        self._memory.__enter__()
        self.canvas_id = new_beat_canvas(nodes=[])
        self.thread_id = new_thread(self.canvas_id)

    def tearDown(self):
        self._memory.__exit__(None, None, None)

    def _run(self):
        async def fake_decide(chat, messages, canvas_id="", tools_json_text="", tools=None,
                              rebuild_json=None):
            return {"thought": "先写文案，再把海报节点建好", "steps": [
                {"tool": "create_node", "description": "新建文本节点",
                 "args": {"canvas_id": self.canvas_id, "type": "text", "prompt": "一杯好咖啡"}},
                {"tool": "generate_image", "description": "建好待生成的海报节点",
                 "args": {"canvas_id": self.canvas_id, "prompt": "白底咖啡海报", "ratio": "3:4"}},
            ]}

        req = {"canvas_id": self.canvas_id, "run_id": "run_" + uuid.uuid4().hex[:10],
               "instruction": "做一张咖啡海报", "focus": main._agent_run_normalize_focus(None),
               "history": [], "thread_id": self.thread_id,
               "chat": {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
                        "model": "stub-model", "provider_cfg": {"protocol": "custom"}, "think_level": ""},
               "max_steps": 0, "mode": "run", "approved_steps": [], "renderer": "beat",
               "use_thread": True, "enforce_write_confirmation": True}

        async def go():
            queue = asyncio.Queue()
            await main._agent_run_producer(req, queue)
            while not queue.empty():
                if queue.get_nowait() is None:
                    break

        with patch.dict(os.environ, {"NOVAI_AGENT_V2_CONTEXT": "1"}), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide):
            asyncio.run(go())

    def _summarize(self):
        captured = {}

        async def fake_chat(chat, messages):
            captured["prompt"] = messages
            return self.SUMMARY

        with patch.object(main, "_agent_run_chat", new=fake_chat):
            asyncio.run(main._agent_v2_memory_update(self.canvas_id, self.thread_id, {"model": "fake"}))
        return captured

    def test_summary_and_profile_use_real_tool_result_node_ids(self):
        self._run()
        messages = thread_messages(self.canvas_id, self.thread_id)
        assistant = [msg for msg in messages if msg.get("role") == "assistant"][-1]
        run_nodes = assistant.get("nodes") or []
        self.assertEqual(len(run_nodes), 2, run_nodes)
        self.assertTrue(all(node.get("id") for node in run_nodes), run_nodes)
        self.assertTrue(all(node.get("title") for node in run_nodes), run_nodes)
        # 摘要提示词里也要带上这两个真实节点（模型写的时候有据可依）
        captured = self._summarize()
        prompt = "\n".join(str(item.get("content") or "") for item in captured.get("prompt") or []
                           if isinstance(item, dict))
        for node in run_nodes:
            self.assertIn(str(node["id"]), prompt)

        doc = main._agent_thread_doc_load(self.canvas_id)
        thread = main._agent_thread_find(doc, self.thread_id)
        summary = str(thread.get("summary") or "")
        self.assertNotIn("无节点 id", summary, summary)
        for node in run_nodes:
            self.assertIn("%s（%s）" % (node["title"], node["id"]), summary, summary)

        profile = STORE.load_profile(main.AGENT_MEMORY_DIR, self.canvas_id)
        self.assertEqual(len(profile["key_nodes"]), 2, profile["key_nodes"])
        for node in run_nodes:
            self.assertIn("%s（%s）" % (node["title"], node["id"]), profile["key_nodes"])


if __name__ == "__main__":
    unittest.main()
