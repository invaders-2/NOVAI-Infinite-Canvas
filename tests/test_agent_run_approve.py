"""方案卡「执行」：POST /api/agent/runs/{run_id}/approve 的契约与安全边界（模型调用 / 工具执行全部打桩）。

覆盖：
  1. 有 pending plan → 批准后开新 run：沿用原指令 / 画布 / 模型，带 approved_steps，返回新 runId；
  2. 重复批准 409、没有待确认方案 409、run 不存在 404、方案里没有可执行步骤 409；
  3. 权限：批准按 edit 判定（viewer 403），不能靠 view 权限改画布；
  4. 请求体收敛：脏 steps 不 422（丢非对象、tool 归空串），显式 steps 覆盖方案里的步骤；
  5. _agent_run_bus_pending_plan 纯函数：优先 bus 标记；退回只认 requires_confirmation 的 plan 事件；空步骤不算；
  6. producer 真链路：mode=run 的写步骤被闸门拦成方案 → 快照读得到 plan、一步都没执行 → 批准后新 run 带同一批步骤。
"""
import asyncio
import contextlib
import io
import json
import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

RUN_ID = "run_approve_plan1"
STEPS = [{"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"}, "description": "建提示词节点"}]


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "owner_id": 1,
            "nodes": [], "connections": [], "updated_at": 1700000000000}


def chat_config():
    return {"provider": "openai", "base": "https://example.invalid/v1", "headers": {},
            "model": "test-chat-model", "provider_cfg": {}}


def base_request(run_id=RUN_ID):
    return {
        "canvas_id": "c1",
        "instruction": "在画布上建个提示词节点",
        "focus": main._agent_run_normalize_focus(None),
        "history": [],
        "chat": chat_config(),
        "max_steps": 6,
        "mode": "run",
        "approved_steps": [],
        "run_id": run_id,
    }


def plan_event(steps=None, requires_confirmation=True):
    extra = {"requires_confirmation": True, "blocked_tools": ["create_node"]} if requires_confirmation else None
    return main._agent_plan_event("建提示词节点", list(STEPS if steps is None else steps), extra=extra)


_DEFAULT_PLAN = object()


def seed_bus(run_id=RUN_ID, plan=_DEFAULT_PLAN, request=None, done=True):
    """造一条「已经出完方案、等用户批准」的 run（done=True：approve 的等待循环立即返回）。
    plan=None 表示这条 run 没有待确认方案。"""
    if plan is _DEFAULT_PLAN:
        plan = plan_event()
    bus = main._agent_run_bus_new(run_id, "c1")
    bus["goal"] = "在画布上建个提示词节点"
    bus["model_config_id"] = "openai::test-chat-model"
    bus["mode"] = "run"
    bus["request"] = base_request(run_id) if request is None else request
    if plan is not None:
        bus["pending_plan"] = plan
        main._agent_run_bus_publish(bus, "plan", plan)
    main._agent_run_bus_publish(bus, "done", {"run_id": run_id, "status": "ok", "message": "方案待确认",
                                              "steps_executed": 0, "changes": {}})
    if done:
        bus["done"] = True
        bus["finished_at"] = time.time()      # 别用 0/1：过期清理会把这个 run 从总线上摘掉
    return bus


