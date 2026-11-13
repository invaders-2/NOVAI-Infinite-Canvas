#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""供应商协议/配置更新包：内置 JSON 的加载与增量合并。

数据文件：server/protocols/protocol_updates.json
  {
    "format": "novai-protocol-updates/v1",
    "updates": [{
      "provider_id": "apimart",
      "name": "APIMart",
      "version": 1,
      "released_at": "2026-11-06",
      "summary": "一句话说明这次更新",
      "docs_url": "https://docs.apimart.ai/...",
      "new_models": {"chat": [], "image": [], "video": [], "audio": []},
      "protocol_changes": [{"field": "stream", "from": "false", "to": "true", "note": "..."}]
    }]
  }

设计铁律（与 server/protocols/registry.py 同一约定）
--------------------------------------------------
1. **加载失败只失效不抛异常**：文件写坏 / 条目类型不对只跳过该条目并记 warning，服务照常启动，
   接口返回空 items（GET 永远 200）。
2. 只做数据合并，不碰 HTTP、不碰密钥。写盘由调用方（main.save_api_providers）负责。
3. 合并只增量：新增模型追加到用户已有列表末尾、去重，绝不删除用户已有模型、不改 Key / 自定义名；
   协议字段只覆盖「provider 记录里本来就有的设置」，其余记录到 protocol_fields 里留档。
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("novai.protocols")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROTOCOLS_DIR = os.path.dirname(os.path.abspath(__file__))
PROTOCOL_UPDATES_FILE = os.path.join(PROTOCOLS_DIR, "protocol_updates.json")

UPDATES_FORMAT = "novai-protocol-updates/v1"
MODEL_KINDS = ("chat", "image", "video", "audio")
# 允许被更新包直接覆盖的 provider 记录字段：这些是「平台接入方式」类设置。
# 模型列表 / Key / 名称 / 启用状态不在其中（更新只增量追加模型，不覆盖这些）。
PROVIDER_OVERRIDABLE_FIELDS = (
    "protocol", "image_request_mode", "image_generation_endpoint", "image_edit_endpoint",
    "use_proxy", "max_concurrency",
)

# 更新包可以附带「模型参数覆盖」：落到 provider.model_caps_overrides，/api/model-caps 合并后编辑器即用新参数。
# 字段白名单与 /api/model-caps 的 caps 结构同源，未知字段直接丢掉（不制造前端不认识的键）。
CAPS_LIST_FIELDS = ("ratios", "resolutions", "qualities", "modes", "output_formats", "sizes")
CAPS_INT_LIST_FIELDS = ("durations", "batch")
CAPS_INT_FIELDS = ("n_max", "max_long_edge", "max_pixels", "min_pixels", "ref_max",
                   "video_ref_max", "audio_ref_max")
CAPS_BOOL_FIELDS = ("exact_size", "mask_url", "base64_refs", "official_fallback", "send_resolution",
                    "thinking_mode", "prompt_only", "native_background")
CAPS_STR_FIELDS = ("fixed_resolution", "size_field", "response_version")
CAPS_FIELDS = CAPS_LIST_FIELDS + CAPS_INT_FIELDS + CAPS_BOOL_FIELDS + CAPS_STR_FIELDS
CAPS_KINDS = ("image", "video")


def _clean_strings(value: Any) -> List[str]:
    out: List[str] = []
    for item in (value if isinstance(value, list) else []):
        text = str(item if item is not None else "").strip()
        if text and text not in out:
            out.append(text)
    return out


