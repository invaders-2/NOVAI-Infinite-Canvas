# -*- coding: utf-8 -*-
"""独立验证：画布助手「步数默认不限 + 等待不计步 + 服务端自动等生成结果」。

与实现者自带的 tests/test_agent_run_step_limits.py 是两套独立用例：
这里用「假 ctx + 假模型 + 假工具执行」直接驱动 main._agent_run_producer，
上下文用 server.agents.context.AgentRunContext 基类（默认实现全是空操作），
不经过 _CanvasRunContext / load_canvas，也不读真实画布文件。

覆盖验收项：
  1. max_steps 归一矩阵（缺省 / None / 0 / 负数 / 正数 / 脏值）与 env 刹车不可关；
  2. server/routes/agents.py 的文件上下文请求与 /api/agent/run 同一口径；
  3. 15 个成功步骤（>12）不会被 abort；正数上限仍按「只数占步数的工具」生效；
  4. check_task 成功不占步数，纯等待轮次不会把 max_steps=1 顶死；
  5. 运行时长上限到点 abort，文案是「已达到运行时长上限 N 分钟，停止后续步骤」；
  6. 经典画布一轮后自动轮询 task_get 到终态，成功 / 失败都写进 history 回灌下一轮；
  7. BEAT 只走 wait_canvas_results，不会两套等待同时触发；
  8. 取消后等待立即退出；
  9. task-3 修复后的行为：只从非只读步骤收 task_id（check_task / get_canvas 读到的旧任务
     不再被当成新任务等待）、同一 task_id 跨轮只等一次、自动等待的 history index 取负数不撞号；
  10. run 时长上限传进等待：到点停止等待并标记「已达到运行时长上限」，不写进失败记录；
  11. 正数 max_steps 中途截断时只扫本轮结果（round_results_start），不重扫上一轮。
"""
import asyncio
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-verify-step-limits-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main  # noqa: E402
from server.agents.context import AgentRunContext  # noqa: E402


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


# ---------------------------------------------------------------------------
# 假上下文：只用基类默认实现，覆盖测试需要观察的两三个方法
# ---------------------------------------------------------------------------
TOOLS = {
    "create_node": {"name": "create_node", "description": "建节点"},
    "check_task": {"name": "check_task", "description": "查任务"},
    "get_canvas": {"name": "get_canvas", "description": "读画布"},
    "generate_image": {"name": "generate_image", "description": "出图"},
    "generate_video": {"name": "generate_video", "description": "出视频"},
}


class FakeCtx(AgentRunContext):
    def __init__(self):
        super().__init__("verify-canvas")
        self.kind = "fake-classic"
        self.beat_waits = []          # BEAT 等待调用记录
        self.beat_outcomes = []
        self.persisted = {}           # persist() 收到的收尾数据（history 在这里取）

    def tools(self):
        return dict(TOOLS)

    def tool_catalog(self):
        return []

    def build_system_prompt(self, snapshot, tools_json_text, history_text, vision_text=""):
        return ""

    def load(self):
        return {"nodes": []}

    def confirmation_needed(self, steps, confirmed=False):
        # 写/生成闸门不在本组用例的验证范围：统一放行（生产行为由 draw 上下文负责）
        return {"needed": False, "tools": []}

    def step_units(self, tool, args):
        # 生成类工具按 1 次生成计价（与画布上下文一致，供批准预算用例使用）
        return 1 if tool in ("generate_image", "generate_video") else 0

    def after_step(self, tool, args, result, units, before, after, undo_log):
        return {"ops": {}, "mutated": False, "task_ids": [], "units": int(units or 0)}

    def persist(self, session, status, message, history, rounds, steps_executed, mutated,
                run_id, intent, instruction, focus, plan=None, used_units=0):
        self.persisted = {"status": status, "message": message, "history": list(history or []),
                          "rounds": rounds, "steps_executed": steps_executed}

    async def wait_canvas_results(self, node_ids, emit, cancelled):
        self.beat_waits.append(list(node_ids))
        emit("waiting", {"text": "BEAT 等画布结果：%s" % (node_ids,), "task_ids": []})
        return list(self.beat_outcomes)


def chat_stub():
    return {"provider": "fake", "base": "http://127.0.0.1:1", "headers": {},
            "model": "fake-chat", "provider_cfg": {}}


def make_req(max_steps=0, renderer="", mode="run"):
    return {"run_id": "run_verify", "instruction": "跑任务",
            "focus": {}, "history": [], "chat": chat_stub(),
            "max_steps": max_steps, "mode": mode, "approved_steps": [],
            "auto_execute": True, "renderer": renderer, "context": FakeCtx()}


def step(tool, args=None, desc=""):
    return {"tool": tool, "args": args if isinstance(args, dict) else {}, "description": desc or tool}


def ok_result(result=None, message="执行成功"):
    return {"ok": True, "result": result if isinstance(result, (dict, list)) else {}, "message": message}


def parse_events(chunks):
    events = []
    for chunk in chunks:
        if not isinstance(chunk, str) or not chunk.startswith("event: "):
            continue
        head, _, body = chunk.partition("\n")
        events.append((head[len("event: "):], json.loads(body.split("data: ", 1)[1])))
    return events


