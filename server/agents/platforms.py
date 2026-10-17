#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""平台元数据：GPT 聊天里「智能体 / 技能」筛选栏的 9 个平台。

- 顺序与 sort_num 来自 sealseek 平台列表：淘宝天猫 10 / 抖音电商 30 / 拼多多 31 /
  1688 33 / 小红书 40 / 京东 70 / 财税 72 / 亚马逊 80（即将上线）/ 私域 90；
- 内置默认就是数据源；data/platforms.json 存在时整表覆盖（用户可配置，不改代码）；
- 图标属于前端的图形资源，按 key 在 web/src/pages/chat/agents/platforms.js 里映射，
  本模块只下发数据（名称 / 顺序 / 是否即将上线 / 别名）。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List

BUILTIN_PLATFORMS = [
    {"key": "taobao", "name": "淘宝天猫", "sort_num": 10, "coming_soon": False, "aliases": ["天猫", "淘宝"]},
    {"key": "douyin", "name": "抖音电商", "sort_num": 30, "coming_soon": False, "aliases": ["抖音"]},
    {"key": "pdd", "name": "拼多多", "sort_num": 31, "coming_soon": False, "aliases": []},
    {"key": "ali1688", "name": "1688", "sort_num": 33, "coming_soon": False, "aliases": ["阿里巴巴"]},
    {"key": "xhs", "name": "小红书", "sort_num": 40, "coming_soon": False, "aliases": []},
    {"key": "jd", "name": "京东", "sort_num": 70, "coming_soon": False, "aliases": []},
    {"key": "tax", "name": "财税", "sort_num": 72, "coming_soon": False, "aliases": ["税务", "财务"]},
    {"key": "amazon", "name": "亚马逊", "sort_num": 80, "coming_soon": True, "aliases": ["Amazon"]},
    {"key": "private", "name": "私域", "sort_num": 90, "coming_soon": False, "aliases": ["微信", "企微", "私域运营"]},
]

_DATA_DIR = ""


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


def _normalize(raw: Dict[str, Any]):
    if not isinstance(raw, dict):
        return None
    key = str(raw.get("key") or raw.get("id") or "").strip()
    if not key:
        return None
    aliases = raw.get("aliases")
    aliases = [str(a) for a in aliases if str(a or "").strip()] if isinstance(aliases, list) else []
    try:
        sort_num = int(raw.get("sort_num") or 0)
    except (TypeError, ValueError):
        sort_num = 0
    return {
        "key": key,
        "name": str(raw.get("name") or key).strip(),
        "sort_num": sort_num,
        "coming_soon": bool(raw.get("coming_soon", False)),
        "aliases": aliases,
    }


def _read_user_platforms() -> List[Dict[str, Any]]:
    path = os.path.join(data_dir(), "platforms.json")
    if not os.path.isfile(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        print("[Platforms] 读取 data/platforms.json 失败: %s" % exc)
        return []
    items = data.get("platforms") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    out = []
    for item in items:
        norm = _normalize(item)
        if norm:
            out.append(norm)
    return out


def list_platforms() -> List[Dict[str, Any]]:
    """按 sort_num 升序返回平台；data/platforms.json 有内容时整表覆盖内置默认。"""
    items = _read_user_platforms()
    if not items:
        items = [_normalize(p) for p in BUILTIN_PLATFORMS]
    items = [i for i in items if i]
    items.sort(key=lambda x: (x["sort_num"], x["key"]))
    return items
