#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOVAI MCP server（P2）：让外部 Agent（Claude Desktop / Codex 等）通过 MCP 调 NOVAI 的画布能力。

用法（stdio 传输，客户端自己 spawn 这个进程）：
    NOVAI_BASE_URL=http://127.0.0.1:8000 NOVAI_API_TOKEN=xxx python3 novai_mcp_server.py

它**不 import main**，而是通过 HTTP 调本机已运行的 NOVAI（默认 http://127.0.0.1:8000）：
    NOVAI_BASE_URL   可选，默认 http://127.0.0.1:8000
    NOVAI_API_TOKEN  可选，有就带 Authorization: Bearer <token>

协议：MCP stdio，一行一条 JSON-RPC（initialize / notifications/initialized / tools/list / tools/call）。
协议版本统一回 2024-11-05；未知方法 -32601；畸形 JSON -32700；单条输入上限 1MB。
工具实现放在 server/mcp/server_tools.py，本文件只做 stdio 循环与帧处理。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

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
    """日志只走 stderr（stdout 是协议通道）。"""
    try:
        sys.stderr.write("[novai-mcp] %s\n" % message)
        sys.stderr.flush()
    except Exception:
        pass


def write_message(message: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply(request_id: Any, result: Any) -> None:
    write_message({"jsonrpc": "2.0", "id": request_id, "result": result})


def reply_error(request_id: Any, code: int, message: str) -> None:
    write_message({"jsonrpc": "2.0", "id": request_id, "error": {"code": int(code), "message": str(message)}})


def handle_initialize(request_id: Any, params: Dict[str, Any]) -> None:
    requested = str(params.get("protocolVersion") or "")
    # 只保证 2024-11-05；客户端提别的版本也回落到它（不报错，客户端按返回值跑）
    version = PROTOCOL_VERSION if requested != PROTOCOL_VERSION else requested
    reply(request_id, {
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": SERVER_INFO,
    })


def handle_tools_call(request_id: Any, params: Dict[str, Any], base_url: str,
                      token: str, timeout: float) -> None:
    name = str(params.get("name") or "").strip()
    arguments = params.get("arguments")
    if not isinstance(arguments, dict):
        arguments = {}
    outcome = server_tools.dispatch(base_url, token, name, arguments, timeout=timeout)
    ok = bool(outcome.get("ok"))
    text = str(outcome.get("text") or ("" if ok else "工具执行失败"))
    result: Dict[str, Any] = {"content": [{"type": "text", "text": text}], "isError": not ok}
    data = outcome.get("data")
    if ok and isinstance(data, dict):
        result["structuredContent"] = data
    reply(request_id, result)


def handle_message(message: Dict[str, Any], base_url: str, token: str, timeout: float) -> None:
    request_id = message.get("id")
    method = str(message.get("method") or "")
    params = message.get("params")
    if not isinstance(params, dict):
        params = {}
    if not method:
        if request_id is not None:
            reply_error(request_id, INVALID_REQUEST, "缺少 method")
        return
    if request_id is None:
        # 通知：initialized / cancelled 等都不需要回包
        return
    if method == "initialize":
        return handle_initialize(request_id, params)
    if method == "ping":
        return reply(request_id, {})
    if method == "tools/list":
        return reply(request_id, {"tools": server_tools.TOOLS})
    if method == "tools/call":
        return handle_tools_call(request_id, params, base_url, token, timeout)
    return reply_error(request_id, METHOD_NOT_FOUND, "method not found: %s" % method)


def _drain_line(stream: Any) -> None:
    """超长行：把这一行剩下的字节读完丢掉，避免下一轮读到半截 JSON。"""
    while True:
        chunk = stream.readline(MAX_INPUT_BYTES)
        if not chunk or chunk.endswith(b"\n"):
            return


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="NOVAI MCP server（stdio）")
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
    log("启动：base_url=%s timeout=%s" % (base_url, timeout))

    stream = sys.stdin.buffer
    while True:
        raw = stream.readline(MAX_INPUT_BYTES + 1)
        if not raw:
            break
        if len(raw) > MAX_INPUT_BYTES and not raw.endswith(b"\n"):
            _drain_line(stream)
            reply_error(None, INVALID_REQUEST, "输入超过 1MB 上限")
            continue
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            continue
        try:
            message = json.loads(text)
        except Exception as exc:
            reply_error(None, PARSE_ERROR, "不是合法 JSON：%s" % exc)
            continue
        if not isinstance(message, dict):
            reply_error(None, INVALID_REQUEST, "只支持单条 JSON-RPC 消息")
            continue
        try:
            handle_message(message, base_url, token, timeout)
        except Exception as exc:               # 兜底：协议层异常也不能把进程带走
            log("处理消息异常：%r" % (exc,))
            reply_error(message.get("id"), INTERNAL_ERROR, "内部错误：%s: %s" % (type(exc).__name__, exc))
    log("stdin 关闭，退出")
    return 0


if __name__ == "__main__":
    sys.exit(main())
