#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP 工具注册表：按需发现（缓存 60s）、工具映射、调用。

- 只有 NOVAI_MCP_ENABLED=1 才会真正连服务；否则一律返回空目录（避免误连）。
- 发现结果缓存 60 秒，可 POST /api/mcp/reload 手动刷新。
- 工具映射：能力 id = <server>.<tool>；模型可见名 = mcp__<server>__<tool>。
- risk 优先看 MCP 的 annotations（readOnlyHint / destructiveHint），缺省按关键词推断。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from server.mcp import config
from server.mcp.config import SERVER_TYPE_HTTP
from server.mcp.errors import McpError
from server.mcp.http import HttpMcpSession
from server.mcp.stdio import StdioMcpSession

CACHE_TTL = 60.0
AGENT_TOOL_PREFIX = "mcp__"
MAX_TEXT_CHARS = 20000
MAX_CONTENT_ITEMS = 50

HIGH_RISK_WORDS = ("delete", "drop", "destroy", "purge", "remove", "rm", "truncate", "revoke")
LOW_RISK_WORDS = ("get", "list", "search", "read", "fetch", "query", "info", "status", "describe",
                  "lookup", "find", "show", "head", "stat")
MEDIUM_RISK_WORDS = ("write", "create", "update", "set", "put", "append", "move", "copy", "rename",
                     "upload", "send", "post", "run", "execute", "apply", "patch", "insert", "add")

_lock = threading.RLock()
_cache: Dict[str, Any] = {"at": 0.0, "config_path": "", "entries": [], "servers": {}, "errors": []}


def enabled() -> bool:
    return config.env_enabled()


def reset_cache() -> None:
    with _lock:
        _cache["at"] = 0.0
        _cache["config_path"] = ""
        _cache["entries"] = []
        _cache["servers"] = {}
        _cache["errors"] = []


# ---------------------------------------------------------------------------
# 配置 → 服务状态
# ---------------------------------------------------------------------------

def _session_class(server: Dict[str, Any]):
    """按 server.type 分派传输：stdio（缺省）或 Streamable HTTP。"""
    if str(server.get("type") or "stdio") == SERVER_TYPE_HTTP:
        return HttpMcpSession
    return StdioMcpSession


def _empty_server_state(server: Dict[str, Any], status: str, error: str = "") -> Dict[str, Any]:
    state = config.redacted(server)
    state.update({"status": status, "error": str(error or ""), "tool_count": 0, "tools": []})
    return state


def _resolve_risk(tool: Dict[str, Any]) -> str:
    annotations = tool.get("annotations") if isinstance(tool.get("annotations"), dict) else {}
    if annotations.get("readOnlyHint") is True:
        return "low"
    if annotations.get("destructiveHint") is True:
        return "high"
    name = str(tool.get("name") or "").strip().lower()
    if any(word in name for word in HIGH_RISK_WORDS):
        return "high"
    if any(word in name for word in LOW_RISK_WORDS):
        return "low"
    if any(word in name for word in MEDIUM_RISK_WORDS):
        return "medium"
    return "medium"


def _build_entry(server_name: str, tool: Dict[str, Any]) -> Dict[str, Any]:
    tool_name = str(tool.get("name") or "").strip()
    description = str(tool.get("description") or "").strip()
    schema = tool.get("inputSchema") if isinstance(tool.get("inputSchema"), dict) else {"type": "object"}
    return {
        "id": "%s.%s" % (server_name, tool_name),
        "name": "%s%s__%s" % (AGENT_TOOL_PREFIX, server_name, tool_name),
        "server": server_name,
        "tool": tool_name,
        "description": description,
        "input_schema": schema,
        "risk": _resolve_risk(tool),
    }


def discover(force: bool = False) -> Dict[str, Any]:
    """发现所有已启用服务的工具。缓存 60s；force=True 强制重连。"""
    if not enabled():
        return {"enabled": False, "servers": {}, "entries": [], "errors": [], "at": 0.0}
    path = config.config_path()
    now = time.monotonic()
    with _lock:
        fresh = (not force and _cache.get("config_path") == path
                 and _cache.get("at") and now - float(_cache["at"]) < CACHE_TTL)
        if fresh:
            return {"enabled": True, "servers": dict(_cache["servers"]),
                    "entries": list(_cache["entries"]), "errors": list(_cache["errors"]),
                    "at": float(_cache["at"])}
    cfg = config.load_config()
    servers_state: Dict[str, Any] = {}
    entries: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = list(cfg.get("errors") or [])
    for name, server in cfg["servers"].items():
        if not server.get("enabled"):
            servers_state[name] = _empty_server_state(server, "未启用")
            continue
        try:
            with _session_class(server)(server) as session:
                tools = session.list_tools()
        except McpError as exc:
            servers_state[name] = _empty_server_state(server, "失败", exc.message)
            errors.append({"name": name, "error": exc.message})
            continue
        except Exception as exc:
            servers_state[name] = _empty_server_state(server, "失败", str(exc))
            errors.append({"name": name, "error": str(exc)})
            continue
        server_entries = [_build_entry(name, tool) for tool in tools if str(tool.get("name") or "").strip()]
        entries.extend(server_entries)
        state = _empty_server_state(server, "就绪")
        state["tool_count"] = len(server_entries)
        state["tools"] = [{"id": item["id"], "name": item["name"], "description": item["description"],
                           "risk": item["risk"]} for item in server_entries]
        servers_state[name] = state
    with _lock:
        _cache.update({"at": now, "config_path": path, "entries": entries,
                       "servers": servers_state, "errors": errors})
    return {"enabled": True, "servers": servers_state, "entries": entries, "errors": errors, "at": now}


