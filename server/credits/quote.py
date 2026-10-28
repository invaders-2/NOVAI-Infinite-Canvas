#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""估价实现：显式 provider 映射 + 最高档成本模式。

server/credits/pricing.py 保留价目加载/档位工具，本模块负责：
    1. 先查 model_map（direct / proxy / conservative）；
    2. proxy/conservative 用「最高档价」算成本，不用均价/中位价；
    3. 未匹配到任何映射时按类型最高价 conservative，绝不静默用便宜值。
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from server.credits import config, model_map, pricing


def _conservative_record(category: str) -> Dict[str, Any]:
    values = model_map.conservative(category)
    if category == "chat":
        input_usd = float(values.get("input_usd") or 0.0)
        output_usd = float(values.get("output_usd") or input_usd)
        return {
            "id": "conservative:chat",
            "category": "chat",
            "billing": "per_1m_tokens",
            "tiers": [
                {"spec": "input", "unit": "per_1m_tokens", "gold": {"usd": input_usd}},
                {"spec": "output", "unit": "per_1m_tokens", "gold": {"usd": output_usd}},
            ],
            "token_rates": {},
        }
    usd = float(values.get("usd") or 0.0)
    unit = str(values.get("unit") or ("per_call" if category == "audio" else "per_second" if category == "video" else "per_image"))
    spec = str(values.get("source_spec") or "conservative")
    return {
        "id": "conservative:%s" % category,
        "category": category,
        "billing": unit,
        "tiers": [{"spec": "conservative:%s" % spec, "unit": unit, "gold": {"usd": usd}}],
        "token_rates": {},
    }


def _best_tier(record: Dict[str, Any], units: Tuple[str, ...]) -> Optional[Dict[str, Any]]:
    best = None
    best_usd = -1.0
    for tier in record.get("tiers") or []:
        if tier.get("unit") not in units:
            continue
        usd = pricing._tier_usd(tier, config.tier())
        if usd is None:
            continue
        if float(usd) > best_usd:
            best = tier
            best_usd = float(usd)
    return best