def drive(req, replies, execute=None, task_get=None, model_calls=None, patches=()):
    """跑完一次 producer，返回 (events, model_calls)。replies 不够时自动 done。"""
    calls = model_calls if model_calls is not None else []
    execute = execute or (lambda tool, args: _async_ok())

    async def fake_model(chat, messages):
        calls.append(messages[-1]["content"])
        index = len(calls) - 1
        reply = replies[index] if index < len(replies) else {"done": True, "message": "收尾"}
        return json.dumps(reply, ensure_ascii=False)

    ctx_patches = [
        patch.object(main, "_agent_run_chat", new=fake_model),
        patch.object(main, "agent_execute_step", new=execute),
        # 自动等待的两条节奏常量：测试不真睡
        patch.object(main, "AGENT_RUN_TASK_WAIT_POLL_SECONDS", 0),
        patch.object(main, "AGENT_RUN_TASK_WAIT_PING_SECONDS", 0),
    ]
    if task_get is not None:
        ctx_patches.append(patch.object(main, "task_get", side_effect=task_get))
    ctx_patches.extend(patches)

    async def go():
        queue = asyncio.Queue()
        with contextlib.ExitStack() as stack:
            for item in ctx_patches:
                stack.enter_context(item)
            with contextlib.redirect_stdout(io.StringIO()):
                await main._agent_run_producer(req, queue)
        out = []
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                break
            out.append(item)
        return out

    return parse_events(asyncio.run(go())), calls


async def _async_ok():
    return ok_result()


def done_event(events):
    done = [data for name, data in events if name == "done"]
    assert done, "没有 done 事件"
    return done[-1]


# ---------------------------------------------------------------------------
# 1) 归一矩阵 / env 刹车 / 请求入口
# ---------------------------------------------------------------------------
class NormalizeAndEntryTests(unittest.TestCase):

    def test_normalize_matrix(self):
        cases = {None: 0, 0: 0, -1: 0, -999: 0, "": 0, "脏": 0, 5: 5, "7": 7,
                 24: 24, 25: 24, 1000: 24, 12.9: 12}
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(main._agent_run_normalize_max_steps(raw), expected)

    def test_env_brakes_cannot_be_disabled(self):
        # 0 / 负数 / 脏值都不能把刹车关掉；正整数照用
        for name, raw, expected in (("NOVAI_AGENT_MAX_ROUNDS", "0", 20),
                                    ("NOVAI_AGENT_MAX_ROUNDS", "-3", 20),
                                    ("NOVAI_AGENT_MAX_ROUNDS", "abc", 20),
                                    ("NOVAI_AGENT_MAX_ROUNDS", "7", 7),
                                    ("NOVAI_AGENT_MAX_SECONDS", "0", 3600),
                                    ("NOVAI_AGENT_MAX_SECONDS", "90", 90)):
            with self.subTest(name=name, raw=raw), patch.dict(os.environ, {name: raw}):
                self.assertEqual(main._agent_run_limit_from_env(name, 20 if "ROUNDS" in name else 3600),
                                 expected)

    def test_request_default_is_unlimited_and_null_is_unlimited(self):
        from main import AgentRunRequest
        self.assertEqual(AgentRunRequest(canvas_id="c1", instruction="看看").max_steps, 0)
        self.assertEqual(main._agent_run_normalize_max_steps(
            AgentRunRequest(canvas_id="c1", instruction="看看", max_steps=None).max_steps), 0)

    def test_files_context_route_uses_same_rule(self):
        import server.routes.agents as agents_route
        build = agents_route._build_run_request
        agents_route.deps.bind(AGENT_RUN_MAX_STEPS_CAP=24,
                               AGENT_RUN_NORMALIZE_FOCUS=lambda value: {})
        try:
            for raw, expected in ((0, 0), (-2, 0), (None, 0), (5, 5), (999, 24)):
                with self.subTest(raw=raw):
                    req = build({"id": "cap", "name": "能力", "deliverables": []}, {"run_id": "r1"},
                                [], {"max_steps": raw}, chat_stub())
                    self.assertEqual(req["max_steps"], expected)
        finally:
            for key in ("AGENT_RUN_MAX_STEPS_CAP", "AGENT_RUN_NORMALIZE_FOCUS"):
                agents_route.deps._bound.pop(key, None)


