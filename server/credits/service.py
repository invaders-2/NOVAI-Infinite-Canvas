#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""积分业务层：预扣、结算、退款、调账、对外 payload。"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from server.credits import config, events, pricing, store
from server.credits.errors import CreditsError


def me_payload(balance: float) -> Dict[str, Any]:
    return {
        "balance": round(float(balance or 0), 2),
        "overdraft_limit": round(config.overdraft_limit(), 2),
        "unit": "credit",
        "usd_per_credit": config.usd_per_credit(),
        "markup": config.markup(),
        "tier": config.tier(),
        "enabled": config.credits_enabled(),
        "auth_enabled": config.auth_enabled(),
    }


def estimate(kind: str, model: Any = "", params: Optional[Dict[str, Any]] = None,
             provider: str = "", conservative: bool = False) -> Dict[str, Any]:
    return pricing.estimate(kind, model, params, provider, conservative)


def charge_start(user_id: int, kind: str, model: Any = "", params: Optional[Dict[str, Any]] = None,
                 task_ref: str = "", estimate: Optional[Dict[str, Any]] = None,
                 provider: str = "") -> Dict[str, Any]:
    """按估价预扣并建 pending 扣费单；余额不足抛 InsufficientCredits（402）。"""
    quote = estimate or pricing.estimate(kind, model, params, provider)
    charge = store.create_charge(
        user_id=int(user_id),
        estimate=float(quote.get("price") or 0),
        kind=kind,
        model=str(model or quote.get("model") or ""),
        params=params or {},
        task_ref=task_ref,
        estimate_cost=float(quote.get("cost") or 0),
        cost_usd=float(quote.get("cost_usd") or 0),
        price_usd=float(quote.get("price_usd") or 0),
        profit_usd=float(quote.get("profit_usd") or 0),
        pricing_fallback=bool(quote.get("pricing_fallback")),
        unmapped=list(quote.get("unmapped") or []),
        matched_spec=str(quote.get("matched_spec") or ""),
        note="postpaid" if quote.get("postpaid") else "estimate",
        provider=str(provider or quote.get("provider") or ""),
        pricing_source=str(quote.get("pricing_source") or "direct"),
        proxy_model=str(quote.get("proxy_model") or ""),
        mode=str(quote.get("mode") or "prepaid"),
        postpaid_estimated_price=quote.get("estimated_price"),
        overdraft_limit=config.overdraft_limit(),
    )
    charge["quote"] = quote
    events.publish(user_id, charge.get("balance_after", 0))
    return charge


def _actual_price(cost_usd: float) -> float:
    """实际成本 → 售价积分：ceil(cost_credits × (1+PROFIT_RATE) / step) × step。

    最后再做一次强校验：USD 售价必须严格大于成本，否则按 step 上调并记 warning。
    """
    cost_credits = max(0.0, float(cost_usd)) / config.usd_per_credit()
    price = float(pricing.price_for_cost(cost_credits))
    step = config.price_step()
    guard = 0
    while price * config.usd_per_credit() <= float(cost_usd) + 1e-12 and guard < 10000:
        price = round(price + step, 2)
        guard += 1
    return round(price, 2)


def charge_settle(charge_id: int, actual_cost_usd: Optional[float] = None,
                  actual: bool = False, note: str = "", pricing_source: str = "",
                  cost_source: str = "") -> Dict[str, Any]:
    """按实际成本结算：实际成本缺省时用预扣时的成本估算（actual=false）。"""
    charge = store.get_charge(int(charge_id))
    if not charge:
        raise CreditsError("扣费单不存在", 404, "charge_not_found")
    if str(charge.get("status")) != "pending":
        charge["credits"] = _credits_payload(charge)
        return charge
    if actual_cost_usd is None:
        estimate_cost_credits = float(charge.get("estimate_cost") or 0)
        actual_cost_usd = round(estimate_cost_credits * config.usd_per_credit(), 10)
    cost_usd = round(max(0.0, float(actual_cost_usd)), 10)
    warnings: List[str] = []
    if actual:
        # 有 actual 必须用 actual 重算，绝不沿用预扣价
        actual_price = _actual_price(cost_usd)
    else:
        # 没 actual：用「该模型最高可能成本 × (1+利润率)」兜底，再与预扣价取大
        floor_cost_usd = cost_usd
        try:
            floor_quote = pricing.estimate(
                str(charge.get("kind") or ""),
                str(charge.get("model") or ""),
                dict(charge.get("params") or {}),
                str(charge.get("provider") or ""),
                conservative=True,
            )
            floor_cost_usd = max(cost_usd, float(floor_quote.get("cost_usd") or 0))
        except Exception as exc:  # noqa: BLE001 - 估价失败时退回预扣价，至少不亏当前已知成本
            print("[credits] 保守估价失败 charge=%s: %s" % (charge_id, exc))
        cost_usd = round(floor_cost_usd, 10)
        actual_price = max(float(charge.get("estimate") or 0), _actual_price(cost_usd))
        if actual_price > _actual_price(cost_usd):
            warnings.append("estimate_precharge_higher")
        else:
            warnings.append("conservative_floor")
    price_usd = round(actual_price * config.usd_per_credit(), 10)
    profit_usd = round(price_usd - cost_usd, 10)
    if price_usd <= cost_usd + 1e-12 or profit_usd <= 0:
        # 极端浮点/0 成本：强制至少一个 step 的利润并留痕
        while price_usd <= cost_usd + 1e-12:
            actual_price = round(actual_price + config.price_step(), 10)
            price_usd = round(actual_price * config.usd_per_credit(), 10)
        profit_usd = round(price_usd - cost_usd, 10)
        warnings.append("profit_guard_adjusted")
    settle_note = note or ("actual_cost" if actual else "estimate_cost")
    if warnings:
        settle_note = (settle_note + "；" if settle_note else "") + "warning=" + ",".join(warnings)
    settled = store.settle_charge(
        int(charge_id),
        actual_price=actual_price,
        actual_cost_usd=cost_usd,
        actual_price_usd=price_usd,
        profit_usd=profit_usd,
        actual=bool(actual),
        note=note or ("actual_cost" if actual else "estimate_cost"),
        matched_spec=str(charge.get("matched_spec") or ""),
        pricing_source=pricing_source,
        overdraft_limit=config.overdraft_limit(),
        cost_source=cost_source,
    )
    events.publish(int(settled.get("user_id") or charge["user_id"]), settled.get("balance_after", 0))
    settled["credits"] = _credits_payload(settled)
    return settled


