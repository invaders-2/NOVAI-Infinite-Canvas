# -*- coding: utf-8 -*-
"""一键写入 Agent 配置：configured 检测 + POST /api/mcp/install-agent。

全部用临时 HOME 隔离，绝不碰真实 ~/Library / ~/.codex / ~/.workbuddy / ~/.kimi-code；
CLI 类用 mock subprocess（只断言 argv 与调用参数，不真跑外部工具）。
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


def workbuddy_config_path(home):
    return os.path.join(home, ".workbuddy", "mcp.json")


def kimi_config_path(home):
    return os.path.join(home, ".kimi-code", "mcp.json")


def fake_which(mapping):
    return lambda command: mapping.get(command)


def all_apps(app):
    return "/Applications/%s.app" % app


class _HomeMixin(unittest.TestCase):

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="novai-home-")
        self.env = patch.dict(os.environ, {"HOME": self.home})
        self.env.start()
        mcp_routes._reset_cli_detect_cache()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.home, ignore_errors=True)
        mcp_routes._reset_cli_detect_cache()

    def install(self, payload):
        return CLIENT.post("/api/mcp/install-agent", json=payload)

    def info(self):
        resp = CLIENT.get("/api/mcp/connect-info")
        assert resp.status_code == 200, resp.text
        return resp.json()

    def agents(self):
        resp = CLIENT.get("/api/mcp/installed-agents")
        assert resp.status_code == 200, resp.text
        return {item["id"]: item for item in resp.json()["agents"]}

    @staticmethod
    def write_json(path, payload):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)

    @staticmethod
    def read_json(path):
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)


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
        payload = self.read_json(path)
        self.assertEqual(payload["mcpServers"]["novai-canvas"], self.info()["server_entry"])

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
        payload = self.read_json(path)
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
        self.write_json(path, {"mcpServers": {"novai-canvas": self.info()["server_entry"]}})
        with open(path, "rb") as fh:
            before = fh.read()
        mtime = os.path.getmtime(path)
        with patch.object(mcp_routes, "_desktop_agent_path", return_value="/Applications/Claude.app"):
            resp = self.install({"id": "claude", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertTrue(resp.json()["already"])
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), before)
        self.assertEqual(os.path.getmtime(path), mtime)

    def test_confirm_required(self):
        with patch.object(mcp_routes, "_desktop_agent_path", return_value="/Applications/Claude.app"):
            resp = self.install({"id": "claude"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("需要 confirm: true", resp.json()["detail"])
        self.assertFalse(os.path.isfile(claude_config_path(self.home)))

    def test_unknown_id_is_400(self):
        for agent_id in ("bash", "Claude", "../claude", "", "codex2"):
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


class InstallJsonAgentTests(_HomeMixin):
    """WorkBuddy / Kimi Code：mcpServers JSON 的通用写入与保护。"""

    def test_workbuddy_creates_config(self):
        with patch.object(mcp_routes, "_desktop_agent_path", side_effect=all_apps):
            resp = self.install({"id": "workbuddy", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        path = workbuddy_config_path(self.home)
        self.assertEqual(body["path"], path)
        self.assertEqual(body["backup"], "")
        self.assertFalse(body["already"])
        payload = self.read_json(path)
        self.assertEqual(payload["mcpServers"]["novai-canvas"], self.info()["server_entry"])

    def test_kimi_preserves_other_keys_and_makes_backup(self):
        path = kimi_config_path(self.home)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        original = json.dumps({"mcpServers": {"other": {"command": "x"}},
                               "theme": "dark"}, ensure_ascii=False).encode("utf-8")
        with open(path, "wb") as fh:
            fh.write(original)
        with patch.object(mcp_routes, "_desktop_agent_path", side_effect=all_apps):
            resp = self.install({"id": "kimi", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["backup"].startswith(path + ".bak."))
        with open(body["backup"], "rb") as fh:
            self.assertEqual(fh.read(), original)
        payload = self.read_json(path)
        self.assertEqual(payload["theme"], "dark")
        self.assertEqual(payload["mcpServers"]["other"], {"command": "x"})
        self.assertIn("novai-canvas", payload["mcpServers"])

    def test_kimi_installed_via_cli_only(self):
        with patch.object(mcp_routes.os.path, "isdir", return_value=False), \
                patch.object(mcp_routes.shutil, "which",
                             side_effect=fake_which({"kimi": "/x/kimi-code/bin/kimi"})):
            resp = self.install({"id": "kimi", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertTrue(os.path.isfile(kimi_config_path(self.home)))

    def test_bad_json_keeps_original_bytes(self):
        for agent_id, path in (("workbuddy", workbuddy_config_path(self.home)),
                               ("kimi", kimi_config_path(self.home))):
            with self.subTest(agent=agent_id):
                if os.path.isfile(path):
                    os.remove(path)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                broken = b"{not valid json"
                with open(path, "wb") as fh:
                    fh.write(broken)
                with patch.object(mcp_routes, "_desktop_agent_path", side_effect=all_apps):
                    resp = self.install({"id": agent_id, "confirm": True})
                self.assertEqual(resp.status_code, 400)
                self.assertIn("不是合法 JSON", resp.json()["detail"])
                with open(path, "rb") as fh:
                    self.assertEqual(fh.read(), broken)

    def test_mcp_servers_not_object_is_400(self):
        path = workbuddy_config_path(self.home)
        self.write_json(path, {"mcpServers": []})
        with open(path, "rb") as fh:
            before = fh.read()
        with patch.object(mcp_routes, "_desktop_agent_path", side_effect=all_apps):
            resp = self.install({"id": "workbuddy", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("mcpServers 必须是对象", resp.json()["detail"])
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), before)

    def test_already_configured_is_idempotent(self):
        path = kimi_config_path(self.home)
        self.write_json(path, {"mcpServers": {"novai-canvas": self.info()["server_entry"]}})
        with open(path, "rb") as fh:
            before = fh.read()
        with patch.object(mcp_routes, "_desktop_agent_path", side_effect=all_apps):
            resp = self.install({"id": "kimi", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertTrue(resp.json()["already"])
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), before)

    def test_not_installed_is_400(self):
        with patch.object(mcp_routes, "_desktop_agent_path", return_value=""), \
                patch.object(mcp_routes.shutil, "which", return_value=""):
            resp = self.install({"id": "workbuddy", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("未检测到本机安装", resp.json()["detail"])
        self.assertFalse(os.path.isfile(workbuddy_config_path(self.home)))


class UpdateExistingConfigTests(_HomeMixin):
    """已存在 novai-canvas 时必须真的更新旧地址 / disabled，而不是无脑 already。"""

    def _install_kimi(self):
        with patch.object(mcp_routes, "_desktop_agent_path", side_effect=all_apps):
            return self.install({"id": "kimi", "confirm": True})

    def test_stale_base_url_is_updated(self):
        path = kimi_config_path(self.home)
        self.write_json(path, {"mcpServers": {"novai-canvas": {
            "command": "old-python",
            "args": ["old.py"],
            "env": {"NOVAI_BASE_URL": "http://127.0.0.1:3971"},
        }}, "theme": "dark"})
        resp = self._install_kimi()
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertFalse(body["already"])
        self.assertTrue(body["backup"].startswith(path + ".bak."))
        entry = self.info()["server_entry"]
        payload = self.read_json(path)
        self.assertEqual(payload["mcpServers"]["novai-canvas"], entry)
        self.assertEqual(payload["mcpServers"]["novai-canvas"]["env"]["NOVAI_BASE_URL"],
                         entry["env"]["NOVAI_BASE_URL"])
        self.assertNotEqual(payload["mcpServers"]["novai-canvas"]["env"]["NOVAI_BASE_URL"],
                            "http://127.0.0.1:3971")
        self.assertEqual(payload["theme"], "dark")

    def test_disabled_entry_is_rewritten_and_disabled_removed(self):
        path = kimi_config_path(self.home)
        entry = self.info()["server_entry"]
        disabled = dict(entry)
        disabled["disabled"] = True
        self.write_json(path, {"mcpServers": {"novai-canvas": disabled}, "theme": "dark"})
        resp = self._install_kimi()
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertFalse(resp.json()["already"])
        payload = self.read_json(path)
        existing = payload["mcpServers"]["novai-canvas"]
        self.assertNotIn("disabled", existing)
        self.assertEqual(existing, entry)
        self.assertEqual(payload["theme"], "dark")

    def test_identical_entry_returns_already_and_leaves_file_untouched(self):
        path = kimi_config_path(self.home)
        self.write_json(path, {"mcpServers": {"novai-canvas": self.info()["server_entry"]}})
        with open(path, "rb") as fh:
            before = fh.read()
        mtime = os.path.getmtime(path)
        resp = self._install_kimi()
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertTrue(resp.json()["already"])
        with open(path, "rb") as fh:
            self.assertEqual(fh.read(), before)
        self.assertEqual(os.path.getmtime(path), mtime)


class InstallCodexTests(_HomeMixin):

    def test_runs_codex_mcp_add_with_argv(self):
        fake = SimpleNamespace(returncode=0, stdout="added novai-canvas", stderr="")
        info = self.info()
        with patch.object(mcp_routes.shutil, "which",
                          side_effect=fake_which({"codex": "/usr/local/bin/codex"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=fake) as run:
            resp = self.install({"id": "codex", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["action"], "command")
        self.assertIn("added novai-canvas", body["output"])
        self.assertTrue(body["needs_restart"])
        run.assert_called_once()
        argv = run.call_args[0][0]
        self.assertEqual(argv, ["/usr/local/bin/codex", "mcp", "add", "novai-canvas",
                                "--env", "NOVAI_BASE_URL=%s" % info["base_url"], "--",
                                info["server_entry"]["command"]] + info["server_entry"]["args"])
        self.assertNotEqual(run.call_args[1].get("shell"), True)
        self.assertEqual(run.call_args[1].get("timeout"), 20)

    def test_codex_failure_is_500_with_output(self):
        fake = SimpleNamespace(returncode=1, stdout="", stderr="boom: invalid config")
        with patch.object(mcp_routes.shutil, "which",
                          side_effect=fake_which({"codex": "/usr/local/bin/codex"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=fake):
            resp = self.install({"id": "codex", "confirm": True})
        self.assertEqual(resp.status_code, 500)
        self.assertIn("boom", resp.json()["detail"])

    def test_codex_not_installed_is_400(self):
        with patch.object(mcp_routes.shutil, "which", return_value=""), \
                patch.object(mcp_routes.subprocess, "run") as run:
            resp = self.install({"id": "codex", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("未检测到本机安装", resp.json()["detail"])
        run.assert_not_called()

    def test_missing_main_py_refuses_without_running_cli(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(mcp_routes, "_REPO_ROOT", tmp), \
                patch.object(mcp_routes.shutil, "which",
                             side_effect=fake_which({"codex": "/x/codex"})), \
                patch.object(mcp_routes.subprocess, "run") as run:
            resp = self.install({"id": "codex", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("main.py", resp.json()["detail"])
        run.assert_not_called()


class InstallClaudeCliTests(_HomeMixin):

    def test_runs_claude_mcp_add_with_argv(self):
        fake = SimpleNamespace(returncode=0, stdout="Added MCP server novai-canvas", stderr="")
        info = self.info()
        with patch.object(mcp_routes.shutil, "which",
                          side_effect=fake_which({"claude": "/x/claude"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=fake) as run:
            resp = self.install({"id": "claude-cli", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn("novai-canvas", resp.json()["output"])
        argv = run.call_args[0][0]
        self.assertEqual(argv, ["/x/claude", "mcp", "add", "-s", "user", "novai-canvas",
                                "-e", "NOVAI_BASE_URL=%s" % info["base_url"], "--",
                                info["server_entry"]["command"]] + info["server_entry"]["args"])
        self.assertNotEqual(run.call_args[1].get("shell"), True)
        self.assertEqual(run.call_args[1].get("timeout"), 20)

    def test_not_installed_is_400(self):
        with patch.object(mcp_routes.shutil, "which", return_value=""), \
                patch.object(mcp_routes.subprocess, "run") as run:
            resp = self.install({"id": "claude-cli", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("未检测到本机安装", resp.json()["detail"])
        run.assert_not_called()


class InstallHermesTests(_HomeMixin):

    def test_runs_hermes_mcp_add_with_argv(self):
        fake = SimpleNamespace(returncode=0, stdout="Added MCP server novai-canvas", stderr="")
        info = self.info()
        with patch.object(mcp_routes.shutil, "which",
                          side_effect=fake_which({"hermes": "/x/hermes"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=fake) as run:
            resp = self.install({"id": "hermes", "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        argv = run.call_args[0][0]
        self.assertEqual(argv, ["/x/hermes", "mcp", "add", "novai-canvas",
                                "--command", info["server_entry"]["command"],
                                "--env", "NOVAI_BASE_URL=%s" % info["base_url"],
                                "--args"] + info["server_entry"]["args"])
        self.assertNotEqual(run.call_args[1].get("shell"), True)
        # hermes mcp add 会问「Enable all N tools?」，自动化要喂 Y，否则会取消不落盘
        self.assertEqual(run.call_args[1].get("input"), "y\n")

    def test_failure_is_500(self):
        fake = SimpleNamespace(returncode=1, stdout="", stderr="boom: bad config")
        with patch.object(mcp_routes.shutil, "which",
                          side_effect=fake_which({"hermes": "/x/hermes"})), \
                patch.object(mcp_routes.subprocess, "run", return_value=fake):
            resp = self.install({"id": "hermes", "confirm": True})
        self.assertEqual(resp.status_code, 500)
        self.assertIn("boom", resp.json()["detail"])


class ManualOnlyTests(_HomeMixin):

    def test_dsh_requires_profile_patch(self):
        resp = self.install({"id": "dsh", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        detail = resp.json()["detail"]
        self.assertIn("不支持自动写入", detail)
        self.assertIn("profile", detail)

    def test_chatgpt_is_not_installable(self):
        resp = self.install({"id": "chatgpt", "confirm": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("不支持自动写入", resp.json()["detail"])


class ConfiguredDetectionTests(_HomeMixin):

    def test_json_agents_and_codex_configured_flags(self):
        claude_path = claude_config_path(self.home)
        self.write_json(claude_path, {"mcpServers": {"novai-canvas": {
            "command": "x", "args": [],
            "env": {"NOVAI_BASE_URL": "http://127.0.0.1:4321"}}}})
        workbuddy_path = workbuddy_config_path(self.home)
        self.write_json(workbuddy_path, {"mcpServers": {"novai-canvas": {
            "command": "x", "args": [], "env": {"NOVAI_BASE_URL": "http://127.0.0.1:4323"}}}})
        kimi_path = kimi_config_path(self.home)
        self.write_json(kimi_path, {"mcpServers": {"novai-canvas": {"command": "x"}}})
        codex_path = codex_config_path(self.home)
        os.makedirs(os.path.dirname(codex_path), exist_ok=True)
        with open(codex_path, "w", encoding="utf-8") as fh:
            fh.write('[mcp_servers.novai-canvas]\ncommand = "x"\n'
                     'env = { NOVAI_BASE_URL = "http://127.0.0.1:4322" }\n')
        mtimes = {path: os.path.getmtime(path) for path in
                  (claude_path, workbuddy_path, kimi_path, codex_path)}
        with patch.object(mcp_routes.os.path, "isdir", return_value=False), \
                patch.object(mcp_routes.shutil, "which", return_value=""), \
                patch.object(mcp_routes.subprocess, "run") as run:
            agents = self.agents()
        run.assert_not_called()                       # CLI 没装就不起进程
        self.assertTrue(agents["claude"]["configured"])
        self.assertEqual(agents["claude"]["configured_base_url"], "http://127.0.0.1:4321")
        self.assertTrue(agents["workbuddy"]["configured"])
        self.assertEqual(agents["workbuddy"]["configured_base_url"], "http://127.0.0.1:4323")
        self.assertTrue(agents["kimi"]["configured"])
        self.assertEqual(agents["kimi"]["configured_base_url"], "")
        self.assertTrue(agents["codex"]["configured"])
        self.assertEqual(agents["codex"]["configured_base_url"], "http://127.0.0.1:4322")
        self.assertFalse(agents["chatgpt"]["configured"])
        self.assertFalse(agents["claude-cli"]["configured"])
        self.assertFalse(agents["hermes"]["configured"])
        self.assertFalse(agents["dsh"]["configured"])
        self.assertIn("reason", agents["chatgpt"])
        self.assertIn("reason", agents["dsh"])
        for path, mtime in mtimes.items():
            self.assertEqual(os.path.getmtime(path), mtime)

    def test_cli_agents_configured_via_probe_command(self):
        def fake_run(argv, **kwargs):
            if "get" in argv:
                return SimpleNamespace(returncode=0, stderr="",
                                       stdout="novai-canvas:\n  NOVAI_BASE_URL=http://127.0.0.1:4324\n")
            return SimpleNamespace(returncode=0, stderr="", stdout="MCP Servers:\n  novai-canvas\n")

        with patch.object(mcp_routes.os.path, "isdir", return_value=False), \
                patch.object(mcp_routes.shutil, "which",
                             side_effect=fake_which({"claude": "/x/claude",
                                                     "hermes": "/x/hermes"})), \
                patch.object(mcp_routes.subprocess, "run", side_effect=fake_run) as run:
            agents = self.agents()
        self.assertTrue(agents["claude-cli"]["configured"])
        self.assertEqual(agents["claude-cli"]["configured_base_url"], "http://127.0.0.1:4324")
        self.assertTrue(agents["hermes"]["configured"])
        self.assertEqual(run.call_count, 2)

    def test_cli_probe_failure_means_unconfigured(self):
        with patch.object(mcp_routes.os.path, "isdir", return_value=False), \
                patch.object(mcp_routes.shutil, "which",
                             side_effect=fake_which({"claude": "/x/claude",
                                                     "hermes": "/x/hermes"})), \
                patch.object(mcp_routes.subprocess, "run",
                             side_effect=TimeoutError("slow")):
            agents = self.agents()
        self.assertFalse(agents["claude-cli"]["configured"])
        self.assertFalse(agents["hermes"]["configured"])

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

        with patch.object(mcp_routes.os.path, "isdir", return_value=False), \
                patch.object(mcp_routes.shutil, "which", return_value=""), \
                patch.object(mcp_routes, "_read_text", side_effect=flaky_read):
            agents = self.agents()
        self.assertFalse(agents["claude"]["configured"])
        self.assertIn("reason", agents["claude"])
        self.assertFalse(agents["codex"]["configured"])
        self.assertIn("reason", agents["codex"])


if __name__ == "__main__":
    unittest.main()
