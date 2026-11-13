# -*- coding: utf-8 -*-
"""E5：托管档上限只认 budget_grant（请求 budget 只是「预计需要」）。

- _agent_managed_cap 没有 grant[modality].max 就返回 0，不回退请求 budget；
- _agent_run_budget_grant 不再把 state["budget"] 当授权；
- POST /budget 的 existing 合并不把请求 budget 当已授权；
- 无授权时第一步生成就 budget_required + waiting_budget，不执行生成；
- 授权 image.max=2 后恢复：最多生成 2 次，第 3 次再 budget_required。
"""
import asyncio
import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_OWN_TMP = ""
_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-budget-grant-")
    _OWN_TMP = _TMP
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import run_state  # noqa: E402
from tests.test_agent_reflect import new_canvas  # noqa: E402
from tests.test_agent_run_state import make_req, run_with_patches, stop_patches  # noqa: E402


def tearDownModule():
    if _OWN_TMP:
        shutil.rmtree(_OWN_TMP, ignore_errors=True)


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def events_of(bus):
    return [{"event": item.get("name"), "data": item.get("data")} for item in (bus.get("events") or [])]


def budget_required_events(bus):
    return [item["data"] for item in events_of(bus) if item["event"] == "budget_required"]


class ManagedCapTests(unittest.TestCase):
    def test_cap_only_reads_grant_max(self):
        self.assertEqual(main._agent_managed_cap({}, {"image": 5}, "image"), 0,
                         "没有授权时请求里的预计预算不能当上限")
        self.assertEqual(main._agent_managed_cap({"image": {"provider": "p"}},
                                                 {"image": 5}, "image"), 0)
        self.assertEqual(main._agent_managed_cap({"image": {"max": 0}},
                                                 {"image": 5}, "image"), 0)
        self.assertEqual(main._agent_managed_cap({"image": {"max": 2}},
                                                 {"image": 5}, "image"), 2)
        self.assertEqual(main._agent_managed_cap({"video": {"max": 1}},
                                                 {"video": 9}, "video"), 1)

    def test_budget_grant_does_not_fall_back_to_request_budget(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        run_id = "run_grant_" + uuid.uuid4().hex[:8]
        main._agent_run_state_write(run_id, {"run_id": run_id, "canvas_id": "c_grant",
                                             "budget": {"image": 5}})
        try:
            main._AGENT_RUN_BUS.pop(run_id, None)
            self.assertEqual(main._agent_run_budget_grant(run_id), {},
                             "state['budget'] 是预计预算，不是授权")
            bus = main._agent_run_bus_new(run_id, "c_grant")
            bus["budget_grant"] = {"image": {"max": 3}}
            self.assertEqual(main._agent_run_budget_grant(run_id)["image"]["max"], 3)
        finally:
            main._AGENT_RUN_BUS.pop(run_id, None)
            path = main._agent_run_state_path(run_id)
            if os.path.exists(path):
                os.remove(path)


class ManagedNoGrantTests(unittest.TestCase):
    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("budget-grant")

    def _run(self, decisions, budget=None, grant=None, extra_env=None):
        req, bus, pending = make_req(self.canvas_id, decisions)
        req.update({"autonomy": "managed", "budget": budget or {}})
        bus["autonomy"] = "managed"
        if grant is not None:
            bus["budget_grant"] = grant
        calls = {"execute": 0, "pending": pending, "req": req}

        async def execute(tool, args):
            calls["execute"] += 1
            return {"ok": True, "tool": tool, "message": "生成成功",
                    "result": {"status": "done", "node_id": "n1", "kind": "image", "url": "/a.png"}}

        messages, pending, patches = run_with_patches(
            req, bus, pending, wait_outcomes=[],
            env_extra={"NOVAI_AGENT_V2_AUTONOMY": "1", "NOVAI_AGENT_V2_RUNSTATE": "1"},
            patches_extra=[patch.object(main, "agent_execute_step", new=execute)])
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
        finally:
            pass
        calls["patches"] = patches
        calls["messages"] = messages
        return req, bus, calls

    def test_no_grant_first_generation_requires_budget(self):
        decisions = [{"steps": [{"tool": "generate_image",
                                  "args": {"canvas_id": self.canvas_id, "prompt": "第1张"}}]},
                     {"done": True, "message": "不该走到这里"}]
        req, bus, calls = self._run(decisions, budget={"image": 5})
        try:
            required = budget_required_events(bus)
            self.assertEqual(len(required), 1, required)
            self.assertEqual(required[0].get("requested"), {"image": 5},
                             "budget_required 要带上请求里的预计预算")
            self.assertGreaterEqual(required[0]["needs"]["image"], 1)
            self.assertEqual(calls["execute"], 0, "没有授权时第一步生成不能执行")
            self.assertFalse([item for item in events_of(bus) if item["event"] == "step_result"])
            state = main._agent_run_state_read(req["run_id"])
            self.assertEqual(state.get("status"), run_state.STATUS_WAITING_BUDGET)
            self.assertFalse([item for item in events_of(bus) if item["event"] == "done"])
            self.assertTrue(bus.get("suspended"))
        finally:
            stop_patches(calls["patches"])

    def test_grant_two_allows_two_generations_then_requires_again(self):
        decisions = [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "第1张"}}]},
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "第2张"}}]},
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "第3张"}}]},
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": self.canvas_id, "prompt": "第4张"}}]},
            {"done": True, "message": "完成"},
        ]
        req, bus, calls = self._run(decisions, budget={"image": 5})
        patches = calls["patches"]
        try:
            self.assertEqual(calls["execute"], 0, "无授权先挂起")
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

            result, resumed_bus = asyncio.run(scenario())
            self.assertTrue(result["resumed"], result)
            self.assertEqual(calls["execute"], 2, "授权 2 次最多生成 2 次")
            step_results = [item for item in events_of(resumed_bus) if item["event"] == "step_result"]
            self.assertEqual(len(step_results), 2, step_results)
            required = budget_required_events(resumed_bus)
            self.assertEqual(len(required), 2, "第 3 次生成要再次 budget_required")
            self.assertEqual(required[-1].get("requested"), {"image": 5})
            self.assertEqual(main._agent_run_state_read(req["run_id"]).get("status"),
                             run_state.STATUS_WAITING_BUDGET)
            self.assertTrue(resumed_bus.get("suspended"))
        finally:
            stop_patches(patches)


class BudgetRouteMergeTests(unittest.TestCase):
    def test_post_budget_does_not_treat_request_budget_as_authorized(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        run_id = "run_budget_merge_" + uuid.uuid4().hex[:8]
        main._agent_run_state_write(run_id, {"run_id": run_id, "canvas_id": "c_merge",
                                             "autonomy": "managed",
                                             "budget": {"image": 5}})
        bus = main._agent_run_bus_new(run_id, "c_merge")
        bus["autonomy"] = "managed"
        try:
            payload = main.AgentRunBudgetRequest(image=main.AgentBudgetChoice(max=2))
            with patch.object(main, "_agent_require_run_access", new=lambda *a, **k: None):
                result = asyncio.run(main.agent_run_budget(run_id, payload, None))
            self.assertTrue(result["ok"])
            self.assertEqual(result["budget"]["image"]["max"], 2,
                             "请求里的 budget=5 不能被当成已授权，上限只能是 2")
            self.assertEqual(bus["budget_grant"]["image"]["max"], 2)
        finally:
            main._AGENT_RUN_BUS.pop(run_id, None)
            path = main._agent_run_state_path(run_id)
            if os.path.exists(path):
                os.remove(path)


if __name__ == "__main__":
    unittest.main()