# ---------------------------------------------------------------------------
# 2) 步数：15 步不 abort / 正数仍生效 / check_task 不计步
# ---------------------------------------------------------------------------
class StepBudgetTests(unittest.TestCase):

    def test_fifteen_successful_steps_are_not_aborted(self):
        steps = [step("create_node", {"canvas_id": "c1", "type": "prompt", "prompt": "第%d条" % i}, "建节点")
                 for i in range(15)]
        events, calls = drive(make_req(0), [{"thought": "批量建片", "steps": steps, "done": False},
                                            {"done": True, "message": "15 个节点都建好了"}])
        done = done_event(events)
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["steps_executed"], 15)
        self.assertNotIn("最大步数上限", done["message"])
        # 回灌给模型的进度里不能出现 /0 这种除零写法
        self.assertIn("15 步（不限步数）", calls[1])
        self.assertNotIn("/0 步", calls[1])

    def test_run_start_echoes_zero_when_unlimited(self):
        events, _ = drive(make_req(0), [{"done": True, "message": "直接回答"}])
        start = [data for name, data in events if name == "run_start"][0]
        self.assertEqual(start["max_steps"], 0)

    def test_positive_cap_still_aborts_and_counts_only_paid_tools(self):
        # 第一轮：1 个 create_node（占 1 步）+ 1 个 check_task（不占步）
        async def execute(tool, args):
            if tool == "check_task":
                return ok_result({"task_id": "t-old", "status": "succeeded"})
            return ok_result({})

        replies = [{"steps": [step("create_node", {"type": "prompt"}), step("check_task", {"task_id": "t-old"})]},
                   {"steps": [step("create_node", {"type": "prompt"}), step("create_node", {"type": "prompt"})]}]
        events, _ = drive(make_req(2), replies, execute=execute, task_get=lambda tid: None)
        done = done_event(events)
        self.assertEqual(done["status"], "aborted")
        self.assertIn("已达到最大步数上限 2，停止后续步骤", done["message"])
        # 只数 create_node：第一轮 1 个 + 第二轮 1 个 = 2，停在第二轮中途
        self.assertEqual(done["steps_executed"], 2)

    def test_check_task_alone_never_wedges_max_steps_one(self):
        async def execute(tool, args):
            if tool == "check_task":
                return ok_result({"task_id": "t-done", "status": "succeeded"})
            return ok_result({})

        replies = [{"steps": [step("check_task", {"task_id": "t-done"})]},
                   {"done": True, "message": "查完了"}]
        events, calls = drive(make_req(1), replies, execute=execute, task_get=lambda tid: None)
        done = done_event(events)
        self.assertEqual(done["status"], "ok")          # 没有被 max_steps=1 顶死
        self.assertEqual(done["steps_executed"], 0)      # 查任务不占步数
        self.assertNotIn("最大步数上限", done["message"])
        self.assertEqual(len(calls), 2)


# ---------------------------------------------------------------------------
# 3) 运行时长刹车
# ---------------------------------------------------------------------------
class TimeBudgetTests(unittest.TestCase):

    def test_elapsed_time_makes_the_limit_trigger(self):
        # 用慢模型把运行时间真实推过上限，验证「按实际耗时刹车」而不是只看轮次
        async def slow_model(chat, messages):
            calls.append(messages[-1]["content"])
            await asyncio.sleep(0.6)
            return json.dumps({"steps": [step("create_node", {"type": "prompt"})]})

        calls = []
        events = None

        async def go():
            queue = asyncio.Queue()
            with contextlib.ExitStack() as stack:
                for item in (patch.object(main, "_agent_run_chat", new=slow_model),
                             patch.object(main, "agent_execute_step", new=lambda t, a: _async_ok()),
                             patch.object(main, "AGENT_RUN_MAX_SECONDS", 1)):
                    stack.enter_context(item)
                with contextlib.redirect_stdout(io.StringIO()):
                    await main._agent_run_producer(make_req(0), queue)
            out = []
            while not queue.empty():
                item = queue.get_nowait()
                if item is None:
                    break
                out.append(item)
            return out

        events = parse_events(asyncio.run(go()))
        done = done_event(events)
        self.assertEqual(done["status"], "aborted")
        self.assertIn("已达到运行时长上限 1 分钟，停止后续步骤", done["message"])
        self.assertGreaterEqual(len(calls), 1)
        self.assertGreaterEqual(done["rounds"], 1)


# ---------------------------------------------------------------------------
# 4) 经典画布自动等生成结果
# ---------------------------------------------------------------------------
class ClassicAutoWaitTests(unittest.TestCase):

    def test_success_result_is_written_back_for_next_round(self):
        polls = {"n": 0}

        def task_get(task_id):
            if task_id != "t1":
                return None
            polls["n"] += 1
            if polls["n"] < 3:
                return {"id": "t1", "kind": "video", "status": "provider_processing"}
            return {"id": "t1", "kind": "video", "status": "succeeded",
                    "result": {"url": "http://local/out/v1.mp4"}}

        async def execute(tool, args):
            return ok_result({"node_id": "v1", "task_id": "t1", "generation_units": 1})

        events, calls = drive(
            make_req(0),
            [{"steps": [step("generate_video", {"canvas_id": "c1", "prompt": "海边"})]},
             {"done": True, "message": "视频好了"}],
            execute=execute, task_get=task_get)
        done = done_event(events)
        self.assertEqual(done["status"], "ok")
        self.assertIn("waiting", [name for name, _ in events])
        self.assertIn("生成结果", calls[1])
        self.assertIn("http://local/out/v1.mp4", calls[1])

    def test_failed_result_is_written_back_and_reported(self):
        def task_get(task_id):
            return {"id": task_id, "kind": "online-image", "status": "failed",
                    "error": "上游 400：提示词违规"}

        async def execute(tool, args):
            return ok_result({"node_id": "i1", "task_id": "t2", "generation_units": 1})

        events, calls = drive(
            make_req(0),
            [{"steps": [step("generate_image", {"canvas_id": "c1", "prompt": "海报"})]},
             {"done": True, "message": "没出成"}],
            execute=execute, task_get=task_get)
        done = done_event(events)
        self.assertIn("失败记录", done["message"])
        self.assertIn("上游 400：提示词违规", done["message"])
        self.assertIn("生成结果", calls[1])
        self.assertIn("上游 400：提示词违规", calls[1])

    def test_task_that_disappeared_is_reported_not_hung(self):
        async def execute(tool, args):
            return ok_result({"task_id": "t-gone"})

        # 提交时 task_get 能查到（过滤要用），等待时返回 None 模拟服务重启
        state = {"first": True}

        def task_get(task_id):
            if state["first"]:
                state["first"] = False
                return {"id": task_id, "kind": "video", "status": "provider_processing"}
            return None

        events, _ = drive(make_req(0),
                          [{"steps": [step("generate_video", {"canvas_id": "c1"})]},
                           {"done": True, "message": "结束"}],
                          execute=execute, task_get=task_get)
        done = done_event(events)
        self.assertIn("找不到了", done["message"])


