#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""积分 HTTP 接口（契约见任务书）：

    GET  /api/credits/me
    GET  /api/credits/transactions?limit=50
    POST /api/admin/users/{id}/credits
    GET  /api/credits/price?model=&kind=&width=&height=&duration=&quality=&rows=
    GET  /api/credits/stream          （SSE，余额变化推送 + 20s 心跳）
    GET  /api/credits/charges         （admin：任务扣费明细，含 pricing_fallback/unmapped）
    GET  /api/credits/pricing         （admin：价目覆盖与未映射清单）
"""
from __future__ import annotations

import asyncio
import math
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from server.credits import config, events, model_map, pricing, service, store
from server.credits.errors import CreditsError, InsufficientBalance, InsufficientCredits

router = APIRouter()


class AdminCreditsPayload(BaseModel):
    delta: float = 0.0
    note: str = Field(default="", max_length=500)


def _auth_service():
    from server.auth import service as auth_service
    return auth_service


def _session_user(request: Request) -> Optional[Dict[str, Any]]:
    if not config.auth_enabled():
        return None
    auth_service = _auth_service()
    token = request.cookies.get(auth_service.COOKIE_NAME, "")
    return auth_service.session_user(token)


def _require_user(request: Request) -> Dict[str, Any]:
    user = _session_user(request)
    if not user:
        raise CreditsError("未登录或会话已过期", 401, "unauthorized")
    return user


def _require_admin(request: Request) -> Dict[str, Any]:
    user = _require_user(request)
    return _auth_service().require_admin(user)


def _limit(value: int) -> int:
    try:
        return max(1, min(200, int(value)))
    except (TypeError, ValueError):
        return 50


# ---------------------------------------------------------------- 我的积分

@router.get("/api/credits/me")
def credits_me(request: Request) -> Dict[str, Any]:
    if not config.auth_enabled():
        payload = service.me_payload(0)
        payload["note"] = "登录体系未启用，积分不扣费"
        return payload
    user = _require_user(request)
    return service.me_payload(store.balance(int(user["id"])))


@router.get("/api/credits/transactions")
def credits_transactions(request: Request, limit: int = Query(50, ge=1, le=200)) -> Dict[str, Any]:
    if not config.auth_enabled():
        return {"enabled": False, "balance": 0, "transactions": []}
    user = _require_user(request)
    user_id = int(user["id"])
    return {
        "enabled": True,
        "balance": store.balance(user_id),
        "transactions": service.transactions(user_id, _limit(limit)),
    }


# ---------------------------------------------------------------- 管理面

@router.post("/api/admin/users/{user_id}/credits")
def admin_adjust_credits(user_id: int, payload: AdminCreditsPayload, request: Request) -> Dict[str, Any]:
    actor = _require_admin(request)
    delta = float(payload.delta or 0)
    if not math.isfinite(delta) or abs(delta) < 1e-9:
        raise CreditsError("delta 必须是非 0 的有限数字", 400, "invalid_delta")
    if abs(delta) > 1_000_000:
        raise CreditsError("单次调账幅度过大（上限 1000000 积分）", 400, "invalid_delta")
    try:
        result = service.admin_adjust(actor, int(user_id), delta, payload.note)
    except ValueError:
        raise CreditsError("用户不存在", 404, "user_not_found")
    return {
        "balance": result["balance"],
        "delta": result["delta"],
        "transaction_id": result["transaction_id"],
        "user_id": int(user_id),
    }


@router.get("/api/credits/charges")
def admin_charges(request: Request, limit: int = Query(100, ge=1, le=500),
                  status: str = "", user_id: Optional[int] = None) -> Dict[str, Any]:
    _require_admin(request)
    items = service.charges(user_id=user_id, limit=_limit(limit), status=str(status or ""))
    return {"charges": items, "total": len(items)}


@router.get("/api/credits/debtors")
def admin_debtors(request: Request, limit: int = Query(200, ge=1, le=500),
                  over_limit: bool = False) -> Dict[str, Any]:
    """后付费欠费用户（负余额）；over_limit=true 只看超过欠费上限的。"""
    _require_admin(request)
    users = store.list_negative_balances(limit=_limit(limit))
    limit_value = config.overdraft_limit()
    if over_limit:
        users = [user for user in users if float(user.get("credits") or 0) < -limit_value + 1e-9]
    for user in users:
        user["overdraft_limit"] = limit_value
        user["over_limit"] = float(user.get("credits") or 0) < -limit_value + 1e-9
    return {"users": users, "total": len(users), "billing_mode": config.billing_mode(),
            "overdraft_limit": limit_value}


@router.get("/api/credits/pricing")
def admin_pricing(request: Request) -> Dict[str, Any]:
    _require_admin(request)
    payload = pricing.load()
    fallback_charges = [item for item in store.list_charges(limit=500) if int(item.get("pricing_fallback") or 0)]
    unmapped: List[str] = []
    for item in fallback_charges:
        for name in item.get("unmapped") or []:
            if name and name not in unmapped:
                unmapped.append(name)
    return {
        "coverage": payload.get("coverage") or {},
        "fallback": payload.get("fallback") or {},
        "source": payload.get("source") or {},
        "unmapped_models": unmapped,
        "recent_fallback_charges": len(fallback_charges),
        "tier": config.tier(),
        "usd_per_credit": config.usd_per_credit(),
        "markup": config.markup(),
    }


# ---------------------------------------------------------------- 估价

@router.get("/api/credits/price")
def credits_price(request: Request, model: str = "", kind: str = "",
                  width: int = 0, height: int = 0, duration: float = 0.0,
                  quality: str = "", rows: int = 1, size: str = "",
                  tokens_in: int = -1, tokens_out: int = -1,
                  provider: str = "") -> Dict[str, Any]:
    if config.auth_enabled():
        _require_user(request)
    params: Dict[str, Any] = {
        "width": int(width or 0),
        "height": int(height or 0),
        "duration": float(duration or 0),
        "quality": str(quality or ""),
        "rows": int(rows or 1),
        "size": str(size or ""),
    }
    if tokens_in >= 0:
        params["tokens_in"] = int(tokens_in)
    if tokens_out >= 0:
        params["tokens_out"] = int(tokens_out)
    quote_kind = str(kind or "").strip().lower()
    if not quote_kind and not str(model or "").strip():
        quote_kind = "image"
    if not quote_kind:
        # 没给 kind 时按映射/价目所属类别推断，避免前端少传一个参数就估错价
        entry = None
        for candidate_kind in ("image", "video", "audio", "chat"):
            entry = model_map.lookup(provider, candidate_kind, model)
            if entry:
                quote_kind = candidate_kind
                break
        if entry is None:
            record = pricing.resolve_model(model, "")[0]
            quote_kind = (record or {}).get("category") or "image"
    if config.billing_mode() == "postpaid":
        quote = pricing.postpaid_quote(quote_kind, model, params, provider)
    else:
        quote = pricing.estimate(quote_kind, model, params, provider)
    return {
        "cost": quote["cost"],
        "price": quote["price"],
        "currency": "credit",
        "usd": quote["usd"],
        "matched_spec": quote["matched_spec"],
        "pricing_fallback": quote["pricing_fallback"],
        "unmapped": quote["unmapped"],
        "model": quote["model"],
        "requested_model": quote["requested_model"],
        "kind": quote["kind"],
        "tier": quote["tier"],
        "unit": quote["unit"],
        "quantity": quote["quantity"],
        "usd_per_credit": quote["usd_per_credit"],
        "markup": quote["markup"],
        "price_step": quote.get("price_step", config.price_step()),
        "pricing_source": quote.get("pricing_source", "direct"),
        "proxy_model": quote.get("proxy_model", ""),
        "provider": quote.get("provider", ""),
        "mode": quote.get("mode", "prepaid"),
        "postpaid": bool(quote.get("postpaid")),
        "message": quote.get("message", ""),
        "estimated_cost": quote.get("estimated_cost", 0.0),
        "estimated_price": quote.get("estimated_price", 0.0),
        "estimated_usd": quote.get("estimated_usd", {}),
        "overdraft_limit": config.overdraft_limit(),
    }


@router.get("/api/credits/audit")
def admin_audit(request: Request) -> Dict[str, Any]:
    """后台覆盖审计：123 个 provider 模型逐个列价（含 proxy/conservative 来源）。"""
    _require_admin(request)
    from server.credits import audit as credits_audit
    return credits_audit.audit()


# ---------------------------------------------------------------- SSE

@router.get("/api/credits/stream")
async def credits_stream(request: Request) -> StreamingResponse:
    user = _session_user(request)
    if config.auth_enabled() and not user:
        raise CreditsError("未登录或会话已过期", 401, "unauthorized")
    loop = asyncio.get_running_loop()
    events.bind_loop(loop)
    user_id = int(user["id"]) if user else 0
    queue = events.subscribe(user_id)
    if not config.credits_enabled():
        first_chunk = "data: " + _json({"type": "credits_disabled"}) + "\n\n"
    else:
        first_chunk = "data: " + _json({"type": "balance", "balance": store.balance(user_id)}) + "\n\n"
    heartbeat = config.sse_heartbeat_seconds()

    # 单层扁平 async generator：
    # - 不引用 Request（避免请求对象和生成器互相持有，关闭时层层 throw）；
    # - 不调用 request.is_disconnected()（它会和 Starlette 的断线监听抢同一个 receive）；
    # - 客户端断开时由 Starlette cancel task，CancelledError 直接穿出，finally 只做同步清理。
    # - 只在这里 yield，不嵌套 async for / 不套第二层 generator。
    async def generator():
        try:
            yield first_chunk
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=heartbeat)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # 心跳注释行，防止代理/浏览器把空闲连接断掉
                    continue
                except GeneratorExit:
                    return
                yield "data: " + _json(event) + "\n\n"
        except GeneratorExit:
            return
        finally:
            events.unsubscribe(user_id, queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


def _json(value: Any) -> str:
    import json
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
