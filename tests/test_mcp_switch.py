# -*- coding: utf-8 -*-
"""MCP 总开关（settings 落盘 + 环境变量覆盖）与服务增删改接口。

覆盖：默认关闭 / settings 开启后生效 / 环境变量强制覆盖、switch 的 confirm 与 env 409、
服务 POST/PUT/DELETE 的校验、404、409，以及「增删改只写盘、不触发工具发现」。

数据目录强制指向本次测试自己的临时目录，不碰真实 ~/.NOVAI。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 命令行已经设了 NOVAI_DATA_DIR 也不复用：本文件要独立、可重复跑
_PREV_DATA_DIR = os.environ.get("NOVAI_DATA_DIR")
_TMP = tempfile.mkdtemp(prefix="novai-mcp-switch-")
os.environ["NOVAI_DATA_DIR"] = _TMP

with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from server.mcp import config, registry  # noqa: E402
from server.routes import mcp as mcp_routes  # noqa: E402

CLIENT = TestClient(main.app)


def tearDownModule():
    registry.reset_cache()
    if _PREV_DATA_DIR is None:
        os.environ.pop("NOVAI_DATA_DIR", None)
    else:
        os.environ["NOVAI_DATA_DIR"] = _PREV_DATA_DIR
    shutil.rmtree(_TMP, ignore_errors=True)


class SwitchTestBase(unittest.TestCase):
    """每个用例一个干净的数据目录：清掉 mcp_servers.json / mcp_settings.json 与相关环境变量。"""

    def setUp(self):
        self._saved_env = {key: os.environ.get(key) for key in ("NOVAI_MCP_ENABLED", "NOVAI_MCP_CONFIG")}
        for key in self._saved_env:
            os.environ.pop(key, None)
        self._clean_files()
        registry.reset_cache()

    def tearDown(self):
        for key, value in self._saved_env.items():
            os.environ.pop(key, None)
            if value is not None:
                os.environ[key] = value
        self._clean_files()
        registry.reset_cache()

    @staticmethod
    def _clean_files():
        for path in (config.config_path(), config.settings_path()):
            try:
                os.remove(path)
            except OSError:
                pass

    def write_payload(self, payload):
        path = config.config_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)

    def write_servers(self, servers):
        self.write_payload({config.TOP_KEY: servers})

    def read_payload(self):
        with open(config.config_path(), "r", encoding="utf-8") as fh:
            return json.load(fh)

    def read_servers(self):
        return self.read_payload()[config.TOP_KEY]

    def write_settings(self, payload):
        path = config.settings_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)

    def read_settings_file(self):
        with open(config.settings_path(), "r", encoding="utf-8") as fh:
            return json.load(fh)

    def switch(self, body):
        return CLIENT.put("/api/mcp/servers/switch", json=body)


class SwitchSettingsTests(SwitchTestBase):
    """config.enabled() 的取值来源：settings 文件 ↔ 环境变量。"""

    def test_default_is_off_with_empty_override(self):
        self.assertEqual(config.env_override(), "")
        self.assertFalse(config.enabled())
        self.assertFalse(registry.enabled())
        self.assertFalse(os.path.isfile(config.settings_path()))

    def test_reads_enabled_from_settings_file(self):
        self.write_settings({"enabled": True, "note": "别的键要留着"})
        self.assertEqual(config.env_override(), "")
        self.assertTrue(config.enabled())
        self.assertTrue(registry.enabled())

    def test_set_enabled_writes_settings_and_keeps_other_keys(self):
        self.write_settings({"enabled": False, "theme": "dark"})
        saved = config.set_enabled(True)
        self.assertTrue(saved["enabled"])
        on_disk = self.read_settings_file()
        self.assertIs(on_disk["enabled"], True)
        self.assertEqual(on_disk["theme"], "dark")
        self.assertTrue(config.enabled())
        self.assertEqual(config.settings_path(), os.path.join(config.data_dir(), "mcp_settings.json"))

        config.set_enabled(False)
        self.assertFalse(config.enabled())
        self.assertIs(self.read_settings_file()["enabled"], False)
        self.assertEqual(self.read_settings_file()["theme"], "dark")

    def test_read_settings_tolerates_missing_and_broken(self):
        self.assertEqual(config.read_settings(), {})
        os.makedirs(os.path.dirname(config.settings_path()), exist_ok=True)
        with open(config.settings_path(), "w", encoding="utf-8") as fh:
            fh.write("{not json")
        self.assertEqual(config.read_settings(), {})
        self.assertFalse(config.enabled())          # 坏文件当关闭，不抛异常
        with open(config.settings_path(), "w", encoding="utf-8") as fh:
            fh.write("[]")
        self.assertEqual(config.read_settings(), {})

    def test_env_override_values(self):
        cases = [("1", "on"), ("true", "on"), ("TRUE", "on"), ("yes", "on"), ("on", "on"),
                 ("0", "off"), ("false", "off"), ("No", "off"), ("off", "off"),
                 ("", ""), ("maybe", "")]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                if raw:
                    os.environ["NOVAI_MCP_ENABLED"] = raw
                else:
                    os.environ.pop("NOVAI_MCP_ENABLED", None)
                self.assertEqual(config.env_override(), expected)

    def test_env_override_beats_settings_off(self):
        self.write_settings({"enabled": True})
        os.environ["NOVAI_MCP_ENABLED"] = "off"
        self.assertFalse(config.enabled())
        self.assertFalse(registry.enabled())
        self.assertEqual(config.env_override(), "off")

    def test_env_override_beats_settings_on(self):
        self.write_settings({"enabled": False})
        os.environ["NOVAI_MCP_ENABLED"] = "1"
        self.assertTrue(config.enabled())
        self.assertTrue(registry.enabled())

    def test_env_enabled_kept_for_compat(self):
        os.environ.pop("NOVAI_MCP_ENABLED", None)
        self.assertFalse(config.env_enabled())
        os.environ["NOVAI_MCP_ENABLED"] = "1"
        self.assertTrue(config.env_enabled())
        os.environ["NOVAI_MCP_ENABLED"] = "0"
        self.assertFalse(config.env_enabled())


class SwitchApiTests(SwitchTestBase):
    """PUT /api/mcp/servers/switch 与 GET /api/mcp/servers 的开关字段。"""

    def test_list_exposes_switch_fields(self):
        resp = CLIENT.get("/api/mcp/servers")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertEqual(body["enabled"], False)
        self.assertEqual(body["env_override"], "")
        self.assertEqual(body["config_path"], config.config_path())
        self.assertEqual(body["servers"], [])
        self.assertEqual(set(body.keys()), {"enabled", "env_override", "config_path", "servers"})

    def test_enable_requires_confirm(self):
        resp = self.switch({"enabled": True})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("confirm", resp.json()["detail"])
        self.assertFalse(os.path.isfile(config.settings_path()))
        self.assertFalse(config.enabled())

    def test_enable_persists_and_reports_state(self):
        resp = self.switch({"enabled": True, "confirm": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["enabled"])
        self.assertEqual(body["env_override"], "")
        self.assertIsInstance(body["servers"], list)
        self.assertIs(self.read_settings_file()["enabled"], True)
        self.assertTrue(config.enabled())
        self.assertTrue(CLIENT.get("/api/mcp/servers").json()["enabled"])

    def test_disable_needs_no_confirm(self):
        self.assertTrue(self.switch({"enabled": True, "confirm": True}).json()["enabled"])
        resp = self.switch({"enabled": False})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertFalse(resp.json()["enabled"])
        self.assertIs(self.read_settings_file()["enabled"], False)
        self.assertFalse(config.enabled())

    def test_env_override_returns_409(self):
        for value in ("1", "on", "true"):
            with self.subTest(env=value):
                os.environ["NOVAI_MCP_ENABLED"] = value
                resp = self.switch({"enabled": True, "confirm": True})
                self.assertEqual(resp.status_code, 409)
                self.assertIn("NOVAI_MCP_ENABLED", resp.json()["detail"])
                self.assertIn("忽略", resp.json()["detail"])
                self.assertFalse(os.path.isfile(config.settings_path()))

    def test_env_override_blocks_disable_too_and_keeps_file(self):
        self.write_settings({"enabled": True, "keep": 1})
        os.environ["NOVAI_MCP_ENABLED"] = "0"
        resp = self.switch({"enabled": False})
        self.assertEqual(resp.status_code, 409)
        self.assertIn("NOVAI_MCP_ENABLED", resp.json()["detail"])
        self.assertEqual(self.read_settings_file(), {"enabled": True, "keep": 1})

    def test_switch_reflects_servers_after_reset(self):
        self.write_servers({"demo": {"command": "python3", "args": [], "enabled": False}})
        body = self.switch({"enabled": True, "confirm": True}).json()
        names = [row["name"] for row in body["servers"]]
        self.assertEqual(names, ["demo"])
        self.assertEqual(body["servers"][0]["status"], "未启用")


class ServerCrudApiTests(SwitchTestBase):
    """POST / PUT / DELETE /api/mcp/servers：只写盘，不触发工具发现。"""

    def test_create_then_list(self):
        resp = CLIENT.post("/api/mcp/servers", json={
            "name": "demo", "command": "python3", "args": ["-c", "print(1)"], "enabled": False})
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["server"]["name"], "demo")
        self.assertEqual(body["server"]["type"], "stdio")
        on_disk = self.read_servers()["demo"]
        self.assertEqual(on_disk["command"], "python3")
        self.assertEqual(on_disk["args"], ["-c", "print(1)"])
        self.assertNotIn("name", on_disk)
        rows = CLIENT.get("/api/mcp/servers").json()["servers"]
        self.assertEqual([row["name"] for row in rows], ["demo"])
        self.assertEqual(rows[0]["status"], "未启用")

    def test_create_rejects_invalid_config(self):
        cases = [
            ({"name": "Bad Name", "command": "x"}, "名称只能"),
            ({"name": "ok"}, "command 必填"),
            ({"name": "ok", "command": "x", "timeout": "slow"}, "timeout"),
            ({"name": "ok", "command": "x", "args": "not-list"}, "args"),
            ({"name": "ok", "type": "http", "url": "ftp://x"}, "url"),
            ({"name": "ok", "type": "ftp", "command": "x"}, "type"),
        ]
        for payload, expected in cases:
            with self.subTest(payload=payload):
                resp = CLIENT.post("/api/mcp/servers", json=payload)
                self.assertEqual(resp.status_code, 400, resp.text)
                self.assertIn(expected, resp.json()["detail"])
        self.assertFalse(os.path.isfile(config.config_path()))

    def test_create_duplicate_409(self):
        self.write_servers({"demo": {"command": "python3", "enabled": False}})
        resp = CLIENT.post("/api/mcp/servers", json={"name": "demo", "command": "python3"})
        self.assertEqual(resp.status_code, 409)
        self.assertIn("已存在", resp.json()["detail"])

    def test_create_keeps_other_servers_and_key_order(self):
        self.write_payload({"mcpServers": {
            "alpha": {"command": "python3", "enabled": False},
            "beta": {"command": "python3", "args": ["-v"], "enabled": False}},
            "customTopKey": {"keep": True}})
        resp = CLIENT.post("/api/mcp/servers", json={"name": "gamma", "command": "python3"})
        self.assertEqual(resp.status_code, 200, resp.text)
        payload = self.read_payload()
        self.assertEqual(payload["customTopKey"], {"keep": True})
        self.assertEqual(list(payload["mcpServers"].keys()), ["alpha", "beta", "gamma"])
        self.assertEqual(payload["mcpServers"]["beta"]["args"], ["-v"])

    def test_update_overwrites_existing(self):
        self.write_servers({"demo": {"command": "python3", "args": ["--old"], "enabled": False}})
        resp = CLIENT.put("/api/mcp/servers/demo",
                          json={"name": "demo", "command": "python3", "args": ["--new"], "enabled": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        on_disk = self.read_servers()["demo"]
        self.assertEqual(on_disk["args"], ["--new"])
        self.assertIs(on_disk["enabled"], True)

    def test_update_renames(self):
        self.write_servers({"demo": {"command": "python3", "enabled": False}})
        resp = CLIENT.put("/api/mcp/servers/demo",
                          json={"name": "renamed", "command": "python3", "args": ["x"], "enabled": False})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["server"]["name"], "renamed")
        servers = self.read_servers()
        self.assertEqual(list(servers.keys()), ["renamed"])
        self.assertEqual(servers["renamed"]["args"], ["x"])

    def test_update_keeps_env_and_headers_when_omitted(self):
        self.write_servers({
            "demo": {"command": "python3", "args": [], "env": {"TOKEN": "s1"}, "enabled": False},
            "remote": {"type": "http", "url": "http://127.0.0.1:1/mcp",
                       "headers": {"Authorization": "Bearer abc"}, "enabled": False}})
        resp = CLIENT.put("/api/mcp/servers/demo",
                          json={"name": "demo", "command": "python3", "args": ["-v"], "enabled": False})
        self.assertEqual(resp.status_code, 200, resp.text)
        on_disk = self.read_servers()["demo"]
        self.assertEqual(on_disk["env"], {"TOKEN": "s1"})       # 没传 env → 保留原值
        self.assertEqual(on_disk["args"], ["-v"])               # 其它字段仍是整条替换

        resp = CLIENT.put("/api/mcp/servers/remote",
                          json={"name": "remote", "type": "http", "url": "http://127.0.0.1:2/mcp",
                                "enabled": False})
        self.assertEqual(resp.status_code, 200, resp.text)
        remote = self.read_servers()["remote"]
        self.assertEqual(remote["headers"], {"Authorization": "Bearer abc"})
        self.assertEqual(remote["url"], "http://127.0.0.1:2/mcp")

        # 显式给了 env 就整条替换它
        resp = CLIENT.put("/api/mcp/servers/demo",
                          json={"name": "demo", "command": "python3", "args": [],
                                "env": {"NEW": "1"}, "enabled": False})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(self.read_servers()["demo"]["env"], {"NEW": "1"})

    def test_update_with_empty_env_clears_it(self):
        self.write_servers({
            "demo": {"command": "python3", "args": [], "env": {"TOKEN": "s1"}, "enabled": False},
            "remote": {"type": "http", "url": "http://127.0.0.1:1/mcp",
                       "headers": {"X-Key": "k"}, "enabled": False}})
        resp = CLIENT.put("/api/mcp/servers/demo",
                          json={"name": "demo", "command": "python3", "args": [],
                                "env": {}, "enabled": False})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(self.read_servers()["demo"]["env"], {})

        resp = CLIENT.put("/api/mcp/servers/remote",
                          json={"name": "remote", "type": "http", "url": "http://127.0.0.1:1/mcp",
                                "headers": {}, "enabled": False})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(self.read_servers()["remote"]["headers"], {})

    def test_rename_keeps_env_from_old_name(self):
        self.write_servers({"old": {"command": "python3", "args": [],
                                    "env": {"TOKEN": "keep-me"}, "enabled": False}})
        resp = CLIENT.put("/api/mcp/servers/old",
                          json={"name": "new", "command": "python3", "args": [], "enabled": False})
        self.assertEqual(resp.status_code, 200, resp.text)
        servers = self.read_servers()
        self.assertEqual(list(servers.keys()), ["new"])
        self.assertEqual(servers["new"]["env"], {"TOKEN": "keep-me"})   # 按原路径名取旧值
        self.assertEqual(resp.json()["server"]["env_keys"], ["TOKEN"])

    def test_create_without_env_defaults_to_empty(self):
        resp = CLIENT.post("/api/mcp/servers", json={"name": "demo", "command": "python3"})
        self.assertEqual(resp.status_code, 200, resp.text)
        on_disk = self.read_servers()["demo"]
        self.assertEqual(on_disk["env"], {})
        self.assertEqual(on_disk["headers"], {})

    def test_update_missing_404_and_invalid_400(self):
        self.assertEqual(CLIENT.put("/api/mcp/servers/nope",
                                    json={"command": "python3"}).status_code, 404)
        self.write_servers({"demo": {"command": "python3", "enabled": False}})
        resp = CLIENT.put("/api/mcp/servers/demo", json={"name": "demo", "command": ""})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("command 必填", resp.json()["detail"])
        self.assertEqual(self.read_servers()["demo"]["command"], "python3")   # 失败不写盘

    def test_delete_then_404(self):
        self.write_servers({"demo": {"command": "python3", "enabled": False},
                            "other": {"command": "python3", "enabled": False}})
        resp = CLIENT.delete("/api/mcp/servers/demo")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json(), {"ok": True, "deleted": "demo"})
        self.assertEqual(list(self.read_servers().keys()), ["other"])
        again = CLIENT.delete("/api/mcp/servers/demo")
        self.assertEqual(again.status_code, 404)
        self.assertIn("不存在", again.json()["detail"])

    def test_crud_does_not_trigger_tool_discovery(self):
        self.write_servers({"demo": {"command": "python3", "args": [], "enabled": True}})
        with patch.object(registry, "discover", side_effect=AssertionError("不该触发工具发现")):
            created = CLIENT.post("/api/mcp/servers", json={
                "name": "added", "command": "python3", "args": [], "enabled": False})
            updated = CLIENT.put("/api/mcp/servers/demo",
                                 json={"name": "demo", "command": "python3", "args": ["-v"], "enabled": True})
            deleted = CLIENT.delete("/api/mcp/servers/added")
        for resp in (created, updated, deleted):
            self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(list(self.read_servers().keys()), ["demo"])

    def test_broken_config_is_reported_not_overwritten(self):
        path = config.config_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        resp = CLIENT.post("/api/mcp/servers", json={"name": "demo", "command": "python3"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("现有 MCP 配置不可用", resp.json()["detail"])
        with open(path, "r", encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "{not json")            # 原文件一个字节都没动


if __name__ == "__main__":
    unittest.main()