# ---------------------------------------------------------------------------
# 4b) plan 模式不进自动等待
# ---------------------------------------------------------------------------
class PlanModeNoWaitTests(unittest.TestCase):

    def test_plan_mode_never_executes_or_waits(self):
        executed = []

        async def execute(tool, args):
            executed.append(tool)
            return ok_result({"task_id": "t-plan"})

        events, calls = drive(make_req(0, mode="plan"),
                              [{"steps": [step("generate_image", {"canvas_id": "c1"})]}],
                              execute=execute,
                              task_get=lambda tid: {"id": tid, "kind": "image", "status": "succeeded"})
        self.assertEqual(executed, [])
        self.assertNotIn("waiting", [name for name, _ in events])
        self.assertTrue([d for name, d in events if name == "plan"])
        self.assertEqual(len(calls), 1)


# ---------------------------------------------------------------------------
# 5) BEAT 路径不被经典等待影响
# ---------------------------------------------------------------------------
class BeatPathTests(unittest.TestCase):

    def test_beat_waits_only_through_canvas_and_never_double_waits(self):
        probe = AsyncMock()

        async def execute(tool, args):
            # BEAT：生成交回画布引擎，返回 queued_on_canvas + node_id（故意也带 task_id）
            return ok_result({"status": "queued_on_canvas", "node_id": "beat-1", "task_id": "t-beat"})

        task_get = lambda tid: {"id": tid, "kind": "image", "status": "succeeded",
                                "result": {"url": "http://local/out/beat.png"}}
        req = make_req(0, renderer="beat")
        req["context"].beat_outcomes = [{"ok": True, "text": "图片生成成功，结果 http://local/out/beat.png"}]
        events, calls = drive(
            req,
            [{"steps": [step("generate_image", {"canvas_id": "c1", "prompt": "海报"})]},
             {"done": True, "message": "画布已开始生成"}],
            execute=execute, task_get=task_get,
            patches=(patch.object(main, "_agent_run_wait_tasks", new=probe),))
        self.assertEqual(req["context"].beat_waits, [["beat-1"]])
        done = done_event(events)
        self.assertEqual(done["status"], "ok")
        probe.assert_not_called()          # 经典 task_get 等待没有触发
        self.assertIn("画布生成结果", calls[1])


# ---------------------------------------------------------------------------
# 6) 取消：等待立即退出
# ---------------------------------------------------------------------------
class CancelTests(unittest.TestCase):

    def test_cancel_flag_breaks_wait_promptly(self):
        state = {"n": 0}
        tasks = [{"id": "t-x", "kind": "video", "status": "provider_processing"}]
        emitted = []

        def task_get(task_id):
            return dict(tasks[0])

        def cancelled():
            state["n"] += 1
            return state["n"] > 1

        async def go():
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(main, "task_get", side_effect=task_get))
                stack.enter_context(patch.object(main, "AGENT_RUN_TASK_WAIT_POLL_SECONDS", 0))
                started = time.monotonic()
                outcomes = await main._agent_run_wait_tasks(["t-x"], lambda e, d: emitted.append((e, d)),
                                                            cancelled)
                return outcomes, time.monotonic() - started

        outcomes, elapsed = asyncio.run(go())
        self.assertLess(elapsed, 2.0)       # 没有卡到 1800 秒的 video 上限
        self.assertEqual(outcomes, [])      # 取消后不再伪造结果
        self.assertTrue(any(name == "waiting" for name, _ in emitted))

    def test_wait_times_out_with_reason(self):
        emitted = []

        def task_get(task_id):
            return {"id": task_id, "kind": "image", "status": "provider_processing"}

        async def go():
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(main, "task_get", side_effect=task_get))
                stack.enter_context(patch.object(main, "AGENT_RUN_TASK_WAIT_POLL_SECONDS", 0))
                stack.enter_context(patch.object(main, "AGENT_RUN_TASK_WAIT_SECONDS", {"image": 0.05}))
                return await main._agent_run_wait_tasks(["t-slow"],
                                                        lambda e, d: emitted.append((e, d)),
                                                        lambda: False)

        outcomes = asyncio.run(go())
        self.assertEqual(len(outcomes), 1)
        self.assertFalse(outcomes[0]["ok"])
        self.assertIn("还没出结果", outcomes[0]["text"])


