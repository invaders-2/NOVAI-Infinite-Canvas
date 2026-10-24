#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOVAI MCP server（P2/P3）：让外部 Agent（Claude Desktop / Codex 等）通过 MCP 调 NOVAI 的画布能力。

用法：
    # stdio（客户端自己 spawn 这个进程）
    NOVAI_BASE_URL=http://127.0.0.1:8000 python3 novai_mcp_server.py
    # Streamable HTTP（独立起服务，POST JSON-RPC 到 /mcp）
    NOVAI_BASE_URL=http://127.0.0.1:8000 python3 novai_mcp_server.py --transport http --port 8765

它**不 import main**，而是通过 HTTP 调本机已运行的 NOVAI（默认 http://127.0.0.1:8000）：
    NOVAI_BASE_URL   可选，默认 http://127.0.0.1:8000
    NOVAI_API_TOKEN  可选，有就带 Authorization: Bearer <token>

协议：MCP（initialize / notifications/initialized / tools/list / tools/call）
    - stdio：一行一条 JSON-RPC；
    - http：POST {path} 接 JSON-RPC（单条或批量），返回 application/json，响应头带 Mcp-Session-Id；
      GET {path} 不支持服务端推送流（405，规范允许）；DELETE {path} 关闭会话（204）。
协议版本统一回 2024-11-05；未知方法 -32601；畸形 JSON -32700；单条输入上限 1MB。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法；只用标准库。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from server.mcp import server_tools  # noqa: E402

PROTOCOL_VERSION = "2024-11-05"
MAX_INPUT_BYTES = 1024 * 1024
SERVER_INFO = {"name": "novai-mcp-server", "version": "1.0"}

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603


def log(message: str) -> None:
    """日志只走 stderr（stdio 下 stdout 是协议通道）。"""
    try:
        sys.stderr.write("[novai-mcp] %s\n" % message)
        sys.stderr.flush()
    except Exception:
        pass


