#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
NOVAI 协议元数据层 —— 供应商协议 / 模型协议注册表。

职责边界（一期刻意收窄）
------------------------
只承载**元数据**：能力（capabilities）、素材输入规则（inputs）、默认值与上限
（defaults / limits）、参数引擎标识（param_engine）、文档链接。

**不承载 HTTP 执行**。真实执行仍在 main.py 既有的命令式链路里
（build_online_image_result / canvas_video_run / run_canvas_hub 等）。
把执行声明式化是独立的大工程，不在本期范围；本模块只负责让
`/api/ai/descriptor` 有可查询的真值源，并让「新增平台 = 加元数据」成为可能。

术语
----
* 供应商协议（kind=provider）：鉴权 + 公共规则 + 模型列表端点。
* 模型协议（kind=model）：能力、素材规则、默认值/上限。

设计铁律
--------
1. **加载与校验绝不抛异常**：协议文件写坏只让对应条目失效并记 warning，
   服务必须照常启动（与 server/appRegistry.py 同一约定）。
2. 纯标准库，不依赖 jsonschema。
3. 解析结果带 reasons，便于前端解释「为什么这个模型不可用」。
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("novai.protocols")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROTOCOLS_DIR = os.path.dirname(os.path.abspath(__file__))
PROVIDER_FILE = os.path.join(PROTOCOLS_DIR, "provider_protocols.json")
MODEL_FILE = os.path.join(PROTOCOLS_DIR, "model_protocols.json")
MANIFEST_FILE = os.path.join(PROTOCOLS_DIR, "manifest.json")

PROVIDER_FORMAT = "novai-provider-protocols/v1"
MODEL_FORMAT = "novai-model-protocols/v1"
MANIFEST_FORMAT = "novai-protocol-manifest/v1"

# 与 server/appRegistry.py 的 App id 规则同源
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9:_-]{1,63}$")

AUTH_TYPES = ("bearer", "api_key_header", "google_api_key", "none")
KINDS = ("provider", "model")

# 匹配得分：精确 provider_ids > provider_protocols > 模型名模式
SCORE_PROVIDER_ID = 30
SCORE_PROVIDER_PROTOCOL = 20
SCORE_MODEL_PATTERN = 10

_cache: Optional[Dict[str, Any]] = None


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:
        logger.warning("[Protocols] 读取 %s 失败：%s", os.path.basename(path), exc)
        return None


def _validate_protocol(entry: Any, kind: str) -> Tuple[bool, str]:
    """校验单条协议。返回 (是否可用, 原因)。"""
    if not isinstance(entry, dict):
        return False, "条目不是对象"
    protocol_id = str(entry.get("id") or "").strip().lower()
    if not ID_PATTERN.match(protocol_id):
        return False, "id 不合法：%r" % (entry.get("id"),)
    if entry.get("kind") != kind:
        return False, "kind 必须是 %s" % kind
    if not str(entry.get("label") or "").strip():
        return False, "缺少 label"
    version = entry.get("version")
    if not isinstance(version, int) or version < 1:
        return False, "version 必须是正整数"
    if kind == "provider":
        auth = entry.get("auth")
        if not isinstance(auth, dict) or auth.get("type") not in AUTH_TYPES:
            return False, "auth.type 必须是 %s 之一" % ("/".join(AUTH_TYPES),)
    else:
        caps = entry.get("capabilities")
        if not isinstance(caps, list) or not caps:
            return False, "模型协议必须声明非空 capabilities"
    return True, ""


def _load_file(path: str, expected_format: str, kind: str) -> List[dict]:
    payload = _read_json(path)
    if not isinstance(payload, dict):
        return []
    if payload.get("format") != expected_format:
        logger.warning("[Protocols] %s 的 format 不是 %s，已忽略", os.path.basename(path), expected_format)
        return []
    raw = payload.get("protocols")
    if not isinstance(raw, list):
        return []
    out: List[dict] = []
    seen = set()
    for entry in raw:
        ok, reason = _validate_protocol(entry, kind)
        if not ok:
            logger.warning("[Protocols] 跳过无效条目（%s）：%s", reason, entry if isinstance(entry, dict) else entry)
            continue
        protocol_id = str(entry["id"]).strip().lower()
        if protocol_id in seen:
            logger.warning("[Protocols] id 重复，保留首个：%s", protocol_id)
            continue
        seen.add(protocol_id)
        out.append(entry)
    return out