def normalize_caps(value: Any) -> Dict[str, Any]:
    """caps 字段级归一：列表去重、数字转 int、布尔转 bool；未知字段丢弃。"""
    if not isinstance(value, dict):
        return {}
    out: Dict[str, Any] = {}
    for field in CAPS_LIST_FIELDS:
        if field in value:
            out[field] = _clean_strings(value.get(field))
    for field in CAPS_INT_LIST_FIELDS:
        if field in value:
            numbers = []
            for item in (value.get(field) if isinstance(value.get(field), list) else []):
                try:
                    number = int(item)
                except (TypeError, ValueError):
                    continue
                if number not in numbers:
                    numbers.append(number)
            out[field] = numbers
    for field in CAPS_INT_FIELDS:
        if field in value:
            try:
                out[field] = max(0, int(value.get(field) or 0))
            except (TypeError, ValueError):
                continue
    for field in CAPS_BOOL_FIELDS:
        if field in value:
            out[field] = bool(value.get(field))
    for field in CAPS_STR_FIELDS:
        if field in value:
            out[field] = str(value.get(field) or "").strip()
    mj = value.get("mj")
    if isinstance(mj, dict) and mj:
        out["mj"] = {
            "versions": _clean_strings(mj.get("versions")),
            "speeds": _clean_strings(mj.get("speeds")),
            "hd": _clean_strings(mj.get("hd")),
        }
    return out


def normalize_model_caps(value: Any) -> List[dict]:
    """更新包的 model_caps 数组：每项 {model, kind, caps}。"""
    out: List[dict] = []
    seen = set()
    for item in (value if isinstance(value, list) else []):
        if not isinstance(item, dict):
            continue
        model = str(item.get("model") or "").strip()
        if not model:
            continue
        kind = str(item.get("kind") or "image").strip().lower()
        if kind not in CAPS_KINDS:
            kind = "image"
        caps = normalize_caps(item.get("caps"))
        if not caps:
            continue
        key = (model.lower(), kind)
        if key in seen:
            continue
        seen.add(key)
        out.append({"model": model, "kind": kind, "caps": caps})
    return out


def normalize_parameter_changes(value: Any) -> List[dict]:
    out: List[dict] = []
    for item in (value if isinstance(value, list) else []):
        if not isinstance(item, dict):
            continue
        model = str(item.get("model") or "").strip()
        field = str(item.get("field") or "").strip()
        if not model or not field:
            continue
        out.append({
            "model": model,
            "field": field,
            "from": str(item.get("from") if item.get("from") is not None else ""),
            "to": str(item.get("to") if item.get("to") is not None else ""),
            "note": str(item.get("note") or ""),
        })
    return out

_cache: Optional[Dict[str, List[dict]]] = None


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:
        logger.warning("[ProtocolUpdates] 读取 %s 失败：%s", os.path.basename(path), exc)
        return None


def _clean_models(value: Any) -> List[str]:
    out: List[str] = []
    for item in (value if isinstance(value, list) else []):
        name = str(item or "").strip()
        if name and name not in out:
            out.append(name)
    return out


def _validate_update(entry: Any) -> Optional[dict]:
    """校验单条更新包；不合法返回 None（只失效，不抛异常）。"""
    if not isinstance(entry, dict):
        logger.warning("[ProtocolUpdates] 跳过非对象条目：%r", entry)
        return None
    provider_id = str(entry.get("provider_id") or "").strip().lower()
    if not provider_id:
        logger.warning("[ProtocolUpdates] 跳过缺少 provider_id 的条目：%r", entry)
        return None
    try:
        version = int(entry.get("version") or 0)
    except (TypeError, ValueError):
        version = 0
    if version <= 0:
        logger.warning("[ProtocolUpdates] 跳过 version 非正整数的条目：%s", provider_id)
        return None
    new_models_raw = entry.get("new_models") if isinstance(entry.get("new_models"), dict) else {}
    new_models = {kind: _clean_models(new_models_raw.get(kind)) for kind in MODEL_KINDS}
    changes: List[dict] = []
    for change in (entry.get("protocol_changes") if isinstance(entry.get("protocol_changes"), list) else []):
        if not isinstance(change, dict):
            continue
        field = str(change.get("field") or "").strip()
        if not field:
            continue
        changes.append({
            "field": field,
            "from": str(change.get("from") or ""),
            "to": str(change.get("to") or ""),
            "note": str(change.get("note") or ""),
        })
    return {
        "provider_id": provider_id,
        "name": str(entry.get("name") or "").strip(),
        "version": version,
        "released_at": str(entry.get("released_at") or "").strip(),
        "summary": str(entry.get("summary") or "").strip(),
        "docs_url": str(entry.get("docs_url") or "").strip(),
        "new_models": new_models,
        "protocol_changes": changes,
        "model_caps": normalize_model_caps(entry.get("model_caps")),
        "parameter_changes": normalize_parameter_changes(entry.get("parameter_changes")),
    }


