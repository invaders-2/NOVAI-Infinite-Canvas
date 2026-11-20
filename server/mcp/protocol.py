#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP 协议层：一条 JSON-RPC 消息 → 一条响应（stdio 与 Streamable HTTP 共用）。

从 novai_mcp_server.py 抽出来：主程序内置的 --mcp stdio 服务（server/mcp/stdio_entry.py）
与独立脚本（novai_mcp_server.py）共用同一份实现，避免两套协议逻辑漂移。
这里只碰消息，不碰 stdin/stdout/HTTP（那是传输层的事）。

协议口径（与重构前逐字一致）：
- 协议版本固定回 2024-11-05；
- 只接受单条 JSON-RPC 对象（dict）；通知（id=None）不回包；
- 未知方法 -32601；畸形 JSON -32700；单条输入上限 1MB；
- tools/call 结果统一 {content, isError, structuredContent?}。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import sys
from typing import Any, Dict, List, Optional

from server.mcp import server_tools

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
