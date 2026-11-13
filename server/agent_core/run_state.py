# -*- coding: utf-8 -*-
"""阶段四·3：运行状态机（纯模块，不 import main）。

运行状态落盘 data/agent_run_states/{run_id}.json（与技能运行记录 data/agent_runs/ 分开），四种状态：
    running            运行中
    waiting_generation 等生成（挂起，不占轮次、不计入运行时长）
    waiting_user       等用户（方案卡 / 审查提问等）
    finished           结束

恢复所需字段：updated_at / created_at / autonomy / budget / round / steps / last_event_seq /
transcript_path / waiting_on / history / results / intent / roadmap / instruction / request 等。
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional

STATUS_RUNNING = "running"
STATUS_WAITING_GENERATION = "waiting_generation"
STATUS_WAITING_USER = "waiting_user"
STATUS_WAITING_BUDGET = "waiting_budget"     # 托管额度用完：挂起等用户补额度（POST /budget 后恢复）
STATUS_FINISHED = "finished"

STATUSES = (STATUS_RUNNING, STATUS_WAITING_GENERATION, STATUS_WAITING_USER, STATUS_WAITING_BUDGET,
            STATUS_FINISHED)
ACTIVE_STATUSES = (STATUS_RUNNING, STATUS_WAITING_GENERATION, STATUS_WAITING_USER,
                   STATUS_WAITING_BUDGET)

_STATE_FILENAME_SUFFIX = ".json"
_STATE_DIRNAME = "agent_run_states"
_LEGACY_DIRNAME = "agent_runs"


def new_state(run_id: str, canvas_id: str = "", **fields: Any) -> Dict[str, Any]:
    """新建一份运行状态（不落盘）。还没开始跑时默认 running。"""
    now = time.time()
    state: Dict[str, Any] = {
        "run_id": str(run_id or "").strip(),
        "canvas_id": str(canvas_id or "").strip(),
        "status": STATUS_RUNNING,
        "created_at": now,
        "updated_at": now,
        "autonomy": "collab",
        "budget": {},
        "round": 0,
        "steps": 0,
        "last_event_seq": 0,
        "transcript_path": "",
        "waiting_on": [],
        "history": [],
        "results": [],
        "intent": "",
        "roadmap": [],
        "instruction": "",
        "request": {},
        "error": "",
        "message": "",
    }
    state.update({key: value for key, value in fields.items() if value is not None})
    return state


def touch(state: Dict[str, Any], status: Optional[str] = None, **fields: Any) -> Dict[str, Any]:
    """更新状态副本：改 status / 字段，刷新 updated_at；状态非法直接报错（开发期尽早暴露）。"""
    if not isinstance(state, dict):
        raise TypeError("state 必须是 dict")
    if status is not None and status not in STATUSES:
        raise ValueError("非法运行状态：%r" % (status,))
    updated = dict(state)
    if status is not None:
        updated["status"] = status
    updated.update({key: value for key, value in fields.items() if value is not None})
    updated["updated_at"] = time.time()
    return updated


def is_active(state: Dict[str, Any]) -> bool:
    return isinstance(state, dict) and str(state.get("status") or "") in ACTIVE_STATUSES


def is_suspended(state: Dict[str, Any]) -> bool:
    return isinstance(state, dict) and str(state.get("status") or "") == STATUS_WAITING_GENERATION


def is_waiting_budget(state: Dict[str, Any]) -> bool:
    return isinstance(state, dict) and str(state.get("status") or "") == STATUS_WAITING_BUDGET


def states_dir(data_dir: str) -> str:
    return os.path.join(str(data_dir or ""), _STATE_DIRNAME)


def state_path(data_dir: str, run_id: str) -> str:
    safe = "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in str(run_id or "").strip())
    return os.path.join(states_dir(data_dir), safe + _STATE_FILENAME_SUFFIX)


def write_state(data_dir: str, state: Dict[str, Any]) -> bool:
    """原子写：写失败只返回 False（调用方记日志），绝不让状态机把运行弄挂。"""
    try:
        state = touch(state)
        path = state_path(data_dir, str(state.get("run_id") or ""))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temp = path + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, default=str)
        os.replace(temp, path)
        return True
    except Exception:
        return False


def read_state(data_dir: str, run_id: str) -> Dict[str, Any]:
    try:
        path = state_path(data_dir, run_id)
        if not os.path.exists(path):
            return {}
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def list_states(data_dir: str) -> List[Dict[str, Any]]:
    """扫描新状态目录里的全部运行状态（坏文件跳过），按 updated_at 倒序。"""
    directory = states_dir(data_dir)
    if not os.path.isdir(directory):
        return []
    states = []
    for name in os.listdir(directory):
        if not name.endswith(_STATE_FILENAME_SUFFIX):
            continue
        try:
            with open(os.path.join(directory, name), "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            continue
        if isinstance(data, dict) and data.get("run_id"):
            states.append(data)
    states.sort(key=lambda item: float(item.get("updated_at") or 0), reverse=True)
    return states


def active_states(data_dir: str) -> List[Dict[str, Any]]:
    return [state for state in list_states(data_dir) if is_active(state)]


def resumable_states(data_dir: str) -> List[Dict[str, Any]]:
    """重启后要自动恢复的：只有「等生成」的挂起运行；等用户的要用户再操作。"""
    return [state for state in active_states(data_dir) if is_suspended(state)]


def migrate_legacy_states(data_dir: str) -> List[str]:
    """把旧位置 data/agent_runs/*.json 里的运行状态搬到 data/agent_run_states/。

    data/agent_runs/ 现在只留给技能运行记录（含 agent_id / capability_id）与 .jsonl 转录：
    只迁移「含 autonomy 字段、且不含 agent_id / capability_id」的文件，搬到新目录后删除源文件，
    保证 data/agent_runs/ 只剩技能记录与 .jsonl。目标已存在（历史残留）也删源文件；坏文件、
    写目标失败则保留源文件（不能丢掉唯一副本）。重复执行幂等。返回本次迁移的 run_id 列表。"""
    legacy_dir = os.path.join(str(data_dir or ""), _LEGACY_DIRNAME)
    if not os.path.isdir(legacy_dir):
        return []
    moved: List[str] = []
    for name in os.listdir(legacy_dir):
        if not name.endswith(_STATE_FILENAME_SUFFIX):
            continue
        source = os.path.join(legacy_dir, name)
        try:
            with open(source, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        if "autonomy" not in data or data.get("agent_id") or data.get("capability_id"):
            continue
        run_id = str(data.get("run_id") or "").strip()
        if not run_id:
            continue
        target = state_path(data_dir, run_id)
        created = False
        if not os.path.exists(target):
            try:
                os.makedirs(states_dir(data_dir), exist_ok=True)
                temp = target + ".tmp"
                with open(temp, "w", encoding="utf-8") as handle:
                    json.dump(data, handle, ensure_ascii=False, default=str)
                os.replace(temp, target)
                created = True
            except Exception:
                continue          # 没搬成功：保留源文件，宁可下次再扫也不能丢唯一副本
        try:
            os.remove(source)     # 搬走 / 目标已存在（历史残留）：源文件都不再留在技能记录目录
        except OSError:
            continue
        if created:
            moved.append(run_id)
    return moved
