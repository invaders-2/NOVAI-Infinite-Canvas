#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上游用量网关的「当前用户」头（X-User-Id）。

NOVAI 多个账号共用同一个服务级 Key 时，网关只看得见一个人。这里把请求发起人的
username 作为 X-User-Id 带在指向本地区域网关的上游请求里，网关据此按人记账。

三条硬约束：
- 只发给本地区域网关：base_url 是 127.0.0.1 / localhost / 内网地址才加头，官方站一律不加
  （官方站不认这个头，也不能把本机账号名发出去）；
- 身份来源：请求里的 x-user-id（前端 / 插件自己带的）优先，没有就用登录态（tenant 上下文）；
- 解析不出来就不加头：网关对未注册的 X-User-Id 直接返回 401，宁可不记名也不能把请求打挂。

本模块不 import main.py（会循环导入），users.db 位置从 server.auth.store 取。
"""
from __future__ import annotations

import contextvars
import ipaddress
import os
import sqlite3
import threading
import time
import urllib.parse
from typing import Any, Dict, Optional

# 请求级 x-user-id 原值：由 server/auth/middleware.py 在每个请求入口绑定。
_REQUEST_USER = contextvars.ContextVar("novai_upstream_user", default="")

_CACHE_TTL_SECONDS = 60.0
_CACHE_LIMIT = 256
_CACHE_LOCK = threading.Lock()
_CACHE: Dict[str, Any] = {}          # key -> (expire_at, username)
_LOGGED_UNRESOLVED = set()


def bind_request(x_user_id: str = "") -> contextvars.Token:
    """把本次请求的 x-user-id 原值绑到上下文；返回 Token 供 reset。"""
    return _REQUEST_USER.set(str(x_user_id or "").strip())


def reset_request(token: Optional[contextvars.Token]) -> None:
    if token is None:
        return
    try:
        _REQUEST_USER.reset(token)
    except (ValueError, RuntimeError):
        _REQUEST_USER.set("")


def users_db_path() -> str:
    """users.db 的绝对路径；取不到返回空串（调用方按「没有用户库」处理）。"""
    try:
        from server.auth import store as auth_store
        return str(auth_store.db_path() or "")
    except Exception:
        return ""


def _lookup_username(key: str) -> str:
    path = users_db_path()
    if not path or not os.path.isfile(path):
        return ""
    conn = None
    try:
        conn = sqlite3.connect(path, timeout=5)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT username FROM users WHERE username = ?", (key,)).fetchone()
        if row is None:
            row = conn.execute(
                "SELECT username FROM users WHERE username = ? COLLATE NOCASE", (key,)).fetchone()
        if row is None and key.isdigit():
            row = conn.execute("SELECT username FROM users WHERE id = ?", (int(key),)).fetchone()
    except sqlite3.Error:
        return ""
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    if row is None:
        return ""
    return str(row["username"] or "").strip()


def resolve_username(user_id: Any = "") -> str:
    """把一个用户标识解析成 users.db 里的 username；解析不出返回空串。

    支持「username 原值」与「数字 id」两种写法（NOVAI 前端和历史数据里都有）。
    """
    key = str(user_id if user_id is not None else "").strip()
    if not key:
        return ""
    now = time.monotonic()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] > now:
            return hit[1]
    name = _lookup_username(key)
    with _CACHE_LOCK:
        if len(_CACHE) >= _CACHE_LIMIT:
            _CACHE.clear()
        _CACHE[key] = (now + _CACHE_TTL_SECONDS, name)
    return name


def is_local_gateway(url: str) -> bool:
    """上游地址是不是本机 / 内网网关：本机回环、10/172.16-31/192.168 内网地址为真。"""
    try:
        host = (urllib.parse.urlsplit(str(url or "").strip()).hostname or "").strip().lower()
    except Exception:
        return False
    if not host:
        return False
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return bool(address.is_loopback or address.is_private)


def _candidate_keys(user_id: Any = None) -> list:
    if user_id is not None:
        return [str(user_id).strip()]
    keys = []
    raw = _REQUEST_USER.get()
    if raw:
        keys.append(raw)
    try:
        from server.auth import tenant
        tenant_id = tenant.current_user_id()
    except Exception:
        tenant_id = None
    if tenant_id is not None:
        keys.append(str(tenant_id))
    return keys


def upstream_user_header(user_id: Any = None) -> Dict[str, str]:
    """当前用户的归属头；解析不到 username 时返回空 dict（绝不带未知用户）。"""
    for key in _candidate_keys(user_id):
        name = resolve_username(key)
        if name:
            return {"X-User-Id": name}
    return {}


def apply_upstream_user_header(headers: Optional[Dict[str, str]], url: str) -> Dict[str, str]:
    """给发往本地区域网关的请求头补上 X-User-Id；其它地址原样返回。"""
    if not headers:
        return headers or {}
    if not is_local_gateway(url):
        return headers
    extra = upstream_user_header()
    if not extra:
        return headers
    merged = dict(headers)
    merged.update(extra)
    return merged
