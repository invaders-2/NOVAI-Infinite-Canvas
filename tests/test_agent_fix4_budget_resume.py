# -*- coding: utf-8 -*-
"""托管额度用完挂起 + POST /budget 补额度恢复（含唤醒后首轮决策能正常解析）。"""
import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-budget-resume-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import run_state  # noqa: E402
from tests.test_agent_reflect import new_canvas  # noqa: E402
from tests.test_agent_run_state import make_req, run_with_patches, stop_patches  # noqa: E402


def review_ok():
    return {"summary": "合格", "items": [
        {"label": "图1", "node_id": "n1", "url": "/output/a.png", "kind": "image",
         "ok": True, "issues": [], "revised_prompt": ""}]}


async def executed_ok(tool, args):
    return {"ok": True, "tool": tool, "message": "生成成功",
            "result": {"status": "done", "node_id": "n1", "kind": "image", "url": "/a.png"}}


async def executed_queued(tool, args):
    return {"ok": True, "tool": tool, "message": "已建节点",
            "result": {"status": "queued_on_canvas", "node_id": "n1", "kind": "image"}}


def events_of(bus):
    return [{"event": item.get("name"), "data": item.get("data")} for item in (bus.get("events") or [])]


def done_of(bus):
    for item in reversed(events_of(bus)):
        if item["event"] == "done":
            return item["data"]
    return None


