#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""注册 / 重置码限流：6 位数字邀请码与重置码都只有 100 万种，不限流就能被脚本枚举。

口径（可用环境变量覆盖）：
- 注册：每 IP 每小时 NOVAI_REGISTER_IP_LIMIT 次（默认 10）
- 注册：全站每分钟 NOVAI_REGISTER_GLOBAL_LIMIT 次（默认 60）
- 重置码：每 IP 每小时 NOVAI_RESET_IP_LIMIT 次（默认 10）

实现是单进程内存滑动窗口；多 worker 部署时每个进程各算一份，
到时候换成 Redis 计数即可（接口保持不变）。
"""
from __future__ import annotations

import os
import threading
import time
from collections import deque
from typing import Deque, Dict, Optional

from server.auth.errors import AuthError

HOUR_SECONDS = 3600
MINUTE_SECONDS = 60
DEFAULT_IP_LIMIT = 10
DEFAULT_GLOBAL_LIMIT = 60
MAX_TRACKED_IPS = 20000

DEFAULT_RESET_IP_LIMIT = 10

_lock = threading.Lock()
_ip_hits: Dict[str, Deque[float]] = {}
_global_hits: Deque[float] = deque()
_reset_hits: Dict[str, Deque[float]] = {}


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default
    return max(1, value)


def ip_limit() -> int:
    return _env_int("NOVAI_REGISTER_IP_LIMIT", DEFAULT_IP_LIMIT)


def global_limit() -> int:
    return _env_int("NOVAI_REGISTER_GLOBAL_LIMIT", DEFAULT_GLOBAL_LIMIT)


def reset_ip_limit() -> int:
    return _env_int("NOVAI_RESET_IP_LIMIT", DEFAULT_RESET_IP_LIMIT)


def _prune(hits: Deque[float], now: float, window: int) -> None:
    while hits and hits[0] <= now - window:
        hits.popleft()


def check(ip: str) -> None:
    """放行则记一次；超限抛 429 AuthError。"""
    now = time.monotonic()
    key = str(ip or "unknown")[:64]
    with _lock:
        _prune(_global_hits, now, MINUTE_SECONDS)
        hits = _ip_hits.get(key)
        if hits is None:
            if len(_ip_hits) >= MAX_TRACKED_IPS:
                _ip_hits.pop(next(iter(_ip_hits)), None)
            hits = _ip_hits[key] = deque()
        _prune(hits, now, HOUR_SECONDS)
        if len(hits) >= ip_limit() or len(_global_hits) >= global_limit():
            raise AuthError("注册请求过于频繁，请稍后再试", 429, "rate_limited")
        hits.append(now)
        _global_hits.append(now)


def check_reset_code(ip: str) -> None:
    """重置密码限流：每 IP 每小时 reset_ip_limit() 次；超限抛 429。"""
    now = time.monotonic()
    key = str(ip or "unknown")[:64]
    with _lock:
        hits = _reset_hits.get(key)
        if hits is None:
            if len(_reset_hits) >= MAX_TRACKED_IPS:
                _reset_hits.pop(next(iter(_reset_hits)), None)
            hits = _reset_hits[key] = deque()
        _prune(hits, now, HOUR_SECONDS)
        if len(hits) >= reset_ip_limit():
            raise AuthError("重置请求过于频繁，请稍后再试", 429, "rate_limited")
        hits.append(now)


def reset() -> None:
    """单测用：清空所有窗口。"""
    with _lock:
        _ip_hits.clear()
        _global_hits.clear()
        _reset_hits.clear()
