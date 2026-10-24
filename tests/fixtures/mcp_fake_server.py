#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测试用的 stdio MCP 服务（实现 initialize / tools/list / tools/call）。

用途：tests/test_mcp_client.py 与 tests/test_mcp_agent_integration.py 的夹具。
协议：一行一条 JSON（MCP stdio）；stdout 只写协议消息，日志一律走 stderr。

行为：
- initialize：拒绝 2025-03-26（触发客户端回退），只认 2024-11-05；
- notifications/initialized：记录，之后 echo 的返回里带 initialized=0/1（验证通知确实发了）；
- tools/list：两页共 2 个工具（echo：readOnlyHint=true；slow：无注解）；
- tools/call：echo 回显；slow 睡 5 秒（配合 timeout 测超时杀进程）；
- 其它方法：-32601。
"""
import json
import os
import sys
import time

SUPPORTED_VERSION = "2024-11-05"

STATE = {"initialized": False}


def _write(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _reply(request_id, result):
    _write({"jsonrpc": "2.0", "id": request_id, "result": result})


def _error(request_id, code, message):
    _write({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


TOOLS = [
    {
        "name": "echo",
        "description": "回显文本，附带 initialized 状态",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}},
                        "required": ["text"]},
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "slow",
        "description": "睡 5 秒再返回（用于超时测试）",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def handle(message):
    method = str(message.get("method") or "")
    request_id = message.get("id")
    if method == "initialize":
        params = message.get("params") or {}
        if params.get("protocolVersion") != SUPPORTED_VERSION:
            _error(request_id, -32602, "unsupported protocol version: %s" % params.get("protocolVersion"))
            return
        _reply(request_id, {"protocolVersion": SUPPORTED_VERSION,
                            "capabilities": {"tools": {"listChanged": False}},
                            "serverInfo": {"name": "fake-mcp", "version": "0.1"}})
        return
    if method == "notifications/initialized":
        STATE["initialized"] = True
        return
    if method == "tools/list":
        params = message.get("params") or {}
        cursor = params.get("cursor") or ""
        if cursor == "":
            _reply(request_id, {"tools": [TOOLS[0]], "nextCursor": "page2"})
        elif cursor == "page2":
            _reply(request_id, {"tools": [TOOLS[1]]})
        else:
            _error(request_id, -32602, "unknown cursor: %s" % cursor)
        return
    if method == "tools/call":
        params = message.get("params") or {}
        name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        if name == "echo":
            text = str(arguments.get("text") or "")
            _reply(request_id, {"content": [{"type": "text",
                                             "text": "echo: %s initialized=%d" % (text, 1 if STATE["initialized"] else 0)}],
                                "isError": False})
            return
        if name == "slow":
            time.sleep(5)
            _reply(request_id, {"content": [{"type": "text", "text": "slow done"}], "isError": False})
            return
        if name == "pid":
            _reply(request_id, {"content": [{"type": "text", "text": str(os.getpid())}], "isError": False})
            return
        if name == "fail":
            _reply(request_id, {"content": [{"type": "text", "text": "boom"}], "isError": True})
            return
        _error(request_id, -32602, "unknown tool: %s" % name)
        return
    _error(request_id, -32601, "method not found: %s" % method)


def main():
    sys.stderr.write("fake-mcp server started (pid %d)\n" % os.getpid())
    sys.stderr.flush()
    for line in sys.stdin.buffer:
        text = line.decode("utf-8", "replace").strip()
        if not text:
            continue
        try:
            message = json.loads(text)
        except Exception:
            _error(None, -32700, "parse error")
            continue
        if not isinstance(message, dict):
            _error(None, -32600, "invalid request")
            continue
        try:
            handle(message)
        except Exception as exc:               # 兜底：别让夹具自己崩
            _error(message.get("id"), -32603, "internal error: %s" % exc)


if __name__ == "__main__":
    main()
