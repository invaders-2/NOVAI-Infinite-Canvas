#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""邀请制登录的 SQLite 存储层（M1）。

数据库固定为 {DATA_DIR}/users.db，WAL 模式（单进程多线程读写 + 单文件备份）。
只依赖标准库：main.py、CLI、单测共用；反向 import main 会循环导入，
所以这里自己解析数据目录（显式 set_data_dir 优先，其次 NOVAI_DATA_DIR）。
"""
from __future__ import annotations

import os
import sqlite3
import time
from typing import Any, Dict, List, Optional, Tuple

from server.auth.errors import AuthError

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        avatar TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        ua TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)",
    """
    CREATE TABLE IF NOT EXISTS invite_codes (
        code TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'user',
        max_uses INTEGER NOT NULL DEFAULT 1,
        used INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        actor_id INTEGER NOT NULL DEFAULT 0,
        actor TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT 'ok',
        detail TEXT NOT NULL DEFAULT ''
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)",
    """
    CREATE TABLE IF NOT EXISTS auth_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS reset_codes (
        user_id INTEGER PRIMARY KEY,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
    """,
)

_DATA_DIR = ""


def set_data_dir(path: str) -> None:
    """main.py 启动时注入 DATA_DIR；空串表示回到环境变量解析（单测 / CLI 用）。"""
    global _DATA_DIR
    _DATA_DIR = str(path or "")


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def data_dir() -> str:
    if _DATA_DIR:
        return _DATA_DIR
    root = os.environ.get("NOVAI_DATA_DIR") or _project_root()
    return os.path.join(root, "data")


def db_path() -> str:
    return os.path.join(data_dir(), "users.db")


def connect() -> sqlite3.Connection:
    """每次操作短连接：FastAPI 线程池里跨线程复用连接不安全，SQLite 打开成本又很低。"""
    os.makedirs(data_dir(), exist_ok=True)
    conn = sqlite3.connect(db_path(), timeout=15)
    conn.row_factory = sqlite3.Row
    # 自动提交；需要原子性的地方显式 BEGIN IMMEDIATE（SQLite 默认的隐式事务会漏掉 DDL）
    conn.isolation_level = None
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    for statement in SCHEMA:
        conn.execute(statement)
    # 增量迁移：老库的 invite_codes 没有 disabled 列（停用邀请码用）
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(invite_codes)").fetchall()}
    if "disabled" not in columns:
        conn.execute("ALTER TABLE invite_codes ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0")
    # 增量迁移：老库的 users 没有 avatar 列（头像用，存 avatars/ 下的相对文件名）
    user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "avatar" not in user_columns:
        conn.execute("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''")
    return conn


def _row(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    return dict(row) if row is not None else None


# ---------------------------------------------------------------- users

def count_users() -> int:
    conn = connect()
    try:
        row = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()
        return int(row["n"] if row else 0)
    finally:
        conn.close()


def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    conn = connect()
    try:
        return _row(conn.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone())
    finally:
        conn.close()


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    conn = connect()
    try:
        return _row(conn.execute("SELECT * FROM users WHERE username = ?", (str(username),)).fetchone())
    finally:
        conn.close()


def insert_user(username: str, password_hash: str, role: str, created_at: int) -> Dict[str, Any]:
    conn = connect()
    try:
        cursor = conn.execute(
            "INSERT INTO users (username, password_hash, role, status, created_at) VALUES (?, ?, ?, 'active', ?)",
            (str(username), str(password_hash), str(role), int(created_at)),
        )
        user_id = int(cursor.lastrowid)
    except sqlite3.IntegrityError:
        raise AuthError("用户名已被占用", 400, "username_taken")
    finally:
        conn.close()
    return get_user_by_id(user_id) or {}


def set_user_role(user_id: int, role: str) -> int:
    conn = connect()
    try:
        cursor = conn.execute("UPDATE users SET role = ? WHERE id = ?", (str(role), int(user_id)))
        return int(cursor.rowcount or 0)
    finally:
        conn.close()


def set_user_password_hash(user_id: int, password_hash: str) -> int:
    conn = connect()
    try:
        cursor = conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (str(password_hash), int(user_id)),
        )
        return int(cursor.rowcount or 0)
    finally:
        conn.close()


