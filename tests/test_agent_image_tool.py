#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""能力运行时生图工具 image_generate 的接线测试（不打真实上游）。

覆盖：
  1. image_generate 已注册进 AGENT_FILE_TOOLS，且 agent_execute_step 能查到；
  2. 参考图按上传目录里的文件名解析成绝对路径后交给注入的生图执行器；
  3. 缺 prompt / 未注入执行器时明确报错（不静默兜底）。
真实出图由真机验证（见交付汇报），这里只锁接线与参数解析。
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main  # noqa: E402
from server.agents import tools, store  # noqa: E402
from server.routes.deps import deps  # noqa: E402


class ImageGenerateToolTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-image-tool-")
        store.set_data_dir(self.root)
        run = store.create_run("image_generate", store.new_session_id(), files=[], params={},
                               capability_id="image_generate", capability_name="自测")
        self.run_id = run["run_id"]
        self.uploads = store.run_uploads_dir(self.run_id)
        self.output = store.run_output_dir(self.run_id)
        os.makedirs(self.uploads, exist_ok=True)
        with open(os.path.join(self.uploads, "product.png"), "wb") as handle:
            handle.write(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
        self.files = [{"name": "product.png", "original": "商品图.png", "size": 40}]
        self.original_generator = deps.get("AGENT_IMAGE_GENERATE")

    def tearDown(self):
        deps.bind(AGENT_IMAGE_GENERATE=self.original_generator)
        shutil.rmtree(self.root, ignore_errors=True)

    def _with_run(self, fn):
        token = tools.set_current_run({
            "run_id": self.run_id,
            "uploads_dir": self.uploads,
            "output_dir": self.output,
            "files": self.files,
        })
        try:
            return fn()
        finally:
            tools.reset_current_run(token)

    def test_tool_is_registered_and_dispatchable(self):
        self.assertIn("image_generate", tools.AGENT_FILE_TOOLS)
        entry = tools.AGENT_FILE_TOOLS["image_generate"]
        self.assertEqual(entry["schema"]["required"], ["prompt"])
        self.assertEqual(main._AGENT_FILE_TOOLS["image_generate"]["run"], tools.image_generate)

    def test_reference_images_resolve_to_upload_paths(self):
        calls = []

        async def fake_generator(spec):
            calls.append(spec)
            return {"provider": "p", "model": "m", "size": spec.get("size") or "1024x1024",
                    "count": 1, "images": [{"name": "out.png", "url": "/u/out.png", "bytes": 12}]}

        deps.bind(AGENT_IMAGE_GENERATE=fake_generator)
        result = self._with_run(lambda: asyncio.run(tools.image_generate(
            {"prompt": "一只猫", "reference_images": ["product.png"]})))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["reference_images"], [os.path.join(self.uploads, "product.png")])
        self.assertEqual(calls[0]["run_id"], self.run_id)
        self.assertEqual(result["images"][0]["name"], "out.png")
        self.assertEqual(result["reference_count"], 1)

    def test_default_reference_is_uploaded_image(self):
        calls = []

        async def fake_generator(spec):
            calls.append(spec)
            return {"images": [{"name": "out.png", "url": "/u/out.png", "bytes": 1}]}

        deps.bind(AGENT_IMAGE_GENERATE=fake_generator)
        self._with_run(lambda: asyncio.run(tools.image_generate({"prompt": "一只猫"})))
        self.assertEqual(calls[0]["reference_images"], [os.path.join(self.uploads, "product.png")])

    def test_missing_prompt_fails_loudly(self):
        with self.assertRaises(tools.AgentFileToolError):
            self._with_run(lambda: asyncio.run(tools.image_generate({})))

    def test_missing_generator_fails_loudly(self):
        deps.bind(AGENT_IMAGE_GENERATE=None)
        with self.assertRaises(tools.AgentFileToolError) as ctx:
            self._with_run(lambda: asyncio.run(tools.image_generate({"prompt": "一只猫"})))
        self.assertEqual(ctx.exception.code, "image_backend_missing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
