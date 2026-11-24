#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP 工具注册表：按需发现（缓存 60s）、工具映射、调用。

- 总开关关闭（config.enabled() 为假）时一律返回空目录（避免误连）。
- 发现结果缓存 60 秒，可 POST /api/mcp/reload 手动刷新。
- 工具映射：能力 id = <server>.<tool>；模型可见名 = mcp__<server>__<tool>。
- risk 优先看 MCP 的 annotations（readOnlyHint / destructiveHint），缺省按关键词推断。
- 除 tools 之外还收两样服务端主动给的东西（都不进 servers_view 的 HTTP 返回）：
  initialize 的 instructions（工作流硬规则，见 agent_instructions_block）与
  prompts/list 的模板（每个服务聚成一个 mcp__<server>__prompt 工具，见 _call_prompt）。

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
# 系统提示词里拼的服务端契约：单个 8000 字、最多 2 个服务（提示词有前缀缓存，别无限膨胀）
MAX_INSTRUCTIONS_CHARS = 8000
MAX_INSTRUCTIONS_SERVERS = 2
# 模板工具名的固定后缀：mcp__<server>__prompt
PROMPT_TOOL_SUFFIX = "__prompt"
MAX_PROMPT_DESCRIPTION_CHARS = 2000
# 30 字是实测值：Photoshop 的 24 个模板正好 1988 字，再长就要截断掉模板了
MAX_PROMPT_USAGE_CHARS = 30

HIGH_RISK_WORDS = ("delete", "drop", "destroy", "purge", "remove", "rm", "truncate", "revoke")
LOW_RISK_WORDS = ("get", "list", "search", "read", "fetch", "query", "info", "status", "describe",
                  "lookup", "find", "show", "head", "stat")
MEDIUM_RISK_WORDS = ("write", "create", "update", "set", "put", "append", "move", "copy", "rename",
                     "upload", "send", "post", "run", "execute", "apply", "patch", "insert", "add")

_lock = threading.RLock()
_cache: Dict[str, Any] = {"at": 0.0, "config_path": "", "entries": [], "servers": {}, "errors": [],
                           "instructions": {}, "prompts": {}}


def enabled() -> bool:
    return config.enabled()


def reset_cache() -> None:
    with _lock:
        _cache["at"] = 0.0
        _cache["config_path"] = ""
        _cache["entries"] = []
        _cache["servers"] = {}
        _cache["errors"] = []
        _cache["instructions"] = {}
        _cache["prompts"] = {}


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


def _collect_prompts(session: Any) -> List[Dict[str, Any]]:
    """发现阶段顺带收模板（只留必要字段）。任何失败都当没有：模板是增强项。"""
    try:
        raw = session.list_prompts()
    except Exception:
        return []
    rows: List[Dict[str, Any]] = []
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        arguments = []
        for arg in item.get("arguments") or []:
            if not isinstance(arg, dict):
                continue
            arg_name = str(arg.get("name") or "").strip()
            if not arg_name:
                continue
            arguments.append({"name": arg_name,
                              "description": str(arg.get("description") or "").strip(),
                              "required": bool(arg.get("required"))})
        rows.append({"name": name,
                     "description": str(item.get("description") or "").strip(),
                     "arguments": arguments})
    return rows


def _prompt_usage(text: str) -> str:
    """模板描述压成一句话：砍掉给人类看的「Users often say…」同义句（同一件事的复述），再限长。"""
    raw = " ".join(str(text or "").split())
    for marker in (" Users often say", " users often say"):
        cut = raw.find(marker)
        if cut > 0:
            raw = raw[:cut]
            break
    if len(raw) > MAX_PROMPT_USAGE_CHARS:
        raw = raw[:MAX_PROMPT_USAGE_CHARS].rstrip() + "…"
    return raw


