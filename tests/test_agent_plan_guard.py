"""画布助手第 3 / 4 条改造：≥2 张参考图的确定性提示注入 + 写操作确认闸门。

覆盖：
  1. agent_reference_image_count / agent_plan_reference_hint 纯函数：0/1 张不注入，
     2/3 张注入且带数量与「table → batch」；
  2. 提示真的进了给规划模型的用户消息（_agent_run_user_prompt）；
  3. agent_plan_confirmation_needed 纯函数：写 / 生成工具未确认要拦，只读放行，confirmed=True 放行；
  4. _agent_run_producer：mode=run 未确认时写 / 生成工具被拦成待确认方案（不执行），
     只读工具照旧执行；approved_steps（用户已点执行）照旧执行。
全程打桩，不调真实模型、不落盘真实画布。
"""
import asyncio
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": [], "connections": [],
            "updated_at": 1700000000000}


def chat_config():
    return {"provider": "openai", "base": "https://example.invalid/v1", "headers": {},
            "model": "test-chat-model", "provider_cfg": {}}


def agent_request(instruction="来张海报", mode="run", approved_steps=None, focus=None, max_steps=6):
    return {
        "canvas_id": "c1",
        "instruction": instruction,
        "focus": focus or main._agent_run_normalize_focus(None),
        "history": [],
        "chat": chat_config(),
        "max_steps": max_steps,
        "mode": mode,
        "approved_steps": approved_steps or [],
        # 与 /api/agent/run 入口一致：开启写操作闸门
        "enforce_write_confirmation": True,
    }


def parse_events(chunks):
    events = []
    for chunk in chunks:
        for block in chunk.strip().split("\n\n"):
            if not block or block.startswith(":"):
                continue
            name, data = "message", {}
            for line in block.split("\n"):
                if line.startswith("event: "):
                    name = line[len("event: "):].strip()
                elif line.startswith("data: "):
                    data = json.loads(line[len("data: "):])
            events.append((name, data))
    return events


def drain(req, replies, execute):
    """同步跑完 producer，返回 (execute mock, events)。"""
    chat = AsyncMock(side_effect=[json.dumps(r, ensure_ascii=False) for r in replies])

    async def run():
        queue = asyncio.Queue()
        with contextlib.redirect_stdout(io.StringIO()):
            await main._agent_run_producer(req, queue)
        out = []
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                break
            out.append(item)
        return out

    with patch.object(main, "load_canvas", return_value=canvas()), \
            patch.object(main, "agent_session_save"), \
            patch.object(main, "_agent_run_chat", new=chat), \
            patch.object(main, "agent_execute_step", new=execute):
        return parse_events(asyncio.run(run()))


class ReferenceHintPureTests(unittest.TestCase):
    """参考图计数与提示注入都是纯函数，直接直调。"""

    def test_count_dedupes_and_skips_video(self):
        self.assertEqual(main.agent_reference_image_count([]), 0)
        self.assertEqual(main.agent_reference_image_count(None), 0)
        self.assertEqual(main.agent_reference_image_count(["/a.png", "/a.png"]), 1)
        self.assertEqual(main.agent_reference_image_count(
            ["https://x/a.png", "https://x/b.mp4", "https://x/c.mov", "data:video/mp4;base64,AA"]), 1)
        self.assertEqual(main.agent_reference_image_count(["", "  ", None, "/a.png", "/b.png"]), 2)

    def test_count_accepts_production_dicts(self):
        # 生产（_agent_run_media_task 构造 focus）传的是字典数组
        refs = [{"url": "/a.png"}, {"url": "/a.png"}, {"url": "/v.mp4"}, {"url": "/b.png"}]
        self.assertEqual(main.agent_reference_image_count(refs), 2)
        self.assertEqual(main.agent_reference_image_count([{}, {"url": ""}, {"url": None}, {"url": "  "}]), 0)
        self.assertIn("2 张参考图", main.agent_plan_reference_hint(refs))

    def test_count_dedupes_across_string_and_dict(self):
        refs = ["/a.png", {"url": "/a.png"}, {"url": "/c.png"}]
        self.assertEqual(main.agent_reference_image_count(refs), 2)

    def test_zero_or_one_reference_image_injects_nothing(self):
        for refs in ([], None, [""], ["/a.png"], ["/a.png", "https://x/a.mp4"], ["/a.png", "/a.png"]):
            self.assertEqual(main.agent_plan_reference_hint(refs), "", repr(refs))

    def test_two_or_three_reference_images_inject_count_and_table_batch(self):
        for n in (2, 3):
            refs = [f"/ref{i}.png" for i in range(n)]
            hint = main.agent_plan_reference_hint(refs)
            self.assertIn(f"{n} 张参考图", hint)
            self.assertIn("table → batch", hint)
            self.assertIn("≥2", hint)
            self.assertIn("create_node(type=table", hint)
            self.assertIn("create_node(type=batch", hint)

    def test_hint_is_wired_into_run_user_prompt(self):
        hint = main.agent_plan_reference_hint(["/a.png", "/b.png"])
        with_hint = main._agent_run_user_prompt("用这两张出 3 版", [], 1, 12, 0, "",
                                                mode="plan", reference_hint=hint)
        self.assertIn("本次有 2 张参考图", with_hint)
        self.assertIn("table → batch", with_hint)
        without = main._agent_run_user_prompt("用这两张出 3 版", [], 1, 12, 0, "",
                                              mode="plan", reference_hint="")
        self.assertNotIn("参考图", without)