def charge_settle_unpriced(charge_id: int, note: str = "") -> Dict[str, Any]:
    """后付费无成本/usage：0 扣费并标 unpriced。"""
    settled = store.settle_unpriced(int(charge_id), note=note or "unpriced")
    events.publish(int(settled.get("user_id") or 0), settled.get("balance_after", 0))
    settled["credits"] = _credits_payload(settled)
    return settled


def charge_refund(charge_id: int, reason: str = "") -> Dict[str, Any]:
    refunded = store.refund_charge(int(charge_id), reason=reason)
    events.publish(int(refunded.get("user_id") or 0), refunded.get("balance_after", 0))
    refunded["credits"] = _credits_payload(refunded)
    return refunded


def _postpaid_message(charge: Dict[str, Any]) -> str:
    if str(charge.get("mode") or "") != "postpaid":
        return ""
    status = str(charge.get("status") or "")
    if status == "pending":
        return "生成后按实际用量扣费"
    if status == "unpriced":
        return "未取得实际用量，本次未扣费（unpriced）"
    if status == "refunded":
        return "生成失败，未扣费"
    return "已按实际用量扣费"


def _credits_payload(charge: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "estimate": round(float(charge.get("estimate") or 0), 2),
        "price": round(float(charge.get("charged") or 0), 2),
        "balance_after": round(float(charge.get("balance_after") or 0), 2),
        "actual_cost_usd": round(float(charge.get("cost_usd") or 0), 6),
        "cost_usd": round(float(charge.get("cost_usd") or 0), 6),
        "price_usd": round(float(charge.get("price_usd") or 0), 6),
        "profit_usd": round(float(charge.get("profit_usd") or 0), 6),
        "cost_source": str(charge.get("cost_source") or ""),
        "pricing_fallback": bool(int(charge.get("pricing_fallback") or 0)),
        "pricing_source": str(charge.get("pricing_source") or "direct"),
        "proxy_model": str(charge.get("proxy_model") or ""),
        "provider": str(charge.get("provider") or ""),
        "mode": str(charge.get("mode") or "prepaid"),
        "postpaid": str(charge.get("mode") or "prepaid") == "postpaid",
        "overdraft_limit": round(config.overdraft_limit(), 2),
        "overdrawn_over_limit": bool(int(charge.get("overdrawn_over_limit") or 0)),
        "message": _postpaid_message(charge),
        "actual": bool(int(charge.get("actual") or 0)),
        "charge_id": int(charge.get("id") or 0),
        "status": str(charge.get("status") or ""),
    }


def admin_adjust(actor: Dict[str, Any], user_id: int, delta: float, note: str = "") -> Dict[str, Any]:
    if not config.auth_enabled():
        raise CreditsError("登录体系未启用", 403, "auth_disabled")
    from server.auth import service as auth_service
    auth_service.require_admin(actor)
    result = store.adjust_credits(int(user_id), float(delta), kind="admin_adjust",
                                  ref="admin:%s" % (actor.get("username") or actor.get("id") or ""),
                                  note=note)
    if config.auth_enabled():
        try:
            from server.auth import store as auth_store
            auth_store.audit("credits_adjust", actor, str(user_id), "ok",
                             "delta=%.4f note=%s" % (float(delta), str(note or "")[:200]))
        except Exception:
            pass
    events.publish(int(user_id), result["balance"])
    return result


def transactions(user_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    return store.list_transactions(int(user_id), limit=limit)


def charges(user_id: Optional[int] = None, limit: int = 50, status: str = "") -> List[Dict[str, Any]]:
    return store.list_charges(user_id=user_id, limit=limit, status=status)
