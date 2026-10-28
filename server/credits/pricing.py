#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""积分估价引擎：APIMart 价目 JSON → 成本积分 / 售价积分 / 利润。

三条硬规则（测试覆盖）：
    1. 售价严格大于成本，且最小加价 0.01 积分；
    2. 售价按分（0.01 积分）向上取整；
    3. 未匹配到模型价格时绝不静默用固定值：按类型兜底并返回 pricing_fallback/unmapped。

价格来源：data/apimart_pricing.json（构建期由 tools/apimart_pricing.py 生成，运行时不联网）。
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
from typing import Any, Dict, List, Optional, Tuple

from server.credits import config

_CACHE_LOCK = threading.Lock()
_CACHE: Dict[str, Any] = {"path": "", "mtime": None, "data": None}

CATEGORY_FOR_KIND = {
    "image": "image",
    "video": "video",
    "audio": "audio",
    "music": "audio",
    "tts": "audio",
    "text": "chat",
    "llm": "chat",
    "chat": "chat",
}
UNIT_FOR_KIND = {
    "image": ("per_image", "per_call"),
    "video": ("per_second", "per_call"),
    "audio": ("per_call", "per_second"),
    "chat": ("per_1m_tokens",),
}
RESOLUTION_ORDER = ["0.5K", "768SQ", "1K", "1.5K", "2K", "4K"]
RESOLUTION_AREA = {
    "0.5K": 300000,
    "768SQ": 590000,
    "1K": 1000000,
    "1.5K": 2200000,
    "2K": 4000000,
    "4K": 8300000,
}


