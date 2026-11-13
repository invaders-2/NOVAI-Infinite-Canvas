# -*- coding: utf-8 -*-
"""画布 run 的步数上限与刹车：0 = 不限、正数仍限制、等待类工具不计步、时长上限、自动等生成结果。

覆盖：
  1. max_steps 归一（缺省/None/0/负数 = 不限；正数收敛到 AGENT_RUN_MAX_STEPS_CAP）；
  2. 0 = 不限步数：一轮跑 13 个成功步骤也不会 abort；
  3. 正数仍生效：max_steps=3 时只执行 3 步，以 aborted + 「已达到最大步数上限 3」结束；
  4. 纯等待/只读工具（check_task）成功不占步数，也算这一轮有进展；
  5. 运行时长上限：到点 aborted，消息是「已达到运行时长上限 N 分钟，停止后续步骤」；
  6. 经典画布（非 BEAT）一轮结束后服务端自动轮询 task_get，把「生成结果」写进 history 回灌下一轮；
     失败的任务如实写进失败记录。
  7. 等待只认本轮真实执行步骤返回的任务：check_task / get_canvas 读到的旧 task_id 不再二次等待、不重复回灌；
     run 级 waited_task_ids 去重（同一 task_id 一轮内/跨轮只等一次）；
  8. 等待期间到 run 时长上限就地停止等待（总耗时受控、不误报生成失败），下一轮边界照旧 abort；
  9. 正数 max_steps 中途截断时不会拿上一轮的结果重扫（round_results_start 切片）；
  10. 等待记录的 index 独立编号（负数），不和步骤 index 撞号；
  11. deadline 已过但任务已成功 → 先 poll 再判 deadline，记成功而不是 timeout；
  12. BEAT 的 wait_canvas_results 也接 deadline：到点提前收尾、不写失败记录、记录 code=runtime_limit；
  13. BEAT 的「画布生成结果」记录 index 同样是独立负数。

不真起服务（直接调 producer，模型与工具全打桩），不落盘真实画布。
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
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-run-step-limits-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": [], "connections": [],
            "updated_at": 1700000000000}


def beat_canvas(done=False):
    # 非 smart + canvas-next 节点 = 经典画布（智能画布BEAT）；done=False 时节点一直在"生成中"
    data = {"gen": {}}
    if done:
        data["agentDone"] = {"ok": True, "url": "http://local/out/x.png"}
    else:
        data["agentRun"] = "run-beat"
    return {"id": "c1", "kind": "classic", "title": "BEAT 画布",
            "nodes": [{"id": "n1", "kind": "image", "title": "海报", "data": data}],
            "connections": [], "updated_at": 1700000000000}


def chat_config():
    # provider_cfg 为空 = 不启用原生工具调用，走 JSON 那条路（全打桩，不出网）
    return {"provider": "p", "base": "http://x", "headers": {}, "model": "test-chat-model",
            "provider_cfg": {}}


def agent_request(max_steps, auto_execute=True, renderer=""):
    return {"run_id": "run_steps", "canvas_id": "c1", "instruction": "跑长任务",
            "focus": main._agent_run_normalize_focus(None), "history": [], "chat": chat_config(),
            "max_steps": max_steps, "mode": "run", "approved_steps": [],
            "auto_execute": auto_execute, "renderer": renderer, "enforce_write_confirmation": True}


def generate_step(tool="generate_video", prompt="黄昏海边"):
    return {"tool": tool, "args": {"canvas_id": "c1", "prompt": prompt}, "description": "出媒体素材"}


def create_step(index):
    return {"tool": "create_node",
            "args": {"canvas_id": "c1", "type": "prompt", "prompt": "第 %d 条" % index},
            "description": "建第 %d 个提示词节点" % index}


def drain(req, replies, execute=None, task_get_side_effect=None, model_calls=None,
          extra_patches=(), model_delay=0.0):
    """在打桩环境里把 producer 跑完，返回 [(事件名, data), ...]。"""
    execute = execute or _always_ok
    calls = model_calls if model_calls is not None else []

    async def model(chat, messages):
        calls.append(messages[1]["content"])
        if model_delay:
            time.sleep(model_delay)
        reply = replies[len(calls) - 1] if len(calls) <= len(replies) else {"done": True, "message": "结束"}
        return json.dumps(reply, ensure_ascii=False) if isinstance(reply, dict) else reply

    patches = [
        patch.object(main, "load_canvas", return_value=canvas()),
        patch.object(main, "agent_session_save"),
        patch.object(main, "_agent_run_chat", new=model),
        patch.object(main, "agent_execute_step", new=execute),
        # 自动等结果的两条节奏常量：测试里不能真睡 3 秒 / 15 秒
        patch.object(main, "AGENT_RUN_TASK_WAIT_POLL_SECONDS", 0),
        patch.object(main, "AGENT_RUN_TASK_WAIT_PING_SECONDS", 0),
    ]
    if task_get_side_effect is not None:
        patches.append(patch.object(main, "task_get", side_effect=task_get_side_effect))
    patches.extend(extra_patches)

    async def go():
        queue = asyncio.Queue()
        with contextlib.ExitStack() as stack:
            for item in patches:
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

    chunks = asyncio.run(go())
    events = []
    for chunk in chunks:
        if chunk.startswith("event: "):
            name = chunk.split("\n")[0][len("event: "):]
            events.append((name, json.loads(chunk.split("data: ", 1)[1])))
    return events


async def _always_ok(tool, args):
    return {"ok": True, "result": {}, "message": "执行成功"}


def done_of(events):
    done = [data for name, data in events if name == "done"]
    assert done, "没有 done 事件"
    return done[-1]


class StepLimitNormalizeTests(unittest.TestCase):

    def test_missing_zero_and_negative_mean_unlimited(self):
        self.assertEqual(main._agent_run_normalize_max_steps(None), 0)
        self.assertEqual(main._agent_run_normalize_max_steps(0), 0)
        self.assertEqual(main._agent_run_normalize_max_steps(-5), 0)
        self.assertEqual(main._agent_run_normalize_max_steps("脏"), 0)

    def test_positive_still_capped(self):
        self.assertEqual(main._agent_run_normalize_max_steps(6), 6)
        self.assertEqual(main._agent_run_normalize_max_steps(100), main.AGENT_RUN_MAX_STEPS_CAP)

    def test_request_default_is_unlimited(self):
        payload = main.AgentRunRequest(canvas_id="c1", instruction="看看画布")
        self.assertEqual(payload.max_steps, 0)
        # 显式传 null 也按「不限」处理（后端 normalize 负责收敛成 0）
        explicit_null = main.AgentRunRequest(canvas_id="c1", instruction="看看画布", max_steps=None)
        self.assertEqual(main._agent_run_normalize_max_steps(explicit_null.max_steps), 0)

    def test_default_brakes_are_configured(self):
        # 默认值：60 轮 / 3600 秒（env 被显式设置时以 env 为准，这里只在没配时断言）
        if not os.environ.get("NOVAI_AGENT_MAX_ROUNDS"):
            self.assertEqual(main.AGENT_RUN_MAX_ROUNDS, 60)
        if not os.environ.get("NOVAI_AGENT_MAX_SECONDS"):
            self.assertEqual(main.AGENT_RUN_MAX_SECONDS, 3600)
        self.assertIn("check_task", main.AGENT_RUN_STEP_FREE_TOOLS)
        self.assertNotIn("refine_prompt", main.AGENT_RUN_STEP_FREE_TOOLS)


class StepLimitProducerTests(unittest.TestCase):

    def test_zero_max_steps_runs_more_than_twelve_steps(self):
        replies = [{"thought": "批量建节点", "steps": [create_step(i) for i in range(13)], "done": False},
                   {"done": True, "message": "都建好了"}]
        events = drain(agent_request(0), replies)
        done = done_of(events)
        self.assertEqual(done["status"], "ok")
        self.assertEqual(done["steps_executed"], 13)
        self.assertNotIn("最大步数上限", done["message"])

    def test_positive_max_steps_still_aborts(self):
        replies = [{"thought": "多步", "steps": [create_step(i) for i in range(5)], "done": False}]
        events = drain(agent_request(3), replies)
        done = done_of(events)
        self.assertEqual(done["status"], "aborted")
        self.assertEqual(done["steps_executed"], 3)
        self.assertIn("已达到最大步数上限 3，停止后续步骤", done["message"])

    def test_check_task_does_not_consume_steps(self):
        # 第一轮只做一次 check_task（不计步），第二轮才真正建节点：max_steps=1 时仍然能跑完
        async def execute(tool, args):
            if tool == "check_task":
                return {"ok": True, "result": {"status": "succeeded", "result_url": "http://x/a.png"},
                        "message": "查到了"}
            return {"ok": True, "result": {}, "message": "执行成功"}

        model_calls = []
        replies = [{"thought": "看看任务", "steps": [{"tool": "check_task",
                                                     "args": {"task_id": "t-done"},
                                                     "description": "查任务"}], "done": False},
                   {"done": True, "message": "查完了"}]
        events = drain(agent_request(1), replies, execute=execute, model_calls=model_calls)
        done = done_of(events)
        self.assertEqual(done["status"], "ok")
        # 只允许 1 步时，纯 check_task 那一轮没占步数，所以还能再跑一轮并正常收尾
        self.assertEqual(done["steps_executed"], 0)
        self.assertEqual(len(model_calls), 2)
        self.assertNotIn("最大步数上限", done["message"])

    def test_run_time_limit_aborts(self):
        model_calls = []
        replies = [{"thought": "建节点", "steps": [create_step(1)], "done": False},
                   {"done": True, "message": "好了"}]
        events = drain(agent_request(0), replies, model_calls=model_calls,
                       extra_patches=[patch.object(main, "AGENT_RUN_MAX_SECONDS", 1)],
                       model_delay=1.05)
        done = done_of(events)
        self.assertEqual(done["status"], "aborted")
        self.assertIn("已达到运行时长上限 1 分钟，停止后续步骤", done["message"])
        self.assertEqual(len(model_calls), 1)                # 第二轮开头就到点，没有再调模型


class AutoWaitGenerationTests(unittest.TestCase):

    def test_succeeded_task_is_fed_back_to_next_round(self):
        state = {"calls": 0}

        def task_get(task_id):
            if task_id != "t1":
                return None
            state["calls"] += 1
            if state["calls"] < 3:
                return {"id": "t1", "kind": "video", "status": "provider_processing", "error": ""}
            return {"id": "t1", "kind": "video", "status": "succeeded", "error": "",
                    "result": {"url": "http://local/output/v1.mp4"}}

        async def execute(tool, args):
            return {"ok": True, "result": {"node_id": "v1", "task_id": "t1", "generation_units": 1},
                    "message": "已提交生成任务"}

        model_calls = []
        replies = [{"thought": "出视频", "steps": [{"tool": "generate_video",
                                                   "args": {"canvas_id": "c1", "prompt": "黄昏海边"},
                                                   "description": "出视频"}], "done": False},
                   {"done": True, "message": "视频好了"}]
        events = drain(agent_request(0), replies, execute=execute,
                       task_get_side_effect=task_get, model_calls=model_calls)
        done = done_of(events)
        self.assertEqual(done["status"], "ok")
        self.assertIn("waiting", [name for name, _ in events])   # 等结果期间有进度事件
        # 下一轮模型能看到服务端自动等回来的结果（不用自己 check_task）
        self.assertIn("生成结果", model_calls[1])
        self.assertIn("http://local/output/v1.mp4", model_calls[1])

    def test_failed_task_is_reported(self):
        def task_get(task_id):
            return {"id": task_id, "kind": "online-image", "status": "failed",
                    "error": "上游返回 400：提示词违规"}

        async def execute(tool, args):
            return {"ok": True, "result": {"node_id": "i1", "task_id": "t2", "generation_units": 1},
                    "message": "已提交生成任务"}

        replies = [{"thought": "出图", "steps": [{"tool": "generate_image",
                                                  "args": {"canvas_id": "c1", "prompt": "海报"},
                                                  "description": "出图"}], "done": False},
                   {"done": True, "message": "没出成"}]
        events = drain(agent_request(0), replies, execute=execute, task_get_side_effect=task_get)
        done = done_of(events)
        self.assertEqual(done["status"], "ok")
        # 步骤失败用户要知道（写进回复），同时运行明细里也有一份
        self.assertIn("失败记录", done["message"])
        self.assertIn("上游返回 400", done["message"])
        self.assertTrue(any("上游返回 400" in str(item) for item in done["failures"]), done["failures"])


class AutoWaitDedupTests(unittest.TestCase):
    """自动等待的去重与时长刹车回归（task-3）：只等本轮真实执行出来的任务，等待期也受 run 时长上限约束。"""

    @staticmethod
    def _wait_recorder(waits, deadlines=None):
        real_wait = main._agent_run_wait_tasks

        async def wrapper(task_ids, emit, cancelled, deadline=None):
            waits.append(list(task_ids))
            if deadlines is not None:
                deadlines.append(deadline)
            return await real_wait(task_ids, emit, cancelled, deadline=deadline)

        return wrapper

    @staticmethod
    def _success_task_get(task_id):
        return {"id": task_id, "kind": "video", "status": "succeeded", "error": "",
                "result": {"url": "http://local/output/v1.mp4"}}

    def test_check_task_old_task_id_is_not_waited_again(self):
        # t1 已经出结果；第二轮模型用 check_task 只看了一眼 t1，读到的旧 task_id 不能再当成新任务等一遍
        state = {"calls": 0}

        def task_get(task_id):
            if task_id != "t1":
                return None
            state["calls"] += 1
            if state["calls"] < 3:
                return {"id": "t1", "kind": "video", "status": "provider_processing", "error": ""}
            return self._success_task_get("t1")

        async def execute(tool, args):
            if tool == "check_task":
                return {"ok": True, "result": {"task_id": "t1", "status": "succeeded",
                                               "result_url": "http://local/output/v1.mp4"},
                        "message": "查到了"}
            return {"ok": True, "result": {"node_id": "v1", "task_id": "t1", "generation_units": 1},
                    "message": "已提交生成任务"}

        waits, model_calls = [], []
        replies = [{"steps": [generate_step()], "done": False},
                   {"steps": [{"tool": "check_task", "args": {"task_id": "t1"}, "description": "查任务"}],
                    "done": False},
                   {"done": True, "message": "好了"}]
        events = drain(agent_request(0), replies, execute=execute, task_get_side_effect=task_get,
                       model_calls=model_calls,
                       extra_patches=[patch.object(main, "_agent_run_wait_tasks",
                                                   new=self._wait_recorder(waits))])
        self.assertEqual(done_of(events)["status"], "ok")
        self.assertEqual(waits, [["t1"]])                        # check_task 那一轮没有再等
        self.assertEqual(model_calls[-1].count("生成结果"), 1)    # 也没有重复回灌

    def test_same_task_id_across_rounds_is_waited_once(self):
        def task_get(task_id):
            return self._success_task_get(task_id)

        async def execute(tool, args):
            return {"ok": True, "result": {"node_id": "v1", "task_id": "t1", "generation_units": 1},
                    "message": "已提交生成任务"}

        waits, model_calls = [], []
        replies = [{"steps": [generate_step()], "done": False},
                   {"steps": [generate_step(prompt="再来一条")], "done": False},
                   {"done": True, "message": "好了"}]
        events = drain(agent_request(0), replies, execute=execute, task_get_side_effect=task_get,
                       model_calls=model_calls,
                       extra_patches=[patch.object(main, "_agent_run_wait_tasks",
                                                   new=self._wait_recorder(waits))])
        done = done_of(events)
        self.assertEqual(done["status"], "ok")
        self.assertEqual(waits, [["t1"]])                        # 同一个 task_id 只等一次
        self.assertEqual(done["steps_executed"], 2)
        self.assertEqual(model_calls[-1].count("生成结果"), 1)

    def test_wait_stops_at_run_deadline_without_false_failure(self):
        def task_get(task_id):
            # 一直不结束：只有 run 的时长上限能把它停下来
            return {"id": task_id, "kind": "video", "status": "provider_processing", "error": ""}

        async def execute(tool, args):
            return {"ok": True, "result": {"node_id": "v1", "task_id": "t1", "generation_units": 1},
                    "message": "已提交生成任务"}

        waits, deadlines = [], []
        started = time.monotonic()
        events = drain(agent_request(0), [{"steps": [generate_step()], "done": False}],
                       execute=execute, task_get_side_effect=task_get,
                       extra_patches=[patch.object(main, "AGENT_RUN_MAX_SECONDS", 1),
                                      patch.object(main, "AGENT_RUN_TASK_WAIT_POLL_SECONDS", 0.05),
                                      patch.object(main, "_agent_run_wait_tasks",
                                                   new=self._wait_recorder(waits, deadlines))])
        elapsed = time.monotonic() - started
        done = done_of(events)
        self.assertEqual(waits, [["t1"]])
        self.assertTrue(deadlines and deadlines[0] is not None)   # deadline 已经传进等待
        self.assertEqual(done["status"], "aborted")
        self.assertIn("已达到运行时长上限 1 分钟，停止后续步骤", done["message"])
        self.assertNotIn("失败记录", done["message"])             # 到点停止等待不算生成失败
        self.assertLess(elapsed, 4)                               # 没有把 1800 秒等满

    def test_truncated_round_does_not_rescan_previous_tasks(self):
        def task_get(task_id):
            return self._success_task_get(task_id)

        async def execute(tool, args):
            if tool == "generate_video":
                return {"ok": True, "result": {"node_id": "v1", "task_id": "t1", "generation_units": 1},
                        "message": "已提交生成任务"}
            return {"ok": True, "result": {}, "message": "执行成功"}

        waits = []
        replies = [{"steps": [generate_step()], "done": False},
                   {"steps": [create_step(1), create_step(2)], "done": False}]
        events = drain(agent_request(2), replies, execute=execute, task_get_side_effect=task_get,
                       extra_patches=[patch.object(main, "_agent_run_wait_tasks",
                                                   new=self._wait_recorder(waits))])
        done = done_of(events)
        self.assertEqual(done["status"], "aborted")
        self.assertIn("已达到最大步数上限 2", done["message"])
        self.assertEqual(done["steps_executed"], 2)
        self.assertEqual(waits, [["t1"]])                         # 第二轮被截断，没拿上一轮的 t1 再等一次

    def test_wait_record_index_is_independent_from_step_index(self):
        def task_get(task_id):
            return self._success_task_get(task_id)

        async def execute(tool, args):
            return {"ok": True, "result": {"node_id": "v1", "task_id": "t1", "generation_units": 1},
                    "message": "已提交生成任务"}

        recorded = {}

        def fake_persist(session, status, message, history, rounds, steps_executed, mutated, canvas_id,
                         run_id, intent, instruction, focus, plan=None):
            recorded["history"] = list(history)

        events = drain(agent_request(0), [{"steps": [generate_step()], "done": False},
                                          {"done": True, "message": "好了"}],
                       execute=execute, task_get_side_effect=task_get,
                       extra_patches=[patch.object(main, "_agent_run_persist_session", new=fake_persist)])
        self.assertEqual(done_of(events)["status"], "ok")
        history = recorded["history"]
        step_indexes = {rec["index"] for rec in history if rec.get("tool") != "生成结果"}
        wait_records = [rec for rec in history if rec.get("tool") == "生成结果"]
        self.assertEqual(len(wait_records), 1)
        self.assertLess(wait_records[0]["index"], 0)              # 负数：明确不是步骤序号
        self.assertNotIn(wait_records[0]["index"], step_indexes)


class RuntimeLimitWaitTests(unittest.TestCase):
    """deadline 收尾的顺序与 BEAT 同样受控（task-5）：先 poll 判终态，再判 deadline；BEAT 也接 deadline。"""

    @staticmethod
    def _persist_recorder():
        recorded = {}

        def fake_persist(session, status, message, history, rounds, steps_executed, mutated, canvas_id,
                         run_id, intent, instruction, focus, plan=None):
            recorded["history"] = list(history)

        return recorded, fake_persist

    def test_succeeded_task_is_not_marked_timeout_when_deadline_already_passed(self):
        def task_get(task_id):
            return {"id": task_id, "kind": "video", "status": "succeeded", "error": "",
                    "result": {"url": "http://local/output/v1.mp4"}}

        async def execute(tool, args):
            return {"ok": True, "result": {"node_id": "v1", "task_id": "t1", "generation_units": 1},
                    "message": "已提交生成任务"}

        recorded, fake_persist = self._persist_recorder()
        # model_delay 让 deadline 在真正开始等待时就已经过了：先 poll 到终态，应该记成功而不是 timeout
        events = drain(agent_request(0), [{"steps": [generate_step()], "done": False}],
                       execute=execute, task_get_side_effect=task_get, model_delay=1.05,
                       extra_patches=[patch.object(main, "AGENT_RUN_MAX_SECONDS", 1),
                                      patch.object(main, "_agent_run_persist_session", new=fake_persist)])
        done = done_of(events)
        self.assertEqual(done["status"], "aborted")             # 时长上限仍然生效
        wait_records = [rec for rec in recorded["history"] if rec.get("tool") == "生成结果"]
        self.assertEqual(len(wait_records), 1)
        self.assertTrue(wait_records[0]["ok"])                   # 已成功 → 记成功
        self.assertEqual(wait_records[0]["code"], "canvas_result")
        self.assertNotIn("失败记录", done["message"])

    def test_beat_wait_stops_at_run_deadline_without_failure_record(self):
        async def execute(tool, args):
            return {"ok": True, "result": {"status": "queued_on_canvas", "node_id": "n1"},
                    "message": "已交给画布生成"}

        recorded, fake_persist = self._persist_recorder()
        # BEAT 节点一直在生成中：只有 run 的时长上限能把它停下（不能等满 video 的 1800 秒）
        started = time.monotonic()
        events = drain(agent_request(0, renderer="beat"),
                       [{"steps": [{"tool": "generate_image",
                                    "args": {"canvas_id": "c1", "prompt": "海报"},
                                    "description": "出图"}], "done": False}],
                       execute=execute, model_delay=1.05,
                       extra_patches=[patch.object(main, "load_canvas", return_value=beat_canvas()),
                                      patch.object(main, "AGENT_RUN_MAX_SECONDS", 1),
                                      patch.object(main, "_agent_run_persist_session", new=fake_persist)])
        elapsed = time.monotonic() - started
        done = done_of(events)
        self.assertEqual(done["status"], "aborted")
        self.assertIn("已达到运行时长上限 1 分钟，停止后续步骤", done["message"])
        self.assertNotIn("失败记录", done["message"])            # 到点停止等待不算生成失败
        self.assertLess(elapsed, 4)                              # 没有把 BEAT 的 1800 秒等满
        records = [rec for rec in recorded["history"] if rec.get("tool") == "画布生成结果"]
        self.assertEqual(len(records), 1)
        self.assertFalse(records[0]["ok"])
        self.assertTrue(records[0]["code"] == "runtime_limit")
        self.assertIn("已达到运行时长上限", records[0]["error"])
        # index 是负数序号，且不与步骤 index 撞号
        step_indexes = [rec["index"] for rec in recorded["history"] if rec.get("tool") != "画布生成结果"]
        self.assertLess(records[0]["index"], 0)
        self.assertNotIn(records[0]["index"], step_indexes)

    def test_beat_wait_record_index_stays_negative_on_success(self):
        async def execute(tool, args):
            return {"ok": True, "result": {"status": "queued_on_canvas", "node_id": "n1"},
                    "message": "已交给画布生成"}

        recorded, fake_persist = self._persist_recorder()
        events = drain(agent_request(0, renderer="beat"),
                       [{"steps": [{"tool": "generate_image",
                                    "args": {"canvas_id": "c1", "prompt": "海报"},
                                    "description": "出图"}], "done": False},
                        {"done": True, "message": "好了"}],
                       execute=execute, extra_patches=[
                           patch.object(main, "load_canvas", return_value=beat_canvas(done=True)),
                           patch.object(main, "_agent_run_persist_session", new=fake_persist)])
        self.assertEqual(done_of(events)["status"], "ok")
        records = [rec for rec in recorded["history"] if rec.get("tool") == "画布生成结果"]
        self.assertEqual(len(records), 1)
        self.assertTrue(records[0]["ok"])
        self.assertLess(records[0]["index"], 0)
        self.assertNotIn(records[0]["index"],
                         [rec["index"] for rec in recorded["history"] if rec.get("tool") != "画布生成结果"])


if __name__ == "__main__":
    unittest.main()
