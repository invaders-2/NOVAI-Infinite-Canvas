#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""请求级租户上下文：当前登录用户 id。

用途：
- 素材/生成结果按用户分目录落盘（main.output_storage 读这里）；
- /assets/users/{uid}/ 的静态访问校验（middleware 用）。

用 contextvars 而不是全局变量：FastAPI 线程池/并发请求会同时处理多个用户，
全局变量会把 A 的上传写进 B 的目录。auth 关闭时这里始终是 None，行为与旧版一致。
"""
from __future__ import annotations

import os
from contextvars import ContextVar, Token
from typing import Any, Dict, Optional

_current_user_id: ContextVar[Optional[int]] = ContextVar("novai_current_user_id", default=None)
_assets_dir = ""


def set_assets_dir(path: str) -> None:
    global _assets_dir
    _assets_dir = str(path or "")


def assets_dir() -> str:
    return _assets_dir


def bind_user(user: Optional[Dict[str, Any]]) -> Token:
    """把当前用户写进请求上下文；返回 Token 供 reset。"""
    try:
        user_id = int(user["id"]) if user and user.get("id") is not None else None
    except (TypeError, ValueError, KeyError):
        user_id = None
    return _current_user_id.set(user_id)


def reset_user(token: Optional[Token]) -> None:
    if token is None:
        return
    try:
        _current_user_id.reset(token)
    except (ValueError, RuntimeError):
        # token 属于另一个上下文（理论上不会发生）：清成 None 兜底
        _current_user_id.set(None)


def current_user_id() -> Optional[int]:
    return _current_user_id.get()


def user_asset_root(user_id: Any) -> str:
    return os.path.join(assets_dir(), "users", str(int(user_id)))


def user_asset_url_prefix(user_id: Any) -> str:
    return f"/assets/users/{int(user_id)}"
