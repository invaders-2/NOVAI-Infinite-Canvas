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
import urllib.parse
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

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="novai-open-agent-home-")
        self.env = patch.dict(os.environ, {"HOME": self.home})
        self.env.start()
        mcp_routes._reset_cli_detect_cache()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.home, ignore_errors=True)
        mcp_routes._reset_cli_detect_cache()

    def _agents(self):
        resp = CLIENT.get("/api/mcp/installed-agents")
        self.assertEqual(resp.status_code, 200)
        return {item["id"]: item for item in resp.json()["agents"]}

    def test_detects_apps_and_clis_and_reports_install_fields(self):
        with patch.object(mcp_routes.os.path, "isdir",
                          side_effect=fake_isdir({"/Applications/Claude.app",
                                                  "/Applications/Kimi Code.app",
                                                  "/Applications/DeepSeek Harness.app"})), \
                patch.object(mcp_routes.shutil, "which",
                             side_effect=fake_which({"codex": "/Users/x/.npm-global/bin/codex"})):
            by_id = self._agents()
        self.assertEqual(list(by_id.keys()),
                         ["claude", "chatgpt", "workbuddy", "kimi", "dsh",
                          "codex", "claude-cli", "hermes"])

        desktop_keys = {"id", "name", "kind", "installed", "path", "installable",
                        "launchable", "config_path", "configured", "configured_base_url"}
        cli_keys = {"id", "name", "kind", "installed", "command", "installable",
                    "launchable", "config_path", "configured", "configured_base_url"}
        for agent_id in ("claude", "chatgpt", "workbuddy", "kimi", "dsh"):
            with self.subTest(agent=agent_id):
                keys = set(by_id[agent_id].keys())
                self.assertTrue(desktop_keys <= keys)
                self.assertTrue(keys <= desktop_keys | {"reason"})
                self.assertTrue(by_id[agent_id]["launchable"])
        for agent_id in ("codex", "claude-cli", "hermes"):
            with self.subTest(agent=agent_id):
                keys = set(by_id[agent_id].keys())
                self.assertTrue(cli_keys <= keys)
                self.assertTrue(keys <= cli_keys | {"reason"})
                self.assertFalse(by_id[agent_id]["launchable"])

        self.assertTrue(by_id["claude"]["installed"])
        self.assertEqual(by_id["claude"]["path"], "/Applications/Claude.app")
        self.assertTrue(by_id["claude"]["installable"])
        self.assertTrue(by_id["claude"]["config_path"].endswith(
            os.path.join("Library", "Application Support", "Claude", "claude_desktop_config.json")))

        self.assertFalse(by_id["chatgpt"]["installed"])
        self.assertEqual(by_id["chatgpt"]["path"], "")
        self.assertFalse(by_id["chatgpt"]["installable"])
        self.assertIn("reason", by_id["chatgpt"])

        self.assertFalse(by_id["workbuddy"]["installed"])
        self.assertTrue(by_id["workbuddy"]["installable"])
        self.assertEqual(by_id["workbuddy"]["config_path"],
                         os.path.join(self.home, ".workbuddy", "mcp.json"))

        self.assertTrue(by_id["kimi"]["installed"])
        self.assertTrue(by_id["kimi"]["installable"])
        self.assertEqual(by_id["kimi"]["config_path"],
                         os.path.join(self.home, ".kimi-code", "mcp.json"))

        self.assertTrue(by_id["dsh"]["installed"])
        self.assertFalse(by_id["dsh"]["installable"])
        self.assertIn("profile", by_id["dsh"]["reason"])

        self.assertTrue(by_id["codex"]["installed"])
        self.assertEqual(by_id["codex"]["command"], "/Users/x/.npm-global/bin/codex")
        self.assertTrue(by_id["codex"]["installable"])
        self.assertEqual(by_id["codex"]["config_path"],
                         os.path.join(self.home, ".codex", "config.toml"))
        self.assertFalse(by_id["claude-cli"]["installed"])
        self.assertEqual(by_id["claude-cli"]["command"], "")
        self.assertTrue(by_id["claude-cli"]["installable"])
        self.assertFalse(by_id["hermes"]["installed"])

    def test_kimi_counts_as_installed_with_cli_only(self):
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir(set())), \
                patch.object(mcp_routes.shutil, "which",
                             side_effect=fake_which({"kimi": "/Users/x/.kimi-code/bin/kimi"})):
            by_id = self._agents()
        self.assertTrue(by_id["kimi"]["installed"])
        self.assertEqual(by_id["kimi"]["path"], "")

    def test_cli_config_detection_is_cached(self):
        fake = SimpleNamespace(returncode=0, stderr="",
                               stdout="novai-canvas:\n  env NOVAI_BASE_URL=http://127.0.0.1:4321\n")
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir(set())), \
                patch.object(mcp_routes.shutil, "which",
                             side_effect=fake_which({"claude": "/x/claude"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=fake) as run:
            first = self._agents()
            second = self._agents()
        run.assert_called_once()                      # 30s 缓存内不再起进程
        self.assertTrue(first["claude-cli"]["configured"])
        self.assertEqual(first["claude-cli"]["configured_base_url"], "http://127.0.0.1:4321")
        self.assertEqual(second["claude-cli"]["configured_base_url"], "http://127.0.0.1:4321")

    def test_cli_detection_failure_means_unconfigured(self):
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir(set())), \
                patch.object(mcp_routes.shutil, "which",
                             side_effect=fake_which({"claude": "/x/claude", "hermes": "/x/hermes"})), \
                patch.object(mcp_routes.subprocess, "run",
                             side_effect=TimeoutError("slow")):
            by_id = self._agents()
        self.assertFalse(by_id["claude-cli"]["configured"])
        self.assertFalse(by_id["hermes"]["configured"])

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

    def test_open_claude_with_prompt_uses_deep_link(self):
        prompt = "请通过 MCP 连接 NOVAI 画布 & 继续 / 当前项目？\n第 2 行：a=b#c"
        ok = SimpleNamespace(returncode=0, stderr="")
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir({"/Applications/Claude.app"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=ok) as run:
            resp = CLIENT.post("/api/mcp/open-agent", json={"id": "claude", "prompt": prompt})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"ok": True, "action": "deep_link", "app": "Claude"})
        run.assert_called_once()
        args, kwargs = run.call_args
        argv = args[0]
        self.assertEqual(argv[0], "open")
        self.assertEqual(len(argv), 2)
        self.assertTrue(argv[1].startswith("claude://claude.ai/new?q="), argv[1])
        query = urllib.parse.urlparse(argv[1]).query
        self.assertEqual(urllib.parse.parse_qs(query).get("q"), [prompt])
        self.assertNotEqual(kwargs.get("shell"), True)

    def test_open_claude_empty_prompt_keeps_open_app(self):
        ok = SimpleNamespace(returncode=0, stderr="")
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir({"/Applications/Claude.app"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=ok) as run:
            for prompt in ("", "   "):
                with self.subTest(prompt=prompt):
                    run.reset_mock()
                    resp = CLIENT.post("/api/mcp/open-agent", json={"id": "claude", "prompt": prompt})
                    self.assertEqual(resp.status_code, 200, resp.text)
                    self.assertEqual(resp.json(), {"ok": True, "action": "opened", "app": "Claude"})
                    run.assert_called_once()
                    self.assertEqual(run.call_args[0][0], ["open", "-a", "Claude"])

    def test_open_other_agent_ignores_prompt(self):
        ok = SimpleNamespace(returncode=0, stderr="")
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir({"/Applications/WorkBuddy.app"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=ok) as run:
            resp = CLIENT.post("/api/mcp/open-agent",
                               json={"id": "workbuddy", "prompt": "不该出现在深链里"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"ok": True, "action": "opened", "app": "WorkBuddy"})
        run.assert_called_once()
        argv = run.call_args[0][0]
        self.assertEqual(argv, ["open", "-a", "WorkBuddy"])
        self.assertFalse(any("claude://" in str(part) for part in argv))

    def test_deep_link_failure_falls_back_to_open_app(self):
        failed = SimpleNamespace(returncode=1, stderr="no handler")
        ok = SimpleNamespace(returncode=0, stderr="")
        with patch.object(mcp_routes.os.path, "isdir", side_effect=fake_isdir({"/Applications/Claude.app"})), \
                patch.object(mcp_routes.subprocess, "run", side_effect=[failed, ok]) as run:
            resp = CLIENT.post("/api/mcp/open-agent", json={"id": "claude", "prompt": "预填提示词"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"ok": True, "action": "opened", "app": "Claude"})
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[1][0][0], ["open", "-a", "Claude"])

    def test_prompt_over_limit_is_422_before_any_call(self):
        with patch.object(mcp_routes.subprocess, "run") as run:
            resp = CLIENT.post("/api/mcp/open-agent",
                               json={"id": "claude", "prompt": "x" * 8001})
        self.assertEqual(resp.status_code, 422)
        run.assert_not_called()

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