class ApproveEndpointTests(unittest.TestCase):
    def setUp(self):
        self.drive = AsyncMock(return_value=None)
        self.patches = [
            patch.object(main, "load_canvas", return_value=canvas()),
            patch.object(main, "_agent_run_bus_drive", new=self.drive),
            patch.object(main, "agent_session_save"),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(RUN_ID, None))

    def approve(self, run_id=RUN_ID, payload=None):
        payload = payload or main.AgentRunApproveRequest()

        async def run():
            result = await main.agent_run_approve(run_id, payload, object())   # auth-off：object() 没有 state.auth_user
            await asyncio.sleep(0)          # 让 create_task 起的驱动真的跑一步
            return result
        return asyncio.run(run())

    def test_approve_starts_new_run_with_the_approved_steps(self):
        bus = seed_bus()
        result = self.approve()

        self.assertTrue(result["ok"])
        new_run_id = result["taskId"]
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(new_run_id, None))
        self.assertNotEqual(new_run_id, RUN_ID)
        self.assertEqual(result["status"], "RUNNING")
        self.assertEqual(bus["approved_run_id"], new_run_id)

        new_bus = main._AGENT_RUN_BUS[new_run_id]
        self.assertEqual(new_bus["canvas_id"], "c1")
        self.assertEqual(new_bus["goal"], bus["goal"])
        self.assertEqual(new_bus["mode"], "run")
        req = new_bus["request"]
        self.assertEqual(req["approved_steps"], bus["pending_plan"]["steps"])
        self.assertEqual(req["instruction"], "在画布上建个提示词节点")
        self.assertEqual(req["mode"], "run")
        self.assertEqual(req["run_id"], new_run_id)
        # 原 run 的请求不能被就地改掉
        self.assertEqual(bus["request"]["approved_steps"], [])
        # 驱动真的被叫起来（执行仍然走 producer 的既有入口）
        self.assertEqual(self.drive.await_count, 1)
        self.assertEqual(self.drive.await_args.args[1]["run_id"], new_run_id)

    def test_approve_twice_is_conflict(self):
        seed_bus()
        first = self.approve()
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(first["taskId"], None))
        with self.assertRaises(main.HTTPException) as ctx:
            self.approve()
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("已经执行过", str(ctx.exception.detail))

    def test_approve_without_pending_plan_is_conflict(self):
        seed_bus(plan=None)
        with self.assertRaises(main.HTTPException) as ctx:
            self.approve()
        self.assertEqual(ctx.exception.status_code, 409)
        self.assertIn("没有待确认的执行方案", str(ctx.exception.detail))

    def test_approve_plan_with_empty_steps_is_conflict(self):
        seed_bus(plan=plan_event(steps=[]))
        with self.assertRaises(main.HTTPException) as ctx:
            self.approve()
        self.assertEqual(ctx.exception.status_code, 409)

    def test_approve_unknown_run_is_404(self):
        with self.assertRaises(main.HTTPException) as ctx:
            self.approve(run_id="run_not_exist")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_approve_requires_edit_permission(self):
        """viewer 只读：批准会改画布，必须 403（auth-on 的真实判定路径）。"""
        seed_bus()
        viewer = types.SimpleNamespace(state=types.SimpleNamespace(
            auth_user={"id": 7, "username": "viewer", "is_admin": False}))

        async def run():
            return await main.agent_run_approve(RUN_ID, main.AgentRunApproveRequest(), viewer)

        with patch.object(main._canvas_perms, "get_share", return_value=None):
            with self.assertRaises(main.HTTPException) as ctx:
                asyncio.run(run())
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(self.drive.await_count, 0)

    def test_explicit_steps_override_the_plan(self):
        seed_bus()
        override = [{"tool": "connect_nodes", "args": {"canvas_id": "c1", "from": "n1", "to": "n2"},
                     "description": "只连线"}]
        result = self.approve(payload=main.AgentRunApproveRequest(steps=override))
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(result["taskId"], None))
        self.assertEqual(main._AGENT_RUN_BUS[result["taskId"]]["request"]["approved_steps"], override)


class ApproveRequestTests(unittest.TestCase):
    def test_dirty_steps_are_tolerated_not_422(self):
        payload = main.AgentRunApproveRequest(steps=[
            "脏数据", {"args": {"a": 1}}, {"tool": "create_node", "args": "不是对象"},
            {"tool": "create_node", "args": {"canvas_id": "c1"}, "description": "建节点"},
        ])
        self.assertEqual([step.tool for step in payload.steps], ["", "create_node", "create_node"])
        self.assertEqual(payload.steps[0].args, {"a": 1})
        self.assertEqual(payload.steps[1].args, "不是对象")
        self.assertEqual(payload.steps[2].description, "建节点")

    def test_non_list_steps_become_empty(self):
        self.assertEqual(main.AgentRunApproveRequest(steps="不是数组").steps, [])


