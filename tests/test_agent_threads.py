# -*- coding: utf-8 -*-
"""会话分支（fork）：多线程存储与迁移、fork 截断、上限、switch、history 优先级、删除画布清理。

用真实 TestClient(main.app) + 临时数据目录；模型不参与（run 的 producer 打桩，只看 req）。
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-agent-threads-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

CLIENT = TestClient(main.app)


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def new_canvas(title="线程测试画布"):
    resp = CLIENT.post("/api/canvases", json={"title": title, "kind": "smart"})
    assert resp.status_code == 200, resp.text
    return resp.json()["canvas"]["id"]


def thread_file(canvas_id):
    return os.path.join(main.AGENT_THREADS_DIR, "%s.json" % canvas_id)


def seed_messages(canvas_id, count=3):
    main.agent_thread_append(canvas_id, [{"role": "user", "text": "第 %d 句" % (index + 1)} for index in range(count)])


class ThreadStorageMigrationTests(unittest.TestCase):

    def test_legacy_single_thread_is_migrated(self):
        canvas_id = new_canvas("旧格式画布")
        legacy = {"canvas_id": canvas_id, "messages": [
            {"role": "user", "text": "旧消息一", "at": 1},
            {"role": "assistant", "text": "旧回复一", "at": 2},
        ], "recent": ["图1"], "updated_at": 123}
        os.makedirs(main.AGENT_THREADS_DIR, exist_ok=True)
        with open(thread_file(canvas_id), "w", encoding="utf-8") as fh:
            json.dump(legacy, fh, ensure_ascii=False)

        thread = main.agent_thread_load(canvas_id)
        self.assertEqual([m["text"] for m in thread["messages"]], ["旧消息一", "旧回复一"])
        self.assertEqual(thread["recent"], ["图1"])
        rows = CLIENT.get("/api/agent/threads", params={"canvas_id": canvas_id}).json()
        self.assertEqual(len(rows["threads"]), 1)
        self.assertEqual(rows["threads"][0]["message_count"], 2)
        self.assertEqual(rows["active_id"], rows["threads"][0]["id"])

        # 迁移后再追加，落成新格式且旧消息不丢
        main.agent_thread_append(canvas_id, [{"role": "user", "text": "新消息"}])
        with open(thread_file(canvas_id), "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertIn("threads", doc)
        self.assertEqual(doc["threads"][0]["messages"][-1]["text"], "新消息")
        self.assertEqual(len(doc["threads"][0]["messages"]), 3)

    def test_thread_list_hides_message_body(self):
        canvas_id = new_canvas("列表画布")
        seed_messages(canvas_id, 2)
        body = CLIENT.get("/api/agent/threads", params={"canvas_id": canvas_id}).json()
        self.assertEqual(len(body["threads"]), 1)
        row = body["threads"][0]
        for key in ("id", "title", "created_at", "updated_at", "forked_from", "message_count"):
            self.assertIn(key, row)
        self.assertNotIn("messages", row)
        self.assertEqual(row["message_count"], 2)
        self.assertIsInstance(row["updated_at"], float)
        self.assertGreaterEqual(row["updated_at"], row["created_at"])


class ThreadForkTests(unittest.TestCase):

    def setUp(self):
        self.canvas_id = new_canvas("fork 画布")
        seed_messages(self.canvas_id, 3)
        self.thread_id = CLIENT.get("/api/agent/threads",
                                    params={"canvas_id": self.canvas_id}).json()["threads"][0]["id"]

    def _fork(self, index, **extra):
        payload = {"canvas_id": self.canvas_id, "thread_id": self.thread_id, "message_index": index}
        payload.update(extra)
        return CLIENT.post("/api/agent/threads/fork", json=payload)

    def test_fork_first_message_boundary(self):
        resp = self._fork(0)
        self.assertEqual(resp.status_code, 200, resp.text)
        thread = resp.json()["thread"]
        self.assertEqual(thread["message_count"], 1)
        self.assertEqual(thread["title"], "对话 1 · 分支 2")
        rows = CLIENT.get("/api/agent/threads", params={"canvas_id": self.canvas_id}).json()["threads"]
        forked = next(item for item in rows if item["id"] == thread["id"])
        self.assertEqual(forked["forked_from"], self.thread_id)
        self.assertEqual(forked["forked_at_message"], 0)

    def test_fork_last_message_boundary(self):
        resp = self._fork(2)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["thread"][ "message_count"], 3)

    def test_fork_out_of_range_is_400(self):
        for index in (3, 99, -1):
            with self.subTest(index=index):
                resp = self._fork(index)
                self.assertEqual(resp.status_code, 400)
                self.assertIn("message_index", resp.json()["detail"])

    def test_fork_numbering_increments(self):
        first = self._fork(1).json()["thread"]
        second = self._fork(1).json()["thread"]
        self.assertEqual(first["title"], "对话 1 · 分支 2")
        self.assertEqual(second["title"], "对话 1 · 分支 3")

    def test_thread_cap_is_20(self):
        with main._AGENT_THREAD_LOCK:
            doc = main._agent_thread_doc_load(self.canvas_id)
            while len(doc["threads"]) < main.AGENT_THREAD_MAX_THREADS:
                doc["threads"].append(main._agent_thread_new_thread("占位线程"))
            main._agent_thread_doc_save(self.canvas_id, doc)
        resp = self._fork(0)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("线程过多", resp.json()["detail"])

    def test_switch_changes_active(self):
        forked = self._fork(1).json()["thread"]["id"]
        switched = CLIENT.post("/api/agent/threads/switch",
                               json={"canvas_id": self.canvas_id, "thread_id": forked})
        self.assertEqual(switched.status_code, 200, switched.text)
        self.assertEqual(switched.json()["active_id"], forked)
        rows = CLIENT.get("/api/agent/threads", params={"canvas_id": self.canvas_id}).json()
        self.assertEqual(rows["active_id"], forked)

    def test_switch_unknown_thread_404(self):
        resp = CLIENT.post("/api/agent/threads/switch",
                           json={"canvas_id": self.canvas_id, "thread_id": "no-such-thread"})
        self.assertEqual(resp.status_code, 404)


class ThreadHistoryPriorityTests(unittest.TestCase):
    """run 带的 thread_id 优先于请求里的 history。"""

    def setUp(self):
        self.canvas_id = new_canvas("history 画布")
        main.agent_thread_append(self.canvas_id, [
            {"role": "user", "text": "线程里的第一句"},
            {"role": "assistant", "text": "线程里的第一答"},
        ])
        doc = main._agent_thread_doc_load(self.canvas_id)
        self.thread_id = doc["active_id"]

    def _run_and_capture(self, payload):
        captured = {}

        async def fake_producer(req, queue, bus=None):
            captured.update(req)
            return

        fake_chat = {"provider": "openai", "base": "https://example.invalid/v1", "headers": {},
                     "model": "test-chat-model", "provider_cfg": {}}
        with patch.object(main, "_agent_run_resolve_chat", return_value=fake_chat), \
                patch.object(main, "_agent_run_producer", new=fake_producer):
            resp = CLIENT.post("/api/agent/run", json=payload)
        self.assertEqual(resp.status_code, 200, resp.text)
        return captured

    def _payload(self, **extra):
        payload = {"canvas_id": self.canvas_id, "instruction": "继续",
                   "history": [{"role": "user", "text": "请求里的历史"}],
                   "provider": "openai", "model": "test-chat-model", "mode": "plan"}
        payload.update(extra)
        return payload

    def test_thread_id_wins_over_request_history(self):
        req = self._run_and_capture(self._payload(thread_id=self.thread_id))
        texts = [item["text"] for item in req["history"]]
        self.assertIn("线程里的第一句", texts)
        self.assertNotIn("请求里的历史", texts)
        self.assertEqual(req["thread_id"], self.thread_id)

    def test_without_thread_id_uses_request_history(self):
        req = self._run_and_capture(self._payload())
        self.assertEqual([item["text"] for item in req["history"]], ["请求里的历史"])
        self.assertEqual(req["thread_id"], "")

    def test_unknown_thread_id_is_404(self):
        resp = CLIENT.post("/api/agent/run", json=self._payload(thread_id="no-such-thread"))
        self.assertEqual(resp.status_code, 404)


class CanvasPurgeTests(unittest.TestCase):

    def test_purge_removes_thread_file(self):
        canvas_id = new_canvas("待删除画布")
        seed_messages(canvas_id, 1)
        self.assertTrue(os.path.isfile(thread_file(canvas_id)))
        resp = CLIENT.delete("/api/canvases/%s/purge" % canvas_id)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertFalse(os.path.isfile(thread_file(canvas_id)))


class ThreadRenameTests(unittest.TestCase):

    def setUp(self):
        self.canvas_id = new_canvas("rename 画布")
        seed_messages(self.canvas_id, 1)
        self.thread_id = CLIENT.get("/api/agent/threads",
                                    params={"canvas_id": self.canvas_id}).json()["threads"][0]["id"]

    def _rename(self, title, thread_id=None, canvas_id=None):
        return CLIENT.post("/api/agent/threads/rename", json={
            "canvas_id": canvas_id if canvas_id is not None else self.canvas_id,
            "thread_id": thread_id if thread_id is not None else self.thread_id,
            "title": title,
        })

    def test_rename_updates_title(self):
        resp = self._rename("  新标题  ")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"ok": True,
                                       "thread": {"id": self.thread_id, "title": "新标题"}})
        rows = CLIENT.get("/api/agent/threads", params={"canvas_id": self.canvas_id}).json()["threads"]
        self.assertEqual(rows[0]["title"], "新标题")

    def test_empty_title_is_400(self):
        resp = self._rename("   ")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["detail"], "标题不能为空")

    def test_too_long_title_is_400(self):
        resp = self._rename("字" * 61)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("标题过长（最多 60 字）", resp.json()["detail"])

    def test_unknown_thread_is_404(self):
        resp = self._rename("x", thread_id="no-such-thread")
        self.assertEqual(resp.status_code, 404)
        self.assertIn("线程不存在", resp.json()["detail"])

    def test_unknown_canvas_is_404(self):
        resp = self._rename("x", canvas_id="no-such-canvas")
        self.assertEqual(resp.status_code, 404)


class ThreadDeleteTests(unittest.TestCase):

    def setUp(self):
        self.canvas_id = new_canvas("delete 画布")
        seed_messages(self.canvas_id, 1)
        self.base_id = CLIENT.get("/api/agent/threads",
                                  params={"canvas_id": self.canvas_id}).json()["threads"][0]["id"]

    def _fork_from(self, message_index=0):
        payload = {"canvas_id": self.canvas_id, "thread_id": self.base_id,
                   "message_index": message_index}
        resp = CLIENT.post("/api/agent/threads/fork", json=payload)
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()["thread"]["id"]

    def _switch(self, thread_id):
        return CLIENT.post("/api/agent/threads/switch",
                           json={"canvas_id": self.canvas_id, "thread_id": thread_id})

    def _delete(self, thread_id, canvas_id=None):
        return CLIENT.delete("/api/agent/threads/%s" % thread_id,
                             params={"canvas_id": canvas_id if canvas_id is not None else self.canvas_id})

    def test_delete_removes_thread(self):
        forked = self._fork_from()
        resp = self._delete(forked)
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["deleted"], forked)
        rows = CLIENT.get("/api/agent/threads", params={"canvas_id": self.canvas_id}).json()["threads"]
        self.assertEqual([item["id"] for item in rows], [self.base_id])

    def test_delete_active_switches_to_newest_remaining(self):
        forked2 = self._fork_from()
        forked3 = self._fork_from()
        with main._AGENT_THREAD_LOCK:
            doc = main._agent_thread_doc_load(self.canvas_id)
            for thread in doc["threads"]:
                if thread["id"] == self.base_id:
                    thread["created_at"] = 100.0
                elif thread["id"] == forked2:
                    thread["created_at"] = 300.0
                elif thread["id"] == forked3:
                    thread["created_at"] = 400.0
            doc["active_id"] = forked2
            main._agent_thread_doc_save(self.canvas_id, doc)
        resp = self._delete(forked2)
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["deleted"], forked2)
        self.assertEqual(body["active_id"], forked3)
        rows = CLIENT.get("/api/agent/threads", params={"canvas_id": self.canvas_id}).json()
        self.assertEqual(rows["active_id"], forked3)

    def test_delete_inactive_keeps_active(self):
        forked = self._fork_from()
        self._switch(forked)
        resp = self._delete(self.base_id)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["active_id"], forked)

    def test_last_thread_is_400(self):
        resp = self._delete(self.base_id)
        self.assertEqual(resp.status_code, 400)
        self.assertIn("至少保留一条对话", resp.json()["detail"])

    def test_unknown_thread_is_404(self):
        resp = self._delete("no-such-thread")
        self.assertEqual(resp.status_code, 404)
        self.assertIn("线程不存在", resp.json()["detail"])

    def test_unknown_canvas_is_404(self):
        resp = self._delete(self.base_id, canvas_id="no-such-canvas")
        self.assertEqual(resp.status_code, 404)


class ThreadFeedbackTests(unittest.TestCase):

    def setUp(self):
        self.canvas_id = new_canvas("反馈画布")
        main.agent_thread_append(self.canvas_id, [
            {"role": "user", "text": "问题"},
            {"role": "assistant", "text": "回答"},
        ])
        self.thread_id = CLIENT.get("/api/agent/threads",
                                    params={"canvas_id": self.canvas_id}).json()["threads"][0]["id"]

    def _rate(self, rating, index=1, thread_id=None):
        return CLIENT.post("/api/agent/threads/feedback", json={
            "canvas_id": self.canvas_id,
            "thread_id": thread_id or self.thread_id,
            "message_index": index,
            "rating": rating,
        })

    def test_set_change_and_clear_feedback(self):
        for rating in ("up", "down", None):
            resp = self._rate(rating)
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual(resp.json()["rating"], rating)
            rows = CLIENT.get("/api/agent/thread/%s" % self.canvas_id).json()["messages"]
            if rating:
                self.assertEqual(rows[1]["rating"], rating)
            else:
                self.assertNotIn("rating", rows[1])
        rows = CLIENT.get("/api/agent/threads", params={"canvas_id": self.canvas_id}).json()["threads"]
        self.assertIsInstance(rows[0]["updated_at"], float)

    def test_feedback_validation(self):
        self.assertEqual(self._rate("up", index=0).status_code, 400)
        self.assertEqual(self._rate("up", index=9).status_code, 400)
        self.assertEqual(self._rate("other").status_code, 400)
        self.assertEqual(self._rate("up", thread_id="no-such-thread").status_code, 404)

    def test_fork_feedback_is_independent(self):
        self.assertEqual(self._rate("up").status_code, 200)
        forked = CLIENT.post("/api/agent/threads/fork", json={
            "canvas_id": self.canvas_id, "thread_id": self.thread_id,
            "message_index": 1}).json()["thread"]["id"]
        self.assertEqual(self._rate(None).status_code, 200)
        original = main._agent_thread_find(main._agent_thread_doc_load(self.canvas_id), self.thread_id)
        fork = main._agent_thread_find(main._agent_thread_doc_load(self.canvas_id), forked)
        self.assertNotIn("rating", original["messages"][1])
        self.assertEqual(fork["messages"][1]["rating"], "up")


class ThreadConcurrencyTests(unittest.TestCase):

    def test_sequential_renames_last_wins(self):
        canvas_id = new_canvas("concurrency 画布")
        seed_messages(canvas_id, 1)
        thread_id = CLIENT.get("/api/agent/threads",
                               params={"canvas_id": canvas_id}).json()["threads"][0]["id"]
        for title in ("第一次改名", "第二次改名"):
            resp = CLIENT.post("/api/agent/threads/rename", json={
                "canvas_id": canvas_id, "thread_id": thread_id, "title": title})
            self.assertEqual(resp.status_code, 200, resp.text)
        rows = CLIENT.get("/api/agent/threads", params={"canvas_id": canvas_id}).json()["threads"]
        self.assertEqual(rows[0]["title"], "第二次改名")
        with open(thread_file(canvas_id), "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(doc["threads"][0]["title"], "第二次改名")


class ThreadMessagesTests(unittest.TestCase):
    """GET /api/agent/threads/{thread_id}/messages：按线程 id 只读消息，不改变 active_id。"""

    def setUp(self):
        self.canvas_id = new_canvas("messages 画布")
        seed_messages(self.canvas_id, 3)
        self.thread_id = CLIENT.get("/api/agent/threads",
                                    params={"canvas_id": self.canvas_id}).json()["threads"][0]["id"]

    def _messages(self, thread_id=None, limit=None, canvas_id=None):
        params = {"canvas_id": canvas_id if canvas_id is not None else self.canvas_id}
        if limit is not None:
            params["limit"] = limit
        return CLIENT.get("/api/agent/threads/%s/messages" % (thread_id or self.thread_id),
                          params=params)

    def test_reads_messages_in_order(self):
        resp = self._messages()
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["thread_id"], self.thread_id)
        self.assertEqual(body["title"], "对话 1")
        self.assertEqual([item["content"] for item in body["messages"]],
                         ["第 1 句", "第 2 句", "第 3 句"])
        self.assertEqual([item["role"] for item in body["messages"]],
                         ["user", "user", "user"])
        self.assertEqual(body["count"], 3)
        self.assertFalse(body["has_more"])
        self.assertIsInstance(body["messages"][0]["at"], float)

    def test_limit_truncates_tail_and_has_more(self):
        main.agent_thread_append(self.canvas_id, [{"role": "user", "text": "第 4 句"},
                                                  {"role": "user", "text": "第 5 句"}])   # 共 5 条
        resp = self._messages(limit=2)
        body = resp.json()
        self.assertEqual(body["count"], 2)
        self.assertEqual([item["content"] for item in body["messages"]],
                         ["第 4 句", "第 5 句"])
        self.assertTrue(body["has_more"])
        full = self._messages(limit=200).json()
        self.assertEqual(full["count"], 5)
        self.assertFalse(full["has_more"])

    def test_limit_clamped_to_200(self):
        with main._AGENT_THREAD_LOCK:
            doc = main._agent_thread_doc_load(self.canvas_id)
            thread = main._agent_thread_find(doc, self.thread_id)
            thread["messages"] = [{"role": "user", "text": "m%03d" % index, "at": float(index)}
                                  for index in range(250)]
            main._agent_thread_doc_save(self.canvas_id, doc)
        body = self._messages(limit=999).json()
        self.assertEqual(body["count"], 200)
        self.assertTrue(body["has_more"])
        self.assertEqual(body["messages"][-1]["content"], "m249")

    def test_thread_and_canvas_404(self):
        missing_thread = self._messages(thread_id="no-such-thread")
        self.assertEqual(missing_thread.status_code, 404)
        self.assertIn("线程不存在", missing_thread.json()["detail"])
        missing_canvas = self._messages(canvas_id="no-such-canvas")
        self.assertEqual(missing_canvas.status_code, 404)

    def test_does_not_change_active_id(self):
        forked = CLIENT.post("/api/agent/threads/fork", json={
            "canvas_id": self.canvas_id, "thread_id": self.thread_id, "message_index": 1}).json()["thread"]["id"]
        CLIENT.post("/api/agent/threads/switch",
                    json={"canvas_id": self.canvas_id, "thread_id": forked})
        resp = self._messages(thread_id=self.thread_id)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(len(resp.json()["messages"]), 3)
        rows = CLIENT.get("/api/agent/threads", params={"canvas_id": self.canvas_id}).json()
        self.assertEqual(rows["active_id"], forked)


def run_canvas_agent(canvas_id, decisions, approved=None):
    req = {
        "canvas_id": canvas_id,
        "instruction": "做个东西",
        "focus": main._agent_run_normalize_focus(None),
        "history": [],
        "chat": {"provider": "p", "base": "https://example.invalid/v1", "headers": {},
                 "model": "test-chat-model", "provider_cfg": {}},
        "max_steps": 6,
        "mode": "run",
        "approved_steps": approved or [],
        "use_thread": True,
    }

    async def fake_decide(*args, **kwargs):
        return decisions.pop(0)

    async def go():
        with patch.object(main, "_agent_run_decide", new=AsyncMock(side_effect=fake_decide)), \
                patch.object(main, "agent_session_save"):
            await main._agent_run_producer(req, None)

    asyncio.run(go())


def last_assistant(canvas_id):
    thread = main.agent_thread_load(canvas_id)
    return [msg for msg in thread.get("messages") or [] if msg.get("role") == "assistant"][-1]


class ThreadStepsPersistenceTests(unittest.TestCase):
    """运行结束后把本轮工具步骤写进 assistant 消息，供历史回放。"""

    def setUp(self):
        self.canvas_id = new_canvas("步骤回放画布")

    def test_success_step_is_persisted(self):
        run_canvas_agent(self.canvas_id, [{"done": True, "message": "建好了"}],
                         approved=[{"tool": "create_node",
                                    "args": {"canvas_id": self.canvas_id, "type": "prompt",
                                             "text": "你好"}}])
        msg = last_assistant(self.canvas_id)
        self.assertTrue(str(msg["run_id"]).startswith("run_"))
        self.assertEqual(len(msg["steps"]), 1)
        step = msg["steps"][0]
        self.assertEqual(step["tool"], "create_node")
        self.assertTrue(step["ok"])
        self.assertIn("index", step)
        self.assertIsInstance(step.get("duration_ms"), int)
        self.assertGreaterEqual(msg["changes"]["nodes"], 1)
        self.assertIn("artifacts", msg["changes"])

    def test_failed_step_keeps_error_and_code(self):
        run_canvas_agent(self.canvas_id, [{"done": True, "message": "失败了"}],
                         approved=[{"tool": "delete_node",
                                    "args": {"canvas_id": self.canvas_id,
                                             "node_id": "missing-node"}}])
        step = last_assistant(self.canvas_id)["steps"][0]
        self.assertFalse(step["ok"])
        self.assertIn("不存在", step["error"])
        self.assertEqual(step["code"], "node_not_found")

    def test_pure_chat_has_empty_steps_and_no_changes(self):
        run_canvas_agent(self.canvas_id, [{"done": True, "message": "直接回答"}])
        msg = last_assistant(self.canvas_id)
        self.assertEqual(msg["steps"], [])
        self.assertNotIn("changes", msg)

    def test_huge_steps_keep_last_10_and_truncated(self):
        steps = [{"index": index + 1, "tool": "tool%d" % (index + 1), "args": {},
                  "ok": True, "output": "字" * 2000} for index in range(20)]
        main.agent_thread_append(self.canvas_id, [{"role": "assistant", "text": "步骤很多",
                                                   "steps": steps}])
        msg = last_assistant(self.canvas_id)
        self.assertEqual(len(msg["steps"]), 10)
        self.assertTrue(msg["truncated"])
        self.assertEqual(msg["steps"][0]["index"], 11)

    def test_api_exposes_steps(self):
        run_canvas_agent(self.canvas_id, [{"done": True, "message": "好了"}],
                         approved=[{"tool": "create_node",
                                    "args": {"canvas_id": self.canvas_id, "type": "prompt",
                                             "text": "你好"}}])
        thread_id = CLIENT.get("/api/agent/threads",
                               params={"canvas_id": self.canvas_id}).json()["threads"][0]["id"]
        rows = CLIENT.get("/api/agent/threads/%s/messages" % thread_id,
                          params={"canvas_id": self.canvas_id}).json()["messages"]
        assistant = [item for item in rows if item["role"] == "assistant"][-1]
        self.assertIn("steps", assistant)
        self.assertIn("run_id", assistant)
        self.assertIn("changes", assistant)
        self.assertEqual(assistant["steps"][0]["tool"], "create_node")
        thread_msgs = CLIENT.get("/api/agent/thread/%s" % self.canvas_id).json()["messages"]
        self.assertIn("steps", [item for item in thread_msgs if item["role"] == "assistant"][-1])

    def test_old_message_without_steps_is_compatible(self):
        canvas_id = new_canvas("旧线程画布")
        os.makedirs(main.AGENT_THREADS_DIR, exist_ok=True)
        legacy = {"canvas_id": canvas_id, "messages": [
            {"role": "user", "text": "旧问题", "at": 1},
            {"role": "assistant", "text": "旧回答", "at": 2},
        ], "recent": []}
        with open(thread_file(canvas_id), "w", encoding="utf-8") as fh:
            json.dump(legacy, fh, ensure_ascii=False)
        rows = CLIENT.get("/api/agent/thread/%s" % canvas_id).json()["messages"]
        self.assertEqual([item["text"] for item in rows], ["旧问题", "旧回答"])
        self.assertNotIn("steps", rows[1])
        self.assertNotIn("changes", rows[1])


if __name__ == "__main__":
    unittest.main()