class WriteGatePureTests(unittest.TestCase):
    """写操作 / 生成操作闸门的纯函数判定。"""

    WRITE_OR_GENERATE = [
        "create_node", "connect_nodes", "update_node", "disconnect_nodes",
        "batch_generate", "apply_template",
        "generate_image", "generate_video", "run_generation", "run_batch", "run_downstream",
    ]
    READ_ONLY = ["get_canvas", "list_canvases", "use_asset", "check_task", "refine_prompt", "list_templates"]

    def test_unconfirmed_write_and_generate_tools_need_confirmation(self):
        for tool in self.WRITE_OR_GENERATE:
            self.assertIn(tool, main.AGENT_PLAN_CONFIRM_TOOLS, tool)
            self.assertTrue(main.agent_plan_confirmation_needed([{"tool": tool}])["needed"], tool)

    def test_read_only_tools_pass(self):
        for tool in self.READ_ONLY:
            self.assertNotIn(tool, main.AGENT_PLAN_CONFIRM_TOOLS, tool)
            self.assertFalse(main.agent_plan_confirmation_needed([{"tool": tool}])["needed"], tool)

    def test_confirmed_steps_pass(self):
        steps = [{"tool": t} for t in self.WRITE_OR_GENERATE]
        self.assertFalse(main.agent_plan_confirmation_needed(steps, confirmed=True)["needed"])
        self.assertEqual(main.agent_plan_confirmation_needed(steps, confirmed=True)["tools"], [])

    def test_dirty_steps_do_not_crash(self):
        self.assertFalse(main.agent_plan_confirmation_needed(["脏", None, 7])["needed"])
        self.assertFalse(main.agent_plan_confirmation_needed(None)["needed"])

    def test_mixed_batch_reports_only_blocked_tools(self):
        result = main.agent_plan_confirmation_needed(
            [{"tool": "get_canvas"}, {"tool": "connect_nodes"}, {"tool": "generate_image"}])
        self.assertTrue(result["needed"])
        self.assertEqual(result["tools"], ["connect_nodes", "generate_image"])


