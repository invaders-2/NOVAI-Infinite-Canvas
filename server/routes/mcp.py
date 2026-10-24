#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP 服务管理接口（P0）。

契约：
    GET  /api/mcp/servers                     -> {enabled, servers:[{name, command, args, timeout, enabled,
                                                  env_keys, status, error, tool_count, tools:[{id,name,description,risk}]}]}
    POST /api/mcp/servers/{name}/enable       -> 必须带 {"confirm": true} 才落盘启用，返回 {ok, server}
    POST /api/mcp/servers/{name}/disable      -> 落盘停用（不需要 confirm），返回 {ok, server}
    POST /api/mcp/reload                      -> 清缓存并重新发现，返回 {enabled, servers}

enable / disable 的差异：
- enable 会真的启动外部进程/发起外部连接（有副作用），所以要 confirm: true 才落盘；
- disable 只是把配置里的 enabled 改成 false（立刻断开、之后不再连），没有副作用，因此不需要 confirm。
两者都写回配置文件，重启/重新加载后保持；disable 后 reload 仍是「未启用」，不会自己恢复。

开关口径：NOVAI_MCP_ENABLED=1 才启用；否则所有服务显示「未启用」，接口不连任何进程。
环境变量永远只返回键名（env_keys），不返回值。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.mcp import config, registry

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


class McpEnableRequest(BaseModel):
    confirm: bool = False


@router.get("/servers")
def mcp_list_servers(force: bool = False) -> Dict[str, Any]:
    return {"enabled": registry.enabled(), "servers": registry.servers_view(force=force)}


@router.post("/servers/{name}/enable")
def mcp_enable_server(name: str, payload: McpEnableRequest) -> Dict[str, Any]:
    server_name = str(name or "").strip()
    if not payload.confirm:
        raise HTTPException(status_code=400, detail="需要 confirm: true 才会真正启用 MCP 服务")
    cfg = config.load_config()
    server = cfg["servers"].get(server_name)
    if not server:
        raise HTTPException(status_code=404, detail="MCP 服务不存在：%s" % (server_name or "<空>"))
    try:
        config.set_server_enabled(server_name, True)
    except KeyError:
        raise HTTPException(status_code=404, detail="MCP 服务不存在：%s" % server_name)
    registry.reset_cache()
    rows = registry.servers_view(force=True)
    row = next((item for item in rows if item.get("name") == server_name), None)
    return {"ok": bool(row and row.get("status") == "就绪"), "server": row}


@router.post("/servers/{name}/disable")
def mcp_disable_server(name: str) -> Dict[str, Any]:
    """停用（持久化）。不需要 confirm：只是把 enabled 改 false 并断连，没有副作用。"""
    server_name = str(name or "").strip()
    cfg = config.load_config()
    if server_name not in cfg["servers"]:
        raise HTTPException(status_code=404, detail="MCP 服务不存在：%s" % (server_name or "<空>"))
    try:
        config.set_server_enabled(server_name, False)
    except KeyError:
        raise HTTPException(status_code=404, detail="MCP 服务不存在：%s" % server_name)
    registry.reset_cache()
    rows = registry.servers_view()
    row = next((item for item in rows if item.get("name") == server_name), None)
    if row is None:
        row = {"name": server_name, "enabled": False, "status": "未启用",
               "tool_count": 0, "tools": [], "error": ""}
    return {"ok": True, "server": row}


@router.post("/reload")
def mcp_reload() -> Dict[str, Any]:
    return registry.reload()
