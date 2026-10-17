#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""能力教程：数据源是 server/agents/tutorials.json（按能力 id 声明，只有声明了的能力才带 tutorial）。

结构：
    {"<capability_id>": {"title": str, "steps": [{"text": str, "image": str(可省)}]}}

catalog 只在这里查一次：查得到就把 tutorial 放进目录/详情输出，查不到就不放 —— 前端据此
决定「查看教程」按钮显不显示，所以没写教程的能力（多数）不会凭空多出一个空教程。
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tutorials.json")
_CACHE = None


def _load() -> Dict[str, Any]:
    global _CACHE
    if _CACHE is None:
        try:
            with open(_FILE, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception as exc:
            print("[Tutorials] 读取教程失败 %s: %s" % (_FILE, exc))
            data = {}
        _CACHE = data if isinstance(data, dict) else {}
    return _CACHE


def _text(value: Any) -> str:
    return str(value or "").strip()


def tutorial_for(capability_id: str) -> Optional[Dict[str, Any]]:
    """取一份能力的教程；没有 / 结构不完整（缺标题或没有可用步骤）时返回 None。"""
    item = _load().get(_text(capability_id))
    if not isinstance(item, dict):
        return None
    title = _text(item.get("title"))
    steps = []
    for raw in item.get("steps") or []:
        if not isinstance(raw, dict):
            continue
        text = _text(raw.get("text"))
        if not text:
            continue
        step = {"text": text}
        image = _text(raw.get("image"))
        if image:
            step["image"] = image
        steps.append(step)
    if not title or not steps:
        return None
    return {"title": title, "steps": steps}