class WriteGateProducerTests(unittest.TestCase):
    """闸门落在 agent 循环执行收口处：未确认的写操作不会真的落盘。"""

    def setUp(self):
        self.execute = AsyncMock(return_value={"ok": True, "result": {"node_id": "n1"}, "message": "执行成功"})

    def test_unconfirmed_create_node_is_deferred_to_plan(self):
        events = drain(agent_request(mode="run"), [
            {"thought": "建提示词节点",
             "steps": [{"tool": "create_node",
                        "args": {"canvas_id": "c1", "type": "prompt", "title": "海报"},
                        "description": "建提示词节点"}], "done": False},
        ], self.execute)
        names = [name for name, _ in events]

        self.assertEqual(self.execute.await_count, 0)
        self.assertNotIn("step_start", names)
        self.assertNotIn("step_result", names)
        plan = [data for name, data in events if name == "plan"][0]
        self.assertTrue(plan["requires_confirmation"])
        self.assertEqual(plan["blocked_tools"], ["create_node"])
        self.assertEqual([s["tool"] for s in plan["steps"]], ["create_node"])
        self.assertEqual(plan["impact"]["writes"], 1)
        done = [data for name, data in events if name == "done"][0]
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["steps_executed"], 0)

    def test_unconfirmed_generate_image_is_deferred_to_plan(self):
        events = drain(agent_request(mode="run"), [
            {"thought": "出图",
             "steps": [{"tool": "generate_image",
                        "args": {"canvas_id": "c1", "prompt": "极简海报", "model": "m"},
                        "description": "生成海报"}], "done": False},
        ], self.execute)

        self.assertEqual(self.execute.await_count, 0)
        plan = [data for name, data in events if name == "plan"][0]
        self.assertTrue(plan["requires_confirmation"])
        self.assertEqual(plan["impact"]["generations"], 1)

    def test_read_only_tools_still_execute_without_confirmation(self):
        events = drain(agent_request(mode="run"), [
            {"thought": "看画布", "steps": [{"tool": "get_canvas",
                                             "args": {"canvas_id": "c1"}, "description": "看画布"}],
             "done": False},
            {"done": True, "message": "看完了"},
        ], self.execute)
        names = [name for name, _ in events]

        self.assertEqual([call.args[0] for call in self.execute.await_args_list], ["get_canvas"])
        self.assertIn("step_start", names)
        self.assertNotIn("confirm_required", names)
        self.assertEqual([data for name, data in events if name == "done"][0]["status"], "ok")

    def test_approved_steps_execute_as_before(self):
        approved = [{"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"},
                     "description": "建提示词节点"}]
        events = drain(agent_request(mode="run", approved_steps=approved),
                       [{"done": True, "message": "完成"}], self.execute)

        self.assertEqual([call.args[0] for call in self.execute.await_args_list], ["create_node"])
        plan = [data for name, data in events if name == "plan"][0]
        self.assertNotIn("requires_confirmation", plan)
        self.assertEqual([data for name, data in events if name == "done"][0]["steps_executed"], 1)

    def test_approved_generation_tool_executes_as_before(self):
        approved = [{"tool": "generate_image",
                     "args": {"canvas_id": "c1", "prompt": "海报", "model": "m"},
                     "description": "生成海报"}]
        events = drain(agent_request(mode="run", approved_steps=approved),
                       [{"done": True, "message": "完成"}], self.execute)

        self.assertEqual([call.args[0] for call in self.execute.await_args_list], ["generate_image"])
        self.assertNotIn("confirm_required", [name for name, _ in events])


class WriteGateEndpointTests(unittest.TestCase):
    """/api/agent/run 整条链路：HTTP 入口一律开启闸门，mode=run 未确认的写操作也只出方案。"""

    def _drive(self, payload, chat_reply, execute):
        chat = AsyncMock(return_value=json.dumps(chat_reply, ensure_ascii=False))

        async def run():
            response = await main.agent_run(payload)
            return [chunk async for chunk in response.body_iterator]

        with patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "_agent_run_resolve_chat", return_value=chat_config()), \
                patch.object(main, "_agent_run_chat", new=chat), \
                patch.object(main, "agent_session_save"), \
                patch.object(main, "agent_execute_step", new=execute):
            chunks = asyncio.run(run())
        return parse_events(chunks)

    def test_endpoint_run_mode_defers_unconfirmed_write(self):
        execute = AsyncMock(return_value={"ok": True, "result": {}, "message": "执行成功"})
        payload = main.AgentRunRequest(canvas_id="c1", instruction="建个提示词节点", mode="run")
        events = self._drive(payload, {
            "thought": "建节点",
            "steps": [{"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"},
                       "description": "建提示词节点"}], "done": False}, execute)

        self.assertEqual(execute.await_count, 0)
        plan = [data for name, data in events if name == "plan"][0]
        self.assertTrue(plan["requires_confirmation"])
        self.assertEqual([data for name, data in events if name == "done"][0]["status"], "ok")

    def test_endpoint_read_only_run_mode_still_executes(self):
        execute = AsyncMock(return_value={"ok": True, "result": {}, "message": "执行成功"})
        payload = main.AgentRunRequest(canvas_id="c1", instruction="看看画布", mode="run")
        chat = AsyncMock(side_effect=[
            json.dumps({"thought": "看画布",
                        "steps": [{"tool": "get_canvas", "args": {"canvas_id": "c1"},
                                   "description": "看画布"}], "done": False}, ensure_ascii=False),
            json.dumps({"done": True, "message": "看完了"}, ensure_ascii=False),
        ])

        async def run():
            response = await main.agent_run(payload)
            return [chunk async for chunk in response.body_iterator]

        with patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "_agent_run_resolve_chat", return_value=chat_config()), \
                patch.object(main, "_agent_run_chat", new=chat), \
                patch.object(main, "agent_session_save"), \
                patch.object(main, "agent_execute_step", new=execute):
            chunks = asyncio.run(run())
        self.assertEqual([call.args[0] for call in execute.await_args_list], ["get_canvas"])


if __name__ == "__main__":
    unittest.main()