def set_username(user_id: int, username: str) -> int:
    conn = connect()
    try:
        cursor = conn.execute("UPDATE users SET username = ? WHERE id = ?", (str(username), int(user_id)))
        return int(cursor.rowcount or 0)
    except sqlite3.IntegrityError:
        raise AuthError("用户名已被占用", 400, "username_taken")
    finally:
        conn.close()


def count_users_created_since(since_ts: int) -> int:
    conn = connect()
    try:
        row = conn.execute("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", (int(since_ts),)).fetchone()
        return int(row["n"] if row else 0)
    finally:
        conn.close()


def count_active_invites(now: int) -> int:
    conn = connect()
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM invite_codes "
            "WHERE disabled = 0 AND used < max_uses AND (expires_at IS NULL OR expires_at > ?)",
            (int(now),),
        ).fetchone()
        return int(row["n"] if row else 0)
    finally:
        conn.close()


def set_user_avatar(user_id: int, avatar: str) -> int:
    conn = connect()
    try:
        cursor = conn.execute("UPDATE users SET avatar = ? WHERE id = ?", (str(avatar or ""), int(user_id)))
        return int(cursor.rowcount or 0)
    finally:
        conn.close()


def set_user_status(user_id: int, status: str) -> int:
    conn = connect()
    try:
        cursor = conn.execute("UPDATE users SET status = ? WHERE id = ?", (str(status), int(user_id)))
        return int(cursor.rowcount or 0)
    finally:
        conn.close()


def delete_sessions_for_user(user_id: int, keep_token_hash: str = "") -> int:
    """删掉该用户全部会话；keep_token_hash 非空时保留这一条（改密码后保持当前设备登录）。"""
    conn = connect()
    try:
        if keep_token_hash:
            cursor = conn.execute(
                "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                (int(user_id), str(keep_token_hash)),
            )
        else:
            cursor = conn.execute("DELETE FROM sessions WHERE user_id = ?", (int(user_id),))
        return int(cursor.rowcount or 0)
    finally:
        conn.close()


def list_users(limit: int = 100) -> List[Dict[str, Any]]:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id, username, role, status, created_at FROM users ORDER BY id LIMIT ?",
            (max(1, int(limit)),),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------- sessions

def create_session(token_hash: str, user_id: int, expires_at: int, ip: str = "", ua: str = "") -> None:
    conn = connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?)",
            (str(token_hash), int(user_id), int(expires_at), str(ip or ""), str(ua or "")),
        )
    finally:
        conn.close()


def get_session(token_hash: str) -> Optional[Dict[str, Any]]:
    conn = connect()
    try:
        return _row(conn.execute("SELECT * FROM sessions WHERE token_hash = ?", (str(token_hash),)).fetchone())
    finally:
        conn.close()


def delete_session(token_hash: str) -> None:
    conn = connect()
    try:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (str(token_hash),))
    finally:
        conn.close()


def delete_expired_sessions(now: int) -> int:
    conn = connect()
    try:
        cursor = conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(now),))
        return int(cursor.rowcount or 0)
    finally:
        conn.close()


# ---------------------------------------------------------------- 重置码

def set_reset_code(user_id: int, code_hash: str, expires_at: int, created_at: int) -> None:
    """一个用户只保留一条重置码：INSERT OR REPLACE 天然把旧码作废。"""
    conn = connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO reset_codes (user_id, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
            (int(user_id), str(code_hash), int(expires_at), int(created_at)),
        )
    finally:
        conn.close()


