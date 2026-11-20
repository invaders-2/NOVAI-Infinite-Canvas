#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP 服务管理接口（P0）。

契约：
    GET  /api/mcp/servers                     -> {enabled, env_override, config_path,
                                                  servers:[{name, command, args, timeout, enabled,
                                                  env_keys, status, error, tool_count, tools:[{id,name,description,risk}]}]}
    PUT  /api/mcp/servers/switch              -> 总开关落盘，body {enabled, confirm}，返回 {ok, enabled, env_override, servers}
    POST /api/mcp/servers                     -> 新增一条服务配置，返回 {ok, server}
    PUT  /api/mcp/servers/{name}              -> 覆盖/改名一条服务配置（body 缺 env/headers 时保留原值），返回 {ok, server}
    DELETE /api/mcp/servers/{name}            -> 删除一条服务配置，返回 {ok, deleted}
    POST /api/mcp/servers/{name}/enable       -> 必须带 {"confirm": true} 才落盘启用，返回 {ok, server}
    POST /api/mcp/servers/{name}/disable      -> 落盘停用（不需要 confirm），返回 {ok, server}
    POST /api/mcp/reload                      -> 清缓存并重新发现，返回 {enabled, servers}

enable / disable 的差异：
- enable 会真的启动外部进程/发起外部连接（有副作用），所以要 confirm: true 才落盘；
- disable 只是把配置里的 enabled 改成 false（立刻断开、之后不再连），没有副作用，因此不需要 confirm。
两者都写回配置文件，重启/重新加载后保持；disable 后 reload 仍是「未启用」，不会自己恢复。

开关口径：总开关默认关闭，可在设置里打开（落盘 <数据目录>/mcp_settings.json，重启保持）；
环境变量 NOVAI_MCP_ENABLED=on/off 显式给出时以环境变量为准，此时界面开关返回 409 被忽略。
总开关关着时所有服务显示「未启用」，接口不连任何进程。
环境变量永远只返回键名（env_keys），不返回值。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from typing import Any, Dict, List, Optional

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


class McpSwitchRequest(BaseModel):
    enabled: bool = False
    confirm: bool = False


@router.get("/servers")
def mcp_list_servers(force: bool = False) -> Dict[str, Any]:
    return {"enabled": registry.enabled(), "env_override": config.env_override(),
            "config_path": config.config_path(), "servers": registry.servers_view(force=force)}


@router.put("/servers/switch")
def mcp_switch(payload: McpSwitchRequest) -> Dict[str, Any]:
    """总开关：开启要 confirm（会真的去连外部进程），关闭不需要；返回落盘后的状态。"""
    if payload.enabled and not payload.confirm:
        raise HTTPException(status_code=400, detail="需要 confirm: true 才会开启 MCP 总开关")
    override = config.env_override()
    if override:
        raise HTTPException(
            status_code=409,
            detail=("MCP 总开关由环境变量 NOVAI_MCP_ENABLED=%s 控制，界面开关已忽略；"
                    "要改请先去掉该环境变量" % override))
    config.set_enabled(bool(payload.enabled))
    registry.reset_cache()
    return {"ok": True, "enabled": config.enabled(), "env_override": config.env_override(),
            "servers": registry.servers_view(force=False)}


def _server_payload() -> Dict[str, Any]:
    """读现有服务配置并返回可写的 payload；文件坏了先报 400，不静默覆盖用户配置。"""
    config.ensure_user_config()
    cfg = config.load_config()
    for item in cfg.get("errors") or []:
        if str(item.get("name") or "") == "<file>":
            raise HTTPException(status_code=400,
                                detail="现有 MCP 配置不可用：%s" % (item.get("error") or "无法读取"))
    payload = cfg.get("raw")
    if not isinstance(payload, dict):
        payload = {config.TOP_KEY: {}}
    servers = payload.get(config.TOP_KEY)
    if not isinstance(servers, dict):
        servers = {}
        payload[config.TOP_KEY] = servers
    return payload


def _disk_entry(server: Dict[str, Any]) -> Dict[str, Any]:
    """落盘用：name 是字典键，不重复写进条目。"""
    entry = dict(server)
    entry.pop("name", None)
    return entry