class BudgetSuspendResumeTests(unittest.TestCase):
    def setUp(self):
        if not main.DATA_DIR.startswith("/tmp") and "/private/tmp" not in str(main.DATA_DIR):
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("budget-resume")

    def _suspend(self, decisions, grant=None):
        req, bus, pending = make_req(self.canvas_id, decisions)
        req.update({"autonomy": "managed", "budget": {"image": 1}})
        bus["autonomy"] = "managed"
        bus["budget_grant"] = grant or {"image": {"provider": "p", "model": "m", "max": 1}}
        messages, pending, patches = run_with_patches(
            req, bus, pending, wait_outcomes=[],
            env_extra={"NOVAI_AGENT_V2_AUTONOMY": "1",
                       "NOVAI_AGENT_V2_RUNSTATE": "1"},
            patches_extra=[patch.object(main, "agent_execute_step", new=executed_ok)])
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(main._agent_run_producer(req, None, bus=bus))
        return req, bus, messages, patches

    def test_over_budget_suspends_instead_of_finishing(self):
        decisions = [{"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "第1张"}}]},
                     {"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "第2张"}}]},
                     {"done": True, "message": "完成"}]
        req, bus, messages, patches = self._suspend(decisions)
        try:
            state = main._agent_run_state_read(req["run_id"])
            self.assertEqual(state.get("status"), run_state.STATUS_WAITING_BUDGET)
            self.assertTrue(bus.get("suspended"))
            self.assertIsNone(done_of(bus), "超预算要挂起，不能结束 run")
            self.assertTrue([item for item in events_of(bus) if item["event"] == "budget_required"])
            suspended = [item["data"] for item in events_of(bus)
                         if item["event"] == "run_suspended" and item["data"].get("reason") == "budget"]
            self.assertTrue(suspended, "要发 run_suspended(reason=budget) 新状态事件")
            self.assertGreaterEqual(suspended[0]["needs"]["image"], 1)
        finally:
            stop_patches(patches)

    def test_budget_post_resumes_and_executes_second_generation(self):
        decisions = [{"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "第1张"}}]},
                     {"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "第2张"}}]},
                     {"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "第2张重试"}}]},
                     {"done": True, "message": "两张都完成"}]
        req, bus, messages, patches = self._suspend(decisions)
        try:
            payload = main.AgentRunBudgetRequest(
                image=main.AgentBudgetChoice(provider="p", model="m", max=3))

            async def scenario():
                with patch.object(main, "_agent_require_run_access", new=lambda *a, **k: None):
                    result = await main.agent_run_budget(req["run_id"], payload, None)
                resumed_bus = main._agent_run_bus_get(req["run_id"])
                task = resumed_bus.get("task") if isinstance(resumed_bus, dict) else None
                if task is not None and not task.done():
                    await task
                return result, resumed_bus

            result, resumed_bus = asyncio.run(scenario())
            self.assertTrue(result["ok"])
            self.assertTrue(result["resumed"], result)
            self.assertEqual(result["budget"]["image"]["max"], 3)
            step_results = [item for item in events_of(resumed_bus) if item["event"] == "step_result"]
            self.assertGreaterEqual(len(step_results), 2, "补额度后要真的执行第 2 次生成")
            done = done_of(resumed_bus)
            self.assertEqual(done.get("message"), "两张都完成")
            self.assertEqual(done.get("status"), "ok")
            self.assertEqual(main._agent_run_state_read(req["run_id"]).get("status"),
                             run_state.STATUS_FINISHED)
        finally:
            stop_patches(patches)

    def test_without_budget_post_stays_waiting(self):
        decisions = [{"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "第1张"}}]},
                     {"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "第2张"}}]}]
        req, bus, messages, patches = self._suspend(decisions)
        try:
            self.assertEqual(main._agent_run_state_read(req["run_id"]).get("status"),
                             run_state.STATUS_WAITING_BUDGET)
            self.assertIsNone(done_of(bus))
            self.assertTrue(bus.get("suspended"), "不补额度时 run 保持挂起，不自动结束")
        finally:
            stop_patches(patches)


class UsedAcrossSuspendTests(unittest.TestCase):
    """预算 used 要跨挂起→唤醒保留：第一次生成后挂起，唤醒后第二次必须先触发 budget_required。"""

    def setUp(self):
        if not main.DATA_DIR.startswith("/tmp") and "/private/tmp" not in str(main.DATA_DIR):
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("budget-cross-suspend")

    def _run_first_round_suspend(self, decisions):
        req, bus, pending = make_req(self.canvas_id, decisions)
        req.update({"autonomy": "managed", "budget": {"image": 1}})
        bus["autonomy"] = "managed"
        bus["budget_grant"] = {"image": {"provider": "p", "model": "m", "max": 1}}
        calls = {"execute": 0}

        async def execute(tool, args):
            calls["execute"] += 1
            if calls["execute"] == 1:
                return await executed_queued(tool, args)   # 第 1 张：进画布排队 → waiting_generation
            return await executed_ok(tool, args)

        messages, pending, patches = run_with_patches(
            req, bus, pending,
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}],
            env_extra={"NOVAI_AGENT_V2_AUTONOMY": "1", "NOVAI_AGENT_V2_RUNSTATE": "1"},
            patches_extra=[patch.object(main, "agent_execute_step", new=execute),
                          patch.object(main, "_agent_beat_review", new=AsyncMock(return_value=review_ok()))])
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(main._agent_run_producer(req, None, bus=bus))
        return req, bus, pending, calls, patches

    def _resume_and_wait(self, run_id, event):
        async def scenario():
            result = await main._agent_run_resume(run_id, event)
            bus = main._agent_run_bus_get(run_id)
            task = bus.get("task") if isinstance(bus, dict) else None
            if task is not None and not task.done():
                await task
            return result
        return asyncio.run(scenario())

    def test_wake_then_second_generation_triggers_budget_required(self):
        decisions = [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "第1张"}}]},
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "第2张"}}]},
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "第2张"}}]},
            {"done": True, "message": "两张都完成"},
        ]
        req, bus, pending, calls, patches = self._run_first_round_suspend(decisions)
        try:
            state = main._agent_run_state_read(req["run_id"])
            self.assertEqual(state.get("status"), run_state.STATUS_WAITING_GENERATION)
            self.assertEqual(state.get("used_by_modality", {}).get("image"), 1,
                             "第一次生成的 used 要写进状态")
            self.assertEqual(calls["execute"], 1)

            # 生成完成事件唤醒（模拟 /api/agent/events → _agent_run_resume）
            result = self._resume_and_wait(req["run_id"], {"node_ids": ["n1"]})
            self.assertTrue(result["ok"], result)
            state = main._agent_run_state_read(req["run_id"])
            self.assertEqual(state.get("status"), run_state.STATUS_WAITING_BUDGET,
                             "唤醒后第 2 次生成必须先触发 budget_required + waiting_budget")
            self.assertEqual(state.get("used_by_modality", {}).get("image"), 1,
                             "唤醒后 used 不能从 0 重算")
            self.assertEqual(calls["execute"], 1, "超预算的第二次生成不能直接执行")
            self.assertTrue([item for item in events_of(bus)
                             if item["event"] == "budget_required" and
                             item["data"].get("needs", {}).get("image", 0) >= 1])
            self.assertIsNone(done_of(bus))

            # 补额度 → 恢复并真的执行第 2 次生成
            payload = main.AgentRunBudgetRequest(
                image=main.AgentBudgetChoice(provider="p", model="m", max=2))

            async def scenario():
                with patch.object(main, "_agent_require_run_access", new=lambda *a, **k: None):
                    result = await main.agent_run_budget(req["run_id"], payload, None)
                resumed_bus = main._agent_run_bus_get(req["run_id"])
                task = resumed_bus.get("task") if isinstance(resumed_bus, dict) else None
                if task is not None and not task.done():
                    await task
                return result, resumed_bus

            budget_result, resumed_bus = asyncio.run(scenario())
            self.assertTrue(budget_result["resumed"], budget_result)
            step_results = [item for item in events_of(resumed_bus) if item["event"] == "step_result"]
            self.assertGreaterEqual(len(step_results), 2, "补额度后要真的执行第 2 次生成")
            self.assertGreaterEqual(calls["execute"], 2)
            self.assertEqual(done_of(resumed_bus).get("message"), "两张都完成")
        finally:
            stop_patches(patches)

    def test_after_wake_without_budget_keeps_waiting_budget(self):
        decisions = [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "第1张"}}]},
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "第2张"}}]},
        ]
        req, bus, pending, calls, patches = self._run_first_round_suspend(decisions)
        try:
            result = self._resume_and_wait(req["run_id"], {"node_ids": ["n1"]})
            self.assertTrue(result["ok"], result)
            state = main._agent_run_state_read(req["run_id"])
            self.assertEqual(state.get("status"), run_state.STATUS_WAITING_BUDGET)
            self.assertEqual(calls["execute"], 1)
            self.assertIsNone(done_of(bus))
            self.assertTrue(bus.get("suspended"))
        finally:
            stop_patches(patches)


