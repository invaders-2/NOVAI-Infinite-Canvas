# -*- coding: utf-8 -*-
"""MCP server 工具层：请求构造、参数校验、HTTP 错误映射（404/500/超时/连不上/非 JSON）。

用本地 ThreadingHTTPServer 当假的 NOVAI REST。
"""
import json
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.mcp import server_tools  # noqa: E402


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        return

    def _send(self, status, payload, content_type="application/json"):
        raw = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if raw:
            self.wfile.write(raw)

    def do_GET(self):
        path = urlsplit(self.path).path
        self.server.requests.append({"method": "GET", "path": path,
                                     "headers": dict(self.headers), "body": None})
        if path.startswith("/badjson"):
            return self._send(200, b"this is not json", "text/plain")
        if path.startswith("/slow"):
            time.sleep(1.5)
            return self._send(200, {"canvases": []})
        if path == "/api/canvases":
            items = [{"id": "c%d" % index, "title": "画布%d" % index, "updated_at": 1000 + index,
                      "kind": "smart" if index % 2 == 0 else "classic"} for index in range(1, 26)]
            return self._send(200, {"canvases": items})
        if path == "/api/canvases/c1":
            return self._send(200, {"canvas": {
                "id": "c1", "title": "画布一", "kind": "smart",
                "nodes": [{"id": "n1", "type": "smart-prompt", "title": "提示词一"},
                          {"id": "n2", "type": "smart-image", "title": ""}],
                "connections": [{"from": "n1", "to": "n2"}],
            }})
        if path == "/api/canvases/missing":
            return self._send(404, {"detail": {"message": "画布不存在", "code": "canvas_not_found"}})
        if path == "/api/canvases/boom":
            return self._send(500, {"detail": "内部错误"})
        return self._send(404, {"detail": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            body = {}
        path = urlsplit(self.path).path
        self.server.requests.append({"method": "POST", "path": path, "headers": dict(self.headers), "body": body})
        args = body.get("args") if isinstance(body, dict) else {}
        if path == "/api/agent/tools/create_node":
            if str(args.get("type") or "") == "text":
                return self._send(400, {"detail": {"message": "type 必须是 image|prompt|video",
                                                   "code": "invalid_args"}})
            return self._send(200, {"ok": True, "tool": "create_node",
                                    "result": {"node_id": "node_new", "x": 10, "y": 20}})
        if path == "/api/agent/tools/update_node":
            if str(args.get("node_id") or "") == "missing":
                return self._send(404, {"detail": {"message": "节点 missing 不存在", "code": "node_not_found"}})
            return self._send(200, {"ok": True, "tool": "update_node",
                                    "result": {"node_id": args.get("node_id"), "title": args.get("title")}})
        if path == "/api/agent/tools/generate_image":
            return self._send(200, {"ok": True, "tool": "generate_image",
                                    "result": {"task_id": "task_1", "node_id": "node_img"}})
        if path == "/api/agent/tools/delete_node":
            if str(args.get("node_id") or "") == "missing":
                return self._send(404, {"detail": {"message": "节点 missing 不存在",
                                                   "code": "node_not_found"}})
            return self._send(200, {"ok": True, "tool": "delete_node",
                                    "result": {"node_id": args.get("node_id"), "deleted": True}})
        if path == "/api/canvases":
            title = body.get("title") if isinstance(body, dict) else ""
            return self._send(200, {"canvas": {"id": "c_new", "title": title or "新画布",
                                               "kind": "classic"}})
        return self._send(404, {"detail": "unknown tool"})


class ServerToolsTests(unittest.TestCase):

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

    def test_tool_catalog_shape(self):
        names = [tool["name"] for tool in server_tools.TOOLS]
        self.assertEqual(len(names), 7)
        for tool in server_tools.TOOLS:
            with self.subTest(tool=tool["name"]):
                self.assertTrue(tool["description"])
                self.assertEqual(tool["inputSchema"]["type"], "object")
        required = {tool["name"]: set(tool["inputSchema"].get("required") or []) for tool in server_tools.TOOLS}
        self.assertEqual(required["novai_canvas_get"], {"canvas_id"})
        self.assertEqual(required["novai_node_update"], {"canvas_id", "node_id"})
        self.assertEqual(required["novai_image_generate"], {"canvas_id", "prompt"})
        self.assertEqual(required["novai_canvas_create"], set())
        self.assertEqual(required["novai_node_delete"], {"canvas_id", "node_id"})
        # 写操作要在说明里标出副作用
        for name in ("novai_node_create", "novai_node_update", "novai_image_generate"):
            tool = next(item for item in server_tools.TOOLS if item["name"] == name)
            self.assertIn("会修改画布", tool["description"])
        delete_tool = next(item for item in server_tools.TOOLS if item["name"] == "novai_node_delete")
        self.assertIn("会修改画布", delete_tool["description"])
        self.assertIn("不可撤销", delete_tool["description"])
        create_tool = next(item for item in server_tools.TOOLS if item["name"] == "novai_canvas_create")
        self.assertIn("新建", create_tool["description"])
        # 现有工具补了「先确认画布 id」的使用约束
        for name in ("novai_canvas_get", "novai_node_create", "novai_node_update",
                     "novai_image_generate"):
            tool = next(item for item in server_tools.TOOLS if item["name"] == name)
            self.assertIn("确认画布 id", tool["description"])

    def test_canvas_list_request_and_limit(self):
        outcome = server_tools.canvas_list(self.base, "", limit=2)
        self.assertTrue(outcome["ok"], outcome)
        self.assertEqual(len(outcome["data"]["canvases"]), 2)
        self.assertIn("c1", outcome["text"])
        request = self.httpd.requests[-1]
        self.assertEqual(request["method"], "GET")
        self.assertEqual(request["path"], "/api/canvases")

    def test_canvas_list_invalid_limit(self):
        self.assertFalse(server_tools.canvas_list(self.base, "", limit="abc")["ok"])
        self.assertFalse(server_tools.canvas_list(self.base, "", limit=0)["ok"])

    def test_canvas_get_summary(self):
        outcome = server_tools.canvas_get(self.base, "", canvas_id="c1")
        self.assertTrue(outcome["ok"], outcome)
        data = outcome["data"]
        self.assertEqual(data["node_count"], 2)
        self.assertEqual(data["connection_count"], 1)
        self.assertEqual([node["id"] for node in data["nodes"]], ["n1", "n2"])
        self.assertIn("2 个节点", outcome["text"])

    def test_canvas_get_404_readable(self):
        outcome = server_tools.canvas_get(self.base, "", canvas_id="missing")
        self.assertFalse(outcome["ok"])
        self.assertIn("HTTP 404", outcome["text"])
        self.assertIn("画布不存在", outcome["text"])

    def test_canvas_get_500_readable(self):
        outcome = server_tools.canvas_get(self.base, "", canvas_id="boom")
        self.assertFalse(outcome["ok"])
        self.assertIn("HTTP 500", outcome["text"])
        self.assertIn("内部错误", outcome["text"])

    def test_node_create_falls_back_for_classic_canvas(self):
        outcome = server_tools.node_create(self.base, "", canvas_id="c1", text="你好")
        self.assertTrue(outcome["ok"], outcome)
        self.assertIn("node_new", outcome["text"])
        self.assertIn("prompt", outcome["text"])              # 提示走了 fallback
        create_calls = [item for item in self.httpd.requests
                        if item["path"] == "/api/agent/tools/create_node"]
        self.assertEqual([item["body"]["args"]["type"] for item in create_calls], ["text", "prompt"])
        self.assertEqual(create_calls[0]["body"]["args"]["prompt"], "你好")

    def test_node_create_uses_token_header(self):
        server_tools.node_create(self.base, "tok-123", canvas_id="c1", node_type="prompt", text="x")
        headers = {key.lower(): value for key, value in self.httpd.requests[-1]["headers"].items()}
        self.assertEqual(headers.get("authorization"), "Bearer tok-123")

    def test_node_create_rejects_bad_coordinates(self):
        outcome = server_tools.node_create(self.base, "", canvas_id="c1", text="x", x="abc")
        self.assertFalse(outcome["ok"])
        self.assertIn("x 必须是数字", outcome["text"])

    def test_node_update_maps_text_and_settings(self):
        outcome = server_tools.node_update(self.base, "", canvas_id="c1", node_id="n1",
                                           title="新标题", text="新文本",
                                           settings={"model": "m1", "ratio": "1:1"})
        self.assertTrue(outcome["ok"], outcome)
        self.assertIn("节点已更新：n1", outcome["text"])
        args = self.httpd.requests[-1]["body"]["args"]
        self.assertEqual(args["canvas_id"], "c1")
        self.assertEqual(args["node_id"], "n1")
        self.assertEqual(args["title"], "新标题")
        self.assertEqual(args["prompt"], "新文本")            # 统一映射到 prompt
        self.assertEqual(args["settings"], {"model": "m1", "ratio": "1:1"})

    def test_node_update_requires_a_field(self):
        outcome = server_tools.node_update(self.base, "", canvas_id="c1", node_id="n1")
        self.assertFalse(outcome["ok"])
        self.assertIn("至少提供", outcome["text"])

    def test_node_update_404_readable(self):
        outcome = server_tools.node_update(self.base, "", canvas_id="c1", node_id="missing", title="x")
        self.assertFalse(outcome["ok"])
        self.assertIn("HTTP 404", outcome["text"])
        self.assertIn("不存在", outcome["text"])

    def test_image_generate_is_async_and_returns_task(self):
        outcome = server_tools.image_generate(self.base, "", canvas_id="c1", prompt="一只猫")
        self.assertTrue(outcome["ok"], outcome)
        self.assertIn("task_1", outcome["text"])
        self.assertIn("node_img", outcome["text"])
        args = self.httpd.requests[-1]["body"]["args"]
        self.assertEqual(args["prompt"], "一只猫")
        self.assertEqual(args["canvas_id"], "c1")

    def test_image_generate_with_node_updates_prompt_first(self):
        outcome = server_tools.image_generate(self.base, "", canvas_id="c1", prompt="一只狗", node_id="n1")
        self.assertTrue(outcome["ok"], outcome)
        paths = [item["path"] for item in self.httpd.requests]
        self.assertEqual(paths, ["/api/agent/tools/update_node", "/api/agent/tools/generate_image"])
        self.assertEqual(self.httpd.requests[0]["body"]["args"]["prompt"], "一只狗")
        self.assertIn("已更新的节点=n1", outcome["text"])

    def test_image_generate_validation(self):
        self.assertFalse(server_tools.image_generate(self.base, "", canvas_id="c1", prompt="  ")["ok"])
        self.assertFalse(server_tools.image_generate(self.base, "", canvas_id="", prompt="x")["ok"])

    def test_timeout(self):
        outcome = server_tools.canvas_list(self.base + "/slow", timeout=0.3)
        self.assertFalse(outcome["ok"])
        self.assertIn("超时", outcome["text"])

    def test_unreachable(self):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        outcome = server_tools.canvas_list("http://127.0.0.1:%d" % port, timeout=1)
        self.assertFalse(outcome["ok"])
        self.assertIn("连不上", outcome["text"])

    def test_non_json_response(self):
        outcome = server_tools.canvas_list(self.base + "/badjson")
        self.assertFalse(outcome["ok"])
        self.assertIn("不是 JSON", outcome["text"])

    def test_canvas_create_request_and_result(self):
        outcome = server_tools.canvas_create(self.base, "", title="演示画布")
        self.assertTrue(outcome["ok"], outcome)
        self.assertEqual(outcome["data"]["canvas_id"], "c_new")
        self.assertIn("c_new", outcome["text"])
        request = self.httpd.requests[-1]
        self.assertEqual(request["method"], "POST")
        self.assertEqual(request["path"], "/api/canvases")
        self.assertEqual(request["body"], {"title": "演示画布"})

    def test_canvas_create_default_title(self):
        server_tools.canvas_create(self.base, "")
        self.assertEqual(self.httpd.requests[-1]["body"], {"title": "新画布"})

    def test_node_delete_request_and_result(self):
        outcome = server_tools.node_delete(self.base, "", canvas_id="c1", node_id="n1")
        self.assertTrue(outcome["ok"], outcome)
        self.assertIn("不可撤销", outcome["text"])
        request = self.httpd.requests[-1]
        self.assertEqual(request["path"], "/api/agent/tools/delete_node")
        self.assertEqual(request["body"]["args"], {"canvas_id": "c1", "node_id": "n1"})

    def test_node_delete_missing_node_maps_error(self):
        outcome = server_tools.node_delete(self.base, "", canvas_id="c1", node_id="missing")
        self.assertFalse(outcome["ok"])
        self.assertIn("HTTP 404", outcome["text"])
        self.assertIn("不存在", outcome["text"])

    def test_node_delete_requires_ids(self):
        outcome = server_tools.node_delete(self.base, "", canvas_id="", node_id="n1")
        self.assertFalse(outcome["ok"])
        self.assertIn("不能为空", outcome["text"])

    def test_dispatch_unknown_tool(self):
        outcome = server_tools.dispatch(self.base, "", "no_such_tool", {})
        self.assertFalse(outcome["ok"])
        self.assertIn("未知工具", outcome["text"])

    def test_dispatch_routes_known_tools(self):
        outcome = server_tools.dispatch(self.base, "", "novai_canvas_list", {"limit": 1})
        self.assertTrue(outcome["ok"], outcome)
        self.assertEqual(len(outcome["data"]["canvases"]), 1)
        created = server_tools.dispatch(self.base, "", "novai_canvas_create", {"title": "x"})
        self.assertTrue(created["ok"], created)
        deleted = server_tools.dispatch(self.base, "", "novai_node_delete",
                                        {"canvas_id": "c1", "node_id": "n1"})
        self.assertTrue(deleted["ok"], deleted)


if __name__ == "__main__":
    unittest.main()