@router.post("/servers")
def mcp_create_server(payload: Dict[str, Any]) -> Dict[str, Any]:
    """新增一条服务配置（只写盘，不触发工具发现，避免顺手连进程）。"""
    name = str(payload.get("name") or "").strip()
    server, error = config.normalize_server(name, payload)
    if error:
        raise HTTPException(status_code=400, detail=error)
    body = _server_payload()
    servers = body[config.TOP_KEY]
    if name in servers:
        raise HTTPException(status_code=409, detail="MCP 服务已存在：%s" % name)
    servers[name] = _disk_entry(server)
    config.save_raw(body)
    registry.reset_cache()
    return {"ok": True, "server": config.redacted(server)}


@router.put("/servers/{name}")
def mcp_update_server(name: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """覆盖一条服务配置；body 的 name 和路径不同时等于改名（旧键删掉）。

    env / headers 缺省视为「保留原值」：GET 只回键名，编辑弹窗回填不了值，整条替换会把它们清空；
    要清空就显式传 {}。改名时按原路径名取旧值。
    """
    old_name = str(name or "").strip()
    body = _server_payload()
    servers = body[config.TOP_KEY]
    if old_name not in servers:
        raise HTTPException(status_code=404, detail="MCP 服务不存在：%s" % (old_name or "<空>"))
    new_name = str(payload.get("name") or old_name).strip()
    merged = dict(payload)
    existing = servers.get(old_name)
    if isinstance(existing, dict):
        for key in ("env", "headers"):
            if key not in payload and key in existing:
                merged[key] = existing[key]
    server, error = config.normalize_server(new_name, merged)
    if error:
        raise HTTPException(status_code=400, detail=error)
    servers.pop(old_name, None)
    servers[server["name"]] = _disk_entry(server)
    config.save_raw(body)
    registry.reset_cache()
    return {"ok": True, "server": config.redacted(server)}


@router.delete("/servers/{name}")
def mcp_delete_server(name: str) -> Dict[str, Any]:
    """删除一条服务配置（只写盘，不触发工具发现）。"""
    server_name = str(name or "").strip()
    body = _server_payload()
    servers = body[config.TOP_KEY]
    if server_name not in servers:
        raise HTTPException(status_code=404, detail="MCP 服务不存在：%s" % (server_name or "<空>"))
    servers.pop(server_name, None)
    config.save_raw(body)
    registry.reset_cache()
    return {"ok": True, "deleted": server_name}


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
    return _connect_info()


def _mcp_entry_args() -> List[str]:
    """MCP 客户端要 spawn 的参数：源码跑 main.py --mcp；打包后主程序自己认 --mcp。

    安装版没打包 novai_mcp_server.py，sys.executable 就是应用主程序，args 必须带 --mcp，
    否则客户端一调用就再起一个 NOVAI 后端（端口冲突，且根本不是 MCP 协议）。
    """
    if getattr(sys, "frozen", False):
        return ["--mcp"]
    main_py = os.path.join(_REPO_ROOT, "main.py")
    return [main_py, "--mcp"] if os.path.isfile(main_py) else []


def _shell_join(argv: List[str]) -> str:
    """给人复制的 shell 命令：逐段引用，空参数丢掉（避免拼出空参数）。"""
    return " ".join(shlex.quote(str(part)) for part in argv if str(part))


def _connect_info() -> Dict[str, Any]:
    port = _server_port()
    base_url = "http://127.0.0.1:%d" % port
    server_py = os.path.join(_REPO_ROOT, _SERVER_PY_NAME)
    server_py = server_py if os.path.isfile(server_py) else ""
    server_entry = {
        "command": sys.executable or "python3",
        "args": _mcp_entry_args(),
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
    codex_command = _shell_join(["codex", "mcp", "add", "novai-canvas",
                                 "--env", "NOVAI_BASE_URL=%s" % base_url, "--",
                                 server_entry["command"]] + list(server_entry["args"]))
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
    {"id": "kimi", "name": "Kimi Code", "app": "Kimi Code"},
    {"id": "dsh", "name": "DeepSeek Harness", "app": "DeepSeek Harness"},
)
_CLI_AGENTS = (
    {"id": "codex", "name": "Codex CLI", "command": "codex"},
    {"id": "claude-cli", "name": "Claude CLI", "command": "claude"},
    {"id": "hermes", "name": "Hermes CLI", "command": "hermes"},
)
_OPEN_AGENT_IDS = tuple(item["id"] for item in _DESKTOP_AGENTS) + tuple(item["id"] for item in _CLI_AGENTS)
_OPEN_AGENT_TIMEOUT = 10

_AGENT_LABELS = {item["id"]: item["name"] for item in _DESKTOP_AGENTS + _CLI_AGENTS}


def _desktop_agent_path(app: str) -> str:
    path = os.path.join(_INSTALLED_APPS_DIR, "%s.app" % app)
    return path if os.path.isdir(path) else ""


def _cli_agent_command(command: str) -> str:
    found = shutil.which(command)
    return found or ""


def _home_dir() -> str:
    return os.path.expanduser("~")


def _claude_config_path() -> str:
    return os.path.join(_home_dir(), "Library", "Application Support", "Claude",
                        "claude_desktop_config.json")


def _codex_config_path() -> str:
    return os.path.join(_home_dir(), ".codex", "config.toml")


def _workbuddy_config_path() -> str:
    return os.path.join(_home_dir(), ".workbuddy", "mcp.json")


def _kimi_config_path() -> str:
    return os.path.join(_home_dir(), ".kimi-code", "mcp.json")


def _claude_cli_config_path() -> str:
    return os.path.join(_home_dir(), ".claude.json")


def _hermes_config_path() -> str:
    return os.path.join(_home_dir(), ".hermes", "config.yaml")


_AGENT_CONFIG_PATHS = {
    "claude": _claude_config_path,
    "workbuddy": _workbuddy_config_path,
    "kimi": _kimi_config_path,
    "codex": _codex_config_path,
    "claude-cli": _claude_cli_config_path,
    "hermes": _hermes_config_path,
}

# 能一键写入的 id（按配置形态分派）；chatgpt / dsh 只能手动接，install-agent 返回 400 + 原因
_INSTALLABLE_AGENT_IDS = ("claude", "codex", "claude-cli", "workbuddy", "kimi", "hermes")
_MANUAL_AGENT_REASONS = {
    "chatgpt": "不支持自动写入配置",
    "dsh": "需要在 profile / Agent 预设里手动接入 MCP（不支持自动写入）",
}


def _agent_config_path(agent_id: str) -> str:
    getter = _AGENT_CONFIG_PATHS.get(agent_id)
    return getter() if getter else ""


def _read_text(path: str) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def _json_configured(path: str, label: str) -> Dict[str, Any]:
    """mcpServers 形态的 JSON（Claude / WorkBuddy / Kimi）配置检测。"""
    try:
        if not os.path.isfile(path):
            return {"configured": False, "configured_base_url": ""}
        payload = json.loads(_read_text(path))
    except Exception as exc:
        return {"configured": False, "configured_base_url": "",
                "reason": "读取 %s 配置失败：%s" % (label, exc)}
    servers = payload.get("mcpServers") if isinstance(payload, dict) else None
    entry = servers.get("novai-canvas") if isinstance(servers, dict) else None
    base_url = ""
    if isinstance(entry, dict):
        env = entry.get("env")
        if isinstance(env, dict):
            base_url = str(env.get("NOVAI_BASE_URL") or "").strip()
    return {"configured": isinstance(servers, dict) and "novai-canvas" in servers,
            "configured_base_url": base_url}


def _claude_configured() -> Dict[str, Any]:
    return _json_configured(_claude_config_path(), "Claude")


_CODEX_CONNECTION_RE = re.compile(
    r'mcp_servers\s*(?:\.\s*novai-canvas|\[\s*["\']?novai-canvas["\']?\s*\])')


_BASE_URL_RE = re.compile(r'NOVAI_BASE_URL\s*=\s*["\']([^"\']*)["\']')


def _codex_configured() -> Dict[str, Any]:
    path = _codex_config_path()
    try:
        if not os.path.isfile(path):
            return {"configured": False, "configured_base_url": ""}
        text = _read_text(path)
    except Exception as exc:
        return {"configured": False, "configured_base_url": "",
                "reason": "读取 Codex 配置失败：%s" % exc}
    match = _BASE_URL_RE.search(text)
    return {"configured": bool(_CODEX_CONNECTION_RE.search(text)),
            "configured_base_url": str(match.group(1) or "").strip() if match else ""}


# CLI 侧配置检测：claude mcp get / hermes mcp list。单次 3s 超时 + 30s 缓存，
# 总预算 4.5s（两个 CLI 都超时也不会把 /installed-agents 拖过 5s）。
_CLI_DETECT_TTL = 30.0
_CLI_DETECT_TIMEOUT = 3.0
_CLI_DETECT_BUDGET = 4.5
_CLI_DETECT_CACHE: Dict[str, Any] = {}
_BASE_URL_TEXT_RE = re.compile(r'NOVAI_BASE_URL\s*[=:]\s*["\']?([^"\'\s,}]+)')


def _reset_cli_detect_cache() -> None:
    _CLI_DETECT_CACHE.clear()


def _cli_configured(agent_id: str, command: str, probe_args: List[str],
                    deadline: float) -> Dict[str, Any]:
    if not command:
        return {"configured": False, "configured_base_url": ""}
    key = "%s|%s" % (agent_id, command)
    now = time.monotonic()
    cached = _CLI_DETECT_CACHE.get(key)
    if cached and now - cached[0] < _CLI_DETECT_TTL:
        return dict(cached[1])
    remaining = deadline - now
    if remaining <= 0:
        return {"configured": False, "configured_base_url": ""}
    try:
        result = subprocess.run([command] + list(probe_args), capture_output=True, text=True,
                                timeout=min(_CLI_DETECT_TIMEOUT, remaining))
        text = ((result.stdout or "") + (result.stderr or "")).strip()
        configured = result.returncode == 0 and "novai-canvas" in text
        match = _BASE_URL_TEXT_RE.search(text)
        outcome = {"configured": bool(configured),
                   "configured_base_url": str(match.group(1) or "").strip() if (configured and match) else ""}
    except Exception:
        outcome = {"configured": False, "configured_base_url": ""}
    _CLI_DETECT_CACHE[key] = (time.monotonic(), dict(outcome))
    return outcome


def _agent_configured(agent_id: str, command: str, deadline: float) -> Dict[str, Any]:
    if agent_id == "claude":
        return _claude_configured()
    if agent_id == "codex":
        return _codex_configured()
    if agent_id == "workbuddy":
        return _json_configured(_workbuddy_config_path(), "WorkBuddy")
    if agent_id == "kimi":
        return _json_configured(_kimi_config_path(), "Kimi Code")
    if agent_id == "claude-cli":
        return _cli_configured(agent_id, command, ["mcp", "get", "novai-canvas"], deadline)
    if agent_id == "hermes":
        return _cli_configured(agent_id, command, ["mcp", "list"], deadline)
    return {"configured": False, "configured_base_url": "",
            "reason": _MANUAL_AGENT_REASONS.get(agent_id, "不支持自动写入配置")}


def _installed_agents() -> List[Dict[str, Any]]:
    agents: List[Dict[str, Any]] = []
    deadline = time.monotonic() + _CLI_DETECT_BUDGET
    for item in _DESKTOP_AGENTS:
        path = _desktop_agent_path(item["app"])
        installed = bool(path)
        if not installed and item["id"] == "kimi":
            installed = bool(_cli_agent_command("kimi"))
        entry = {"id": item["id"], "name": item["name"], "kind": "desktop",
                 "installed": installed, "path": path,
                 "installable": item["id"] in _INSTALLABLE_AGENT_IDS,
                 "launchable": True,
                 "config_path": _agent_config_path(item["id"])}
        entry.update(_agent_configured(item["id"], "", deadline))
        agents.append(entry)
    for item in _CLI_AGENTS:
        command = _cli_agent_command(item["command"])
        entry = {"id": item["id"], "name": item["name"], "kind": "cli",
                 "installed": bool(command), "command": command,
                 "installable": item["id"] in _INSTALLABLE_AGENT_IDS,
                 "launchable": False,
                 "config_path": _agent_config_path(item["id"])}
        entry.update(_agent_configured(item["id"], command, deadline))
        agents.append(entry)
    return agents


class OpenAgentRequest(BaseModel):
    id: str = Field("", max_length=64)
    # Claude 官方深链的预填提示词；其它 Agent 忽略
    prompt: str = Field("", max_length=8000)


@router.get("/installed-agents")
def mcp_installed_agents() -> Dict[str, Any]:
    """本机检测到的 Agent（只读：桌面端不启动进程；CLI 只跑配置查询命令）。"""
    return {"agents": _installed_agents()}


def _claude_deep_link(prompt: str) -> str:
    """Claude Desktop 官方深链：新对话 + 预填输入框。提示词只进 q 查询参数，不拼 shell。"""
    return "claude://claude.ai/new?q=" + urllib.parse.quote(prompt, safe="")


def _open_url(url: str) -> bool:
    """用系统默认方式打开 URL；失败返回 False（调用方回退到 open -a）。"""
    try:
        if sys.platform == "darwin":
            result = subprocess.run(["open", url], capture_output=True, text=True,
                                    timeout=_OPEN_AGENT_TIMEOUT)
            return result.returncode == 0
        if sys.platform.startswith("win"):
            os.startfile(url)  # type: ignore[attr-defined]
            return True
        result = subprocess.run(["xdg-open", url], capture_output=True, text=True,
                                timeout=_OPEN_AGENT_TIMEOUT)
        return result.returncode == 0
    except Exception:
        return False


@router.post("/open-agent")
def mcp_open_agent(payload: OpenAgentRequest) -> Dict[str, Any]:
    """跳到本机已安装的 Agent：桌面端用 open -a 打开；CLI 只返回命令，不启动进程。

    安全：先做白名单校验（不拼接任何用户字符串），桌面端用 argv 调 subprocess，绝不 shell=True。
    Claude 带 prompt 时优先走官方深链把提示词预填进输入框；深链不可用再回退 open -a。
    """
    agent_id = str(payload.id or "").strip()
    if agent_id not in _OPEN_AGENT_IDS:
        raise HTTPException(status_code=400, detail="不支持的 Agent：%s" % (agent_id or "<空>"))
    prompt = str(payload.prompt or "")
    if not prompt.strip():
        prompt = ""
    if agent_id == "claude" and prompt:
        if _open_url(_claude_deep_link(prompt)):
            return {"ok": True, "action": "deep_link", "app": "Claude"}
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


# ---------------------------------------------------------------------------
# 一键写入 Agent 配置（路径全部写死，不接收任何路径参数）
# ---------------------------------------------------------------------------

_INSTALL_TIMEOUT = 20


class InstallAgentRequest(BaseModel):
    id: str = Field("", max_length=64)
    confirm: bool = False


def _atomic_write_text(path: str, text: str) -> None:
    """临时文件 + os.replace：写失败不会破坏原文件。"""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".novai-mcp-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _write_json_mcp_config(path: str, label: str) -> Dict[str, Any]:
    """把 novai-canvas 合并进 mcpServers：先备份、坏 JSON 不动原文件、原子写、幂等。"""
    entry = _connect_info()["server_entry"]
    backup = ""
    if os.path.isfile(path):
        try:
            backup = "%s.bak.%d" % (path, int(time.time()))
            shutil.copyfile(path, backup)
        except Exception as exc:
            raise HTTPException(status_code=500,
                                detail="备份 %s 配置失败（原文件未改动）：%s" % (label, exc))
        try:
            raw = _read_text(path)
        except Exception as exc:
            raise HTTPException(status_code=400,
                                detail="读取 %s 配置失败（原文件未改动）：%s" % (label, exc))
        try:
            payload = json.loads(raw)
        except Exception as exc:
            raise HTTPException(status_code=400,
                                detail="%s 配置不是合法 JSON（原文件未改动）：%s" % (label, exc))
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400,
                                detail="%s 配置顶层必须是对象（原文件未改动）" % label)
    else:
        payload = {}
    servers = payload.get("mcpServers")
    if servers is None:
        servers = {}
    if not isinstance(servers, dict):
        raise HTTPException(status_code=400,
                            detail="%s 配置里的 mcpServers 必须是对象（原文件未改动）" % label)
    existing = servers.get("novai-canvas")
    if (isinstance(existing, dict)
            and existing.get("command") == entry["command"]
            and existing.get("args") == entry["args"]
            and existing.get("env") == entry["env"]
            and existing.get("disabled") is not True):
        return {"ok": True, "action": "written", "path": path, "backup": backup,
                "already": True, "needs_restart": True}
    # 旧配置（旧端口 / disabled:true / 命令不对）要真的覆盖掉；entry 本身不带 disabled
    servers["novai-canvas"] = entry
    payload["mcpServers"] = servers
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    try:
        _atomic_write_text(path, text)
    except Exception as exc:
        raise HTTPException(status_code=500,
                            detail="写入 %s 配置失败（原文件未改动）：%s" % (label, exc))
    return {"ok": True, "action": "written", "path": path, "backup": backup,
            "already": False, "needs_restart": True}