class ManagedFinishTests(unittest.TestCase):
    """托管生成完成后不能卡在 running：慢审查在后台跑，状态要先 finished。"""

    def setUp(self):
        if not main.DATA_DIR.startswith("/tmp") and "/private/tmp" not in str(main.DATA_DIR):
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("managed-finish")

    def _add_finished_node(self, node_id="n1", url="/output/a.png"):
        def mutate(canvas):
            canvas.setdefault("nodes", []).append({
                "id": node_id, "kind": "image", "x": 400, "y": 0,
                "data": {"gen": {"title": "图1", "prompt": "海报", "hist": [{"url": url}], "hi": 0}}})
            return None
        main._agent_mutate_canvas(self.canvas_id, mutate)

    def test_managed_finishes_while_review_still_pending(self):
        decisions = [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
            {"done": True, "message": "完成"},
        ]
        req, bus, pending = make_req(self.canvas_id, decisions)
        req.update({"autonomy": "managed", "budget": {"image": 1}})
        messages, pending, patches = run_with_patches(
            req, bus, pending, wait_outcomes=[],
            env_extra={"NOVAI_AGENT_V2_AUTONOMY": "1", "NOVAI_AGENT_V2_RUNSTATE": "1"},
            patches_extra=[patch.object(main, "agent_execute_step", new=executed_queued)])
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
            self._add_finished_node("n1")

            async def slow_review(*args):
                await asyncio.sleep(3)
                return review_ok()

            async def scenario():
                with patch.object(main, "_agent_beat_review", new=slow_review):
                    result = await main._agent_run_resume(req["run_id"], {"node_ids": ["n1"]})
                    resumed_bus = main._agent_run_bus_get(req["run_id"])
                    task = resumed_bus.get("task") if isinstance(resumed_bus, dict) else None
                    await asyncio.sleep(0.3)
                    state_while_review = main._agent_run_state_read(req["run_id"])
                    if task is not None and not task.done():
                        await asyncio.wait_for(task, timeout=8)
                return result, resumed_bus, state_while_review

            result, resumed_bus, state = asyncio.run(scenario())
            self.assertTrue(result["ok"], result)
            self.assertEqual(state.get("status"), run_state.STATUS_FINISHED,
                             "慢审查不能把 run 卡在 running")
            self.assertIsNotNone(done_of(resumed_bus))
            self.assertNotEqual(state.get("status"), run_state.STATUS_RUNNING)
        finally:
            stop_patches(patches)


