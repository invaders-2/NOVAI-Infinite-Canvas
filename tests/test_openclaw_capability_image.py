#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenClaw 能力后端：NOVAI 侧生图产物不该被会话模型失败判死。

真实环境里 OpenClaw 会话模型可能因为供应商限流/网关问题失败；生图能力（交付物是图片）
已经由 NOVAI 的既有生图链路产出并登记，此时整次运行仍应算成功（失败原因写进 message）。
报告类能力没有产物时仍必须判失败。

不打真实网关/上游：整体替换 OpenClawGatewayClient 与 AGENT_IMAGE_GENERATE。
"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["NOVAI_CAPABILITY_BACKEND"] = "openclaw"
os.environ["NOVAI_CAPABILITY_OPENCLAW_MODE"] = "agent"
import main  # noqa: E402
from server.agents import store  # noqa: E402
from server.integrations import openclaw_capability  # noqa: E402
from server.routes.deps import deps  # noqa: E402

IMAGE_CAP = {
    "id": "main-image-gen", "name": "主图生成", "kind": "agent",
    "description": "生成商品主图",
    "deliverables": [{"kind": "image", "name": "商品主图", "label": "商品主图"}],
    "skill_prompt": "生成主图",
}
REPORT_CAP = {
    "id": "style-money", "name": "风格找钱模型", "kind": "skill",
    "description": "分析报告",
    "deliverables": [{"kind": "html", "name": "报告.html", "label": "报告"}],
    "skill_prompt": "写报告",
}


class _FailingClient(object):
    def __init__(self, *args, **kwargs):
        pass

    async def chat_stream(self, *args, **kwargs):
        raise openclaw_capability.OpenClawError("供应商限流")


def _settings():
    return SimpleNamespace(agent_id="test", model="", capability_session_key=lambda run_id: "k:%s" % run_id)


class OpenClawImagePhaseTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-oc-image-")
        store.set_data_dir(self.root)
        self.original_generator = deps.get("AGENT_IMAGE_GENERATE")
        self.tmp_module_patches = []

    def tearDown(self):
        deps.bind(AGENT_IMAGE_GENERATE=self.original_generator)
        shutil.rmtree(self.root, ignore_errors=True)

    def _run(self, cap, params):
        run = store.create_run(cap["id"], store.new_session_id(), files=[], params=params,
                               capability_id=cap["id"], capability_name=cap["name"])
        run_id = run["run_id"]
        events = []
        with patch.object(openclaw_capability, "capability_settings", lambda: (_settings(), "test-model")), \
                patch.object(openclaw_capability, "OpenClawGatewayClient", _FailingClient):
            asyncio.run(openclaw_capability.run(run_id, cap, run, [], params,
                                                lambda e, d: events.append((e, d))))
        return store.load_run(run_id) or {}, events

    def test_image_phase_artifacts_survive_model_failure(self):
        async def fake_generator(spec):
            path = os.path.join(spec["output_dir"], "gen.png")
            os.makedirs(spec["output_dir"], exist_ok=True)
            with open(path, "wb") as handle:
                handle.write(b"png")
            item = store.add_artifact(spec["run_id"], "image", "gen.png", path)
            return {"provider": "p", "model": "m", "size": "1024x1024", "count": 1,
                    "images": [{"name": "gen.png", "url": item.get("url"), "bytes": 3}]}

        deps.bind(AGENT_IMAGE_GENERATE=fake_generator)
        record, events = self._run(IMAGE_CAP, {"image_provider": "p", "image_model": "m"})
        self.assertEqual(record["status"], "ok")
        self.assertIn("生图链路已产出", record["message"])
        self.assertEqual(record["artifacts"][0]["name"], "gen.png")
        self.assertTrue(any(e[0] == "done" and e[1].get("status") == "ok" for e in events))

    def test_report_capability_still_fails_without_artifacts(self):
        record, events = self._run(REPORT_CAP, {})
        self.assertEqual(record["status"], "failed")
        self.assertIn("OpenClaw 能力运行失败", record["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
