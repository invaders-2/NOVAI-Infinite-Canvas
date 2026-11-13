# -*- coding: utf-8 -*-
"""阶段四·3：运行状态机（挂起 / 唤醒 / 重启恢复）。

覆盖：状态模块纯函数与四态；producer 等生成时挂起（不占轮次、不计入时长）；
事件唤醒后从挂起处继续且消息不丢；模拟重启（新进程读状态文件 + 转录）恢复；
开关 NOVAI_AGENT_V2_RUNSTATE 关闭时保持原轮询行为。
"""
import asyncio
import contextlib
import io
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-runstate-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import run_state  # noqa: E402
from tests.test_agent_reflect import new_canvas  # noqa: E402


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def chat_config():
    return {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
            "model": "runstate-model", "provider_cfg": {"protocol": "custom"}, "think_level": ""}


def make_req(canvas_id, decisions):
    run_id = "run_state_" + uuid.uuid4().hex[:10]
    req = {"canvas_id": canvas_id, "run_id": run_id, "instruction": "做一张海报",
           "focus": main._agent_run_normalize_focus(None), "history": [], "thread_id": "",
           "chat": chat_config(), "max_steps": 0, "mode": "run", "approved_steps": [],
           "renderer": "beat", "use_thread": False, "enforce_write_confirmation": True,
           "autonomy": "collab", "budget": {}}
    bus = main._agent_run_bus_new(run_id, canvas_id)
    bus["request"] = req
    return req, bus, list(decisions)


async def executed_ready(tool, args):
    return {"ok": True, "tool": tool, "message": "已建节点",
            "result": {"status": "queued_on_canvas", "node_id": "n1", "kind": "image"}}


async def executed_done(tool, args):
    return {"ok": True, "tool": tool, "message": "生成成功",
            "result": {"status": "done", "node_id": "n1", "kind": "image", "url": "/a.png"}}


def run_with_patches(req, bus, decisions, wait_outcomes, env_extra=None, patches_extra=None):
    messages = []
    pending = list(decisions)

    async def fake_decide(chat, msgs, cid, tools_json_text="", tools=None, rebuild_json=None):
        messages.append([dict(message) for message in msgs])
        return pending.pop(0) if pending else {"done": True, "message": "完成"}

    async def fake_wait(self, node_ids, emit, cancelled, deadline=None):
        return [dict(item) for item in (wait_outcomes or [])]

    async def fake_review(*args, **kwargs):
        return None

    env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2")}
    env.update({"NOVAI_AGENT_V2_CONTEXT": "1", "NOVAI_AGENT_V2_RUNSTATE": "1",
                "NOVAI_AGENT_V2_TRANSCRIPT": "1", "NOVAI_AGENT_V2_AUTONOMY": "1"})
    env.update(env_extra or {})
    patches = [
        patch.dict(os.environ, env, clear=True),
        patch.object(main, "_agent_run_decide_v2", new=fake_decide),
        patch.object(main, "agent_execute_step", new=executed_ready),
        patch.object(main._CanvasRunContext, "wait_canvas_results", new=fake_wait),
        patch.object(main._CanvasRunContext, "confirmation_needed",
                     new=lambda self, steps, confirmed=False: {"needed": False, "tools": []}),
        patch.object(main, "_agent_beat_review", new=fake_review),
        patch.object(main, "_agent_v2_memory_schedule", new=lambda *a, **k: None),
    ] + list(patches_extra or [])
    for item in patches:
        item.start()
    return messages, pending, patches


def stop_patches(patches):
    for item in reversed(patches):
        item.stop()


def events_of(bus):
    return [{"event": item.get("name"), "data": item.get("data")}
            for item in (bus.get("events") or [])]