def _build_prompt_entry(server_name: str, prompts: List[Dict[str, Any]]) -> Dict[str, Any]:
    """一个有模板的服务 → 一个 agent 工具。24 个模板也必须压进 2000 字，所以只留名字+一句话+参数名。"""
    lines = []
    for item in prompts:
        args = [arg["name"] for arg in item.get("arguments") or []]
        line = "- %s" % item["name"]
        usage = _prompt_usage(item.get("description") or "")
        if usage:
            line += "：" + usage
        if args:
            line += "（参数：%s）" % "、".join(args)
        lines.append(line)
    header = ("MCP 服务 %s 的任务模板（共 %d 个）：name 选模板、arguments 传参数，"
              "返回该模板展开的完整操作步骤；模板是服务端给的权威流程，照它做，不要自己另编一套。"
              % (server_name, len(prompts)))
    description = header + "\n" + "\n".join(lines)
    if len(description) > MAX_PROMPT_DESCRIPTION_CHARS:
        tail = "…（其余模板已省略）"
        description = description[:MAX_PROMPT_DESCRIPTION_CHARS - len(tail)] + tail
    return {
        "id": "%s.prompt" % server_name,
        "name": "%s%s%s" % (AGENT_TOOL_PREFIX, server_name, PROMPT_TOOL_SUFFIX),
        "server": server_name,
        "tool": "",
        "prompt": True,
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "enum": [item["name"] for item in prompts],
                         "description": "模板名，只能从这里选"},
                "arguments": {"type": "object", "description": "模板参数键值对，可省略"},
            },
            "required": ["name"],
        },
        "risk": "low",
    }


def is_prompt_tool(tool_name: str) -> bool:
    """模板工具只把服务端模板展开成文本、没有副作用，所以不进 agent 的确认闸门。"""
    name = str(tool_name or "").strip()
    return name.startswith(AGENT_TOOL_PREFIX) and name.endswith(PROMPT_TOOL_SUFFIX)


def discover(force: bool = False) -> Dict[str, Any]:
    """发现所有已启用服务的工具。缓存 60s；force=True 强制重连。"""
    if not enabled():
        return {"enabled": False, "servers": {}, "entries": [], "errors": [], "at": 0.0,
                "instructions": {}, "prompts": {}}
    path = config.config_path()
    now = time.monotonic()
    with _lock:
        fresh = (not force and _cache.get("config_path") == path
                 and _cache.get("at") and now - float(_cache["at"]) < CACHE_TTL)
        if fresh:
            return {"enabled": True, "servers": dict(_cache["servers"]),
                    "entries": list(_cache["entries"]), "errors": list(_cache["errors"]),
                    "at": float(_cache["at"]),
                    "instructions": dict(_cache.get("instructions") or {}),
                    "prompts": dict(_cache.get("prompts") or {})}
    cfg = config.load_config()
    servers_state: Dict[str, Any] = {}
    entries: List[Dict[str, Any]] = []
    errors: List[Dict[str, str]] = list(cfg.get("errors") or [])
    instructions: Dict[str, str] = {}
    prompts_by_server: Dict[str, Any] = {}
    for name, server in cfg["servers"].items():
        if not server.get("enabled"):
            servers_state[name] = _empty_server_state(server, "未启用")
            continue
        try:
            with _session_class(server)(server) as session:
                tools = session.list_tools()
                server_instructions = str(getattr(session, "instructions", "") or "").strip()
                server_prompts = _collect_prompts(session)
        except McpError as exc:
            servers_state[name] = _empty_server_state(server, "失败", exc.message)
            errors.append({"name": name, "error": exc.message})
            continue
        except Exception as exc:
            servers_state[name] = _empty_server_state(server, "失败", str(exc))
            errors.append({"name": name, "error": str(exc)})
            continue
        if server_instructions:
            instructions[name] = server_instructions
        server_entries = [_build_entry(name, tool) for tool in tools if str(tool.get("name") or "").strip()]
        entries.extend(server_entries)
        state = _empty_server_state(server, "就绪")
        state["tool_count"] = len(server_entries)
        state["tools"] = [{"id": item["id"], "name": item["name"], "description": item["description"],
                           "risk": item["risk"]} for item in server_entries]
        servers_state[name] = state
        # 模板工具也进 entries（agent 目录与执行都走同一张表），但不进 state["tools"]：
        # 那个列表是「这个服务有哪些工具」的界面视图，塞个虚拟工具进去会让人误解
        if server_prompts:
            prompts_by_server[name] = server_prompts
            entries.append(_build_prompt_entry(name, server_prompts))
    with _lock:
        _cache.update({"at": now, "config_path": path, "entries": entries,
                       "servers": servers_state, "errors": errors,
                       "instructions": instructions, "prompts": prompts_by_server})
    return {"enabled": True, "servers": servers_state, "entries": entries, "errors": errors, "at": now,
            "instructions": instructions, "prompts": prompts_by_server}


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
        if entry.get("prompt"):
            # 模板工具的描述自己写清了来源与模板清单，再加前缀只会白占长度
            rows.append({"name": entry["name"], "description": description,
                         "schema": entry["input_schema"], "risk": entry["risk"]})
            continue
        prefix = "MCP 服务 %s 提供的工具。" % entry["server"]
        rows.append({
            "name": entry["name"],
            "description": (prefix + description).strip(),
            "schema": entry["input_schema"],
            "risk": entry["risk"],
        })
    return rows


