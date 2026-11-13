# -*- coding: utf-8 -*-
"""阶段四·1：三个自治档位 + 托管预算 + 旧 auto_execute 兼容（开关 NOVAI_AGENT_V2_AUTONOMY）。

验收：
- collab：阶段结束停下问用户（现状）；
- auto：审查合格不再问用户，自动进下一阶段；
- managed：授权预算内直接生成；超预算发 budget_required 且不再生成；
- 旧 auto_execute=true 仍被识别为 auto；
- 开关关闭时三档都退回 collab 现状（不发新事件、不自动推进）。
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-autonomy-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from tests.test_agent_reflect import new_canvas  # noqa: E402


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def chat_config():
    return {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
            "model": "autonomy-model", "provider_cfg": {"protocol": "custom"}, "think_level": ""}


def review_pass():
    return {"summary": "合格", "items": [
        {"label": "海报", "node_id": "n1", "url": "/a.png", "kind": "image", "ok": True,
         "issues": [], "revised_prompt": ""}]}


def run_autonomy_producer(canvas_id, decisions, execute, autonomy="collab", budget=None,
                          grant=None, review=None, wait_outcomes=None, roadmap=None,
                          auto_execute=False, extra_env=None):
    messages_seen = []
    pending = list(decisions)

    async def fake_decide(chat, messages, cid, tools_json_text="", tools=None, rebuild_json=None):
        messages_seen.append([dict(message) for message in messages])
        return pending.pop(0) if pending else {"done": True, "message": "完成"}

    async def fake_wait(self, node_ids, emit, cancelled, deadline=None):
        return [dict(item) for item in (wait_outcomes or [])]

    async def fake_review(chat, instruction, roadmap_arg, items):
        return review

    req = {"canvas_id": canvas_id, "run_id": "run_auto_" + uuid.uuid4().hex[:8],
           "instruction": "做一张海报", "focus": main._agent_run_normalize_focus(None),
           "history": [], "thread_id": "", "chat": chat_config(), "max_steps": 0,
           "mode": "run", "approved_steps": [], "renderer": "beat", "use_thread": False,
           "enforce_write_confirmation": True, "autonomy": autonomy,
           "auto_execute": bool(auto_execute),
           "budget": main._agent_run_budget_limits(budget or {}),
           "roadmap": roadmap or []}
    bus = main._agent_run_bus_new(req["run_id"], canvas_id)
    bus["autonomy"] = autonomy
    if grant is not None:
        bus["budget_grant"] = grant
    bus["request"] = req

    async def go():
        await main._agent_run_producer(req, None, bus=bus)

    env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2")}
    env.update({"NOVAI_AGENT_V2_CONTEXT": "1", "NOVAI_AGENT_V2_AUTONOMY": "1"})
    env.update(extra_env or {})
    with patch.dict(os.environ, env, clear=True), \
            patch.object(main, "_agent_run_decide_v2", new=fake_decide), \
            patch.object(main, "agent_execute_step", new=execute), \
            patch.object(main._CanvasRunContext, "wait_canvas_results", new=fake_wait), \
            patch.object(main._CanvasRunContext, "confirmation_needed",
                         new=lambda self, steps, confirmed=False: {"needed": False, "tools": []}), \
            patch.object(main, "_agent_beat_review", new=fake_review), \
            patch.object(main, "_agent_v2_memory_schedule", new=lambda *a, **k: None):
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(go())
    events = [{"event": item.get("name"), "data": item.get("data")}
              for item in (bus.get("events") or [])]
    done = next((item["data"] for item in reversed(events) if item["event"] == "done"), {})
    return {"bus": bus, "events": events, "messages": messages_seen, "done": done}


async def executed_done(tool, args):
    return {"ok": True, "tool": tool, "message": "生成成功",
            "result": {"status": "done", "node_id": "n1", "kind": "image", "url": "/a.png"}}


async def executed_ready(tool, args):  # noqa: F811
    return {"ok": True, "tool": tool, "message": "已建节点",
            "result": {"status": "queued_on_canvas", "node_id": "n1", "kind": "image"}}


class AutonomyRequestTests(unittest.TestCase):
    def test_flag_off_always_collab(self):
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_AUTONOMY": "0"}):
            for req in ({"autonomy": "managed"}, {"autonomy": "auto"},
                        {"auto_execute": True}):
                self.assertEqual(main._agent_run_autonomy(req), "collab")

    def test_flag_on_resolves_tiers_and_legacy_field(self):
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_AUTONOMY": "1"}):
            self.assertEqual(main._agent_run_autonomy({"autonomy": "managed"}), "managed")
            self.assertEqual(main._agent_run_autonomy({"autonomy": "auto"}), "auto")
            self.assertEqual(main._agent_run_autonomy({"autonomy": "collab"}), "collab")
            self.assertEqual(main._agent_run_autonomy({"auto_execute": True}), "auto")
            self.assertEqual(main._agent_run_autonomy({}), "collab")
            self.assertEqual(main._agent_run_autonomy({"autonomy": "weird"}), "collab")

    def test_request_model_accepts_autonomy_and_budget(self):
        payload = main.AgentRunRequest(canvas_id="c1", instruction="做海报",
                                       autonomy="managed", budget={"image": 3, "video": 1,
                                                                   "audio": 0, "bad": 9})
        self.assertEqual(payload.autonomy, "managed")
        self.assertEqual(payload.budget, {"image": 3, "video": 1, "audio": 0},
                         "显式 0 是明确上限，不能被吞掉")
        self.assertEqual(main.AgentRunRequest(canvas_id="c1", instruction="x").autonomy, "collab")

    def test_flag_off_producer_ignores_managed_tier(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        canvas_id = new_canvas("auto-off")
        out = run_autonomy_producer(
            canvas_id,
            [{"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": canvas_id, "prompt": "海报", "count": 2}}]},
             {"done": True, "message": "好了"}],
            executed_done, autonomy="managed", grant={"image": {"max": 5}},
            extra_env={"NOVAI_AGENT_V2_AUTONOMY": "0"})
        self.assertFalse([item for item in out["events"] if item["event"] == "budget_required"])
        self.assertEqual(len(out["messages"]), 2, "开关关闭时 managed 也按现状跑（不自动推进、不扣预算）")
        self.assertFalse([item for item in out["events"]
                          if item["event"] == "thought" and item["data"].get("kind") == "autonomy"])


class BudgetRouteTests(unittest.TestCase):
    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("budget-route")
        self.run_id = "run_budget_" + uuid.uuid4().hex[:8]
        self.bus = main._agent_run_bus_new(self.run_id, self.canvas_id)
        self.bus["autonomy"] = "managed"

    def tearDown(self):
        path = main._agent_run_state_path(self.run_id)
        if os.path.exists(path):
            os.remove(path)

    def test_route_persists_grant_and_state(self):
        payload = main.AgentRunBudgetRequest(
            image=main.AgentBudgetChoice(provider="p", model="m", max=3),
            video=main.AgentBudgetChoice(provider="p", model="v", max=1))
        with patch.object(main, "_agent_require_run_access", new=lambda *a, **k: None):
            result = asyncio.run(main.agent_run_budget(self.run_id, payload, None))
        self.assertTrue(result["ok"])
        self.assertEqual(self.bus["budget_grant"],
                         {"image": {"provider": "p", "model": "m", "max": 3},
                          "video": {"provider": "p", "model": "v", "max": 1}})
        state = main._agent_run_state_read(self.run_id)
        self.assertEqual(state.get("budget"), self.bus["budget_grant"])
        self.assertEqual(state.get("run_id"), self.run_id)

    def test_route_rejects_finished_run(self):
        self.bus["done"] = True
        payload = main.AgentRunBudgetRequest(image=main.AgentBudgetChoice(max=1))
        with patch.object(main, "_agent_require_run_access", new=lambda *a, **k: None):
            response = asyncio.run(main.agent_run_budget(self.run_id, payload, None))
        self.assertEqual(response.status_code, 409)


class CollabStageEndTests(unittest.TestCase):
    """collab：审查完停下问用户（现状）。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("collab-stop")

    def test_collab_stops_after_review_and_asks_user(self):
        out = run_autonomy_producer(
            self.canvas_id,
            [{"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
             {"done": True, "message": "好了"}],
            executed_ready, autonomy="collab",
            review=review_pass(),
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}])
        self.assertEqual(len(out["messages"]), 1, "collab 出结果就停，不该继续下一轮")
        self.assertIn("审查在后台", out["done"].get("message") or "")
        self.assertTrue([item for item in out["events"] if item["event"] == "review"])
        self.assertFalse([item for item in out["events"]
                          if item["event"] == "thought" and item["data"].get("kind") == "autonomy"])


