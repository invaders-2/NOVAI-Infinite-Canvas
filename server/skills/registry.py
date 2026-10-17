#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""技能注册表：内置默认（server/skills/builtin_skills.json）+ 用户可改的 data/skills/*.json。

契约字段（与智能体一致，前端按 kind='skill' 渲染）：
    id / kind='skill' / name / category / icon / description / tags /
    input_schema / deliverables / skill_prompt / enabled / available

规则与 server/agents/registry.py 保持一致：
- 内置默认来自 sealseek 导出的 16 个技能原文（tools/build_builtin_skills.py 生成），
  只把「读取 / 交付」动作适配成 read_table / write_html_report / write_xlsx；
- data/skills/ 不存在时把内置默认写盘，用户可以直接改这些 JSON；
- data/skills/*.json 里同 id 的条目覆盖内置，多出来的条目追加。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional

SKILL_FIELDS = ("id", "name", "category", "icon", "description", "tags", "input_schema",
                "deliverables", "skill_prompt", "enabled", "available", "usage_instruction",
                "platforms", "scenarios", "source_skill_code", "skill_type")

SKILL_TYPES = ("system", "mine", "subscribe")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

_BUILTIN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "builtin_skills.json")

_DATA_DIR = ""
_BUILTIN_CACHE = None


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


def skills_dir() -> str:
    return os.path.join(data_dir(), "skills")


def load_builtin() -> List[Dict[str, Any]]:
    global _BUILTIN_CACHE
    if _BUILTIN_CACHE is not None:
        return _BUILTIN_CACHE
    try:
        with open(_BUILTIN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        print("[Skills] 读取内置技能失败 %s: %s" % (_BUILTIN_FILE, exc))
        data = []
    _BUILTIN_CACHE = [d for d in data if isinstance(d, dict)]
    return _BUILTIN_CACHE


def _normalize_skill(raw):
    if not isinstance(raw, dict):
        return None
    sid = str(raw.get("id") or "").strip()
    if not sid:
        return None
    tags = raw.get("tags")
    tags = [str(t) for t in tags if str(t or "").strip()] if isinstance(tags, list) else []
    deliverables = raw.get("deliverables")
    deliverables = [d for d in deliverables if isinstance(d, dict)] if isinstance(deliverables, list) else []
    schema = raw.get("input_schema")
    schema = schema if isinstance(schema, dict) else {"files": [], "params": []}
    platforms = raw.get("platforms")
    platforms = [str(p) for p in platforms] if isinstance(platforms, list) else []
    scenarios = raw.get("scenarios")
    scenarios = [str(s) for s in scenarios] if isinstance(scenarios, list) else []
    return {
        "id": sid,
        "name": str(raw.get("name") or sid).strip(),
        "category": str(raw.get("category") or "未分类").strip(),
        "icon": str(raw.get("icon") or "").strip(),
        "description": str(raw.get("description") or "").strip(),
        "tags": tags,
        "platforms": platforms,
        "scenarios": scenarios,
        "usage_instruction": str(raw.get("usage_instruction") or "").strip(),
        "source_skill_code": str(raw.get("source_skill_code") or "").strip(),
        "input_schema": schema,
        "deliverables": deliverables,
        "skill_prompt": str(raw.get("skill_prompt") or ""),
        "enabled": bool(raw.get("enabled", True)),
        "available": bool(raw.get("available", True)),
        "skill_type": str(raw.get("skill_type") or "").strip().lower(),
    }


def _builtin_ids():
    """内置技能 id 集合：不在里面的 = 用户自己加进来的（技能面板的「我的技能」）。"""
    return {str(d.get("id") or "") for d in load_builtin()}


def _read_user_skills():
    out = []
    folder = skills_dir()
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
            print("[Skills] 读取注册表条目失败 %s: %s" % (path, exc))
            continue
        items = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
        for item in items:
            norm = _normalize_skill(item)
            if norm:
                out.append(norm)
    return out


def _seed_builtin():
    folder = skills_dir()
    if os.path.isdir(folder):
        return
    try:
        os.makedirs(folder, exist_ok=True)
        for skill in load_builtin():
            path = os.path.join(folder, "%s.json" % skill.get("id"))
            with open(path, "w", encoding="utf-8") as f:
                json.dump(skill, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("[Skills] 写入默认注册表失败（不影响使用）: %s" % exc)


def load_skills():
    """合并「内置默认 + 用户注册表」：同 id 用户覆盖内置，用户独有条目追加。"""
    _seed_builtin()
    user = _read_user_skills()
    user_by_id = {}
    for item in user:
        user_by_id[item["id"]] = item
    merged = []
    seen = set()
    for builtin in load_builtin():
        norm = _normalize_skill(builtin)
        if not norm:
            continue
        merged.append(user_by_id.get(norm["id"], norm))
        seen.add(norm["id"])
    for item in user:
        if item["id"] not in seen:
            merged.append(item)
            seen.add(item["id"])
    return merged


def skill_ids() -> List[str]:
    return [s["id"] for s in load_builtin()]


def get_skill(skill_id):
    sid = str(skill_id or "").strip()
    if not sid:
        return None
    for skill in load_skills():
        if skill["id"] == sid:
            return skill
    return None


def public_skill(skill, kind: str = "skill", usage_count=None):
    """列表 / 详情字段（契约冻结；source_skill_code / skill_type / usage_count 为可选新增字段）。

    skill_type：条目自己声明了 system/mine/subscribe 就用它；没声明时，不在内置清单里的
    就是用户导入的，记「mine」，其余是「system」。没有订阅数据源，这个字段不会凭空造
    「subscribe」。
    usage_count：调用方传入的真实运行次数（server/agents/store.usage_counts），没给就是 0。
    """
    sid = str(skill.get("id") or "")
    declared = str(skill.get("skill_type") or "").strip().lower()
    if declared in SKILL_TYPES:
        skill_type = declared
    else:
        skill_type = "system" if sid in _builtin_ids() else "mine"
    return {
        "id": skill.get("id"),
        "kind": kind,
        "name": skill.get("name"),
        "category": skill.get("category"),
        "icon": skill.get("icon"),
        "description": skill.get("description"),
        "tags": skill.get("tags") or [],
        "deliverables": skill.get("deliverables") or [],
        "enabled": bool(skill.get("enabled", True)),
        "available": bool(skill.get("available", True)),
        "source_skill_code": str(skill.get("source_skill_code") or ""),
        "skill_type": skill_type,
        "usage_count": int(usage_count or 0),
    }


def import_skill(raw):
    """把一份技能定义写进 data/skills/{id}.json，返回 (定义, 是否新建)。

    校验不通过抛 ValueError。只收用户自己的技能：内置技能的 id 不允许被导入覆盖
    （内置同名条目在 data/skills 里有种子文件，写进去会顶掉系统技能）。
    """
    if not isinstance(raw, dict):
        raise ValueError("技能定义必须是 JSON 对象")
    if not str(raw.get("name") or "").strip():
        raise ValueError("技能定义缺少 name")
    skill = _normalize_skill(raw)
    if not skill:
        raise ValueError("技能定义缺少 id")
    if not _ID_RE.match(skill["id"]):
        raise ValueError("技能 id 只能由字母、数字、点、下划线和连字符组成，最长 64 位")
    if skill["id"] in _builtin_ids():
        raise ValueError("「%s」是内置技能的 id，导入不能覆盖系统技能" % skill["id"])
    folder = skills_dir()
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "%s.json" % skill["id"])
    created = not os.path.isfile(path)
    tmp = "%s.tmp" % path
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(skill, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return skill, created