class ResumeConsumeCompletedTests(unittest.TestCase):
    """唤醒事件里的节点其实已经有结果：resume 要直接消费，不能对着它继续挂起。"""

    def setUp(self):
        if not main.DATA_DIR.startswith("/tmp") and "/private/tmp" not in str(main.DATA_DIR):
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("resume-consume")

    def _add_finished_node(self, node_id="n1", url="/output/a.png"):
        def mutate(canvas):
            canvas.setdefault("nodes", []).append({
                "id": node_id, "kind": "image", "x": 400, "y": 0,
                "data": {"gen": {"title": "图1", "prompt": "海报", "hist": [{"url": url}], "hi": 0}}})
            return None
        main._agent_mutate_canvas(self.canvas_id, mutate)

    def test_resume_consumes_completed_node_and_finishes(self):
        decisions = [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
            {"done": True, "message": "已经完成"},
        ]
        req, bus, pending = make_req(self.canvas_id, decisions)
        messages, pending, patches = run_with_patches(
            req, bus, pending, wait_outcomes=[],
            env_extra={"NOVAI_AGENT_V2_RUNSTATE": "1"},
            patches_extra=[patch.object(main, "agent_execute_step", new=executed_queued)])
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
            state = main._agent_run_state_read(req["run_id"])
            self.assertEqual(state.get("status"), run_state.STATUS_WAITING_GENERATION)
            self.assertEqual(state.get("waiting_on"), ["n1"])

            # 事件到达前节点其实已经出结果了
            self._add_finished_node("n1")
            wait_calls = []

            async def fake_wait(self, node_ids, emit, cancelled, deadline=None):
                wait_calls.append(list(node_ids))
                return []

            async def scenario():
                with patch.object(main._CanvasRunContext, "wait_canvas_results", new=fake_wait):
                    result = await main._agent_run_resume(req["run_id"], {"node_ids": ["n1"]})
                    resumed_bus = main._agent_run_bus_get(req["run_id"])
                    task = resumed_bus.get("task") if isinstance(resumed_bus, dict) else None
                    if task is not None and not task.done():
                        await task
                return result, resumed_bus

            result, resumed_bus = asyncio.run(scenario())
            self.assertTrue(result["ok"], result)
            self.assertEqual(wait_calls, [], "已经出结果的节点不能再去 wait_canvas_results 挂起")
            state = main._agent_run_state_read(req["run_id"])
            self.assertEqual(state.get("status"), run_state.STATUS_WAITING_USER,
                             "协作档唤醒消费完结果、审查完要停下问用户（不能停在 waiting_generation）")
            self.assertEqual(state.get("waiting_on"), [])
            done = done_of(resumed_bus)
            self.assertIsNotNone(done)
            self.assertEqual(done.get("status"), "ok")
            # 本用例 harness 的审查桩返回 None：协作档仍会停下问用户；审查本身由下面专项用例覆盖
        finally:
            stop_patches(patches)

    def test_resume_review_runs_and_writes_history(self):
        decisions = [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
            {"done": True, "message": "完成"},
        ]
        req, bus, pending = make_req(self.canvas_id, decisions)
        messages, pending, patches = run_with_patches(
            req, bus, pending, wait_outcomes=[],
            env_extra={"NOVAI_AGENT_V2_RUNSTATE": "1"},
            patches_extra=[patch.object(main, "agent_execute_step", new=executed_queued)])
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
            self._add_finished_node("n1")
            review = {"summary": "合格", "items": [
                {"label": "图1", "node_id": "n1", "url": "/output/a.png", "kind": "image",
                 "ok": True, "issues": [], "revised_prompt": ""}]}
            review_mock = AsyncMock(return_value=review)

            async def scenario():
                with patch.object(main, "_agent_beat_review", new=review_mock):
                    result = await main._agent_run_resume(req["run_id"], {"node_ids": ["n1"]})
                    resumed_bus = main._agent_run_bus_get(req["run_id"])
                    task = resumed_bus.get("task") if isinstance(resumed_bus, dict) else None
                    if task is not None and not task.done():
                        await task
                return result, resumed_bus

            result, resumed_bus = asyncio.run(scenario())
            self.assertTrue(result["ok"], result)
            self.assertEqual(review_mock.await_count, 1, "唤醒消费完结果后要调用一次 BEAT 审查")
            reviewed = review_mock.await_args.args[3]
            self.assertEqual([item["node_id"] for item in reviewed], ["n1"])
            self.assertTrue([item for item in events_of(resumed_bus) if item["event"] == "review"])
            names = [item["event"] for item in events_of(resumed_bus)]
            self.assertLess(names.index("done"), names.index("review"),
                            "done 必须先于 review：审查不能挡回复")
            transcript = resumed_bus.get("transcript")
            notes = [entry for entry in (transcript.entries if transcript else [])
                     if entry.get("type") == "note" and entry.get("kind") == "review"]
            self.assertTrue(notes, "审查结论要写进转录")
            self.assertIn("审查合格", notes[-1]["text"])
        finally:
            stop_patches(patches)

    def test_resume_without_reviewable_result_skips_review(self):
        decisions = [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
            {"done": True, "message": "完成"},
        ]
        req, bus, pending = make_req(self.canvas_id, decisions)
        messages, pending, patches = run_with_patches(
            req, bus, pending, wait_outcomes=[],
            env_extra={"NOVAI_AGENT_V2_RUNSTATE": "1"},
            patches_extra=[patch.object(main, "agent_execute_step", new=executed_queued)])
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
            review_mock = AsyncMock(return_value=None)

            async def scenario():
                with patch.object(main, "_agent_beat_review", new=review_mock):
                    result = await main._agent_run_resume(req["run_id"], {"node_ids": ["n1"]})
                    resumed_bus = main._agent_run_bus_get(req["run_id"])
                    task = resumed_bus.get("task") if isinstance(resumed_bus, dict) else None
                    if task is not None and not task.done():
                        await task
                return result, resumed_bus

            result, resumed_bus = asyncio.run(scenario())
            self.assertTrue(result["ok"], result)
            self.assertEqual(review_mock.await_count, 0, "没有可审结果时不该调用审查")
            self.assertFalse([item for item in events_of(resumed_bus) if item["event"] == "review"])
            self.assertEqual(main._agent_run_state_read(req["run_id"]).get("status"),
                             run_state.STATUS_FINISHED)
        finally:
            stop_patches(patches)

    def test_second_wake_after_resume_does_not_wait_again(self):
        decisions = [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
            {"done": True, "message": "完成"},
        ]
        req, bus, pending = make_req(self.canvas_id, decisions)
        messages, pending, patches = run_with_patches(
            req, bus, pending, wait_outcomes=[],
            env_extra={"NOVAI_AGENT_V2_RUNSTATE": "1"},
            patches_extra=[patch.object(main, "agent_execute_step", new=executed_queued)])
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
            self._add_finished_node("n1")

            async def scenario():
                first = await main._agent_run_resume(req["run_id"], {"node_ids": ["n1"]})
                second = await main._agent_run_resume(req["run_id"], {"node_ids": ["n1"]})
                resumed_bus = main._agent_run_bus_get(req["run_id"])
                task = resumed_bus.get("task") if isinstance(resumed_bus, dict) else None
                if task is not None and not task.done():
                    await task
                return first, second, resumed_bus

            first, second, resumed_bus = asyncio.run(scenario())
            self.assertTrue(first["ok"], first)
            self.assertFalse(second["ok"], "已经恢复/结束的 run，第二次唤醒不能再等同一个节点")
            self.assertEqual(second.get("reason"), "not_suspended")
            events = events_of(resumed_bus)
            self.assertEqual(len([item for item in events if item["event"] == "done"]), 1,
                             "两次唤醒也只能收尾一次")
        finally:
            stop_patches(patches)


