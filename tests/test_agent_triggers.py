# -*- coding: utf-8 -*-
"""阶段四·2/4：画布事件触发 + 主动消息（NOVAI_AGENT_V2_TRIGGERS）。

覆盖：四类事件策略；节流（5 分钟内第二条被吞）；开关关闭 / 画布设置关闭时无主动消息；
auto 档「生成完成」事件唤醒挂起的运行（与 4.3 联动，用假模型）。
"""
import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import time
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-agent-triggers-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import triggers  # noqa: E402
from tests.test_agent_reflect import new_canvas  # noqa: E402
from tests.test_agent_run_state import (executed_ready, make_req, run_with_patches,  # noqa: E402
                                        stop_patches)


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def fake_request():
    return types.SimpleNamespace(headers={}, cookies={}, client=None)


def post_event(canvas_id, event_type, event_payload=None):
    payload = main.AgentEventRequest(canvas_id=canvas_id, type=event_type,
                                     payload=event_payload or {})
    with patch.object(main, "require_canvas_access", new=lambda *a, **k: None):
        return asyncio.run(main.agent_run_events(payload, fake_request()))


def thread_messages(canvas_id):
    thread = main._agent_thread_active(main._agent_thread_doc_load(canvas_id))
    return (thread or {}).get("messages") or []


def set_unfinished_plan(canvas_id):
    doc, thread = main._agent_thread_ensure_active(canvas_id)
    thread["roadmap"] = [{"stage": "出图", "generations": 2}, {"stage": "成片", "generations": 1}]
    main._agent_thread_doc_save(canvas_id, doc)


class PolicyTests(unittest.TestCase):
    def test_event_aliases(self):
        self.assertEqual(triggers.normalize_event_type("generation.completed"),
                         triggers.EVENT_GENERATION_COMPLETED)
        self.assertEqual(triggers.normalize_event_type("生成失败"),
                         triggers.EVENT_GENERATION_FAILED)
        self.assertEqual(triggers.normalize_event_type("asset.added"),
                         triggers.EVENT_ASSET_ADDED)
        self.assertEqual(triggers.normalize_event_type("bogus"), "")

    def test_four_event_actions(self):
        completed = triggers.TriggerPolicy("collab").decide(
            {"type": "generation_completed", "payload": {"node_id": "n1"}})
        self.assertEqual(completed["action"], "none")
        self.assertTrue(completed["review"])
        self.assertTrue(triggers.TriggerPolicy("auto", has_suspended_run=True)
                        .decide({"type": "generation_completed"})["wake"])
        failed = triggers.TriggerPolicy("collab").decide(
            {"type": "generation_failed", "payload": {"reason": "超时"}})
        self.assertEqual(failed["action"], "message")
        self.assertIn("超时", failed["message"])
        self.assertIn("建议", failed["message"])
        asset = triggers.TriggerPolicy("collab").decide(
            {"type": "asset_added", "payload": {"assets": [{"name": "白底图"}]}})
        self.assertEqual(asset["action"], "message")
        self.assertTrue(2 <= len(asset["suggestions"]) <= 3, asset["suggestions"])
        opened = triggers.TriggerPolicy("collab", has_unfinished_plan=True).decide(
            {"type": "canvas_opened", "payload": {"stage": "出图"}})
        self.assertEqual(opened["action"], "message")
        self.assertIn("上次停在「出图」", opened["message"])
        self.assertTrue(opened["suggestions"])

    def test_throttle_helper(self):
        now = 1_000_000.0
        self.assertFalse(triggers.is_throttled(None, now))
        self.assertTrue(triggers.is_throttled(now - 10, now))
        self.assertFalse(triggers.is_throttled(now - 301, now))


