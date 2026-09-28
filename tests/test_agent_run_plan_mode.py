"""画布助手「先出方案再动手」：/api/agent/run 的 mode=plan 与 approved_steps（模型调用全部打桩）。

覆盖：
  1. mode=plan + 模型返回方案 → 只发 plan 事件 + done，impact/summary 齐全且数字正确，agent_execute_step 一次都不调；
  2. mode=plan + 模型直接回答 → 无 plan 事件、无工具调用、message 原样透出；
  3. mode=run → 保持现有行为（真的执行步骤）；
  4. approved_steps → 跳过规划轮（模型调用不发生在执行之前），按给定步骤执行；
  5. agent_plan_impact 纯函数：0 步 / 只读 / 混合 / 带 model+size；
  6. 脏 approved_steps 不 422，走现有错误路径（无效步骤被过滤并记账，不执行）。
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


def agent_request(instruction="来张海报", mode="plan", approved_steps=None, max_steps=6):
    return {
        "canvas_id": "c1",
        "instruction": instruction,
        "focus": main._agent_run_normalize_focus(None),
        "history": [],
        "chat": chat_config(),
        "max_steps": max_steps,
        "mode": mode,
        "approved_steps": approved_steps or [],
    }


def drain(req):
    """同步跑完 producer，收集它塞进队列的所有 SSE 片段（静音它自己的进度打印）。"""
    async def run():
        queue = asyncio.Queue()
        with contextlib.redirect_stdout(io.StringIO()):
            await main._agent_run_producer(req, queue)
        chunks = []
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                break
            chunks.append(item)
        return chunks
    return asyncio.run(run())


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


def plan_steps():
    poster = {"canvas_id": "c1", "prompt": "极简风海报", "provider": "lovart",
              "model": "generate_image_gpt_image_2_5_flare", "ratio": "3:4"}
    return [
        {"tool": "generate_image", "args": dict(poster), "description": "生成第一张 3:4 海报"},
        {"tool": "generate_image", "args": dict(poster, prompt="极简风海报（第二张）"),
         "description": "生成第二张 3:4 海报"},
        {"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"}, "description": "建提示词节点"},
        {"tool": "connect_nodes", "args": {"canvas_id": "c1", "from": "n1", "to": "n2"},
         "description": "把提示词节点连到图片节点"},
    ]


class AgentRunPlanModeTests(unittest.TestCase):
    """mode=plan：第一轮只出方案或直接回答，绝不执行任何工具。"""

    def setUp(self):
        self.execute = AsyncMock(return_value={"ok": True, "result": {}, "message": "执行成功"})
        self.saved_sessions = []
        self.patches = [
            patch.object(main, "load_canvas", return_value=canvas()),
            patch.object(main, "agent_session_save", side_effect=self.saved_sessions.append),
            patch.object(main, "agent_execute_step", new=self.execute),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def _chat(self, reply):
        chat = AsyncMock(return_value=json.dumps(reply, ensure_ascii=False))
        patcher = patch.object(main, "_agent_run_chat", new=chat)
        patcher.start()
        self.addCleanup(patcher.stop)
        return chat

    def test_plan_reply_emits_plan_event_and_never_executes(self):
        self._chat({"intent": "出两张 3:4 海报", "steps": plan_steps(),
                    "expected_output": "两张 3:4 海报落到画布上"})
        events = parse_events(drain(agent_request(mode="plan")))
        names = [name for name, _ in events]

        self.assertEqual(names.count("plan"), 1)
        self.assertEqual(names[-1], "done")
        self.assertNotIn("step_start", names)
        self.assertNotIn("step_result", names)
        self.assertEqual(self.execute.await_count, 0)

        plan = [data for name, data in events if name == "plan"][0]
        self.assertEqual(set(plan.keys()),
                         {"intent", "steps", "expected_output", "impact", "summary"})
        self.assertEqual(plan["intent"], "出两张 3:4 海报")
        self.assertEqual(plan["steps"], plan_steps())
        self.assertEqual(plan["expected_output"], "两张 3:4 海报落到画布上")
        self.assertEqual(plan["impact"], {
            "generations": 2, "writes": 2, "models": ["generate_image_gpt_image_2_5_flare"],
            "sizes": ["1008x1344"], "nodes": 1})
        self.assertIn("2 次真实生成", plan["summary"])
        self.assertIn("generate_image_gpt_image_2_5_flare", plan["summary"])
        self.assertIn("1008x1344", plan["summary"])

        done = [data for name, data in events if name == "done"][0]
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["steps_executed"], 0)
        self.assertEqual(done["message"], plan["summary"])

    def test_plan_is_persisted_into_session_store(self):
        self._chat({"intent": "出两张 3:4 海报", "steps": plan_steps(), "expected_output": "两张海报"})
        drain(agent_request(mode="plan"))

        session = self.saved_sessions[-1]
        self.assertEqual(session["mode"], "plan")
        self.assertEqual(session["status"], "planned")
        self.assertTrue(session["run_id"].startswith("run_"))
        self.assertEqual(session["plan"]["intent"], "出两张 3:4 海报")
        self.assertEqual(session["plan"]["steps"], plan_steps())
        self.assertEqual(session["plan"]["impact"]["generations"], 2)
        self.assertEqual(session["plan"]["run_id"], session["run_id"])
        self.assertEqual(session["execution_log"], [])

    def test_direct_answer_has_no_plan_event_and_no_tools(self):
        self._chat({"done": True, "message": "3:4 海报适合小红书，建议用 1008x1344。"})
        events = parse_events(drain(agent_request(mode="plan", instruction="海报用什么比例好？")))
        names = [name for name, _ in events]

        self.assertNotIn("plan", names)
        self.assertIn(("message", {"text": "3:4 海报适合小红书，建议用 1008x1344。"}), events)
        self.assertEqual(names[-1], "done")
        self.assertEqual(self.execute.await_count, 0)
        done = [data for name, data in events if name == "done"][0]
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["message"], "3:4 海报适合小红书，建议用 1008x1344。")
        self.assertEqual(self.saved_sessions[-1]["status"], "applied")

    def test_plan_mode_default_request_mode_is_plan(self):
        self.assertEqual(main.AgentRunRequest(canvas_id="c1", instruction="来一张").mode, "plan")
        self.assertEqual(main.AgentRunRequest(canvas_id="c1", instruction="来一张",
                                              mode="乱写").mode, "plan")
        self.assertEqual(main.AgentRunRequest(canvas_id="c1", instruction="来一张", mode="RUN").mode, "run")


class AgentRunRunModeTests(unittest.TestCase):
    """mode=run：老的执行行为不能变。"""

    def test_run_mode_executes_steps(self):
        execute = AsyncMock(side_effect=[
            {"ok": True, "result": {"node_id": "n1"}, "message": "执行成功"}])
        replies = [
            json.dumps({"thought": "先建提示词节点",
                        "steps": [{"tool": "create_node",
                                   "args": {"canvas_id": "c1", "type": "prompt", "title": "海报"},
                                   "description": "建提示词节点"}], "done": False},
                       ensure_ascii=False),
            json.dumps({"done": True, "message": "做完了"}, ensure_ascii=False),
        ]
        chat = AsyncMock(side_effect=replies)
        with patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "agent_session_save"), \
                patch.object(main, "agent_execute_step", new=execute), \
                patch.object(main, "_agent_run_chat", new=chat):
            events = parse_events(drain(agent_request(mode="run", instruction="建个提示词节点")))

        names = [name for name, _ in events]
        self.assertEqual([call.args[0] for call in execute.await_args_list], ["create_node"])
        self.assertEqual(names.count("step_start"), 1)
        self.assertEqual(names.count("step_result"), 1)
        self.assertEqual(names.count("plan"), 1)
        self.assertEqual(names[-1], "done")
        self.assertEqual([data for name, data in events if name == "done"][0]["status"], "ok")
        plan = [data for name, data in events if name == "plan"][0]
        self.assertEqual(plan["impact"], {"generations": 0, "writes": 1, "models": [], "sizes": [], "nodes": 1})
        self.assertEqual(plan["round"], 1)
        self.assertIn("画布操作", plan["summary"])


class AgentRunApprovedStepsTests(unittest.TestCase):
    """approved_steps：用户点了「执行」→ 跳过规划，直接执行给定步骤。"""

    APPROVED = [
        {"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"}, "description": "建提示词节点"},
        {"tool": "connect_nodes", "args": {"canvas_id": "c1", "from": "n1", "to": "n2"}, "description": "连线"},
    ]

    def setUp(self):
        self.execute = AsyncMock(return_value={"ok": True, "result": {"node_id": "n1"}, "message": "执行成功"})
        self.executed_before_chat = []
        self.chat = AsyncMock(return_value=json.dumps({"done": True, "message": "全部完成"}, ensure_ascii=False))

        async def chat_side_effect(chat, messages):
            self.executed_before_chat.append(self.execute.await_count)
            return self.chat.return_value

        self.chat.side_effect = chat_side_effect
        self.patches = [
            patch.object(main, "load_canvas", return_value=canvas()),
            patch.object(main, "agent_session_save"),
            patch.object(main, "agent_execute_step", new=self.execute),
            patch.object(main, "_agent_run_chat", new=self.chat),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_approved_steps_skip_planning_even_when_mode_is_plan(self):
        events = parse_events(drain(agent_request(mode="plan", approved_steps=self.APPROVED)))
        names = [name for name, _ in events]

        self.assertEqual([call.args[0] for call in self.execute.await_args_list],
                         ["create_node", "connect_nodes"])
        self.assertEqual(self.chat.await_count, 1)
        self.assertEqual(self.executed_before_chat, [2])
        self.assertEqual(names[-1], "done")
        # 执行走向现有 run 路径：仍然发一次 plan 事件，但内容就是用户批准的那批步骤
        plan = [data for name, data in events if name == "plan"][0]
        self.assertEqual([step["tool"] for step in plan["steps"]], ["create_node", "connect_nodes"])
        self.assertEqual(plan["impact"], {"generations": 0, "writes": 2, "models": [], "sizes": [],
                                         "nodes": 1})
        self.assertEqual([data for name, data in events if name == "done"][0]["status"], "ok")

    def test_dirty_approved_steps_are_flagged_and_not_executed(self):
        dirty = [{"args": {}}, "脏数据", {"tool": "不存在的工具", "args": {}},
                 {"tool": "create_node", "args": "不是对象"}]
        events = parse_events(drain(agent_request(mode="run", approved_steps=dirty)))
        names = [name for name, _ in events]

        self.assertEqual(self.execute.await_count, 0)
        self.assertEqual(self.chat.await_count, 1)
        self.assertEqual(names[-1], "done")
        done = [data for name, data in events if name == "done"][0]
        self.assertEqual(done["status"], "ok")
        self.assertIn("不可用步骤", done["message"])

    def test_valid_and_dirty_approved_steps_run_only_the_valid_ones(self):
        mixed = [{"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"}, "description": "建节点"},
                 {"tool": "不存在的工具", "args": {}}]
        events = parse_events(drain(agent_request(mode="run", approved_steps=mixed)))
        self.assertEqual([call.args[0] for call in self.execute.await_args_list], ["create_node"])
        self.assertEqual([name for name, _ in events][-1], "done")

    def test_request_model_tolerates_dirty_approved_steps_without_422(self):
        payload = main.AgentRunRequest(
            canvas_id="c1", instruction="来一张", mode="plan",
            approved_steps=["脏数据", {"args": {"a": 1}}, {"tool": "不存在的工具", "args": {}},
                            {"tool": "create_node", "args": "不是对象"}, {"tool": 7, "description": 9}])
        self.assertEqual([step.tool for step in payload.approved_steps],
                         ["", "不存在的工具", "create_node", ""])
        self.assertEqual(payload.approved_steps[0].args, {"a": 1})
        self.assertEqual(payload.approved_steps[2].args, "不是对象")
        self.assertEqual(payload.approved_steps[3].description, "")
        self.assertEqual(main.AgentRunRequest(canvas_id="c1", instruction="来一张",
                                              approved_steps="不是数组").approved_steps, [])
        self.assertEqual([step.model_dump() for step in payload.approved_steps][1],
                         {"tool": "不存在的工具", "args": {}, "description": ""})


class AgentPlanImpactTests(unittest.TestCase):
    """agent_plan_impact 是纯函数：只做计数与字面收集。"""

    ZERO = {"generations": 0, "writes": 0, "models": [], "sizes": [], "nodes": 0}

    def test_empty_and_dirty_steps_are_zero(self):
        for value in ([], None, ["脏数据", {"tool": None, "args": "不是对象"}, {"args": []}]):
            self.assertEqual(main.agent_plan_impact(value), self.ZERO, repr(value))

    def test_read_only_steps_count_nothing(self):
        steps = [{"tool": "list_canvases", "args": {}}, {"tool": "get_canvas", "args": {"canvas_id": "c1"}},
                 {"tool": "check_task", "args": {"task_id": "t1"}}, {"tool": "use_asset", "args": {"query": "猫"}}]
        self.assertEqual(main.agent_plan_impact(steps), self.ZERO)
        self.assertIn("只读", main._agent_plan_summary(steps, main.agent_plan_impact(steps)))

    def test_mixed_steps_count_generations_writes_and_nodes(self):
        steps = [
            {"tool": "list_canvases", "args": {}},
            {"tool": "generate_image", "args": {"model": "generate_image_gpt_image_2_5_flare", "ratio": "3:4"}},
            {"tool": "create_node", "args": {"canvas_id": "c1", "type": "image"}},
            {"tool": "connect_nodes", "args": {"canvas_id": "c1", "from": "n1", "to": "n2"}},
            {"tool": "update_node", "args": {"canvas_id": "c1", "node_id": "n1"}},
            {"tool": "generate_video", "args": {"model": "seedance-2.0", "duration": 5}},
            {"tool": "run_generation", "args": {"canvas_id": "c1", "node_id": "n1", "size": "1024x1536"}},
        ]
        impact = main.agent_plan_impact(steps)
        self.assertEqual(impact, {"generations": 3, "writes": 3,
                                  "models": ["generate_image_gpt_image_2_5_flare", "seedance-2.0"],
                                  "sizes": ["1008x1344", "1024x1536"], "nodes": 1})

    def test_generation_step_with_model_and_size(self):
        steps = [{"tool": "generate_image",
                  "args": {"model": "gpt-image-2", "size": "1024x1536", "prompt": "海报"}}]
        impact = main.agent_plan_impact(steps)
        self.assertEqual(impact, {"generations": 1, "writes": 0, "models": ["gpt-image-2"],
                                  "sizes": ["1024x1536"], "nodes": 0})
        summary = main._agent_plan_summary(steps, impact)
        self.assertIn("gpt-image-2", summary)
        self.assertIn("1024x1536", summary)
        self.assertIn("1 次真实生成", summary)

    def test_model_size_dedupe_and_no_ratio_leak(self):
        steps = [{"tool": "generate_image", "args": {"model": "m1", "ratio": "1:1"}},
                 {"tool": "generate_image", "args": {"model": "m1", "ratio": "1:1"}},
                 {"tool": "generate_video", "args": {"ratio": "adaptive"}}]
        impact = main.agent_plan_impact(steps)
        self.assertEqual(impact["models"], ["m1"])
        self.assertEqual(impact["sizes"], ["1024x1024"])
        self.assertEqual(impact["generations"], 3)
        self.assertIn("3 次真实生成", main._agent_plan_summary(steps, impact))

    def test_plan_event_always_has_the_full_contract_shape(self):
        event = main._agent_plan_event("", [])
        self.assertEqual(set(event.keys()),
                         {"intent", "steps", "expected_output", "impact", "summary"})
        self.assertEqual(event["steps"], [])
        self.assertEqual(event["expected_output"], "")
        self.assertEqual(event["impact"], self.ZERO)
        self.assertTrue(event["intent"])
        self.assertTrue(event["summary"])


class AgentRunEndpointModeTests(unittest.TestCase):
    """/api/agent/run 整条链路：mode 与 approved_steps 真的传到了 producer。"""

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
        return chat, parse_events(chunks)

    def test_endpoint_plan_mode_returns_plan_without_executing(self):
        execute = AsyncMock(return_value={"ok": True, "result": {}, "message": "执行成功"})
        payload = main.AgentRunRequest(canvas_id="c1", instruction="来两张 3:4 海报", mode="plan")
        chat, events = self._drive(payload, {"intent": "出海报", "steps": plan_steps()[:1],
                                             "expected_output": "一张海报"}, execute)
        names = [name for name, _ in events]
        self.assertEqual(names.count("plan"), 1)
        self.assertEqual(names[-1], "done")
        self.assertEqual(execute.await_count, 0)
        self.assertEqual(chat.await_count, 1)
        done = [data for name, data in events if name == "done"][0]
        self.assertEqual(done["status"], "ok")

    def test_endpoint_approved_steps_skip_planning_and_execute(self):
        execute = AsyncMock(return_value={"ok": True, "result": {}, "message": "执行成功"})
        payload = main.AgentRunRequest(
            canvas_id="c1", instruction="来一张", mode="plan",
            approved_steps=[{"tool": "list_canvases", "args": {}, "description": "看画布"}])
        chat, events = self._drive(payload, {"done": True, "message": "完成"}, execute)
        names = [name for name, _ in events]
        self.assertEqual([call.args[0] for call in execute.await_args_list], ["list_canvases"])
        self.assertEqual(names.count("plan"), 1)
        self.assertEqual(names[-1], "done")
        self.assertEqual(chat.await_count, 1)


if __name__ == "__main__":
    unittest.main()