def _agent_installed(agent_id: str) -> bool:
    for item in _DESKTOP_AGENTS:
        if item["id"] != agent_id:
            continue
        if _desktop_agent_path(item["app"]):
            return True
        return agent_id == "kimi" and bool(_cli_agent_command("kimi"))
    for item in _CLI_AGENTS:
        if item["id"] == agent_id:
            return bool(_cli_agent_command(item["command"]))
    return False


def _install_claude() -> Dict[str, Any]:
    if not _desktop_agent_path("Claude"):
        raise HTTPException(status_code=400, detail="未检测到本机安装：Claude")
    return _write_json_mcp_config(_claude_config_path(), "Claude")


def _install_json_agent(agent_id: str) -> Dict[str, Any]:
    label = _AGENT_LABELS[agent_id]
    if not _agent_installed(agent_id):
        raise HTTPException(status_code=400, detail="未检测到本机安装：%s" % label)
    return _write_json_mcp_config(_agent_config_path(agent_id), label)


def _run_agent_cli(label: str, argv: List[str], stdin_text: Optional[str] = None) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {}
    if stdin_text is not None:
        kwargs["input"] = stdin_text
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=_INSTALL_TIMEOUT,
                                **kwargs)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="写入 %s 配置失败：%s: %s" % (
            label, type(exc).__name__, exc))
    output = ((result.stdout or "") + (result.stderr or "")).strip()
    if result.returncode != 0:
        raise HTTPException(status_code=500,
                            detail="写入 %s 配置失败：%s" % (label, output[:200] or "命令返回非 0"))
    return {"ok": True, "action": "command", "output": output[:2000], "needs_restart": True}


