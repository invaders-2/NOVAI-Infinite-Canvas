#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模型价格映射（server/credits/model_map.json）。

为什么不运行时猜：
    任何 provider 的模型都必须能回答「这次生成成本多少」。映射表在构建期生成
    （tools/build_credit_model_map.py），运行时只查表：
    - direct：APIMart 同名/别名，按规格档精确定价；
    - proxy：其它 provider 映射到 APIMart 等价模型，按该模型最高档价（防亏）；
    - conservative：确无等价模型，按该类型全价目最高价（防亏）。
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

_LOCK = threading.Lock()
_CACHE: Dict[str, Any] = {"path": "", "mtime": None, "data": None}


def map_path() -> str:
    explicit = str(os.environ.get("NOVAI_MODEL_MAP_FILE", "") or "").strip()
    if explicit:
        return explicit
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_map.json")


def _load() -> Dict[str, Any]:
    path = os.path.abspath(map_path())
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        raise RuntimeError("模型价格映射文件不存在：%s；先跑 python3 tools/build_credit_model_map.py" % path)
    with _LOCK:
        if _CACHE["data"] is not None and _CACHE["path"] == path and _CACHE["mtime"] == mtime:
            return _CACHE["data"]
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        _CACHE.update({"path": path, "mtime": mtime, "data": data})
        return data


def reset_cache() -> None:
    with _LOCK:
        _CACHE.update({"path": "", "mtime": None, "data": None})


def lookup(provider: str, kind: str, model: str) -> Optional[Dict[str, Any]]:
    """按 provider+kind+model 精确查；没有 provider 时按 kind+model 找一条（优先 direct/proxy）。"""
    data = _load()
    entries = data.get("entries") or {}
    key = "%s|%s|%s" % (str(provider or "").strip(), kind, str(model or "").strip())
    if key in entries:
        return entries[key]
    # 未给 provider（估价接口只传 model）：按模型名在全部 provider 里找
    candidates: List[Dict[str, Any]] = []
    for entry in entries.values():
        if entry.get("kind") == kind and str(entry.get("model") or "") == str(model or ""):
            candidates.append(entry)
    if not candidates:
        return None
    candidates.sort(key=lambda entry: 0 if entry.get("mode") in ("direct", "proxy") else 1)
    return candidates[0]


def entries() -> List[Dict[str, Any]]:
    return list((_load().get("entries") or {}).values())


def coverage() -> Dict[str, Any]:
    return dict(_load().get("coverage") or {})


def conservative(category: str) -> Dict[str, Any]:
    return dict((_load().get("conservative") or {}).get(category) or {})


def raw() -> Dict[str, Any]:
    return _load()
