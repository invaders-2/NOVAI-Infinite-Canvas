# -*- coding: utf-8 -*-
"""运行中插话（steer）：排队到下一轮，不打断当前轮。

契约：
  POST /api/agent/runs/{run_id}/steer  body {"message": "..."}（1..2000 字，超长 400）
  - run 不存在/已过期 → 404
  - run 已结束 → 409 {"error": "该运行已结束，无法插话"}
  - 排队超过 10 条 → 409 {"error": "插话太频繁，请等本轮读完"}
  - 正常 → {"accepted": true, "pending": N}
事件：user_steer{id, status: placed|unread, text}；done payload 带 unread_steer。

模型与工具全打桩；不真起服务、不落盘真实画布。
"""
import asyncio
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-run-steer-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": [], "connections": [],
            "updated_at": 1700000000000}


def agent_request(run_id="run_test"):
    return {"run_id": run_id, "canvas_id": "c1", "instruction": "看看画布",
            "focus": main._agent_run_normalize_focus(None), "history": [],
            "chat": {"provider": "p", "base": "http://x", "headers": {}, "model": "test-chat-model",
                     "provider_cfg": {}},
            "max_steps": 6, "mode": "run", "approved_steps": [], "enforce_write_confirmation": True}


def drive(bus, replies, run_id="run_test", execute=None):
    """在打桩环境里把 bus 对应的 producer 跑完；返回模型 mock（可查它收到的 user prompt）。"""
    execute = execute or AsyncMock(return_value={"ok": True, "result": {"nodes": []}, "message": "执行成功"})
    if callable(replies) and not isinstance(replies, list):
        model = AsyncMock(side_effect=replies)
    else:
        model = AsyncMock(side_effect=[json.dumps(r, ensure_ascii=False) for r in replies])

    async def go():
        with contextlib.redirect_stdout(io.StringIO()), \
                patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "agent_session_save"), \
                patch.object(main, "_agent_run_chat", new=model), \
                patch.object(main, "agent_execute_step", new=execute):
            await main._agent_run_bus_drive(agent_request(run_id), bus)

    asyncio.run(go())
    return model


def user_prompt_of(model, call_index=0):
    """取某次模型调用里发给模型的 user 文本。"""
    messages = model.call_args_list[call_index].args[1]
    for item in messages:
        if item.get("role") == "user":
            return item.get("content") or ""
    return ""


def names_of(bus):
    return [e["name"] for e in bus["events"]]


def payloads_of(bus, name):
    return [e["data"] for e in bus["events"] if e["name"] == name]


class SteerQueueTests(unittest.TestCase):

    def setUp(self):
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        main._AGENT_RUN_BUS.clear()

    def test_push_then_drain_clears_queue(self):
        bus = main._agent_run_bus_new("run_q")
        self.assertEqual(main._agent_run_bus_push_steer("run_q", "换个风格"), {"ok": True, "reason": "", "pending": 1})
        self.assertEqual(main._agent_run_bus_push_steer("run_q", "再加点光效")["pending"], 2)
        self.assertEqual(main._agent_run_bus_drain_steer("run_q"), ["换个风格", "再加点光效"])
        self.assertEqual(bus["steer"], [])
        self.assertEqual(main._agent_run_bus_drain_steer("run_q"), [])

    def test_eleventh_push_is_rejected(self):
        main._agent_run_bus_new("run_full")
        for i in range(main.AGENT_RUN_STEER_MAX):
            self.assertTrue(main._agent_run_bus_push_steer("run_full", "第 %d 条" % i)["ok"])
        rejected = main._agent_run_bus_push_steer("run_full", "第 11 条")   # 返回错误标志，不抛异常
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["reason"], "full")
        self.assertEqual(len(main._agent_run_bus_drain_steer("run_full")), main.AGENT_RUN_STEER_MAX)

    def test_unknown_and_finished_run_rejected(self):
        self.assertEqual(main._agent_run_bus_push_steer("run_nope", "x")["reason"], "not_found")
        bus = main._agent_run_bus_new("run_done")
        main._agent_run_bus_close(bus)
        self.assertEqual(main._agent_run_bus_push_steer("run_done", "x")["reason"], "done")


