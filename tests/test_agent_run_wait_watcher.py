# -*- coding: utf-8 -*-
"""挂起等生成的服务端看护 + 停止挂起运行（前端不调 /api/agent/events 时运行不能永远挂着）。"""
import asyncio, os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("NOVAI_DATA_DIR", tempfile.mkdtemp())
import main
from unittest.mock import patch

def canvas(done):
    data = {"agentDone": {"ok": True, "url": "/x.mp4"}} if done else {"agentRun": {"at": 1}}
    return {"id": "c1", "nodes": [{"id": "v1", "kind": "video", "data": dict(data)}]}

class WatchTests(unittest.TestCase):
    def setUp(self):
        self._poll = main.AGENT_RUN_WATCH_POLL_SECONDS
        self.addCleanup(setattr, main, "AGENT_RUN_WATCH_POLL_SECONDS", self._poll)
        main._agent_run_state_update("r1", main._agent_run_state.STATUS_WAITING_GENERATION,
                                     canvas_id="c1", waiting_on=["v1"])
        main.AGENT_RUN_WATCH_POLL_SECONDS = 0.01
    def test_resumes_when_settled(self):
        calls = []
        async def fake_resume(rid, ev=None):
            calls.append((rid, ev)); return {"ok": True}
        seq = iter([canvas(False), canvas(False), canvas(True)])
        async def go():
            with patch.object(main, "load_canvas", side_effect=lambda cid: next(seq)), \
                 patch.object(main, "_agent_run_resume", side_effect=fake_resume):
                self.assertTrue(main._agent_run_ensure_wait_watcher("r1"))
                self.assertTrue(main._agent_run_ensure_wait_watcher("r1"))   # 幂等
                await asyncio.wait_for(main._AGENT_RUN_WAIT_WATCHERS["r1"], 2)
        asyncio.run(go())
        self.assertEqual(calls[0][0], "r1"); self.assertEqual(calls[0][1]["node_ids"], ["v1"])
    def test_stops_when_not_suspended(self):
        main._agent_run_state_update("r1", main._agent_run_state.STATUS_FINISHED)
        async def go():
            self.assertFalse(main._agent_run_ensure_wait_watcher("r1"))
        asyncio.run(go())
    def test_cancel_suspended_closes_bus(self):
        bus = {"run_id": "r1", "suspended": True, "task": None, "events": [], "subs": []}
        class Req: pass
        async def go():
            with patch.object(main, "_agent_run_bus_get", return_value=bus), \
                 patch.object(main, "_agent_require_run_access", return_value=None):
                return await main.agent_run_cancel("r1", Req())
        r = asyncio.run(go())
        self.assertEqual(r["status"], "CANCELLED"); self.assertTrue(bus["done"])
        self.assertEqual(bus["events"][-1]["name"], "done")
        self.assertEqual(main._agent_run_state_read("r1")["status"], "finished")
if __name__ == "__main__":
    unittest.main()
