# -*- coding: utf-8 -*-
"""决策/阶段心跳：等待期间每 5s 一条；不写转录、不计步、不影响状态；结束后停发。"""
import asyncio
import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-heartbeat-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


class HeartbeatTests(unittest.TestCase):
    def setUp(self):
        self._saved = main._AGENT_HEARTBEAT_SECONDS
        main._AGENT_HEARTBEAT_SECONDS = 0.03

    def tearDown(self):
        main._AGENT_HEARTBEAT_SECONDS = self._saved

    def test_slow_decision_emits_heartbeats(self):
        events = []

        async def slow():
            await asyncio.sleep(0.12)
            return {"done": True}

        result = asyncio.run(main._agent_run_with_heartbeat(
            slow(), lambda name, data: events.append((name, data)), "run_h", 2, "non_stream"))
        self.assertEqual(result, {"done": True})
        self.assertGreaterEqual(len(events), 1)
        name, data = events[0]
        self.assertEqual(name, "heartbeat")
        self.assertEqual(data["run_id"], "run_h")
        self.assertEqual(data["round"], 2)
        self.assertEqual(data["stage"], "decide")
        self.assertEqual(data["kind"], "non_stream")
        self.assertGreaterEqual(data["elapsed_ms"], 20)
        count = len(events)
        asyncio.run(asyncio.sleep(0.08))
        self.assertEqual(len(events), count, "决策返回后必须停发心跳")

    def test_fast_decision_does_not_emit(self):
        events = []

        async def fast():
            await asyncio.sleep(0.005)
            return {"done": True}

        asyncio.run(main._agent_run_with_heartbeat(
            fast(), lambda name, data: events.append((name, data)), "run_h", 1, "stream"))
        self.assertEqual(events, [], "没等满一个周期不该发心跳（节流）")

    def test_kind_is_passed_through(self):
        events = []

        async def slow():
            await asyncio.sleep(0.08)
            return "ok"

        asyncio.run(main._agent_run_with_heartbeat(
            slow(), lambda name, data: events.append(data), "run_h", 3, "stream"))
        self.assertTrue(events)
        self.assertTrue(all(item["kind"] == "stream" for item in events))


if __name__ == "__main__":
    unittest.main()