# ---------------------------------------------------------------------------
# 7) 原有护栏没被改坏：失败跳过 / 无进展 / 批准预算 / 轮次刹车
# ---------------------------------------------------------------------------
class ExistingGuardTests(unittest.TestCase):

    def test_same_tool_args_failing_twice_is_skipped(self):
        async def execute(tool, args):
            return {"ok": False, "error": "上游 500", "code": "tool_error"}

        same = [step("generate_image", {"canvas_id": "c1", "prompt": "同一个提示词"}),
                step("generate_image", {"canvas_id": "c1", "prompt": "同一个提示词"})]
        events, _ = drive(make_req(0),
                          [{"steps": same}, {"steps": [same[0]]}, {"done": True, "message": "结束"}],
                          execute=execute, task_get=lambda tid: None)
        codes = [d.get("code") for name, d in events if name == "step_result"]
        self.assertIn("skipped_after_failures", codes)
        done = done_event(events)
        self.assertEqual(done["status"], "failed")
        self.assertIn("连续两轮没有任何步骤执行成功", done["message"])

    def test_two_rounds_without_success_stop(self):
        async def execute(tool, args):
            return {"ok": False, "error": "节点不存在", "code": "node_not_found"}

        events, calls = drive(make_req(0),
                              [{"steps": [step("create_node", {"type": "prompt", "n": 1})]},
                               {"steps": [step("create_node", {"type": "prompt", "n": 2})]},
                               {"done": True, "message": "不该走到这里"}],
                              execute=execute, task_get=lambda tid: None)
        done = done_event(events)
        self.assertEqual(done["status"], "failed")
        self.assertIn("连续两轮没有任何步骤执行成功", done["message"])
        self.assertEqual(len(calls), 2)

    def test_approved_generation_budget_still_blocks_extra_spending(self):
        approved = [{"tool": "generate_image",
                     "args": {"canvas_id": "c1", "prompt": "批准的图"},
                     "description": "按批准方案出图"}]
        req = make_req(0)
        req["approved_steps"] = approved

        async def execute(tool, args):
            return ok_result({"node_id": "i1"})

        events, _ = drive(req,
                          [{"steps": [step("generate_image", {"canvas_id": "c1", "prompt": "多出来的图"})]},
                           {"done": True, "message": "结束"}],
                          execute=execute, task_get=lambda tid: None)
        confirm = [d for name, d in events if name == "confirm_required"]
        self.assertTrue(confirm)
        self.assertEqual(confirm[0]["confirm_kind"], "budget")
        done = done_event(events)
        self.assertEqual(done["status"], "ok")
        self.assertIn("已按你批准的方案执行完", done["message"])

    def test_max_rounds_brake_still_stops(self):
        req = make_req(0)
        req["context"].max_rounds = 3
        replies = [{"steps": [step("create_node", {"type": "prompt", "n": i})]} for i in range(5)]
        events, calls = drive(req, replies)
        done = done_event(events)
        self.assertEqual(done["status"], "aborted")
        self.assertIn("已达到最大轮次上限 3，停止后续步骤", done["message"])
        self.assertEqual(done["rounds"], 3)
        self.assertEqual(len(calls), 3)


