#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""智能体运行记录与产物落地。

- 运行记录：{DATA_DIR}/agent_runs/{run_id}.json，供 GET /api/agents/runs/{run_id} 查询；
- 产物目录：{DATA_DIR}/agent_outputs/{run_id}/，HTML / xlsx 都落这里；
- 上传文件：{DATA_DIR}/agent_outputs/{run_id}/uploads/。

只依赖标准库，避免与 main.py 形成循环 import。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from threading import Lock
from typing import Any, Dict, List, Optional

_LOCK = Lock()
_DATA_DIR = ""
# usage_counts 的缓存键：运行目录的 (文件数, mtime)。新增/写回 run 都会动目录 mtime。
_USAGE_CACHE = {"key": None, "counts": {}}


def set_data_dir(path: str) -> None:
    global _DATA_DIR
    _DATA_DIR = str(path or "")


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def data_dir() -> str:
    if _DATA_DIR:
        return _DATA_DIR
    root = os.environ.get("NOVAI_DATA_DIR") or _project_root()
    return os.path.join(root, "data")


def runs_dir() -> str:
    return os.path.join(data_dir(), "agent_runs")


def usage_counts() -> Dict[str, int]:
    """按能力 id 统计已发起的运行次数（真实使用记录；没有记录就是空）。

    技能面板的「常用」按这个排序/筛选；数据只来自 agent_runs/*.json，不凭空造数。
    """
    folder = runs_dir()
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".json"))
        key = (len(names), os.path.getmtime(folder))
    except OSError:
        return {}
    with _LOCK:
        if _USAGE_CACHE["key"] == key:
            return dict(_USAGE_CACHE["counts"])
    counts: Dict[str, int] = {}
    for name in names:
        try:
            with open(os.path.join(folder, name), "r", encoding="utf-8") as f:
                record = json.load(f)
        except Exception:
            continue
        if not isinstance(record, dict):
            continue
        capability_id = str(record.get("capability_id") or record.get("agent_id") or "").strip()
        if capability_id:
            counts[capability_id] = counts.get(capability_id, 0) + 1
    with _LOCK:
        _USAGE_CACHE["key"] = key
        _USAGE_CACHE["counts"] = dict(counts)
    return counts


def outputs_dir() -> str:
    return os.path.join(data_dir(), "agent_outputs")


def run_output_dir(run_id: str) -> str:
    return os.path.join(outputs_dir(), _safe_id(run_id))


def run_uploads_dir(run_id: str) -> str:
    return os.path.join(run_output_dir(run_id), "uploads")


def run_path(run_id: str) -> str:
    return os.path.join(runs_dir(), "%s.json" % _safe_id(run_id))


def _safe_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "", str(value or ""))
    return cleaned[:80]


def new_run_id() -> str:
    return "run_%s" % uuid.uuid4().hex[:16]


def new_session_id() -> str:
    return "sess_%s" % uuid.uuid4().hex[:16]


def new_message_id() -> str:
    """会话消息 id（与 main.py 的对话消息一致，用裸 uuid hex）。"""
    return uuid.uuid4().hex


def safe_filename(name: str, default: str = "file") -> str:
    """只保留基名与安全字符，阻断路径穿越。"""
    base = os.path.basename(str(name or "").replace("\\", "/")).strip()
    base = re.sub(r"[^\w.\-()（）\u4e00-\u9fff ]+", "_", base, flags=re.UNICODE).strip(" .")
    if not base:
        base = default
    return base[:120]


