#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""photoshop_bridge.py —— 画布节点「送 Photoshop 精修 / 取回修改」的桥。

HTTP（手动按钮）：
- POST /api/photoshop/open-node   {canvas_id, node_id}
- POST /api/photoshop/fetch-node  {canvas_id, node_id}

Agent 工具（AI 助手驱动，注册进 main.AGENT_TOOLS）：
- photoshop_open_node  {canvas_id, node_id}
- photoshop_fetch_node {canvas_id, node_id, title?}

只写素材文件与映射；HTTP 取回不写画布（前端本地建节点），Agent 取回才写画布（计划执行链路会 refreshAuthoritative）。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/api/photoshop", tags=["photoshop"])

MAP_FILENAME = "ps_bridge.json"
COPY_DIRNAME = "ps_bridge"
MCP_OPEN = "photoshop.photoshop_open_image"
MCP_EXPORT = "photoshop.photoshop_export_as"
MCP_STATE = "photoshop.photoshop_get_state"
MCP_DOCS = "photoshop.photoshop_list_documents"
MCP_PING = "photoshop.photoshop_ping"
CONNECT_HINTS = ("failed to connect to photoshop", "connect to photoshop", "photoshop is not running")
PHOTOSHOP_WAIT_SECONDS = 45
OPEN_MESSAGE = "已在 Photoshop 打开这张图（副本）。接下来用 mcp__photoshop__* 工具改它，改完调 photoshop_fetch_node 把结果放回画布。"
MAP_LOCK = threading.Lock()
_DEPS: Dict[str, Any] = {}


class PsBridgeError(Exception):
    def __init__(self, message: str, code: str = "tool_error", status_code: int = 400):
        super().__init__(message)
        self.message = str(message)
        self.code = code
        self.status_code = status_code


def init(**deps: Any) -> None:
    """由 main.py 注入画布 / 素材依赖，避免本模块反向 import main（循环导入）。"""
    _DEPS.update(deps)


def _dep(name: str):
    fn = _DEPS.get(name)
    if fn is None:
        raise RuntimeError("photoshop_bridge 缺少依赖：%s" % name)
    return fn


def _err(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"ok": False, "code": code, "message": message})


def _short_error(exc: Any) -> str:
    return re.sub(r"\s+", " ", str(exc or type(exc).__name__)).strip()[:200]


def _safe_id(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))


def _stamp() -> int:
    return int(time.time() * 1000)


def _as_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _node_output_url(node: Dict[str, Any]) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    gen = data.get("gen") if isinstance(data.get("gen"), dict) else {}
    hist = gen.get("hist") if isinstance(gen.get("hist"), list) else []
    if hist:
        index = _as_int(gen.get("hi")) or 0
        if not 0 <= index < len(hist):
            index = 0
        current = hist[index] if isinstance(hist[index], dict) else {}
        url = str(current.get("url") or "").strip()
        if url:
            return url
    images = node.get("images") if isinstance(node.get("images"), list) else []
    for item in images:
        url = str(item.get("url") or "").strip() if isinstance(item, dict) else ""
        if url:
            return url
    return str(node.get("url") or "").strip()


def _node_title(node: Dict[str, Any]) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    gen = data.get("gen") if isinstance(data.get("gen"), dict) else {}
    for value in (gen.get("title"), node.get("title"), node.get("name")):
        text = str(value or "").strip()
        if text:
            return text[:120]
    return ""


def _find_node(canvas: Dict[str, Any], node_id: str) -> Optional[Dict[str, Any]]:
    nodes = canvas.get("nodes") if isinstance(canvas.get("nodes"), list) else []
    for node in nodes:
        if isinstance(node, dict) and node.get("id") == node_id:
            return node
    return None


