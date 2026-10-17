#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""智能体注册表：内置默认 + 用户可改的 data/agents/*.json。

契约字段（冻结，前端按此对接）：
    id / name / category / icon / description / tags / input_schema / deliverables /
    skill_prompt / enabled / available；可选新增字段（缺省不影响既有调用方）：
    source_agent_id（sealseek 智能体 id）/ unavailable_reason（即将上线原因）

规则：
- 内置默认来自 builtin_agents.json（sealseek 智能体广场真实目录 27 个），名称与一句话
  描述与线上目录一致；sealseek 的智能体 id 记在 source_agent_id；分类与平台 tag 一一对应；
- 「能靠上传表格/文本跑通的」available=true 并接上运行时；「需要平台 API / 图片输入 /
  视频输入 / 生图」的一律 available=false，原因写进 unavailable_reason（不假装能做）；
- 关键词找钱模型 / 优势找钱模型在 sealseek 里属于技能，已迁到 server/skills/registry.py，
  本目录不再重复放；catalog 会按技能 id 过滤掉同名用户条目；
- data/agents/ 不存在时把内置默认写盘，用户可以直接改这些 JSON。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

AGENT_FIELDS = ("id", "name", "category", "icon", "description", "tags",
                "input_schema", "deliverables", "skill_prompt", "enabled", "available",
                "source_agent_id", "unavailable_reason", "suggestions")

# sealseek 平台 id -> 名称（来自 /api/agent/superSearch/platformList）
PLATFORM_NAMES = {
    1: "淘宝天猫", 3: "抖音电商", 4: "小红书", 5: "拼多多",
    6: "1688", 7: "京东", 8: "亚马逊", 9: "私域", 10: "财税",
}

_DATA_DIR = ""


def set_data_dir(path: str) -> None:
    global _DATA_DIR
    _DATA_DIR = str(path or "")


def _project_root() -> str:
    # server/agents/registry.py -> 项目根目录
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def data_dir() -> str:
    if _DATA_DIR:
        return _DATA_DIR
    root = os.environ.get("NOVAI_DATA_DIR") or _project_root()
    return os.path.join(root, "data")


def agents_dir() -> str:
    return os.path.join(data_dir(), "agents")


# 内置默认来自 server/agents/builtin_agents.json（sealseek 智能体广场真实目录，27 个）。
# 这份 JSON 就是智能体目录的数据源；data/agents/*.json 里同 id 的条目覆盖内置，多出来的条目追加。
_BUILTIN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "builtin_agents.json")
_BUILTIN_CACHE = None


def load_builtin() -> List[Dict[str, Any]]:
    global _BUILTIN_CACHE
    if _BUILTIN_CACHE is not None:
        return _BUILTIN_CACHE
    try:
        with open(_BUILTIN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        print("[Agents] 读取内置智能体目录失败 %s: %s" % (_BUILTIN_FILE, exc))
        data = []
    _BUILTIN_CACHE = [d for d in data if isinstance(d, dict)]
    return _BUILTIN_CACHE


BUILTIN_AGENTS = load_builtin()


def _normalize_agent(raw):
    """把一条注册表条目收敛成契约字段；缺 id 视为脏数据丢弃。"""
    if not isinstance(raw, dict):
        return None
    aid = str(raw.get("id") or "").strip()
    if not aid:
        return None
    tags = raw.get("tags")
    if isinstance(tags, list):
        tags = [str(t) for t in tags if str(t or "").strip()]
    else:
        tags = []
    if not tags:
        ids = raw.get("platform_ids")
        if isinstance(ids, list):
            tags = [PLATFORM_NAMES[i] for i in ids if i in PLATFORM_NAMES]
    deliverables = raw.get("deliverables")
    deliverables = [d for d in deliverables if isinstance(d, dict)] if isinstance(deliverables, list) else []
    schema = raw.get("input_schema")
    schema = schema if isinstance(schema, dict) else {"files": [], "params": []}
    try:
        source_agent_id = int(raw.get("source_agent_id") or 0)
    except (TypeError, ValueError):
        source_agent_id = 0
    suggestions = raw.get("suggestions")
    suggestions = [s for s in suggestions
                   if isinstance(s, dict) and str(s.get("text") or "").strip()] if isinstance(suggestions, list) else []
    return {
        "id": aid,
        "name": str(raw.get("name") or aid).strip(),
        "category": str(raw.get("category") or "未分类").strip(),
        "icon": str(raw.get("icon") or "").strip(),
        "description": str(raw.get("description") or "").strip(),
        "tags": tags,
        "input_schema": schema,
        "deliverables": deliverables,
        "skill_prompt": str(raw.get("skill_prompt") or ""),
        "enabled": bool(raw.get("enabled", True)),
        "available": bool(raw.get("available", True)),
        "source_agent_id": source_agent_id,
        "unavailable_reason": str(raw.get("unavailable_reason") or "").strip(),
        "suggestions": suggestions,
    }


def _read_user_agents():
    out = []
    folder = agents_dir()
    if not os.path.isdir(folder):
        return out
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".json"))
    except OSError:
        return out
    for name in names:
        path = os.path.join(folder, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as exc:
            print("[Agents] 读取注册表条目失败 %s: %s" % (path, exc))
            continue
        items = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
        for item in items:
            norm = _normalize_agent(item)
            if norm:
                out.append(norm)
    return out


def _seed_builtin():
    """首次运行且目录不存在时，把内置默认写盘，方便用户直接改。"""
    folder = agents_dir()
    if os.path.isdir(folder):
        return
    try:
        os.makedirs(folder, exist_ok=True)
        for agent in BUILTIN_AGENTS:
            path = os.path.join(folder, "%s.json" % agent["id"])
            with open(path, "w", encoding="utf-8") as f:
                json.dump(_normalize_agent(agent), f, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("[Agents] 写入默认注册表失败（不影响使用）: %s" % exc)


def load_agents():
    """合并「内置默认 + 用户注册表」：同 id 用户覆盖内置，用户独有条目追加。"""
    _seed_builtin()
    user = _read_user_agents()
    user_by_id = {}
    for item in user:
        user_by_id[item["id"]] = item
    merged = []
    seen = set()
    for builtin in BUILTIN_AGENTS:
        norm = _normalize_agent(builtin)
        if not norm:
            continue
        merged.append(user_by_id.get(norm["id"], norm))
        seen.add(norm["id"])
    for item in user:
        if item["id"] not in seen:
            merged.append(item)
            seen.add(item["id"])
    return merged


def get_agent(agent_id):
    aid = str(agent_id or "").strip()
    if not aid:
        return None
    for agent in load_agents():
        if agent["id"] == aid:
            return agent
    return None


def public_agent(agent, kind: str = "agent"):
    """列表接口字段（契约冻结；source_agent_id / unavailable_reason 为可选新增字段）。"""
    return {
        "id": agent.get("id"),
        "kind": kind,
        "name": agent.get("name"),
        "category": agent.get("category"),
        "icon": agent.get("icon"),
        "description": agent.get("description"),
        "tags": agent.get("tags") or [],
        "deliverables": agent.get("deliverables") or [],
        "enabled": bool(agent.get("enabled", True)),
        "available": bool(agent.get("available", True)),
        "source_agent_id": int(agent.get("source_agent_id") or 0),
        "unavailable_reason": str(agent.get("unavailable_reason") or ""),
    }
