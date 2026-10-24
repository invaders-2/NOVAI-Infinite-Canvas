#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""画布权限（M3）：canvas_shares 表 + owner/admin/editor/viewer 角色判定。

与邀请制登录共用 {DATA_DIR}/users.db；本模块只在 auth-on 的请求里被调用，
auth-off 时 main.py 根本不会进这些函数，因此不会创建 users.db 或新表。
"""
from __future__ import annotations

import sqlite3
import time
from typing import Any, Dict, List, Optional

from server.auth import store as auth_store
from server.auth.errors import AuthError

ROLE_VIEWER = "viewer"
ROLE_EDITOR = "editor"
MEMBER_ROLES = (ROLE_VIEWER, ROLE_EDITOR)

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS canvas_shares (
        canvas_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
        created_by INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (canvas_id, user_id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_canvas_shares_user ON canvas_shares(user_id)",
)

_ready_path = ""


def ensure_schema() -> None:
    """幂等建表；数据目录被切换（单测）时重新建一次。"""
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


# ---------------------------------------------------------------- 读取

def get_share(canvas_id: str, user_id: int) -> Optional[Dict[str, Any]]:
    ensure_schema()
    conn = auth_store.connect()
    try:
        return _row(conn.execute(
            "SELECT canvas_id, user_id, role, created_by, created_at FROM canvas_shares "
            "WHERE canvas_id = ? AND user_id = ?",
            (str(canvas_id), int(user_id)),
        ).fetchone())
    finally:
        conn.close()


def list_members(canvas_id: str) -> List[Dict[str, Any]]:
    ensure_schema()
    conn = auth_store.connect()
    try:
        rows = conn.execute(
            "SELECT s.user_id, u.username, s.role, s.created_at "
            "FROM canvas_shares s LEFT JOIN users u ON u.id = s.user_id "
            "WHERE s.canvas_id = ? ORDER BY s.created_at, s.user_id",
            (str(canvas_id),),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def shared_roles_for_user(user_id: int) -> Dict[str, str]:
    """{canvas_id: role}，用于列表一次性判断，避免每条画布查一次库。"""
    ensure_schema()
    conn = auth_store.connect()
    try:
        rows = conn.execute(
            "SELECT canvas_id, role FROM canvas_shares WHERE user_id = ?",
            (int(user_id),),
        ).fetchall()
        return {str(row["canvas_id"]): str(row["role"]) for row in rows}
    finally:
        conn.close()


def user_names() -> Dict[int, str]:
    """id → username，用于列表的 owner_username（一次查询）。"""
    ensure_schema()
    conn = auth_store.connect()
    try:
        rows = conn.execute("SELECT id, username FROM users").fetchall()
        return {int(row["id"]): str(row["username"]) for row in rows}
    finally:
        conn.close()


def get_user(user_id: Any) -> Optional[Dict[str, Any]]:
    ensure_schema()
    return auth_store.get_user_by_id(int(user_id))


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    ensure_schema()
    return auth_store.get_user_by_username(str(username or "").strip())


# ---------------------------------------------------------------- 写入

def add_member(canvas_id: str, user_id: int, role: str, created_by: int) -> Dict[str, Any]:
    ensure_schema()
    if role not in MEMBER_ROLES:
        raise AuthError("角色只能是 viewer 或 editor", 400, "invalid_role")
    conn = auth_store.connect()
    try:
        conn.execute(
            "INSERT INTO canvas_shares (canvas_id, user_id, role, created_by, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (str(canvas_id), int(user_id), str(role), int(created_by), int(time.time())),
        )
    except sqlite3.IntegrityError:
        raise AuthError("该用户已在成员列表中", 409, "member_exists")
    finally:
        conn.close()
    return get_share(canvas_id, user_id) or {}


def update_member_role(canvas_id: str, user_id: int, role: str) -> Dict[str, Any]:
    ensure_schema()
    if role not in MEMBER_ROLES:
        raise AuthError("角色只能是 viewer 或 editor", 400, "invalid_role")
    conn = auth_store.connect()
    try:
        cursor = conn.execute(
            "UPDATE canvas_shares SET role = ? WHERE canvas_id = ? AND user_id = ?",
            (str(role), str(canvas_id), int(user_id)),
        )
    finally:
        conn.close()
    if int(cursor.rowcount or 0) == 0:
        raise AuthError("成员不存在", 404, "member_not_found")
    return get_share(canvas_id, user_id) or {}


def remove_member(canvas_id: str, user_id: int) -> None:
    ensure_schema()
    conn = auth_store.connect()
    try:
        cursor = conn.execute(
            "DELETE FROM canvas_shares WHERE canvas_id = ? AND user_id = ?",
            (str(canvas_id), int(user_id)),
        )
    finally:
        conn.close()
    if int(cursor.rowcount or 0) == 0:
        raise AuthError("成员不存在", 404, "member_not_found")


# ---------------------------------------------------------------- 角色判定

def resolve_role(owner_id: Optional[int], user: Optional[Dict[str, Any]], share: Optional[Dict[str, Any]]) -> Optional[str]:
    """owner 优先，其次 admin，最后是显式分享角色；没关系返回 None。"""
    if not user:
        return None
    user_id = int(user.get("id"))
    if owner_id is not None and int(owner_id) == user_id:
        return "owner"
    if str(user.get("role")) == "admin":
        return "admin"
    if share and str(share.get("role")) in MEMBER_ROLES:
        return str(share["role"])
    return None


def can(role: Optional[str], need: str = "view") -> bool:
    """need: view / edit / manage。owner 与 admin 全通；editor 可读写；viewer 只读。"""
    if role in ("owner", "admin"):
        return True
    if role == "editor":
        return need in ("view", "edit")
    if role == "viewer":
        return need == "view"
    return False


def audit(action: str, actor: Optional[Dict[str, Any]], canvas_id: str, target: str, result: str = "ok", detail: str = "") -> None:
    auth_store.audit(action, actor, "%s:%s" % (canvas_id, target), result, detail)