# ---------------------------------------------------------------------------
# 7) task-3 修复后的行为：旧 task_id 不再二次等待 / 跨轮只等一次 / index 不撞号
# ---------------------------------------------------------------------------
class WaitDedupeTests(unittest.TestCase):
    """task-2 这几个用例原来断言的是旧 bug（重复等待）；task-3 修好后改成断言期望行为：
    - 只从「非只读步骤」的成功结果里收 task_id（main.py:42228-42233）；
    - 同一个 task_id 记在 run 级 waited_task_ids，跨轮只等一次（42298-42308）；
    - 等待记录的 history index 取负数（42307），不再和步骤序号撞号。"""

    def test_check_task_on_old_task_is_not_waited_again(self):
        def task_get(task_id):
            return {"id": task_id, "kind": "video", "status": "succeeded",
                    "result": {"url": "http://local/out/old.mp4"}}

        async def execute(tool, args):
            if tool == "check_task":
                return ok_result({"task_id": "t-old", "status": "succeeded",
                                  "result_url": "http://local/out/old.mp4"})
            return ok_result({"node_id": "v1", "task_id": "t-old"})

        events, calls = drive(
            make_req(0),
            [{"steps": [step("generate_video", {"canvas_id": "c1"})]},
             {"steps": [step("check_task", {"task_id": "t-old"})]},
             {"done": True, "message": "结束"}],
            execute=execute, task_get=task_get)
        waiting = [d for name, d in events if name == "waiting"]
        self.assertEqual(len(waiting), 1)                        # 只有第一轮新任务等了一次
        self.assertEqual(waiting[0]["task_ids"], ["t-old"])
        self.assertEqual(calls[2].count("生成结果 成功"), 1)      # 结果只回灌一次

    def test_get_canvas_task_id_is_not_waited(self):
        # 经典画布 get_canvas 的节点摘要仍带 task_id（这是只读工具，不该当成新任务）
        def task_get(task_id):
            return {"id": task_id, "kind": "image", "status": "succeeded",
                    "result": {"url": "http://local/out/a.png"}}

        async def execute(tool, args):
            if tool == "get_canvas":
                return ok_result({"canvas": {"nodes": [{"id": "n1", "type": "image",
                                                        "task_id": "t-prev"}]}})
            return ok_result({"node_id": "n1", "task_id": "t-new"})

        events, _ = drive(
            make_req(0),
            [{"steps": [step("generate_image", {"canvas_id": "c1"})]},
             {"steps": [step("get_canvas", {"canvas_id": "c1"})]},
             {"done": True, "message": "结束"}],
            execute=execute, task_get=task_get)
        waiting = [d for name, d in events if name == "waiting"]
        self.assertEqual(len(waiting), 1)
        self.assertEqual(waiting[0]["task_ids"], ["t-new"])      # t-prev 从来没进过等待
        self.assertNotIn("t-prev", [tid for d in waiting for tid in (d.get("task_ids") or [])])

    def test_same_task_id_is_waited_only_once_across_rounds(self):
        # 第二轮一个非只读步骤又返回了同一个 task_id：跨轮去重，不再等第二次
        def task_get(task_id):
            return {"id": task_id, "kind": "image", "status": "succeeded",
                    "result": {"url": "http://local/out/same.png"}}

        async def execute(tool, args):
            return ok_result({"node_id": "i1", "task_id": "t-same"})

        events, calls = drive(
            make_req(0),
            [{"steps": [step("generate_image", {"canvas_id": "c1", "prompt": "图一"})]},
             {"steps": [step("generate_image", {"canvas_id": "c1", "prompt": "图一（重试）"})]},
             {"done": True, "message": "结束"}],
            execute=execute, task_get=task_get)
        waiting = [d for name, d in events if name == "waiting"]
        self.assertEqual(len(waiting), 1)
        self.assertEqual(calls[2].count("生成结果 成功"), 1)

    def test_wait_record_index_never_collides_with_step_index(self):
        def task_get(task_id):
            return {"id": task_id, "kind": "image", "status": "succeeded",
                    "result": {"url": "http://local/out/%s.png" % task_id}}

        async def execute(tool, args):
            return ok_result({"task_id": "t-%d" % len(args.get("prompt") or "")})

        req = make_req(0)
        events, _ = drive(
            req,
            [{"steps": [step("generate_image", {"canvas_id": "c1", "prompt": "a"})]},
             {"steps": [step("generate_image", {"canvas_id": "c1", "prompt": "bb"})]},
             {"done": True, "message": "结束"}],
            execute=execute, task_get=task_get)
        history = req["context"].persisted["history"]
        step_indexes = [rec["index"] for rec in history if rec.get("tool") != "生成结果"]
        wait_indexes = [rec["index"] for rec in history if rec.get("tool") == "生成结果"]
        self.assertEqual(len(wait_indexes), 2)
        self.assertEqual(wait_indexes, [-1, -2])                 # 负数独立编号，跨轮递增
        self.assertTrue(all(isinstance(i, int) and i >= 0 for i in step_indexes))
        self.assertFalse(set(step_indexes) & set(wait_indexes))  # 不再撞号

    def test_nested_canvas_cli_result_is_still_collected(self):
        # canvas_cli 会把工具结果再包一层：嵌套里的 task_id 仍要收到
        def task_get(task_id):
            return {"id": task_id, "kind": "image", "status": "succeeded",
                    "result": {"url": "http://local/out/n.png"}}

        async def execute(tool, args):
            return ok_result({"value": {"result": {"task_id": "t-nested", "node_id": "n1"}}})

        events, _ = drive(make_req(0),
                          [{"steps": [step("generate_image", {"canvas_id": "c1"})]},
                           {"done": True, "message": "结束"}],
                          execute=execute, task_get=task_get)
        waiting = [d for name, d in events if name == "waiting"]
        self.assertEqual(len(waiting), 1)
        self.assertEqual(waiting[0]["task_ids"], ["t-nested"])


# ---------------------------------------------------------------------------
# 8) 正数 max_steps 中途截断：不重扫上一轮结果（round_results_start 切片）
# ---------------------------------------------------------------------------
class MidRoundSliceTests(unittest.TestCase):

    def test_mid_round_truncation_does_not_rescan_previous_round(self):
        def task_get(task_id):
            return {"id": task_id, "kind": "image", "status": "succeeded",
                    "result": {"url": "http://local/out/a.png"}}

        async def execute(tool, args):
            return ok_result({"node_id": "i1", "task_id": "t1"})

        req = make_req(3)
        events, _ = drive(
            req,
            [{"steps": [step("generate_image", {"canvas_id": "c1", "prompt": "图一"}),
                        step("create_node", {"type": "prompt"})]},
             {"steps": [step("create_node", {"type": "prompt"}),
                        step("create_node", {"type": "prompt"}),
                        step("create_node", {"type": "prompt"})]}],
            execute=execute, task_get=task_get)
        waiting = [d for name, d in events if name == "waiting"]
        self.assertEqual(len(waiting), 1)        # 第二轮被截断，但没有拿上一轮的 t1 再等一遍
        history = req["context"].persisted["history"]
        self.assertEqual(len([r for r in history if r.get("tool") == "生成结果"]), 1)
        done = done_event(events)
        self.assertEqual(done["status"], "aborted")
        self.assertIn("已达到最大步数上限 3", done["message"])


