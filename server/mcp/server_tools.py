#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP server 方向的工具层：通过 HTTP 调本机 NOVAI 的 REST 接口（不 import main）。

设计：
- 每个工具都是「纯函数 + 显式参数」：base_url / token 由调用方传入，方便单测；
- 返回值统一是 {"ok": bool, "text": str, "data": Any}，不抛异常（网络/HTTP/JSON 错误都收敛成 ok=False + 可读文案）；
- 只做 P2 的 5 个轻量工具，全部幂等或可安全重试（生图是异步触发，不等结果）。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_TIMEOUT = 30.0
DEFAULT_LIMIT = 20
MAX_LIMIT = 200
BODY_CHARS = 200
USER_AGENT = "novai-mcp-server/1.0"


def _result(ok: bool, text: str, data: Any = None) -> Dict[str, Any]:
    return {"ok": bool(ok), "text": str(text), "data": data}


def _base(base_url: str) -> str:
    return str(base_url or "").strip().rstrip("/")


def _http(method: str, base_url: str, path: str, token: str = "",
          payload: Optional[Dict[str, Any]] = None,
          timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    """发一次 JSON 请求，返回 {ok, status, body, error}；错误也当数据返回，不抛。"""
    url = _base(base_url) + path
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer %s" % token
    request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = int(getattr(response, "status", 200) or 200)
            raw = response.read()
            return {"ok": status < 400, "status": status, "body": raw, "error": ""}
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read()
        except Exception:
            raw = b""
        return {"ok": False, "status": int(exc.code), "body": raw, "error": ""}
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return {"ok": False, "status": 0, "body": b"", "error": "请求 NOVAI 超时（%.1fs）" % timeout}
        return {"ok": False, "status": 0, "body": b"",
                "error": "连不上 NOVAI（%s）：%s" % (_base(base_url), reason)}
    except (socket.timeout, TimeoutError):
        return {"ok": False, "status": 0, "body": b"", "error": "请求 NOVAI 超时（%.1fs）" % timeout}
    except Exception as exc:
        return {"ok": False, "status": 0, "body": b"", "error": "请求 NOVAI 失败：%s" % exc}


def _decode(response: Dict[str, Any]) -> Tuple[Optional[Any], str]:
    """把 _http 的 body 解成 JSON；失败返回 (None, 可读错误)。"""
    raw = response.get("body") or b""
    text = raw.decode("utf-8", "replace").strip() if isinstance(raw, (bytes, bytearray)) else str(raw)
    if not text:
        return None, ""
    try:
        return json.loads(text), ""
    except Exception:
        return None, text[:BODY_CHARS]


def _error_from(response: Dict[str, Any]) -> str:
    """HTTP 错误 → 可读文案（优先取 FastAPI 的 detail.message / detail）。"""
    if response.get("error"):
        return str(response["error"])
    payload, snippet = _decode(response)
    status = int(response.get("status") or 0)
    detail = ""
    if isinstance(payload, dict):
        raw_detail = payload.get("detail")
        if isinstance(raw_detail, dict):
            detail = str(raw_detail.get("message") or raw_detail.get("error") or "")
        elif raw_detail is not None:
            detail = str(raw_detail)
        if not detail:
            detail = str(payload.get("error") or "")
    if not detail:
        detail = snippet or "无响应体"
    return "NOVAI 返回 HTTP %d：%s" % (status, detail[:BODY_CHARS])


def _ok_text(payload: Any, fallback: str) -> Tuple[str, Any]:
    if isinstance(payload, dict):
        return fallback, payload
    return fallback, payload


# ---------------------------------------------------------------------------
# 工具 1：列画布
# ---------------------------------------------------------------------------

def canvas_list(base_url: str, token: str = "", limit: Optional[int] = None,
                timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    if limit is None:
        limit_value = DEFAULT_LIMIT
    else:
        try:
            limit_value = int(limit)
        except (TypeError, ValueError):
            return _result(False, "limit 必须是整数")
        if limit_value < 1:
            return _result(False, "limit 必须 >= 1")
    limit_value = min(limit_value, MAX_LIMIT)
    response = _http("GET", base_url, "/api/canvases", token, timeout=timeout)
    if not response.get("ok"):
        return _result(False, _error_from(response))
    payload, snippet = _decode(response)
    if not isinstance(payload, dict):
        return _result(False, "NOVAI 返回的不是 JSON：%s" % (snippet or "空响应"))
    rows = []
    for item in (payload.get("canvases") or [])[:limit_value]:
        if not isinstance(item, dict):
            continue
        rows.append({"id": item.get("id"), "title": item.get("title"),
                     "updated_at": item.get("updated_at"), "kind": item.get("kind")})
    lines = ["共 %d 个画布（显示前 %d 个）：" % (len(rows), limit_value)]
    for row in rows:
        lines.append("- %s | %s | 更新: %s" % (row["id"], row["title"] or "(未命名)", row["updated_at"]))
    return _result(True, "\n".join(lines) if rows else "没有画布", {"canvases": rows})


# ---------------------------------------------------------------------------
# 工具 2：画布结构摘要
# ---------------------------------------------------------------------------

def canvas_get(base_url: str, token: str = "", canvas_id: str = "",
               timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    canvas_id = str(canvas_id or "").strip()
    if not canvas_id:
        return _result(False, "canvas_id 不能为空")
    response = _http("GET", base_url, "/api/canvases/%s" % urllib.parse.quote(canvas_id),
                     token, timeout=timeout)
    if not response.get("ok"):
        return _result(False, _error_from(response))
    payload, snippet = _decode(response)
    if not isinstance(payload, dict):
        return _result(False, "NOVAI 返回的不是 JSON：%s" % (snippet or "空响应"))
    canvas = payload.get("canvas") if isinstance(payload.get("canvas"), dict) else payload
    nodes = canvas.get("nodes") if isinstance(canvas.get("nodes"), list) else []
    connections = canvas.get("connections") if isinstance(canvas.get("connections"), list) else []
    summary_nodes = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        summary_nodes.append({"id": node.get("id"), "type": node.get("type"),
                              "title": node.get("title") or ""})
    text = "画布 %s《%s》：%d 个节点，%d 条连线" % (
        canvas_id, canvas.get("title") or "(未命名)", len(summary_nodes), len(connections))
    for node in summary_nodes[:50]:
        text += "\n- %s | %s | %s" % (node["id"], node["type"], node["title"] or "")
    if len(summary_nodes) > 50:
        text += "\n…（节点较多，只列前 50 个）"
    return _result(True, text, {"canvas_id": canvas_id, "title": canvas.get("title"),
                                "kind": canvas.get("kind"), "node_count": len(summary_nodes),
                                "nodes": summary_nodes, "connection_count": len(connections)})


# ---------------------------------------------------------------------------
# 工具 3：新建节点
# ---------------------------------------------------------------------------

def _agent_tool(base_url: str, token: str, tool_name: str, args: Dict[str, Any],
                timeout: float) -> Dict[str, Any]:
    """调 /api/agent/tools/{tool}；成功返回 {ok, result}，失败返回 {ok:False, error, code}。"""
    response = _http("POST", base_url, "/api/agent/tools/%s" % urllib.parse.quote(tool_name),
                     token, {"args": args}, timeout=timeout)
    if not response.get("ok"):
        return {"ok": False, "error": _error_from(response), "status": int(response.get("status") or 0)}
    payload, snippet = _decode(response)
    if not isinstance(payload, dict):
        return {"ok": False, "error": "NOVAI 返回的不是 JSON：%s" % (snippet or "空响应"), "status": 0}
    return {"ok": bool(payload.get("ok", True)), "result": payload.get("result"),
            "message": payload.get("message") or "", "error": ""}


def node_create(base_url: str, token: str = "", canvas_id: str = "", node_type: str = "text",
                title: Optional[str] = None, x: Optional[float] = None,
                y: Optional[float] = None, text: Optional[str] = None,
                timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    canvas_id = str(canvas_id or "").strip()
    if not canvas_id:
        return _result(False, "canvas_id 不能为空")
    node_type = str(node_type or "text").strip().lower() or "text"
    args: Dict[str, Any] = {"canvas_id": canvas_id, "type": node_type}
    if title is not None:
        args["title"] = str(title)
    for key, value in (("x", x), ("y", y)):
        if value is None:
            continue
        try:
            args[key] = float(value)
        except (TypeError, ValueError):
            return _result(False, "%s 必须是数字" % key)
    if text is not None:
        args["prompt"] = str(text)        # 智能画布/经典画布都用 prompt 承载文本
    outcome = _agent_tool(base_url, token, "create_node", args, timeout)
    used_type = node_type
    fallback_note = ""
    if not outcome.get("ok") and node_type == "text":
        # 经典画布只认 image|prompt|video：文本节点退化成 prompt 节点再试一次
        message = str(outcome.get("error") or "")
        if "type 必须是" in message:
            args["type"] = "prompt"
            outcome = _agent_tool(base_url, token, "create_node", args, timeout)
            used_type = "prompt"
            fallback_note = "（经典画布不支持 text，已按 prompt 创建）"
    if not outcome.get("ok"):
        return _result(False, outcome.get("error") or "创建节点失败")
    data = outcome.get("result")
    node_id = ""
    if isinstance(data, dict):
        node_id = str(data.get("node_id") or data.get("id") or "")
    text_out = "已创建节点：%s（type=%s）%s" % (node_id or "(未返回 id)", used_type, fallback_note)
    return _result(True, text_out, data)


# ---------------------------------------------------------------------------
# 工具 4：更新节点
# ---------------------------------------------------------------------------

def node_update(base_url: str, token: str = "", canvas_id: str = "", node_id: str = "",
                title: Optional[str] = None, text: Optional[str] = None,
                settings: Optional[Dict[str, Any]] = None,
                timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    canvas_id = str(canvas_id or "").strip()
    node_id = str(node_id or "").strip()
    if not canvas_id or not node_id:
        return _result(False, "canvas_id 与 node_id 不能为空")
    if title is None and text is None and settings is None:
        return _result(False, "至少提供 title / text / settings 之一")
    if settings is not None and not isinstance(settings, dict):
        return _result(False, "settings 必须是对象")
    args: Dict[str, Any] = {"canvas_id": canvas_id, "node_id": node_id}
    if title is not None:
        args["title"] = str(title)
    if text is not None:
        args["prompt"] = str(text)
    if settings is not None:
        args["settings"] = dict(settings)
    outcome = _agent_tool(base_url, token, "update_node", args, timeout)
    if not outcome.get("ok"):
        return _result(False, outcome.get("error") or "更新节点失败")
    data = outcome.get("result")
    return _result(True, "节点已更新：%s" % node_id, data)


# ---------------------------------------------------------------------------
# 工具 5：触发生图（异步）
# ---------------------------------------------------------------------------

def image_generate(base_url: str, token: str = "", canvas_id: str = "", prompt: str = "",
                   node_id: Optional[str] = None,
                   timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    canvas_id = str(canvas_id or "").strip()
    prompt = str(prompt or "").strip()
    if not canvas_id:
        return _result(False, "canvas_id 不能为空")
    if not prompt:
        return _result(False, "prompt 不能为空")
    updated = None
    node_id = str(node_id or "").strip()
    if node_id:
        # 指定节点时先把提示词写进该节点，再触发；两步都成功才算成功
        updated = node_update(base_url, token, canvas_id=canvas_id, node_id=node_id,
                              text=prompt, timeout=timeout)
        if not updated.get("ok"):
            return _result(False, "写节点失败：%s" % updated.get("text"))
    args: Dict[str, Any] = {"canvas_id": canvas_id, "prompt": prompt}
    outcome = _agent_tool(base_url, token, "generate_image", args, timeout)
    if not outcome.get("ok"):
        return _result(False, outcome.get("error") or "触发图片生成失败")
    data = outcome.get("result") if isinstance(outcome.get("result"), dict) else {}
    task_id = str(data.get("task_id") or data.get("task") or "")
    new_node = str(data.get("node_id") or "")
    parts = ["已触发图片生成（异步，不会等待出图）"]
    if task_id:
        parts.append("task=%s" % task_id)
    if new_node:
        parts.append("node=%s" % new_node)
    if node_id:
        parts.append("已更新的节点=%s" % node_id)
    if not task_id and not new_node:
        parts.append("返回：%s" % json.dumps(data, ensure_ascii=False)[:300])
    return _result(True, "；".join(parts), data)


# ---------------------------------------------------------------------------
# MCP 工具目录
# ---------------------------------------------------------------------------

TOOLS: List[Dict[str, Any]] = [
    {
        "name": "novai_canvas_list",
        "description": "列出 NOVAI 里的画布（id、标题、更新时间）。只读，不修改任何数据。",
        "inputSchema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": MAX_LIMIT,
                                     "description": "最多返回多少条，默认 %d" % DEFAULT_LIMIT}},
            "additionalProperties": False,
        },
    },
    {
        "name": "novai_canvas_get",
        "description": "读取一个画布的结构摘要（节点数量、节点 id/类型/标题、连线数量）。只读，不修改画布内容。",
        "inputSchema": {
            "type": "object",
            "properties": {"canvas_id": {"type": "string", "description": "画布 id"}},
            "required": ["canvas_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "novai_node_create",
        "description": "在指定画布上新建一个节点（默认文本节点），返回新节点 id。会修改画布：写入一个新节点。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "canvas_id": {"type": "string"},
                "type": {"type": "string",
                         "enum": ["text", "prompt", "image", "video"],
                         "description": "节点类型，默认 text；经典画布只支持 image/prompt/video"},
                "title": {"type": "string", "description": "节点标题"},
                "x": {"type": "number", "description": "画布坐标 x（不传则自动排布）"},
                "y": {"type": "number", "description": "画布坐标 y（不传则自动排布）"},
                "text": {"type": "string", "description": "节点文本/提示词"},
            },
            "required": ["canvas_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "novai_node_update",
        "description": "更新一个节点的标题、文本或生成参数，返回更新结果。会修改画布：覆盖指定节点的字段。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "canvas_id": {"type": "string"},
                "node_id": {"type": "string"},
                "title": {"type": "string"},
                "text": {"type": "string", "description": "节点文本/提示词（智能画布写到 prompt）"},
                "settings": {"type": "object", "description": "生成参数（模型/比例/分辨率等，仅图片/视频节点）"},
            },
            "required": ["canvas_id", "node_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "novai_image_generate",
        "description": "触发一次图片生成（异步，立即返回，不等待出图）。会修改画布并消耗生成额度：新建图片节点或更新指定节点。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "canvas_id": {"type": "string"},
                "prompt": {"type": "string", "description": "图片提示词"},
                "node_id": {"type": "string", "description": "可选：把提示词写进这个已有节点再触发生成"},
            },
            "required": ["canvas_id", "prompt"],
            "additionalProperties": False,
        },
    },
]

TOOL_NAMES = tuple(item["name"] for item in TOOLS)


def dispatch(base_url: str, token: str, name: str, arguments: Optional[Dict[str, Any]] = None,
             timeout: float = DEFAULT_TIMEOUT) -> Dict[str, Any]:
    """按工具名分发。未知工具也走统一 ok=False，不抛异常。"""
    args = dict(arguments or {})
    try:
        if name == "novai_canvas_list":
            return canvas_list(base_url, token, limit=args.get("limit"), timeout=timeout)
        if name == "novai_canvas_get":
            return canvas_get(base_url, token, canvas_id=args.get("canvas_id", ""), timeout=timeout)
        if name == "novai_node_create":
            return node_create(base_url, token, canvas_id=args.get("canvas_id", ""),
                               node_type=args.get("type") or "text", title=args.get("title"),
                               x=args.get("x"), y=args.get("y"), text=args.get("text"),
                               timeout=timeout)
        if name == "novai_node_update":
            return node_update(base_url, token, canvas_id=args.get("canvas_id", ""),
                               node_id=args.get("node_id", ""), title=args.get("title"),
                               text=args.get("text"), settings=args.get("settings"),
                               timeout=timeout)
        if name == "novai_image_generate":
            return image_generate(base_url, token, canvas_id=args.get("canvas_id", ""),
                                  prompt=args.get("prompt", ""), node_id=args.get("node_id"),
                                  timeout=timeout)
    except Exception as exc:                      # 工具层绝不把异常抛给 MCP 客户端
        return _result(False, "工具执行异常：%s: %s" % (type(exc).__name__, exc))
    return _result(False, "未知工具：%s（可用：%s）" % (name, "、".join(TOOL_NAMES)))