def get_reset_code(user_id: int) -> Optional[Dict[str, Any]]:
    conn = connect()
    try:
        return _row(conn.execute("SELECT * FROM reset_codes WHERE user_id = ?", (int(user_id),)).fetchone())
    finally:
        conn.close()


def delete_reset_code(user_id: int) -> int:
    conn = connect()
    try:
        cursor = conn.execute("DELETE FROM reset_codes WHERE user_id = ?", (int(user_id),))
        return int(cursor.rowcount or 0)
    finally:
        conn.close()


def consume_reset_code(user_id: int, code_hash: str) -> bool:
    """一次性消费：只有真正删除成功的那次请求能继续改密码（并发下也只有一个赢家）。"""
    conn = connect()
    try:
        cursor = conn.execute(
            "DELETE FROM reset_codes WHERE user_id = ? AND code_hash = ?",
            (int(user_id), str(code_hash)),
        )
        return bool(cursor.rowcount)
    finally:
        conn.close()


# ---------------------------------------------------------------- invites

def get_invite(code: str) -> Optional[Dict[str, Any]]:
    conn = connect()
    try:
        return _row(conn.execute("SELECT * FROM invite_codes WHERE code = ?", (str(code),)).fetchone())
    finally:
        conn.close()


def insert_invite(code: str, role: str, max_uses: int, expires_at: Optional[int], created_by: str) -> None:
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO invite_codes (code, role, max_uses, used, expires_at, created_by) VALUES (?, ?, ?, 0, ?, ?)",
            (str(code), str(role), int(max_uses), expires_at, str(created_by or "")),
        )
    finally:
        conn.close()


def list_invites(limit: int = 50) -> List[Dict[str, Any]]:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT code, role, max_uses, used, expires_at, disabled, created_by "
            "FROM invite_codes ORDER BY rowid DESC LIMIT ?",
            (max(1, int(limit)),),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def set_invite_disabled(code: str) -> int:
    conn = connect()
    try:
        cursor = conn.execute("UPDATE invite_codes SET disabled = 1 WHERE code = ?", (str(code),))
        return int(cursor.rowcount or 0)
    finally:
        conn.close()


def audit(action: str, actor: Optional[Dict[str, Any]], target: str = "", result: str = "ok", detail: str = "") -> None:
    """写一条管理操作审计；日志失败不能影响主流程。"""
    try:
        actor = actor or {}
        actor_id = int(actor.get("id") or 0)
        actor_name = str(actor.get("username") or "")[:64]
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO audit_log (created_at, actor_id, actor, action, target, result, detail) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    int(time.time()),
                    actor_id,
                    actor_name,
                    str(action or "")[:64],
                    str(target or "")[:128],
                    str(result or "ok")[:16],
                    str(detail or "")[:500],
                ),
            )
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 - 审计不能阻断业务
        print(f"[auth] 审计日志写入失败：{exc}")


def list_audit(limit: int = 100) -> List[Dict[str, Any]]:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT created_at, actor_id, actor, action, target, result, detail "
            "FROM audit_log ORDER BY id DESC LIMIT ?",
            (max(1, int(limit)),),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def register_with_invite(username: str, password_hash: str, invite_code: str, now: int) -> Dict[str, Any]:
    """扣减邀请码并建用户放在同一事务里：并发注册不会把 max_uses 用超。"""
    conn = connect()
    user_id = 0
    try:
        conn.execute("BEGIN IMMEDIATE")
        invite = conn.execute(
            "SELECT code, role, max_uses, used, expires_at, disabled FROM invite_codes WHERE code = ?",
            (str(invite_code),),
        ).fetchone()
        if invite is None:
            raise AuthError("邀请码无效", 400, "invalid_invite")
        if int(invite["disabled"] or 0):
            raise AuthError("邀请码已停用", 400, "invite_disabled")
        expires_at = invite["expires_at"]
        if expires_at is not None and int(expires_at) <= int(now):
            raise AuthError("邀请码已过期", 400, "invite_expired")
        if int(invite["used"]) >= int(invite["max_uses"]):
            raise AuthError("邀请码已用完", 400, "invite_exhausted")
        try:
            cursor = conn.execute(
                "INSERT INTO users (username, password_hash, role, status, created_at) VALUES (?, ?, ?, 'active', ?)",
                (str(username), str(password_hash), str(invite["role"]), int(now)),
            )
        except sqlite3.IntegrityError:
            raise AuthError("用户名已被占用", 400, "username_taken")
        user_id = int(cursor.lastrowid)
        conn.execute("UPDATE invite_codes SET used = used + 1 WHERE code = ?", (str(invite_code),))
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()
    return get_user_by_id(user_id) or {}


