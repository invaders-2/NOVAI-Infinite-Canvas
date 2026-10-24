# -*- coding: utf-8 -*-
"""MCP Streamable HTTP 传输（P1）：JSON / SSE 两种响应、session id 回传、错误可读、超时、不可达、协议不匹配。

起一个真的本地 http.server（线程）模拟 MCP 服务，不用 mock 网络。
"""
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.mcp import config, http as mcp_http, registry  # noqa: E402
from server.mcp.errors import McpError  # noqa: E402

SESSION_ID = "sess-http-1"


def _result_for(message):
    method = str(message.get("method") or "")
    params = message.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion") or "2024-11-05",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "http-fake", "version": "0.1"}}
    if method == "tools/list":
        cursor = params.get("cursor") or ""
        if cursor == "":
            return {"tools": [{"name": "echo", "description": "回显",
                               "inputSchema": {"type": "object"},
                               "annotations": {"readOnlyHint": True}}],
                    "nextCursor": "p2"}
        if cursor == "p2":
            return {"tools": [{"name": "sum", "description": "求和",
                               "inputSchema": {"type": "object"}}]}
        return None
    if method == "tools/call":
        name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        if name == "echo":
            return {"content": [{"type": "text", "text": "http-echo: %s" % arguments.get("text", "")}],
                    "isError": False}
        if name == "sum":
            return {"content": [{"type": "text",
                                 "text": "sum=%d" % (int(arguments.get("a") or 0) + int(arguments.get("b") or 0))}],
                    "isError": False}
        if name == "fail":
            return {"content": [{"type": "text", "text": "boom"}], "isError": True}
        return None
    return None


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):        # 测试不打印访问日志
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            message = json.loads(raw.decode("utf-8"))
        except Exception:
            message = {}
        path = urlsplit(self.path).path
        self.server.requests.append({"path": path, "headers": dict(self.headers), "message": message})
        if path == "/unauth":
            return self._send(401, b"missing token", "text/plain")
        if path == "/boom":
            return self._send(500, b"server exploded", "text/plain")
        if path == "/html":
            return self._send(200, b"<html>not an mcp server</html>", "text/html")
        if path == "/slow":
            time.sleep(1.5)
            return self._json(message)
        if path == "/sse":
            return self._sse(message)
        return self._json(message)

    def _send(self, status, body, content_type="application/json", extra_headers=None):
        self.send_response(status)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        if content_type:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)
            self.wfile.flush()

    def _json(self, message):
        method = str(message.get("method") or "")
        if method == "notifications/initialized":
            return self._send(202, b"")
        headers = {"Mcp-Session-Id": SESSION_ID} if method == "initialize" else {}
        result = _result_for(message)
        if result is None:
            payload = {"jsonrpc": "2.0", "id": message.get("id"),
                       "error": {"code": -32601, "message": "method not found"}}
        else:
            payload = {"jsonrpc": "2.0", "id": message.get("id"), "result": result}
        return self._send(200, json.dumps(payload).encode("utf-8"), "application/json", headers)

    def _sse(self, message):
        method = str(message.get("method") or "")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        if method == "initialize":
            self.send_header("Mcp-Session-Id", SESSION_ID)
        self.send_header("Connection", "close")
        self.end_headers()
        # 心跳冒号行 + 一帧通知 + 一帧响应（multi-frame）
        self.wfile.write(b": ping\n\n")
        if method not in ("notifications/initialized",):
            self.wfile.write(b"event: message\ndata: " +
                             json.dumps({"jsonrpc": "2.0", "method": "notifications/progress",
                                         "params": {"progress": 50}}).encode("utf-8") + b"\n\n")
        result = _result_for(message)
        payload = {"jsonrpc": "2.0", "id": message.get("id"),
                   "result": result if result is not None else None}
        if result is None:
            payload = {"jsonrpc": "2.0", "id": message.get("id"),
                       "error": {"code": -32601, "message": "method not found"}}
        self.wfile.write(b"event: message\ndata: " + json.dumps(payload).encode("utf-8") + b"\n\n")
        self.wfile.flush()


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class HttpMcpTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.httpd.requests = []
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.httpd.requests.clear()

    def _server(self, path="/json", timeout=2, headers=None):
        return {"name": "httpfake", "type": "http", "url": self.base + path,
                "headers": headers or {"Authorization": "Bearer secret"}, "timeout": timeout}

    def test_config_http_rules_and_redaction(self):
        server, error = config.normalize_server("svc", {"type": "http", "url": "https://example.com/mcp",
                                                        "headers": {"X-Key": "secret"}})
        self.assertIsNone(error)
        self.assertEqual(server["type"], "http")
        self.assertEqual(server["url"], "https://example.com/mcp")
        self.assertEqual(server["command"], "")
        self.assertEqual(server["headers"], {"X-Key": "secret"})
        view = config.redacted(server)
        self.assertEqual(view["type"], "http")
        self.assertEqual(view["url"], "https://example.com/mcp")
        self.assertEqual(view["header_keys"], ["X-Key"])
        self.assertNotIn("secret", json.dumps(view))

        for raw in ({"type": "ftp", "url": "http://x"},
                    {"type": "http"},
                    {"type": "http", "url": "ftp://x"},
                    {"type": "http", "url": "https://x", "command": "python3"},
                    {"type": "stdio", "command": "python3", "headers": "not-dict"}):
            with self.subTest(raw=raw):
                got, err = config.normalize_server("svc", raw)
                self.assertIsNone(got)
                self.assertTrue(err)

        stdio, err = config.normalize_server("svc2", {"command": "python3"})
        self.assertIsNone(err)
        self.assertEqual(stdio["type"], "stdio")
        self.assertEqual(config.redacted(stdio)["url"], "")

    def test_json_transport_handshake_tools_and_session(self):
        with mcp_http.HttpMcpSession(self._server("/json")) as session:
            self.assertEqual(session.negotiated_version, "2025-03-26")
            self.assertEqual(session.session_id, SESSION_ID)
            tools = session.list_tools()
            self.assertEqual([tool["name"] for tool in tools], ["echo", "sum"])
            result = session.call_tool("echo", {"text": "hi"})
            self.assertEqual(result["content"][0]["text"], "http-echo: hi")
        # 第二次请求（tools/list）带回了 session id；Accept 两种都要
        list_requests = [item for item in self.httpd.requests if item["message"].get("method") == "tools/list"]
        self.assertTrue(list_requests)
        headers = {key.lower(): value for key, value in list_requests[0]["headers"].items()}
        self.assertEqual(headers.get("mcp-session-id"), SESSION_ID)
        self.assertIn("application/json", headers.get("accept", ""))
        self.assertIn("text/event-stream", headers.get("accept", ""))
        self.assertEqual(headers.get("mcp-protocol-version"), "2025-03-26")

    def test_sse_stream_parsing(self):
        with mcp_http.HttpMcpSession(self._server("/sse")) as session:
            self.assertEqual(session.session_id, SESSION_ID)
            tools = session.list_tools()
            self.assertEqual([tool["name"] for tool in tools], ["echo", "sum"])
            result = session.call_tool("sum", {"a": 2, "b": 3})
            self.assertEqual(result["content"][0]["text"], "sum=5")
            self.assertTrue(session.notifications)      # progress 帧被当成通知跳过，响应仍能拿到

    def test_http_401_and_500_are_readable(self):
        for path, status in (("/unauth", 401), ("/boom", 500)):
            with self.subTest(path=path):
                with self.assertRaises(McpError) as ctx:
                    mcp_http.HttpMcpSession(self._server(path)).__enter__()
                error = ctx.exception
                self.assertEqual(error.code, "mcp_http_status")
                self.assertIn(str(status), error.message)
                self.assertIn("missing token" if status == 401 else "server exploded", error.message)

    def test_protocol_mismatch_is_distinct(self):
        with self.assertRaises(McpError) as ctx:
            mcp_http.HttpMcpSession(self._server("/html")).__enter__()
        self.assertEqual(ctx.exception.code, "mcp_http_protocol")
        self.assertIn("协议不匹配", ctx.exception.message)
        self.assertIn("text/html", ctx.exception.message)

    def test_timeout(self):
        with self.assertRaises(McpError) as ctx:
            mcp_http.HttpMcpSession(self._server("/slow", timeout=0.5)).__enter__()
        self.assertEqual(ctx.exception.code, "mcp_http_timeout")
        self.assertIn("超时", ctx.exception.message)

    def test_unreachable(self):
        server = {"name": "dead", "type": "http",
                  "url": "http://127.0.0.1:%d/json" % _free_port(), "timeout": 1}
        with self.assertRaises(McpError) as ctx:
            mcp_http.HttpMcpSession(server).__enter__()
        self.assertEqual(ctx.exception.code, "mcp_http_unreachable")
        self.assertIn("连不上", ctx.exception.message)

    def test_registry_dispatches_http_and_reports_type(self):
        tmp = tempfile.mkdtemp(prefix="novai-mcp-http-")
        try:
            cfg_path = os.path.join(tmp, "mcp_servers.json")
            with open(cfg_path, "w", encoding="utf-8") as fh:
                json.dump({"mcpServers": {"httpfake": {
                    "type": "http", "url": self.base + "/json",
                    "headers": {"Authorization": "Bearer secret"},
                    "timeout": 2, "enabled": True}}}, fh)
            with patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "1", "NOVAI_MCP_CONFIG": cfg_path}):
                registry.reset_cache()
                entries = registry.tool_entries()
                self.assertEqual(sorted(entry["name"] for entry in entries),
                                 ["mcp__httpfake__echo", "mcp__httpfake__sum"])
                rows = registry.servers_view()
                self.assertEqual(rows[0]["type"], "http")
                self.assertEqual(rows[0]["status"], "就绪")
                self.assertEqual(rows[0]["tool_count"], 2)
                self.assertEqual(rows[0]["header_keys"], ["Authorization"])
                self.assertNotIn("Bearer secret", json.dumps(rows[0]))
                result = registry.call_tool("mcp__httpfake__echo", {"text": "ok"})
                self.assertTrue(result["ok"])
                self.assertIn("http-echo: ok", result["result"]["content"][0]["text"])
                registry.reset_cache()
        finally:
            os.environ.pop("NOVAI_MCP_CONFIG", None)
            os.environ.pop("NOVAI_MCP_ENABLED", None)
            registry.reset_cache()
            shutil.rmtree(tmp, ignore_errors=True)

    def test_registry_marks_http_failure_reason(self):
        tmp = tempfile.mkdtemp(prefix="novai-mcp-http-")
        try:
            cfg_path = os.path.join(tmp, "mcp_servers.json")
            with open(cfg_path, "w", encoding="utf-8") as fh:
                json.dump({"mcpServers": {"brokenhttp": {
                    "type": "http", "url": self.base + "/unauth", "timeout": 2, "enabled": True}}}, fh)
            with patch.dict(os.environ, {"NOVAI_MCP_ENABLED": "1", "NOVAI_MCP_CONFIG": cfg_path}):
                registry.reset_cache()
                rows = registry.servers_view()
                self.assertEqual(rows[0]["status"], "失败")
                self.assertIn("401", rows[0]["error"])
                registry.reset_cache()
        finally:
            os.environ.pop("NOVAI_MCP_CONFIG", None)
            os.environ.pop("NOVAI_MCP_ENABLED", None)
            registry.reset_cache()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
