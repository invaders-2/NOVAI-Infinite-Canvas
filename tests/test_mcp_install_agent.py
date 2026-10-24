# -*- coding: utf-8 -*-
"""一键写入 Agent 配置：configured 检测 + POST /api/mcp/install-agent。

全部用临时 HOME 隔离，绝不碰真实 ~/Library / ~/.codex；cli 走 mock subprocess。
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

_TMP = tempfile.mkdtemp(prefix="novai-mcp-install-agent-")
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


def claude_config_path(home):
    return os.path.join(home, "Library", "Application Support", "Claude",
                        "claude_desktop_config.json")


def codex_config_path(home):
    return os.path.join(home, ".codex", "config.toml")


class _HomeMixin(unittest.TestCase):

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="novai-home-")
        self.env = patch.dict(os.environ, {"HOME": self.home})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.home, ignore_errors=True)

    def install(self, payload):
        return CLIENT.post("/api/mcp/install-agent", json=payload)


class InstallClaudeTests(_HomeMixin):

    def test_creates_config_when_missing(self):
        with patch.object(mcp_routes, "_desktop_agent_path", return_value="/Applications/Claude.app"):
            resp = self.install({"id": "claude", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        path = claude_config_path(self.home)
        self.assertEqual(body["action"], "written")
        self.assertEqual(body["path"], path)
        self.assertEqual(body["backup"], "")
        self.assertFalse(body["already"])
        self.assertTrue(body["needs_restart"])
        self.assertTrue(os.path.isfile(path))
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        expected = CLIENT.get("/api/mcp/connect-info").json()["server_entry"]
        self.assertEqual(payload["mcpServers"]["novai-canvas"], expected)

    def test_preserves_other_servers_and_makes_backup(self):
        path = claude_config_path(self.home)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        original = json.dumps({"mcpServers": {"other": {"command": "x"}}, "theme": "dark"},
                              ensure_ascii=False).encode("utf-8")
        with open(path, "wb") as fh:
            fh.write(original)
        with patch.object(mcp_routes, "_desktop_agent_path", return_value="/Applications/Claude.app"):
            resp = self.install({"id": "claude", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertFalse(body["already"])
        self.assertTrue(body["backup"].startswith(path + ".bak."))
        self.assertTrue(os.path.isfile(body["backup"]))
        with open(body["backup"], "rb") as fh:
            self.assertEqual(fh.read(), original)
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        self.assertEqual(payload["theme"], "dark")
        self.assertEqual(payload["mcpServers"]["other"], {"command": "x"})
        self.assertIn("novai-canvas", payload["mcpServers"])

    def test_bad_json_keeps_original_bytes(self):
        path = claude_config_path(self.home)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        broken = b"{not valid json"
        with open(path, "wb") as fh:
            fh.write(broken)
        with patch.object(mcp_routes, "_desktop_agent_path", return_value="/Applications/Claude.app"):
            resp = self.install({"id": "claude", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("不是合法 JSON", resp.json()["detail"])
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), broken)

    def test_already_configured_is_idempotent(self):
        path = claude_config_path(self.home)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        payload = {"mcpServers": {"novai-canvas": {"command": "old-python", "args": ["old.py"],
                                                   "env": {"NOVAI_BASE_URL": "http://127.0.0.1:1"}}}}
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        with open(path, "rb") as fh:
            before = fh.read()
        with patch.object(mcp_routes, "_desktop_agent_path", return_value="/Applications/Claude.app"):
            resp = self.install({"id": "claude", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["already"])
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), before)

    def test_confirm_required(self):
        with patch.object(mcp_routes, "_desktop_agent_path", return_value="/Applications/Claude.app"):
            resp = self.install({"id": "claude"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("需要 confirm: true", resp.json()["detail"])
        self.assertFalse(os.path.isfile(claude_config_path(self.home)))

    def test_unknown_id_is_400(self):
        for agent_id in ("bash", "claude-cli", "../claude", ""):
            with self.subTest(agent_id=agent_id):
                resp = self.install({"id": agent_id, "confirm": True})
                self.assertEqual(resp.status_code, 400)
                self.assertIn("不支持的 Agent", resp.json()["detail"])
        self.assertFalse(os.path.isfile(claude_config_path(self.home)))

    def test_not_installed_is_400(self):
        with patch.object(mcp_routes, "_desktop_agent_path", return_value=""):
            resp = self.install({"id": "claude", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("未检测到本机安装", resp.json()["detail"])
        self.assertFalse(os.path.isfile(claude_config_path(self.home)))

    def test_extra_path_field_is_ignored(self):
        with patch.object(mcp_routes, "_desktop_agent_path", return_value="/Applications/Claude.app"):
            resp = self.install({"id": "claude", "confirm": True, "path": "/tmp/evil.json"})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertTrue(os.path.isfile(claude_config_path(self.home)))
        self.assertFalse(os.path.exists("/tmp/evil.json"))


class InstallCodexTests(_HomeMixin):

    def test_runs_codex_mcp_add_with_argv(self):
        fake = SimpleNamespace(returncode=0, stdout="added novai-canvas", stderr="")
        info = CLIENT.get("/api/mcp/connect-info").json()
        with patch.object(mcp_routes, "_cli_agent_command", return_value="/usr/local/bin/codex"), \
                patch.object(mcp_routes.subprocess, "run", return_value=fake) as run:
            resp = self.install({"id": "codex", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["action"], "command")
        self.assertIn("added novai-canvas", body["output"])
        self.assertTrue(body["needs_restart"])
        run.assert_called_once()
        argv = run.call_args[0][0]
        self.assertEqual(argv, [
            "/usr/local/bin/codex", "mcp", "add", "novai-canvas",
            "--env", "NOVAI_BASE_URL=%s" % info["base_url"],
            "--", info["server_entry"]["command"], info["server_py"],
        ])
        self.assertNotEqual(run.call_args[1].get("shell"), True)
        self.assertEqual(run.call_args[1].get("timeout"), 20)

    def test_codex_failure_is_500_with_output(self):
        fake = SimpleNamespace(returncode=1, stdout="", stderr="boom: invalid config")
        with patch.object(mcp_routes, "_cli_agent_command", return_value="/usr/local/bin/codex"), \
                patch.object(mcp_routes.subprocess, "run", return_value=fake):
            resp = self.install({"id": "codex", "confirm": True})
        self.assertEqual(resp.status_code, 500)
        self.assertIn("boom", resp.json()["detail"])

    def test_codex_not_installed_is_400(self):
        with patch.object(mcp_routes, "_cli_agent_command", return_value=""), \
                patch.object(mcp_routes.subprocess, "run") as run:
            resp = self.install({"id": "codex", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("未检测到本机安装", resp.json()["detail"])
        run.assert_not_called()


class ConfiguredDetectionTests(_HomeMixin):

    def _agents(self):
        return {item["id"]: item for item in CLIENT.get("/api/mcp/installed-agents").json()["agents"]}

    def test_configured_flags_and_readonly(self):
        claude_path = claude_config_path(self.home)
        os.makedirs(os.path.dirname(claude_path), exist_ok=True)
        with open(claude_path, "w", encoding="utf-8") as fh:
            json.dump({"mcpServers": {"novai-canvas": {"command": "x"}}}, fh)
        codex_path = codex_config_path(self.home)
        os.makedirs(os.path.dirname(codex_path), exist_ok=True)
        with open(codex_path, "w", encoding="utf-8") as fh:
            fh.write("[mcp_servers.novai-canvas]\ncommand = \"x\"\n")
        claude_mtime = os.path.getmtime(claude_path)
        codex_mtime = os.path.getmtime(codex_path)
        with patch.object(mcp_routes, "_desktop_agent_path",
                          side_effect=lambda app: "/Applications/%s.app" % app), \
                patch.object(mcp_routes, "_cli_agent_command", return_value="/x/codex"), \
                patch.object(mcp_routes.subprocess, "run") as run:
            agents = self._agents()
        run.assert_not_called()
        self.assertTrue(agents["claude"]["configured"])
        self.assertTrue(agents["codex"]["configured"])
        self.assertFalse(agents["chatgpt"]["configured"])
        self.assertFalse(agents["workbuddy"]["configured"])
        self.assertFalse(agents["claude-cli"]["configured"])
        self.assertIn("reason", agents["chatgpt"])
        # 没配 NOVAI_BASE_URL 时为空串
        for agent_id in ("claude", "codex", "chatgpt", "workbuddy", "claude-cli"):
            self.assertEqual(agents[agent_id]["configured_base_url"], "")
        self.assertEqual(os.path.getmtime(claude_path), claude_mtime)
        self.assertEqual(os.path.getmtime(codex_path), codex_mtime)

    def test_configured_base_url_values(self):
        claude_path = claude_config_path(self.home)
        os.makedirs(os.path.dirname(claude_path), exist_ok=True)
        with open(claude_path, "w", encoding="utf-8") as fh:
            json.dump({"mcpServers": {"novai-canvas": {
                "command": "x", "args": [],
                "env": {"NOVAI_BASE_URL": "http://127.0.0.1:4321"}}}}, fh)
        codex_path = codex_config_path(self.home)
        os.makedirs(os.path.dirname(codex_path), exist_ok=True)
        with open(codex_path, "w", encoding="utf-8") as fh:
            fh.write('[mcp_servers.novai-canvas]\ncommand = "x"\n'
                     'env = { NOVAI_BASE_URL = "http://127.0.0.1:4322" }\n')
        with patch.object(mcp_routes, "_desktop_agent_path", return_value=""), \
                patch.object(mcp_routes, "_cli_agent_command", return_value=""):
            agents = self._agents()
        self.assertTrue(agents["claude"]["configured"])
        self.assertEqual(agents["claude"]["configured_base_url"], "http://127.0.0.1:4321")
        self.assertTrue(agents["codex"]["configured"])
        self.assertEqual(agents["codex"]["configured_base_url"], "http://127.0.0.1:4322")
        for agent_id in ("chatgpt", "workbuddy", "claude-cli"):
            self.assertEqual(agents[agent_id]["configured_base_url"], "")

    def test_configured_base_url_absent_env_is_empty(self):
        claude_path = claude_config_path(self.home)
        os.makedirs(os.path.dirname(claude_path), exist_ok=True)
        with open(claude_path, "w", encoding="utf-8") as fh:
            json.dump({"mcpServers": {"novai-canvas": {"command": "x", "args": []}}}, fh)
        codex_path = codex_config_path(self.home)
        os.makedirs(os.path.dirname(codex_path), exist_ok=True)
        with open(codex_path, "w", encoding="utf-8") as fh:
            fh.write('[mcp_servers.novai-canvas]\ncommand = "x"\n')
        with patch.object(mcp_routes, "_desktop_agent_path", return_value=""), \
                patch.object(mcp_routes, "_cli_agent_command", return_value=""):
            agents = self._agents()
        self.assertEqual(agents["claude"]["configured_base_url"], "")
        self.assertEqual(agents["codex"]["configured_base_url"], "")

    def test_unreadable_configs_report_reason(self):
        claude_path = claude_config_path(self.home)
        os.makedirs(os.path.dirname(claude_path), exist_ok=True)
        with open(claude_path, "w", encoding="utf-8") as fh:
            fh.write("{broken")
        codex_path = codex_config_path(self.home)
        os.makedirs(os.path.dirname(codex_path), exist_ok=True)
        with open(codex_path, "w", encoding="utf-8") as fh:
            fh.write("[mcp_servers.other]\n")
        real_read = mcp_routes._read_text

        def flaky_read(path):
            if path == codex_path:
                raise OSError("permission denied")
            return real_read(path)

        with patch.object(mcp_routes, "_desktop_agent_path", return_value=""), \
                patch.object(mcp_routes, "_cli_agent_command", return_value=""), \
                patch.object(mcp_routes, "_read_text", side_effect=flaky_read):
            agents = self._agents()
        self.assertFalse(agents["claude"]["configured"])
        self.assertIn("reason", agents["claude"])
        self.assertFalse(agents["codex"]["configured"])
        self.assertIn("reason", agents["codex"])


if __name__ == "__main__":
    unittest.main()
