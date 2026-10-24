#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""积分账本（SQLite，复用 users.db / WAL）。

三张表：
    users.credits            余额（迁移新增，幂等）
    credit_transactions      流水：每笔余额变化都写，balance_after 可对账
    credit_charges           任务扣费：预扣 pending → settled（按实际多退少补）/ refunded

并发策略：
    - 每次操作短连接；
    - 所有「读余额 → 扣/加 → 写流水」放在 BEGIN IMMEDIATE 事务里，并发扣费只有一个赢家；
    - 预扣和结算都用 status 做幂等：同一 charge 结算/退款只生效一次。
"""
from __future__ import annotations

import json
import math
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional, Tuple

from server.credits import config
from server.credits.errors import InsufficientBalance

_DATA_DIR = ""
_EPSILON = 1e-6

SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS credit_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        delta REAL NOT NULL,
        balance_after REAL NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        cost_usd REAL NOT NULL DEFAULT 0,
        price_usd REAL NOT NULL DEFAULT 0,
        profit_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions(user_id, id DESC)",
    """
    CREATE TABLE IF NOT EXISTS credit_charges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        task_ref TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT '',
        params_json TEXT NOT NULL DEFAULT '{}',
        estimate REAL NOT NULL DEFAULT 0,
        charged REAL NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        price_usd REAL NOT NULL DEFAULT 0,
        profit_usd REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        estimate_cost REAL NOT NULL DEFAULT 0,
        actual INTEGER NOT NULL DEFAULT 0,
        pricing_fallback INTEGER NOT NULL DEFAULT 0,
        unmapped_json TEXT NOT NULL DEFAULT '[]',
        matched_spec TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL DEFAULT '',
        pricing_source TEXT NOT NULL DEFAULT 'direct',
        proxy_model TEXT NOT NULL DEFAULT ''
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_credit_charges_user ON credit_charges(user_id, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_credit_charges_status ON credit_charges(status, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_credit_charges_task ON credit_charges(task_ref)",
)

CHARGE_COLUMNS = (
    ("estimate_cost", "REAL NOT NULL DEFAULT 0"),
    ("actual", "INTEGER NOT NULL DEFAULT 0"),
    ("pricing_fallback", "INTEGER NOT NULL DEFAULT 0"),
    ("unmapped_json", "TEXT NOT NULL DEFAULT '[]'"),
    ("matched_spec", "TEXT NOT NULL DEFAULT ''"),
    ("note", "TEXT NOT NULL DEFAULT ''"),
    ("provider", "TEXT NOT NULL DEFAULT ''"),
    ("pricing_source", "TEXT NOT NULL DEFAULT 'direct'"),
    ("proxy_model", "TEXT NOT NULL DEFAULT ''"),
)


def set_data_dir(path: str) -> None:
    """显式覆盖（独立脚本/CLI 用）；正常服务与测试都走动态解析，import 时不绑定。"""
    global _DATA_DIR
    _DATA_DIR = str(path or "")


def reset_for_tests() -> None:
    """清掉显式覆盖，让下一次调用重新按当前 env/auth store 解析数据目录。"""
    global _DATA_DIR
    _DATA_DIR = ""


def data_dir() -> str:
    """每次调用都重新解析：优先显式 set_data_dir，其次 auth store（它跟随当前环境/测试切换），
    最后才是 NOVAI_DATA_DIR。import 时不缓存路径，避免多测试套件串库。"""
    if _DATA_DIR:
        return _DATA_DIR
    try:
        from server.auth import store as auth_store
        return auth_store.data_dir()
    except Exception:
        root = os.environ.get("NOVAI_DATA_DIR") or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        return os.path.join(root, "data")


def db_path() -> str:
    return os.path.join(data_dir(), "users.db")


def connect() -> sqlite3.Connection:
    os.makedirs(data_dir(), exist_ok=True)
    conn = sqlite3.connect(db_path(), timeout=20)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    for statement in SCHEMA:
        conn.execute(statement)
    _migrate(conn)
    return conn


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (str(name),)).fetchone()
    return row is not None


def _migrate(conn: sqlite3.Connection) -> None:
    # users.credits：users 表由邀请制登录模块创建；还没建就等下次连接再迁移
    if _table_exists(conn, "users"):
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "credits" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN credits REAL NOT NULL DEFAULT 0")
    charge_columns = {row["name"] for row in conn.execute("PRAGMA table_info(credit_charges)").fetchall()}
    for name, ddl in CHARGE_COLUMNS:
        if name not in charge_columns:
            conn.execute("ALTER TABLE credit_charges ADD COLUMN %s %s" % (name, ddl))