def _ok(request_id: Any, result: Any) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _err(request_id: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": int(code), "message": str(message)}}


def _tool_result(outcome: Dict[str, Any]) -> Dict[str, Any]:
    ok = bool(outcome.get("ok"))
    text = str(outcome.get("text") or ("" if ok else "工具执行失败"))
    result: Dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": not ok}
    data = outcome.get("data")
    if ok and isinstance(data, dict):
        result["structuredContent"] = data
    return result


def build_response(message: Any, base_url: str, token: str,
                   timeout: float) -> Optional[Dict[str, Any]]:
    """单条 JSON-RPC 消息 → 响应（通知返回 None）。stdio 与 http 共用这一份。"""
    if not isinstance(message, dict):
        return _err(None, INVALID_REQUEST, "只支持单条 JSON-RPC 消息")
    request_id = message.get("id")
    method = str(message.get("method") or "")
    params = message.get("params")
    if not isinstance(params, dict):
        params = {}
    if not method:
        return _err(request_id, INVALID_REQUEST, "缺少 method")
    if request_id is None:
        return None                                # 通知：不需要回包
    if method == "initialize":
        requested = str(params.get("protocolVersion") or "")
        version = PROTOCOL_VERSION if requested != PROTOCOL_VERSION else requested
        return _ok(request_id, {"protocolVersion": version,
                                "capabilities": {"tools": {"listChanged": False}},
                                "serverInfo": SERVER_INFO})
    if method == "ping":
        return _ok(request_id, {})
    if method == "tools/list":
        return _ok(request_id, {"tools": server_tools.TOOLS})
    if method == "tools/call":
        name = str(params.get("name") or "").strip()
        arguments = params.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        return _ok(request_id, _tool_result(
            server_tools.dispatch(base_url, token, name, arguments, timeout=timeout)))
    return _err(request_id, METHOD_NOT_FOUND, "method not found: %s" % method)


def build_batch(payload: Any, base_url: str, token: str,
                timeout: float) -> List[Dict[str, Any]]:
    """一条 POST body（单条或批量）→ 响应数组（通知不产生响应）。"""
    items = payload if isinstance(payload, list) else [payload]
    responses = []
    for item in items:
        try:
            response = build_response(item, base_url, token, timeout)
        except Exception as exc:
            log("处理消息异常：%r" % (exc,))
            request_id = item.get("id") if isinstance(item, dict) else None
            response = _err(request_id, INTERNAL_ERROR, "内部错误：%s: %s" % (type(exc).__name__, exc))
        if response is not None:
            responses.append(response)
    return responses


# ---------------------------------------------------------------------------
# stdio 传输
# ---------------------------------------------------------------------------

def _drain_line(stream: Any) -> None:
    """超长行：把这一行剩下的字节读完丢掉，避免下一轮读到半截 JSON。"""
    while True:
        chunk = stream.readline(MAX_INPUT_BYTES)
        if not chunk or chunk.endswith(b"\n"):
            return


def serve_stdio(base_url: str, token: str, timeout: float) -> int:
    stream = sys.stdin.buffer
    while True:
        raw = stream.readline(MAX_INPUT_BYTES + 1)
        if not raw:
            break
        if len(raw) > MAX_INPUT_BYTES and not raw.endswith(b"\n"):
            _drain_line(stream)
            sys.stdout.write(json.dumps(_err(None, INVALID_REQUEST, "输入超过 1MB 上限"),
                                        ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            continue
        try:
            message = json.loads(text)
        except Exception as exc:
            sys.stdout.write(json.dumps(_err(None, PARSE_ERROR, "不是合法 JSON：%s" % exc),
                                        ensure_ascii=False) + "\n")
            sys.stdout.flush()
            continue
        if isinstance(message, list):
            response: Any = _err(None, INVALID_REQUEST, "stdio 传输只支持单条 JSON-RPC 消息")
        else:
            try:
                response = build_response(message, base_url, token, timeout)
            except Exception as exc:
                log("处理消息异常：%r" % (exc,))
                response = _err(message.get("id") if isinstance(message, dict) else None,
                                INTERNAL_ERROR, "内部错误：%s: %s" % (type(exc).__name__, exc))
        if response is None:
            continue
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    log("stdin 关闭，退出")
    return 0


# ---------------------------------------------------------------------------
# Streamable HTTP 传输
# ---------------------------------------------------------------------------

class _McpHTTPHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        return

    def _send_json(self, status: int, payload: Any,
                   extra_headers: Optional[Dict[str, str]] = None) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else b""
        self.send_response(int(status))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Mcp-Session-Id", self.server.mcp_session_id)
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if raw:
            self.wfile.write(raw)
            self.wfile.flush()

    def _send_text(self, status: int, text: str,
                   extra_headers: Optional[Dict[str, str]] = None) -> None:
        raw = str(text or "").encode("utf-8")
        self.send_response(int(status))
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if raw:
            self.wfile.write(raw)
            self.wfile.flush()

    def _path_ok(self) -> bool:
        return urlsplit(self.path).path == self.server.mcp_path

    def do_POST(self):
        if not self._path_ok():
            return self._send_text(404, "not found")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length > MAX_INPUT_BYTES:
            return self._send_json(200, _err(None, INVALID_REQUEST, "输入超过 1MB 上限"))
        raw = self.rfile.read(length) if length > 0 else b""
        text = raw.decode("utf-8", "replace").strip()
        try:
            payload = json.loads(text) if text else None
        except Exception as exc:
            return self._send_json(200, _err(None, PARSE_ERROR, "不是合法 JSON：%s" % exc))
        if payload is None:
            return self._send_json(200, _err(None, INVALID_REQUEST, "空请求体"))
        responses = build_batch(payload, self.server.mcp_base_url, self.server.mcp_token,
                                self.server.mcp_timeout)
        if not responses:
            # 只有通知：规范要求 202 Accepted，无响应体
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.send_header("Mcp-Session-Id", self.server.mcp_session_id)
            self.end_headers()
            return None
        body: Any = responses if isinstance(payload, list) else responses[0]
        return self._send_json(200, body)

    def do_GET(self):
        if not self._path_ok():
            return self._send_text(404, "not found")
        return self._send_text(405, "GET 推送流暂不支持；请用 POST 发送 JSON-RPC。",
                               {"Allow": "POST, DELETE"})

    def do_DELETE(self):
        if not self._path_ok():
            return self._send_text(404, "not found")
        self.send_response(204)
        self.send_header("Mcp-Session-Id", self.server.mcp_session_id)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return None


class McpHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, base_url: str, token: str, timeout: float,
                 path: str, session_id: str):
        super().__init__(address, handler)
        self.mcp_base_url = base_url
        self.mcp_token = token
        self.mcp_timeout = timeout
        self.mcp_path = path
        self.mcp_session_id = session_id


def serve_http(base_url: str, token: str, timeout: float, host: str, port: int,
               path: str) -> int:
    session_id = "sess_" + uuid.uuid4().hex[:16]
    httpd = McpHTTPServer((host, int(port)), _McpHTTPHandler, base_url, token, timeout,
                          path, session_id)
    log("HTTP 传输已启动：http://%s:%d%s（Mcp-Session-Id=%s）" % (host, int(port), path, session_id))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        httpd.server_close()
    return 0


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="NOVAI MCP server（stdio / Streamable HTTP）")
    parser.add_argument("--transport", choices=("stdio", "http"), default="stdio",
                        help="传输方式，默认 stdio")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP 监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8765, help="HTTP 监听端口，默认 8765")
    parser.add_argument("--path", default="/mcp", help="HTTP 路径，默认 /mcp")
    parser.add_argument("--base-url", default=os.environ.get("NOVAI_BASE_URL", "http://127.0.0.1:8000"),
                        help="本机 NOVAI 的地址，默认 http://127.0.0.1:8000")
    parser.add_argument("--token", default=os.environ.get("NOVAI_API_TOKEN", ""),
                        help="可选，带 Authorization: Bearer <token>")
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("NOVAI_MCP_TIMEOUT", "30")),
                        help="单次 HTTP 调用的超时秒数，默认 30")
    args = parser.parse_args(argv)
    base_url = str(args.base_url or "").strip()
    token = str(args.token or "").strip()
    timeout = float(args.timeout or 30)
    if args.transport == "http":
        return serve_http(base_url, token, timeout, args.host, args.port,
                          str(args.path or "/mcp"))
    log("stdio 启动：base_url=%s timeout=%s" % (base_url, timeout))
    return serve_stdio(base_url, token, timeout)


if __name__ == "__main__":
    sys.exit(main())
