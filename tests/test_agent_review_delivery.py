# -*- coding: utf-8 -*-
"""审查结论的投递与持久化：每批一条 review 事件 + 写进那条回复，刷新后还能看到。"""
import asyncio
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

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-review-delivery-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402

ITEM = {"label": "海报", "node_id": "n1", "url": "/output/a.png", "kind": "image",
        "ok": False, "issues": ["杯身变形"], "revised_prompt": "杯身笔直"}


class ReviewDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="novai-review-threads-")
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.patch = patch.object(main, "AGENT_THREADS_DIR", self.dir)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def _thread(self):
        return main._agent_thread_active(main._agent_thread_doc_load("c1"))

    def _seed_reply(self, run_id="run_x"):
        main.agent_thread_append("c1", [{"role": "assistant", "text": "已生成", "run_id": run_id}])
        return self._thread()["id"]

    def test_attach_reviews_reaches_message_row(self):
        thread_id = self._seed_reply()
        payload = {"summary": "有一张不合格", "model": "vm", "skipped": False, "items": [ITEM]}
        self.assertTrue(main._agent_thread_attach_reviews("c1", thread_id, "run_x", [payload]))
        msg = [m for m in self._thread()["messages"] if m.get("run_id") == "run_x"][-1]
        self.assertEqual(msg["reviews"][0]["summary"], "有一张不合格")
        row = main._agent_thread_message_row(msg)
        self.assertIn("reviews", row)
        self.assertEqual(row["reviews"][0]["items"][0]["issues"], ["杯身变形"])

    def test_background_review_emits_one_batch_and_persists(self):
        self._seed_reply("run_y")
        review = {"summary": "两张都有问题", "model": "vm",
                  "items": [dict(ITEM), dict(ITEM, label="海报 2", node_id="n2")]}
        events = []
        run_reviews = []
        with patch.object(main, "_agent_beat_review", new=AsyncMock(return_value=review)), \
                patch.object(main, "_agent_regen_reset_review_reruns", new=lambda *a, **k: 0):
            asyncio.run(main._agent_review_background(
                {}, "做两张海报", [], [{"ok": True, "node_id": "n1", "url": "x"},
                                     {"ok": True, "node_id": "n2", "url": "y"}],
                None, lambda name, data: events.append((name, data)),
                "run_y", 1, {}, "c1", [], thread_id="", run_reviews=run_reviews))
        reviews = [data for name, data in events if name == "review"]
        self.assertEqual(len(reviews), 1, "每批只发一条审查事件")
        self.assertEqual(len(reviews[0]["items"]), 2)
        self.assertFalse(reviews[0]["skipped"])
        self.assertEqual(run_reviews[0]["summary"], "两张都有问题")
        msg = [m for m in self._thread()["messages"] if m.get("run_id") == "run_y"][-1]
        self.assertEqual(msg["reviews"][0]["summary"], "两张都有问题")

    def test_skipped_review_still_lands_in_thread(self):
        self._seed_reply("run_z")
        skipped = {"summary": "这批结果没审查成", "model": "", "items": [], "skipped": True}
        events = []
        with patch.object(main, "_agent_beat_review", new=AsyncMock(return_value=skipped)), \
                patch.object(main, "_agent_regen_reset_review_reruns", new=lambda *a, **k: 0):
            asyncio.run(main._agent_review_background(
                {}, "做两张海报", [], [{"ok": True, "node_id": "n1", "url": "x"}],
                None, lambda name, data: events.append((name, data)),
                "run_z", 1, {}, "c1", [], thread_id=""))
        self.assertTrue(events[0][1]["skipped"])
        msg = [m for m in self._thread()["messages"] if m.get("run_id") == "run_z"][-1]
        self.assertTrue(msg["reviews"][0]["skipped"])


if __name__ == "__main__":
    unittest.main()