class RunStateModuleTests(unittest.TestCase):
    def test_four_states_and_validation(self):
        state = run_state.new_state("run_x", "c1", autonomy="auto")
        self.assertEqual(state["status"], run_state.STATUS_RUNNING)
        self.assertEqual(run_state.STATUSES,
                         ("running", "waiting_generation", "waiting_user", "waiting_budget", "finished"))
        self.assertTrue(run_state.is_active(state))
        suspended = run_state.touch(state, run_state.STATUS_WAITING_GENERATION, waiting_on=["n1"])
        self.assertEqual(suspended["status"], "waiting_generation")
        self.assertTrue(run_state.is_suspended(suspended))
        self.assertTrue(run_state.touch(suspended, run_state.STATUS_RUNNING)["updated_at"] > 0)
        with self.assertRaises(ValueError):
            run_state.touch(state, "bogus")

    def test_write_read_list_and_resume_scan(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        run_id = "run_mod_" + uuid.uuid4().hex[:8]
        state = run_state.new_state(run_id, "c1", round=2, steps=3, autonomy="managed",
                                    budget={"image": 2}, instruction="做海报")
        self.assertTrue(run_state.write_state(main.DATA_DIR, state))
        read = run_state.read_state(main.DATA_DIR, run_id)
        self.assertEqual(read["round"], 2)
        waiting = run_state.touch(read, run_state.STATUS_WAITING_GENERATION, waiting_on=["n1"])
        run_state.write_state(main.DATA_DIR, waiting)
        self.assertEqual([s["run_id"] for s in run_state.resumable_states(main.DATA_DIR)
                          if s["run_id"] == run_id], [run_id])
        run_state.write_state(main.DATA_DIR, run_state.touch(waiting, run_state.STATUS_FINISHED))
        self.assertEqual([s for s in run_state.resumable_states(main.DATA_DIR)
                          if s["run_id"] == run_id], [])
        os.remove(main._agent_run_state_path(run_id))


def review_ok():
    return {"summary": "合格", "items": [
        {"label": "图1", "node_id": "n1", "url": "/a.png", "kind": "image",
         "ok": True, "issues": [], "revised_prompt": ""}]}


async def resume_and_wait(run_id, event):
    """唤醒并在同一个事件循环里等恢复出来的 producer 跑完（跨进程恢复也一样）。"""
    result = await main._agent_run_resume(run_id, event)
    bus = main._agent_run_bus_get(run_id)
    task = bus.get("task") if isinstance(bus, dict) else None
    if task is not None and not task.done():
        await task
    return result


class ProducerSuspendTests(unittest.TestCase):
    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("runstate")

    def _start_suspended(self, decisions, autonomy="collab"):
        req, bus, pending = make_req(self.canvas_id, decisions)
        req["autonomy"] = autonomy
        messages, pending, patches = run_with_patches(
            req, bus, decisions,
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}])
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(main._agent_run_producer(req, None, bus=bus))
        return req, bus, messages, patches

    def test_generation_wait_suspends_without_consuming_round(self):
        decisions = [{"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
                     {"done": True, "message": "完成"}]
        req, bus, messages, patches = self._start_suspended(decisions)
        try:
            self.assertEqual(len(messages), 1, "挂起后不能再调模型")
            self.assertTrue(bus.get("suspended"))
            self.assertFalse([item for item in events_of(bus) if item["event"] == "done"],
                             "挂起不能发 done")
            state = main._agent_run_state_read(req["run_id"])
            self.assertEqual(state["status"], run_state.STATUS_WAITING_GENERATION)
            self.assertEqual(int(state["round"]), 1, "挂起不占轮次（状态里仍是第 1 轮）")
            self.assertEqual(state["waiting_on"], ["n1"])
            self.assertTrue([item for item in events_of(bus) if item["event"] == "run_suspended"])
            # 挂起后的状态文件里有恢复所需字段
            self.assertEqual(state["instruction"], "做一张海报")
            self.assertIn("history", state)
            self.assertIn("results", state)
        finally:
            stop_patches(patches)

    def test_resume_continues_from_suspended_place_and_keeps_messages(self):
        decisions = [{"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
                     {"done": True, "message": "完成"}]
        req, bus, messages, patches = self._start_suspended(decisions, autonomy="auto")
        try:
            transcript_before = len(bus.get("transcript").entries) if bus.get("transcript") else 0
            with patch.object(main, "_agent_beat_review", new=AsyncMock(return_value=review_ok())):
                result = asyncio.run(resume_and_wait(req["run_id"], {"node_ids": ["n1"]}))
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["waiting_on"], ["n1"])
            self.assertEqual(len(messages), 2, "唤醒后要从挂起处继续，而不是从头再来")
            resumed_messages = "\n".join(str(message.get("content") or "") for message in messages[1])
            self.assertIn("做一张海报", resumed_messages, "恢复的消息不能丢原指令")
            self.assertTrue([item for item in events_of(bus) if item["event"] == "run_resumed"])
            self.assertTrue([item for item in events_of(bus) if item["event"] == "done"])
            done = next(item["data"] for item in reversed(events_of(bus)) if item["event"] == "done")
            self.assertEqual(done["status"], "ok")
            self.assertEqual(int(main._agent_run_state_read(req["run_id"])["round"]), 2,
                             "唤醒后继续到第 2 轮（挂起时是第 1 轮、不重复）")
            transcript_after = len(bus.get("transcript").entries) if bus.get("transcript") else 0
            self.assertGreaterEqual(transcript_after, transcript_before, "转录不能被清空")
        finally:
            stop_patches(patches)

    def test_simulated_restart_restores_from_state_and_transcript(self):
        decisions = [{"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
                     {"done": True, "message": "重启后完成"}]
        req, bus, messages, patches = self._start_suspended(decisions, autonomy="auto")
        try:
            run_id = req["run_id"]
            transcript_path = os.path.join(main.DATA_DIR, "agent_runs", run_id + ".jsonl")
            self.assertTrue(os.path.exists(transcript_path), "挂起时转录必须已落盘")
            # 模拟进程重启：内存里的总线与任务全部丢掉，只剩状态文件 + 转录
            main._AGENT_RUN_BUS.pop(run_id, None)
            restored_req, restored_bus = main._agent_run_restore(run_id)
            self.assertIsNotNone(restored_req)
            self.assertEqual(restored_req["_resume_state"]["status"], "waiting_generation")
            with patch.object(main, "_agent_beat_review", new=AsyncMock(return_value=review_ok())):
                result = asyncio.run(resume_and_wait(run_id, {"node_ids": ["n1"]}))
            self.assertTrue(result["ok"], result)
            restored_bus = main._agent_run_bus_get(run_id)
            done = next(item["data"] for item in reversed(events_of(restored_bus))
                        if item["event"] == "done")
            self.assertEqual(done["message"], "重启后完成")
            resumed_text = "\n".join(str(message.get("content") or "") for message in messages[-1])
            self.assertTrue(resumed_text.strip(), "恢复后要有完整的消息列表（来自转录 / 历史）")
        finally:
            stop_patches(patches)

    def test_waiting_user_state_after_generation_card(self):
        # ready_to_generate → 待生成卡 → waiting_user（不是 finished）
        async def executed_card(tool, args):
            return {"ok": True, "tool": tool, "message": "已建好待生成节点",
                    "result": {"status": "ready_to_generate", "node_id": "n1", "kind": "image"}}
        req, bus, pending = make_req(self.canvas_id, [])
        env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2")}
        env.update({"NOVAI_AGENT_V2_CONTEXT": "1", "NOVAI_AGENT_V2_RUNSTATE": "1"})
        async def fake_decide(chat, msgs, cid, tools_json_text="", tools=None, rebuild_json=None):
            return {"steps": [{"tool": "generate_image",
                               "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]}
        with patch.dict(os.environ, env, clear=True), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide), \
                patch.object(main, "agent_execute_step", new=executed_card), \
                patch.object(main._CanvasRunContext, "confirmation_needed",
                             new=lambda self, steps, confirmed=False: {"needed": False, "tools": []}), \
                patch.object(main, "_agent_v2_memory_schedule", new=lambda *a, **k: None):
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
        state = main._agent_run_state_read(req["run_id"])
        self.assertEqual(state["status"], run_state.STATUS_WAITING_USER)


class SwitchOffTests(unittest.TestCase):
    def test_flag_off_keeps_polling_wait_and_no_state_file(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        canvas_id = new_canvas("runstate-off")
        req, bus, pending = make_req(canvas_id, [])
        calls = []

        async def fake_decide(chat, msgs, cid, tools_json_text="", tools=None, rebuild_json=None):
            return ({"steps": [{"tool": "generate_image",
                                "args": {"canvas_id": canvas_id, "prompt": "海报"}}]}
                    if not calls else {"done": True, "message": "完成"})

        async def fake_wait(self, node_ids, emit, cancelled, deadline=None):
            calls.append(list(node_ids))
            return [{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                     "text": "图片生成成功 /a.png"}]
        env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2")}
        env["NOVAI_AGENT_V2_CONTEXT"] = "1"
        with patch.dict(os.environ, env, clear=True), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide), \
                patch.object(main, "agent_execute_step", new=executed_ready), \
                patch.object(main._CanvasRunContext, "wait_canvas_results", new=fake_wait), \
                patch.object(main._CanvasRunContext, "confirmation_needed",
                             new=lambda self, steps, confirmed=False: {"needed": False, "tools": []}), \
                patch.object(main, "_agent_beat_review", new=AsyncMock(return_value=None)), \
                patch.object(main, "_agent_v2_memory_schedule", new=lambda *a, **k: None):
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
        self.assertEqual(calls, [["n1"]], "开关关闭时仍在循环里轮询 wait_canvas_results")
        self.assertTrue([item for item in events_of(bus) if item["event"] == "done"])
        self.assertFalse(os.path.exists(main._agent_run_state_path(req["run_id"])),
                         "开关关闭时不该写运行状态文件")


if __name__ == "__main__":
    unittest.main()
