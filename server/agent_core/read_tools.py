#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按需读取工具：模型不再只靠提示词里塞的画布快照，而是自己决定读什么。

  read_node      读节点全文 / 提示词 / 参数 / 上下游 / 结果地址 / 历史版本数
  search_canvas  按标题、正文、提示词找节点，可按种类、状态过滤
  read_table     读多维表格的列、行、输入通道
  canvas_diff    两份画布快照之间用户（或别人）改了什么
  view_image     请求在下一轮把某张图 / 某个视频节点的封面交给模型看
  recall_step    取回本次运行里被折叠的某条工具结果原文

全部只读、不花钱。这里只有纯函数 + CanvasAccess（BEAT 节点格式的读取口径）；
load_canvas、转录、版本快照都由 main.py 在接线时通过 tool_entries(...) 传进来。
Python 3.9 约束：注解用 Optional/Dict/List。
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional

_MENTION_RE = re.compile(r"@\{([A-Za-z0-9_\-]+)\}")
READ_NODE_MAX = 12
READ_TEXT_MAX = 20000
SEARCH_LIMIT_MAX = 30
TABLE_ROWS_MAX = 60
STATUS_CODES = ("empty", "done", "failed", "pending", "uploaded")
STATUS_LABEL = {"empty": "空", "done": "有结果", "failed": "失败", "pending": "等待生成", "uploaded": "已上传"}
MEDIA_KINDS = ("image", "video", "audio")


class ReadToolError(Exception):
    """参数 / 目标不对。code 与 main.AgentToolError 的口径一致，接线时会被换成它。"""

    def __init__(self, message: str, code: str = "invalid_args"):
        super().__init__(message)
        self.message = str(message)
        self.code = code