def load_protocol_updates(force: bool = False) -> Dict[str, List[dict]]:
    """按 provider_id 分组的更新包（按 version 升序）。任何异常都降级为空表。"""
    global _cache
    if _cache is not None and not force:
        return _cache
    payload = _read_json(PROTOCOL_UPDATES_FILE)
    grouped: Dict[str, List[dict]] = {}
    if isinstance(payload, dict) and payload.get("format") == UPDATES_FORMAT:
        raw = payload.get("updates")
        for entry in (raw if isinstance(raw, list) else []):
            update = _validate_update(entry)
            if not update:
                continue
            grouped.setdefault(update["provider_id"], []).append(update)
    elif payload is not None:
        logger.warning("[ProtocolUpdates] %s 的 format 不是 %s，已忽略",
                       os.path.basename(PROTOCOL_UPDATES_FILE), UPDATES_FORMAT)
    for items in grouped.values():
        items.sort(key=lambda item: int(item.get("version") or 0))
    _cache = grouped
    return _cache


def updates_for(provider_id: Any, force: bool = False) -> List[dict]:
    key = str(provider_id or "").strip().lower()
    return list(load_protocol_updates(force=force).get(key) or [])


def latest_update(provider_id: Any) -> Optional[dict]:
    items = updates_for(provider_id)
    return items[-1] if items else None


def latest_version(provider_id: Any) -> int:
    latest = latest_update(provider_id)
    return int(latest.get("version") or 0) if latest else 0


def pending_updates(provider_id: Any, current_version: Any) -> List[dict]:
    """当前已应用版本之后还需要合并的更新包（升序）。"""
    try:
        current = int(current_version or 0)
    except (TypeError, ValueError):
        current = 0
    return [item for item in updates_for(provider_id) if int(item.get("version") or 0) > current]


def build_updates_view(providers: List[dict], provider_ids: Optional[List[str]] = None) -> List[dict]:
    """/api/providers/protocol-updates 的 items：只列「有内置更新包」且调用方可见的平台。"""
    allowed = None
    if provider_ids is not None:
        allowed = {str(item or "").strip().lower() for item in provider_ids}
    view: List[dict] = []
    for provider in providers or []:
        if not isinstance(provider, dict):
            continue
        pid = str(provider.get("id") or "").strip().lower()
        if not pid or (allowed is not None and pid not in allowed):
            continue
        latest = latest_update(pid)
        if not latest:
            continue
        current = _safe_version(provider.get("protocol_version"))
        latest_version_value = int(latest.get("version") or 0)
        # 弹窗要展示「这次更新会改哪些参数」：优先列出尚未应用的更新，已是最新时退回最新一条。
        relevant = [item for item in updates_for(pid) if int(item.get("version") or 0) > current] or [latest]
        caps_map: Dict[Tuple[str, str], dict] = {}
        parameter_changes: List[dict] = []
        new_models_view: Dict[str, List[str]] = {kind: [] for kind in MODEL_KINDS}
        protocol_changes_view: List[dict] = []
        for item in relevant:
            for kind in MODEL_KINDS:
                for name in item.get("new_models", {}).get(kind) or []:
                    if name not in new_models_view[kind]:
                        new_models_view[kind].append(name)
            protocol_changes_view.extend(dict(change) for change in (item.get("protocol_changes") or []))
            for cap in item.get("model_caps") or []:
                key = (str(cap.get("model") or "").lower(), str(cap.get("kind") or "image"))
                merged_caps = dict((caps_map.get(key) or {}).get("caps") or {})
                merged_caps.update(cap.get("caps") or {})
                caps_map[key] = {"model": cap.get("model"), "kind": cap.get("kind") or "image", "caps": merged_caps}
            parameter_changes.extend(dict(change) for change in (item.get("parameter_changes") or []))
        view.append({
            "provider_id": pid,
            "name": provider.get("name") or latest.get("name") or pid,
            "current_version": current,
            "latest_version": latest_version_value,
            "available": latest_version_value > current,
            # 跨版本聚合：v2 只带参数覆盖时，v1 的新模型与协议变更不能从弹窗里消失
            "new_models": new_models_view,
            "protocol_changes": protocol_changes_view,
            "model_caps": list(caps_map.values()),
            "parameter_changes": parameter_changes,
            "summary": latest.get("summary") or "",
            "docs_url": latest.get("docs_url") or "",
            "released_at": latest.get("released_at") or "",
        })
    view.sort(key=lambda item: item["provider_id"])
    return view


