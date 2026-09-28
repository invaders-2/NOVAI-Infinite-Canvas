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
import math
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


# ---------------------------------------------------------------------------
# 生图尺寸策略
# ---------------------------------------------------------------------------
# 尺寸知识的唯一来源是模型协议条目的 size 块：上游真枚举的通道声明 enum，
# 只作为提示词下发的通道声明 free，后端与前端共用同一份声明。
# 供应商配置由 main.py 传入（本模块不反向依赖服务层），这里只做纯计算。
SIZE_POLICY_FORMAT = "novai-size-policy/v1"

DEFAULT_SIZE_POLICY: Dict[str, Any] = {
    "mode": "free",
    "hintOnly": False,
    "maxEdge": 0,
    "maxPixels": 0,
    "minPixels": 0,
    "multipleOf": 0,
    "options": [],
    "prefer": "ratio",
    "autoSize": False,
    "defaultLevel": "",
    "tiers": [
        {"id": "1k", "maxPixels": 1572864},
        {"id": "2k", "maxPixels": 4194304},
        {"id": "4k", "maxPixels": 8294400},
    ],
}

SIZE_MODES = ("free", "bounds", "enum")
SIZE_PREFERS = ("ratio", "area")
SIZE_LEVELS = ("1k", "2k", "4k")
# 同一模型名出现在多个供应商时保留更严格的一方，避免自由声明覆盖真枚举
SIZE_MODE_RANK = {"free": 0, "bounds": 1, "enum": 2}


