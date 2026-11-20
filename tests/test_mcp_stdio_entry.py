# -*- coding: utf-8 -*-
"""--mcp：主程序内置的 MCP stdio 服务（python3 main.py --mcp）端到端。

真起子进程，走客户端同款「一行一条 JSON-RPC」：断言 stdout 每一行都是合法 JSON-RPC
（没有 [storage]/[TaskEngine] 这类启动日志），initialize / notifications/initialized /
ping / tools/list / tools/call 全链路可用；EOF 后进程正常退出。
"""
import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.mcp import stdio_entry  # noqa: E402

MAIN_PY = str(ROOT / "main.py")
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
        if urlsplit(self.path).path == "/api/canvases":
            return self._send(200, {"canvases": [
                {"id": "c1", "title": "演示画布", "updated_at": 111, "kind": "smart"}]})
        return self._send(404, {"detail": "not found"})


class MainMcpStdioTests(unittest.TestCase):

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

    def _run(self, messages, stdin_text=None):
        if stdin_text is None:
            stdin_text = "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in messages)
        env = dict(os.environ)
        env.update({"NOVAI_BASE_URL": self.base_url, "NOVAI_MCP_TIMEOUT": "10"})
        proc = subprocess.run([sys.executable, MAIN_PY, "--mcp"],
                              input=stdin_text.encode("utf-8"),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=env, timeout=60)
        return proc

    @staticmethod
    def _parse_stdout(proc):
        lines = [line for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
        parsed = []
        for line in lines:
            message = json.loads(line)          # 不是 JSON 就在这里失败
            assert isinstance(message, dict), line
            assert message.get("jsonrpc") == "2.0", line
            parsed.append(message)
        return parsed

    def test_stdout_is_pure_jsonrpc_and_all_methods_work(self):
        proc = self._run([
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-03-26"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "ping"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
             "params": {"name": "novai_canvas_list", "arguments": {"limit": 1}}},
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace")[-2000:])
        parsed = self._parse_stdout(proc)
        self.assertEqual([item["id"] for item in parsed], [1, 2, 3, 4])
        self.assertEqual(parsed[0]["result"]["protocolVersion"], "2024-11-05")
        self.assertEqual(parsed[0]["result"]["serverInfo"]["name"], "novai-mcp-server")
        self.assertEqual(parsed[1]["result"], {})
        self.assertEqual([tool["name"] for tool in parsed[2]["result"]["tools"]], EXPECTED_TOOLS)
        tool_result = parsed[3]["result"]
        self.assertFalse(tool_result["isError"])
        self.assertIn("c1", tool_result["content"][0]["text"])
        self.assertEqual(tool_result["structuredContent"]["canvases"][0]["id"], "c1")

    def test_bad_json_returns_parse_error_and_keeps_running(self):
        stdin_text = ('{not json\n'
                      '{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
        proc = self._run([], stdin_text=stdin_text)
        self.assertEqual(proc.returncode, 0)
        parsed = self._parse_stdout(proc)
        self.assertEqual(parsed[0]["error"]["code"], -32700)
        self.assertIsNone(parsed[0].get("id"))
        self.assertEqual(parsed[1], {"jsonrpc": "2.0", "id": 2, "result": {}})

    def test_blank_lines_are_skipped(self):
        stdin_text = ('\n\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n\n')
        proc = self._run([], stdin_text=stdin_text)
        self.assertEqual(proc.returncode, 0)
        parsed = self._parse_stdout(proc)
        self.assertEqual([item["id"] for item in parsed], [7])

    def test_unknown_method_is_32601(self):
        proc = self._run([{"jsonrpc": "2.0", "id": 9, "method": "resources/list"}])
        self.assertEqual(proc.returncode, 0)
        parsed = self._parse_stdout(proc)
        self.assertEqual(parsed[0]["error"]["code"], -32601)

    def test_eof_exits_cleanly_without_extra_output(self):
        proc = self._run([])
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(self._parse_stdout(proc), [])


class ResolveConfigTests(unittest.TestCase):

    def test_defaults_to_lan_free_localhost_and_port_env(self):
        with patch.dict(os.environ, {"NOVAI_PORT": "4123", "NOVAI_API_TOKEN": "tok",
                                     "NOVAI_MCP_TIMEOUT": "12"}, clear=True):
            self.assertEqual(stdio_entry.resolve_config(),
                             ("http://127.0.0.1:4123", "tok", 12.0))

    def test_falls_back_to_3000_and_30_seconds(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(stdio_entry.resolve_config(), ("http://127.0.0.1:3000", "", 30.0))

    def test_invalid_values_fall_back(self):
        with patch.dict(os.environ, {"NOVAI_PORT": "abc", "NOVAI_MCP_TIMEOUT": "fast"}, clear=True):
            self.assertEqual(stdio_entry.resolve_config()[0], "http://127.0.0.1:3000")
            self.assertEqual(stdio_entry.resolve_config()[2], 30.0)

    def test_explicit_arguments_win(self):
        with patch.dict(os.environ, {"NOVAI_BASE_URL": "http://127.0.0.1:9",
                                     "NOVAI_API_TOKEN": "env-token",
                                     "NOVAI_MCP_TIMEOUT": "9"}, clear=True):
            self.assertEqual(stdio_entry.resolve_config(base_url="http://127.0.0.1:5555",
                                                        token="cli-token", timeout=5),
                             ("http://127.0.0.1:5555", "cli-token", 5.0))


if __name__ == "__main__":
    unittest.main()
