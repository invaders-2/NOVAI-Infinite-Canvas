# -*- coding: utf-8 -*-
"""MCP 客户端（P0）：配置校验、JSON-RPC、stdio 传输、注册表（发现/风险/脱敏/分页/超时清理）。

用 tests/fixtures/mcp_fake_server.py 作为真实 stdio 服务（不是 mock 进程），所以这些用例
会真的起子进程、真的走管道；每个用例只跑必要的几次，避免测试变慢。
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.mcp import config, jsonrpc, registry, stdio  # noqa: E402

FAKE_SERVER = str(ROOT / "tests" / "fixtures" / "mcp_fake_server.py")

# 停用接口的测试要 import main（TestClient），给一份临时数据目录，别写到真实数据里
_TMP_HOME = tempfile.mkdtemp(prefix="novai-mcp-client-home-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_HOME)


def tearDownModule():
    registry.reset_cache()
    shutil.rmtree(_TMP_HOME, ignore_errors=True)


def fake_server(timeout=30, enabled=True):
    return {"name": "fake", "command": sys.executable, "args": [FAKE_SERVER],
            "env": {"SECRET_TOKEN": "不要泄露"}, "timeout": timeout, "enabled": enabled}


def write_config(path, servers, top_key="mcpServers"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({top_key: servers}, fh, ensure_ascii=False)


class McpEnvMixin(unittest.TestCase):
    """临时配置 + 打开总开关；每个用例结束清缓存。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-mcp-test-")
        self.config_path = os.path.join(self.tmp, "mcp_servers.json")
        write_config(self.config_path, {"fake": fake_server()})
        self.env = patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "1",
                                           "NOVAI_MCP_CONFIG": self.config_path})
        self.env.start()
        registry.reset_cache()

    def tearDown(self):
        self.env.stop()
        registry.reset_cache()
        shutil.rmtree(self.tmp, ignore_errors=True)


class ConfigTests(unittest.TestCase):

    def test_template_exists_with_top_key(self):
        path = config.template_path()
        self.assertTrue(os.path.isfile(path))
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        self.assertIsInstance(payload.get("mcpServers"), dict)
        self.assertEqual(payload["mcpServers"], {})

    def test_normalize_defaults(self):
        server, error = config.normalize_server("my-server_1", {"command": "python3"})
        self.assertIsNone(error)
        self.assertEqual(server["args"], [])
        self.assertEqual(server["env"], {})
        self.assertEqual(server["timeout"], config.DEFAULT_TIMEOUT)
        self.assertFalse(server["enabled"])

    def test_normalize_rejects_bad_values(self):
        cases = [
            ("Bad Name", {"command": "x"}),
            ("ok", {}),
            ("ok", {"command": ""}),
            ("ok", {"command": "x", "args": "not-list"}),
            ("ok", {"command": "x", "args": [1]}),
            ("ok", {"command": "x", "env": "nope"}),
            ("ok", {"command": "x", "env": {"A": {"nested": 1}}}),
            ("ok", {"command": "x", "timeout": "slow"}),
            ("ok", {"command": "x", "timeout": 0}),
            ("ok", {"command": "x", "enabled": "yes"}),
            ("ok", "not-dict"),
        ]
        for name, raw in cases:
            with self.subTest(name=name, raw=raw):
                server, error = config.normalize_server(name, raw)
                self.assertIsNone(server)
                self.assertTrue(error)

    def test_load_config_collects_errors(self):
        tmp = tempfile.mkdtemp(prefix="novai-mcp-cfg-")
        try:
            path = os.path.join(tmp, "mcp_servers.json")
            write_config(path, {
                "good": {"command": "python3", "args": [], "timeout": 12, "enabled": True},
                "bad": {"args": []},
                "BadName": {"command": "python3"},
            })
            cfg = config.load_config(path)
            self.assertEqual(sorted(cfg["servers"].keys()), ["good"])
            self.assertEqual(cfg["servers"]["good"]["timeout"], 12)
            self.assertTrue(cfg["servers"]["good"]["enabled"])
            names = [item["name"] for item in cfg["errors"]]
            self.assertIn("bad", names)
            self.assertIn("BadName", names)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_missing_file(self):
        cfg = config.load_config(os.path.join(tempfile.gettempdir(), "definitely-missing-mcp.json"))
        self.assertTrue(cfg["missing"])
        self.assertEqual(cfg["servers"], {})
        self.assertEqual(cfg["errors"], [])

    def test_top_key_required(self):
        tmp = tempfile.mkdtemp(prefix="novai-mcp-cfg-")
        try:
            path = os.path.join(tmp, "mcp_servers.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"servers": {}}, fh)
            cfg = config.load_config(path)
            self.assertEqual(cfg["servers"], {})
            self.assertIn("mcpServers", cfg["errors"][0]["error"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_redacted_hides_env_values(self):
        server, _ = config.normalize_server("fake", {"command": "x", "env": {"SECRET_TOKEN": "abc", "OTHER": "1"}})
        view = config.redacted(server)
        self.assertEqual(view["env_keys"], ["OTHER", "SECRET_TOKEN"])
        self.assertNotIn("env", view)
        self.assertNotIn("abc", json.dumps(view))

    def test_env_path_override(self):
        with patch.dict(os.environ, {"NOVAI_MCP_CONFIG": "/tmp/x/mcp_servers.json"}):
            self.assertEqual(config.config_path(), os.path.abspath("/tmp/x/mcp_servers.json"))

    def test_env_enabled_flag(self):
        with patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "1"}):
            self.assertTrue(config.env_enabled())
        with patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "0"}):
            self.assertFalse(config.env_enabled())