def _row(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    return dict(row) if row is not None else None


def _now() -> int:
    return int(time.time())


def _clean_amount(value: Any) -> float:
    return round(float(value or 0), 6)


# ---------------------------------------------------------------- 余额 / 流水

def _user_exists(conn: sqlite3.Connection, user_id: int) -> bool:
    if not _table_exists(conn, "users"):
        return False
    return conn.execute("SELECT 1 FROM users WHERE id = ?", (int(user_id),)).fetchone() is not None


def balance(user_id: int) -> float:
    conn = connect()
    try:
        if not _table_exists(conn, "users"):
            return 0.0
        row = conn.execute("SELECT credits FROM users WHERE id = ?", (int(user_id),)).fetchone()
        return _clean_amount(row["credits"]) if row else 0.0
    finally:
        conn.close()


def _insert_transaction(conn: sqlite3.Connection, user_id: int, delta: float, balance_after: float,
                        kind: str, ref: str = "", note: str = "", cost_usd: float = 0.0,
                        price_usd: float = 0.0, profit_usd: float = 0.0) -> int:
    cursor = conn.execute(
        "INSERT INTO credit_transactions (user_id, delta, balance_after, kind, ref, note, "
        "cost_usd, price_usd, profit_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (int(user_id), _clean_amount(delta), _clean_amount(balance_after), str(kind or ""),
         str(ref or ""), str(note or ""), _clean_amount(cost_usd), _clean_amount(price_usd),
         _clean_amount(profit_usd), _now()),
    )
    return int(cursor.lastrowid)


def adjust_credits(user_id: int, delta: float, kind: str = "admin_adjust", ref: str = "",
                   note: str = "", cost_usd: float = 0.0, price_usd: float = 0.0,
                   profit_usd: float = 0.0) -> Dict[str, Any]:
    """管理员调账：允许正负；扣到 0 以下抛 InsufficientBalance（契约 400）。"""
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT credits FROM users WHERE id = ?", (int(user_id),)).fetchone()
        if row is None:
            conn.execute("ROLLBACK")
            raise ValueError("user_not_found")
        current = _clean_amount(row["credits"])
        new_balance = round(current + float(delta), 6)
        if new_balance < -_EPSILON:
            conn.execute("ROLLBACK")
            raise InsufficientBalance(current, float(delta))
        conn.execute("UPDATE users SET credits = ? WHERE id = ?", (_clean_amount(new_balance), int(user_id)))
        tx_id = _insert_transaction(conn, user_id, float(delta), new_balance, kind, ref, note,
                                    cost_usd, price_usd, profit_usd)
        conn.execute("COMMIT")
        return {"balance": _clean_amount(new_balance), "delta": float(delta), "transaction_id": tx_id}
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


def list_transactions(user_id: int, limit: int = 50) -> List[Dict[str, Any]]:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id, user_id, delta, balance_after, kind, ref, note, cost_usd, price_usd, profit_usd, created_at "
            "FROM credit_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?",
            (int(user_id), max(1, min(500, int(limit)))),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------- 扣费单

def _charge_row(conn: sqlite3.Connection, charge_id: int) -> Optional[Dict[str, Any]]:
    return _row(conn.execute("SELECT * FROM credit_charges WHERE id = ?", (int(charge_id),)).fetchone())