class CanvasAccess:
    """BEAT（canvas-next）节点的读取口径。与 main.py 的 _agent_beat_* 一致；
    别的画布格式接线时传一个覆盖了对应方法的子类即可。"""

    def nodes(self, canvas: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [n for n in ((canvas or {}).get("nodes") or []) if isinstance(n, dict) and n.get("id")]

    def by_id(self, canvas: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        return {str(n.get("id")): n for n in self.nodes(canvas)}

    def edges(self, canvas: Dict[str, Any]) -> List[Dict[str, Any]]:
        raw = (canvas or {}).get("connections")
        if not isinstance(raw, list):
            raw = (canvas or {}).get("edges")
        return [e for e in (raw or []) if isinstance(e, dict) and e.get("from") and e.get("to")]

    def kind(self, node: Dict[str, Any]) -> str:
        kind = str(node.get("kind") or node.get("type") or "")
        return "label" if kind == "note" else kind

    def gen(self, node: Dict[str, Any]) -> Dict[str, Any]:
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        gen = data.get("gen")
        return gen if isinstance(gen, dict) else {}

    def versions(self, node: Dict[str, Any]) -> List[Dict[str, Any]]:
        return [h for h in (self.gen(node).get("hist") or []) if isinstance(h, dict)]

    def out(self, node: Dict[str, Any]) -> Dict[str, Any]:
        hist = self.versions(node)
        if not hist:
            return {}
        try:
            hi = int(self.gen(node).get("hi") or 0)
        except (TypeError, ValueError):
            hi = 0
        return hist[max(0, min(hi, len(hist) - 1))]

    def title(self, node: Dict[str, Any]) -> str:
        title = str(self.gen(node).get("title") or "").strip()
        if title:
            return title
        if self.kind(node) == "table":
            table = self.table(node)
            return str(table.get("title") or node.get("title") or node.get("text") or "").strip()[:60]
        return str(node.get("text") or "").strip()[:60] if self.kind(node) != "text" else ""

    def url(self, node: Dict[str, Any]) -> str:
        return str(self.out(node).get("url") or node.get("url") or "").strip()

    def text(self, node: Dict[str, Any]) -> str:
        return str(self.out(node).get("text") or node.get("text") or "") if self.kind(node) == "text" else ""

    def raw_prompt(self, node: Dict[str, Any]) -> str:
        return str(self.gen(node).get("prompt") or "").replace(" ", " ")

    def prompt(self, node: Dict[str, Any], by_id: Optional[Dict[str, Dict[str, Any]]] = None) -> str:
        """提示词；@{id} 换成 @标题（id），模型既看得懂又能照着 id 操作。"""
        def name(match: "re.Match[str]") -> str:
            ref = (by_id or {}).get(match.group(1))
            return "@%s（%s）" % (self.title(ref) or match.group(1), match.group(1)) if ref else "@" + match.group(1)
        return _MENTION_RE.sub(name, self.raw_prompt(node)).strip()

    def params(self, node: Dict[str, Any]) -> Dict[str, Any]:
        params = self.gen(node).get("params")
        if not isinstance(params, dict):
            return {}
        return {k: v for k, v in params.items() if v not in (None, "", [], {}) and not isinstance(v, (dict, list))}

    def status(self, node: Dict[str, Any]) -> str:
        """状态码：empty / done / failed / pending / uploaded；不是生成类节点返回空串。"""
        kind = self.kind(node)
        gen = self.gen(node)
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        if kind not in MEDIA_KINDS and kind != "text":
            return ""
        if data.get("agentRun") or data.get("agentPending") or gen.get("taskId"):
            return "pending"
        if gen.get("err"):
            return "failed"
        if kind == "text":
            return "done" if self.text(node).strip() else "empty"
        if self.url(node):
            return "uploaded" if gen.get("uploaded") else "done"
        return "empty"

    def table(self, node: Dict[str, Any]) -> Dict[str, Any]:
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        table = data.get("table") if isinstance(data.get("table"), dict) else {}
        # 智能画布的表格在 node["table"]（BEAT 在 data.table）：两种都读，别让模型看到空表
        if not table and isinstance(node.get("table"), dict):
            table = node["table"]
        columns = [str(c) for c in (table.get("columns") or [])] if isinstance(table.get("columns"), list) else []
        rows = [r if isinstance(r, list) else [r] for r in (table.get("rows") or [])] if isinstance(table.get("rows"), list) else []
        return {"columns": columns, "rows": rows, "raw": table}

    def members(self, node: Dict[str, Any], by_id: Dict[str, Dict[str, Any]]) -> List[str]:
        return [str(c) for c in (node.get("children") or []) if str(c) in by_id]

    # --- 给上下文引擎用 ---
    def map_line(self, node: Dict[str, Any], upstream: int = 0) -> str:
        kind = self.kind(node)
        if kind == "text":
            head = self.text(node) or self.raw_prompt(node)
        elif kind == "table":
            table = self.table(node)
            head = "%d 列 × %d 行" % (len(table["columns"]), len(table["rows"]))
        elif kind == "group":
            children = node.get("children") or []
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            head = "%s，成员 %d 个" % ("堆叠" if data.get("stack") else "分组", len(children))
        else:
            head = self.raw_prompt(node)
        head = " ".join(_MENTION_RE.sub("@", head).split())[:40]
        status = STATUS_LABEL.get(self.status(node), "")
        return "- %s | %s | %s | %s | %d | %s" % (node.get("id"), kind, self.title(node)[:30] or "（无标题）",
                                                 status or "-", upstream, head)

    def detail(self, canvas: Dict[str, Any], node: Dict[str, Any], fields: Optional[List[str]] = None,
               text_max: int = READ_TEXT_MAX) -> Dict[str, Any]:
        """节点完整信息（read_node 的返回 / 地图里重点节点的摘要）。fields 给了就只返回这些键（id / kind / title 总在）。"""
        by_id = self.by_id(canvas)
        nid = str(node.get("id"))
        kind = self.kind(node)
        out: Dict[str, Any] = {"id": nid, "kind": kind, "title": self.title(node)}
        status = self.status(node)
        if status:
            out["status"] = status
            if status == "failed":
                out["error"] = str(self.gen(node).get("err") or "")[:300]
        if kind == "text":
            body = self.text(node)
            out["text"] = body if len(body) <= text_max else body[:text_max] + "…（已截断，共 %d 字）" % len(body)
        prompt = self.prompt(node, by_id)
        if prompt:
            out["prompt"] = prompt if len(prompt) <= text_max else prompt[:text_max] + "…"
        url = self.url(node)
        if url and kind in MEDIA_KINDS:
            out["%s_urls" % kind] = [url]
        versions = self.versions(node)
        if len(versions) > 1:
            out["versions"] = len(versions)
            try:
                out["current_version"] = int(self.gen(node).get("hi") or 0) + 1
            except (TypeError, ValueError):
                pass
        current = self.out(node)
        for key in ("w", "h", "dur"):
            if current.get(key):
                out[key] = current[key]
        params = self.params(node)
        if params:
            out["settings"] = params
        edges = self.edges(canvas)
        upstream = [str(e.get("from")) for e in edges if str(e.get("to")) == nid]
        downstream = [str(e.get("to")) for e in edges if str(e.get("from")) == nid]
        if upstream:
            out["upstream"] = [{"id": u, "kind": self.kind(by_id[u]), "title": self.title(by_id[u])}
                               for u in upstream if u in by_id][:20]
        if downstream:
            out["downstream"] = [{"id": d, "kind": self.kind(by_id[d]), "title": self.title(by_id[d])}
                                 for d in downstream if d in by_id][:20]
        if kind == "group":
            data = node.get("data") if isinstance(node.get("data"), dict) else {}
            out["group_kind"] = "stack" if data.get("stack") else "group"
            out["members"] = [{"id": m, "kind": self.kind(by_id[m]), "title": self.title(by_id[m]),
                               "url": self.url(by_id[m])} for m in self.members(node, by_id)][:40]
        if kind == "table":
            table = self.table(node)
            out["columns"] = table["columns"]
            out["row_count"] = len(table["rows"])
        if kind == "timeline":
            out["clips"] = len(node.get("clips") or [])
        out["x"], out["y"] = node.get("x"), node.get("y")
        if fields:
            keep = {"id", "kind", "title"} | {str(f) for f in fields}
            out = {k: v for k, v in out.items() if k in keep}
        return out


def resolve_node(canvas: Dict[str, Any], ref: Any, access: CanvasAccess) -> Optional[Dict[str, Any]]:
    """节点引用 → 节点：先按 id，再按标题精确匹配（模型有时直接写标题）。"""
    ref = str(ref or "").strip()
    if not ref:
        return None
    by_id = access.by_id(canvas)
    if ref in by_id:
        return by_id[ref]
    hits = [n for n in by_id.values() if access.title(n) == ref]
    return hits[0] if len(hits) == 1 else None


def read_node(canvas: Dict[str, Any], node_ids: List[Any], fields: Optional[List[str]] = None,
              access: Optional[CanvasAccess] = None) -> Dict[str, Any]:
    access = access or CanvasAccess()
    found, missing = [], []
    for ref in list(node_ids or [])[:READ_NODE_MAX]:
        node = resolve_node(canvas, ref, access)
        if node is None:
            missing.append(str(ref))
        else:
            found.append(access.detail(canvas, node, fields))
    out: Dict[str, Any] = {"nodes": found}
    if missing:
        out["missing"] = missing
        out["hint"] = "这些引用在画布上找不到（可能已删除或写错了）；用 search_canvas 按标题 / 内容找"
    return out


def _terms(query: str) -> List[str]:
    return [t for t in re.split(r"[\s,，、;；]+", str(query or "").strip().lower()) if t]


def search_canvas(canvas: Dict[str, Any], query: str = "", kind: str = "", status: str = "",
                  limit: int = 10, access: Optional[CanvasAccess] = None) -> Dict[str, Any]:
    """关键词搜索：所有词都出现才算命中；标题命中权重最高，其次提示词，再次正文 / 表格内容。"""
    access = access or CanvasAccess()
    terms = _terms(query)
    kind = str(kind or "").strip().lower()
    status = str(status or "").strip().lower()
    try:
        limit = max(1, min(int(limit or 10), SEARCH_LIMIT_MAX))
    except (TypeError, ValueError):
        limit = 10
    scored = []
    by_id = access.by_id(canvas)
    for node in access.nodes(canvas):
        node_kind = access.kind(node)
        if kind and node_kind != kind:
            continue
        if status and access.status(node) != status:
            continue
        title = access.title(node).lower()
        prompt = access.raw_prompt(node).lower()
        body = access.text(node).lower()
        if node_kind == "table":
            table = access.table(node)
            body = (" ".join(table["columns"]) + " "
                    + " ".join(" ".join(str(c) for c in row) for row in table["rows"][:200])).lower()
        score = 0
        matched = True
        where = ""
        for term in terms:
            if term in title:
                score += 5
                where = where or "title"
            elif term in prompt:
                score += 3
                where = where or "prompt"
            elif term in body:
                score += 2
                where = where or "text"
            elif term == str(node.get("id")).lower():
                score += 8
                where = "id"
            else:
                matched = False
                break
        if not matched:
            continue
        snippet = ""
        if terms and where in ("prompt", "text"):
            source = access.raw_prompt(node) if where == "prompt" else (access.text(node) if node_kind == "text" else body)
            # 片段里的 @{id} 换成 @标题：模型看到的是人话，不是半截记号
            source = _MENTION_RE.sub(lambda m: "@" + (access.title(by_id[m.group(1)]) or m.group(1))
                                     if m.group(1) in by_id else "@" + m.group(1), source)
            pos = source.lower().find(terms[0])
            start = max(0, pos - 30)
            snippet = " ".join(source[start:start + 120].split())
        row: Dict[str, Any] = {"id": node.get("id"), "kind": node_kind, "title": access.title(node)}
        node_status = access.status(node)
        if node_status:
            row["status"] = node_status
        if snippet:
            row["match"] = snippet
        scored.append((-score, float(node.get("y") or 0), float(node.get("x") or 0), row))
    scored.sort(key=lambda item: item[:3])
    out: Dict[str, Any] = {"total": len(scored), "nodes": [item[3] for item in scored[:limit]]}
    if not scored:
        out["hint"] = "没有命中。换个关键词，或去掉 kind / status 过滤再试"
    elif len(scored) > limit:
        out["hint"] = "还有 %d 个命中没列出，加关键词或过滤条件缩小范围" % (len(scored) - limit)
    return out


def read_table(canvas: Dict[str, Any], node_id: Any, start: int = 0, limit: int = 20,
               access: Optional[CanvasAccess] = None) -> Dict[str, Any]:
    access = access or CanvasAccess()
    node = resolve_node(canvas, node_id, access)
    if node is None:
        raise ReadToolError("节点 %s 不存在" % node_id, code="node_not_found")
    if access.kind(node) != "table":
        raise ReadToolError("「%s」不是多维表格节点" % (access.title(node) or node_id))
    table = access.table(node)
    try:
        start = max(0, int(start or 0))
        limit = max(1, min(int(limit or 20), TABLE_ROWS_MAX))
    except (TypeError, ValueError):
        start, limit = 0, 20
    by_id = access.by_id(canvas)
    rows = []
    for offset, row in enumerate(table["rows"][start:start + limit]):
        cells = [_MENTION_RE.sub(lambda m: "@%s（%s）" % (access.title(by_id[m.group(1)]) or m.group(1), m.group(1))
                                 if m.group(1) in by_id else m.group(0), str(c)) for c in row]
        rows.append({"row": start + offset + 1, "cells": cells})
    nid = str(node.get("id"))
    inputs = [{"id": str(e.get("from")), "kind": access.kind(by_id[str(e.get("from"))]),
               "title": access.title(by_id[str(e.get("from"))])}
              for e in access.edges(canvas) if str(e.get("to")) == nid and str(e.get("from")) in by_id]
    out: Dict[str, Any] = {"id": nid, "title": access.title(node), "columns": table["columns"],
                           "row_count": len(table["rows"]), "rows": rows, "inputs": inputs}
    modes = table["raw"].get("inputModes") or table["raw"].get("input_modes")
    if isinstance(modes, dict) and modes:
        out["input_modes"] = modes
    if start + limit < len(table["rows"]):
        out["hint"] = "还有 %d 行，用 start=%d 接着读" % (len(table["rows"]) - start - limit, start + limit)
    return out


def _fingerprint(node: Dict[str, Any], access: CanvasAccess) -> Dict[str, Any]:
    table = access.table(node) if access.kind(node) == "table" else None
    return {
        "title": access.title(node),
        "prompt": access.raw_prompt(node),
        "text": access.text(node),
        "result": access.url(node),
        "settings": json.dumps(access.params(node), ensure_ascii=False, sort_keys=True),
        "table": json.dumps([table["columns"], table["rows"]], ensure_ascii=False) if table else "",
        "members": ",".join(str(c) for c in (node.get("children") or [])),
    }


def canvas_diff(old: Optional[Dict[str, Any]], new: Dict[str, Any], access: Optional[CanvasAccess] = None,
                limit: int = 40) -> Dict[str, Any]:
    """两份快照的差异（不比位置和尺寸——挪一下节点不算「改了内容」）。"""
    access = access or CanvasAccess()
    if not isinstance(old, dict):
        return {"available": False, "message": "没有可对比的旧快照"}
    before, after = access.by_id(old), access.by_id(new)
    created = [{"id": nid, "kind": access.kind(n), "title": access.title(n)} for nid, n in after.items() if nid not in before]
    deleted = [{"id": nid, "kind": access.kind(n), "title": access.title(n)} for nid, n in before.items() if nid not in after]
    modified = []
    for nid, node in after.items():
        if nid not in before:
            continue
        a, b = _fingerprint(before[nid], access), _fingerprint(node, access)
        changed = [key for key in a if a[key] != b[key]]
        if changed:
            modified.append({"id": nid, "kind": access.kind(node), "title": access.title(node), "changed": changed})
    edge_key = lambda e: (str(e.get("from")), str(e.get("to")))
    old_edges, new_edges = {edge_key(e) for e in access.edges(old)}, {edge_key(e) for e in access.edges(new)}
    out: Dict[str, Any] = {
        "available": True,
        "created": created[:limit], "deleted": deleted[:limit], "modified": modified[:limit],
        "connections_added": [{"from": a, "to": b} for a, b in sorted(new_edges - old_edges)][:limit],
        "connections_removed": [{"from": a, "to": b} for a, b in sorted(old_edges - new_edges)][:limit],
    }
    out["unchanged"] = not any(out[k] for k in ("created", "deleted", "modified", "connections_added", "connections_removed"))
    total = len(created) + len(deleted) + len(modified)
    if total > limit:
        out["hint"] = "改动较多，只列了每类前 %d 个" % limit
    return out


def view_image(canvas: Dict[str, Any], node_id: Any = "", url: str = "", question: str = "",
               access: Optional[CanvasAccess] = None) -> Dict[str, Any]:
    """登记「下一轮把这张图给模型看」。真正把图挂进消息由循环做（context_engine.attach_images）；
    模型不能直接看图时，循环按原有的看图转述流程把画面描述写进这条结果。"""
    access = access or CanvasAccess()
    label = ""
    if node_id:
        node = resolve_node(canvas, node_id, access)
        if node is None:
            raise ReadToolError("节点 %s 不存在" % node_id, code="node_not_found")
        kind = access.kind(node)
        current = access.out(node)
        if kind == "image":
            url = access.url(node)
        elif kind == "video":
            url = str(current.get("frame") or "").strip()
            if not url:
                raise ReadToolError("「%s」这个视频没有封面帧可看" % (access.title(node) or node_id))
        else:
            raise ReadToolError("「%s」是 %s 节点，不是图片或视频" % (access.title(node) or node_id, kind))
        if not url:
            raise ReadToolError("「%s」还没有结果，没有图可看" % (access.title(node) or node_id))
        label = access.title(node) or str(node.get("id"))
    url = str(url or "").strip()
    if not url:
        raise ReadToolError("要给 node_id 或 url")
    return {"view_images": [{"url": url, "label": label or "图片"}], "question": str(question or "")[:500],
            "message": "已安排在下一轮查看「%s」" % (label or "这张图")}


def recall_step(transcript: Any, index: Any) -> Dict[str, Any]:
    entry = transcript.step(index) if transcript is not None else None
    if entry is None:
        raise ReadToolError("本次运行里没有编号为 %s 的步骤" % index, code="invalid_args")
    out = {"index": entry.get("index"), "tool": entry.get("tool"), "ok": bool(entry.get("ok")),
           "args": entry.get("args") or {}}
    if entry.get("ok"):
        out["result"] = entry.get("text") or ""
    else:
        out["error"] = entry.get("error") or ""
    return out


# ---------------------------------------------------------------------------
# 工具定义 + 接线：tool_entries(...) 返回 AGENT_TOOLS 同形状的条目
# ---------------------------------------------------------------------------

READ_TOOL_NAMES = ("read_node", "search_canvas", "read_table", "canvas_diff", "view_image", "recall_step")

TOOL_SPECS: Dict[str, Dict[str, Any]] = {
    "read_node": {
        "description": "读节点的完整信息：文本节点全文、提示词原文、生成参数、上下游、结果地址、版本数、分组成员。"
                       "画布地图里每个节点只有一行概要，要改写 / 引用某个节点的内容前先用它读全。一次最多 %d 个。" % READ_NODE_MAX,
        "schema": {"type": "object", "properties": {
            "canvas_id": {"type": "string", "description": "目标画布 ID；不填就用本次运行所属的画布（也就是当前画布）。不要填画布标题。"},
            "node_ids": {"type": "array", "items": {"type": "string"}, "description": "节点 id（也可以写节点标题）"},
            "fields": {"type": "array", "items": {"type": "string"},
                       "description": "可选：只要这些字段（text / prompt / settings / upstream / downstream / members …），不写返回全部"}},
            "required": ["node_ids"]},
    },
    "search_canvas": {
        "description": "在画布上找节点：query 的每个词都要在标题 / 提示词 / 正文 / 表格内容里出现；可按 kind、status 过滤。"
                       "用户用内容描述节点（「那个写着口播的文本」「失败的那几个视频」）时用它定位，不要猜 id。",
        "schema": {"type": "object", "properties": {
            "canvas_id": {"type": "string", "description": "目标画布 ID；不填就用本次运行所属的画布（也就是当前画布）。不要填画布标题。"},
            "query": {"type": "string", "description": "关键词，空格分隔；可以为空（只按 kind / status 过滤）"},
            "kind": {"type": "string", "enum": ["image", "video", "audio", "text", "table", "group", "timeline"]},
            "status": {"type": "string", "enum": list(STATUS_CODES),
                       "description": "empty=还没生成 done=有结果 failed=上次失败 pending=等待生成 uploaded=用户上传的素材"},
            "limit": {"type": "integer", "description": "最多返回几个，默认 10，最多 %d" % SEARCH_LIMIT_MAX}}},
    },
    "read_table": {
        "description": "读多维表格节点：列名、指定范围的行（单元格原文）、输入通道和每条通道的模式。",
        "schema": {"type": "object", "properties": {
            "canvas_id": {"type": "string", "description": "目标画布 ID；不填就用本次运行所属的画布（也就是当前画布）。不要填画布标题。"}, "node_id": {"type": "string"},
            "start": {"type": "integer", "description": "从第几行开始（0 起），默认 0"},
            "limit": {"type": "integer", "description": "读几行，默认 20，最多 %d" % TABLE_ROWS_MAX}},
            "required": ["node_id"]},
    },
    "canvas_diff": {
        "description": "看用户在两次对话之间手动改了画布的什么：新建 / 删除 / 改动的节点（改了标题、提示词、正文、结果、参数中的哪几项）和连线变化。"
                       "用户说「我刚改了」「我调过了」或画布状态和你记得的不一样时用。",
        "schema": {"type": "object", "properties": {"canvas_id": {"type": "string", "description": "目标画布 ID；不填就用本次运行所属的画布（也就是当前画布）。不要填画布标题。"}}},
    },
    "view_image": {
        "description": "再看一张图：把某个图片节点的当前结果（视频节点看封面帧）在下一轮交给你看。"
                       "检查生成结果、对比参考图、读图里的文字或细节时用。question 写你想确认什么。",
        "schema": {"type": "object", "properties": {
            "canvas_id": {"type": "string", "description": "目标画布 ID；不填就用本次运行所属的画布（也就是当前画布）。不要填画布标题。"}, "node_id": {"type": "string"},
            "url": {"type": "string", "description": "没有节点时直接给图片地址（必须是画布快照 / 工具结果里真实出现过的）"},
            "question": {"type": "string"}}},
    },
    "recall_step": {
        "description": "取回本次运行里某个步骤的结果原文。执行记录里标着「已折叠」的结果，需要原文时用它按 index 取。",
        "schema": {"type": "object", "properties": {"index": {"type": "integer", "description": "步骤编号（执行记录里的 #N）"}},
                   "required": ["index"]},
    },
}


def tool_entries(load_canvas: Callable[[str], Dict[str, Any]],
                 get_transcript: Optional[Callable[[], Any]] = None,
                 load_baseline: Optional[Callable[[str], Optional[Dict[str, Any]]]] = None,
                 access: Optional[CanvasAccess] = None,
                 error_cls: Optional[type] = None) -> Dict[str, Dict[str, Any]]:
    """生成可以直接 AGENT_TOOLS.update(...) 的条目。

    load_canvas(canvas_id) → 画布 dict（找不到自己抛错）
    get_transcript() → 当前运行的 Transcript（recall_step 用；没有就返回 None）
    load_baseline(canvas_id) → 用来对比的旧快照（上次助手运行结束时的画布；没有返回 None）
    error_cls → 抛给循环的异常类（main.AgentToolError：__init__(message, code=...)）；缺省用 ReadToolError"""
    access = access or CanvasAccess()
    error_cls = error_cls or ReadToolError

    def guard(fn: Callable[..., Any]) -> Callable[..., Any]:
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            try:
                return fn(*args, **kwargs)
            except ReadToolError as exc:
                if error_cls is ReadToolError:
                    raise
                raise error_cls(exc.message, code=exc.code)
        return wrapped

    def need_canvas(args: Dict[str, Any]) -> str:
        canvas_id = str((args or {}).get("canvas_id") or "").strip()
        if not canvas_id:
            raise ReadToolError("canvas_id 不能为空")
        load_canvas(canvas_id)       # 不存在由 load_canvas 自己抛
        return canvas_id

    def v_read_node(args):
        canvas_id = need_canvas(args)
        ids = args.get("node_ids")
        if isinstance(ids, str):
            ids = [ids]
        if not ids and args.get("node_id"):
            ids = [args.get("node_id")]
        ids = [str(i).strip() for i in (ids or []) if str(i).strip()]
        if not ids:
            raise ReadToolError("node_ids 不能为空")
        fields = [str(f) for f in (args.get("fields") or [])] if isinstance(args.get("fields"), list) else []
        return {"canvas_id": canvas_id, "node_ids": ids[:READ_NODE_MAX], "fields": fields}

    def v_search(args):
        canvas_id = need_canvas(args)
        status = str(args.get("status") or "").strip().lower()
        if status and status not in STATUS_CODES:
            raise ReadToolError("status 只能是 " + " / ".join(STATUS_CODES))
        return {"canvas_id": canvas_id, "query": str(args.get("query") or "")[:200],
                "kind": str(args.get("kind") or "").strip().lower(), "status": status, "limit": args.get("limit") or 10}

    def v_table(args):
        canvas_id = need_canvas(args)
        node_id = str(args.get("node_id") or "").strip()
        if not node_id:
            raise ReadToolError("node_id 不能为空")
        return {"canvas_id": canvas_id, "node_id": node_id, "start": args.get("start") or 0, "limit": args.get("limit") or 20}

    def v_view(args):
        canvas_id = need_canvas(args)
        node_id, url = str(args.get("node_id") or "").strip(), str(args.get("url") or "").strip()
        if not node_id and not url:
            raise ReadToolError("要给 node_id 或 url")
        return {"canvas_id": canvas_id, "node_id": node_id, "url": url, "question": str(args.get("question") or "")}

    def v_recall(args):
        try:
            index = int((args or {}).get("index"))
        except (TypeError, ValueError):
            raise ReadToolError("index 必须是步骤编号（整数）")
        return {"index": index}

    def r_diff(args):
        baseline = load_baseline(args["canvas_id"]) if load_baseline else None
        return canvas_diff(baseline, load_canvas(args["canvas_id"]), access)

    runs = {
        "read_node": (v_read_node, lambda a: read_node(load_canvas(a["canvas_id"]), a["node_ids"], a["fields"], access),
                      lambda a, c: "读取 %d 个节点的完整信息" % len(a.get("node_ids") or [])),
        "search_canvas": (v_search, lambda a: search_canvas(load_canvas(a["canvas_id"]), a["query"], a["kind"], a["status"], a["limit"], access),
                          lambda a, c: "在画布上查找「%s」" % (a.get("query") or a.get("kind") or a.get("status") or "节点")),
        "read_table": (v_table, lambda a: read_table(load_canvas(a["canvas_id"]), a["node_id"], a["start"], a["limit"], access),
                       lambda a, c: "读取表格内容"),
        "canvas_diff": (lambda a: {"canvas_id": need_canvas(a)}, r_diff, lambda a, c: "查看画布自上次对话以来的改动"),
        "view_image": (v_view, lambda a: view_image(load_canvas(a["canvas_id"]), a["node_id"], a["url"], a["question"], access),
                       lambda a, c: "查看图片"),
        "recall_step": (v_recall, lambda a: recall_step(get_transcript() if get_transcript else None, a["index"]),
                        lambda a, c: "取回第 %s 步的结果原文" % a.get("index")),
    }
    entries: Dict[str, Dict[str, Any]] = {}
    for name in READ_TOOL_NAMES:
        validate, run, preview = runs[name]
        entries[name] = {"description": TOOL_SPECS[name]["description"], "schema": TOOL_SPECS[name]["schema"],
                         "validate": guard(validate), "run": guard(run), "preview": preview, "mutates_canvas": False}
    return entries