class AutoAdvanceTests(unittest.TestCase):
    """auto：结果合格不再问用户，自动进下一阶段。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("auto-advance")
        self.roadmap = [{"stage": "第一张", "generations": 1, "acceptance": "第一张出图"},
                        {"stage": "第二张", "generations": 1, "acceptance": "第二张出图"}]

    def test_auto_advances_after_passed_review(self):
        out = run_autonomy_producer(
            self.canvas_id,
            [{"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "第一张"}}]},
             {"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "第二张"}}]},
             {"done": True, "message": "两个阶段都完成"}],
            executed_ready, autonomy="auto", review=review_pass(),
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}],
            roadmap=self.roadmap)
        self.assertEqual(len(out["messages"]), 3, "auto 合格后要继续下一轮，而不是停下")
        autonomy_thoughts = [item for item in out["events"]
                             if item["event"] == "thought" and item["data"].get("kind") == "autonomy"]
        self.assertTrue(autonomy_thoughts, "自动推进要发 thought(kind=autonomy) 给面板")
        self.assertEqual(out["done"].get("status"), "ok")
        self.assertEqual(out["done"].get("message"), "两个阶段都完成")
        self.assertNotIn("满意", out["done"].get("message") or "")

    def test_auto_stage_end_done_advances_with_roadmap(self):
        out = run_autonomy_producer(
            self.canvas_id,
            [{"roadmap": self.roadmap,
              "steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "第一张"}}]},
             {"done": True, "message": "第一阶段好了"},
             {"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "第二张"}}]},
             {"done": True, "message": "两个阶段都完成"}],
            executed_ready, autonomy="auto", review=review_pass(),
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}],
            roadmap=self.roadmap)
        self.assertGreaterEqual(len(out["messages"]), 4, "done 时还有后续阶段要自动继续")
        self.assertEqual(out["done"].get("message"), "两个阶段都完成")


class ManagedBudgetTests(unittest.TestCase):
    """managed：授权预算内直接生成；超预算发 budget_required 且不生成。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("managed")

    def test_within_budget_generates_directly(self):
        out = run_autonomy_producer(
            self.canvas_id,
            [{"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "海报", "count": 2}}]},
             {"done": True, "message": "完成"}],
            executed_done, autonomy="managed", grant={"image": {"provider": "p", "model": "m",
                                                                "max": 2}},
            extra_env={"NOVAI_AGENT_V2_AUTONOMY": "1"})
        self.assertFalse([item for item in out["events"] if item["event"] == "budget_required"])
        self.assertEqual(out["done"].get("status"), "ok")
        self.assertEqual(out["done"].get("message"), "完成")
        step_results = [item for item in out["events"] if item["event"] == "step_result"]
        self.assertTrue(step_results, "托管档预算内要直接执行生成，不能停在待生成卡")

    def test_zero_budget_keeps_zero_and_requires_budget(self):
        out = run_autonomy_producer(
            self.canvas_id,
            [{"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
             {"done": True, "message": "不该走到这里"}],
            executed_done, autonomy="managed", budget={"image": 0}, grant={},
            extra_env={"NOVAI_AGENT_V2_RUNSTATE": "1"})
        state = main._agent_run_state_read(out["bus"]["run_id"])
        self.assertEqual(state.get("budget"), {"image": 0}, "显式 0 必须原样落在状态文件里")
        required = [item["data"] for item in out["events"] if item["event"] == "budget_required"]
        self.assertEqual(len(required), 1, required)
        self.assertGreaterEqual(required[0]["needs"]["image"], 1, "0 上限下第一次生成就要授权")
        self.assertFalse([item for item in out["events"] if item["event"] == "step_result"],
                         "0 上限下不能生成")
        state = main._agent_run_state_read(out["bus"]["run_id"])
        self.assertEqual(state.get("status"), "waiting_budget", "超预算要挂起等补额度，不能结束 run")
        self.assertFalse([item for item in out["events"] if item["event"] == "done"])

    def test_over_budget_emits_budget_required_and_generates_nothing(self):
        out = run_autonomy_producer(
            self.canvas_id,
            [{"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "海报", "count": 2}}]},
             {"done": True, "message": "不该走到这里"}],
            executed_done, autonomy="managed", grant={"image": {"provider": "p", "model": "m",
                                                                "max": 1}})
        required = [item["data"] for item in out["events"] if item["event"] == "budget_required"]
        self.assertEqual(len(required), 1, required)
        self.assertEqual(set(required[0]["needs"]), {"image", "video", "audio"})
        self.assertGreaterEqual(required[0]["needs"]["image"], 2)
        self.assertFalse([item for item in out["events"] if item["event"] == "step_result"],
                         "超预算不能偷偷生成")
        state = main._agent_run_state_read(out["bus"]["run_id"])
        self.assertEqual(state.get("status"), "waiting_budget", "超预算要挂起等补额度，不能结束 run")
        self.assertFalse([item for item in out["events"] if item["event"] == "done"],
                         "挂起时不能发 done")

    def test_legacy_auto_execute_behaves_like_auto(self):
        out = run_autonomy_producer(
            self.canvas_id,
            [{"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
             {"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": self.canvas_id, "prompt": "再来一张"}}]},
             {"done": True, "message": "都好了"}],
            executed_ready, autonomy="", auto_execute=True, review=review_pass(),
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}],
            roadmap=[{"stage": "一", "generations": 1}, {"stage": "二", "generations": 1}])
        # 旧 auto_execute=True：没写 autonomy 时按 auto 处理——审查合格自动推进，不再停下问用户
        self.assertGreaterEqual(len(out["messages"]), 3, "旧字段也要触发自动推进")
        self.assertNotIn("满意", out["done"].get("message") or "")
        self.assertTrue([item for item in out["events"]
                         if item["event"] == "thought" and item["data"].get("kind") == "autonomy"])


class SwitchOffTests(unittest.TestCase):
    def test_flag_off_has_no_new_events_and_no_advance(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        canvas_id = new_canvas("off")
        out = run_autonomy_producer(
            canvas_id,
            [{"steps": [{"tool": "generate_image",
                         "args": {"canvas_id": canvas_id, "prompt": "海报"}}]},
             {"done": True, "message": "好了"}],
            executed_ready, autonomy="auto", review=review_pass(),
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}],
            roadmap=[{"stage": "一", "generations": 1}, {"stage": "二", "generations": 1}],
            extra_env={"NOVAI_AGENT_V2_AUTONOMY": "0"})
        self.assertFalse([item for item in out["events"] if item["event"] == "budget_required"])
        self.assertFalse([item for item in out["events"]
                          if item["event"] == "thought" and item["data"].get("kind") == "autonomy"])
        self.assertEqual(len(out["messages"]), 1, "开关关闭时按现状停下问用户")


if __name__ == "__main__":
    unittest.main()