def _install_codex() -> Dict[str, Any]:
    codex = _cli_agent_command("codex")
    if not codex:
        raise HTTPException(status_code=400, detail="未检测到本机安装：Codex CLI")
    info = _connect_info()
    command = info["server_entry"]["command"]
    args = list(info["server_entry"]["args"])
    if not args:
        raise HTTPException(status_code=400,
                            detail="仓库里找不到 main.py，无法生成 MCP 启动参数，未写入 Codex 配置")
    argv = [codex, "mcp", "add", "novai-canvas",
            "--env", "NOVAI_BASE_URL=%s" % info["base_url"],
            "--", command] + args
    return _run_agent_cli("Codex", argv)


def _install_claude_cli() -> Dict[str, Any]:
    claude = _cli_agent_command("claude")
    if not claude:
        raise HTTPException(status_code=400, detail="未检测到本机安装：Claude CLI")
    info = _connect_info()
    command = info["server_entry"]["command"]
    args = list(info["server_entry"]["args"])
    if not args:
        raise HTTPException(status_code=400,
                            detail="仓库里找不到 main.py，无法生成 MCP 启动参数，未写入 Claude CLI 配置")
    argv = [claude, "mcp", "add", "-s", "user", "novai-canvas",
            "-e", "NOVAI_BASE_URL=%s" % info["base_url"],
            "--", command] + args
    result = _run_agent_cli("Claude CLI", argv)
    _reset_cli_detect_cache()
    return result