def _size_int(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _default_size_policy() -> Dict[str, Any]:
    policy = dict(DEFAULT_SIZE_POLICY)
    policy["options"] = []
    policy["tiers"] = [dict(item) for item in DEFAULT_SIZE_POLICY["tiers"]]
    return policy


def _size_tiers(value: Any) -> Optional[List[Dict[str, Any]]]:
    """校验档位表（id + 递增 maxPixels）；非法返回 None，由调用方退回默认档位。"""
    if not isinstance(value, list):
        return None
    tiers: List[Dict[str, Any]] = []
    previous = 0
    for item in value:
        if not isinstance(item, dict):
            return None
        tier_id = str(item.get("id") or "").strip()
        max_pixels = _size_int(item.get("maxPixels"))
        if not tier_id or not max_pixels or max_pixels <= previous:
            return None
        tiers.append({"id": tier_id, "maxPixels": max_pixels})
        previous = max_pixels
    return tiers


def _normalize_size_policy(block: Any) -> Dict[str, Any]:
    """把 size 块补全成固定字段的策略；声明坏了就退回默认值。"""
    policy = _default_size_policy()
    if not isinstance(block, dict):
        return policy
    mode = str(block.get("mode") or "").strip().lower()
    if mode in SIZE_MODES:
        policy["mode"] = mode
    prefer = str(block.get("prefer") or "").strip().lower()
    if prefer in SIZE_PREFERS:
        policy["prefer"] = prefer
    options = block.get("options")
    if isinstance(options, list):
        policy["options"] = [str(item).strip() for item in options if str(item or "").strip()]
    level = str(block.get("defaultLevel") or "").strip().lower()
    if level in SIZE_LEVELS:
        policy["defaultLevel"] = level
    tiers = _size_tiers(block.get("tiers"))
    policy["tiers"] = tiers if tiers is not None else [dict(item) for item in DEFAULT_SIZE_POLICY["tiers"]]
    policy["hintOnly"] = bool(block.get("hintOnly"))
    policy["autoSize"] = bool(block.get("autoSize"))
    for key in ("maxEdge", "maxPixels", "minPixels", "multipleOf"):
        if key in block:
            policy[key] = _size_int(block.get(key))
    return policy


def _model_pattern_hit_length(entry: dict, model: str) -> int:
    """条目 match.model_patterns 对模型名的命中长度；未命中返回 0（匹配规则同 _match_score）。"""
    match = entry.get("match") if isinstance(entry.get("match"), dict) else {}
    lowered = str(model or "").lower()
    if not lowered:
        return 0
    lengths = []
    for raw in match.get("model_patterns") or []:
        pattern = str(raw or "").lower()
        if pattern == "*":
            lengths.append(1)
        elif pattern and pattern in lowered:
            lengths.append(len(pattern))
    return max(lengths) if lengths else 0


def _size_family_block(model: str) -> Optional[dict]:
    """按模型名找尺寸族声明；命中多个时取 pattern 最长（最具体）的，同长度取文件顺序靠前。"""
    best_block: Optional[dict] = None
    best_length = 0
    for entry in load_protocols()["models"]:
        block = entry.get("size")
        if not isinstance(block, dict):
            continue
        hit = _model_pattern_hit_length(entry, model)
        if hit > best_length:
            best_block = block
            best_length = hit
    return best_block


def _explicit_size_block(provider: dict, model: str) -> Optional[dict]:
    """该 (供应商, 模型) 命中的条目里自带 size 块的，按匹配得分取最高者。

    model_protocols_for 用空模型名打分，所以「provider_ids + model_patterns」的条目
    会对该供应商的每个模型都拿到最高分；这里必须再要求 model_patterns 真正命中模型名。
    """
    best_block: Optional[dict] = None
    best_score = -1
    for entry in model_protocols_for(provider or {}):
        block = entry.get("size")
        if not isinstance(block, dict):
            continue
        if "image.generate" not in (entry.get("capabilities") or []):
            continue
        match = entry.get("match") if isinstance(entry.get("match"), dict) else {}
        patterns = [str(x or "") for x in (match.get("model_patterns") or [])]
        if patterns and _model_pattern_hit_length(entry, model) == 0:
            continue
        score = _match_score(entry, provider or {}, model)
        if score > best_score:
            best_block = block
            best_score = score
    return best_block


def size_policy_for(provider: dict, model: str) -> Dict[str, Any]:
    """该 (供应商, 模型) 的生图尺寸策略，按三步解析；任何异常返回默认策略。

    1. 命中的模型协议条目自己声明了 size 块 → 用它（供应商专属声明优先）；
    2. 否则取按模型名命中的尺寸族声明（离散枚举属于模型族，不属于"某协议"）；
    3. 都没有 → DEFAULT_SIZE_POLICY。
    """
    try:
        name = str(model or "")
        block = _explicit_size_block(provider or {}, name)
        if not isinstance(block, dict):
            block = _size_family_block(name)
        return _normalize_size_policy(block)
    except Exception:
        return _default_size_policy()


# 尺寸收敛：与 static/js/shared/size-policy.js 的 constrain 同规则。
# 前端只做预览，真正下发上游的值必须由同一套规则算出，否则两端显示不一致。
_SIZE_PATTERN = re.compile(r"^\s*(\d+)\s*[xX*]\s*(\d+)\s*$")


def _size_pair(value: Any) -> Optional[Tuple[int, int]]:
    match = _SIZE_PATTERN.match(str(value if value is not None else ""))
    if not match:
        return None
    width, height = int(match.group(1)), int(match.group(2))
    return (width, height) if width > 0 and height > 0 else None


def _size_orientation(pair: Tuple[int, int]) -> str:
    if pair[0] == pair[1]:
        return "square"
    return "landscape" if pair[0] > pair[1] else "portrait"


def _size_tier_index(pair: Tuple[int, int], tiers: List[Dict[str, Any]]) -> int:
    """尺寸属于哪一档：第一个 maxPixels ≥ 面积的档；超过最后一档取最后一档。"""
    area = pair[0] * pair[1]
    for index, tier in enumerate(tiers):
        if area <= tier["maxPixels"]:
            return index
    return max(0, len(tiers) - 1)


def _size_align(value: float, multiple: int, round_up: bool) -> int:
    if multiple < 2:
        return max(1, int(math.floor(value + 0.5)))
    if round_up:
        return max(multiple, int(math.ceil(value / multiple)) * multiple)
    return max(multiple, int(math.floor(value / multiple)) * multiple)


def _fit_size_within(pair: Tuple[int, int], policy: Dict[str, Any]) -> str:
    """等比缩进 maxEdge / maxPixels，按 multipleOf 对齐；不足 minPixels 再等比放大。"""
    max_edge = _size_int(policy.get("maxEdge"))
    max_pixels = _size_int(policy.get("maxPixels"))
    min_pixels = _size_int(policy.get("minPixels"))
    multiple = _size_int(policy.get("multipleOf"))
    scale = 1.0
    if max_edge > 0:
        scale = min(scale, max_edge / max(pair))
    if max_pixels > 0:
        scale = min(scale, math.sqrt(max_pixels / (pair[0] * pair[1])))
    width = _size_align(pair[0] * scale, multiple, False)
    height = _size_align(pair[1] * scale, multiple, False)
    if min_pixels > 0 and width * height < min_pixels:
        grow = math.sqrt(min_pixels / max(1, width * height))
        width = _size_align(width * grow, multiple, True)
        height = _size_align(height * grow, multiple, True)
    return "%dx%d" % (width, height)


def _pick_best_size(candidates: List[Tuple[str, int, int]], pair: Tuple[int, int],
                    policy: Dict[str, Any], tiers: List[Dict[str, Any]]) -> Optional[str]:
    """池内先比档位高，再比比例接近（prefer=area 时先比面积），最后比次要项；同分取先出现的。"""
    prefer_area = str(policy.get("prefer") or "").strip().lower() == "area"
    best: Optional[str] = None
    best_key: Optional[Tuple[int, float, float]] = None
    for text, width, height in candidates:
        tier = _size_tier_index((width, height), tiers) if tiers else 0
        ratio_score = abs(math.log((pair[0] / pair[1]) / (width / height)))
        area_score = abs(float(width * height - pair[0] * pair[1]))
        first, second = (area_score, ratio_score) if prefer_area else (ratio_score, area_score)
        key = (tier, -first, -second)
        if best_key is None or key > best_key:
            best, best_key = text, key
    return best


def _snap_enum_size(size: str, pair: Tuple[int, int], policy: Dict[str, Any]) -> str:
    max_edge = _size_int(policy.get("maxEdge"))
    max_pixels = _size_int(policy.get("maxPixels"))
    candidates: List[Tuple[str, int, int]] = []
    for option in policy.get("options") or []:
        cand = _size_pair(option)
        if not cand:
            continue
        if max_edge > 0 and max(cand) > max_edge:
            continue
        if max_pixels > 0 and cand[0] * cand[1] > max_pixels:
            continue
        candidates.append((str(option), cand[0], cand[1]))
    if not candidates:
        return size
    tiers = policy.get("tiers") if isinstance(policy.get("tiers"), list) else []
    if not tiers:
        return _pick_best_size(candidates, pair, policy, tiers) or size
    # 用户请求的档位不能被吃掉：先按方向收窄，再只留「不超过请求档位」的候选，池空退回全表
    target_orientation = _size_orientation(pair)
    target_tier = _size_tier_index(pair, tiers)
    pool = [item for item in candidates
            if _size_orientation((item[1], item[2])) == target_orientation
            and _size_tier_index((item[1], item[2]), tiers) <= target_tier]
    if not pool:
        pool = candidates
    return _pick_best_size(pool, pair, policy, tiers) or size


def constrain_size(provider: dict, model: str, size: str) -> str:
    """把请求尺寸收敛成真正能下发的值：enum 吸附到合法枚举，bounds 等比缩进上限，free 原样。

    与前端 shared/size-policy.js 的 constrain 同规则；无法解析的尺寸（如 auto、占位符）原样返回。
    """
    raw = str(size if size is not None else "")
    pair = _size_pair(raw)
    if not pair:
        return raw
    policy = size_policy_for(provider or {}, str(model or ""))
    if policy.get("mode") == "enum":
        return _snap_enum_size(raw, pair, policy)
    if policy.get("mode") == "bounds" or policy.get("maxEdge") or policy.get("maxPixels") or policy.get("minPixels"):
        return _fit_size_within(pair, policy)
    return raw


def size_policy_table(providers: Any) -> Dict[str, Any]:
    """前端一次性全量表（novai-size-policy/v1）：按模型名展开，前端不必自己映射供应商。

    providers 由调用方传入；只取 enabled 的平台，模型名重复时保留更严格的策略。
    """
    models: Dict[str, Any] = {}
    for provider in providers if isinstance(providers, list) else []:
        try:
            if not isinstance(provider, dict) or not provider.get("enabled", True):
                continue
            for raw in provider.get("image_models") or []:
                model = str(raw or "").strip()
                if not model:
                    continue
                policy = size_policy_for(provider, model)
                current = models.get(model)
                if current is None or SIZE_MODE_RANK.get(policy["mode"], 0) > SIZE_MODE_RANK.get(current["mode"], 0):
                    models[model] = policy
        except Exception:
            continue
    return {
        "format": SIZE_POLICY_FORMAT,
        "default": _default_size_policy(),
        "models": models,
    }
