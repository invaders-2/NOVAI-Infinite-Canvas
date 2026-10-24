# -*- coding: utf-8 -*-
"""画布 run 的 SSE 事件总线：带序号的事件帧 + 断流恢复（重放 + 续推）。

覆盖：
  1. 总线单元：publish 递增 seq、超过上限丢最旧、订阅者收新事件、after 只回放更大的 seq、
     close 后订阅结束、未知 run = None、TTL / 条数两种清理策略；
  2. 打桩跑一次 producer：事件序号从 1 连续无缺号、可重放、结束后 bus.done=True；
  3. 端点：POST /api/agent/run 现在带 id: 行且事件类型与改造前一致；
     GET /api/agent/runs/{run_id}/stream 支持 after 与 Last-Event-ID、未知 run 404。

不真起服务（直接调 FastAPI 的处理函数，模型与工具全打桩），不落盘真实画布。
"""
import asyncio
import contextlib
import io
import json
import os
import re
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

_TMP_DATA = tempfile.mkdtemp(prefix="novai-run-stream-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": [], "connections": [],
            "updated_at": 1700000000000}


def chat_config():
    # provider_cfg 为空 = 不启用原生工具调用，走 JSON 那条路（全打桩，不出网）
    return {"provider": "p", "base": "http://x", "headers": {}, "model": "test-chat-model",
            "provider_cfg": {}}


def agent_request(run_id="run_test"):
    return {"run_id": run_id, "canvas_id": "c1", "instruction": "看看画布",
            "focus": main._agent_run_normalize_focus(None), "history": [], "chat": chat_config(),
            "max_steps": 6, "mode": "run", "approved_steps": [], "enforce_write_confirmation": True}


READ_ONLY_REPLIES = [
    {"thought": "看画布", "steps": [{"tool": "get_canvas", "args": {"canvas_id": "c1"},
                                    "description": "看画布"}], "done": False},
    {"done": True, "message": "看完了"},
]
WRITE_REPLIES = [
    {"thought": "建节点", "steps": [{"tool": "create_node",
                                    "args": {"canvas_id": "c1", "type": "prompt", "title": "海报"},
                                    "description": "建提示词节点"}], "done": False},
]


def drive(bus, replies, execute=None, run_id="run_test"):
    """在打桩环境里把 bus 对应的 producer 跑完。"""
    execute = execute or AsyncMock(return_value={"ok": True, "result": {"nodes": []}, "message": "执行成功"})
    model = AsyncMock(side_effect=[json.dumps(r, ensure_ascii=False) for r in replies])

    async def go():
        with contextlib.redirect_stdout(io.StringIO()), \
                patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "agent_session_save"), \
                patch.object(main, "_agent_run_chat", new=model), \
                patch.object(main, "agent_execute_step", new=execute):
            await main._agent_run_bus_drive(agent_request(run_id), bus)

    asyncio.run(go())
    return bus


def collect_stream(bus, after=0):
    async def go():
        return [chunk async for chunk in main._agent_run_bus_stream(bus, after)]
    return "".join(asyncio.run(go()))


def frame_ids(text):
    return [int(m) for m in re.findall(r"^id: (\d+)$", text, re.M)]


def frame_names(text):
    return re.findall(r"^event: (.+)$", text, re.M)