def _call_mcp(tool: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    from server.mcp import registry

    try:
        return registry.call_tool(tool, arguments)
    except Exception as exc:
        return {"ok": False, "code": "mcp_call_failed", "error": _short_error(exc)}


def _result_text(result: Dict[str, Any]) -> str:
    body = result.get("result") if isinstance(result.get("result"), dict) else {}
    parts = []
    for item in body.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
            parts.append(str(item["text"]))
    if parts:
        return "\n".join(parts)
    return str(result.get("error") or result.get("message") or "")


def _mcp_error_kind(result: Dict[str, Any]) -> str:
    if str(result.get("code") or "") in ("unknown_tool", "unknown_server"):
        return "disabled"
    text = str(result.get("error") or result.get("message") or "").lower()
    if any(hint in text for hint in CONNECT_HINTS):
        return "unavailable"
    return "other"


def _mcp_error(result: Dict[str, Any], fallback: str) -> PsBridgeError:
    kind = _mcp_error_kind(result)
    if kind == "disabled":
        return PsBridgeError("MCP 未启用：设置 → 插件 → MCP 服务 里打开总开关", "mcp_disabled", 400)
    if kind == "unavailable":
        return PsBridgeError("连不上 Photoshop：先打开 Photoshop 再试", "photoshop_unavailable", 502)
    detail = re.sub(r"\s+", " ", str(result.get("error") or result.get("message") or "")).strip()[:200]
    return PsBridgeError((fallback + "：" + detail) if detail else fallback, "photoshop_error", 502)


def _json_payload(text: str) -> Any:
    raw = str(text or "")
    match = re.search(r"[\[{]", raw)
    if not match:
        return None
    try:
        return json.JSONDecoder().raw_decode(raw[match.start():])[0]
    except ValueError:
        return None


def _collect_documents(payload: Any) -> List[Dict[str, Any]]:
    documents = []
    if isinstance(payload, list):
        for item in payload:
            documents.extend(_collect_documents(item))
    elif isinstance(payload, dict):
        if _as_int(payload.get("id")) is not None and isinstance(payload.get("id"), (int, str)):
            documents.append(payload)
        for value in payload.values():
            if isinstance(value, (list, dict)):
                documents.extend(_collect_documents(value))
    return documents


def _document_path(document: Dict[str, Any]) -> str:
    for key in ("path", "filePath", "file_path"):
        text = str(document.get(key) or "").strip()
        if text:
            return text
    return ""


def _match_document_by_path(text: str, path: str) -> Optional[Dict[str, Any]]:
    target = os.path.realpath(path)
    target_name = os.path.basename(target)
    for document in _collect_documents(_json_payload(text)):
        document_path = _document_path(document)
        if not document_path:
            continue
        if os.path.realpath(document_path) == target or os.path.basename(document_path) == target_name:
            return document
    return None


def _list_open_document_ids() -> Optional[List[int]]:
    """Photoshop 当前打开的文档 id 列表；列表读不出来返回 None（不能当成已关闭）。"""
    result = _call_mcp(MCP_DOCS, {})
    if not result.get("ok"):
        if _mcp_error_kind(result) in ("unavailable", "disabled"):
            raise _mcp_error(result, "读取 Photoshop 文档列表失败")
        return None
    payload = _json_payload(_result_text(result))
    documents = None
    if isinstance(payload, dict) and isinstance(payload.get("details"), dict) and "documents" in payload["details"]:
        documents = payload["details"].get("documents") or []
    elif isinstance(payload, dict) and isinstance(payload.get("documents"), list):
        documents = payload["documents"]
    elif isinstance(payload, list):
        documents = payload
    if not isinstance(documents, list):
        return None
    return [item for item in (_as_int(doc.get("id")) for doc in documents if isinstance(doc, dict)) if item is not None]


def _parse_doc_id(text: str) -> Optional[int]:
    match = re.search(r'"id"\s*:\s*(\d+)', text or "")
    return int(match.group(1)) if match else None


def _parse_name(text: str) -> str:
    match = re.search(r'"name"\s*:\s*"((?:[^"\\]|\\.)*)"', text or "")
    if not match:
        return ""
    try:
        return str(json.loads('"' + match.group(1) + '"')).strip()
    except ValueError:
        return match.group(1).strip()


def _map_path() -> str:
    return os.path.join(_dep("data_dir")(), MAP_FILENAME)


def _map_key(canvas_id: str, node_id: str) -> str:
    return "%s:%s" % (canvas_id, node_id)


def _read_map() -> Dict[str, Any]:
    try:
        with open(_map_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_map(data: Dict[str, Any]) -> None:
    path = _map_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    temp = "%s.%d.tmp" % (path, os.getpid())
    with open(temp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(temp, path)


def _save_mapping(canvas_id: str, node_id: str, record: Dict[str, Any]) -> None:
    with MAP_LOCK:
        data = _read_map()
        data[_map_key(canvas_id, node_id)] = record
        _write_map(data)


def _load_mapping(canvas_id: str, node_id: str) -> Optional[Dict[str, Any]]:
    with MAP_LOCK:
        entry = _read_map().get(_map_key(canvas_id, node_id))
    return entry if isinstance(entry, dict) else None


def _copy_for_photoshop(canvas_id: str, node_id: str, source: str) -> str:
    """PS 保存会写回打开的文件，所以打开的是副本，原始素材不会被改掉。"""
    folder = os.path.join(_dep("data_dir")(), COPY_DIRNAME, _safe_id(canvas_id))
    os.makedirs(folder, exist_ok=True)
    ext = os.path.splitext(source)[1].lower().lstrip(".") or "png"
    if ext not in ("png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "psd", "psb"):
        ext = "png"
    target = os.path.join(folder, "%s-%d.%s" % (_safe_id(node_id), _stamp(), ext))
    shutil.copyfile(source, target)
    return target


def _normalize_ids(args: Dict[str, Any]) -> Dict[str, Any]:
    args = dict(args or {})
    canvas_id = str(args.get("canvas_id") or "").strip()
    node_id = str(args.get("node_id") or "").strip()
    if not canvas_id or not node_id:
        raise PsBridgeError("canvas_id 与 node_id 不能为空", "invalid_args", 400)
    if not _safe_id(canvas_id) or not _safe_id(node_id):
        raise PsBridgeError("canvas_id / node_id 不合法", "invalid_args", 400)
    out = {"canvas_id": canvas_id, "node_id": node_id}
    title = str(args.get("title") or "").strip()
    if title:
        out["title"] = title[:120]
    return out


# ---------------------------------------------------------------------------
# Photoshop 自动启动：连不上时自己把本机 PS 拉起来，不让用户手动开
# ---------------------------------------------------------------------------

def _photoshop_app_name() -> str:
    try:
        names = os.listdir("/Applications")
    except OSError:
        return ""
    for name in sorted(names):
        lower = name.lower()
        if "adobe photoshop" in lower and lower.endswith(".app"):
            return name[:-4]
    return ""


def _start_photoshop():
    if sys.platform != "darwin":
        return False, "只能在 macOS 上自动启动 Photoshop"
    name = _photoshop_app_name()
    if not name:
        return False, "本机没装 Photoshop（/Applications 下没找到 Adobe Photoshop）"
    try:
        subprocess.Popen(["open", "-a", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as exc:
        return False, "打不开 Photoshop：%s" % _short_error(exc)
    return True, name


def _wait_photoshop(seconds: int) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        time.sleep(2)
        probe = _call_mcp(MCP_PING, {})
        if probe.get("ok"):
            return True
        if _mcp_error_kind(probe) == "disabled":
            return False
    return False


def _open_in_photoshop(copy_path: str) -> Dict[str, Any]:
    result = _call_mcp(MCP_OPEN, {"filePath": copy_path})
    if result.get("ok"):
        return result
    if _mcp_error_kind(result) != "unavailable":
        raise _mcp_error(result, "打开 Photoshop 文档失败")
    started, note = _start_photoshop()
    if not started:
        raise PsBridgeError("连不上 Photoshop：" + note, "photoshop_unavailable", 502)
    if not _wait_photoshop(PHOTOSHOP_WAIT_SECONDS):
        raise PsBridgeError("Photoshop 启动了，但 %d 秒内还没连上：请稍等一下再试" % PHOTOSHOP_WAIT_SECONDS,
                            "photoshop_unavailable", 502)
    result = _call_mcp(MCP_OPEN, {"filePath": copy_path})
    if result.get("ok"):
        return result
    raise _mcp_error(result, "打开 Photoshop 文档失败")


# ---------------------------------------------------------------------------
# 两条主流程（HTTP 与 Agent 工具共用）
# ---------------------------------------------------------------------------

def _open_payload(canvas_id: str, node_id: str) -> Dict[str, Any]:
    try:
        canvas = _dep("load_canvas")(canvas_id)
    except HTTPException as exc:
        raise PsBridgeError(str(exc.detail or "画布不存在"), "canvas_not_found", exc.status_code or 404)
    node = _find_node(canvas, node_id)
    if node is None:
        raise PsBridgeError("这个节点不存在", "node_not_found", 404)
    url = _node_output_url(node)
    if not url:
        raise PsBridgeError("这个节点还没有图片", "node_has_no_image", 400)
    source = _dep("local_image_path")(url)
    if not source or not os.path.isfile(source):
        raise PsBridgeError("找不到这张图的本地文件，没法送到 Photoshop", "image_not_found", 400)
    copy_path = _copy_for_photoshop(canvas_id, node_id, source)
    result = _open_in_photoshop(copy_path)
    text = _result_text(result)
    doc_id = _parse_doc_id(text)
    name = _parse_name(text) or os.path.basename(copy_path)
    if doc_id is None:
        state = _call_mcp(MCP_STATE, {})
        document = _match_document_by_path(_result_text(state), copy_path) if state.get("ok") else None
        if document:
            doc_id = _as_int(document.get("id"))
            name = str(document.get("name") or name)
    if doc_id is None:
        raise PsBridgeError("Photoshop 打开了图，但读不到文档 id", "photoshop_error", 502)
    title = _node_title(node) or os.path.splitext(os.path.basename(copy_path))[0]
    _save_mapping(canvas_id, node_id, {"doc_id": doc_id, "path": copy_path, "title": title, "at": _stamp()})
    return {"ok": True, "doc_id": doc_id, "path": copy_path, "name": name, "title": title}


def _fetch_payload(canvas_id: str, node_id: str) -> Dict[str, Any]:
    entry = _load_mapping(canvas_id, node_id)
    doc_id = _as_int((entry or {}).get("doc_id"))
    if not entry or doc_id is None:
        raise PsBridgeError("这个节点还没送到 Photoshop", "not_sent", 404)
    opened = _list_open_document_ids()
    if opened is None:
        raise PsBridgeError("读不到 Photoshop 打开的文档列表", "photoshop_error", 502)
    if doc_id not in opened:
        raise PsBridgeError("Photoshop 里那张图已经关闭了", "document_closed", 404)
    out_dir = os.path.join(_dep("assets_dir")(), "output")
    os.makedirs(out_dir, exist_ok=True)
    filename = "ps_%s_%d.png" % (_safe_id(node_id), _stamp())
    out_path = os.path.join(out_dir, filename)
    result = _call_mcp(MCP_EXPORT, {"path": out_path, "format": "PNG", "document_id": doc_id})
    if not result.get("ok"):
        raise _mcp_error(result, "从 Photoshop 导出图片失败")
    if not os.path.isfile(out_path) or os.path.getsize(out_path) <= 0:
        raise PsBridgeError("导出失败：Photoshop 没有写出图片文件", "export_failed", 502)
    width, height = _dep("read_image_size")(out_path)
    if not width or not height:
        try:
            os.remove(out_path)
        except OSError:
            pass
        raise PsBridgeError("导出的图片读不出尺寸", "export_failed", 502)
    return {"ok": True, "url": "/assets/output/" + filename, "width": int(width), "height": int(height),
            "title": str(entry.get("title") or "").strip()}


@router.post("/open-node")
def open_node(payload: Dict[str, Any]) -> Any:
    try:
        args = _normalize_ids(payload)
        result = _open_payload(args["canvas_id"], args["node_id"])
        return {"ok": True, "doc_id": result["doc_id"], "path": result["path"], "name": result["name"]}
    except PsBridgeError as exc:
        return _err(exc.status_code, exc.code, exc.message)
    except Exception as exc:
        return _err(500, "internal_error", "打开 Photoshop 出错：" + _short_error(exc))


@router.post("/fetch-node")
def fetch_node(payload: Dict[str, Any]) -> Any:
    try:
        args = _normalize_ids(payload)
        result = _fetch_payload(args["canvas_id"], args["node_id"])
        return {"ok": True, "url": result["url"], "width": result["width"], "height": result["height"]}
    except PsBridgeError as exc:
        return _err(exc.status_code, exc.code, exc.message)
    except Exception as exc:
        return _err(500, "internal_error", "取回 Photoshop 修改出错：" + _short_error(exc))


# ---------------------------------------------------------------------------
# Agent 工具：AI 助手驱动 Photoshop（计划执行链路）
# ---------------------------------------------------------------------------

def _agent_validate(args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return _normalize_ids(args)
    except PsBridgeError as exc:
        raise _dep("tool_error")(exc.message, code=exc.code, status_code=exc.status_code)


def _raise_agent_error(exc: PsBridgeError):
    raise _dep("tool_error")(exc.message, code=exc.code, status_code=exc.status_code)


async def _agent_open_run(args: Dict[str, Any]) -> Dict[str, Any]:
    try:
        payload = await asyncio.to_thread(_open_payload, args["canvas_id"], args["node_id"])
    except PsBridgeError as exc:
        _raise_agent_error(exc)
    return {"ok": True, "doc_id": payload["doc_id"], "name": payload["name"], "message": OPEN_MESSAGE}


async def _agent_fetch_run(args: Dict[str, Any]) -> Dict[str, Any]:
    canvas_id, node_id = args["canvas_id"], args["node_id"]
    try:
        payload = await asyncio.to_thread(_fetch_payload, canvas_id, node_id)
    except PsBridgeError as exc:
        _raise_agent_error(exc)
    title = str(args.get("title") or "").strip()
    if not title:
        base = str(payload.get("title") or "").strip()
        title = (base + " · PS 精修") if base else "PS 精修"
    added = await _dep("add_image_to_canvas")(canvas_id, payload["url"], title)
    return {"ok": True, "node_id": added.get("node_id"), "url": payload["url"],
            "width": payload["width"], "height": payload["height"]}


def _agent_open_preview(args: Dict[str, Any], canvas: Dict[str, Any]) -> str:
    node = _find_node(canvas or {}, str(args.get("node_id") or ""))
    name = _node_title(node) if node else ""
    return "在 Photoshop 中打开「%s」的当前图片（打开副本，改完再取回）" % (name or "这个节点")


def _agent_fetch_preview(args: Dict[str, Any], canvas: Dict[str, Any]) -> str:
    return "把 Photoshop 里改好的图片导出，作为新节点放回画布（原节点不动）"


def agent_tool_entries() -> Dict[str, Dict[str, Any]]:
    return {
        "photoshop_open_node": {
            "description": "把画布上某个图片节点的当前图片送到 Photoshop 打开（打开副本，不动原素材），"
                           "之后可以用 mcp__photoshop__* 工具精修。什么时候用：用户要「去 Photoshop 里修一下 / 精修 / "
                           "调色 / 抠图 / 加字」并指定了画布上的某张图。标准顺序：先 photoshop_open_node 拿到 doc_id，"
                           "再用 mcp__photoshop__* 工具改这张图（优先用 recipe 类工具），改完必须调 photoshop_fetch_node "
                           "把结果放回画布。返回 doc_id，后续步骤用 {stepN.doc_id} 引用。",
            "schema": {"type": "object", "properties": {
                "canvas_id": {"type": "string", "description": "目标画布 ID"},
                "node_id": {"type": "string", "description": "要精修的图片节点 ID"}},
                "required": ["canvas_id", "node_id"]},
            "validate": _agent_validate,
            "run": _agent_open_run,
            "preview": _agent_open_preview,
            "mutates_canvas": False,
        },
        "photoshop_fetch_node": {
            "description": "把 Photoshop 里改好的那张图导出成图片，作为新节点放回画布（原节点不动），"
                           "后续步骤可以引用新节点继续处理。什么时候用：photoshop_open_node 之后、用 mcp__photoshop__* "
                           "改完了，用它收尾。返回新节点 id 和图片地址，后续步骤用 {stepN.node_id} / {stepN.url} 引用。",
            "schema": {"type": "object", "properties": {
                "canvas_id": {"type": "string", "description": "目标画布 ID"},
                "node_id": {"type": "string", "description": "送去 Photoshop 时用的原图片节点 ID"},
                "title": {"type": "string", "description": "可选：新节点标题（默认「原标题 · PS 精修」）"}},
                "required": ["canvas_id", "node_id"]},
            "validate": _agent_validate,
            "run": _agent_fetch_run,
            "preview": _agent_fetch_preview,
            "mutates_canvas": True,
        },
    }
