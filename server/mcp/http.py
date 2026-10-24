#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP Streamable HTTP 传输（P1）：POST JSON-RPC 到 url，兼容 JSON 与 SSE 两种响应。

流程与 stdio 一致：initialize → notifications/initialized → tools/list（cursor 分页）→ tools/call。
差异：
- 每次请求都是 POST 到配置里的 url；
- 响应头出现 Mcp-Session-Id 时，后续请求都带这个头（服务端要求时也带 MCP-Protocol-Version）；
- 响应可能是 application/json，也可能是 text/event-stream（SSE）：按行解析 data:，跳过注释心跳，
  一帧可能是通知（忽略）、也可能是带 id 的响应（取它）；
- 非 200 带 HTTP 状态 + 响应体前 200 字；连不上与协议不匹配给不同错误码。

零新依赖：urllib.request + 标准库。Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from server.mcp import jsonrpc
from server.mcp.config import DEFAULT_TIMEOUT
from server.mcp.errors import McpError

MAX_SSE_FRAMES = 500
ERROR_BODY_CHARS = 200
SESSION_HEADER = "Mcp-Session-Id"
PROTOCOL_HEADER = "MCP-Protocol-Version"


class HttpMcpSession:
    """一个 Streamable HTTP 的 MCP 会话。上下文管理器负责握手/清理（HTTP 无进程可清）。"""

    def __init__(self, server: Dict[str, Any], timeout: Optional[float] = None,
                 protocol_version: str = jsonrpc.PROTOCOL_VERSION) -> None:
        self.server = dict(server or {})
        self.server_name = str(self.server.get("name") or "")
        self.url = str(self.server.get("url") or "").strip()
        self.user_headers = {str(k): str(v) for k, v in (self.server.get("headers") or {}).items()}
        self.timeout = float(timeout if timeout is not None else self.server.get("timeout") or DEFAULT_TIMEOUT)
        self.protocol_version = protocol_version
        self.negotiated_version = ""
        self.server_info: Dict[str, Any] = {}
        self.session_id = ""
        self._next_id = 0
        self.notifications: List[int] = []

    # ---- 生命周期 ----

    def __enter__(self) -> "HttpMcpSession":
        self._validate_url()
        self.initialize()
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False

    def close(self) -> None:
        """HTTP 无长连接，保留空实现让调用方代码统一。"""
        return None

    def _validate_url(self) -> None:
        parsed = urlparse(self.url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise McpError("MCP 服务 %s 的 url 不合法：%r" % (self.server_name, self.url),
                           code="mcp_config_invalid", server=self.server_name)

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        headers.update(self.user_headers)
        if self.session_id:
            headers[SESSION_HEADER] = self.session_id
        if self.negotiated_version:
            headers[PROTOCOL_HEADER] = self.negotiated_version
        return headers

    # ---- 协议 ----

    def initialize(self) -> Dict[str, Any]:
        params = {
            "protocolVersion": self.protocol_version,
            "capabilities": {"roots": {"listChanged": False}, "sampling": {}},
            "clientInfo": {"name": "novai", "version": "1.0"},
        }
        try:
            result = self._request("initialize", params)
        except jsonrpc.JsonRpcError as first:
            if self.protocol_version == jsonrpc.FALLBACK_PROTOCOL_VERSION:
                raise self._wrap(first, "initialize")
            params["protocolVersion"] = jsonrpc.FALLBACK_PROTOCOL_VERSION
            try:
                result = self._request("initialize", params)
            except jsonrpc.JsonRpcError as second:
                raise self._wrap(second, "initialize")
        if not isinstance(result, dict):
            raise McpError("MCP 服务 %s 的 initialize 返回不是对象" % self.server_name,
                           code="mcp_http_protocol", server=self.server_name)
        self.negotiated_version = str(result.get("protocolVersion") or jsonrpc.FALLBACK_PROTOCOL_VERSION)
        self.server_info = result.get("serverInfo") if isinstance(result.get("serverInfo"), dict) else {}
        self._notify("notifications/initialized", {})
        return result

    def list_tools(self, max_pages: int = 50) -> List[Dict[str, Any]]:
        tools: List[Dict[str, Any]] = []
        cursor = ""
        for _page in range(max(1, int(max_pages))):
            params = {"cursor": cursor} if cursor else {}
            result = self._request("tools/list", params)
            if not isinstance(result, dict):
                raise McpError("MCP 服务 %s 的 tools/list 返回不是对象" % self.server_name,
                               code="mcp_http_protocol", server=self.server_name)
            page = result.get("tools")
            if isinstance(page, list):
                tools.extend([item for item in page if isinstance(item, dict)])
            next_cursor = result.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor:
                break
            cursor = next_cursor
        return tools

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        result = self._request("tools/call", {"name": str(name), "arguments": dict(arguments or {})})
        if not isinstance(result, dict):
            raise McpError("MCP 服务 %s 的 tools/call 返回不是对象" % self.server_name,
                           code="mcp_http_protocol", server=self.server_name)
        return result

    def _wrap(self, exc: Exception, action: str) -> McpError:
        if isinstance(exc, McpError):
            return exc
        return McpError("MCP %s 服务 %s 失败：%s" % (action, self.server_name, exc),
                        code="mcp_%s_failed" % action, server=self.server_name)

    def _request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        self._next_id += 1
        request_id = self._next_id
        message: Dict[str, Any] = {"jsonrpc": jsonrpc.JSONRPC_VERSION, "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        response = self._post(message)
        if response is None:
            raise McpError("协议不匹配：MCP 服务 %s 对 %s 返回了空响应" % (self.server_name, method),
                           code="mcp_http_protocol", server=self.server_name)
        if response.get("id") not in (None, request_id):
            raise McpError("协议不匹配：MCP 服务 %s 的 %s 响应 id=%r 与请求 id=%d 不一致"
                           % (self.server_name, method, response.get("id"), request_id),
                           code="mcp_http_protocol", server=self.server_name)
        error = response.get("error")
        if isinstance(error, dict):
            raise jsonrpc.JsonRpcError(str(error.get("message") or "上游返回错误"),
                                       code=int(error.get("code") or -32000),
                                       data=error.get("data"), rpc_method=method)
        return response.get("result")

    def _notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        message: Dict[str, Any] = {"jsonrpc": jsonrpc.JSONRPC_VERSION, "method": method}
        if params is not None:
            message["params"] = params
        self._post(message, expect_response=False)

    # ---- HTTP ----

    def _post(self, message: Dict[str, Any], expect_response: bool = True) -> Optional[Dict[str, Any]]:
        body = json.dumps(message, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.url, data=body, headers=self._headers(), method="POST")
        try:
            response = urllib.request.urlopen(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            detail = _body_snippet(exc)
            code = "mcp_http_status"
            message_text = "MCP 服务 %s 返回 HTTP %d：%s" % (self.url, exc.code, detail)
            raise McpError(message_text, code=code, server=self.server_name)
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, (socket.timeout, TimeoutError)):
                raise McpError("MCP 服务 %s 请求超时（%.1fs）" % (self.url, self.timeout),
                               code="mcp_http_timeout", server=self.server_name)
            raise McpError("连不上 MCP 服务 %s（%s）" % (self.url, reason),
                           code="mcp_http_unreachable", server=self.server_name)
        except (socket.timeout, TimeoutError):
            raise McpError("MCP 服务 %s 请求超时（%.1fs）" % (self.url, self.timeout),
                           code="mcp_http_timeout", server=self.server_name)
        try:
            return self._read_response(response, expect_response)
        finally:
            try:
                response.close()
            except Exception:
                pass

    def _read_response(self, response: Any, expect_response: bool) -> Optional[Dict[str, Any]]:
        status = int(getattr(response, "status", None) or getattr(response, "code", None) or 200)
        headers = response.headers
        session_id = headers.get(SESSION_HEADER) if headers else None
        if session_id:
            self.session_id = str(session_id)
        content_type = str(headers.get("Content-Type") or "").lower() if headers else ""
        try:
            if "text/event-stream" in content_type:
                message = self._read_sse(response)
            else:
                raw = response.read(jsonrpc.MAX_MESSAGE_BYTES + 1)
                if len(raw) > jsonrpc.MAX_MESSAGE_BYTES:
                    raise McpError("协议不匹配：MCP 服务 %s 的响应超过 4MB" % self.server_name,
                                   code="mcp_http_protocol", server=self.server_name)
                message = self._parse_body(raw, status, content_type)
        except McpError:
            raise
        except (socket.timeout, TimeoutError):
            raise McpError("MCP 服务 %s 读取响应超时（%.1fs）" % (self.url, self.timeout),
                           code="mcp_http_timeout", server=self.server_name)
        except Exception as exc:
            raise McpError("MCP 服务 %s 读取响应失败：%s" % (self.url, exc),
                           code="mcp_http_protocol", server=self.server_name)
        if status >= 400:
            raise McpError("MCP 服务 %s 返回 HTTP %d：%s" % (self.url, status, _message_snippet(message)),
                           code="mcp_http_status", server=self.server_name)
        if not expect_response:
            return None
        return message

    def _parse_body(self, raw: bytes, status: int, content_type: str) -> Optional[Dict[str, Any]]:
        text = raw.decode("utf-8", "replace").strip()
        if not text:
            return None
        try:
            message = json.loads(text)
        except Exception:
            raise McpError("协议不匹配：MCP 服务 %s 返回的不是 JSON-RPC（HTTP %d，content-type=%r）：%s"
                           % (self.server_name, status, content_type, text[:ERROR_BODY_CHARS]),
                           code="mcp_http_protocol", server=self.server_name)
        if not isinstance(message, dict):
            raise McpError("协议不匹配：MCP 服务 %s 返回的不是单条 JSON-RPC 消息" % self.server_name,
                           code="mcp_http_protocol", server=self.server_name)
        return message

    def _read_sse(self, response: Any) -> Optional[Dict[str, Any]]:
        """按 SSE 规范读流：注释行（心跳）跳过，data: 累积到空行成一帧。"""
        data_lines: List[str] = []
        for _frame in range(MAX_SSE_FRAMES):
            raw_line = response.readline()
            if not raw_line:
                break
            line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
            if line == "":
                if not data_lines:
                    continue
                payload = "\n".join(data_lines)
                data_lines = []
                message = self._parse_body(payload.encode("utf-8"), 200, "text/event-stream")
                if message is None:
                    continue
                if "id" in message and ("result" in message or "error" in message):
                    return message
                # 通知/服务端请求：streamable HTTP 里客户端可忽略（P1 不做服务端回调）
                self.notifications.append(1)
                continue
            if line.startswith(":"):
                continue                      # 心跳/注释
            if line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            # event:/id:/retry: 字段本场景不需要
        raise McpError("协议不匹配：MCP 服务 %s 的 SSE 流里没有拿到 JSON-RPC 响应" % self.server_name,
                       code="mcp_http_protocol", server=self.server_name)


def _body_snippet(error: Any, limit: int = ERROR_BODY_CHARS) -> str:
    try:
        raw = error.read(4096)
    except Exception:
        return ""
    text = raw.decode("utf-8", "replace").strip().replace("\n", " ")
    return text[:limit]


def _message_snippet(message: Optional[Dict[str, Any]], limit: int = ERROR_BODY_CHARS) -> str:
    if not message:
        return ""
    text = json.dumps(message, ensure_ascii=False)
    return text[:limit]