class BusUnitTests(unittest.TestCase):

    def setUp(self):
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        main._AGENT_RUN_BUS.clear()

    def test_publish_assigns_increasing_seq(self):
        bus = main._agent_run_bus_new("run_a")
        self.assertEqual([main._agent_run_bus_publish(bus, "x", {"i": i}) for i in range(3)], [1, 2, 3])
        self.assertEqual([e["seq"] for e in bus["events"]], [1, 2, 3])
        self.assertEqual(bus["events"][0]["name"], "x")

    def test_buffer_drops_oldest_beyond_limit(self):
        bus = main._agent_run_bus_new("run_b")
        with patch.object(main, "AGENT_RUN_BUS_MAX_EVENTS", 3):
            for i in range(5):
                main._agent_run_bus_publish(bus, "e", {"i": i})
        self.assertEqual([e["seq"] for e in bus["events"]], [3, 4, 5])   # 丢最旧、序号不回退
        self.assertEqual(bus["next_seq"], 6)

    def test_subscriber_receives_new_events(self):
        bus = main._agent_run_bus_new("run_c")
        queue = main._agent_run_bus_subscribe(bus)
        main._agent_run_bus_publish(bus, "a", {})
        main._agent_run_bus_publish(bus, "b", {})
        self.assertEqual([queue.get_nowait()["seq"] for _ in range(2)], [1, 2])
        self.assertTrue(queue.empty())

    def test_events_after_replays_only_newer(self):
        bus = main._agent_run_bus_new("run_d")
        for i in range(5):
            main._agent_run_bus_publish(bus, "e", {"i": i})
        self.assertEqual([e["seq"] for e in main._agent_run_bus_events_after(bus, 2)], [3, 4, 5])
        self.assertEqual(main._agent_run_bus_events_after(bus, 5), [])
        self.assertEqual([e["seq"] for e in main._agent_run_bus_events_after(bus, 0)], [1, 2, 3, 4, 5])
        self.assertEqual([e["seq"] for e in main._agent_run_bus_events_after(bus, "脏")], [1, 2, 3, 4, 5])

    def test_close_notifies_subscribers_and_marks_done(self):
        bus = main._agent_run_bus_new("run_e")
        queue = main._agent_run_bus_subscribe(bus)
        main._agent_run_bus_close(bus)
        self.assertTrue(bus["done"])
        self.assertGreater(bus["finished_at"], 0)
        self.assertIsNone(queue.get_nowait())          # 订阅者被叫醒，流可以正常收尾
        main._agent_run_bus_close(bus)                  # 重复 close 无副作用
        self.assertTrue(bus["done"])

    def test_unknown_run_is_none(self):
        self.assertIsNone(main._agent_run_bus_get("run_not_exist"))

    def test_prune_drops_expired_finished_run(self):
        bus = main._agent_run_bus_new("run_old")
        main._agent_run_bus_close(bus)
        bus["finished_at"] = time.time() - 100000        # 远早于 TTL（0 会被当成缺省值，别用）
        with patch.object(main, "AGENT_RUN_BUS_TTL_SECONDS", 600):
            main._agent_run_bus_prune()
        self.assertIsNone(main._agent_run_bus_get("run_old"))

    def test_prune_keeps_running_run(self):
        main._agent_run_bus_new("run_live")
        with patch.object(main, "AGENT_RUN_BUS_TTL_SECONDS", 0), \
                patch.object(main, "AGENT_RUN_BUS_MAX_FINISHED", 0):
            main._agent_run_bus_prune()
        self.assertIsNotNone(main._agent_run_bus_get("run_live"))

    def test_prune_caps_finished_runs(self):
        now = time.time()
        for i in range(4):
            bus = main._agent_run_bus_new("run_%d" % i)
            main._agent_run_bus_close(bus)
            bus["finished_at"] = now - 10 + i          # 都在 TTL 内，只会被条数上限清掉
        with patch.object(main, "AGENT_RUN_BUS_MAX_FINISHED", 2), \
                patch.object(main, "AGENT_RUN_BUS_TTL_SECONDS", 600):
            main._agent_run_bus_prune()
        self.assertEqual(sorted(main._AGENT_RUN_BUS), ["run_2", "run_3"])   # 留最新的两个


class ProducerBusTests(unittest.TestCase):

    def setUp(self):
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        main._AGENT_RUN_BUS.clear()

    def test_events_are_sequential_and_bus_closes(self):
        bus = main._agent_run_bus_new("run_seq")
        drive(bus, READ_ONLY_REPLIES)
        seqs = [e["seq"] for e in bus["events"]]
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))      # 连续无缺号
        names = [e["name"] for e in bus["events"]]
        self.assertIn("run_start", names)
        self.assertIn("done", names)
        self.assertTrue(bus["done"])
        self.assertGreater(bus["finished_at"], 0)

    def test_replay_returns_tail_after_seq(self):
        bus = main._agent_run_bus_new("run_replay")
        drive(bus, READ_ONLY_REPLIES)
        total = len(bus["events"])
        self.assertGreaterEqual(total, 4)
        tail = main._agent_run_bus_events_after(bus, 2)
        self.assertEqual([e["seq"] for e in tail], list(range(3, total + 1)))

    def test_stream_replays_all_then_ends(self):
        bus = main._agent_run_bus_new("run_stream")
        drive(bus, READ_ONLY_REPLIES)
        text = collect_stream(bus, 0)
        self.assertEqual(frame_ids(text), [e["seq"] for e in bus["events"]])
        self.assertIn("run_start", frame_names(text))
        self.assertIn("done", frame_names(text))
        self.assertTrue(text.rstrip().endswith("}"))               # 正常结束（不是心跳吊着）

    def test_stream_after_skips_earlier_events(self):
        bus = main._agent_run_bus_new("run_after")
        drive(bus, READ_ONLY_REPLIES)
        text = collect_stream(bus, after=2)
        self.assertTrue(frame_ids(text))
        self.assertGreater(min(frame_ids(text)), 2)
        self.assertEqual(frame_ids(text), [e["seq"] for e in main._agent_run_bus_events_after(bus, 2)])