def load_protocols(force: bool = False) -> Dict[str, Any]:
    """加载并缓存协议表。任何异常都降级为空表，绝不影响服务启动。"""
    global _cache
    if _cache is not None and not force:
        return _cache
    providers = _load_file(PROVIDER_FILE, PROVIDER_FORMAT, "provider")
    models = _load_file(MODEL_FILE, MODEL_FORMAT, "model")
    _cache = {
        "providers": providers,
        "models": models,
        "by_id": {item["id"]: item for item in providers + models},
    }
    logger.info("[Protocols] 已载入供应商协议 %d 条、模型协议 %d 条", len(providers), len(models))
    return _cache


def provider_protocol(protocol_id: str) -> Optional[dict]:
    key = str(protocol_id or "").strip().lower()
    if not key:
        return None
    entry = load_protocols()["by_id"].get(key)
    return entry if entry and entry.get("kind") == "provider" else None


def _match_score(entry: dict, provider: dict, model: str) -> int:
    match = entry.get("match") if isinstance(entry.get("match"), dict) else {}
    provider_id = str((provider or {}).get("id") or "").strip().lower()
    protocol = str((provider or {}).get("protocol") or "").strip().lower()
    score = 0
    ids = [str(x).lower() for x in (match.get("provider_ids") or [])]
    protocols = [str(x).lower() for x in (match.get("provider_protocols") or [])]
    if ids and provider_id in ids:
        score += SCORE_PROVIDER_ID
    if protocols and protocol in protocols:
        score += SCORE_PROVIDER_PROTOCOL
    patterns = [str(x).lower() for x in (match.get("model_patterns") or [])]
    if patterns:
        lowered = str(model or "").lower()
        if any(pattern == "*" or pattern in lowered for pattern in patterns):
            score += SCORE_MODEL_PATTERN
    return score


def model_protocols_for(provider: dict) -> List[dict]:
    """所有对该供应商有匹配度的模型协议条目（按得分降序）。"""
    scored = []
    for entry in load_protocols()["models"]:
        score = _match_score(entry, provider, "")
        if score > 0:
            scored.append((score, entry))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [entry for _, entry in scored]


def resolve_model_protocol(provider: dict, intent: str = "", model: str = "") -> Tuple[Optional[dict], List[str]]:
    """按 (provider, intent, model) 解析模型协议。

    返回 (命中的协议条目或 None, reasons)。
    未命中时 reasons 说明原因与候选可用能力，供前端直接展示。
    """
    reasons: List[str] = []
    candidates = model_protocols_for(provider)
    if not candidates:
        protocol = str((provider or {}).get("protocol") or "")
        reasons.append("供应商协议「%s」尚无对应模型协议条目" % (protocol or "未声明"))
        return None, reasons

    wanted = str(intent or "").strip()
    if not wanted:
        return candidates[0], reasons

    exact = [entry for entry in candidates if wanted in (entry.get("capabilities") or [])]
    if exact:
        # 同为精确命中时，provider_ids 匹配的条目优先（generic 条目在后）
        exact.sort(key=lambda entry: _match_score(entry, provider, model), reverse=True)
        return exact[0], reasons

    available: List[str] = []
    for entry in candidates:
        for capability in entry.get("capabilities") or []:
            if capability not in available:
                available.append(capability)
    reasons.append("模型协议不支持意图「%s」" % wanted)
    if available:
        reasons.append("当前可用意图：" + "、".join(available[:12]))
    return None, reasons


def capabilities_for(provider: dict) -> List[str]:
    """该供应商所有匹配条目能提供的意图全集。"""
    out: List[str] = []
    for entry in model_protocols_for(provider):
        for capability in entry.get("capabilities") or []:
            if capability not in out:
                out.append(capability)
    return out


def list_protocols(kind: str = "") -> List[dict]:
    data = load_protocols()
    items = data["providers"] if kind == "provider" else data["models"] if kind == "model" else data["providers"] + data["models"]
    return [json.loads(json.dumps(item, ensure_ascii=False)) for item in items]


def manifest() -> dict:
    """协议清单：id / kind / version，供更新通道比对。"""
    data = load_protocols()
    return {
        "format": MANIFEST_FORMAT,
        "protocols": [
            {"id": item["id"], "kind": item["kind"], "version": item["version"]}
            for item in data["providers"] + data["models"]
        ],
    }
