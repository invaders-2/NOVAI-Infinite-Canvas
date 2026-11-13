# -*- coding: utf-8 -*-
"""E3：/api/agent/events 的唤醒 / 主动消息分支要求画布 edit 权限。

view 权限下：会唤醒挂起运行或往对话写主动消息的事件返回 403，且没有副作用
（状态不变、对话无新消息、不写节流时间戳）；纯 action=none 的事件不受影响。
"""
import asyncio
import contextlib
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_OWN_TMP = ""
_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-event-perms-")
    _OWN_TMP = _TMP
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import run_state  # noqa: E402


def tearDownModule():
    if _OWN_TMP:
        shutil.rmtree(_OWN_TMP, ignore_errors=True)


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def canvas():
    return {"id": "c1", "kind": "beat", "title": "权限测试画布", "owner_id": 1,
            "nodes": [], "connections": [], "updated_at": 1700000000000}


def request():
    """占位 request：身份与角色都在 _enter() 里 patch 掉。"""
    return object()


def thread_messages(canvas_id):
    doc = main._agent_thread_doc_load(canvas_id)
    thread = main._agent_thread_active(doc)
    return list((thread or {}).get("messages") or [])


class EventPermissionTests(unittest.TestCase):

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = "c1"
        self.run_id = "run_evt_" + uuid.uuid4().hex[:8]
        main._AGENT_TRIGGER_LAST_MESSAGE.clear()
        self._remove()

    def tearDown(self):
        self._remove()
        main._AGENT_TRIGGER_LAST_MESSAGE.clear()

    def _remove(self):
        try:
            path = main._agent_run_state_path(self.run_id)
        except Exception:
            path = ""
        if path and os.path.exists(path):
            os.remove(path)
        try:
            thread_path = main._agent_thread_path(self.canvas_id)
        except Exception:
            thread_path = ""
        if thread_path and os.path.exists(thread_path):
            os.remove(thread_path)

    def _suspend(self):
        main._agent_run_state_write(self.run_id, {
            "run_id": self.run_id, "canvas_id": self.canvas_id,
            "autonomy": "collab", "status": run_state.STATUS_WAITING_GENERATION,
            "waiting_on": ["n1"], "round": 1, "steps": 1})

    def _enter(self, role):
        """已登录、角色为 role（viewer / editor / owner）。"""
        stack = contextlib.ExitStack()
        user = {"id": 2, "role": "user"}
        stack.enter_context(patch.object(main, "request_auth_user", return_value=user))
        stack.enter_context(patch.object(main, "canvas_access_role", return_value=role))
        stack.enter_context(patch.object(main, "load_canvas", return_value=canvas()))
        stack.enter_context(patch.object(main, "_agent_v2_triggers_enabled", return_value=True))
        return stack

    def _event(self, event_type, payload=None):
        return main.AgentEventRequest(canvas_id=self.canvas_id, type=event_type,
                                      payload=payload or {})

    def test_viewer_generation_completed_is_403_without_side_effects(self):
        self._suspend()
        resume_mock = AsyncMock(return_value={"ok": True})
        with self._enter("viewer"), patch.object(main, "_agent_run_resume", new=resume_mock):
            with self.assertRaises(main.HTTPException) as caught:
                asyncio.run(main.agent_run_events(
                    self._event("generation_completed", {"node_id": "n1"}), request()))
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(str(caught.exception.detail), "需要可编辑权限")
        self.assertEqual(resume_mock.await_count, 0, "403 不能去唤醒运行")
        self.assertEqual(main._agent_run_state_read(self.run_id).get("status"),
                         run_state.STATUS_WAITING_GENERATION, "状态不能被改")
        self.assertEqual(thread_messages(self.canvas_id), [], "对话不能新增消息")
        self.assertEqual(main._AGENT_TRIGGER_LAST_MESSAGE, {}, "不能写节流时间戳")

    def test_editor_generation_completed_wakes_run(self):
        self._suspend()
        resume_mock = AsyncMock(return_value={"ok": True})
        with self._enter("editor"), patch.object(main, "_agent_run_resume", new=resume_mock):
            result = asyncio.run(main.agent_run_events(
                self._event("generation_completed", {"node_id": "n1"}), request()))
        self.assertEqual(result.get("action"), "wake")
        self.assertTrue(result.get("resumed"))
        self.assertEqual(resume_mock.await_count, 1)
        self.assertEqual(resume_mock.await_args.args[1]["node_ids"], ["n1"])

    def test_viewer_proactive_message_is_403_without_side_effects(self):
        with self._enter("viewer"):
            with self.assertRaises(main.HTTPException) as caught:
                asyncio.run(main.agent_run_events(
                    self._event("asset_added", {"name": "产品图"}), request()))
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(thread_messages(self.canvas_id), [], "403 不能写主动消息")
        self.assertEqual(main._AGENT_TRIGGER_LAST_MESSAGE, {}, "不能写节流时间戳")

    def test_editor_proactive_message_is_written(self):
        with self._enter("editor"):
            result = asyncio.run(main.agent_run_events(
                self._event("asset_added", {"name": "产品图"}), request()))
        self.assertEqual(result.get("action"), "message")
        messages = thread_messages(self.canvas_id)
        self.assertEqual(len(messages), 1, messages)
        self.assertEqual(messages[0].get("origin"), "agent")
        self.assertIn(self.canvas_id, main._AGENT_TRIGGER_LAST_MESSAGE)

    def test_unknown_event_is_noop_for_viewer(self):
        with self._enter("viewer"):
            result = asyncio.run(main.agent_run_events(
                self._event("not_a_real_event", {}), request()))
        self.assertEqual(result.get("action"), "none")
        self.assertEqual(thread_messages(self.canvas_id), [])


if __name__ == "__main__":
    unittest.main()