def _write_json(path: str, data: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp.%s" % (path, uuid.uuid4().hex[:8])
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def create_run(agent_id: str, session_id: str, files: List[Dict[str, Any]],
               params: Dict[str, Any], provider: str = "", model: str = "",
               conversation_id: str = "", capability_id: str = "", capability_name: str = "",
               capability_kind: str = "", conversation_user_id: str = "") -> Dict[str, Any]:
    run_id = new_run_id()
    now = time.time()
    record = {
        "run_id": run_id,
        "session_id": session_id,
        "agent_id": str(agent_id or ""),
        # 会话作用域 run 的附加字段（对话里跑能力时才有值）
        "conversation_id": str(conversation_id or ""),
        "capability_id": str(capability_id or agent_id or ""),
        "capability_name": str(capability_name or ""),
        "capability_kind": str(capability_kind or "agent"),
        "conversation_user_id": str(conversation_user_id or ""),
        "assistant_message_id": "",
        "status": "running",
        "steps": [],
        "artifacts": [],
        "error": "",
        "created_at": now,
        "updated_at": now,
        "files": files or [],
        "params": params or {},
        "provider": provider or "",
        "model": model or "",
        "message": "",
        "rounds": 0,
        "steps_executed": 0,
    }
    os.makedirs(run_uploads_dir(run_id), exist_ok=True)
    os.makedirs(run_output_dir(run_id), exist_ok=True)
    save_run(record)
    return record


def load_run(run_id: str) -> Optional[Dict[str, Any]]:
    path = run_path(run_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception as exc:
        print("[Agents] 读取运行记录失败 %s: %s" % (path, exc))
        return None


def save_run(record: Dict[str, Any]) -> None:
    if not isinstance(record, dict) or not record.get("run_id"):
        return
    record["updated_at"] = time.time()
    with _LOCK:
        _write_json(run_path(record["run_id"]), record)


def update_run(run_id: str, **fields: Any) -> Optional[Dict[str, Any]]:
    with _LOCK:
        record = load_run(run_id)
        if not record:
            return None
        record.update(fields)
        record["updated_at"] = time.time()
        _write_json(run_path(run_id), record)
        return record


def append_step(run_id: str, step: Dict[str, Any]) -> None:
    with _LOCK:
        record = load_run(run_id)
        if not record:
            return
        record.setdefault("steps", []).append(step)
        record["updated_at"] = time.time()
        _write_json(run_path(run_id), record)


def artifact_url(run_id: str, name: str) -> str:
    from urllib.parse import quote
    return "/api/agents/runs/%s/files/%s" % (_safe_id(run_id), quote(safe_filename(name)))


def add_artifact(run_id: str, kind: str, name: str, path: str) -> Dict[str, Any]:
    """登记一个产物（幂等：同名同类型只登记一次）。"""
    name = safe_filename(name)
    item = {"kind": str(kind or ""), "name": name, "url": artifact_url(run_id, name)}
    with _LOCK:
        record = load_run(run_id)
        if not record:
            return item
        artifacts = record.setdefault("artifacts", [])
        if not any(a.get("kind") == item["kind"] and a.get("name") == item["name"] for a in artifacts):
            artifacts.append(item)
        record["updated_at"] = time.time()
        _write_json(run_path(run_id), record)
    return item


def is_safe_output_path(run_id: str, name: str) -> Optional[str]:
    """把请求里的文件名收成 run 产物目录下的真实文件路径；不合法返回 None。"""
    safe = safe_filename(name)
    if not safe or safe != os.path.basename(str(name or "").strip()):
        return None
    path = os.path.join(run_output_dir(run_id), safe)
    if os.path.commonpath([os.path.abspath(path), os.path.abspath(run_output_dir(run_id))]) != \
            os.path.abspath(run_output_dir(run_id)):
        return None
    return path if os.path.isfile(path) else None


def public_run(record: Dict[str, Any]) -> Dict[str, Any]:
    """GET /api/agents/runs/{run_id} 的返回体（契约冻结，字段名不改）。"""
    return {
        "run_id": record.get("run_id"),
        "agent_id": record.get("agent_id"),
        "status": record.get("status"),
        "steps": record.get("steps") or [],
        "artifacts": record.get("artifacts") or [],
        "error": record.get("error") or "",
        "created_at": record.get("created_at"),
        "updated_at": record.get("updated_at"),
        # 新增字段（原字段与顺序不变）；对话外的 run 这两个字段为空串
        "conversation_id": record.get("conversation_id") or "",
        "capability_id": record.get("capability_id") or record.get("agent_id") or "",
        "capability_name": record.get("capability_name") or "",
    }
