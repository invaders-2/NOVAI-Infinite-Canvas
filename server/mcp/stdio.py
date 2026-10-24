#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP stdio 传输：起子进程、按行读写 JSON、initialize 握手、tools/list、tools/call。

握手顺序（MCP stdio）：
    initialize（协议版本本端先提 2025-03-26；被拒绝就回退 2024-11-05，最终采用服务端返回的版本）
    → notifications/initialized
    → tools/list（支持 cursor 翻页）
    → tools/call

约束：
- 单条消息上限 4MB（jsonrpc.MAX_MESSAGE_BYTES）；
- 读超时会杀掉子进程；任何情况下 finally 都会 terminate/wait，避免留孤儿进程；
- stderr 由后台线程收最近 20 行，报错时拼进异常信息，排查不用翻日志。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import os
import queue
import subprocess
import threading
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional

from server.mcp import jsonrpc
from server.mcp.config import DEFAULT_TIMEOUT


# 异常放在 errors.py（stdio / http 共用）；这里保留同名引用，历史 import 不受影响
from server.mcp.errors import McpError  # noqa: E402  (放在 import 段之后，避免循环)


class StdioTransport:
    """一个 MCP 服务的 stdio 管道：写 stdin、读 stdout（一行一条 JSON）。"""

    def __init__(self, server_name: str, command: str, args: Optional[List[str]] = None,
                 env: Optional[Dict[str, str]] = None, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.server_name = str(server_name or "")
        self.command = str(command or "")
        self.args = list(args or [])
        self.env_extra = dict(env or {})
        self.timeout = float(timeout or DEFAULT_TIMEOUT)
        self.process: Optional[subprocess.Popen] = None
        self.stderr_lines: Deque[str] = deque(maxlen=20)
        self._queue: "queue.Queue[Any]" = queue.Queue()
        self._stdout_thread: Optional[threading.Thread] = None
        self._stderr_thread: Optional[threading.Thread] = None
        self._closed = False

    # ---- 生命周期 ----

    def start(self) -> "StdioTransport":
        if self.process is not None:
            return self
        env = dict(os.environ)
        env.update({str(k): str(v) for k, v in self.env_extra.items()})
        try:
            self.process = subprocess.Popen(
                [self.command] + self.args,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                bufsize=0,
            )
        except Exception as exc:
            raise McpError("无法启动 MCP 服务 %s：%s" % (self.command, exc),
                           code="mcp_spawn_failed", server=self.server_name)
        self._stdout_thread = threading.Thread(target=self._pump_stdout, name="mcp-stdout-%s" % self.server_name)
        self._stdout_thread.daemon = True
        self._stdout_thread.start()
        self._stderr_thread = threading.Thread(target=self._pump_stderr, name="mcp-stderr-%s" % self.server_name)
        self._stderr_thread.daemon = True
        self._stderr_thread.start()
        return self

    def _pump_stdout(self) -> None:
        stream = self.process.stdout if self.process else None
        if stream is None:
            self._queue.put(("error", JsonRpcClosed("stdout 不可用")))
            return
        try:
            while True:
                line = stream.readline(jsonrpc.MAX_MESSAGE_BYTES + 1)
                if not line:
                    self._queue.put(("eof", None))
                    return
                if len(line) > jsonrpc.MAX_MESSAGE_BYTES and not line.endswith(b"\n"):
                    self._queue.put(("error", jsonrpc.JsonRpcTooLarge("服务端返回的消息超过 4MB")))
                    return
                self._queue.put(("line", line))
        except Exception as exc:                      # 进程被杀 / 管道关闭
            self._queue.put(("error", JsonRpcClosed("读取 stdout 失败：%s" % exc)))

    def _pump_stderr(self) -> None:
        stream = self.process.stderr if self.process else None
        if stream is None:
            return
        try:
            while True:
                line = stream.readline(8192)
                if not line:
                    return
                text = line.decode("utf-8", "replace").rstrip("\r\n")
                if text:
                    self.stderr_lines.append(text)
        except Exception:
            return

    # ---- 读写 ----

    def send_line(self, raw: bytes) -> None:
        if self._closed or not self.process or not self.process.stdin:
            raise jsonrpc.JsonRpcClosed("MCP 服务 %s 的连接已关闭" % self.server_name)
        try:
            self.process.stdin.write(raw)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise jsonrpc.JsonRpcClosed("写入 %s 失败：%s" % (self.server_name, exc))

    def read_line(self, timeout: Optional[float] = None) -> bytes:
        wait = self.timeout if timeout is None else float(timeout)
        try:
            kind, payload = self._queue.get(timeout=max(0.001, wait))
        except queue.Empty:
            raise jsonrpc.JsonRpcTimeout("等待 %s 输出超时（%.1fs）" % (self.server_name, wait))
        if kind == "line":
            return payload
        if kind == "eof":
            message = "MCP 服务 %s 已退出" % self.server_name
            tail = self.stderr_tail()
            if tail:
                message += "；stderr：%s" % " | ".join(tail[-3:])
            raise jsonrpc.JsonRpcClosed(message)
        if isinstance(payload, Exception):
            raise payload
        raise jsonrpc.JsonRpcClosed("MCP 服务 %s 读取失败" % self.server_name)

    def stderr_tail(self, limit: int = 20) -> List[str]:
        return list(self.stderr_lines)[-int(limit):]

    def close(self) -> None:
        """幂等清理：关 stdin → terminate → wait → kill；线程是 daemon，不会被它拖住。"""
        if self._closed:
            return
        self._closed = True
        process = self.process
        if process is None:
            return
        try:
            if process.stdin:
                try:
                    process.stdin.close()
                except Exception:
                    pass
        finally:
            if process.poll() is None:
                try:
                    process.terminate()
                except Exception:
                    pass
                try:
                    process.wait(timeout=2)
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
                    try:
                        process.wait(timeout=2)
                    except Exception:
                        pass
        for thread in (self._stdout_thread, self._stderr_thread):
            if thread is not None and thread.is_alive():
                thread.join(timeout=1)
        for stream in (process.stdout, process.stderr):
            try:
                if stream is not None:
                    stream.close()
            except Exception:
                pass


class StdioMcpSession:
    """一次 MCP 会话：连接 → 握手 → 列工具 / 调工具 → 关闭。用作上下文管理器最省心。"""

    def __init__(self, server: Dict[str, Any], timeout: Optional[float] = None,
                 protocol_version: str = jsonrpc.PROTOCOL_VERSION) -> None:
        self.server = dict(server or {})
        self.server_name = str(self.server.get("name") or "")
        self.command = str(self.server.get("command") or "")
        self.args = list(self.server.get("args") or [])
        self.env = dict(self.server.get("env") or {})
        self.timeout = float(timeout if timeout is not None else self.server.get("timeout") or DEFAULT_TIMEOUT)
        self.protocol_version = protocol_version
        self.negotiated_version = ""
        self.server_info: Dict[str, Any] = {}
        self.transport = StdioTransport(self.server_name, self.command, self.args, self.env, self.timeout)
        self.peer: Optional[jsonrpc.JsonRpcPeer] = None

    # ---- 生命周期 ----

    def __enter__(self) -> "StdioMcpSession":
        self.transport.start()
        self.peer = jsonrpc.JsonRpcPeer(self.transport, timeout=self.timeout)
        try:
            self.initialize()
        except Exception:
            self.close()
            raise
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.close()
        return False

    def close(self) -> None:
        self.transport.close()

    def stderr_tail(self) -> List[str]:
        return self.transport.stderr_tail()

    def _wrap(self, exc: Exception, action: str) -> McpError:
        if isinstance(exc, McpError):
            return exc
        tail = self.stderr_tail()
        message = "MCP %s 服务 %s 失败：%s" % (action, self.server_name, exc)
        if tail:
            message += "；stderr：%s" % " | ".join(tail[-3:])
        return McpError(message, code="mcp_%s_failed" % action, server=self.server_name, stderr=tail)

    # ---- 协议 ----

    def initialize(self) -> Dict[str, Any]:
        assert self.peer is not None
        params = {
            "protocolVersion": self.protocol_version,
            "capabilities": {"roots": {"listChanged": False}, "sampling": {}},
            "clientInfo": {"name": "novai", "version": "1.0"},
        }
        try:
            result = self.peer.request("initialize", params)
        except jsonrpc.JsonRpcError as first:
            if self.protocol_version == jsonrpc.FALLBACK_PROTOCOL_VERSION:
                raise self._wrap(first, "initialize")
            # 服务端不认新版本：按约定回退到 2024-11-05 再握一次
            params["protocolVersion"] = jsonrpc.FALLBACK_PROTOCOL_VERSION
            try:
                result = self.peer.request("initialize", params)
            except jsonrpc.JsonRpcError as second:
                raise self._wrap(second, "initialize")
        if not isinstance(result, dict):
            raise McpError("MCP %s 的 initialize 返回不是对象" % self.server_name,
                           code="mcp_initialize_failed", server=self.server_name,
                           stderr=self.stderr_tail())
        self.negotiated_version = str(result.get("protocolVersion") or jsonrpc.FALLBACK_PROTOCOL_VERSION)
        self.server_info = result.get("serverInfo") if isinstance(result.get("serverInfo"), dict) else {}
        self.peer.notify("notifications/initialized", {})
        return result

    def list_tools(self, max_pages: int = 50) -> List[Dict[str, Any]]:
        assert self.peer is not None
        tools: List[Dict[str, Any]] = []
        cursor = ""
        for _page in range(max(1, int(max_pages))):
            params = {"cursor": cursor} if cursor else {}
            try:
                result = self.peer.request("tools/list", params)
            except jsonrpc.JsonRpcError as exc:
                raise self._wrap(exc, "list")
            if not isinstance(result, dict):
                raise McpError("MCP %s 的 tools/list 返回不是对象" % self.server_name,
                               code="mcp_list_failed", server=self.server_name,
                               stderr=self.stderr_tail())
            page = result.get("tools")
            if isinstance(page, list):
                tools.extend([item for item in page if isinstance(item, dict)])
            next_cursor = result.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor:
                break
            cursor = next_cursor
        return tools

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        assert self.peer is not None
        try:
            result = self.peer.request("tools/call",
                                       {"name": str(name), "arguments": dict(arguments or {})})
        except jsonrpc.JsonRpcError as exc:
            raise self._wrap(exc, "call")
        if not isinstance(result, dict):
            raise McpError("MCP %s 的 tools/call 返回不是对象" % self.server_name,
                           code="mcp_call_failed", server=self.server_name,
                           stderr=self.stderr_tail())
        return result