class _FakeTransport:
    def __init__(self, responses=None):
        self.sent = []
        self.responses = list(responses or [])

    def send_line(self, raw):
        self.sent.append(json.loads(raw.decode("utf-8")))

    def read_line(self, timeout=None):
        if not self.responses:
            raise jsonrpc.JsonRpcTimeout()
        return self.responses.pop(0)


class JsonRpcTests(unittest.TestCase):

    def test_message_roundtrip_and_ids(self):
        transport = _FakeTransport()
        peer = jsonrpc.JsonRpcPeer(transport, timeout=1)
        self.assertEqual(peer.new_id(), 1)
        self.assertEqual(peer.new_id(), 2)
        transport.responses.append(jsonrpc.encode_message({"jsonrpc": "2.0", "id": 3, "result": {"ok": 1}}))
        result = peer.request("ping", {"a": 1})
        self.assertEqual(result, {"ok": 1})
        sent = transport.sent[-1]
        self.assertEqual(sent["method"], "ping")
        self.assertEqual(sent["id"], 3)
        self.assertEqual(sent["params"], {"a": 1})

    def test_notification_has_no_id(self):
        transport = _FakeTransport()
        peer = jsonrpc.JsonRpcPeer(transport, timeout=1)
        peer.notify("notifications/initialized", {})
        self.assertNotIn("id", transport.sent[-1])
        self.assertEqual(transport.sent[-1]["method"], "notifications/initialized")

    def test_error_response_raises(self):
        transport = _FakeTransport()
        peer = jsonrpc.JsonRpcPeer(transport, timeout=1)
        transport.responses.append(jsonrpc.encode_message(
            {"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "bad params"}}))
        with self.assertRaises(jsonrpc.JsonRpcError) as ctx:
            peer.request("tools/list", {})
        self.assertEqual(ctx.exception.code, -32602)
        self.assertIn("bad params", ctx.exception.message)

    def test_oversize_rejected(self):
        message = {"jsonrpc": "2.0", "id": 1, "result": "x" * (jsonrpc.MAX_MESSAGE_BYTES + 1)}
        with self.assertRaises(jsonrpc.JsonRpcTooLarge):
            jsonrpc.encode_message(message)
        with self.assertRaises(jsonrpc.JsonRpcTooLarge):
            jsonrpc.decode_message(b"{" + b" " * (jsonrpc.MAX_MESSAGE_BYTES + 1) + b"}")

    def test_invalid_json_rejected(self):
        with self.assertRaises(jsonrpc.JsonRpcError):
            jsonrpc.decode_message(b"{not json")

    def test_notification_and_server_request_handled(self):
        transport = _FakeTransport()
        peer = jsonrpc.JsonRpcPeer(transport, timeout=1)
        transport.responses.append(jsonrpc.encode_message({"jsonrpc": "2.0", "method": "progress", "params": {}}))
        transport.responses.append(jsonrpc.encode_message({"jsonrpc": "2.0", "id": 99, "method": "roots/list"}))
        transport.responses.append(jsonrpc.encode_message({"jsonrpc": "2.0", "id": 1, "result": "done"}))
        self.assertEqual(peer.request("ping"), "done")
        self.assertEqual(len(peer.notifications), 1)
        # 对服务端请求回了 -32601
        replies = [item for item in transport.sent if item.get("id") == 99]
        self.assertEqual(replies[0]["error"]["code"], jsonrpc.METHOD_NOT_FOUND)


class StdioSessionTests(McpEnvMixin):

    def test_initialize_fallback_and_initialized_notification(self):
        server = fake_server()
        with stdio.StdioMcpSession(server) as session:
            self.assertEqual(session.negotiated_version, "2024-11-05")   # 新版被拒 → 回退
            result = session.call_tool("echo", {"text": "hi"})
            text = result["content"][0]["text"]
            self.assertIn("echo: hi", text)
            self.assertIn("initialized=1", text)                         # notifications/initialized 确实发了

    def test_tools_list_paginates_cursor(self):
        with stdio.StdioMcpSession(fake_server()) as session:
            tools = session.list_tools()
        names = [tool["name"] for tool in tools]
        self.assertEqual(names, ["echo", "slow"])                        # 两页各 1 个，按顺序合并

    def test_call_tool_error_flag(self):
        with stdio.StdioMcpSession(fake_server()) as session:
            result = session.call_tool("fail", {})
        self.assertTrue(result["isError"])
        self.assertEqual(result["content"][0]["text"], "boom")

    def test_unknown_tool_raises(self):
        with stdio.StdioMcpSession(fake_server()) as session:
            with self.assertRaises(stdio.McpError):
                session.call_tool("no-such-tool", {})

    def test_timeout_kills_process_and_reports_stderr(self):
        session = stdio.StdioMcpSession(fake_server(timeout=1), timeout=1)
        session.transport.start()
        session.peer = jsonrpc.JsonRpcPeer(session.transport, timeout=1)
        process = session.transport.process
        self.assertIsNotNone(process)
        try:
            session.initialize()
            with self.assertRaises(stdio.McpError) as ctx:
                session.call_tool("slow", {})
            self.assertIn("超时", str(ctx.exception))
        finally:
            session.close()
        self.assertIsNotNone(process.poll())                              # 超时后进程被杀
        self.assertTrue(any("fake-mcp server started" in line for line in session.stderr_tail()))

    def test_context_manager_cleans_up_process(self):
        session = stdio.StdioMcpSession(fake_server())
        with session:
            process = session.transport.process
            self.assertIsNone(process.poll())
        self.assertIsNotNone(process.poll())                              # 退出即回收


class RegistryTests(McpEnvMixin):

    def test_discovery_maps_entries_and_risk(self):
        entries = registry.tool_entries()
        names = sorted(entry["name"] for entry in entries)
        self.assertEqual(names, ["mcp__fake__echo", "mcp__fake__slow"])
        by_name = {entry["name"]: entry for entry in entries}
        self.assertEqual(by_name["mcp__fake__echo"]["id"], "fake.echo")
        self.assertEqual(by_name["mcp__fake__echo"]["risk"], "low")       # annotations.readOnlyHint
        self.assertEqual(by_name["mcp__fake__slow"]["risk"], "medium")    # 无注解、无关键词
        self.assertEqual(by_name["mcp__fake__echo"]["input_schema"]["type"], "object")

    def test_risk_inference_keywords(self):
        cases = [
            ({"name": "get_user"}, "low"),
            ({"name": "list_projects"}, "low"),
            ({"name": "search_docs"}, "low"),
            ({"name": "create_issue"}, "medium"),
            ({"name": "update_page"}, "medium"),
            ({"name": "delete_repo"}, "high"),
            ({"name": "drop_table"}, "high"),
            ({"name": "annotated_read", "annotations": {"readOnlyHint": True}}, "low"),
            ({"name": "annotated_write", "annotations": {"readOnlyHint": True, "destructiveHint": True}}, "low"),
        ]
        for tool, expected in cases:
            with self.subTest(tool=tool):
                self.assertEqual(registry._resolve_risk(tool), expected)

    def test_agent_tool_entries_describe_server(self):
        rows = registry.agent_tool_entries()
        self.assertEqual(len(rows), 2)
        echo = next(row for row in rows if row["name"] == "mcp__fake__echo")
        self.assertIn("fake", echo["description"])

    def test_call_tool_serializes_text(self):
        result = registry.call_tool("mcp__fake__echo", {"text": "hi"})
        self.assertTrue(result["ok"])
        text = result["result"]["content"][0]["text"]
        self.assertIn("echo: hi", text)
        # 也支持能力 id 形式
        by_id = registry.call_tool("fake.echo", {"text": "id"})
        self.assertTrue(by_id["ok"])

    def test_call_unknown_tool(self):
        result = registry.call_tool("mcp__fake__nope", {})
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "unknown_tool")

    def test_execute_agent_step_contract(self):
        ok = registry.execute_agent_step("mcp__fake__echo", {"text": "x"})
        self.assertTrue(ok["ok"])
        self.assertEqual(ok["tool"], "mcp__fake__echo")
        bad = registry.execute_agent_step("mcp__fake__echo", {})
        self.assertTrue(bad["ok"])                                        # 缺参数也算成功（服务端自己处理）
        missing = registry.execute_agent_step("mcp__fake__nope", {})
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["code"], "unknown_tool")

    def test_servers_view_ready_and_redacted(self):
        rows = registry.servers_view()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["status"], "就绪")
        self.assertEqual(row["tool_count"], 2)
        self.assertEqual(row["env_keys"], ["SECRET_TOKEN"])
        self.assertNotIn("env", row)
        self.assertNotIn("不要泄露", json.dumps(row, ensure_ascii=False))

    def test_disabled_switch_hides_everything(self):
        with patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "0"}):
            registry.reset_cache()
            self.assertEqual(registry.tool_entries(), [])
            self.assertEqual(registry.agent_tool_entries(), [])
            rows = registry.servers_view()
            self.assertEqual(rows[0]["status"], "未启用")

    def test_server_disabled_in_config_not_connected(self):
        write_config(self.config_path, {"fake": fake_server(enabled=False)})
        registry.reset_cache()
        rows = registry.servers_view()
        self.assertEqual(rows[0]["status"], "未启用")
        self.assertEqual(registry.tool_entries(), [])

    def test_reload_returns_summary(self):
        summary = registry.reload()
        self.assertTrue(summary["enabled"])
        self.assertEqual(summary["servers"][0]["status"], "就绪")