def _compact(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _float(value: Any) -> Optional[float]:
    if value in (None, "", "$undefined"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load() -> Dict[str, Any]:
    path = os.path.abspath(config.pricing_file())
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        raise RuntimeError(
            "APIMart 价目文件不存在：%s；先跑 python3 tools/apimart_pricing.py（构建期解析，运行时不联网）" % path
        )
    with _CACHE_LOCK:
        if _CACHE["data"] is not None and _CACHE["path"] == path and _CACHE["mtime"] == mtime:
            return _CACHE["data"]
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        _CACHE.update({"path": path, "mtime": mtime, "data": data})
        return data


def reload() -> Dict[str, Any]:
    with _CACHE_LOCK:
        _CACHE["mtime"] = None
        _CACHE["data"] = None
    return load()


def reset_cache() -> None:
    """清空价目缓存（测试切换 NOVAI_PRICING_FILE 时用）。"""
    with _CACHE_LOCK:
        _CACHE.update({"path": "", "mtime": None, "data": None})


def resolve_model(model: Any, category: Optional[str] = None) -> Tuple[Optional[Dict[str, Any]], bool, List[str]]:
    """返回 (模型记录, 是否兜底, 未匹配请求列表)。匹配顺序：id → 别名 → 压缩别名。"""
    payload = load()
    models = payload.get("models") or {}
    aliases = payload.get("alias_map") or {}
    requested = str(model or "").strip()
    record = None
    if requested:
        for candidate in (requested, requested.lower(), _compact(requested)):
            if candidate in models:
                record = models[candidate]
                break
            target = aliases.get(candidate) or aliases.get(candidate.lower())
            if not target:
                target = aliases.get(_compact(candidate))
            if target and target in models:
                record = models[target]
                break
    if record is not None:
        return record, False, []
    fallback_id = (payload.get("fallback") or {}).get(category or "") or ""
    fallback = models.get(fallback_id)
    if fallback is None:
        # 该类型没有任何可用兜底：显式报错，绝不编一个固定价
        raise RuntimeError("价目表里没有 %s 类型的兜底模型，无法为 %r 估价" % (category, requested))
    return fallback, True, [requested]


def _tier_usd(tier: Dict[str, Any], tier_name: str) -> Optional[float]:
    block = tier.get(tier_name) or {}
    value = _float(block.get("usd"))
    if value is None:
        value = _float(tier.get(tier_name + "_usd"))
    return value


def _spec_norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _resolution_of(spec: str, width: int = 0, height: int = 0) -> str:
    text = _spec_norm(spec)
    for token in ("0.5k", "768sq", "1.5k", "4k", "2k", "1k"):
        if token in text:
            return {"0.5k": "0.5K", "768sq": "768SQ", "1.5k": "1.5K", "4k": "4K",
                    "2k": "2K", "1k": "1K"}[token]
    mp = re.search(r"(\d+(?:\.\d+)?)\s*mp", text)
    if mp:
        megapixels = float(mp.group(1))
        for name in RESOLUTION_ORDER:
            if abs(RESOLUTION_AREA[name] / 1000000.0 - megapixels) < 0.35:
                return name
    dims = re.search(r"(\d{3,5})\s*[x*]\s*(\d{3,5})", text)
    if dims:
        area = int(dims.group(1)) * int(dims.group(2))
        return _resolution_for_area(area)
    return ""


def _resolution_for_area(area: int) -> str:
    if area >= 6000000:
        return "4K"
    if area >= 2800000:
        return "2K"
    if area >= 1400000:
        return "1.5K"
    if area >= 760000:
        return "1K"
    if area >= 320000:
        return "768SQ"
    return "0.5K"


def _parse_dims(params: Dict[str, Any]) -> Tuple[int, int]:
    width = int(params.get("width") or 0)
    height = int(params.get("height") or 0)
    if width > 0 and height > 0:
        return width, height
    raw = str(params.get("size") or "").strip()
    match = re.search(r"(\d{2,5})\s*[x*]\s*(\d{2,5})", raw)
    if match:
        return int(match.group(1)), int(match.group(2))
    return width, height


def _quality_suffix_match(spec: str, quality: str) -> bool:
    if not quality:
        return False
    text = _spec_norm(spec)
    return ("@" + quality) in text or text.endswith(quality) or (" " + quality) in text


def pick_image_tier(record: Dict[str, Any], params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    params = params or {}
    tiers = [tier for tier in record.get("tiers") or []
             if tier.get("unit") in ("per_image", "per_call")]
    if not tiers:
        return None
    width, height = _parse_dims(params)
    quality = str(params.get("quality") or "").strip().lower()
    if quality in ("auto", "标准", "default"):
        quality = ""
    target = _resolution_for_area(width * height) if width and height else ""
    ranked: List[Tuple[float, Dict[str, Any]]] = []
    for tier in tiers:
        spec = _spec_norm(tier.get("spec"))
        score = 0.0
        if spec in ("default", "默认"):
            score += 1
        if quality and _quality_suffix_match(spec, quality):
            score += 40
        spec_res = _resolution_of(spec)
        if target and spec_res:
            if spec_res == target:
                score += 100
            else:
                # 同尺寸系列但档位不同：挑「不小于目标」的最近档（不低估成本），否则按距离扣分
                target_index = RESOLUTION_ORDER.index(target) if target in RESOLUTION_ORDER else 0
                spec_index = RESOLUTION_ORDER.index(spec_res) if spec_res in RESOLUTION_ORDER else 0
                if spec_index >= target_index:
                    score += 60 - (spec_index - target_index) * 5
                else:
                    score += 10 - (target_index - spec_index) * 5
        if "input" in spec or "参考" in spec:
            score -= 30
        ranked.append((score, tier))
    ranked.sort(key=lambda item: item[0], reverse=True)
    best = ranked[0]
    if best[0] <= 0:
        defaults = [tier for tier in tiers if _spec_norm(tier.get("spec")) in ("default", "默认")]
        return defaults[0] if defaults else tiers[0]
    return best[1]


def _video_resolution_value(spec: str) -> int:
    text = _spec_norm(spec)
    if "4k" in text:
        return 2160
    if "2k" in text:
        return 1440
    numbers = [int(value) for value in re.findall(r"(\d{3,4})\s*p", text)]
    if numbers:
        return max(numbers)
    return 0


def pick_video_tier(record: Dict[str, Any], params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    params = params or {}
    tiers = [tier for tier in record.get("tiers") or [] if tier.get("unit") in ("per_second", "per_call")]
    if not tiers:
        return None
    per_second = [tier for tier in tiers if tier.get("unit") == "per_second"]
    candidates = per_second or tiers
    width, height = _parse_dims(params)
    target = int(height or 0) or (int(width * 9 / 16) if width else 720)
    non_input = [tier for tier in candidates if "-input" not in _spec_norm(tier.get("spec")) and "参考视频" not in _spec_norm(tier.get("spec"))]
    if non_input:
        candidates = non_input
    ranked: List[Tuple[float, Dict[str, Any]]] = []
    for tier in candidates:
        value = _video_resolution_value(str(tier.get("spec")))
        score = 0.0
        if value == 0:
            score = 1.0
        elif value >= target:
            score = 100 - (value - target) / 100.0
        else:
            score = 10 - (target - value) / 500.0
        ranked.append((score, tier))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return ranked[0][1] if ranked else candidates[0]


def pick_audio_tier(record: Dict[str, Any], params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    tiers = [tier for tier in record.get("tiers") or [] if tier.get("unit") in ("per_call", "per_second")]
    if not tiers:
        return None
    defaults = [tier for tier in tiers if _spec_norm(tier.get("spec")) in ("default", "默认")]
    return defaults[0] if defaults else tiers[0]


def _token_rates(record: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    rates = record.get("token_rates") or {}
    input_gold = None
    output_gold = None
    for key in ("text_input", "image_input"):
        value = _tier_usd((rates.get(key) or {}), "gold")
        if value is None:
            value = _float(((rates.get(key) or {}).get("gold") or {}).get("usd"))
        if value is not None:
            input_gold = value if input_gold is None else input_gold
    for key in ("text_output", "image_output"):
        value = _tier_usd((rates.get(key) or {}), "gold")
        if value is None:
            value = _float(((rates.get(key) or {}).get("gold") or {}).get("usd"))
        if value is not None:
            output_gold = value if output_gold is None else output_gold
    if input_gold is None or output_gold is None:
        for tier in record.get("tiers") or []:
            if tier.get("unit") != "per_1m_tokens":
                continue
            if _spec_norm(tier.get("spec")) == "input" and input_gold is None:
                input_gold = _tier_usd(tier, "gold")
            if _spec_norm(tier.get("spec")) == "output" and output_gold is None:
                output_gold = _tier_usd(tier, "gold")
    return input_gold, output_gold


def _image_token_rates(record: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    """图像 token 计价优先用 image_input/image_output；没有再退回 text_input/text_output。"""
    rates = record.get("token_rates") or {}
    input_gold = None
    output_gold = None
    for key in ("image_input", "text_input"):
        block = rates.get(key) or {}
        value = _float((block.get("gold") or {}).get("usd"))
        if value is not None:
            input_gold = value
            break
    for key in ("image_output", "text_output"):
        block = rates.get(key) or {}
        value = _float((block.get("gold") or {}).get("usd"))
        if value is not None:
            output_gold = value
            break
    return input_gold, output_gold


def _text_tokens(params: Dict[str, Any]) -> Tuple[int, int]:
    tokens_in = params.get("tokens_in")
    tokens_out = params.get("tokens_out")
    if tokens_in in (None, ""):
        text = " ".join(str(params.get(key) or "") for key in ("text", "prompt", "input"))
        if not text:
            messages = params.get("messages") or []
            parts = []
            for message in messages if isinstance(messages, list) else []:
                if isinstance(message, dict):
                    parts.append(str(message.get("content") or ""))
            text = " ".join(parts)
        tokens_in = max(0, int(len(text) / 4)) if text else 0
    try:
        tokens_out = int(tokens_out) if tokens_out not in (None, "") else config.text_default_output_tokens()
    except (TypeError, ValueError):
        tokens_out = config.text_default_output_tokens()
    try:
        tokens_in = int(tokens_in)
    except (TypeError, ValueError):
        tokens_in = 0
    return max(0, tokens_in), max(0, tokens_out)


def _price_credits(cost_credits: float) -> float:
    """售价 = ceil(cost × markup / step) × step；最小 1 step，且严格 > 成本。

    验收口径：0.01 步进、2 位小数。图片成本 0.072 → 0.10；视频 1.19 → 1.55；
    视频 1.0 → 1.30；文本 0.00002 / TTS 0.003 这类不足一个 step 的 → 0.01。
    """
    step = config.price_step()
    raw = max(0.0, float(cost_credits))
    units = math.ceil(round(raw * config.markup(), 12) / step - 1e-12)
    price = round(units * step, 2)
    if price <= raw + 1e-12:
        price = round((math.floor(round(raw, 12) / step) + 1) * step, 2)
    if price < step:
        price = round(step, 2)
    return round(price, 2)


def price_for_cost(cost_credits: float) -> float:
    return _price_credits(cost_credits)


def _zero_payload(kind: str) -> Dict[str, Any]:
    return {
        "cost": 0.0,
        "price": 0.0,
        "currency": "credit",
        "usd": {"cost": 0.0, "price": 0.0, "profit": 0.0},
        "matched_spec": "",
        "pricing_fallback": False,
        "unmapped": [],
        "model": "",
        "kind": kind,
        "tier": config.tier(),
        "unit": "per_call",
        "quantity": 0,
        "cost_usd": 0.0,
        "price_usd": 0.0,
        "profit_usd": 0.0,
    }


def postpaid_quote(kind: str, model: Any = "", params: Optional[Dict[str, Any]] = None,
                  provider: str = "") -> Dict[str, Any]:
    from server.credits.quote import postpaid_quote as _impl
    return _impl(kind, model, params, provider)


def estimate(kind: str, model: Any = "", params: Optional[Dict[str, Any]] = None,
             provider: str = "", conservative: bool = False) -> Dict[str, Any]:
    """估价入口：实现见 server/credits/quote.py（显式 provider/映射/max 成本模式）。"""
    from server.credits.quote import estimate as _impl
    return _impl(kind, model, params, provider, conservative)

def model_names() -> List[str]:
    return sorted((load().get("models") or {}).keys())


def coverage() -> Dict[str, Any]:
    return dict(load().get("coverage") or {})
