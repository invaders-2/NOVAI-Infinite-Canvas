#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""积分领域的两个显式错误：余额不足（402）与账户不存在（404）。"""
from __future__ import annotations


class CreditsError(Exception):
    def __init__(self, message: str, status_code: int = 400, code: str = "credits_error", payload=None) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.payload = payload or {}


class InsufficientCredits(CreditsError):
    """生成前校验失败：契约要求 402 + body 带 estimate / balance。"""

    def __init__(self, estimate: float, balance: float, detail: str = "积分不足",
                 overdraft_limit=None) -> None:
        payload = {
            "code": "INSUFFICIENT_CREDITS",
            "detail": detail,
            "estimate": round(float(estimate), 6),
            "balance": round(float(balance), 6),
        }
        if overdraft_limit is not None:
            payload["overdraft_limit"] = round(float(overdraft_limit), 6)
        super().__init__(detail, 402, "INSUFFICIENT_CREDITS", payload)


class InsufficientBalance(CreditsError):
    """管理员调账把余额扣到 0 以下。"""

    def __init__(self, balance: float, delta: float) -> None:
        super().__init__(
            "余额不足：当前 %.2f，无法扣减 %.2f" % (float(balance), abs(float(delta))),
            400,
            "INSUFFICIENT_BALANCE",
            {"code": "INSUFFICIENT_BALANCE", "balance": round(float(balance), 6), "delta": float(delta)},
        )
