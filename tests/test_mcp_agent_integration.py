# -*- coding: utf-8 -*-
"""MCP × Agent 集成：目录并入、mcp__* 执行、确认闸门、producer 全链路（打桩模型）。

真实调用链路：agent_execute_step → registry → stdio 子进程（tests/fixtures/mcp_fake_server.py），
不解 MCP 的 mock。
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

FAKE_SERVER = str(ROOT / "tests" / "fixtures" / "mcp_fake_server.py")
_TMP_DATA = tempfile.mkdtemp(prefix="novai-mcp-agent-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main  # noqa: E402
from server.mcp import registry  # noqa: E402


def tearDownModule():
    registry.reset_cache()
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def snapshot():
    return {"id": "c1", "kind": "smart", "title": "测试画布",
            "nodes": [{"id": "p1", "type": "smart-prompt", "alias": "提示词1", "title": "提示词",
                       "text": "做个东西"}],
            "connections": []}


def mcp_config(tmp, enabled=True, timeout=30):
    path = os.path.join(tmp, "mcp_servers.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"mcpServers": {"fake": {
            "command": sys.executable, "args": [FAKE_SERVER],
            "env": {"SECRET_TOKEN": "不要泄露"}, "timeout": timeout, "enabled": enabled}}}, fh)
    return path


class McpAgentTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-mcp-agent-cfg-")
        self.config_path = mcp_config(self.tmp)
        self.env = patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "1",
                                           "NOVAI_MCP_CONFIG": self.config_path})
        self.env.start()
        registry.reset_cache()
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        self.env.stop()
        registry.reset_cache()
        main._AGENT_RUN_BUS.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- 目录 ----

    def test_catalog_contains_mcp_tools_with_server_prefix(self):
        catalog = {item["name"]: item for item in main._agent_build_tools_catalog()}
        self.assertIn("mcp__fake__echo", catalog)
        self.assertIn("mcp__fake__slow", catalog)
        self.assertIn("fake", catalog["mcp__fake__echo"]["description"])
        self.assertEqual(catalog["mcp__fake__echo"]["schema"]["type"], "object")

    def test_catalog_without_mcp_is_unchanged(self):
        with patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "0"}):
            registry.reset_cache()
            names = [item["name"] for item in main._agent_build_tools_catalog()]
        self.assertFalse([name for name in names if name.startswith("mcp__")])

    def test_canvas_context_tools_include_mcp(self):
        tools = main._CanvasRunContext({"canvas_id": "c1"}).tools()
        self.assertIn("mcp__fake__echo", tools)
        self.assertIn("create_node", tools)          # 原有工具一个不少

    # ---- 执行 ----

    def test_execute_step_calls_real_mcp_server(self):
        result = asyncio.run(main.agent_execute_step("mcp__fake__echo", {"text": "hello"}))
        self.assertTrue(result["ok"])
        text = result["result"]["content"][0]["text"]
        self.assertIn("echo: hello", text)

    def test_execute_step_reports_mcp_errors(self):
        result = asyncio.run(main.agent_execute_step("mcp__fake__nope", {}))
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "unknown_tool")

    def test_execute_step_mcp_disabled(self):
        with patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "0"}):
            registry.reset_cache()
            result = asyncio.run(main.agent_execute_step("mcp__fake__echo", {"text": "x"}))
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "mcp_disabled")

    # ---- 确认闸门 ----

    def test_mcp_tools_require_confirmation(self):
        gate = main.agent_plan_confirmation_needed([{"tool": "mcp__fake__echo", "args": {}}])
        self.assertTrue(gate["needed"])
        self.assertEqual(gate["tools"], ["mcp__fake__echo"])
        self.assertFalse(main.agent_plan_confirmation_needed(
            [{"tool": "mcp__fake__echo", "args": {}}], confirmed=True)["needed"])
        self.assertFalse(main.agent_plan_confirmation_needed(
            [{"tool": "check_task", "args": {}}])["needed"])

    # ---- producer 全链路 ----

    def _run_producer(self, req, decide):
        queue = asyncio.Queue()

        async def go():
            with patch.object(main, "load_canvas", return_value=snapshot()), \
                    patch.object(main, "agent_session_save"), \
                    patch.object(main, "_agent_run_decide", new=AsyncMock(side_effect=decide)):
                await main._agent_run_producer(req, queue)

        asyncio.run(go())
        events = []
        while not queue.empty():
            raw = queue.get_nowait()
            if not isinstance(raw, str):      # producer 结束时的 None 哨兵
                continue
            event, data = None, None
            for line in raw.split("\n"):
                if line.startswith("event: "):
                    event = line[len("event: "):]
                elif line.startswith("data: "):
                    data = json.loads(line[len("data: "):])
            if event is not None:
                events.append({"event": event, "data": data})
        return events

    def _req(self, **extra):
        req = {"run_id": "run_mcp", "canvas_id": "c1", "instruction": "用 MCP 工具做点事",
               "focus": main._agent_run_normalize_focus(None), "history": [],
               "chat": {"provider": "p", "base": "http://x", "headers": {}, "model": "test-chat-model",
                        "provider_cfg": {}},
               "max_steps": 4, "mode": "run"}
        req.update(extra)
        return req

    def test_producer_executes_approved_mcp_step(self):
        seen = {}

        async def decide(chat, system, user_content, context_id, tools_json_text="", tools=None):
            seen["system"] = system
            seen["tools_json"] = tools_json_text
            return {"done": True, "message": "完成"}

        req = self._req(approved_steps=[{"tool": "mcp__fake__echo", "args": {"text": "hello"}}])
        events = self._run_producer(req, decide)
        self.assertIn("mcp__fake__echo", seen["tools_json"])
        self.assertNotIn("不要泄露", seen["system"])
        dumped = json.dumps(events, ensure_ascii=False)
        self.assertIn("echo: hello", dumped)

    def test_producer_blocks_unapproved_mcp_step(self):
        async def decide(chat, system, user_content, context_id, tools_json_text="", tools=None):
            return {"thought": "调用 MCP", "steps": [{"tool": "mcp__fake__echo",
                                                      "args": {"text": "x"}}]}

        events = self._run_producer(self._req(), decide)
        plans = [item for item in events if item.get("event") == "plan"]
        self.assertEqual(len(plans), 1)
        plan = plans[0]["data"]
        self.assertIn("mcp__fake__echo", json.dumps(plan, ensure_ascii=False))
        self.assertIn("mcp__fake__echo", plan.get("blocked_tools") or [])
        self.assertNotIn("echo:", json.dumps(events, ensure_ascii=False))   # 没确认 → 不执行


if __name__ == "__main__":
    unittest.main()
