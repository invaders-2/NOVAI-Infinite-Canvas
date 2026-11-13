# -*- coding: utf-8 -*-
"""生成张数不再被静默吞掉（请求 4 张、模型一次最多 1 张时也不能变成 1 张）。

覆盖：
- 画布直发图片执行端按模型单次上限拆批，总数不变（4→[1,1,1,1] / n_max=2→[2,2]）；
- 助手 generate_image 的 validate 保留请求张数，并用 max_batch / batch_note 把模型上限如实告诉调用方；
- 经典画布 generate_image 请求 4 张时真的建 4 个生成任务（以前写死 n=1）。
"""
import asyncio
import os
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-count-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


class RequestBatchTests(unittest.TestCase):
    def _batches(self, n, n_max):
        caps = {"n_max": n_max} if n_max else {}
        with patch.object(main, "model_caps_for", new=lambda *a, **k: caps):
            return main.direct_image_request_batches("p", "m", n)

    def test_model_max_one_still_requests_four(self):
        batches = self._batches(4, 1)
        self.assertEqual(batches, [1, 1, 1, 1], "请求 4 张、模型一次 1 张 → 拆成 4 次单张请求")
        self.assertEqual(sum(batches), 4)

    def test_model_max_two_splits_in_twos(self):
        self.assertEqual(self._batches(4, 2), [2, 2])
        self.assertEqual(self._batches(5, 2), [2, 2, 1], "余数也要发出去，不能丢")

    def test_model_max_larger_than_request_keeps_one_call(self):
        self.assertEqual(self._batches(4, 6), [4])

    def test_unknown_caps_keep_old_behavior_but_do_not_swallow(self):
        self.assertEqual(self._batches(4, 0), [1, 1, 1, 1])

    def test_compat_count_helper_returns_per_batch(self):
        with patch.object(main, "model_caps_for", new=lambda *a, **k: {"n_max": 1}):
            self.assertEqual(main.direct_image_request_count("p", "m", 4), 1)


class GenerateImageValidateTests(unittest.TestCase):
    def test_count_four_is_preserved_and_batch_reported(self):
        args = {"canvas_id": "c1", "prompt": "白底产品图", "count": 4,
                "provider": "p", "model": "m", "size": "1024x1024", "ratio": "1:1"}
        caps = {"n_max": 1, "ratios": [], "resolutions": []}
        with patch.object(main, "load_canvas", new=lambda cid: {"id": cid, "nodes": []}), \
                patch.object(main, "_agent_resolve_media_target",
                             new=lambda *a, **k: ("p", "m", "")), \
                patch.object(main, "agent_image_size", new=lambda *a, **k: "1024x1024"), \
                patch.object(main, "model_caps_for", new=lambda *a, **k: caps):
            norm = main._agent_tool_generate_image_validate(args)
        self.assertEqual(norm["count"], 4, "请求 4 张不能被模型 n_max=1 静默改成 1")
        self.assertEqual(norm["max_batch"], 1)
        self.assertIn("一次最多 1 张", norm["batch_note"])
        self.assertTrue(any("一次最多 1 张" in note for note in norm.get("caps_notes") or []))
        self.assertFalse(any(str(note).startswith("张数 4") for note in norm.get("caps_notes") or []),
                         "不能再出现「张数 4 → 1」这种静默收敛说明")


class ClassicGenerateImageTests(unittest.TestCase):
    def test_classic_path_creates_one_task_per_requested_image(self):
        created = []

        def fake_task_create(**kwargs):
            task_id = "t%d" % (len(created) + 1)
            created.append({"id": task_id, "payload": kwargs.get("payload") or {}})
            return {"id": task_id}

        def fake_create_node_run(args):
            return {"node_id": "n" + args["type"]}

        args = {"canvas_id": "c1", "prompt": "白底产品图", "count": 4,
                "provider": "p", "model": "m", "size": "1024x1024",
                "title": "产品图", "reference_urls": [], "model_note": "", "caps_notes": []}
        with patch.object(main, "load_canvas", new=lambda cid: {"id": cid, "nodes": []}), \
                patch.object(main, "_agent_tool_create_node_validate", new=lambda a: a), \
                patch.object(main, "_agent_tool_create_node_run", new=fake_create_node_run), \
                patch.object(main, "_agent_tool_connect_nodes_validate", new=lambda a: a), \
                patch.object(main, "_agent_tool_connect_nodes_run", new=lambda a: {}), \
                patch.object(main, "_agent_mutate_canvas", new=lambda cid, fn: fn({"nodes": []})), \
                patch.object(main, "task_create", new=fake_task_create), \
                patch.object(main, "task_enqueue", new=AsyncMock(return_value=None)):
            result = asyncio.run(main._agent_tool_generate_image_run_classic(args))
        self.assertEqual(result["count"], 4)
        self.assertEqual(len(result["task_ids"]), 4, "请求 4 张要真的提交 4 个任务")
        self.assertEqual(len(created), 4)
        self.assertTrue(all(task["payload"].get("n") == 1 for task in created),
                        "每个任务单张请求，靠任务数保证总数")


if __name__ == "__main__":
    unittest.main()