# ---------------------------------------------------------------- settings / 开放注册（2026-11-07）

def get_setting(key: str, default: str = "") -> str:
    conn = connect()
    try:
        row = conn.execute("SELECT value FROM auth_settings WHERE key = ?", (str(key),)).fetchone()
        return str(row["value"]) if row is not None else default
    finally:
        conn.close()


def set_setting(key: str, value: str) -> None:
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO auth_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(key), str(value)),
        )
    finally:
        conn.close()


# ---------------------------------------------------------------- 注销账号（2026-11）

def _table_names(conn: sqlite3.Connection) -> set:
    """users.db 里的表是各功能按需建的（画布共享 / 分享链接 / 积分），老库可能没有。"""
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {str(row["name"]) for row in rows}


def account_counts() -> Tuple[int, int]:
    """(账号总数, 在职管理员数)：注销时判断「是不是最后一个管理员」。"""
    conn = connect()
    try:
        total = int(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"])
        admins = int(conn.execute(
            "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'"
        ).fetchone()["n"])
        return total, admins
    finally:
        conn.close()


def account_impact(user_id: int, username: str, canvas_ids: Optional[List[str]] = None) -> Dict[str, int]:
    """注销前的影响面统计（只读）：画布 / 成员 / 别人的共享 / 邀请码 / 分享链接 / 积分流水。"""
    uid = int(user_id)
    owned = [str(cid) for cid in (canvas_ids or [])]
    counts: Dict[str, int] = {
        "canvases": len(owned),
        "canvas_members": 0,
        "shared_canvases": 0,
        "invites": 0,
        "share_links": 0,
        "credit_records": 0,
    }
    conn = connect()
    try:
        tables = _table_names(conn)
        if "canvas_shares" in tables:
            for cid in owned:
                row = conn.execute(
                    "SELECT COUNT(*) AS n FROM canvas_shares WHERE canvas_id = ?", (cid,)
                ).fetchone()
                counts["canvas_members"] += int(row["n"] if row else 0)
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM canvas_shares WHERE user_id = ?", (uid,)
            ).fetchone()
            counts["shared_canvases"] = int(row["n"] if row else 0)
        if "invite_codes" in tables:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM invite_codes WHERE created_by = ?", (str(username),)
            ).fetchone()
            counts["invites"] = int(row["n"] if row else 0)
        if "canvas_share_links" in tables:
            # 同一行可能既在名下画布又由本人创建：按 distinct 行数统计，别重复算
            if owned:
                placeholders = ",".join("?" for _ in owned)
                row = conn.execute(
                    "SELECT COUNT(*) AS n FROM canvas_share_links "
                    "WHERE created_by = ? OR canvas_id IN (%s)" % placeholders,
                    tuple([uid] + owned),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT COUNT(*) AS n FROM canvas_share_links WHERE created_by = ?", (uid,)
                ).fetchone()
            counts["share_links"] = int(row["n"] if row else 0)
        for table in ("credit_transactions", "credit_charges"):
            if table in tables:
                row = conn.execute(
                    "SELECT COUNT(*) AS n FROM %s WHERE user_id = ?" % table, (uid,)
                ).fetchone()
                counts["credit_records"] += int(row["n"] if row else 0)
        return counts
    finally:
        conn.close()