class EndpointTests(unittest.TestCase):

    def setUp(self):
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        main._AGENT_RUN_BUS.clear()

    def _run_post(self, replies, execute=None):
        """走真实的 agent_run 处理函数，把 StreamingResponse 的流整段读出来。"""
        execute = execute or AsyncMock(return_value={"ok": True, "result": {"nodes": []}, "message": "执行成功"})
        model = AsyncMock(side_effect=[json.dumps(r, ensure_ascii=False) for r in replies])
        payload = main.AgentRunRequest(canvas_id="c1", instruction="看看画布", mode="run")

        async def go():
            with contextlib.redirect_stdout(io.StringIO()), \
                    patch.object(main, "load_canvas", return_value=canvas()), \
                    patch.object(main, "agent_session_save"), \
                    patch.object(main, "_agent_run_chat", new=model), \
                    patch.object(main, "_agent_run_resolve_chat", return_value=chat_config()), \
                    patch.object(main, "agent_execute_step", new=execute):
                resp = await main.agent_run(payload, object())
                chunks = [chunk async for chunk in resp.body_iterator]
                return resp, "".join(chunks)

        return asyncio.run(go())

    def test_post_stream_has_ids_and_run_header(self):
        resp, text = self._run_post(READ_ONLY_REPLIES)
        run_id = resp.headers["x-novai-run-id"]
        self.assertTrue(run_id.startswith("run_"))
        self.assertEqual(frame_ids(text), list(range(1, len(frame_ids(text)) + 1)))
        self.assertIn("id: 1\nevent: run_start", text)
        # run_start 里的 run_id 与响应头一致：断流后前端能直接拿它续传
        first = json.loads(re.search(r"^event: run_start\ndata: (.+)$", text, re.M).group(1))
        self.assertEqual(first["run_id"], run_id)
        self.assertIsNotNone(main._agent_run_bus_get(run_id))

    def test_post_event_types_unchanged(self):
        _resp, text = self._run_post(READ_ONLY_REPLIES)
        names = frame_names(text)
        for name in ("run_start", "context_usage", "plan", "step_start", "step_result", "done"):
            self.assertIn(name, names)
        _resp2, text2 = self._run_post(WRITE_REPLIES)
        self.assertIn("plan", frame_names(text2))                  # 未确认写步骤仍然先出方案
        self.assertIn("done", frame_names(text2))

    def test_resume_endpoint_404_for_unknown_run(self):
        with self.assertRaises(main.HTTPException) as caught:
            asyncio.run(main.agent_run_stream("run_missing", object(), 0, None))
        self.assertEqual(caught.exception.status_code, 404)
        self.assertIn("run_missing", str(caught.exception.detail) + "run_missing")

    def test_resume_endpoint_replays_after(self):
        bus = main._agent_run_bus_new("run_resume")
        drive(bus, READ_ONLY_REPLIES)

        async def go(after, header_value=None):
            resp = await main.agent_run_stream("run_resume", object(), after, header_value)
            return "".join([chunk async for chunk in resp.body_iterator])

        text = asyncio.run(go(2))
        self.assertEqual(frame_ids(text), [e["seq"] for e in main._agent_run_bus_events_after(bus, 2)])

        # Last-Event-ID 兜底（浏览器 EventSource 断线重连时自动带）
        text_header = asyncio.run(go(0, "2"))
        self.assertEqual(frame_ids(text_header), [e["seq"] for e in main._agent_run_bus_events_after(bus, 2)])

        # 已结束的 run：重放完就正常结束，不会挂着等
        text_all = asyncio.run(go(0))
        self.assertIn("done", frame_names(text_all))


if __name__ == "__main__":
    unittest.main()
