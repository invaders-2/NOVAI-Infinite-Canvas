# -*- coding: utf-8 -*-
"""GET /api/agent/runs/{run_id}/model-context：模型上下文摘要（不含提示词原文）。

覆盖：字段齐全、过期 run 404、没有 debug 快照时缺字段给 null、真实 run 的 tool_names 与工具目录一致。
"""
import asyncio
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

_TMP = tempfile.mkdtemp(prefix="novai-agent-model-context-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

CLIENT = TestClient(main.app)
FIELDS = {"run_id", "model", "system_prompt_chars", "system_prompt_sections", "tool_count",
          "tool_names", "history_chars", "instruction_chars", "estimated_tokens",
          "context_max", "percentage"}


def tearDownModule():
    main._AGENT_RUN_BUS.clear()
    shutil.rmtree(_TMP, ignore_errors=True)


def get_context(run_id):
    return CLIENT.get("/api/agent/runs/%s/model-context" % run_id)


class ModelContextTests(unittest.TestCase):

    def setUp(self):
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        main._AGENT_RUN_BUS.clear()

    def test_expired_run_is_404(self):
        resp = get_context("run_does_not_exist")
        self.assertEqual(resp.status_code, 404)
        self.assertIn("已过期", resp.json()["detail"])

    def test_fields_present_and_missing_are_null(self):
        bus = main._agent_run_bus_new("run_ctx_empty")
        self.assertEqual(bus["run_id"], "run_ctx_empty")
        resp = get_context("run_ctx_empty")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(set(body.keys()), FIELDS)
        self.assertEqual(body["run_id"], "run_ctx_empty")
        for key in FIELDS - {"run_id"}:
            self.assertIsNone(body[key], key)

    def test_fallback_from_bus_events(self):
        bus = main._agent_run_bus_new("run_ctx_fallback")
        main._agent_run_bus_publish(bus, "run_start", {"run_id": "run_ctx_fallback",
                                                       "model": "fallback-model", "max_steps": 4})
        main._agent_run_bus_publish(bus, "context_usage", {"used_tokens": 123,
                                                           "max_tokens": 1000,
                                                           "percentage": 12.3})
        body = get_context("run_ctx_fallback").json()
        self.assertEqual(body["model"], "fallback-model")
        self.assertEqual(body["estimated_tokens"], 123)
        self.assertEqual(body["context_max"], 1000)
        self.assertEqual(body["percentage"], 12.3)
        self.assertIsNone(body["system_prompt_chars"])
        self.assertIsNone(body["tool_names"])

    def test_real_run_matches_tool_catalog(self):
        canvas = main.new_canvas("上下文摘要画布", kind="smart")
        canvas_id = canvas["id"]
        run_id = "run_ctx_real"
        bus = main._agent_run_bus_new(run_id, canvas_id)
        instruction = "做个东西"
        req = {
            "run_id": run_id,
            "canvas_id": canvas_id,
            "instruction": instruction,
            "focus": main._agent_run_normalize_focus(None),
            "history": [],
            "chat": {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
                     "model": "test-chat-model", "provider_cfg": {}, "context_max": 200000},
            "max_steps": 4,
            "mode": "run",
            "approved_steps": [],
        }

        async def fake_decide(*args, **kwargs):
            return {"done": True, "message": "完成"}

        async def go():
            with patch.object(main, "_agent_run_decide", new=AsyncMock(side_effect=fake_decide)), \
                    patch.object(main, "agent_session_save"):
                await main._agent_run_producer(req, None, bus=bus)

        asyncio.run(go())
        body = get_context(run_id).json()
        self.assertEqual(body["run_id"], run_id)
        self.assertEqual(body["model"], "test-chat-model")
        ctx = main._CanvasRunContext({"canvas_id": canvas_id,
                                      "focus": main._agent_run_normalize_focus(None)})
        expected_tools = list(ctx.tools().keys())
        self.assertEqual(body["tool_names"], expected_tools)
        self.assertEqual(body["tool_count"], len(expected_tools))
        self.assertGreater(body["system_prompt_chars"], 0)
        self.assertIn("role", body["system_prompt_sections"])
        self.assertIn("canvas", body["system_prompt_sections"])
        self.assertIn("tools", body["system_prompt_sections"])
        self.assertIn("skill_index", body["system_prompt_sections"])   # 没选中技能 → 索引模式
        self.assertEqual(body["instruction_chars"], len(instruction))
        self.assertIsInstance(body["history_chars"], int)
        self.assertGreater(body["estimated_tokens"], 0)
        self.assertGreater(body["context_max"], 0)
        self.assertIsInstance(body["percentage"], float)


if __name__ == "__main__":
    unittest.main()