# ---------------------------------------------------------------------------
# 9) run 时长上限传进等待：到点就停，不当成生成失败
# ---------------------------------------------------------------------------
class DeadlineTests(unittest.TestCase):

    def test_deadline_stops_wait_before_media_timeout(self):
        emitted = []

        def task_get(task_id):
            return {"id": task_id, "kind": "video", "status": "provider_processing"}

        async def go():
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(main, "task_get", side_effect=task_get))
                stack.enter_context(patch.object(main, "AGENT_RUN_TASK_WAIT_POLL_SECONDS", 0.05))
                started = time.monotonic()
                outcomes = await main._agent_run_wait_tasks(
                    ["t-slow"], lambda e, d: emitted.append((e, d)),
                    lambda: False, deadline=time.monotonic() + 0.25)
                return outcomes, time.monotonic() - started

        outcomes, elapsed = asyncio.run(go())
        self.assertLess(elapsed, 2.0)                     # 远早于 video 的 1800s 媒体上限
        self.assertEqual(len(outcomes), 1)
        self.assertFalse(outcomes[0]["ok"])
        self.assertTrue(outcomes[0]["timeout"])           # 标记「到运行时长上限」而不是生成失败
        self.assertIn("已达到运行时长上限", outcomes[0]["text"])
        self.assertNotIn("生成失败", outcomes[0]["text"])
        self.assertTrue(any(name == "waiting" for name, _ in emitted))

    def test_run_deadline_aborts_run_without_failure_note(self):
        def task_get(task_id):
            return {"id": task_id, "kind": "video", "status": "provider_processing"}

        async def execute(tool, args):
            return ok_result({"node_id": "v1", "task_id": "t-never"})

        req = make_req(0)
        started = time.monotonic()
        events, _ = drive(
            req,
            [{"steps": [step("generate_video", {"canvas_id": "c1", "prompt": "长视频"})]},
             {"done": True, "message": "不该走到这里"}],
            execute=execute, task_get=task_get,
            patches=(patch.object(main, "AGENT_RUN_MAX_SECONDS", 0.4),
                     patch.object(main, "AGENT_RUN_TASK_WAIT_POLL_SECONDS", 0.05)))
        elapsed = time.monotonic() - started
        done = done_event(events)
        self.assertLess(elapsed, 3.0)                     # 0.4s 到点就停，没等到 1800s
        self.assertEqual(done["status"], "aborted")
        self.assertIn("已达到运行时长上限", done["message"])
        self.assertNotIn("失败记录", done["message"])      # 等超时不算生成失败
        wait_records = [r for r in req["context"].persisted["history"] if r.get("tool") == "生成结果"]
        self.assertEqual(len(wait_records), 1)
        self.assertFalse(wait_records[0]["ok"])
        self.assertIn("运行时长上限", wait_records[0]["error"])


# ---------------------------------------------------------------------------
# 10) deadline 顺序（task-5）：先 poll 再判 deadline，已成功的任务不被误标 timeout
# ---------------------------------------------------------------------------
class DeadlineOrderTests(unittest.TestCase):

    def test_classic_succeeded_task_beats_expired_deadline(self):
        def task_get(task_id):
            return {"id": task_id, "kind": "image", "status": "succeeded",
                    "result": {"url": "http://local/out/done.png"}}

        async def go():
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(main, "task_get", side_effect=task_get))
                stack.enter_context(patch.object(main, "AGENT_RUN_TASK_WAIT_POLL_SECONDS", 0))
                return await main._agent_run_wait_tasks(["t-done"], lambda e, d: None,
                                                        lambda: False, deadline=time.monotonic() - 1)

        outcomes = asyncio.run(go())
        self.assertEqual(len(outcomes), 1)
        self.assertTrue(outcomes[0]["ok"])                  # 已经成功的任务照实报成功
        self.assertNotIn("timeout", outcomes[0])
        self.assertIn("生成成功", outcomes[0]["text"])


# ---------------------------------------------------------------------------
# 11) 真实 BEAT 上下文：wait_canvas_results 也认 deadline，且先 poll 再判到点
# ---------------------------------------------------------------------------
def beat_ctx():
    return main._CanvasRunContext({"canvas_id": "c1"})


class BeatRealWaitTests(unittest.TestCase):

    def test_beat_wait_stops_at_run_deadline(self):
        canvas = {"id": "c1", "nodes": [{"id": "n1", "kind": "video", "title": "镜头", "data": {}}]}
        emitted = []

        async def go():
            with patch.object(main, "load_canvas", return_value=canvas):
                started = time.monotonic()
                out = await beat_ctx().wait_canvas_results(
                    ["n1"], lambda e, d: emitted.append((e, d)), lambda: False,
                    deadline=time.monotonic() + 0.15)
                return out, time.monotonic() - started

        outcomes, elapsed = asyncio.run(go())
        self.assertLess(elapsed, 2.0)                       # 远早于 video 的 1800s 节点上限
        self.assertEqual(len(outcomes), 1)
        self.assertFalse(outcomes[0]["ok"])
        self.assertTrue(outcomes[0]["timeout"])
        self.assertIn("运行时长上限", outcomes[0]["text"])
        self.assertNotIn("生成失败", outcomes[0]["text"])
        self.assertTrue(any(name == "waiting" for name, _ in emitted))

    def test_beat_done_node_reported_even_when_deadline_already_passed(self):
        canvas = {"id": "c1", "nodes": [{"id": "n1", "kind": "video", "title": "镜头",
                                         "data": {"agentDone": {"ok": True, "url": "http://local/v.mp4"}}}]}

        async def go():
            with patch.object(main, "load_canvas", return_value=canvas):
                return await beat_ctx().wait_canvas_results(["n1"], lambda e, d: None,
                                                            lambda: False,
                                                            deadline=time.monotonic() - 1)

        outcomes = asyncio.run(go())
        self.assertEqual(len(outcomes), 1)
        self.assertTrue(outcomes[0]["ok"])                  # 先 poll：已完成的节点不会被到点误标
        self.assertIn("生成成功", outcomes[0]["text"])