def _safe_version(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _empty_applied() -> Dict[str, Any]:
    return {"added_models": {kind: [] for kind in MODEL_KINDS}, "protocol_changes": [],
            "model_caps": [], "parameter_changes": []}


def apply_updates(provider: dict, updates: List[dict]) -> Tuple[dict, Dict[str, Any]]:
    """把更新包增量合并进 provider 记录，返回 (新记录, applied 摘要)。

    - 模型：追加到用户已有列表末尾、去重；保留用户已有顺序与自定义名（不重排、不覆盖）。
    - 协议字段：只覆盖 PROVIDER_OVERRIDABLE_FIELDS 里且记录本来就有/允许的字段；
      其余字段写进 protocol_fields 留档，不制造未知键。
    - protocol_version 推进到合并过的最大版本。
    """
    merged = json.loads(json.dumps(provider or {}, ensure_ascii=False))
    applied = _empty_applied()
    fields = dict(merged.get("protocol_fields") or {}) if isinstance(merged.get("protocol_fields"), dict) else {}
    overrides = dict(merged.get("model_caps_overrides") or {}) if isinstance(merged.get("model_caps_overrides"), dict) else {}
    for update in sorted(updates or [], key=lambda item: int(item.get("version") or 0)):
        for kind in MODEL_KINDS:
            target_key = f"{kind}_models"
            existing = merged.get(target_key)
            if not isinstance(existing, list):
                existing = []
            for name in update.get("new_models", {}).get(kind) or []:
                if name in existing:
                    continue
                existing.append(name)
                applied["added_models"][kind].append(name)
            merged[target_key] = existing
        for change in update.get("protocol_changes") or []:
            field = str(change.get("field") or "").strip()
            if not field:
                continue
            fields[field] = change.get("to") or ""
            if field in PROVIDER_OVERRIDABLE_FIELDS and field in merged:
                merged[field] = change.get("to")
            applied["protocol_changes"].append(dict(change))
        # 模型参数覆盖：同一模型跨版本按字段合并（后版本优先），写进 provider.model_caps_overrides
        for cap in update.get("model_caps") or []:
            model = str(cap.get("model") or "").strip()
            if not model:
                continue
            key = model.lower()
            kind = str(cap.get("kind") or "image")
            previous = overrides.get(key) if isinstance(overrides.get(key), dict) else {}
            merged_caps = dict(previous.get("caps") or {})
            new_caps = normalize_caps(cap.get("caps"))
            merged_caps.update(new_caps)
            overrides[key] = {"model": model, "kind": kind, "caps": merged_caps}
            applied["model_caps"].append({"model": model, "kind": kind, "fields": sorted(new_caps)})
        for change in update.get("parameter_changes") or []:
            applied["parameter_changes"].append(dict(change))
        merged["protocol_version"] = int(update.get("version") or 0)
    if fields:
        merged["protocol_fields"] = fields
    if overrides:
        merged["model_caps_overrides"] = overrides
    return merged, applied
