# -*- coding: utf-8 -*-
"""E4：事件唤醒按 waiting_on 匹配 + 挂起超时标记 + canvas_id → 挂起 run 的内存索引。

(a) 等节点 A 时收到节点 B 的 generation_completed 不唤醒、状态仍 waiting_generation；
(b) 节点 A 事件唤醒；
(c) updated_at 25 小时前的挂起状态启动恢复不处理，状态变 finished、原因含「等待生成超时」；
(d) 索引建好后连续事件请求 / _agent_run_suspended_for_canvas 不读状态目录文件、不扫目录。
"""
import asyncio
import builtins
import contextlib
import json
import os
import shutil
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

_OWN_TMP = ""
_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-run-wait-index-")
    _OWN_TMP = _TMP
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import run_state  # noqa: E402
from tests.test_agent_reflect import new_canvas  # noqa: E402


def tearDownModule():
    if _OWN_TMP:
        shutil.rmtree(_OWN_TMP, ignore_errors=True)


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def fake_request():
    return object()


def write_suspended(canvas_id, run_id, waiting_on, updated_at=None):
    """直接落一份没被 touch 改过 updated_at 的挂起状态（用来造「25 小时前」）。"""
    state = run_state.new_state(run_id, canvas_id, autonomy="collab",
                                status=run_state.STATUS_WAITING_GENERATION,
                                waiting_on=list(waiting_on), round=1, steps=1)
    state["updated_at"] = float(updated_at if updated_at is not None else time.time())
    path = run_state.state_path(main.DATA_DIR, run_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False)
    return state


def post_event(canvas_id, event_type, event_payload=None):
    payload = main.AgentEventRequest(canvas_id=canvas_id, type=event_type,
                                     payload=event_payload or {})
    with patch.object(main, "request_auth_user", return_value=None), \
            patch.object(main, "_agent_v2_triggers_enabled", return_value=True):
        return asyncio.run(main.agent_run_events(payload, fake_request()))


class WaitMatchBase(unittest.TestCase):
    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("wait-index")
        self.run_id = "run_wait_" + uuid.uuid4().hex[:8]
        main._AGENT_RUN_SUSPENDED_INDEX.clear()
        main._AGENT_RUN_SUSPENDED_STATES.clear()
        main._AGENT_TRIGGER_LAST_MESSAGE.clear()

    def tearDown(self):
        main._AGENT_RUN_SUSPENDED_INDEX.clear()
        main._AGENT_RUN_SUSPENDED_STATES.clear()
        main._AGENT_TRIGGER_LAST_MESSAGE.clear()
        try:
            path = run_state.state_path(main.DATA_DIR, self.run_id)
        except Exception:
            path = ""
        if path and os.path.exists(path):
            os.remove(path)


class WakeMatchTests(WaitMatchBase):
    def test_other_node_event_does_not_wake(self):
        write_suspended(self.canvas_id, self.run_id, ["nA"])
        main._agent_run_suspended_index_rebuild()
        resume_mock = AsyncMock(return_value={"ok": True})
        with patch.object(main, "_agent_run_resume", new=resume_mock):
            result = post_event(self.canvas_id, "generation_completed", {"node_id": "nB"})
        self.assertEqual(result["action"], "none")
        self.assertFalse(result.get("resumed"))
        self.assertEqual(resume_mock.await_count, 0, "别的节点出结果不能唤醒")
        self.assertEqual(main._agent_run_state_read(self.run_id).get("status"),
                         run_state.STATUS_WAITING_GENERATION)

    def test_event_without_ids_never_wakes(self):
        write_suspended(self.canvas_id, self.run_id, ["nA"])
        main._agent_run_suspended_index_rebuild()
        resume_mock = AsyncMock(return_value={"ok": True})
        with patch.object(main, "_agent_run_resume", new=resume_mock):
            result = post_event(self.canvas_id, "generation_completed", {})
        self.assertEqual(result["action"], "none")
        self.assertEqual(resume_mock.await_count, 0, "不带 id 的事件绝不唤醒")

    def test_matching_node_event_wakes_run(self):
        write_suspended(self.canvas_id, self.run_id, ["nA"])
        main._agent_run_suspended_index_rebuild()
        resume_mock = AsyncMock(return_value={"ok": True})
        with patch.object(main, "_agent_run_resume", new=resume_mock):
            result = post_event(self.canvas_id, "generation_completed", {"node_id": "nA"})
        self.assertEqual(result["action"], "wake")
        self.assertTrue(result.get("resumed"))
        self.assertEqual(resume_mock.await_count, 1)
        self.assertEqual(resume_mock.await_args.args[1]["node_ids"], ["nA"])

    def test_matching_task_id_event_wakes_run(self):
        write_suspended(self.canvas_id, self.run_id, ["nA", "tA"])
        main._agent_run_suspended_index_rebuild()
        resume_mock = AsyncMock(return_value={"ok": True})
        with patch.object(main, "_agent_run_resume", new=resume_mock):
            result = post_event(self.canvas_id, "generation_completed", {"task_id": "tA"})
        self.assertEqual(result["action"], "wake")
        self.assertEqual(resume_mock.await_count, 1)


