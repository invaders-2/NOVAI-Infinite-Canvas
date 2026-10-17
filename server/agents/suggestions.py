#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GPT 聊天输入框下方的「猜你想问」：默认数据 + 可配置覆盖。

- 每条只声明「文案 + 图标类型 + 指向哪个能力 id」，描述符由 catalog 从能力目录实时拼装，
  所以文案与能力永远对得上，前端不写死任何一条；
- data/chat_suggestions.json 存在时整表覆盖（用户可配置，不改代码）；
- icon_type 取值与 sealseek 一致：hot / new / skill / generate-image / 空。

Python 3.9 约束：注解用 Optional/Dict/List。
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List

DEFAULT_SUGGESTIONS = [
    {"id": "keyword-insight-blue-ocean", "text": "帮我找到行业必争蓝海词\U0001F4A1",
     "icon_type": "hot", "capability_id": "keyword-insight"},
    {"id": "viral-image-teardown", "text": "一键拆解爆款主图",
     "icon_type": "new", "capability_id": "viral-image-teardown"},
    {"id": "promotion-roi", "text": "我的推广投产比为什么上不去？",
     "icon_type": "hot", "capability_id": "promotion-analysis"},
    {"id": "buyer-show-graphic", "text": "技能：帮我生成真实的买家秀图文",
     "icon_type": "skill", "capability_id": "buyer-show-graphic"},
    {"id": "generate-image-scene", "text": "AI生图：给我的商品生成2张不同风格的场景图",
     "icon_type": "generate-image", "card_type": 3},
]

_ICON_TYPES = ("hot", "new", "skill", "generate-image", "")


def _normalize(raw: Dict[str, Any]):
    if not isinstance(raw, dict):
        return None
    text = str(raw.get("text") or "").strip()
    if not text:
        return None
    icon_type = str(raw.get("icon_type") or "").strip().lower()
    if icon_type not in _ICON_TYPES:
        icon_type = ""
    return {
        "id": str(raw.get("id") or text).strip(),
        "text": text,
        "icon_type": icon_type,
        "capability_id": str(raw.get("capability_id") or "").strip(),
        "card_type": raw.get("card_type") or 0,
    }


def load_suggestions(data_dir_path: str) -> List[Dict[str, Any]]:
    """data/chat_suggestions.json 有内容时整表覆盖默认；两份都按契约归一化。"""
    path = os.path.join(str(data_dir_path or ""), "chat_suggestions.json")
    items = None
    if path and os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            items = data.get("suggestions") if isinstance(data, dict) else data
        except Exception as exc:
            print("[Suggestions] 读取 data/chat_suggestions.json 失败: %s" % exc)
            items = None
    if not isinstance(items, list) or not items:
        items = DEFAULT_SUGGESTIONS
    out = []
    for item in items:
        norm = _normalize(item)
        if norm:
            out.append(norm)
    return out