def servers_view(force: bool = False) -> List[Dict[str, Any]]:
    """接口用：脱敏列表 + 状态。总开关关着时全部「未启用」。"""
    cfg = config.load_config()
    if not enabled():
        return [_empty_server_state(server, "未启用") for server in cfg["servers"].values()]
    discovered = discover(force=force)
    states = discovered.get("servers") or {}
    rows = []
    for name, server in cfg["servers"].items():
        state = states.get(name) or _empty_server_state(server, "未知")
        rows.append(state)
    for error in cfg.get("errors") or []:
        rows.append({"name": str(error.get("name") or ""), "status": "失败",
                     "error": str(error.get("error") or ""), "tool_count": 0, "tools": [],
                     "command": "", "args": [], "timeout": None, "enabled": False, "env_keys": []})
    return rows


def tool_entries() -> List[Dict[str, Any]]:
    if not enabled():
        return []
    return list(discover().get("entries") or [])


def agent_tool_entries() -> List[Dict[str, Any]]:
    """给 Agent 工具目录：{name, description, schema}。描述里带 server 前缀，方便模型挑。"""
    rows = []
    for entry in tool_entries():
        description = entry.get("description") or ""
        prefix = "MCP 服务 %s 提供的工具。" % entry["server"]
        rows.append({
            "name": entry["name"],
            "description": (prefix + description).strip(),
            "schema": entry["input_schema"],
            "risk": entry["risk"],
        })
    return rows


# ---------------------------------------------------------------------------
# 调用
# ---------------------------------------------------------------------------

def _truncate_text(text: str) -> str:
    text = str(text or "")
    if len(text) > MAX_TEXT_CHARS:
        return text[:MAX_TEXT_CHARS] + "…（已截断）"
    return text


def serialize_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """把 MCP tools/call 的返回收敛成可 JSON 序列化、可回灌模型的结构（超长文本截断）。"""
    out: Dict[str, Any] = {"isError": bool(result.get("isError")),
                           "content": [], "server_info": {}}
    content = result.get("content")
    if isinstance(content, list):
        for item in content[:MAX_CONTENT_ITEMS]:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("type") or "")
            if kind == "text":
                out["content"].append({"type": "text", "text": _truncate_text(item.get("text"))})
            elif kind == "resource":
                resource = item.get("resource") if isinstance(item.get("resource"), dict) else {}
                out["content"].append({"type": "resource",
                                       "uri": resource.get("uri"),
                                       "mimeType": resource.get("mimeType"),
                                       "text": _truncate_text(resource.get("text") or "")})
            else:
                out["content"].append({"type": kind or "unknown", "data": _truncate_text(item.get("data"))})
    elif content is not None:
        out["content"].append({"type": "text", "text": _truncate_text(content)})
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        raw = json.dumps(structured, ensure_ascii=False)
        if len(raw) > MAX_TEXT_CHARS:
            # 截断会破坏 JSON，宁可给「被截断」标记 + 预览，也不返回坏结构
            out["structuredContent"] = {"_truncated": True, "preview": raw[:MAX_TEXT_CHARS]}
        else:
            out["structuredContent"] = structured
    return out


def _result_text(serialized: Dict[str, Any]) -> str:
    parts = []
    for item in serialized.get("content") or []:
        if item.get("type") == "text" and item.get("text"):
            parts.append(str(item["text"]))
    return "\n".join(parts)


def find_entry(name: str) -> Optional[Dict[str, Any]]:
    key = str(name or "").strip()
    if not key:
        return None
    for entry in tool_entries():
        if entry["name"] == key or entry["id"] == key:
            return entry
    return None


def _server_config(server_name: str) -> Optional[Dict[str, Any]]:
    return config.load_config()["servers"].get(server_name)


def call_tool(name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """按 mcp__<server>__<tool>（或 <server>.<tool>）调用；每次新建连接（P0 简单可靠）。"""
    entry = find_entry(name)
    if not entry:
        return {"ok": False, "tool": str(name), "code": "unknown_tool",
                "error": "MCP 工具不存在或未启用：%s" % (name or "<空>")}
    server = _server_config(entry["server"])
    if not server:
        return {"ok": False, "tool": entry["name"], "code": "unknown_server",
                "error": "MCP 服务配置不存在：%s" % entry["server"]}
    try:
        with _session_class(server)(server) as session:
            raw = session.call_tool(entry["tool"], arguments or {})
    except McpError as exc:
        return {"ok": False, "tool": entry["name"], "code": exc.code, "error": exc.message}
    except Exception as exc:
        return {"ok": False, "tool": entry["name"], "code": "mcp_call_failed",
                "error": "%s: %s" % (type(exc).__name__, exc)}
    serialized = serialize_result(raw)
    is_error = bool(serialized.get("isError"))
    return {
        "ok": not is_error,
        "tool": entry["name"],
        "result": serialized,
        "message": _result_text(serialized) if is_error else "执行成功",
        "error": _result_text(serialized) if is_error else "",
        "code": "mcp_tool_error" if is_error else "",
    }


def execute_agent_step(tool_name: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """agent_execute_step 的 MCP 分支：返回同一套 {ok, tool, result/error, code} 契约。"""
    result = call_tool(tool_name, args or {})
    if result.get("ok"):
        return {"ok": True, "tool": result["tool"], "result": result.get("result"),
                "message": "执行成功"}
    return {"ok": False, "tool": result.get("tool") or tool_name,
            "error": result.get("error") or "MCP 调用失败",
            "code": result.get("code") or "mcp_call_failed", "status_code": 502}


def reload() -> Dict[str, Any]:
    """手动刷新：清缓存 + 重连发现，返回与接口同形状的结果。"""
    reset_cache()
    return {"enabled": enabled(), "servers": servers_view(force=True)}
