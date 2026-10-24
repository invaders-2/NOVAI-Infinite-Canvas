#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""JSON-RPC 2.0（MCP 用）的最小实现：请求/响应/错误封装、id 自增、通知、消息上限。

MCP 的 stdio 传输是「一行一条 JSON」。这里只做协议层，不碰进程/管道（那是 stdio.py 的事）。
消息上限 4MB：超出的行直接报错，避免一条异常数据把内存吃光。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List, Optional

MAX_MESSAGE_BYTES = 4 * 1024 * 1024
# 本端倾向的新协议版本；服务端拒绝时回退到 2024-11-05（stdio 稳定版）
PROTOCOL_VERSION = "2025-03-26"
FALLBACK_PROTOCOL_VERSION = "2024-11-05"
JSONRPC_VERSION = "2.0"

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601


class JsonRpcError(Exception):
    """协议层错误。code/message/data 与 JSON-RPC 的 error 对象对应。"""

    def __init__(self, message: str, code: int = INVALID_REQUEST,
                 data: Any = None, rpc_method: str = "") -> None:
        super().__init__(message)
        self.message = str(message)
        self.code = int(code)
        self.data = data
        self.rpc_method = str(rpc_method or "")

    def __str__(self) -> str:
        return self.message


class JsonRpcTimeout(JsonRpcError):
    def __init__(self, message: str = "等待响应超时", rpc_method: str = "") -> None:
        super().__init__(message, code=-32000, rpc_method=rpc_method)


class JsonRpcClosed(JsonRpcError):
    def __init__(self, message: str = "连接已关闭", rpc_method: str = "") -> None:
        super().__init__(message, code=-32001, rpc_method=rpc_method)


class JsonRpcTooLarge(JsonRpcError):
    def __init__(self, message: str = "消息超过 4MB 上限") -> None:
        super().__init__(message, code=-32002)


def encode_message(message: Dict[str, Any]) -> bytes:
    """把一条消息编码成「一行 JSON + 换行」，并检查大小。"""
    raw = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_MESSAGE_BYTES:
        raise JsonRpcTooLarge("消息超过 %d 字节上限" % MAX_MESSAGE_BYTES)
    return raw + b"\n"


def decode_message(raw: bytes) -> Dict[str, Any]:
    """解析一行；只接受单个 JSON 对象（MCP 不用 batch）。"""
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if len(raw) > MAX_MESSAGE_BYTES:
        raise JsonRpcTooLarge()
    text = raw.decode("utf-8", "replace").strip()
    if not text:
        raise JsonRpcError("空消息", code=PARSE_ERROR)
    try:
        message = json.loads(text)
    except Exception as exc:
        raise JsonRpcError("不是合法 JSON：%s" % exc, code=PARSE_ERROR)
    if not isinstance(message, dict):
        raise JsonRpcError("只支持单条 JSON-RPC 消息", code=INVALID_REQUEST)
    return message


class JsonRpcPeer:
    """跑在某个 transport 上的 JSON-RPC 客户端。

    transport 需要两个方法：
        send_line(raw: bytes) -> None
        read_line(timeout: Optional[float]) -> bytes   （无数据时抛 JsonRpcTimeout，EOF 抛 JsonRpcClosed）
    """

    def __init__(self, transport: Any, timeout: float = 30.0,
                 max_notifications: int = 200) -> None:
        self.transport = transport
        self.timeout = float(timeout)
        self._next_id = 0
        self.notifications: List[Dict[str, Any]] = []
        self._max_notifications = int(max_notifications)

    def new_id(self) -> int:
        self._next_id += 1
        return self._next_id

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """发请求并等到匹配的响应；服务器在等待期间发来的通知/请求会被顺带处理。"""
        request_id = self.new_id()
        message: Dict[str, Any] = {"jsonrpc": JSONRPC_VERSION, "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self.transport.send_line(encode_message(message))
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise JsonRpcTimeout("等待 %s 响应超时（%.1fs）" % (method, self.timeout),
                                     rpc_method=method)
            raw = self.transport.read_line(remaining)
            incoming = decode_message(raw)
            if incoming.get("id") == request_id and ("result" in incoming or "error" in incoming):
                error = incoming.get("error")
                if isinstance(error, dict):
                    raise JsonRpcError(str(error.get("message") or "上游返回错误"),
                                       code=int(error.get("code") or -32000),
                                       data=error.get("data"), rpc_method=method)
                return incoming.get("result")
            if "method" in incoming:
                if "id" in incoming:
                    self._reject_server_request(incoming)
                else:
                    self._remember_notification(incoming)
                continue
            # 迟到的/不匹配的响应：忽略（超时兜底由 deadline 负责）

    def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        message: Dict[str, Any] = {"jsonrpc": JSONRPC_VERSION, "method": method}
        if params is not None:
            message["params"] = params
        self.transport.send_line(encode_message(message))

    def _reject_server_request(self, incoming: Dict[str, Any]) -> None:
        reply = {"jsonrpc": JSONRPC_VERSION, "id": incoming.get("id"),
                 "error": {"code": METHOD_NOT_FOUND,
                           "message": "客户端不支持服务端发起的请求：%s" % incoming.get("method")}}
        try:
            self.transport.send_line(encode_message(reply))
        except Exception:
            pass

    def _remember_notification(self, incoming: Dict[str, Any]) -> None:
        self.notifications.append(incoming)
        if len(self.notifications) > self._max_notifications:
            del self.notifications[:len(self.notifications) - self._max_notifications]
