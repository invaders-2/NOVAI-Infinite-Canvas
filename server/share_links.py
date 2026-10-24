#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""公开分享链接（M6）：canvas_share_links 表、token、密码 cookie、解锁限速。

与现有用户库共用同一个 users.db；只在 auth-on 的接口里被调用。
注意（新契约）：链接本身仍要求登录；访问通过后由 main.py 自动把当前用户加为 viewer 成员，
素材鉴权直接复用 M5 的「共享画布引用」逻辑，不再有 token 素材白名单。
"""
from __future__ import annotations

import hashlib
import hmac
import math
import os
import secrets
import sqlite3
import time
from collections import deque
from typing import Any, Dict, Optional, Tuple

from server.auth import passwords, store as auth_store

TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 去掉 I/O/0/1
TOKEN_LENGTH = 10
COOKIE_NAME = "novai_share_access"
COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000
UNLOCK_WINDOW_SECONDS = 60
UNLOCK_LIMIT = 10
VALID_EXPIRES_IN_DAYS = (0, 1, 7, 30)

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS canvas_share_links (
        canvas_id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT 'viewer',
        expires_at INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT,
        allow_clone INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
    )
    """,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_token ON canvas_share_links(token)",
)

_ready_path = ""
_secret_cache = ""
_unlock_hits: Dict[str, deque] = {}
_unlock_lock = __import__("threading").Lock()


def now_ms() -> int:
    return int(time.time() * 1000)


def ensure_schema() -> None:
    global _ready_path
    path = auth_store.db_path()
    if _ready_path == path:
        return
    conn = auth_store.connect()
    try:
        for statement in SCHEMA:
            conn.execute(statement)
    finally:
        conn.close()
    _ready_path = path