class DisableApiTests(McpEnvMixin):
    """POST /api/mcp/servers/{name}/disable：落盘停用、状态回未启用、reload 不恢复、不存在 404。"""

    def _client(self):
        import warnings
        from fastapi.testclient import TestClient
        with warnings.catch_warnings():                 # main 里的 on_event 弃用警告，别刷屏
            warnings.simplefilter("ignore", DeprecationWarning)
            import main
        return TestClient(main.app)

    def setUp(self):
        super().setUp()
        # 从「未启用」开始，先 enable 再 disable，覆盖完整状态流转
        write_config(self.config_path, {"fake": fake_server(enabled=False)})
        registry.reset_cache()

    def test_enable_then_disable_returns_to_disabled(self):
        client = self._client()
        enabled = client.post("/api/mcp/servers/fake/enable", json={"confirm": True})
        self.assertEqual(enabled.status_code, 200)
        self.assertTrue(enabled.json()["server"]["enabled"])
        self.assertEqual(enabled.json()["server"]["status"], "就绪")

        disabled = client.post("/api/mcp/servers/fake/disable")
        self.assertEqual(disabled.status_code, 200)
        body = disabled.json()
        self.assertTrue(body["ok"])
        self.assertFalse(body["server"]["enabled"])
        self.assertEqual(body["server"]["status"], "未启用")
        self.assertEqual(body["server"]["tool_count"], 0)
        self.assertEqual(body["server"]["tools"], [])

    def test_disable_is_persisted_and_reload_keeps_it_off(self):
        client = self._client()
        client.post("/api/mcp/servers/fake/enable", json={"confirm": True})
        client.post("/api/mcp/servers/fake/disable")

        self.assertFalse(config.load_config(self.config_path)["servers"]["fake"]["enabled"])
        reloaded = client.post("/api/mcp/reload").json()
        row = next(item for item in reloaded["servers"] if item["name"] == "fake")
        self.assertEqual(row["status"], "未启用")
        self.assertFalse(row["enabled"])
        self.assertEqual(registry.tool_entries(), [])          # 重新发现也不会恢复

    def test_disable_missing_server_404(self):
        client = self._client()
        resp = client.post("/api/mcp/servers/no-such-server/disable")
        self.assertEqual(resp.status_code, 404)
        self.assertIn("不存在", resp.json()["detail"])


if __name__ == "__main__":
    unittest.main()