class PendingPlanTests(unittest.TestCase):
    def test_prefers_bus_flag(self):
        bus = {"pending_plan": plan_event()}
        self.assertEqual(main._agent_run_bus_pending_plan(bus)["steps"], STEPS)

    def test_falls_back_to_requires_confirmation_event(self):
        bus = {"events": [{"seq": 1, "name": "plan", "data": plan_event(requires_confirmation=False)}]}
        self.assertIsNone(main._agent_run_bus_pending_plan(bus))
        bus["events"].append({"seq": 2, "name": "plan", "data": plan_event()})
        self.assertEqual(main._agent_run_bus_pending_plan(bus)["steps"], STEPS)

    def test_empty_steps_are_not_a_plan(self):
        self.assertIsNone(main._agent_run_bus_pending_plan({"pending_plan": {"steps": []}}))
        self.assertIsNone(main._agent_run_bus_pending_plan({}))
        self.assertIsNone(main._agent_run_bus_pending_plan(None))


class ProducerToApproveTests(unittest.TestCase):
    """真链路：写步骤被闸门拦成方案 → 快照带 plan → 批准后新 run 带同一批步骤。"""

    def setUp(self):
        self.execute = AsyncMock(return_value={"ok": True, "result": {"node_id": "n1"}, "message": "执行成功"})
        self.chat = AsyncMock(return_value=json.dumps(
            {"thought": "建提示词节点",
             "steps": [{"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"},
                        "description": "建提示词节点"}], "done": False}, ensure_ascii=False))
        self.patches = [
            patch.object(main, "load_canvas", return_value=canvas()),
            patch.object(main, "_agent_run_chat", new=self.chat),
            patch.object(main, "agent_session_save"),
            patch.object(main, "agent_execute_step", new=self.execute),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        self.run_id = "run_producer_plan1"
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(self.run_id, None))

    def _produce(self):
        bus = main._agent_run_bus_new(self.run_id, "c1")
        bus["request"] = base_request(self.run_id)
        req = base_request(self.run_id)

        async def run():
            with contextlib.redirect_stdout(io.StringIO()):
                await main._agent_run_producer(req, None, bus=bus)
        asyncio.run(run())
        return bus

    def test_write_step_becomes_snapshot_plan_then_approve_replays_it(self):
        bus = self._produce()
        main._agent_run_bus_close(bus)          # 生产循环由 _agent_run_bus_drive 收尾，这里手动闭总线

        snapshot = main._agent_run_task_snapshot(bus)
        self.assertEqual(snapshot["task"]["status"], "SUCCEEDED")
        self.assertIsNotNone(snapshot["plan"])
        self.assertEqual([step["tool"] for step in snapshot["plan"]["steps"]], ["create_node"])
        self.assertEqual(snapshot["plan"]["blocked_tools"], ["create_node"])
        self.assertFalse([event for event in snapshot["events"]
                          if str(event["eventType"]).startswith("tool.execution")])
        self.assertEqual(self.execute.await_count, 0)      # 未批准：一步都没执行

        drive = AsyncMock(return_value=None)
        with patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "_agent_run_bus_drive", new=drive):
            async def approve():
                result = await main.agent_run_approve(
                    self.run_id, main.AgentRunApproveRequest(), object())
                await asyncio.sleep(0)
                return result
            result = asyncio.run(approve())
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(result["taskId"], None))
        self.assertEqual(self.execute.await_count, 0)      # 驱动被打桩：仍然不执行
        replayed = drive.await_args.args[0]["approved_steps"]
        self.assertEqual([step["tool"] for step in replayed], ["create_node"])
        self.assertEqual(replayed, snapshot["plan"]["steps"])


if __name__ == "__main__":
    unittest.main()
