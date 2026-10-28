#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""积分计费的可配置口径（全部走环境变量，禁止把价格/汇率/加价写死在业务代码里）。

    NOVAI_CREDIT_USD       1 积分对应的成本美元，默认 0.1（= 1 APIMart Credit）
    CREDIT_BILLING_MODE    计费模式：postpaid（默认，生成后按实际扣）| prepaid（兼容旧流程）
    CREDIT_OVERDRAFT_LIMIT 后付费允许的最大欠费（积分），默认 0.01
    PROFIT_RATE            利润率，默认 0.30（售价 = 实际成本 × 1.30）
    CREDIT_MARKUP          旧变量（兼容）；显式设置时优先于 PROFIT_RATE
    CREDIT_PRICE_STEP      售价精度（积分），默认 0.01（2 位小数）；必须 > 1
    APIMART_TIER           成本档位：gold | platinum | diamond | official，默认 gold
    NOVAI_PRICING_FILE     价目 JSON 路径，默认 server/credits/apimart_pricing.json
    NOVAI_CREDITS_DISABLED 1/true 时整条计费链路关闭（auth-off 也会关闭）
    NOVAI_VIDEO_DEFAULT_SECONDS 视频未传时长时的估价秒数，默认 5
    NOVAI_SSE_HEARTBEAT_SECONDS 积分 SSE 心跳间隔，默认 20（测试可调小）
    NOVAI_IMAGE_DEFAULT_SIDE    图片未传宽高时的估价边长，默认 1024
    NOVAI_TEXT_DEFAULT_OUTPUT_TOKENS 文本未给输出 token 时的估价，默认 800
"""
from __future__ import annotations

import os

VALID_TIERS = ("gold", "platinum", "diamond", "official")
DEFAULT_TIER = "gold"
DEFAULT_USD_PER_CREDIT = 0.1
DEFAULT_PROFIT_RATE = 0.30
DEFAULT_MARKUP = 1.30
DEFAULT_PRICE_STEP = 0.01
DEFAULT_OVERDRAFT_LIMIT = 0.01


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "")
    if raw in (None, ""):
        return float(default)
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return float(default)
    return value if value > 0 else float(default)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "")
    try:
        value = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        return int(default)
    return value if value > 0 else int(default)


def usd_per_credit() -> float:
    return _env_float("NOVAI_CREDIT_USD", DEFAULT_USD_PER_CREDIT)


def billing_mode() -> str:
    """默认全局后付费；显式 CREDIT_BILLING_MODE=prepaid 可切回预扣兼容。"""
    raw = str(os.environ.get("CREDIT_BILLING_MODE", "") or "postpaid").strip().lower()
    return raw if raw in ("postpaid", "prepaid") else "postpaid"


def overdraft_limit() -> float:
    """后付费欠费上限（积分），默认 0.01；非法/负数回退默认。"""
    raw = os.environ.get("CREDIT_OVERDRAFT_LIMIT", "")
    if str(raw).strip() != "":
        try:
            value = float(str(raw).strip())
        except (TypeError, ValueError):
            return DEFAULT_OVERDRAFT_LIMIT
        return value if value >= 0 else DEFAULT_OVERDRAFT_LIMIT
    return DEFAULT_OVERDRAFT_LIMIT


def profit_rate() -> float:
    """默认 30%。显式设置 PROFIT_RATE 时以它为准；负数/非法回退 0.30。"""
    raw = os.environ.get("PROFIT_RATE", "")
    if str(raw).strip() != "":
        try:
            value = float(str(raw).strip())
        except (TypeError, ValueError):
            return DEFAULT_PROFIT_RATE
        return value if value >= 0 else DEFAULT_PROFIT_RATE
    return DEFAULT_PROFIT_RATE


def markup() -> float:
    """售价倍率 = 1 + 利润率；兼容旧的 CREDIT_MARKUP（显式设置时优先）。"""
    raw = str(os.environ.get("CREDIT_MARKUP", "") or "").strip()
    if raw:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            value = 0.0
        if value > 0:
            return value
    return 1.0 + profit_rate()


def price_step() -> float:
    """售价精度：0.01 积分（2 位小数，最小收费 0.01）。"""
    return _env_float("CREDIT_PRICE_STEP", DEFAULT_PRICE_STEP)


def tier() -> str:
    value = str(os.environ.get("APIMART_TIER", "") or DEFAULT_TIER).strip().lower()
    return value if value in VALID_TIERS else DEFAULT_TIER


def credits_disabled() -> bool:
    raw = str(os.environ.get("NOVAI_CREDITS_DISABLED", "") or "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def auth_enabled() -> bool:
    try:
        from server.auth import service
        return bool(service.auth_enabled())
    except Exception:
        return False


def credits_enabled() -> bool:
    """只有「登录体系开启 + 显式未关闭」才扣费；auth-off 的全开本地模式行为保持原样。"""
    return bool(auth_enabled()) and not credits_disabled()


def sse_heartbeat_seconds() -> float:
    try:
        value = float(os.environ.get("NOVAI_SSE_HEARTBEAT_SECONDS", "") or 20.0)
    except (TypeError, ValueError):
        return 20.0
    return value if value > 0 else 20.0


def video_default_seconds() -> int:
    return _env_int("NOVAI_VIDEO_DEFAULT_SECONDS", 5)


def image_default_side() -> int:
    return _env_int("NOVAI_IMAGE_DEFAULT_SIDE", 1024)


def text_default_output_tokens() -> int:
    # 后付费场景下文本估价只需覆盖典型短回复；实际结算按 usage。
    return _env_int("NOVAI_TEXT_DEFAULT_OUTPUT_TOKENS", 20)


def image_output_tokens() -> int:
    """token 计价的图像模型（如 gpt-image-2.5-flare）没有每张固定价，估价时按输出 token 数估算。"""
    return _env_int("NOVAI_IMAGE_OUTPUT_TOKENS", 1024)


def pricing_file() -> str:
    explicit = str(os.environ.get("NOVAI_PRICING_FILE", "") or "").strip()
    if explicit:
        return explicit
    # 放在 server/credits/ 下而不是 data/：data/ 被 .gitignore 忽略，价格必须随仓库走
    root = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(root, "apimart_pricing.json")
