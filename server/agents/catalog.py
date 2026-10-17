#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一能力目录：把「智能体」与「技能」合成一份契约一致的清单。

- 技能优先：/api/capabilities/{id} 先查技能再查智能体（关键词找钱 / 优势找钱
  已按 sealseek 真实归属迁到技能目录，同 id 不会再出现在智能体目录里）；
- /api/agents 仍然只返回 kind='agent'，字段与第一批完全一致（只新增 available）；
- 这里只做「读取 + 拼装」，不持有任何状态。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from server.agents import platforms as platforms_registry
from server.agents import registry as agents_registry
from server.agents import store as agents_store
from server.agents import suggestions as suggestions_registry
from server.agents import tutorials as tutorials_registry
from server.skills import registry as skills_registry


def list_skills() -> List[Dict[str, Any]]:
    return skills_registry.load_skills()


def list_agents() -> List[Dict[str, Any]]:
    """智能体目录：剔除与内置技能同 id 的条目（历史 data/agents/keyword-money.json 等）。"""
    taken = set(skills_registry.skill_ids())
    return [a for a in agents_registry.load_agents() if a.get("id") not in taken]


def list_capabilities() -> List[Dict[str, Any]]:
    """统一清单：智能体在前、技能在后，每项都带 kind 与 available。

    技能的 usage_count 用真实运行记录（server/agents/store.usage_counts）算出来。
    """
    items = []
    for agent in list_agents():
        items.append(agents_registry.public_agent(agent, kind="agent"))
    counts = agents_store.usage_counts()
    for skill in list_skills():
        items.append(skills_registry.public_skill(
            skill, kind="skill", usage_count=counts.get(str(skill.get("id")), 0)))
    for item in items:
        _attach_tutorial(item)
    return items


def _attach_tutorial(item: Dict[str, Any]) -> Dict[str, Any]:
    """声明了教程的能力才带 tutorial 字段（数据源 server/agents/tutorials.json）。"""
    tutorial = tutorials_registry.tutorial_for(str(item.get("id") or ""))
    if tutorial:
        item["tutorial"] = tutorial
    return item


def get_capability(capability_id: str) -> Tuple[Optional[Dict[str, Any]], str]:
    """按 id 取能力，返回 (能力定义, kind)；找不到返回 (None, '')。"""
    cid = str(capability_id or "").strip()
    if not cid:
        return None, ""
    skill = skills_registry.get_skill(cid)
    if skill:
        return skill, "skill"
    agent = agents_registry.get_agent(cid)
    if agent:
        return agent, "agent"
    return None, ""


def public_capability(capability: Dict[str, Any], kind: str) -> Dict[str, Any]:
    if kind == "skill":
        return skills_registry.public_skill(capability, kind="skill")
    return agents_registry.public_agent(capability, kind="agent")


def capability_detail(capability: Dict[str, Any], kind: str) -> Dict[str, Any]:
    """详情：列表字段 + input_schema + 技能特有的平台/场景/用法说明。"""
    detail = dict(public_capability(capability, kind))
    if kind == "skill":
        counts = agents_store.usage_counts()
        detail["usage_count"] = counts.get(str(capability.get("id")), 0)
    detail["input_schema"] = capability.get("input_schema") or {"files": [], "params": []}
    detail["usage_instruction"] = capability.get("usage_instruction") or ""
    detail["platforms"] = capability.get("platforms") or []
    detail["scenarios"] = capability.get("scenarios") or []
    detail["source_skill_code"] = capability.get("source_skill_code") or ""
    _attach_tutorial(detail)
    return detail


def required_files(capability: Dict[str, Any]) -> List[Dict[str, Any]]:
    schema = capability.get("input_schema") or {}
    files = schema.get("files")
    if not isinstance(files, list):
        return []
    return [f for f in files if isinstance(f, dict) and f.get("required")]


def list_platforms() -> List[Dict[str, Any]]:
    """平台筛选栏数据（数据源见 server/agents/platforms.py）。"""
    return platforms_registry.list_platforms()


def capability_descriptor(cap: Dict[str, Any], kind: str) -> Dict[str, Any]:
    """把能力定义转成 sealseek 形态的 capability 描述符（agent / skill 两类）。"""
    if kind == "skill":
        return {
            "type": "skill",
            "capabilityId": cap.get("id") or "",
            "skillCode": cap.get("source_skill_code") or "",
            "skillName": cap.get("name") or "",
            "name": cap.get("name") or "",
        }
    return {
        "type": "agent",
        "capabilityId": cap.get("id") or "",
        "agentId": int(cap.get("source_agent_id") or 0),
        "name": cap.get("name") or "",
    }


def list_suggestions() -> List[Dict[str, Any]]:
    """「猜你想问」：文案来自 suggestions 默认/配置，描述符按能力目录实时拼装。"""
    agents = {a["id"]: a for a in list_agents()}
    skills = {s["id"]: s for s in list_skills()}
    out = []
    for item in suggestions_registry.load_suggestions(agents_registry.data_dir()):
        cid = item.get("capability_id") or ""
        cap = agents.get(cid) or skills.get(cid)
        kind = "agent" if cid in agents else ("skill" if cid in skills else "")
        if not cid:
            descriptor = {"type": "generate-image", "cardType": item.get("card_type") or 0}
        elif cap:
            descriptor = capability_descriptor(cap, kind)
        else:
            continue
        out.append({
            "id": item.get("id") or item.get("text"),
            "text": item.get("text"),
            "icon_type": item.get("icon_type") or "",
            "capability": descriptor,
            "available": bool(cap.get("available", True)) if cap else True,
        })
    return out