def agent_instructions_block() -> str:
    """把服务端 initialize 里自带的操作契约拼成系统提示词追加段（没有货就返回空串）。

    总开关关着、发现失败、服务端没给 instructions 一律空串：调用方可以无条件拼，
    拼不拼到东西只取决于有没有真契约，MCP 没开时提示词逐字不变。
    """
    if not enabled():
        return ""
    try:
        discovered = discover()
    except Exception:
        return ""
    instructions = discovered.get("instructions") or {}
    blocks: List[str] = []
    for name, raw in instructions.items():
        text = str(raw or "").strip()
        if not text:
            continue
        if len(blocks) >= MAX_INSTRUCTIONS_SERVERS:
            break
        if len(text) > MAX_INSTRUCTIONS_CHARS:
            text = text[:MAX_INSTRUCTIONS_CHARS] + "\n…（已截断）"
        blocks.append("【MCP 服务「%s」自带的操作契约（优先遵守，和上面的通用规则冲突时以它为准）】\n%s"
                      % (name, text))
    return "\n\n".join(blocks)


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


def _prompt_result_text(result: Dict[str, Any]) -> str:
    """prompts/get 的 messages → 一段文本（模板本来就是给模型看的操作步骤）。"""
    parts: List[str] = []
    messages = result.get("messages")
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        for item in content if isinstance(content, list) else [content]:
            if isinstance(item, str):
                if item.strip():
                    parts.append(item)
                continue
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if text:
                parts.append(text)
                continue
            resource = item.get("resource") if isinstance(item.get("resource"), dict) else {}
            uri = str(item.get("uri") or resource.get("uri") or "").strip()
            if uri:
                parts.append("[附件：%s]" % uri)
    if not parts:
        description = str(result.get("description") or "").strip()
        if description:
            parts.append(description)
    return "\n".join(parts).strip()


def _call_prompt(entry: Dict[str, Any], server: Dict[str, Any],
                 arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """mcp__<server>__prompt 的执行：prompts/get → 文本，结果形状与 tools/call 完全一致。"""
    raw = arguments if isinstance(arguments, dict) else {}
    prompt_name = str(raw.get("name") or "").strip()
    prompt_args = raw.get("arguments") if isinstance(raw.get("arguments"), dict) else {}
    if not prompt_name:
        return {"ok": False, "tool": entry["name"], "code": "invalid_args",
                "error": "缺少模板名 name；可选项见工具参数 name 的 enum"}
    try:
        with _session_class(server)(server) as session:
            result = session.get_prompt(prompt_name, prompt_args)
    except McpError as exc:
        return {"ok": False, "tool": entry["name"], "code": exc.code, "error": exc.message}
    except Exception as exc:
        return {"ok": False, "tool": entry["name"], "code": "mcp_prompt_failed",
                "error": "%s: %s" % (type(exc).__name__, exc)}
    text = _prompt_result_text(result)
    if not text:
        return {"ok": False, "tool": entry["name"], "code": "mcp_prompt_empty",
                "error": "MCP 服务 %s 的模板 %s 没有返回文本内容" % (entry["server"], prompt_name)}
    return {"ok": True, "tool": entry["name"],
            "result": serialize_result({"content": [{"type": "text", "text": text}], "isError": False}),
            "message": "执行成功", "error": "", "code": ""}


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
    if entry.get("prompt"):
        return _call_prompt(entry, server, arguments)
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
