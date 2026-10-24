#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""main.py 的唯一接入口：credits_charge_start / credits_charge_settle / credits_charge_refund。

设计目标：路由分支只调用这三个函数，不自己算钱、不自己写流水。
- auth 关闭（NOVAI_AUTH_ENABLED 未开）或 NOVAI_CREDITS_DISABLED=1：全部 no-op，本地全开模式零感知；
- 未登录（拿不到用户）：no-op；
- 余额不足：抛 InsufficientCredits，由 install() 注册的异常处理器回 402（body 带 estimate/balance）；
- 结算：上游响应里有 cost/credits_cost 就用实际值（actual=true）；文本有 usage token 数就按
  token 实际计费；都没有就按预扣估价结算（actual=false），不伪造实际成本。
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from server.credits import config, pricing, service
from server.credits.errors import CreditsError, InsufficientCredits

COST_KEYS_USD = ("cost_usd", "costUSD", "cost")
COST_KEYS_CREDITS = ("credits_cost", "creditsCost", "credit_cost")
CONTAINER_KEYS = ("usage", "data", "raw", "response", "result", "meta", "billing")


def current_user_id() -> Optional[int]:
    try:
        from server.auth import tenant
        return tenant.current_user_id()
    except Exception:
        return None


def _as_user_id(user_id: Any) -> Optional[int]:
    if user_id in (None, ""):
        return None
    try:
        return int(user_id)
    except (TypeError, ValueError):
        return None


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip().replace("$", "").replace(",", "")
        try:
            return float(text)
        except ValueError:
            return None
    return None


def _find_cost(payload: Any, depth: int = 0) -> Optional[Dict[str, Any]]:
    if depth > 4 or not isinstance(payload, dict):
        return None
    for key in COST_KEYS_USD:
        value = _number(payload.get(key))
        if value is not None and value >= 0:
            return {"usd": value, "field": key, "kind": "usd"}
    for key in COST_KEYS_CREDITS:
        value = _number(payload.get(key))
        if value is not None and value >= 0:
            return {"usd": value * config.usd_per_credit(), "field": key, "credits": value, "kind": "credits"}
    for key in CONTAINER_KEYS:
        nested = payload.get(key)
        found = _find_cost(nested, depth + 1)
        if found:
            return found
    return None


def credits_result_cost(result: Any) -> Optional[Dict[str, Any]]:
    """从生成结果里找上游实际成本：cost/cost_usd 视作 USD，credits_cost 按 1 credit=$0.1。"""
    if not isinstance(result, dict):
        return None
    return _find_cost(result)


def _text_usage(result: Any) -> Optional[Dict[str, int]]:
    """OpenAI 兼容 usage：prompt_tokens / completion_tokens（也认 input/output）。"""
    if not isinstance(result, dict):
        return None
    containers = [result.get("usage"), result.get("raw_usage")]
    raw = result.get("raw")
    if isinstance(raw, dict):
        containers.append(raw.get("usage"))
    for usage in containers:
        if not isinstance(usage, dict):
            continue
        try:
            input_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
            output_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
        except (TypeError, ValueError):
            continue
        if input_tokens or output_tokens:
            return {"input": input_tokens, "output": output_tokens}
    return None


def credits_estimate(kind: str, model: Any = "", params: Optional[Dict[str, Any]] = None,
                     user_id: Any = None, provider: str = "", conservative: bool = False) -> Dict[str, Any]:
    """估价（不扣费）。auth-off 也能算，价格接口和生成前校验共用。"""
    return service.estimate(kind, model, params, provider, conservative)


def credits_charge_start(kind: str, model: Any = "", params: Optional[Dict[str, Any]] = None,
                         user_id: Any = None, task_ref: str = "",
                         estimate: Optional[Dict[str, Any]] = None,
                         provider: str = "") -> Optional[Dict[str, Any]]:
    """生成前预扣。返回扣费单（含 quote/credits/balance_after）；不扣费时返回 None。"""
    if not config.credits_enabled():
        return None
    uid = _as_user_id(user_id) or current_user_id()
    if not uid:
        return None
    quote = estimate or credits_estimate(kind, model, params, provider=provider)
    charge = service.charge_start(uid, kind, model, params or {}, task_ref=task_ref, estimate=quote,
                                  provider=provider)
    charge["credits"] = service._credits_payload(charge)
    return charge


def credits_charge_settle(charge: Any, result: Any = None,
                          actual_cost_usd: Optional[float] = None,
                          note: str = "") -> Optional[Dict[str, Any]]:
    """任务完成按实际结算（多退少补）。charge 可传扣费单 dict / id / None。"""
    charge_id = _charge_id(charge)
    if not charge_id:
        return None
    cost_usd = actual_cost_usd
    actual = False
    settle_note = note
    if cost_usd is None and result is not None:
        found = credits_result_cost(result)
        if found:
            cost_usd = found["usd"]
            actual = True
            settle_note = note or ("upstream:%s" % found["field"])
        else:
            usage = _text_usage(result)
            if usage:
                # 文本：按上游真实 token 数回算成本（比估价准，仍属实际用量）
                quote = credits_estimate("text", _charge_model(charge),
                                         {"tokens_in": usage["input"], "tokens_out": usage["output"]},
                                         provider=_charge_provider(charge))
                cost_usd = float(quote.get("cost_usd") or 0)
                actual = True
                settle_note = note or "usage_tokens"
    try:
        settled = service.charge_settle(int(charge_id), actual_cost_usd=cost_usd,
                                        actual=actual, note=settle_note)
    except Exception as exc:  # noqa: BLE001 - 生成已成功，结算失败不能把结果变成 500
        print("[credits] 结算失败 charge=%s: %s" % (charge_id, exc))
        return None
    return settled.get("credits") or service._credits_payload(settled)


def credits_charge_refund(charge: Any, reason: str = "") -> Optional[Dict[str, Any]]:
    charge_id = _charge_id(charge)
    if not charge_id:
        return None
    try:
        refunded = service.charge_refund(int(charge_id), reason=reason)
    except Exception as exc:  # noqa: BLE001
        print("[credits] 退款失败 charge=%s: %s" % (charge_id, exc))
        return None
    return refunded.get("credits") or service._credits_payload(refunded)


def credits_charge_attach_task(charge: Any, task_ref: str) -> None:
    """任务型入口先预扣、后建 task：建成后补记 task_ref（失败也不影响主流程）。"""
    charge_id = _charge_id(charge)
    if not charge_id:
        return
    try:
        from server.credits import store
        store.set_charge_task_ref(charge_id, task_ref)
    except Exception as exc:  # noqa: BLE001
        print("[credits] 补记 task_ref 失败 charge=%s: %s" % (charge_id, exc))


def credits_charge_id(charge: Any) -> Optional[int]:
    return _charge_id(charge)


def _charge_id(charge: Any) -> Optional[int]:
    if charge in (None, "", 0):
        return None
    if isinstance(charge, dict):
        value = charge.get("id") or charge.get("charge_id")
    else:
        value = charge
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _charge_model(charge: Any) -> str:
    if isinstance(charge, dict):
        return str(charge.get("model") or "")
    return ""


def _charge_provider(charge: Any) -> str:
    if isinstance(charge, dict):
        return str(charge.get("provider") or "")
    return ""


def credits_attach(result: Dict[str, Any], credits: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """把预扣结果挂到生成响应：契约要求响应里带 credits:{estimate,price,balance_after}。"""
    if credits and isinstance(result, dict):
        result["credits"] = credits
    return result


def credits_enabled() -> bool:
    return config.credits_enabled()