# ---------------------------------------------------------------------------
# 12) producer 的 BEAT 分支：3 参 ctx 兼容 / 4 参 ctx 收 deadline / 负数 index / runtime_limit
# ---------------------------------------------------------------------------
class DeadlineAwareCtx(FakeCtx):
    """4 参签名（带 deadline）的上下文桩：验证 producer 会把 run deadline 传进去。"""

    def __init__(self):
        super().__init__()
        self.deadline_seen = "missing"

    async def wait_canvas_results(self, node_ids, emit, cancelled, deadline=None):
        self.deadline_seen = deadline
        return await super().wait_canvas_results(node_ids, emit, cancelled)


class BeatProducerCompatTests(unittest.TestCase):

    @staticmethod
    def _beat_execute():
        async def execute(tool, args):
            return ok_result({"status": "queued_on_canvas", "node_id": "beat-1", "task_id": "t-beat"})
        return execute

    def test_three_arg_ctx_is_called_without_deadline_kwarg(self):
        # 老签名 (node_ids, emit, cancelled)：不崩、被调用一次、结果照常回灌
        req = make_req(0, renderer="beat")
        req["context"].beat_outcomes = [{"ok": True, "text": "图片生成成功，结果 http://local/beat.png"}]
        events, calls = drive(
            req,
            [{"steps": [step("generate_image", {"canvas_id": "c1"})]},
             {"done": True, "message": "结束"}],
            execute=self._beat_execute(),
            task_get=lambda tid: {"id": tid, "kind": "image", "status": "succeeded"})
        self.assertEqual(req["context"].beat_waits, [["beat-1"]])
        done = done_event(events)
        self.assertEqual(done["status"], "ok")
        self.assertIn("画布生成结果", calls[1])

    def test_four_arg_ctx_receives_run_deadline(self):
        req = make_req(0, renderer="beat")
        req["context"] = DeadlineAwareCtx()
        req["context"].beat_outcomes = [{"ok": True, "text": "图片生成成功，结果 http://local/beat.png"}]
        drive(req,
              [{"steps": [step("generate_image", {"canvas_id": "c1"})]},
               {"done": True, "message": "结束"}],
              execute=self._beat_execute(),
              task_get=lambda tid: {"id": tid, "kind": "image", "status": "succeeded"})
        deadline = req["context"].deadline_seen
        self.assertIsInstance(deadline, float)              # 传进来了，不是默认的 None
        self.assertGreater(deadline, time.monotonic())      # 本次 run 的时长上限（默认 3600s 后）

    def test_beat_timeout_record_is_runtime_limit_without_failure_note(self):
        req = make_req(0, renderer="beat")
        req["context"].beat_outcomes = [{
            "ok": False, "timeout": True,
            "text": "镜头 还在生成，已达到运行时长上限，先停止等待；结果出来后显示在节点上"}]
        events, _ = drive(
            req,
            [{"steps": [step("generate_image", {"canvas_id": "c1"})]},
             {"done": True, "message": "结束"}],
            execute=self._beat_execute(),
            task_get=lambda tid: {"id": tid, "kind": "image", "status": "processing"})
        done = done_event(events)
        self.assertNotIn("失败记录", done["message"])        # 到点停止等待不算失败
        history = req["context"].persisted["history"]
        records = [r for r in history if r.get("tool") == "画布生成结果"]
        self.assertEqual(len(records), 1)
        self.assertFalse(records[0]["ok"])
        self.assertEqual(records[0]["code"], "runtime_limit")
        self.assertEqual(records[0]["index"], -1)            # 负数序号，和步骤 index 不撞号

    def test_beat_wait_record_index_does_not_collide_with_step_index(self):
        req = make_req(0, renderer="beat")
        req["context"].beat_outcomes = [{"ok": True, "text": "图片生成成功，结果 http://local/beat.png"}]
        drive(req,
              [{"steps": [step("generate_image", {"canvas_id": "c1"})]},
               {"done": True, "message": "结束"}],
              execute=self._beat_execute(),
              task_get=lambda tid: {"id": tid, "kind": "image", "status": "succeeded"})
        history = req["context"].persisted["history"]
        step_indexes = [r["index"] for r in history if r.get("tool") != "画布生成结果"]
        wait_indexes = [r["index"] for r in history if r.get("tool") == "画布生成结果"]
        self.assertEqual(wait_indexes, [-1])
        self.assertTrue(all(isinstance(i, int) and i >= 0 for i in step_indexes))
        self.assertFalse(set(step_indexes) & set(wait_indexes))


if __name__ == "__main__":
    unittest.main()