def _charge_payload(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    data = dict(row)
    try:
        data["params"] = json.loads(data.get("params_json") or "{}")
    except ValueError:
        data["params"] = {}
    try:
        data["unmapped"] = json.loads(data.get("unmapped_json") or "[]")
    except ValueError:
        data["unmapped"] = []
    return data


def set_charge_task_ref(charge_id: int, task_ref: str) -> None:
    """预扣发生在 task_create 之前时，任务建成后把 task_ref 补到扣费单上（仅记录用途）。"""
    conn = connect()
    try:
        conn.execute("UPDATE credit_charges SET task_ref = ? WHERE id = ?",
                     (str(task_ref or ""), int(charge_id)))
    finally:
        conn.close()


def get_charge(charge_id: int) -> Optional[Dict[str, Any]]:
    conn = connect()
    try:
        return _charge_payload(_charge_row(conn, charge_id))
    finally:
        conn.close()


def create_charge(user_id: int, estimate: float, kind: str, model: str, params: Optional[Dict[str, Any]] = None,
                  task_ref: str = "", estimate_cost: float = 0.0, cost_usd: float = 0.0,
                  price_usd: float = 0.0, profit_usd: float = 0.0, pricing_fallback: bool = False,
                  unmapped: Optional[List[str]] = None, matched_spec: str = "",
                  note: str = "", provider: str = "", pricing_source: str = "direct",
                  proxy_model: str = "") -> Dict[str, Any]:
    """预扣：余额不足抛 InsufficientCredits；成功返回含 balance_after 的扣费单。"""
    from server.credits.errors import InsufficientCredits

    estimate = _clean_amount(estimate)
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT credits FROM users WHERE id = ?", (int(user_id),)).fetchone()
        if row is None:
            conn.execute("ROLLBACK")
            raise InsufficientCredits(estimate, 0.0, "账户不存在")
        current = _clean_amount(row["credits"])
        if current + _EPSILON < estimate:
            conn.execute("ROLLBACK")
            raise InsufficientCredits(estimate, current)
        new_balance = round(current - estimate, 6)
        conn.execute("UPDATE users SET credits = ? WHERE id = ?", (new_balance, int(user_id)))
        now = _now()
        cursor = conn.execute(
            "INSERT INTO credit_charges (user_id, task_ref, model, kind, params_json, estimate, charged, "
            "cost_usd, price_usd, profit_usd, status, created_at, estimate_cost, actual, pricing_fallback, "
            "unmapped_json, matched_spec, note, provider, pricing_source, proxy_model) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
            (int(user_id), str(task_ref or ""), str(model or ""), str(kind or ""),
             json.dumps(params or {}, ensure_ascii=False, default=str), estimate, estimate,
             _clean_amount(cost_usd), _clean_amount(price_usd), _clean_amount(profit_usd), now,
             _clean_amount(estimate_cost), 1 if pricing_fallback else 0,
             json.dumps(unmapped or [], ensure_ascii=False), str(matched_spec or ""), str(note or ""),
             str(provider or ""), str(pricing_source or "direct"), str(proxy_model or "")),
        )
        charge_id = int(cursor.lastrowid)
        tx_id = _insert_transaction(conn, user_id, -estimate, new_balance, "charge",
                                    str(task_ref or ("charge:%d" % charge_id)), note,
                                    cost_usd, price_usd, profit_usd)
        conn.execute("COMMIT")
        charge = _charge_payload(_charge_row(conn, charge_id)) or {}
        charge["balance_after"] = new_balance
        charge["transaction_id"] = tx_id
        return charge
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


def settle_charge(charge_id: int, actual_price: float, actual_cost_usd: float, actual_price_usd: float,
                  profit_usd: float, actual: bool = False, note: str = "",
                  matched_spec: str = "") -> Dict[str, Any]:
    """按实际结算：多退少补；同一 charge 幂等（非 pending 直接返回现状）。"""
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = _charge_row(conn, charge_id)
        if row is None:
            conn.execute("ROLLBACK")
            raise ValueError("charge_not_found")
        if str(row.get("status")) != "pending":
            conn.execute("ROLLBACK")
            charge = _charge_payload(row) or {}
            charge["balance_after"] = balance(int(row["user_id"]))
            charge["noop"] = True
            return charge
        user_id = int(row["user_id"])
        current_charge = _clean_amount(row["charged"])
        target_charge = _clean_amount(actual_price)
        delta = round(target_charge - current_charge, 6)
        user_row = conn.execute("SELECT credits FROM users WHERE id = ?", (user_id,)).fetchone()
        current_balance = _clean_amount(user_row["credits"]) if user_row else 0.0
        # 多退少补：正数补扣、负数退回。实际成本高于预扣时允许把余额扣成负数（记欠费），
        # 绝不因为余额不够就少记成本——那等于平台吞掉差额、每单亏一点。
        new_balance = round(current_balance - delta, 6)
        conn.execute("UPDATE users SET credits = ? WHERE id = ?", (new_balance, user_id))
        settled_at = _now()
        final_note = str(note or "")
        if new_balance < -_EPSILON:
            final_note = (final_note + "；" if final_note else "") + "balance_debt=%.6f" % new_balance
        conn.execute(
            "UPDATE credit_charges SET charged = ?, cost_usd = ?, price_usd = ?, profit_usd = ?, "
            "status = 'settled', settled_at = ?, actual = ?, matched_spec = ?, note = ? WHERE id = ?",
            (_clean_amount(target_charge), _clean_amount(actual_cost_usd), _clean_amount(actual_price_usd),
             _clean_amount(profit_usd), settled_at, 1 if actual else 0, str(matched_spec or ""),
             final_note, int(charge_id)),
        )
        if abs(delta) > _EPSILON:
            tx_kind = "settle" if delta > 0 else "refund"
            _insert_transaction(conn, user_id, -delta, new_balance, tx_kind, "charge:%d" % int(charge_id),
                                final_note, actual_cost_usd, actual_price_usd, profit_usd)
        conn.execute("COMMIT")
        charge = _charge_payload(_charge_row(conn, charge_id)) or {}
        charge["balance_after"] = new_balance
        charge["delta"] = round(-delta, 6)
        charge["balance_debt"] = new_balance if new_balance < -_EPSILON else 0.0
        return charge
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


def refund_charge(charge_id: int, reason: str = "") -> Dict[str, Any]:
    """失败/取消退款：把预扣的 charged 原路退回；非 pending 幂等返回。"""
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = _charge_row(conn, charge_id)
        if row is None:
            conn.execute("ROLLBACK")
            raise ValueError("charge_not_found")
        if str(row.get("status")) != "pending":
            conn.execute("ROLLBACK")
            charge = _charge_payload(row) or {}
            charge["balance_after"] = balance(int(row["user_id"]))
            charge["noop"] = True
            return charge
        user_id = int(row["user_id"])
        refund = _clean_amount(row["charged"])
        user_row = conn.execute("SELECT credits FROM users WHERE id = ?", (user_id,)).fetchone()
        current_balance = _clean_amount(user_row["credits"]) if user_row else 0.0
        new_balance = round(current_balance + refund, 6)
        conn.execute("UPDATE users SET credits = ? WHERE id = ?", (new_balance, user_id))
        conn.execute(
            "UPDATE credit_charges SET status = 'refunded', settled_at = ?, note = ? WHERE id = ?",
            (_now(), str(reason or ""), int(charge_id)),
        )
        if refund > _EPSILON:
            _insert_transaction(conn, user_id, refund, new_balance, "refund",
                                "charge:%d" % int(charge_id), str(reason or ""), 0.0,
                                round(refund * config.usd_per_credit(), 6), 0.0)
        conn.execute("COMMIT")
        charge = _charge_payload(_charge_row(conn, charge_id)) or {}
        charge["balance_after"] = new_balance
        charge["refunded"] = refund
        return charge
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


def list_charges(user_id: Optional[int] = None, limit: int = 50, status: str = "") -> List[Dict[str, Any]]:
    conn = connect()
    try:
        clauses = []
        values: List[Any] = []
        if user_id is not None:
            clauses.append("user_id = ?")
            values.append(int(user_id))
        if status:
            clauses.append("status = ?")
            values.append(str(status))
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = conn.execute(
            "SELECT * FROM credit_charges" + where + " ORDER BY id DESC LIMIT ?",
            (*values, max(1, min(500, int(limit)))),
        ).fetchall()
        return [_charge_payload(row) or {} for row in rows]
    finally:
        conn.close()


def expire_pending_charges(ttl_hours: int = 24) -> int:
    """兜底：长时间挂着的 pending 扣费单自动退款（避免用户余额被永久占用）。"""
    cutoff = _now() - max(1, int(ttl_hours)) * 3600
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id FROM credit_charges WHERE status = 'pending' AND created_at < ? ORDER BY id",
            (cutoff,),
        ).fetchall()
    finally:
        conn.close()
    count = 0
    for row in rows:
        try:
            refund_charge(int(row["id"]), "pending_timeout")
            count += 1
        except Exception as exc:  # noqa: BLE001 - 清理失败不能阻断启动
            print("[credits] 过期扣费单退款失败 %s: %s" % (row["id"], exc))
    return count


def stats(user_id: Optional[int] = None) -> Dict[str, Any]:
    conn = connect()
    try:
        where = " WHERE user_id = ?" if user_id is not None else ""
        values = (int(user_id),) if user_id is not None else ()
        row = conn.execute(
            "SELECT COUNT(*) AS charges, "
            "COALESCE(SUM(CASE WHEN status='settled' THEN cost_usd ELSE 0 END),0) AS cost_usd, "
            "COALESCE(SUM(CASE WHEN status='settled' THEN price_usd ELSE 0 END),0) AS price_usd, "
            "COALESCE(SUM(CASE WHEN status='settled' THEN profit_usd ELSE 0 END),0) AS profit_usd, "
            "SUM(CASE WHEN pricing_fallback=1 THEN 1 ELSE 0 END) AS fallback_charges "
            "FROM credit_charges" + where,
            values,
        ).fetchone()
        return {key: (round(float(row[key]), 6) if key != "charges" and key != "fallback_charges" else int(row[key] or 0))
                for key in row.keys()}
    finally:
        conn.close()