def _max_token_rates(record: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    """取该模型输入/输出单价的最高值（token 计价，USD / 1M tokens）。"""
    input_rates = []
    output_rates = []
    for key, block in (record.get("token_rates") or {}).items():
        value = pricing._float(((block.get("gold") or {}).get("usd")))
        if value is None:
            continue
        if "input" in key:
            input_rates.append(value)
        elif "output" in key:
            output_rates.append(value)
    for tier in record.get("tiers") or []:
        if tier.get("unit") != "per_1m_tokens":
            continue
        value = pricing._tier_usd(tier, config.tier())
        if value is None:
            continue
        spec = str(tier.get("spec") or "").lower()
        if spec == "input":
            input_rates.append(value)
        elif spec == "output":
            output_rates.append(value)
    return (max(input_rates) if input_rates else None,
            max(output_rates) if output_rates else None)


def postpaid_quote(kind: str, model: Any = "", params: Optional[Dict[str, Any]] = None,
                  provider: str = "") -> Dict[str, Any]:
    """全局后付费报价：不预扣；保留 estimated_* 供后台参考，cost/price 对外为 0。"""
    base = estimate(kind, model, params, provider)
    if base.get("postpaid"):
        return base
    payload = dict(base)
    estimated_cost = float(base.get("cost") or 0)
    estimated_price = float(base.get("price") or 0)
    payload.update({
        "cost": 0.0,
        "price": 0.0,
        "usd": {"cost": 0.0, "price": 0.0, "profit": 0.0},
        "cost_usd": 0.0,
        "price_usd": 0.0,
        "profit_usd": 0.0,
        "estimated_cost": estimated_cost,
        "estimated_price": estimated_price,
        "estimated_usd": base.get("usd") or {},
        "estimated_source": base.get("pricing_source") or "estimate",
        "pricing_source": "estimate",
        "mode": "postpaid",
        "postpaid": True,
        "message": "生成后按实际用量扣费",
        "matched_spec": base.get("matched_spec") or "",
        "provider": str(provider or base.get("provider") or ""),
    })
    return payload


def estimate(kind: str, model: Any = "", params: Optional[Dict[str, Any]] = None,
             provider: str = "", conservative: bool = False) -> Dict[str, Any]:
    params = dict(params or {})
    kind = str(kind or "").strip().lower() or "image"
    category = pricing.CATEGORY_FOR_KIND.get(kind, kind if kind in ("image", "video", "audio", "chat") else "image")
    rows = params.get("rows", params.get("count", 1))
    try:
        rows = max(1, min(10000, int(rows)))
    except (TypeError, ValueError):
        rows = 1

    tier_name = config.tier()
    mapping = model_map.lookup(provider, category, model)
    mode = str((mapping or {}).get("mode") or "")
    if mode == "postpaid" and config.billing_mode() == "prepaid":
        # 切回预扣兼容时，语音模型也不走后付费：按类型最高价预扣
        mode = "conservative"
    target = str((mapping or {}).get("target") or "")
    pricing_source = "direct"
    proxy_model = ""
    fallback = False
    unmapped = []
    max_mode = False
    record = None

    if mode == "postpaid":
        # 后付费：这里不报价、不预扣；完成后按上游成本/usage 结算
        payload = pricing._zero_payload(kind)
        payload.update({
            "cost": 0.0,
            "price": 0.0,
            "currency": "credit",
            "usd": {"cost": 0.0, "price": 0.0, "profit": 0.0},
            "cost_usd": 0.0,
            "price_usd": 0.0,
            "profit_usd": 0.0,
            "matched_spec": "postpaid",
            "pricing_fallback": False,
            "unmapped": [],
            "pricing_source": "postpaid",
            "estimate_mode": "postpaid",
            "proxy_model": "",
            "scope": "postpaid",
            "mode": "postpaid",
            "postpaid": True,
            "message": "生成后按实际用量扣费",
            "model": str(model or ""),
            "requested_model": str(model or ""),
            "kind": kind,
            "category": category,
            "tier": tier_name,
            "unit": "per_usage",
            "quantity": rows,
            "usd_per_credit": config.usd_per_credit(),
            "markup": config.markup(),
            "price_step": config.price_step(),
            "provider": str(provider or ""),
        })
        return payload
    if mode in ("direct", "proxy") and target:
        candidate, _fb, _un = pricing.resolve_model(target, category)
        if candidate is not None and candidate.get("category") == category:
            record = candidate
            if mode == "proxy":
                pricing_source = "proxy"
                proxy_model = str(candidate.get("id") or target)
                max_mode = True
    if mode == "proxy" and record is None:
        # 映射目标失效：宁可按类型最高价，也不能退回便宜估价
        mode = "conservative"
    if record is None and not mode and (not provider or provider == "apimart"):
        # 估价接口没传 provider / APIMart 现成模型没写进映射表：按模型名直接找价目
        candidate, fb, un = pricing.resolve_model(model, category) if model else (None, True, [str(model or "")])
        if candidate is not None and not fb:
            record = candidate
            pricing_source = "direct"
    if conservative and record is not None and not max_mode:
        # 预扣/兜底估价：按该模型最高档价，保证「实际成本缺失时」也不会低于最高可能成本
        max_mode = True
    if mode == "conservative" or record is None:
        record = _conservative_record(category)
        pricing_source = "conservative"
        proxy_model = ""
        fallback = True
        unmapped = [str(model)] if model else []
        max_mode = True

    usd = 0.0
    matched_spec = ""
    unit = pricing.UNIT_FOR_KIND.get(category, ("per_call",))[0]
    extra: Dict[str, Any] = {}

    if category == "image":
        tier = _best_tier(record, ("per_image", "per_call")) if max_mode else pricing.pick_image_tier(record, params)
        if tier is None and (record.get("token_rates") or {}):
            input_gold, output_gold = pricing._image_token_rates(record)
            tokens_in, _ignored = pricing._text_tokens(params)
            tokens_out = int(params.get("tokens_out") or config.image_output_tokens())
            usd = ((tokens_in * (input_gold or 0)) + (tokens_out * (output_gold or 0))) / 1000000.0 * rows
            unit = "per_1m_tokens"
            matched_spec = ("token:max" if max_mode else "token")
            extra["tokens"] = {"input": tokens_in, "output": tokens_out}
        elif tier is not None:
            unit = tier.get("unit") or "per_image"
            matched_spec = str(tier.get("spec") or "default")
            if max_mode:
                matched_spec = "max:" + matched_spec
            usd = float(pricing._tier_usd(tier, tier_name) or 0.0) * rows
        else:
            record = _conservative_record("image")
            pricing_source = "conservative"
            fallback = True
            unmapped = [str(model)] if model else []
            tier = _best_tier(record, ("per_image",))
            unit = "per_image"
            matched_spec = "conservative:max"
            usd = float(pricing._tier_usd(tier, tier_name) or 0.0) * rows
    elif category == "video":
        if max_mode:
            tier = _best_tier(record, ("per_second",)) or _best_tier(record, ("per_call",))
        else:
            tier = pricing.pick_video_tier(record, params)
        if tier is None:
            record = _conservative_record("video")
            pricing_source = "conservative"
            fallback = True
            unmapped = [str(model)] if model else []
            tier = _best_tier(record, ("per_second",))
        unit = tier.get("unit") or "per_second"
        matched_spec = str(tier.get("spec") or "default")
        if max_mode or pricing_source == "conservative":
            matched_spec = "max:" + matched_spec if pricing_source != "conservative" else "conservative:max"
        gold = float(pricing._tier_usd(tier, tier_name) or 0.0)
        if unit == "per_second":
            try:
                duration = float(params.get("duration") or 0)
            except (TypeError, ValueError):
                duration = 0.0
            if duration <= 0:
                duration = float(config.video_default_seconds())
            usd = gold * duration * rows
            extra["duration"] = duration
            extra["rows"] = rows
        else:
            usd = gold * rows
    elif category == "audio":
        if max_mode:
            tier = _best_tier(record, ("per_call",)) or _best_tier(record, ("per_second",))
        else:
            tier = pricing.pick_audio_tier(record, params)
        if tier is None:
            record = _conservative_record("audio")
            pricing_source = "conservative"
            fallback = True
            unmapped = [str(model)] if model else []
            tier = _best_tier(record, ("per_call",))
        unit = tier.get("unit") or "per_call"
        matched_spec = "conservative:max" if pricing_source == "conservative" else (
            "max:" + str(tier.get("spec") or "default") if max_mode else str(tier.get("spec") or "default"))
        gold = float(pricing._tier_usd(tier, tier_name) or 0.0)
        if unit == "per_second":
            try:
                duration = float(params.get("duration") or 0)
            except (TypeError, ValueError):
                duration = 0.0
            usd = gold * (duration if duration > 0 else 1.0) * rows
        else:
            usd = gold * rows
    elif category == "chat":
        if max_mode:
            input_gold, output_gold = _max_token_rates(record)
        else:
            input_gold, output_gold = pricing._token_rates(record)
        if input_gold is None and output_gold is None:
            record = _conservative_record("chat")
            pricing_source = "conservative"
            fallback = True
            unmapped = [str(model)] if model else []
            input_gold, output_gold = _max_token_rates(record)
        tokens_in, tokens_out = pricing._text_tokens(params)
        input_gold = input_gold or 0.0
        output_gold = output_gold if output_gold is not None else input_gold
        usd = ((tokens_in * input_gold) + (tokens_out * output_gold)) / 1000000.0 * rows
        unit = "per_1m_tokens"
        matched_spec = "conservative:max" if pricing_source == "conservative" else (
            "input+output:max" if max_mode else "input+output")
        extra["tokens"] = {"input": tokens_in, "output": tokens_out}
    else:
        raise RuntimeError("未知生成类型：%r" % (kind,))

    cost_credits = round(usd / config.usd_per_credit(), 10) if usd else 0.0
    price_credits = pricing._price_credits(cost_credits)
    profit_credits = round(price_credits - cost_credits, 10)
    result = pricing._zero_payload(kind)
    result.update({
        "cost": cost_credits,
        "price": price_credits,
        "currency": "credit",
        "usd": {
            "cost": round(cost_credits * config.usd_per_credit(), 10),
            "price": round(price_credits * config.usd_per_credit(), 10),
            "profit": round(profit_credits * config.usd_per_credit(), 10),
        },
        "cost_usd": round(cost_credits * config.usd_per_credit(), 10),
        "price_usd": round(price_credits * config.usd_per_credit(), 10),
        "profit_usd": round(profit_credits * config.usd_per_credit(), 10),
        "matched_spec": matched_spec,
        "pricing_fallback": bool(fallback),
        "unmapped": unmapped,
        "pricing_source": pricing_source,
        "estimate_mode": "conservative" if conservative else "spec",
        "proxy_model": proxy_model,
        "provider": str(provider or ""),
        "model": str(record.get("id") or model or ""),
        "requested_model": str(model or ""),
        "kind": kind,
        "category": category,
        "tier": tier_name,
        "unit": unit,
        "quantity": rows,
        "usd_per_credit": config.usd_per_credit(),
        "markup": config.markup(),
        "price_step": config.price_step(),
    })
    result.update(extra)
    if pricing_source == "conservative":
        result["fallback_model"] = str(record.get("id") or "")
    return result
