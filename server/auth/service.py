#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""邀请制登录业务逻辑：口令、会话、邀请码、首个管理员。

不依赖 FastAPI：HTTP 层（api.py / middleware.py）与 CLI 共用这里。
"""
from __future__ import annotations

import hashlib
import os
import re
import time
import secrets
import sqlite3
import time
from typing import Any, Dict, List, Optional, Tuple

from server.auth import passwords, ratelimit, store
from server.auth.errors import AuthError

COOKIE_NAME = "novai_session"
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
VALID_ROLES = ("admin", "team", "user")
# \w 在 Unicode 下包含中文，手机号/邮箱/中文昵称都能当用户名
USERNAME_RE = re.compile(r"^[\w.@+-]{3,32}$", re.UNICODE)
PASSWORD_MIN = 8
PASSWORD_MAX = 128
INVITE_CODE_ATTEMPTS = 20
INVITE_DEFAULT_DAYS = 7
RESET_CODE_TTL_SECONDS = 15 * 60


def now_seconds() -> int:
    return int(time.time())


def _truthy(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def auth_enabled() -> bool:
    """NOVAI_AUTH_DISABLED 优先（强制关闭），其次 NOVAI_AUTH_ENABLED；默认关闭。"""
    if _truthy(os.getenv("NOVAI_AUTH_DISABLED")):
        return False
    return _truthy(os.getenv("NOVAI_AUTH_ENABLED"))


# ---------------------------------------------------------------- 校验

def normalize_username(username: Any) -> str:
    return str(username or "").strip()


def validate_username(username: str) -> str:
    if not USERNAME_RE.match(username or ""):
        raise AuthError(
            "用户名需为 3-32 位字符（字母、数字、下划线、点、中划线或 @）",
            400,
            "invalid_username",
        )
    return username


def validate_password(password: Any) -> str:
    text = str(password or "")
    if len(text) < PASSWORD_MIN or len(text) > PASSWORD_MAX:
        raise AuthError(
            "密码长度需为 %d-%d 个字符" % (PASSWORD_MIN, PASSWORD_MAX),
            400,
            "invalid_password",
        )
    return text


def avatar_url_for(user_id: Any) -> str:
    try:
        from server import avatars
        return avatars.url_for(user_id)
    except Exception:
        return ""


def user_payload(user: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not user:
        return None
    return {
        "id": int(user["id"]),
        "username": user["username"],
        "role": user["role"],
        "avatar_url": avatar_url_for(user["id"]),
    }


# ---------------------------------------------------------------- 会话

def session_token_hash(token: str) -> str:
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


def _issue_session(user_id: int, ip: str = "", ua: str = "") -> str:
    token = secrets.token_urlsafe(32)
    store.create_session(
        session_token_hash(token),
        int(user_id),
        now_seconds() + SESSION_TTL_SECONDS,
        str(ip or "")[:64],
        str(ua or "")[:300],
    )
    return token


def session_user(token: str) -> Optional[Dict[str, Any]]:
    if not token:
        return None
    row = store.get_session(session_token_hash(token))
    if not row:
        return None
    if int(row["expires_at"]) <= now_seconds():
        store.delete_session(row["token_hash"])
        return None
    user = store.get_user_by_id(int(row["user_id"]))
    if not user or str(user.get("status")) != "active":
        return None
    return user_payload(user)


def logout(token: str) -> None:
    if token:
        store.delete_session(session_token_hash(token))


def change_password(user: Dict[str, Any], old_password: Any, new_password: Any, keep_token_hash: str = "") -> None:
    """自助改密码：校验旧密码 + 现有强度规则，保留当前会话、踢掉其它设备。"""
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    row = store.get_user_by_id(int(user["id"]))
    if not row:
        raise AuthError("用户不存在", 401, "unauthorized")
    if not passwords.verify_password(str(old_password or ""), row["password_hash"]):
        raise AuthError("旧密码不正确", 400, "bad_credentials")
    validate_password(new_password)
    store.set_user_password_hash(int(row["id"]), passwords.hash_password(str(new_password)))
    store.delete_sessions_for_user(int(row["id"]), keep_token_hash=keep_token_hash)


def change_username(user: Dict[str, Any], new_username: Any, password: Any) -> Dict[str, Any]:
    """自助改用户名：先验密码再校验格式/唯一，成功后返回新用户视图（会话不受影响）。"""
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    row = store.get_user_by_id(int(user["id"]))
    if not row:
        raise AuthError("用户不存在", 401, "unauthorized")
    if not passwords.verify_password(str(password or ""), row["password_hash"]):
        raise AuthError("密码不正确", 400, "bad_credentials")
    name = validate_username(normalize_username(new_username))
    if name == row["username"]:
        return user_payload(row) or {}
    store.set_username(int(row["id"]), name)
    return user_payload(store.get_user_by_id(int(row["id"]))) or {}


# ---------------------------------------------------------------- 注册 / 登录

def register(username: Any, password: Any, invite_code: Any, ip: str = "", ua: str = "") -> Tuple[Dict[str, Any], str]:
    if not auth_enabled():
        raise AuthError("登录体系未启用", 403, "auth_disabled")
    name = validate_username(normalize_username(username))
    pwd = validate_password(password)
    code = normalize_invite_code(invite_code)
    if not code:
        raise AuthError("必须填写邀请码", 400, "invite_required")
    # 限流必须在 scrypt 之前：否则枚举者用错误码也能把 CPU 打满
    ratelimit.check(ip)
    user = store.register_with_invite(name, passwords.hash_password(pwd), code, now_seconds())
    return user, _issue_session(user["id"], ip, ua)


def login(username: Any, password: Any, ip: str = "", ua: str = "") -> Tuple[Dict[str, Any], str]:
    if not auth_enabled():
        raise AuthError("登录体系未启用", 403, "auth_disabled")
    name = normalize_username(username)
    user = store.get_user_by_username(name) if name else None
    # 用户不存在与密码错误给同一句提示，避免暴露账号是否存在
    if not user or not passwords.verify_password(password, user["password_hash"]):
        raise AuthError("用户名或密码不正确", 401, "bad_credentials")
    if str(user.get("status")) != "active":
        raise AuthError("账号已被停用", 403, "user_disabled")
    store.delete_expired_sessions(now_seconds())
    return user, _issue_session(user["id"], ip, ua)


# ---------------------------------------------------------------- 用户 / 邀请码

def create_user(username: Any, password: Any, role: str = "user") -> Dict[str, Any]:
    name = validate_username(normalize_username(username))
    role = str(role or "user").strip().lower()
    if role not in VALID_ROLES:
        raise AuthError("角色必须是 %s 之一" % "/".join(VALID_ROLES), 400, "invalid_role")
    return store.insert_user(name, passwords.hash_password(validate_password(password)), role, now_seconds())


def _new_invite_code() -> str:
    """6 位数字、首位非 0：100 万种组合，后台可念可抄。
    旧格式 NOVAI-XXXX-XXXX-XXXX 只保留“能读出来”的兼容，不再新生成。"""
    return str(secrets.randbelow(900000) + 100000)


def normalize_invite_code(code: Any) -> str:
    """新码是纯数字，历史码带 NOVAI- 前缀与中划线：统一去空白转大写后查库。"""
    return str(code or "").strip().upper()


def create_invite(role: str = "user", uses: int = 1, days: Optional[int] = INVITE_DEFAULT_DAYS, created_by: str = "") -> str:
    """生成邀请码；默认一次一码、7 天有效；days=None 永不过期，days<=0 生成即过期。"""
    role = str(role or "user").strip().lower()
    if role not in VALID_ROLES:
        raise AuthError("角色必须是 %s 之一" % "/".join(VALID_ROLES), 400, "invalid_role")
    try:
        max_uses = int(uses)
    except (TypeError, ValueError):
        raise AuthError("邀请码可用次数需为正整数", 400, "invalid_uses")
    if max_uses < 1 or max_uses > 1000:
        raise AuthError("邀请码可用次数需在 1-1000 之间", 400, "invalid_uses")

    now = now_seconds()
    if days is None:
        expires_at = None
    else:
        try:
            days_int = int(days)
        except (TypeError, ValueError):
            raise AuthError("有效天数需为整数", 400, "invalid_days")
        if days_int > 3650:
            raise AuthError("有效天数不能超过 3650 天", 400, "invalid_days")
        expires_at = now if days_int <= 0 else now + days_int * 86400

    # 6 位数字只有 100 万种，写库前必须查重：冲突就换一个再试
    for _ in range(INVITE_CODE_ATTEMPTS):
        code = _new_invite_code()
        try:
            store.insert_invite(code, role, max_uses, expires_at, created_by)
            return code
        except sqlite3.IntegrityError:
            continue
    raise AuthError("邀请码生成冲突，请重试", 500, "invite_code_collision")


def bootstrap_admin() -> Optional[Dict[str, Any]]:
    """启动时引导首个管理员：仅在 auth 开启、users 为空、环境变量齐全时执行。"""
    if not auth_enabled():
        return None
    username = os.getenv("NOVAI_ADMIN_USER", "").strip()
    password = os.getenv("NOVAI_ADMIN_PASSWORD", "")
    if not username or not password:
        return None
    if store.count_users() > 0:
        return None
    try:
        user = create_user(username, password, "admin")
    except AuthError as exc:
        print("[auth] 首个管理员创建失败：%s" % exc.message)
        return None
    print("[auth] 已创建首个管理员：%s（请尽快修改默认密码）" % user["username"])
    return user


# ---------------------------------------------------------------- 管理面

def ensure_auth_enabled() -> None:
    if not auth_enabled():
        raise AuthError("登录体系未启用", 403, "auth_disabled")


def require_admin(user: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    if str(user.get("role")) != "admin":
        raise AuthError("需要管理员权限", 403, "forbidden")
    return user


def invite_payload(row: Optional[Dict[str, Any]], now: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """后台展示用的邀请码视图：status 由停用 / 过期 / 用完实时算出来。"""
    if not row:
        return None
    current = now_seconds() if now is None else int(now)
    expires_at = row.get("expires_at")
    used = int(row.get("used") or 0)
    max_uses = int(row.get("max_uses") or 0)
    disabled = bool(int(row.get("disabled") or 0))
    if disabled:
        status = "disabled"
    elif expires_at is not None and int(expires_at) <= current:
        status = "expired"
    elif used >= max_uses:
        status = "exhausted"
    else:
        status = "active"
    return {
        "code": row.get("code", ""),
        "role": row.get("role", "user"),
        "max_uses": max_uses,
        "used": used,
        "expires_at": expires_at,
        "disabled": disabled,
        "status": status,
        "created_by": row.get("created_by", ""),
    }


def list_invites_admin(limit: int = 100) -> List[Dict[str, Any]]:
    return [invite_payload(row) for row in store.list_invites(limit)]


def create_invite_for(actor: Dict[str, Any], uses: Any = 1, days: Any = INVITE_DEFAULT_DAYS, role: str = "user") -> Dict[str, Any]:
    require_admin(actor)
    code = create_invite(role=role, uses=uses, days=days, created_by=str(actor.get("username") or ""))
    return invite_payload(store.get_invite(code))


def disable_invite(code: Any) -> Dict[str, Any]:
    ensure_auth_enabled()
    normalized = normalize_invite_code(code)
    if not normalized or not store.get_invite(normalized):
        raise AuthError("邀请码不存在", 404, "invite_not_found")
    store.set_invite_disabled(normalized)
    return invite_payload(store.get_invite(normalized))


def list_users_admin(actor: Dict[str, Any], limit: int = 200) -> List[Dict[str, Any]]:
    require_admin(actor)
    return [
        {
            "id": int(row["id"]),
            "username": row["username"],
            "role": row["role"],
            "status": row["status"],
            "created_at": int(row["created_at"]),
            "avatar_url": avatar_url_for(row["id"]),
        }
        for row in store.list_users(limit)
    ]


def disable_user(actor: Dict[str, Any], user_id: Any) -> Dict[str, Any]:
    require_admin(actor)
    try:
        target_id = int(user_id)
    except (TypeError, ValueError):
        raise AuthError("用户 ID 不合法", 400, "invalid_user_id")
    if int(actor.get("id") or 0) == target_id:
        raise AuthError("不能停用自己的账号", 400, "cannot_disable_self")
    user = store.get_user_by_id(target_id)
    if not user:
        raise AuthError("用户不存在", 404, "user_not_found")
    store.set_user_status(target_id, "disabled")
    # 停用后立刻踢掉现有会话与未用的重置码，下一次请求就是 401
    store.delete_sessions_for_user(target_id)
    store.delete_reset_code(target_id)
    return _public_user(user, status="disabled")


def _public_user(user: Dict[str, Any], status: Optional[str] = None) -> Dict[str, Any]:
    return {
        "id": int(user["id"]),
        "username": user["username"],
        "role": user["role"],
        "status": status or str(user.get("status") or "active"),
        "created_at": int(user["created_at"]),
        "avatar_url": avatar_url_for(user["id"]),
    }


def _target_user(actor: Dict[str, Any], user_id: Any) -> Dict[str, Any]:
    try:
        target_id = int(user_id)
    except (TypeError, ValueError):
        raise AuthError("用户 ID 不合法", 400, "invalid_user_id")
    user = store.get_user_by_id(target_id)
    if not user:
        raise AuthError("用户不存在", 404, "user_not_found")
    return user


def enable_user(actor: Dict[str, Any], user_id: Any) -> Dict[str, Any]:
    require_admin(actor)
    user = _target_user(actor, user_id)
    store.set_user_status(int(user["id"]), "active")
    return _public_user(user, status="active")


def change_user_role(actor: Dict[str, Any], user_id: Any, role: Any) -> Dict[str, Any]:
    require_admin(actor)
    target = _target_user(actor, user_id)
    value = str(role or "").strip().lower()
    if value not in VALID_ROLES:
        raise AuthError("角色必须是 %s 之一" % "/".join(VALID_ROLES), 400, "invalid_role")
    if int(actor.get("id") or 0) == int(target["id"]) and value != "admin":
        raise AuthError("不能降低自己的管理员权限", 400, "cannot_change_own_role")
    store.set_user_role(int(target["id"]), value)
    updated = store.get_user_by_id(int(target["id"])) or target
    return _public_user(updated)


def _temp_password(length: int = 12) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(max(8, int(length))))


def reset_user_password(actor: Dict[str, Any], user_id: Any) -> tuple:
    """生成一次性临时密码：只返回一次明文，库里只存 scrypt 哈希，并踢掉旧会话。"""
    require_admin(actor)
    user = _target_user(actor, user_id)
    temp = _temp_password()
    store.set_user_password_hash(int(user["id"]), passwords.hash_password(temp))
    store.delete_sessions_for_user(int(user["id"]))
    store.delete_reset_code(int(user["id"]))
    return _public_user(user), temp


def _new_reset_code() -> str:
    return str(secrets.randbelow(900000) + 100000)


def create_reset_code(actor: Dict[str, Any], user_id: Any) -> Tuple[Dict[str, Any], str, int]:
    """管理员给某个用户生成一次性重置码：只返回一次明文，库里只存 scrypt 哈希。

    同一用户再次生成会直接覆盖旧码（旧码立刻失效），15 分钟后过期。
    """
    require_admin(actor)
    user = _target_user(actor, user_id)
    code = _new_reset_code()
    expires_at = now_seconds() + RESET_CODE_TTL_SECONDS
    store.set_reset_code(int(user["id"]), passwords.hash_password(code), expires_at, now_seconds())
    return _public_user(user), code, expires_at


def reset_password_with_code(username: Any, code: Any, new_password: Any, ip: str = "") -> Dict[str, Any]:
    """公开凭重置码改密码：用完即作废、踢掉该用户全部会话；失败不暴露账号是否存在。"""
    ensure_auth_enabled()
    # 限流在 scrypt 之前：否则枚举者能拿错误码把 CPU 打满
    ratelimit.check_reset_code(ip)
    validate_password(new_password)
    name = normalize_username(username)
    user = store.get_user_by_username(name) if name else None
    if not user:
        raise AuthError("重置码无效或已使用，请向管理员重新索取", 400, "invalid_reset_code")
    if str(user.get("status")) != "active":
        raise AuthError("账号已被停用，请联系管理员", 403, "user_disabled")
    record = store.get_reset_code(int(user["id"]))
    if not record or not passwords.verify_password(str(code or ""), record["code_hash"]):
        raise AuthError("重置码无效或已使用，请向管理员重新索取", 400, "invalid_reset_code")
    if int(record["expires_at"]) <= now_seconds():
        raise AuthError("重置码已过期，请向管理员重新索取", 400, "reset_code_expired")
    if not store.consume_reset_code(int(user["id"]), record["code_hash"]):
        raise AuthError("重置码无效或已使用，请向管理员重新索取", 400, "invalid_reset_code")
    store.set_user_password_hash(int(user["id"]), passwords.hash_password(str(new_password)))
    store.delete_sessions_for_user(int(user["id"]))
    return _public_user(user)


def admin_stats(now: Optional[int] = None) -> Dict[str, int]:
    current = now_seconds() if now is None else int(now)
    local = time.localtime(current)
    midnight = int(time.mktime((local.tm_year, local.tm_mon, local.tm_mday, 0, 0, 0, 0, 0, -1)))
    return {
        "users": store.count_users(),
        "active_invites": store.count_active_invites(current),
        "new_today": store.count_users_created_since(midnight),
    }