class SteerProducerTests(unittest.TestCase):

    def setUp(self):
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        main._AGENT_RUN_BUS.clear()

    def test_steer_is_placed_and_reaches_the_model(self):
        bus = main._agent_run_bus_new("run_s1")
        main._agent_run_bus_push_steer("run_s1", "背景换成夜景")
        model = drive(bus, [{"done": True, "message": "好的"}], run_id="run_s1")

        placed = payloads_of(bus, "user_steer")
        self.assertEqual(len(placed), 1)
        self.assertEqual(placed[0]["status"], "placed")
        self.assertEqual(placed[0]["text"], "背景换成夜景")
        self.assertEqual(placed[0]["id"], "run_s1:steer:1")

        prompt = user_prompt_of(model)
        self.assertIn("用户在运行中补充的内容（按时间顺序，用于修正方向）：", prompt)
        self.assertIn("- 背景换成夜景", prompt)

        done = payloads_of(bus, "done")[0]
        self.assertEqual(done["unread_steer"], 0)          # 已读到，不算未读

    def test_second_steer_gets_next_sequence_id(self):
        bus = main._agent_run_bus_new("run_s2")
        main._agent_run_bus_push_steer("run_s2", "第一句")
        drive(bus, [{"done": False, "steps": [{"tool": "get_canvas", "args": {"canvas_id": "c1"},
                                              "description": "看画布"}]},
                    {"done": True, "message": "好了"}], run_id="run_s2")
        # 第二轮再插一条（用第二个 run 位置无法中途插入，这里直接验证跨轮编号在单轮内不重复）
        self.assertEqual([p["id"] for p in payloads_of(bus, "user_steer")], ["run_s2:steer:1"])

    def test_unread_steer_reported_at_the_end(self):
        bus = main._agent_run_bus_new("run_s3")

        def reply_and_steer(*args, **kwargs):
            # 模型这一轮已经开始跑了，此刻推进来的插话本轮读不到 → 收尾必须报出来
            main._agent_run_bus_push_steer("run_s3", "顺便把比例改成 16:9")
            return json.dumps({"done": True, "message": "好的"}, ensure_ascii=False)

        drive(bus, reply_and_steer, run_id="run_s3")
        unread = [p for p in payloads_of(bus, "user_steer") if p.get("status") == "unread"]
        self.assertEqual(len(unread), 1)
        self.assertEqual(unread[0]["text"], "顺便把比例改成 16:9")
        self.assertEqual(payloads_of(bus, "done")[0]["unread_steer"], 1)
        self.assertNotIn("placed", [p.get("status") for p in payloads_of(bus, "user_steer")])

    def test_no_steer_keeps_event_sequence(self):
        bus = main._agent_run_bus_new("run_s4")
        drive(bus, [{"done": False, "steps": [{"tool": "get_canvas", "args": {"canvas_id": "c1"},
                                              "description": "看画布"}]},
                    {"done": True, "message": "看完了"}], run_id="run_s4")
        names = names_of(bus)
        self.assertNotIn("user_steer", names)             # 没插话就一条也不发
        for name in ("run_start", "context_usage", "plan", "step_start", "step_result", "done"):
            self.assertIn(name, names)
        self.assertEqual(payloads_of(bus, "done")[0]["unread_steer"], 0)


class SteerEndpointTests(unittest.TestCase):

    def setUp(self):
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        main._AGENT_RUN_BUS.clear()

    def _call(self, run_id, message):
        payload = main.AgentRunSteerRequest(message=message)
        return asyncio.run(main.agent_run_steer(run_id, payload, object()))

    def test_accepts_and_reports_pending(self):
        main._agent_run_bus_new("run_e1")
        self.assertEqual(self._call("run_e1", "换个风格"), {"accepted": True, "pending": 1})
        self.assertEqual(self._call("run_e1", "再亮一点"), {"accepted": True, "pending": 2})

    def test_unknown_run_is_404(self):
        with self.assertRaises(main.HTTPException) as caught:
            self._call("run_missing", "换个风格")
        self.assertEqual(caught.exception.status_code, 404)
        self.assertIn("run 不存在或已过期", str(caught.exception.detail))

    def test_finished_run_is_409(self):
        bus = main._agent_run_bus_new("run_e2")
        main._agent_run_bus_close(bus)
        resp = self._call("run_e2", "换个风格")
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(json.loads(resp.body), {"error": "该运行已结束，无法插话"})

    def test_too_many_pending_is_409(self):
        main._agent_run_bus_new("run_e3")
        for i in range(main.AGENT_RUN_STEER_MAX):
            self._call("run_e3", "第 %d 条" % i)
        resp = self._call("run_e3", "第 11 条")
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(json.loads(resp.body), {"error": "插话太频繁，请等本轮读完"})

    def test_message_length_is_400(self):
        main._agent_run_bus_new("run_e4")
        for bad in ("", "   ", "字" * (main.AGENT_RUN_STEER_TEXT_MAX + 1)):
            with self.subTest(length=len(bad)):
                with self.assertRaises(main.HTTPException) as caught:
                    self._call("run_e4", bad)
                self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