def _row(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    return dict(row) if row is not None else None


def get_link(canvas_id: str) -> Optional[Dict[str, Any]]:
    ensure_schema()
    conn = auth_store.connect()
    try:
        return _row(conn.execute(
            "SELECT * FROM canvas_share_links WHERE canvas_id = ?",
            (str(canvas_id),),
        ).fetchone())
    finally:
        conn.close()


def find_by_token(token: str) -> Optional[Dict[str, Any]]:
    ensure_schema()
    conn = auth_store.connect()
    try:
        return _row(conn.execute(
            "SELECT * FROM canvas_share_links WHERE token = ?",
            (str(token or ""),),
        ).fetchone())
    finally:
        conn.close()


def _new_token() -> str:
    return "".join(secrets.choice(TOKEN_ALPHABET) for _ in range(TOKEN_LENGTH))


def upsert_link(
    canvas_id: str,
    created_by: int,
    expires_in_days: int,
    password_hash: Optional[str],
    allow_clone: bool,
    role: str = "viewer",
) -> Dict[str, Any]:
    """无链接创建；已有则更新设置，token 不变（已发出的链接继续可用），并解除撤销。"""
    ensure_schema()
    now = now_ms()
    expires_at = 0 if int(expires_in_days) == 0 else now + int(expires_in_days) * 86400000
    existing = get_link(canvas_id)
    conn = auth_store.connect()
    try:
        if existing:
            conn.execute(
                "UPDATE canvas_share_links SET role = ?, expires_at = ?, password_hash = ?, "
                "allow_clone = ?, revoked = 0 WHERE canvas_id = ?",
                (str(role), int(expires_at), password_hash, 1 if allow_clone else 0, str(canvas_id)),
            )
        else:
            for _ in range(20):
                token = _new_token()
                try:
                    conn.execute(
                        "INSERT INTO canvas_share_links (canvas_id, token, role, expires_at, password_hash, "
                        "allow_clone, created_by, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
                        (str(canvas_id), token, str(role), int(expires_at), password_hash,
                         1 if allow_clone else 0, int(created_by), now),
                    )
                    break
                except sqlite3.IntegrityError:
                    continue
            else:
                raise RuntimeError("分享 token 生成冲突，请重试")
    finally:
        conn.close()
    link = get_link(canvas_id)
    if not link:
        raise RuntimeError("分享链接写入失败")
    return link


def revoke_link(canvas_id: str) -> bool:
    ensure_schema()
    conn = auth_store.connect()
    try:
        cursor = conn.execute(
            "UPDATE canvas_share_links SET revoked = 1 WHERE canvas_id = ? AND revoked = 0",
            (str(canvas_id),),
        )
        return int(cursor.rowcount or 0) > 0
    finally:
        conn.close()


def is_expired(record: Dict[str, Any], now: Optional[int] = None) -> bool:
    expires_at = int(record.get("expires_at") or 0)
    if not expires_at:
        return False
    return expires_at <= (now_ms() if now is None else int(now))


def expires_in_days(record: Dict[str, Any], now: Optional[int] = None) -> int:
    expires_at = int(record.get("expires_at") or 0)
    if not expires_at:
        return 0
    remaining = expires_at - (now_ms() if now is None else int(now))
    if remaining <= 0:
        return 0
    days = int(math.ceil(remaining / 86400000.0))
    return max(0, min(3650, days))


def has_password(record: Optional[Dict[str, Any]]) -> bool:
    return bool(record and record.get("password_hash"))


def password_matches(record: Dict[str, Any], password: Any) -> bool:
    stored = str(record.get("password_hash") or "")
    if not stored:
        return True
    return passwords.verify_password(str(password or ""), stored)


def link_payload(record: Dict[str, Any], base_url: str) -> Dict[str, Any]:
    token = str(record.get("token") or "")
    base = str(base_url or "").rstrip("/")
    return {
        "token": token,
        "url": base + "/c/" + token,
        "role": str(record.get("role") or "viewer"),
        "expires_at": int(record.get("expires_at") or 0),
        "expires_in_days": expires_in_days(record),
        "has_password": has_password(record),
        "allow_clone": bool(int(record.get("allow_clone") or 0)),
        "created_at": int(record.get("created_at") or 0),
    }


# ---------------------------------------------------------------- 密码解锁 cookie

def _secret() -> str:
    global _secret_cache
    env_secret = os.environ.get("NOVAI_SERVER_SECRET", "").strip()
    if env_secret:
        return env_secret
    if _secret_cache:
        return _secret_cache
    path = os.path.join(auth_store.data_dir(), "share_secret")
    try:
        if os.path.isfile(path):
            _secret_cache = open(path, "r", encoding="utf-8").read().strip()
        if not _secret_cache:
            _secret_cache = secrets.token_hex(32)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(_secret_cache)
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
    except Exception:
        _secret_cache = _secret_cache or secrets.token_hex(32)
    return _secret_cache


def _sign(token: str, exp: int) -> str:
    message = ("%s:%d" % (token, int(exp))).encode("utf-8")
    return hmac.new(_secret().encode("utf-8"), message, hashlib.sha256).hexdigest()


def make_access_cookie(token: str, record: Dict[str, Any]) -> Tuple[str, int, int]:
    """返回 (cookie 值, max_age 秒, exp 毫秒)；有效期 7 天，且不超过链接自身过期时间。"""
    now = now_ms()
    exp = now + COOKIE_TTL_MS
    link_exp = int(record.get("expires_at") or 0)
    if link_exp:
        exp = min(exp, link_exp)
    if exp <= now:
        exp = now + 60 * 1000
    max_age = max(1, int((exp - now) / 1000))
    return "%s:%d:%s" % (token, exp, _sign(token, exp)), max_age, exp


def verify_access_cookie(raw: Any, token: str) -> bool:
    parts = str(raw or "").split(":")
    if len(parts) != 3:
        return False
    cookie_token, exp_raw, signature = parts
    if cookie_token != str(token or ""):
        return False
    try:
        exp = int(exp_raw)
    except (TypeError, ValueError):
        return False
    if exp <= now_ms():
        return False
    return hmac.compare_digest(signature, _sign(cookie_token, exp))


# ---------------------------------------------------------------- 解锁限速（每 IP 10 次/分钟）

def _unlock_limit() -> int:
    try:
        return max(1, int(os.environ.get("NOVAI_SHARE_UNLOCK_LIMIT", "") or UNLOCK_LIMIT))
    except (TypeError, ValueError):
        return UNLOCK_LIMIT


def clear_unlock_hits() -> None:
    """单测用：清空解锁限速窗口。"""
    with _unlock_lock:
        _unlock_hits.clear()


def unlock_rate_limited(ip: str) -> bool:
    key = str(ip or "unknown")[:64]
    now = time.monotonic()
    with _unlock_lock:
        hits = _unlock_hits.get(key)
        if hits is None:
            if len(_unlock_hits) > 5000:
                _unlock_hits.clear()
            hits = _unlock_hits[key] = deque()
        while hits and hits[0] <= now - UNLOCK_WINDOW_SECONDS:
            hits.popleft()
        hits.append(now)
        return len(hits) > _unlock_limit()
