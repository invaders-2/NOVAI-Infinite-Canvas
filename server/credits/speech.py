#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""语音模型的后付费成本估算（OpenAI 官方公开单价，APIMart 价目页未收录 TTS/Whisper）。

用途：APIMart 语音模型没有固定 per-call 价，也没有 cost 字段时，用上游 usage
（字符数/音频秒数/token）按官方单价换算出真实成本；拿不到 usage 就返回 None，
调用方应把该单标 unpriced、0 扣费，绝不猜一个固定值。

来源：OpenAI public pricing（2025-2026）：
    tts-1             $15 / 1M characters
    tts-1-hd          $30 / 1M characters
    gpt-4o-mini-tts   $0.015 / minute of audio output
    gpt-4o-audio-*    audio input $40 / 1M tokens，audio output $80 / 1M tokens
    gpt-audio-mini-*  audio input $10 / 1M tokens，audio output $20 / 1M tokens
    whisper-1         $0.006 / minute
"""
from __future__ import annotations

import math
from typing import Any, Dict, Optional

OFFICIAL_RATES = {
    "tts-1": {"unit": "character", "usd": 15.0 / 1_000_000},
    "tts-1-1106": {"unit": "character", "usd": 15.0 / 1_000_000},
    "tts-1-hd": {"unit": "character", "usd": 30.0 / 1_000_000},
    "tts-1-hd-1106": {"unit": "character", "usd": 30.0 / 1_000_000},
    "gpt-4o-mini-tts": {"unit": "minute", "usd": 0.015},
    "gpt-4o-audio-preview": {"unit": "audio_token", "input": 40.0 / 1_000_000, "output": 80.0 / 1_000_000},
    "gpt-4o-audio-preview-2024-10-01": {"unit": "audio_token", "input": 40.0 / 1_000_000, "output": 80.0 / 1_000_000},
    "gpt-audio-mini": {"unit": "audio_token", "input": 10.0 / 1_000_000, "output": 20.0 / 1_000_000},
    "gpt-audio-mini-2025-10-06": {"unit": "audio_token", "input": 10.0 / 1_000_000, "output": 20.0 / 1_000_000},
    "whisper-1": {"unit": "minute", "usd": 0.006},
}


def _number(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _usage_number(usage: Dict[str, Any], *keys: str) -> Optional[float]:
    for key in keys:
        value = _number(usage.get(key))
        if value is not None and value > 0:
            return value
    return None


def estimate_speech_cost(model: str, usage: Optional[Dict[str, Any]] = None,
                         result: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """返回 {usd, source, model, basis, usage}；没有可用 usage 返回 None。"""
    name = str(model or "").strip().lower()
    rates = OFFICIAL_RATES.get(name)
    if not rates:
        return None
    usage = dict(usage or {})
    if result:
        for key in ("characters", "seconds", "bytes"):
            if usage.get(key) in (None, "") and result.get(key) not in (None, ""):
                usage[key] = result.get(key)

    characters = _usage_number(usage, "characters", "char_count", "input_characters")
    seconds = _usage_number(usage, "seconds", "duration", "duration_seconds", "audio_seconds")
    bytes_count = _usage_number(usage, "bytes", "audio_bytes", "content_length")

    if rates["unit"] == "character":
        if characters is not None:
            return _cost_result(characters * rates["usd"], model, "characters=%d" % int(characters), usage)
        return None

    if rates["unit"] == "minute":
        if seconds is None and characters is not None:
            # 没有音频时长时用 15 字符/秒近似（约 150 wpm），并标 estimated
            seconds = max(0.1, characters / 15.0)
        if seconds is not None:
            return _cost_result(seconds / 60.0 * rates["usd"], model,
                                "seconds=%.3f%s" % (seconds, "" if _usage_number(usage, "seconds", "duration", "duration_seconds", "audio_seconds") else "(estimated)"),
                                usage)
        return None

    if rates["unit"] == "audio_token":
        input_tokens = _usage_number(usage, "input_audio_tokens", "audio_input_tokens", "prompt_tokens")
        output_tokens = _usage_number(usage, "output_audio_tokens", "audio_output_tokens", "completion_tokens")
        if input_tokens is None and output_tokens is None:
            if characters is not None:
                # 没有 token usage 时按 4 字符/token 估算输出音频 token（保守按 output 单价）
                output_tokens = max(1.0, characters / 4.0)
            else:
                return None
        cost = (input_tokens or 0.0) * rates["input"] + (output_tokens or 0.0) * rates["output"]
        return _cost_result(cost, model, "audio_tokens=%s/%s" % (
            int(input_tokens or 0), int(output_tokens or 0)), usage)
    return None


def _cost_result(usd: float, model: str, basis: str, usage: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if usd is None or not math.isfinite(usd) or usd < 0:
        return None
    return {
        "usd": round(float(usd), 10),
        "source": "openai_official",
        "model": str(model or ""),
        "basis": basis,
        "usage": usage,
    }