class WaitTimeoutTests(WaitMatchBase):
    def test_startup_skips_stale_state_and_marks_finished(self):
        write_suspended(self.canvas_id, self.run_id, ["nA"],
                        updated_at=time.time() - 25 * 3600)
        resume_mock = AsyncMock(return_value={"ok": True})
        with patch.object(main, "_agent_v2_runstate_enabled", return_value=True), \
                patch.object(main, "_agent_run_resume", new=resume_mock):
            resumed = asyncio.run(main._agent_run_resume_all())
        self.assertNotIn(self.run_id, resumed, "超时的挂起运行不能自动恢复")
        attempted = [call.args[0] for call in resume_mock.await_args_list]
        self.assertNotIn(self.run_id, attempted, "超时的挂起运行不能被恢复")
        state = main._agent_run_state_read(self.run_id)
        self.assertEqual(state.get("status"), run_state.STATUS_FINISHED)
        self.assertIn("等待生成超时", str(state.get("message") or ""))
        self.assertEqual(state.get("waiting_on"), [])
        main._agent_run_suspended_index_rebuild()
        self.assertIsNone(main._agent_run_suspended_for_canvas(self.canvas_id))

    def test_event_wake_marks_stale_finished(self):
        write_suspended(self.canvas_id, self.run_id, ["nA"],
                        updated_at=time.time() - 25 * 3600)
        main._agent_run_suspended_index_rebuild()
        resume_mock = AsyncMock(return_value={"ok": True})
        with patch.object(main, "_agent_run_resume", new=resume_mock):
            result = post_event(self.canvas_id, "generation_completed", {"node_id": "nA"})
        self.assertEqual(result["action"], "none")
        self.assertTrue(result.get("timeout"))
        self.assertEqual(resume_mock.await_count, 0, "超时运行不能被唤醒")
        state = main._agent_run_state_read(self.run_id)
        self.assertEqual(state.get("status"), run_state.STATUS_FINISHED)
        self.assertIn("等待生成超时", str(state.get("message") or ""))


class SuspendedIndexPerformanceTests(WaitMatchBase):
    def test_index_lookup_does_not_read_state_files(self):
        write_suspended(self.canvas_id, self.run_id, ["nA"])
        main._agent_run_suspended_index_rebuild()
        self.assertIsNotNone(main._agent_run_suspended_for_canvas(self.canvas_id),
                             "索引建好后要能查到挂起运行")
        state_dir = os.path.abspath(run_state.states_dir(main.DATA_DIR))
        real_open = builtins.open
        opened = []

        def counting_open(file, *args, **kwargs):
            try:
                path = os.path.abspath(os.fspath(file))
            except TypeError:
                path = ""
            if path and os.path.dirname(path) == state_dir:
                opened.append(path)
            return real_open(file, *args, **kwargs)

        resume_mock = AsyncMock(return_value={"ok": True})
        with patch("builtins.open", new=counting_open), \
                patch.object(run_state, "list_states",
                             wraps=run_state.list_states) as list_mock, \
                patch.object(main, "_agent_run_resume", new=resume_mock):
            for _ in range(100):
                self.assertIsNotNone(main._agent_run_suspended_for_canvas(self.canvas_id))
            for _ in range(100):
                result = post_event(self.canvas_id, "generation_completed", {"node_id": "nA"})
                self.assertEqual(result["action"], "wake")
        self.assertEqual(opened, [], "查索引不能读状态目录文件")
        self.assertEqual(list_mock.call_count, 0, "查索引不能全量扫状态目录")
        self.assertEqual(resume_mock.await_count, 100)


if __name__ == "__main__":
    unittest.main()
