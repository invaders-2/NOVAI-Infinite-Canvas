# -*- coding: utf-8 -*-
"""MCP server（P2）端到端：用我们自己的 P0 stdio 客户端连 novai_mcp_server.py 真实子进程。

假 NOVAI REST 用本地 ThreadingHTTPServer；客户端走的协议链路与外部 Agent（Claude Desktop 等）一致。
"""
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.mcp import jsonrpc  # noqa: E402
from server.mcp.stdio import StdioMcpSession  # noqa: E402

SERVER_ENTRY = str(ROOT / "novai_mcp_server.py")
EXPECTED_TOOLS = ["novai_canvas_list", "novai_canvas_get", "novai_node_create",
                  "novai_node_update", "novai_image_generate"]


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
            return self._send(200, {"canvases": [
                {"id": "c1", "title": "演示画布", "updated_at": 111, "kind": "smart"},
                {"id": "c2", "title": "第二个画布", "updated_at": 222, "kind": "classic"},
            ]})
        if path == "/api/canvases/c1":
            return self._send(200, {"canvas": {"id": "c1", "title": "演示画布", "kind": "smart",
                                               "nodes": [{"id": "n1", "type": "smart-prompt", "title": "提示词"}],
                                               "connections": []}})
        return self._send(404, {"detail": {"message": "画布不存在", "code": "canvas_not_found"}})


class McpServerProcessTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _FakeNovai)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = "http://127.0.0.1:%d" % cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def _session(self):
        return StdioMcpSession({
            "name": "novai-mcp",
            "command": sys.executable,
            "args": [SERVER_ENTRY],
            "env": {"NOVAI_BASE_URL": self.base_url, "NOVAI_MCP_TIMEOUT": "5"},
            "timeout": 10,
        })

    def test_initialize_negotiates_version_and_lists_five_tools(self):
        with self._session() as session:
            # 客户端先提 2025-03-26，服务端只认 2024-11-05，最终以服务端返回的为准
            self.assertEqual(session.negotiated_version, "2024-11-05")
            self.assertEqual(session.server_info.get("name"), "novai-mcp-server")
            names = [tool["name"] for tool in session.list_tools()]
            self.assertEqual(names, EXPECTED_TOOLS)

    def test_tools_call_canvas_list(self):
        with self._session() as session:
            result = session.call_tool("novai_canvas_list", {"limit": 1})
        self.assertFalse(result["isError"])
        text = result["content"][0]["text"]
        self.assertIn("c1", text)
        self.assertEqual(len(result["structuredContent"]["canvases"]), 1)

    def test_tools_call_canvas_get(self):
        with self._session() as session:
            result = session.call_tool("novai_canvas_get", {"canvas_id": "c1"})
        self.assertFalse(result["isError"])
        self.assertIn("1 个节点", result["content"][0]["text"])
        self.assertEqual(result["structuredContent"]["node_count"], 1)

    def test_tools_call_missing_canvas_maps_to_error_content(self):
        with self._session() as session:
            result = session.call_tool("novai_canvas_get", {"canvas_id": "missing"})
        self.assertTrue(result["isError"])
        self.assertIn("HTTP 404", result["content"][0]["text"])

    def test_unknown_tool_is_error_not_exception(self):
        with self._session() as session:
            result = session.call_tool("no_such_tool", {})
        self.assertTrue(result["isError"])
        self.assertIn("未知工具", result["content"][0]["text"])

    def test_unknown_method_returns_32601(self):
        with self._session() as session:
            with self.assertRaises(jsonrpc.JsonRpcError) as ctx:
                session.peer.request("resources/list", {})
        self.assertEqual(ctx.exception.code, jsonrpc.METHOD_NOT_FOUND)

    def test_malformed_json_returns_parse_error_and_keeps_running(self):
        with self._session() as session:
            session.transport.send_line(b"{not json\n")
            message = jsonrpc.decode_message(session.transport.read_line(5))
            self.assertEqual(message["error"]["code"], jsonrpc.PARSE_ERROR)
            self.assertIsNone(message.get("id"))
            self.assertEqual(session.peer.request("ping", {}), {})

    def test_oversized_input_is_rejected_and_process_survives(self):
        with self._session() as session:
            big = b'{"jsonrpc":"2.0","id":7,"method":"ping","params":{"x":"' + b"a" * (1024 * 1024 + 10) + b'"}}\n'
            session.transport.send_line(big)
            message = jsonrpc.decode_message(session.transport.read_line(10))
            self.assertEqual(message["error"]["code"], jsonrpc.INVALID_REQUEST)
            self.assertIn("1MB", message["error"]["message"])
            self.assertEqual(session.peer.request("ping", {}), {})


if __name__ == "__main__":
    unittest.main()
