# -*- coding: utf-8 -*-
"""MCP 接入卡：本机 Agent 检测（GET /api/mcp/installed-agents）与跳转（POST /api/mcp/open-agent）。

检测只读；跳转只允许白名单，桌面端 argv 调 open，CLI 只返回命令；绝不 shell=True。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-mcp-open-agent-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402
from server.routes import mcp as mcp_routes  # noqa: E402

CLIENT = TestClient(main.app)


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def fake_isdir(existing):
    existing = set(existing)
    return lambda path: path in existing


def fake_which(mapping):
    return lambda command: mapping.get(command)


class InstalledAgentsTests(unittest.TestCase):

    def test_detects_apps_and_clis(self):
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir({"/Applications/Claude.app"})), \
                patch.object(mcp_routes.shutil, "which",
                             side_effect=fake_which({"codex": "/Users/x/.npm-global/bin/codex"})):
            resp = CLIENT.get("/api/mcp/installed-agents")
        self.assertEqual(resp.status_code, 200)
        agents = resp.json()["agents"]
        self.assertEqual([item["id"] for item in agents],
                         ["claude", "chatgpt", "workbuddy", "codex", "claude-cli"])
        by_id = {item["id"]: item for item in agents}
        # configured 是后加的字段（install-agent 用）；读取失败时还会多一个 reason
        claude_keys = set(by_id["claude"].keys())
        self.assertTrue({"id", "name", "kind", "installed", "path", "configured"} <= claude_keys)
        self.assertTrue(claude_keys <= {"id", "name", "kind", "installed", "path",
                                        "configured", "reason"})
        self.assertTrue(by_id["claude"]["installed"])
        self.assertEqual(by_id["claude"]["path"], "/Applications/Claude.app")
        self.assertEqual(by_id["claude"]["kind"], "desktop")
        self.assertFalse(by_id["chatgpt"]["installed"])
        self.assertEqual(by_id["chatgpt"]["path"], "")
        self.assertFalse(by_id["workbuddy"]["installed"])
        codex_keys = set(by_id["codex"].keys())
        self.assertTrue({"id", "name", "kind", "installed", "command", "configured"} <= codex_keys)
        self.assertTrue(codex_keys <= {"id", "name", "kind", "installed", "command",
                                        "configured", "reason"})
        self.assertTrue(by_id["codex"]["installed"])
        self.assertEqual(by_id["codex"]["command"], "/Users/x/.npm-global/bin/codex")
        self.assertFalse(by_id["claude-cli"]["installed"])
        self.assertEqual(by_id["claude-cli"]["command"], "")

    def test_detection_never_starts_process(self):
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir(set())), \
                patch.object(mcp_routes.shutil, "which", side_effect=fake_which({})), \
                patch.object(mcp_routes.subprocess, "run") as run:
            resp = CLIENT.get("/api/mcp/installed-agents")
        self.assertEqual(resp.status_code, 200)
        run.assert_not_called()


class OpenAgentTests(unittest.TestCase):

    def test_open_installed_desktop_uses_argv(self):
        fake_run = SimpleNamespace(returncode=0, stderr="")
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir({"/Applications/Claude.app"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=fake_run) as run:
            resp = CLIENT.post("/api/mcp/open-agent", json={"id": "claude"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"ok": True, "action": "opened", "app": "Claude"})
        run.assert_called_once()
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["open", "-a", "Claude"])
        self.assertNotEqual(kwargs.get("shell"), True)

    def test_open_missing_desktop_is_400(self):
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir(set())), \
                patch.object(mcp_routes.subprocess, "run") as run:
            resp = CLIENT.post("/api/mcp/open-agent", json={"id": "chatgpt"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("未检测到本机安装", resp.json()["detail"])
        run.assert_not_called()

    def test_open_cli_returns_command_without_process(self):
        with patch.object(mcp_routes.shutil, "which",
                          side_effect=fake_which({"codex": "/Users/x/.npm-global/bin/codex"})), \
                patch.object(mcp_routes.subprocess, "run") as run:
            resp = CLIENT.post("/api/mcp/open-agent", json={"id": "codex"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"ok": True, "action": "command", "command": "codex"})
        run.assert_not_called()

    def test_unknown_id_is_400_before_any_call(self):
        with patch.object(mcp_routes.subprocess, "run") as run, \
                patch.object(mcp_routes.shutil, "which") as which:
            for agent_id in ("bash", "claude; rm -rf /", "claude || echo hacked",
                             "$(whoami)", "../claude", "", "Claude", "codex2"):
                with self.subTest(agent_id=agent_id):
                    resp = CLIENT.post("/api/mcp/open-agent", json={"id": agent_id})
                    self.assertEqual(resp.status_code, 400)
                    self.assertIn("不支持的 Agent", resp.json()["detail"])
        run.assert_not_called()
        which.assert_not_called()

    def test_open_failure_is_500_with_stderr(self):
        failed = SimpleNamespace(returncode=1, stderr="kLSSharedFileList: launch failed")
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir({"/Applications/Claude.app"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=failed):
            resp = CLIENT.post("/api/mcp/open-agent", json={"id": "claude"})
        self.assertEqual(resp.status_code, 500)
        self.assertIn("launch failed", resp.json()["detail"])

    def test_open_exception_is_500(self):
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir({"/Applications/Claude.app"})), \
                patch.object(mcp_routes.subprocess, "run", side_effect=FileNotFoundError("open missing")):
            resp = CLIENT.post("/api/mcp/open-agent", json={"id": "claude"})
        self.assertEqual(resp.status_code, 500)
        self.assertIn("open missing", resp.json()["detail"])


if __name__ == "__main__":
    unittest.main()
