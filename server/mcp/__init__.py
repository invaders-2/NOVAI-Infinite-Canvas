# -*- coding: utf-8 -*-
"""MCP client：stdio（P0）+ Streamable HTTP（P1）。

模块职责：
    config    读取/校验/脱敏配置（data/mcp_servers.json，NOVAI_MCP_CONFIG 可覆盖；type=stdio|http）
    jsonrpc   请求/响应/错误封装、id 自增、通知、单条消息 4MB 上限
    errors    McpError（两种传输共用）
    stdio     subprocess 传输：initialize 握手 → notifications/initialized → tools/list（cursor 翻页）→ tools/call
    http      Streamable HTTP 传输：POST JSON-RPC，兼容 JSON / SSE 两种响应，回传 Mcp-Session-Id
    registry  按需发现（缓存 60s）+ 工具映射（id/name/description/input_schema/risk）+ 按 type 分派调用
"""
from server.mcp import config, errors, http, jsonrpc, registry, stdio  # noqa: F401

__all__ = ["config", "errors", "http", "jsonrpc", "stdio", "registry"]