def purge_account(user_id: int, username: str, canvas_ids: Optional[List[str]] = None) -> Dict[str, int]:
    """删账号与它独占的数据库数据：单个事务，任何一步失败整体回滚，库里一行都不动。

    调用方要先把名下画布的 JSON 文件挪走（失败时再挪回来），这里只删数据库归属。
    别人的画布只退出共享（canvas_shares.user_id），不动画布本身。
    """
    uid = int(user_id)
    name = str(username or "")
    owned = [str(cid) for cid in (canvas_ids or [])]
    counts: Dict[str, int] = {
        "users": 0,
        "canvases": len(owned),
        "sessions": 0,
        "reset_codes": 0,
        "canvas_members": 0,
        "canvas_shares_out": 0,
        "invites": 0,
        "share_links": 0,
        "credit_records": 0,
    }
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        tables = _table_names(conn)
        if "sessions" in tables:
            counts["sessions"] = int(conn.execute("DELETE FROM sessions WHERE user_id = ?", (uid,)).rowcount or 0)
        if "reset_codes" in tables:
            counts["reset_codes"] = int(conn.execute("DELETE FROM reset_codes WHERE user_id = ?", (uid,)).rowcount or 0)
        if "invite_codes" in tables:
            counts["invites"] = int(conn.execute(
                "DELETE FROM invite_codes WHERE created_by = ?", (name,)
            ).rowcount or 0)
        if "canvas_shares" in tables:
            # 名下画布整本删：这些画布的成员记录一起清掉
            for cid in owned:
                counts["canvas_members"] += int(conn.execute(
                    "DELETE FROM canvas_shares WHERE canvas_id = ?", (cid,)
                ).rowcount or 0)
            # 别人分享给我的画布：只退出，画布本身保留
            counts["canvas_shares_out"] = int(conn.execute(
                "DELETE FROM canvas_shares WHERE user_id = ?", (uid,)
            ).rowcount or 0)
        if "canvas_share_links" in tables:
            for cid in owned:
                counts["share_links"] += int(conn.execute(
                    "DELETE FROM canvas_share_links WHERE canvas_id = ?", (cid,)
                ).rowcount or 0)
            counts["share_links"] += int(conn.execute(
                "DELETE FROM canvas_share_links WHERE created_by = ?", (uid,)
            ).rowcount or 0)
        for table in ("credit_transactions", "credit_charges"):
            if table in tables:
                counts["credit_records"] += int(conn.execute(
                    "DELETE FROM %s WHERE user_id = ?" % table, (uid,)
                ).rowcount or 0)
        counts["users"] = int(conn.execute("DELETE FROM users WHERE id = ?", (uid,)).rowcount or 0)
        if counts["users"] != 1:
            raise AuthError("账号不存在或已被删除", 404, "user_not_found")
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()
    return counts


def register_open(username: str, password_hash: str, now: int, first_user_role: str = "admin") -> Dict[str, Any]:
    """不需要邀请码的注册：库里还没有任何用户时，第一个账号直接是管理员（本机第一个人管这台 NOVAI）；
    数用户和建用户放在同一事务里，两个人同时抢第一个注册也只会有一个管理员。"""
    conn = connect()
    user_id = 0
    try:
        conn.execute("BEGIN IMMEDIATE")
        total = int(conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"])
        role = str(first_user_role) if total == 0 else "user"
        try:
            cursor = conn.execute(
                "INSERT INTO users (username, password_hash, role, status, created_at) VALUES (?, ?, ?, 'active', ?)",
                (str(username), str(password_hash), role, int(now)),
            )
        except sqlite3.IntegrityError:
            raise AuthError("用户名已被占用", 400, "username_taken")
        user_id = int(cursor.lastrowid)
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()
    return get_user_by_id(user_id) or {}