def _install_hermes() -> Dict[str, Any]:
    hermes = _cli_agent_command("hermes")
    if not hermes:
        raise HTTPException(status_code=400, detail="未检测到本机安装：Hermes CLI")
    info = _connect_info()
    command = info["server_entry"]["command"]
    args = list(info["server_entry"]["args"])
    if not args:
        raise HTTPException(status_code=400,
                            detail="仓库里找不到 main.py，无法生成 MCP 启动参数，未写入 Hermes 配置")
    argv = [hermes, "mcp", "add", "novai-canvas", "--command", command,
            "--env", "NOVAI_BASE_URL=%s" % info["base_url"], "--args"] + args
    # hermes mcp add 是交互式的：连上之后会问「Enable all N tools?」，自动化要直接把 Y 喂进去
    result = _run_agent_cli("Hermes", argv, stdin_text="y\n")
    _reset_cli_detect_cache()
    return result


@router.post("/install-agent")
def mcp_install_agent(payload: InstallAgentRequest) -> Dict[str, Any]:
    """一键把 novai-canvas 写进本机 Agent 配置（JSON 类直接写，CLI 类走官方命令）。"""
    agent_id = str(payload.id or "").strip()
    if agent_id not in _INSTALLABLE_AGENT_IDS:
        reason = _MANUAL_AGENT_REASONS.get(agent_id)
        if reason:
            raise HTTPException(status_code=400, detail="%s：%s" % (
                _AGENT_LABELS.get(agent_id, agent_id), reason))
        raise HTTPException(status_code=400, detail="不支持的 Agent：%s" % (agent_id or "<空>"))
    if not payload.confirm:
        raise HTTPException(status_code=400, detail="需要 confirm: true 才会写入 Agent 配置")
    if agent_id == "claude":
        return _install_claude()
    if agent_id == "codex":
        return _install_codex()
    if agent_id == "claude-cli":
        return _install_claude_cli()
    if agent_id == "hermes":
        return _install_hermes()
    return _install_json_agent(agent_id)


@router.post("/reload")
def mcp_reload() -> Dict[str, Any]:
    return registry.reload()
