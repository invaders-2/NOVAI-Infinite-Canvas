# -*- coding: utf-8 -*-
"""done=true 同时带 steps 时：先执行步骤，再结束（不能把 done 当跳过执行）。

覆盖：
- steps=[create_node] + done=true → 节点真的建出来（不是 0 节点），done 消息仍是模型给的；
- steps=[] + done=true → 直接结束（原行为不变）；
- 事件/日志里有「本轮同时给了 done 和步骤」的说明（thought kind=done_with_steps）。
"""
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
    _TMP = tempfile.mkdtemp(prefix="novai-done-steps-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from tests.test_agent_reflect import new_canvas, run_producer  # noqa: E402

REAL_EXECUTE = main.agent_execute_step


async def real_execute(tool, args):
    """走真实工具执行：create_node 要真的落画布，才能抓到「done 跳过执行」的 bug。"""
    return await REAL_EXECUTE(tool, args)


def event_list(out):
    return [{"event": item.get("name"), "data": item.get("data")} for item in (out["bus"].get("events") or [])]


def done_event(out):
    for item in reversed(event_list(out)):
        if item["event"] == "done":
            return item["data"]
    raise AssertionError("运行没有发 done 事件")


class DoneWithStepsTests(unittest.TestCase):
    def setUp(self):
        if not main.DATA_DIR.startswith("/tmp") and "/private/tmp" not in str(main.DATA_DIR):
            self.skipTest("DATA_DIR 不是临时目录")
        self.canvas_id = new_canvas("done-steps")

    def test_done_with_create_node_executes_step_before_finishing(self):
        canvas_before = main.load_canvas(self.canvas_id)
        nodes_before = len(canvas_before.get("nodes") or [])
        out = run_producer(
            self.canvas_id,
            [{"done": True, "message": "节点头像已经建好了",
              "steps": [{"tool": "create_node",
                         "args": {"canvas_id": self.canvas_id, "type": "text",
                                  "text": "这是补建的旁白节点"}}]}],
            real_execute)
        canvas_after = main.load_canvas(self.canvas_id)
        nodes_after = len(canvas_after.get("nodes") or [])
        self.assertEqual(nodes_after, nodes_before + 1, "done 一起给的 steps 必须真的执行，不能 0 节点收尾")
        self.assertTrue(any("补建的旁白节点" in str(node.get("text") or "")
                            for node in canvas_after.get("nodes") or []))
        done = done_event(out)
        self.assertEqual(done.get("status"), "ok")
        self.assertEqual(done.get("message"), "节点头像已经建好了")
        notes = [item["data"] for item in event_list(out)
                 if item["event"] == "thought" and item["data"].get("kind") == "done_with_steps"]
        self.assertTrue(notes, "要在事件里说明本轮同时给了 done 和步骤")
        self.assertIn("先执行步骤", notes[0]["text"])

    def test_done_without_steps_still_finishes_immediately(self):
        canvas_before = main.load_canvas(self.canvas_id)
        nodes_before = len(canvas_before.get("nodes") or [])
        out = run_producer(self.canvas_id,
                           [{"done": True, "message": "直接完成"}], real_execute)
        nodes_after = len(main.load_canvas(self.canvas_id).get("nodes") or [])
        self.assertEqual(nodes_after, nodes_before, "没有步骤时不应该改画布")
        done = done_event(out)
        self.assertEqual(done.get("status"), "ok")
        self.assertEqual(done.get("message"), "直接完成")
        self.assertEqual(len(out["messages"]), 1, "原行为：done 直接结束，不再多跑一轮")

    def test_done_with_unusable_steps_is_not_treated_as_complete(self):
        out = run_producer(self.canvas_id, [
            {"done": True, "message": "完成",
             "steps": [{"tool": "totally_unknown_tool", "args": {}}]},
            {"done": True, "message": "这次真的完成了"},
        ], real_execute)
        done = done_event(out)
        self.assertEqual(done.get("status"), "ok")
        self.assertIn("这次真的完成了", done.get("message"),
                      "不可用步骤的 done 不能当完成，要回到循环让模型修正")


if __name__ == "__main__":
    unittest.main()