class EventsRouteTests(unittest.TestCase):
    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("triggers")
        main._AGENT_TRIGGER_LAST_MESSAGE.pop(self.canvas_id, None)
        self.addCleanup(main._AGENT_TRIGGER_LAST_MESSAGE.pop, self.canvas_id, None)
        self.addCleanup(lambda: main._agent_set_proactive_messages(self.canvas_id, True))

    def test_switch_off_returns_disabled_and_creates_no_message(self):
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_TRIGGERS": "0"}):
            result = post_event(self.canvas_id, "generation_failed",
                                {"reason": "超时"})
        self.assertFalse(result["ok"])
        self.assertFalse(result["enabled"])
        self.assertEqual(thread_messages(self.canvas_id), [])

    def test_generation_failed_sends_proactive_message_with_fix(self):
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_TRIGGERS": "1"}):
            result = post_event(self.canvas_id, "generation_failed",
                                {"reason": "模型返回 500", "title": "海报"})
        self.assertEqual(result["action"], "message")
        self.assertIn("失败", result["message"]["text"])
        self.assertIn("建议", result["message"]["text"])
        self.assertEqual(result["message"]["origin"], "agent")
        rows = thread_messages(self.canvas_id)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["origin"], "agent")
        self.assertIn("失败", rows[0]["text"])

    def test_asset_added_sends_two_or_three_suggestion_chips(self):
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_TRIGGERS": "1"}):
            result = post_event(self.canvas_id, "asset_added",
                                {"assets": [{"name": "白底产品图"}]})
        self.assertEqual(result["action"], "message")
        suggestions = result["message"]["suggestions"]
        self.assertTrue(2 <= len(suggestions) <= 3, suggestions)
        self.assertIn("白底产品图", suggestions[0])
        self.assertEqual(thread_messages(self.canvas_id)[0]["suggestions"], suggestions)

    def test_canvas_opened_with_unfinished_plan_reminds_where_it_stopped(self):
        set_unfinished_plan(self.canvas_id)
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_TRIGGERS": "1"}):
            result = post_event(self.canvas_id, "canvas_opened", {"stage": "出图"})
        self.assertEqual(result["action"], "message")
        self.assertIn("上次停在「出图」", result["message"]["text"])
        self.assertTrue(result["message"]["suggestions"])

    def test_generation_completed_collab_without_run_does_not_message(self):
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_TRIGGERS": "1"}):
            result = post_event(self.canvas_id, "generation_completed", {"node_id": "n1"})
        self.assertEqual(result["action"], "none")
        self.assertTrue(result["review"], "collab 仍按现状走审查")
        self.assertEqual(thread_messages(self.canvas_id), [])

    def test_throttle_swallows_second_message_within_five_minutes(self):
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_TRIGGERS": "1"}):
            first = post_event(self.canvas_id, "asset_added", {"name": "图 A"})
            second = post_event(self.canvas_id, "generation_failed", {"reason": "超时"})
        self.assertEqual(first["action"], "message")
        self.assertEqual(second["action"], "none")
        self.assertTrue(second.get("throttled"))
        self.assertEqual(len(thread_messages(self.canvas_id)), 1)

    def test_canvas_setting_off_sends_no_message(self):
        main._agent_set_proactive_messages(self.canvas_id, False)
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_TRIGGERS": "1"}):
            result = post_event(self.canvas_id, "asset_added", {"name": "图 A"})
        self.assertEqual(result["action"], "none")
        self.assertTrue(result.get("settings_off"))
        self.assertEqual(thread_messages(self.canvas_id), [])

    def test_auto_generation_completed_wakes_suspended_run(self):
        req, bus, pending = make_req(self.canvas_id, [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
            {"done": True, "message": "自动继续完成"}])
        req["autonomy"] = "auto"
        messages, pending, patches = run_with_patches(
            req, bus, pending,
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}],
            env_extra={"NOVAI_AGENT_V2_AUTONOMY": "1"})
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
            self.assertEqual(main._agent_run_state_read(req["run_id"])["status"],
                             "waiting_generation", "先挂起，等生成事件唤醒")
            with patch.dict(os.environ, {"NOVAI_AGENT_V2_TRIGGERS": "1"}):
                async def scenario():
                    payload = main.AgentEventRequest(
                        canvas_id=self.canvas_id, type="generation_completed",
                        payload={"node_id": "n1", "url": "/a.png"})
                    review = {"summary": "合格", "items": [
                        {"label": "图1", "node_id": "n1", "url": "/a.png", "kind": "image",
                         "ok": True, "issues": [], "revised_prompt": ""}]}
                    with patch.object(main, "require_canvas_access", new=lambda *a, **k: None), \
                            patch.object(main, "_agent_beat_review",
                                         new=AsyncMock(return_value=review)):
                        result = await main.agent_run_events(payload, fake_request())
                        resumed_bus = main._agent_run_bus_get(req["run_id"])
                        task = resumed_bus.get("task") if isinstance(resumed_bus, dict) else None
                        if task is not None and not task.done():
                            await task
                    return result
                result = asyncio.run(scenario())
            self.assertEqual(result["action"], "wake")
            self.assertTrue(result["resumed"], result)
            done = next(item["data"] for item in reversed(
                [{"event": e.get("name"), "data": e.get("data")} for e in (bus.get("events") or [])])
                if item["event"] == "done")
            self.assertEqual(done["message"], "自动继续完成")
            self.assertEqual(len(messages), 2, "唤醒后从挂起处继续")
        finally:
            stop_patches(patches)


if __name__ == "__main__":
    unittest.main()
