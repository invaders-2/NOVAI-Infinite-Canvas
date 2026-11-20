#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""主程序内置的 MCP stdio 服务：python3 main.py --mcp（打包后是 NOVAI --mcp）。

外部 Agent（Claude Desktop / Codex / Claude CLI / Kimi / Hermes / DSH 等）spawn 这条命令，
一行一条 JSON-RPC 走 stdin/stdout。stdout 只写协议 JSON，所有日志走 stderr。
默认连本机已运行的 NOVAI：NOVAI_BASE_URL，端口取 NOVAI_PORT（主程序启动时会回写实际端口），
都没给就按 3000。

为什么放在主程序里：安装版没打包 novai_mcp_server.py，_connect_info() 只能用 sys.executable，
打包后那就是应用主程序本身；不带 --mcp 会再起一个后端（端口冲突），协议也完全不对。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, Optional, Tuple

from server.mcp import protocol

DEFAULT_PORT = 3000
DEFAULT_TIMEOUT = 30.0


def _default_base_url() -> str:
    try:
        port = int(str(os.environ.get("NOVAI_PORT") or "").strip())
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    if not 0 < port < 65536:
        port = DEFAULT_PORT
    return "http://127.0.0.1:%d" % port


def _to_timeout(raw: Any, fallback: float = DEFAULT_TIMEOUT) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return fallback
    return value if value > 0 else fallback


def resolve_config(base_url: Optional[str] = None, token: Optional[str] = None,
                   timeout: Optional[float] = None) -> Tuple[str, str, float]:
    """显式入参 > 环境变量 > 默认值。环境变量每次调用时现读，方便测试与客户端覆盖。"""
    resolved_base = str(base_url or "").strip() or str(os.environ.get("NOVAI_BASE_URL") or "").strip()
    resolved_token = str(token or "").strip() or str(os.environ.get("NOVAI_API_TOKEN") or "").strip()
    if timeout is None:
        resolved_timeout = _to_timeout(os.environ.get("NOVAI_MCP_TIMEOUT"))
    else:
        resolved_timeout = _to_timeout(timeout)
    return (resolved_base or _default_base_url()), resolved_token, resolved_timeout


def _drain_line(stream: Any) -> None:
    """超长行：把这一行剩下的字节读完丢掉，避免下一轮读到半截 JSON。"""
    while True:
        chunk = stream.readline(protocol.MAX_INPUT_BYTES)
        if not chunk or chunk.endswith(b"\n"):
            return


def _write(response: Dict[str, Any]) -> bool:
    """一条响应一行，立即 flush；客户端提前断开时返回 False。"""
    try:
        text = json.dumps(response, ensure_ascii=False)
    except Exception as exc:                       # 兜底：序列化失败也只回一条错误，不崩进程
        protocol.log("序列化响应失败：%r" % (exc,))
        text = json.dumps(protocol._err(None, protocol.INTERNAL_ERROR, "内部错误：响应无法序列化"),
                          ensure_ascii=False)
    try:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()
        return True
    except (BrokenPipeError, ValueError):
        return False


def run_stdio(base_url: Optional[str] = None, token: Optional[str] = None,
              timeout: Optional[float] = None) -> int:
    """跑 stdio 服务直到 stdin EOF；返回进程退出码。"""
    resolved_base, resolved_token, resolved_timeout = resolve_config(base_url, token, timeout)
    protocol.log("stdio 启动：base_url=%s timeout=%s" % (resolved_base, resolved_timeout))
    stream = sys.stdin.buffer
    while True:
        try:
            raw = stream.readline(protocol.MAX_INPUT_BYTES + 1)
        except Exception as exc:
            protocol.log("读 stdin 失败：%r" % (exc,))
            return 1
        if not raw:
            break
        if len(raw) > protocol.MAX_INPUT_BYTES and not raw.endswith(b"\n"):
            _drain_line(stream)
            if not _write(protocol._err(None, protocol.INVALID_REQUEST, "输入超过 1MB 上限")):
                return 0
            continue
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            continue
        try:
            message = json.loads(text)
        except Exception as exc:
            if not _write(protocol._err(None, protocol.PARSE_ERROR, "不是合法 JSON：%s" % exc)):
                return 0
            continue
        try:
            if isinstance(message, list):
                response: Any = protocol._err(None, protocol.INVALID_REQUEST,
                                              "stdio 传输只支持单条 JSON-RPC 消息")
            else:
                response = protocol.build_response(message, resolved_base, resolved_token,
                                                   resolved_timeout)
        except Exception as exc:
            protocol.log("处理消息异常：%r" % (exc,))
            request_id = message.get("id") if isinstance(message, dict) else None
            response = protocol._err(request_id, protocol.INTERNAL_ERROR,
                                     "内部错误：%s: %s" % (type(exc).__name__, exc))
        if response is None:
            continue
        if not _write(response):
            return 0
    protocol.log("stdin 关闭，退出")
    return 0