class ResumeDecisionParseTests(unittest.TestCase):
    """挂起 → 唤醒后第一轮决策用真实 decide 路径解析（打桩模型返回合法 JSON）。"""

    def test_first_decision_after_resume_parses_legal_json(self):
        canvas_id = new_canvas("resume-parse")
        req, bus, pending = make_req(canvas_id, [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": canvas_id, "prompt": "海报"}}]}])
        req["autonomy"] = "auto"      # 审查合格后继续决策（协作档会停下问用户）
        real_decide = main._agent_run_decide_v2
        calls = []

        async def decide(chat, messages, cid, tools_json_text="", tools=None, rebuild_json=None):
            calls.append([dict(m) for m in messages])
            if len(calls) == 1:
                return {"steps": [{"tool": "generate_image",
                                   "args": {"canvas_id": canvas_id, "prompt": "海报"}}]}
            return await real_decide(chat, messages, cid, tools_json_text, tools)

        async def fake_chat(chat, messages):
            return json.dumps({"thought": "唤醒后继续", "done": True, "message": "恢复完成"},
                              ensure_ascii=False)

        async def fake_raw(chat, messages, tools=None):
            # 原生工具 / 原始 JSON 分支（2026-11 起默认可能走这里）返回同一份决策
            return {"choices": [{"message": {"role": "assistant", "content": json.dumps(
                {"thought": "唤醒后继续", "done": True, "message": "恢复完成"}, ensure_ascii=False)}}]}

        messages, pending, patches = run_with_patches(
            req, bus, pending,
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}],
            env_extra={"NOVAI_AGENT_V2_AUTONOMY": "1"},
            patches_extra=[patch.object(main, "_agent_run_decide_v2", new=decide),
                           patch.object(main, "_agent_run_chat", new=fake_chat)])
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
            self.assertEqual(main._agent_run_state_read(req["run_id"]).get("status"),
                             run_state.STATUS_WAITING_GENERATION)

            async def scenario():
                with patch.object(main, "_agent_beat_review", new=AsyncMock(return_value=review_ok())), \
                        patch.object(main, "_agent_run_chat_raw", new=fake_raw):
                    result = await main._agent_run_resume(req["run_id"], {"node_ids": ["n1"]})
                    resumed_bus = main._agent_run_bus_get(req["run_id"])
                    task = resumed_bus.get("task") if isinstance(resumed_bus, dict) else None
                    if task is not None and not task.done():
                        await task
                return result, resumed_bus

            result, resumed_bus = asyncio.run(scenario())
            self.assertTrue(result["ok"], result)
            done = done_of(resumed_bus)
            self.assertIsNotNone(done)
            self.assertEqual(done.get("message"), "恢复完成", "唤醒后第一轮合法 JSON 要能正常解析")
            self.assertNotIn("解析失败", done.get("message") or "")
            self.assertGreaterEqual(len(calls), 2)
            resumed_messages = calls[1]
            self.assertEqual(resumed_messages[0].get("role"), "system")
            flat = "\n".join(str(m.get("content") or "") for m in resumed_messages)
            self.assertIn("当前环境状态", flat, "恢复后第一轮不能缺环境状态段")
        finally:
            stop_patches(patches)


if __name__ == "__main__":
    unittest.main()
