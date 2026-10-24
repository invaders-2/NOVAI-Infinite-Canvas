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

import os
import shutil
import subprocess
import sys
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from server.mcp import config, registry

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_SERVER_PY_NAME = "novai_mcp_server.py"
_DOCS_PATH = "docs/v2/MCP_SERVER.md"
_DEFAULT_PORT = 3000


def _server_port() -> int:
    """当前实际监听端口：main 启动时会把最终端口写回 NOVAI_PORT（含 --port 覆盖），没跑主程序时用默认 3000。"""
    raw = str(os.environ.get("NOVAI_PORT") or "").strip()
    try:
        port = int(raw)
    except (TypeError, ValueError):
        return _DEFAULT_PORT
    return port if 0 < port < 65536 else _DEFAULT_PORT


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


@router.get("/connect-info")
def mcp_connect_info() -> Dict[str, Any]:
    """画布「MCP 接入」入口卡的数据：全部从当前运行态与本地配置推导，不写死端口/路径。"""
    port = _server_port()
    base_url = "http://127.0.0.1:%d" % port
    server_py = os.path.join(_REPO_ROOT, _SERVER_PY_NAME)
    server_py = server_py if os.path.isfile(server_py) else ""
    command = sys.executable or "python3"
    server_entry = {
        "command": command,
        "args": [server_py] if server_py else [],
        "env": {"NOVAI_BASE_URL": base_url},
    }
    http_url = ""
    try:
        cfg = config.load_config()
        for server in (cfg.get("servers") or {}).values():
            if str(server.get("type") or "") == "http" and str(server.get("url") or "").strip():
                http_url = str(server.get("url") or "").strip()
                break
    except Exception:
        http_url = ""
    codex_command = "codex mcp add novai-canvas --env NOVAI_BASE_URL=%s -- %s %s" % (
        base_url, command, server_py)
    return {
        "enabled": registry.enabled(),
        "server_entry": server_entry,
        "mcp_servers_json": {"mcpServers": {"novai-canvas": server_entry}},
        "codex_command": codex_command,
        "http_url": http_url,
        "docs_path": _DOCS_PATH,
        "server_py": server_py,
        "base_url": base_url,
    }


# 本机可跳转的 Agent 清单（白名单；id → 展示信息）。检测只读：看 /Applications 下的 .app 与 PATH 里的 CLI。
_INSTALLED_APPS_DIR = "/Applications"
_DESKTOP_AGENTS = (
    {"id": "claude", "name": "Claude", "app": "Claude"},
    {"id": "chatgpt", "name": "ChatGPT", "app": "ChatGPT"},
    {"id": "workbuddy", "name": "WorkBuddy", "app": "WorkBuddy"},
)
_CLI_AGENTS = (
    {"id": "codex", "name": "Codex CLI", "command": "codex"},
    {"id": "claude-cli", "name": "Claude CLI", "command": "claude"},
)
_OPEN_AGENT_IDS = tuple(item["id"] for item in _DESKTOP_AGENTS) + tuple(item["id"] for item in _CLI_AGENTS)
_OPEN_AGENT_TIMEOUT = 10


def _desktop_agent_path(app: str) -> str:
    path = os.path.join(_INSTALLED_APPS_DIR, "%s.app" % app)
    return path if os.path.isdir(path) else ""


def _cli_agent_command(command: str) -> str:
    found = shutil.which(command)
    return found or ""


def _installed_agents() -> List[Dict[str, Any]]:
    agents: List[Dict[str, Any]] = []
    for item in _DESKTOP_AGENTS:
        path = _desktop_agent_path(item["app"])
        agents.append({"id": item["id"], "name": item["name"], "kind": "desktop",
                       "installed": bool(path), "path": path})
    for item in _CLI_AGENTS:
        command = _cli_agent_command(item["command"])
        agents.append({"id": item["id"], "name": item["name"], "kind": "cli",
                       "installed": bool(command), "command": command})
    return agents


class OpenAgentRequest(BaseModel):
    id: str = Field("", max_length=64)


@router.get("/installed-agents")
def mcp_installed_agents() -> Dict[str, Any]:
    """本机检测到的 Agent（只读：不启动任何进程）。"""
    return {"agents": _installed_agents()}


@router.post("/open-agent")
def mcp_open_agent(payload: OpenAgentRequest) -> Dict[str, Any]:
    """跳到本机已安装的 Agent：桌面端用 open -a 打开；CLI 只返回命令，不启动进程。

    安全：先做白名单校验（不拼接任何用户字符串），桌面端用 argv 调 subprocess，绝不 shell=True。
    """
    agent_id = str(payload.id or "").strip()
    if agent_id not in _OPEN_AGENT_IDS:
        raise HTTPException(status_code=400, detail="不支持的 Agent：%s" % (agent_id or "<空>"))
    for item in _DESKTOP_AGENTS:
        if item["id"] != agent_id:
            continue
        if not _desktop_agent_path(item["app"]):
            raise HTTPException(status_code=400, detail="未检测到本机安装：%s" % item["name"])
        argv = ["open", "-a", item["app"]]
        try:
            result = subprocess.run(argv, capture_output=True, text=True, timeout=_OPEN_AGENT_TIMEOUT)
        except Exception as exc:
            raise HTTPException(status_code=500, detail="打开 %s 失败：%s: %s" % (
                item["name"], type(exc).__name__, exc))
        if result.returncode != 0:
            stderr = str(result.stderr or "").strip()[:200] or "open 返回非 0"
            raise HTTPException(status_code=500, detail="打开 %s 失败：%s" % (item["name"], stderr))
        return {"ok": True, "action": "opened", "app": item["name"]}
    for item in _CLI_AGENTS:
        if item["id"] != agent_id:
            continue
        found = _cli_agent_command(item["command"])
        command = os.path.basename(found) if found else item["command"]
        return {"ok": True, "action": "command", "command": command}
    raise HTTPException(status_code=400, detail="不支持的 Agent：%s" % agent_id)


@router.post("/reload")
def mcp_reload() -> Dict[str, Any]:
    return registry.reload()
