# -*- coding: utf-8 -*-
"""画布「MCP 接入」入口卡数据：GET /api/mcp/connect-info。

全部字段从运行态推导：端口读 NOVAI_PORT（main 启动时写回实际端口）、server_entry 指向
main.py --mcp（源码）或主程序 --mcp（打包后）、server_py 只是兼容字段（找不到给空串）、
http_url 从 data 目录的 MCP 客户端配置里取 type=http 的 url。
"""
import json
import os
import shlex
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-mcp-connect-info-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402
from server.routes import mcp as mcp_routes  # noqa: E402

CLIENT = TestClient(main.app)
FIELDS = {"enabled", "server_entry", "mcp_servers_json", "codex_command", "http_url",
          "docs_path", "server_py", "base_url"}


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def get_info():
    resp = CLIENT.get("/api/mcp/connect-info")
    assert resp.status_code == 200, resp.text
    return resp.json()


class ConnectInfoTests(unittest.TestCase):

    def test_fields_present_and_types(self):
        body = get_info()
        self.assertEqual(set(body.keys()), FIELDS)
        self.assertIsInstance(body["enabled"], bool)
        self.assertIsInstance(body["server_entry"], dict)
        self.assertEqual(set(body["server_entry"].keys()), {"command", "args", "env"})
        self.assertIsInstance(body["server_entry"]["args"], list)
        self.assertIsInstance(body["server_entry"]["env"], dict)
        self.assertIsInstance(body["codex_command"], str)
        self.assertIsInstance(body["http_url"], str)
        self.assertEqual(body["docs_path"], "docs/v2/MCP_SERVER.md")
        self.assertIsInstance(body["server_py"], str)
        self.assertTrue(body["base_url"].startswith("http://127.0.0.1:"))

    def test_port_comes_from_runtime_env(self):
        for port in (3971, 4123):
            with patch.dict(os.environ, {"NOVAI_PORT": str(port)}):
                body = get_info()
            self.assertEqual(body["base_url"], "http://127.0.0.1:%d" % port)
            self.assertEqual(body["server_entry"]["env"]["NOVAI_BASE_URL"], body["base_url"])
            self.assertIn(body["base_url"], body["codex_command"])
        with patch.dict(os.environ, {}, clear=False) as env:
            env.pop("NOVAI_PORT", None)
            body = get_info()
        self.assertEqual(body["base_url"], "http://127.0.0.1:3000")

    def _expected_codex_command(self, base_url, command, args):
        parts = ["codex", "mcp", "add", "novai-canvas",
                 "--env", "NOVAI_BASE_URL=%s" % base_url, "--", command] + list(args)
        return " ".join(shlex.quote(part) for part in parts)

    def test_source_entry_runs_repo_main_with_mcp(self):
        body = get_info()
        main_py = str(ROOT / "main.py")
        self.assertTrue(os.path.isfile(main_py))
        self.assertEqual(body["server_entry"]["command"], sys.executable)
        self.assertEqual(body["server_entry"]["args"], [main_py, "--mcp"])
        self.assertEqual(body["server_py"], str(ROOT / "novai_mcp_server.py"))
        self.assertEqual(
            body["codex_command"],
            self._expected_codex_command(body["base_url"], sys.executable, [main_py, "--mcp"]))

    def test_frozen_entry_uses_app_binary_with_mcp(self):
        with patch.object(mcp_routes.sys, "frozen", True, create=True):
            body = get_info()
        self.assertEqual(body["server_entry"]["command"], sys.executable)
        self.assertEqual(body["server_entry"]["args"], ["--mcp"])
        self.assertEqual(body["server_entry"]["env"]["NOVAI_BASE_URL"], body["base_url"])
        self.assertEqual(
            body["codex_command"],
            self._expected_codex_command(body["base_url"], sys.executable, ["--mcp"]))

    def test_server_py_empty_when_missing(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(mcp_routes, "_REPO_ROOT", tmp):
            body = get_info()
        self.assertEqual(body["server_py"], "")
        self.assertEqual(body["server_entry"]["args"], [])

    def test_mcp_servers_json_round_trip(self):
        body = get_info()
        dumped = json.dumps(body["mcp_servers_json"], ensure_ascii=False)
        loaded = json.loads(dumped)
        self.assertEqual(loaded, body["mcp_servers_json"])
        self.assertEqual(loaded["mcpServers"]["novai-canvas"], body["server_entry"])

    def test_http_url_empty_without_http_config(self):
        tmp = tempfile.mkdtemp(prefix="novai-connect-cfg-")
        try:
            cfg_path = os.path.join(tmp, "mcp_servers.json")
            with open(cfg_path, "w", encoding="utf-8") as fh:
                json.dump({"mcpServers": {"local": {"command": "python3", "args": []}}}, fh)
            with patch.dict(os.environ, {"NOVAI_MCP_CONFIG": cfg_path}):
                body = get_info()
            self.assertEqual(body["http_url"], "")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_http_url_from_config(self):
        tmp = tempfile.mkdtemp(prefix="novai-connect-cfg-")
        try:
            cfg_path = os.path.join(tmp, "mcp_servers.json")
            with open(cfg_path, "w", encoding="utf-8") as fh:
                json.dump({"mcpServers": {"remote": {"type": "http",
                                                     "url": "http://127.0.0.1:8765/mcp",
                                                     "enabled": True}}}, fh)
            with patch.dict(os.environ, {"NOVAI_MCP_CONFIG": cfg_path}):
                body = get_info()
            self.assertEqual(body["http_url"], "http://127.0.0.1:8765/mcp")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_enabled_flag_follows_switch(self):
        with patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "1"}):
            self.assertTrue(get_info()["enabled"])
        with patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "0"}):
            self.assertFalse(get_info()["enabled"])


if __name__ == "__main__":
    unittest.main()
