# -*- coding: utf-8 -*-
"""MCP server 的 Streamable HTTP 传输：真起子进程 --transport http，用 urllib 走真实往返。

假 NOVAI REST 用本地 ThreadingHTTPServer；协议侧断言 session 头、7 个工具、工具调用、错误码、GET 405。
"""
import json
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SERVER_ENTRY = str(ROOT / "novai_mcp_server.py")
EXPECTED_TOOLS = ["novai_canvas_list", "novai_canvas_get", "novai_node_create",
                  "novai_node_update", "novai_image_generate", "novai_canvas_create",
                  "novai_node_delete"]


class _FakeNovai(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        return

    def _send(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/canvases":
            return self._send(200, {"canvases": [{"id": "c1", "title": "演示画布", "updated_at": 1,
                                                  "kind": "smart"}]})
        if path == "/api/canvases/c1":
            return self._send(200, {"canvas": {"id": "c1", "title": "演示画布", "kind": "smart",
                                               "nodes": [{"id": "n1", "type": "smart-prompt",
                                                          "title": "提示词"}],
                                               "connections": []}})
        return self._send(404, {"detail": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            body = {}
        path = urlsplit(self.path).path
        args = body.get("args") if isinstance(body, dict) and isinstance(body.get("args"), dict) else {}
        if path == "/api/agent/tools/create_node":
            return self._send(200, {"ok": True, "tool": "create_node",
                                    "result": {"node_id": "node_http_1", "type": args.get("type")}})
        if path == "/api/agent/tools/delete_node":
            return self._send(200, {"ok": True, "tool": "delete_node",
                                    "result": {"node_id": args.get("node_id")}})
        if path == "/api/canvases":
            title = body.get("title") if isinstance(body, dict) else ""
            return self._send(200, {"canvas": {"id": "c_new", "title": title or "新画布"}})
        return self._send(404, {"detail": "not found"})


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class McpServerHttpTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.rest = ThreadingHTTPServer(("127.0.0.1", 0), _FakeNovai)
        cls.rest_thread = threading.Thread(target=cls.rest.serve_forever, daemon=True)
        cls.rest_thread.start()
        cls.base_url = "http://127.0.0.1:%d" % cls.rest.server_address[1]

        cls.port = _free_port()
        cls.url = "http://127.0.0.1:%d/mcp" % cls.port
        cls.proc = subprocess.Popen(
            [sys.executable, SERVER_ENTRY, "--transport", "http", "--host", "127.0.0.1",
             "--port", str(cls.port), "--path", "/mcp", "--base-url", cls.base_url,
             "--timeout", "5"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", cls.port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError("MCP HTTP server 没起来")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        if cls.proc.stderr:
            cls.proc.stderr.close()
        cls.rest.shutdown()
        cls.rest.server_close()
        cls.rest_thread.join(timeout=2)

    # ---- helpers ----

    def _post(self, payload=None, raw=None, headers=None):
        data = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.url, data=data, method="POST",
                                         headers={"Content-Type": "application/json",
                                                  "Accept": "application/json, text/event-stream"})
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, dict(response.headers), json.loads(response.read().decode("utf-8"))

    def test_initialize_sets_session_header(self):
        status, headers, body = self._post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                            "params": {"protocolVersion": "2025-03-26"}})
        self.assertEqual(status, 200)
        session_id = headers.get("Mcp-Session-Id") or headers.get("mcp-session-id")
        self.assertTrue(session_id)
        self.assertEqual(body["result"]["protocolVersion"], "2024-11-05")
        self.assertEqual(body["result"]["serverInfo"]["name"], "novai-mcp-server")
        # 后续请求带同一个 session id
        _, headers2, _ = self._post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(headers2.get("Mcp-Session-Id") or headers2.get("mcp-session-id"), session_id)

    def test_tools_list_has_seven_tools(self):
        _, _, body = self._post({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
        names = [tool["name"] for tool in body["result"]["tools"]]
        self.assertEqual(names, EXPECTED_TOOLS)

    def test_tools_call_read_and_write(self):
        _, _, body = self._post({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                                 "params": {"name": "novai_canvas_list", "arguments": {"limit": 5}}})
        result = body["result"]
        self.assertFalse(result["isError"])
        self.assertIn("c1", result["content"][0]["text"])

        _, _, body = self._post({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                                 "params": {"name": "novai_node_create",
                                            "arguments": {"canvas_id": "c1", "text": "来自 HTTP"}}})
        result = body["result"]
        self.assertFalse(result["isError"])
        self.assertIn("node_http_1", result["content"][0]["text"])

    def test_batch_request_returns_array(self):
        status, _, body = self._post([
            {"jsonrpc": "2.0", "id": 6, "method": "ping"},
            {"jsonrpc": "2.0", "id": 7, "method": "tools/list"},
        ])
        self.assertEqual(status, 200)
        self.assertIsInstance(body, list)
        self.assertEqual([item["id"] for item in body], [6, 7])

    def test_unknown_method_32601(self):
        _, _, body = self._post({"jsonrpc": "2.0", "id": 8, "method": "resources/list"})
        self.assertEqual(body["error"]["code"], -32601)

    def test_malformed_json_32700(self):
        _, _, body = self._post(raw=b"{not json")
        self.assertEqual(body["error"]["code"], -32700)

    def test_get_returns_405(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(self.url, timeout=5)
        self.assertEqual(ctx.exception.code, 405)
        text = ctx.exception.read().decode("utf-8", "replace")
        self.assertIn("POST", text)

    def test_delete_returns_204(self):
        request = urllib.request.Request(self.url, method="DELETE")
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 204)


if __name__ == "__main__":
    unittest.main()
