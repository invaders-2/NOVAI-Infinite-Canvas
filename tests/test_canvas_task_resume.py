#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成任务跨页面续跑的后端部分：任务记录上的 canvas_id/node_id 绑定 + /api/canvas-tasks 的画布过滤与字段。

跑法：
    venv/bin/python -m unittest tests.test_canvas_task_resume -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

os.environ["NOVAI_DATA_DIR"] = tempfile.mkdtemp(prefix="novai-canvas-task-resume-")
os.environ.pop("NOVAI_AUTH_ENABLED", None)

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def fresh_client() -> TestClient:
    return TestClient(main.app, client=("127.0.0.1", 50000), follow_redirects=False)


class CanvasTaskListTests(unittest.TestCase):
    def setUp(self):
        self.client = fresh_client()
        self.canvas_a = self.client.post("/api/canvases", json={"title": "续跑测试 A"}).json()["canvas"]["id"]
        self.canvas_b = self.client.post("/api/canvases", json={"title": "续跑测试 B"}).json()["canvas"]["id"]

    def _image_task(self, canvas_id: str, node_id: str, prompt: str = "画一只猫") -> dict:
        return main.task_create(
            kind="online-image",
            payload=main.OnlineImageRequest(prompt=prompt, canvas_id=canvas_id, node_id=node_id),
            runner_name="run_canvas_image_task",
            provider_id="comfly",
            model_id="seedream-test",
        )

    def test_task_records_canvas_and_node(self):
        task = self._image_task(self.canvas_a, "node-1")
        self.assertEqual(task["canvas_id"], self.canvas_a)
        self.assertEqual(task["node_id"], "node-1")
        # runner 重跑要能把 payload 还原成请求对象：新字段必须被模型接受
        restored = main._task_restore_payload(main.task_get(task["id"]))
        self.assertEqual(restored.canvas_id, self.canvas_a)
        self.assertEqual(restored.node_id, "node-1")

    def test_list_filters_by_canvas_and_returns_resume_fields(self):
        task = self._image_task(self.canvas_a, "node-1")
        main.task_set_status(task["id"], "running")
        main.task_set_status(task["id"], "provider_processing")
        main.task_set_status(task["id"], "saving")
        main.task_set_status(task["id"], "succeeded", extra={"result": {"images": [{"url": "/output/a.png", "width": 512, "height": 512}]}})
        other = self._image_task(self.canvas_b, "node-2")

        data = self.client.get("/api/canvas-tasks", params={"canvas_id": self.canvas_a}).json()
        ids = [row["task_id"] for row in data["items"]]
        self.assertIn(task["id"], ids)
        self.assertNotIn(other["id"], ids)
        row = next(item for item in data["items"] if item["task_id"] == task["id"])
        self.assertEqual(row["node_id"], "node-1")
        self.assertEqual(row["kind"], "online-image")
        self.assertEqual(row["status"], "succeeded")
        self.assertEqual(row["model"], "seedream-test")
        self.assertEqual(row["result"]["images"][0]["url"], "/output/a.png")
        self.assertGreater(row["created_at"], 0)
        self.assertIn("error", row)

    def test_legacy_task_falls_back_to_payload(self):
        task_id = "legacy_canvas_task_1"
        with main.TASK_STORE_LOCK:
            main.TASK_STORE[task_id] = {
                "id": task_id, "kind": "video", "status": "running", "created_at": time.time(),
                "payload": {"canvas_id": self.canvas_a, "node_id": "node-legacy", "prompt": "旧任务"},
            }
        try:
            data = self.client.get("/api/canvas-tasks", params={"canvas_id": self.canvas_a}).json()
            row = next(item for item in data["items"] if item["task_id"] == task_id)
            self.assertEqual(row["node_id"], "node-legacy")
            self.assertEqual(row["kind"], "video")
            self.assertEqual(row["status"], "running")
        finally:
            with main.TASK_STORE_LOCK:
                main.TASK_STORE.pop(task_id, None)

    def test_cancelled_maps_to_failed(self):
        task = self._image_task(self.canvas_a, "node-3")
        main.task_set_status(task["id"], "cancel_requested")
        main.task_set_status(task["id"], "cancelled", error="任务已取消")
        data = self.client.get("/api/canvas-tasks", params={"canvas_id": self.canvas_a}).json()
        row = next(item for item in data["items"] if item["task_id"] == task["id"])
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["raw_status"], "cancelled")
        self.assertEqual(row["error"], "任务已取消")

    def test_requires_local_canvas_id(self):
        self.assertEqual(self.client.get("/api/canvas-tasks").status_code, 422)
        self.assertEqual(self.client.get("/api/canvas-tasks", params={"canvas_id": "no-such-canvas"}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
