#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""邀请制登录业务逻辑：口令、会话、邀请码、首个管理员。

不依赖 FastAPI：HTTP 层（api.py / middleware.py）与 CLI 共用这里。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
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


AUTH_MODES = ("off", "optional", "required")

# 登录 / 注册成功后的「认领无归属数据」钩子：画布与素材在 main.py，auth 模块只负责在正确时机调用。
_CLAIM_HOOK: Optional[Any] = None
# 注销时清理该账号名下的素材数据（库/条目/产品/提示词库 + users/{uid}）与清单统计。
_ASSET_PURGE_HOOK: Optional[Any] = None
_ASSET_IMPACT_HOOK: Optional[Any] = None


def set_claim_hook(hook: Optional[Any]) -> None:
    """main.py 启动时注入；CLI / 单测没有画布存储时保持 None（不产生副作用）。"""
    global _CLAIM_HOOK
    _CLAIM_HOOK = hook


def set_asset_hooks(purge: Optional[Any] = None, impact: Optional[Any] = None) -> None:
    """main.py 启动时注入：注销时清理素材数据、注销清单统计素材归属。"""
    global _ASSET_PURGE_HOOK, _ASSET_IMPACT_HOOK
    if purge is not None:
        _ASSET_PURGE_HOOK = purge
    if impact is not None:
        _ASSET_IMPACT_HOOK = impact


def _run_asset_purge(user_id: int) -> Dict[str, Any]:
    hook = _ASSET_PURGE_HOOK
    if hook is None:
        return {}
    try:
        result = hook(int(user_id))
        return dict(result or {})
    except Exception as exc:
        print("[auth] 注销清理素材数据失败（账号已注销，不回滚）：%s" % exc)
        return {}


def _run_asset_impact(user_id: int) -> Dict[str, Any]:
    hook = _ASSET_IMPACT_HOOK
    if hook is None:
        return {}
    try:
        return dict(hook(int(user_id)) or {})
    except Exception as exc:
        print("[auth] 注销清单统计素材失败：%s" % exc)
        return {}


def _run_claim_hook(user: Optional[Dict[str, Any]]) -> None:
    hook = _CLAIM_HOOK
    if hook is None or not user:
        return
    try:
        hook(user)
    except Exception as exc:
        print("[auth] 登录后认领无归属数据失败（不影响登录）：%s" % exc)


def auth_mode() -> str:
    """登录模式（2026-11-07 起默认 optional）：
    - off：没有账号体系（NOVAI_AUTH_DISABLED=1 或 NOVAI_AUTH_MODE=off）；
    - optional：可选登录——不登录照常本机使用，不拦截、不按账号隔离；登录只是带上身份
      （共享 / 协作 / 团队资产等以后按账号开放的功能用）；
    - required：必须登录（NOVAI_AUTH_ENABLED=1 或 NOVAI_AUTH_MODE=required），
      全站拦截 + 画布 / 素材按账号隔离，即原来的「邀请制登录」。
    NOVAI_AUTH_DISABLED 优先级最高，其次 NOVAI_AUTH_ENABLED，再其次 NOVAI_AUTH_MODE。"""
    if _truthy(os.getenv("NOVAI_AUTH_DISABLED")):
        return "off"
    if _truthy(os.getenv("NOVAI_AUTH_ENABLED")):
        return "required"
    mode = str(os.getenv("NOVAI_AUTH_MODE") or "").strip().lower()
    return mode if mode in AUTH_MODES else "optional"


def auth_enabled() -> bool:
    """「必须登录」模式：全站拦截、按账号隔离都只认这个（可选登录下保持本机单用户行为）。"""
    return auth_mode() == "required"


def accounts_enabled() -> bool:
    """账号体系是否可用（注册 / 登录 / 我的账户 / 管理面）：必须登录、可选登录两种模式都算。"""
    return auth_mode() != "off"


# 注册是否需要邀请码：管理员在「我的」页切换，存在 users.db 的 auth_settings 里；默认不需要（开放注册）
INVITE_REQUIRED_KEY = "invite_required"
# 只有管理员显式打开时才写 "1"；老库没有这条设置，因此升级后仍然是开放注册
INVITE_REQUIRED_DEFAULT = "0"


def invite_required() -> bool:
    try:
        return _truthy(store.get_setting(INVITE_REQUIRED_KEY, INVITE_REQUIRED_DEFAULT))
    except Exception as exc:
        print("[auth] 读取注册设置失败，按不需要邀请码处理：%s" % exc)
        return False


def set_invite_required(required: bool) -> bool:
    store.set_setting(INVITE_REQUIRED_KEY, "1" if required else "0")
    return invite_required()


def public_config() -> Dict[str, Any]:
    """登录页需要知道的公开信息：模式、注册要不要邀请码、是不是还一个账号都没有（第一个注册的是管理员）。"""
    mode = auth_mode()
    has_users = True
    if mode != "off":
        try:
            has_users = store.count_users() > 0
        except Exception:
            has_users = True
    return {
        "auth_mode": mode,
        "accounts_enabled": mode != "off",
        "invite_required": invite_required() if mode != "off" else False,
        "has_users": has_users,
    }


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
    if not accounts_enabled():
        raise AuthError("登录体系未启用", 403, "auth_disabled")
    name = validate_username(normalize_username(username))
    pwd = validate_password(password)
    code = normalize_invite_code(invite_code)
    first = store.count_users() == 0
    if not code and invite_required() and not first:
        raise AuthError("必须填写邀请码", 400, "invite_required")
    # 限流必须在 scrypt 之前：否则枚举者用错误码也能把 CPU 打满
    ratelimit.check(ip)
    if code and not first:
        # 填了邀请码就按邀请码走（开放注册时也能用邀请码拿到 team / admin 角色）
        user = store.register_with_invite(name, passwords.hash_password(pwd), code, now_seconds())
    else:
        # 开放注册，或者这台 NOVAI 还没有任何账号：第一个账号是管理员
        user = store.register_open(name, passwords.hash_password(pwd), now_seconds())
    token = _issue_session(user["id"], ip, ua)
    _run_claim_hook(user)
    return user, token


# ---------------------------------------------------------------- 自助注销（2026-11）

def _scan_canvases(canvas_dir: str, user_id: int) -> Tuple[List[Tuple[str, str]], List[Tuple[str, str]]]:
    """一次扫描画布目录：([(id, 路径)] 属于本账号的, [(id, 路径)] 没有 owner_id 的历史画布)。

    只认 owner_id；「没有归属信息」的老画布单独返回，注销时按「整机最后一个账号」规则处理。
    """
    root = str(canvas_dir or "")
    if not root or not os.path.isdir(root):
        return [], []
    try:
        names = os.listdir(root)
    except OSError:
        return [], []
    owned: List[Tuple[str, str]] = []
    unowned: List[Tuple[str, str]] = []
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(root, name)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
        except Exception:
            continue
        if not isinstance(doc, dict):
            continue
        canvas_id = str(doc.get("id") or name[:-5])
        value = doc.get("owner_id")
        if value is None or value == "":
            unowned.append((canvas_id, path))
            continue
        try:
            owner = int(value)
        except (TypeError, ValueError):
            unowned.append((canvas_id, path))
            continue
        if owner == int(user_id):
            owned.append((canvas_id, path))
    return owned, unowned


def _lan_impact(user_id: int) -> Dict[str, int]:
    """这个账号在本机的局域网数据（身份 / 好友 / 好友申请 / 聊天）；只读。"""
    try:
        from server.routes import lan_account as _lan
        raw = _lan.owner_impact("u%d" % int(user_id))
    except Exception:
        return {"lan_account": 0, "lan_friends": 0, "lan_requests": 0, "lan_chat_messages": 0}
    return {
        "lan_account": int(raw.get("account") or 0),
        "lan_friends": int(raw.get("friends") or 0),
        "lan_requests": int(raw.get("requests") or 0),
        "lan_chat_messages": int(raw.get("chat_messages") or 0),
    }


def _purge_lan(user_id: int) -> Dict[str, int]:
    """注销成功后清掉这个账号的局域网数据（身份 / 好友 / 聊天 / 好友申请 / 待补发）。

    两套存储不在一个事务里：这里失败只记日志，不回滚已经完成的账号删除。
    返回 LAN 侧计数（accounts / friends / chats / requests），供接口结果与审计日志使用。
    """
    try:
        from server.routes import lan_account as _lan
        raw = _lan.purge_account(int(user_id))
        return {str(key): int(value or 0) for key, value in dict(raw or {}).items()}
    except Exception as exc:
        print("[auth] 清理局域网数据失败（账号已注销，不回滚）：%s" % exc)
        return {}


def _count_user_assets(user_id: int) -> int:
    """名下素材文件的个数（只统计，不删除：本机素材文件属于整机数据）。"""
    try:
        from server.auth import tenant
        root = tenant.user_asset_root(user_id)
    except Exception:
        return 0
    if not root or not os.path.isdir(root):
        return 0
    total = 0
    for _dirpath, _dirnames, filenames in os.walk(root):
        for filename in filenames:
            if not filename.startswith("."):
                total += 1
    return total


def _build_impact(row: Dict[str, Any], owned: List[Tuple[str, str]], unowned: List[Tuple[str, str]]) -> Dict[str, Any]:
    uid = int(row["id"])
    counts = store.account_impact(uid, str(row["username"]), [cid for cid, _path in owned])
    counts["asset_files"] = _count_user_assets(uid)
    counts["unowned_canvases"] = len(unowned)
    counts.update(_lan_impact(uid))
    counts.update(_run_asset_impact(uid))
    total_users, active_admins = store.account_counts()
    # 整机最后一个账号：没有任何别的账号，注销后回到「第一个注册的是管理员」首启状态，
    # 这时没有 owner_id 的历史画布没有别人会再用，一并删除；否则保留并单独提示。
    last_account = total_users <= 1
    blocked = ""
    if str(row.get("role")) == "admin" and active_admins <= 1 and not last_account:
        # 还有别的账号却没有别的管理员：删完就没人能管理账号了，先拒绝
        blocked = "last_admin"
    return {
        "username": str(row["username"]),
        "role": str(row.get("role") or "user"),
        "counts": counts,
        "last_account": last_account,
        "delete_unowned": bool(last_account),
        "blocked": blocked,
    }


def account_delete_impact(user: Optional[Dict[str, Any]], canvas_dir: str = "") -> Dict[str, Any]:
    """注销前给前端确认弹窗用的清单：会被删什么、什么保留、能不能删。"""
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    row = store.get_user_by_id(int(user["id"]))
    if not row:
        raise AuthError("账号不存在或已被删除", 404, "user_not_found")
    owned, unowned = _scan_canvases(canvas_dir, int(row["id"]))
    return _build_impact(row, owned, unowned)


def delete_account(user: Optional[Dict[str, Any]], password: Any, confirm_username: Any, canvas_dir: str = "") -> Dict[str, Any]:
    """自助注销：密码 + 账号名双重确认；名下数据一起删，一个事务里做完，失败全部回滚。"""
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    row = store.get_user_by_id(int(user["id"]))
    if not row:
        raise AuthError("账号不存在或已被删除", 404, "user_not_found")
    uid = int(row["id"])
    username = str(row["username"])
    if not passwords.verify_password(str(password or ""), row["password_hash"]):
        raise AuthError("当前密码不正确", 400, "bad_password")
    if str(confirm_username or "").strip() != username:
        raise AuthError("账号名不匹配，请输入当前账号名确认", 400, "confirm_mismatch")
    owned, unowned = _scan_canvases(canvas_dir, uid)
    impact = _build_impact(row, owned, unowned)
    if impact["blocked"]:
        raise AuthError("这是本机最后一个管理员，请先把其他账号设为管理员再注销", 400, "last_admin")

    # 整机最后一个账号：没有 owner_id 的历史画布也一起删；否则不动它们
    extra = unowned if impact["last_account"] else []
    files = owned + extra
    canvas_ids = [cid for cid, _path in files]
    trash = ""
    moved: List[Tuple[str, str]] = []
    try:
        if files:
            trash = tempfile.mkdtemp(prefix=".account-delete-", dir=canvas_dir)
            for index, (_cid, path) in enumerate(files):
                target = os.path.join(trash, "%d-%s" % (index, os.path.basename(path)))
                shutil.move(path, target)
                moved.append((target, path))
        counts = store.purge_account(uid, username, canvas_ids)
    except AuthError:
        _restore_canvases(moved, trash)
        raise
    except Exception as exc:
        _restore_canvases(moved, trash)
        print("[auth] 注销账号失败，数据已回滚：%s" % exc)
        raise AuthError("注销失败，数据未改动，请重试", 500, "delete_failed")
    if trash:
        shutil.rmtree(trash, ignore_errors=True)
    # 素材数据不在 users.db 事务里：账号已注销后尽力清理，失败只记日志。
    counts.update(_run_asset_purge(uid))

    try:
        from server import avatars
        avatars.delete(uid)
    except Exception:
        pass
    try:
        from server import asset_acl
        asset_acl.clear_cache()
    except Exception:
        pass
    lan_removed = _purge_lan(uid)
    for key in ("accounts", "friends", "chats", "requests"):
        counts["lan_" + key + "_removed"] = int(lan_removed.get(key) or 0)
    counts["asset_files"] = impact["counts"].get("asset_files", 0)
    counts["unowned_canvases"] = len(extra)
    return {
        "counts": counts,
        "last_account": bool(impact["last_account"]),
        "delete_unowned": bool(impact["last_account"]),
        "notice": "last_account" if impact["last_account"] else "",
    }


def _restore_canvases(moved: List[Tuple[str, str]], trash: str) -> None:
    """事务失败时把挪走的画布文件放回原位（尽力而为，失败只打印）。"""
    for target, path in moved:
        try:
            shutil.move(target, path)
        except Exception as exc:
            print("[auth] 画布恢复失败 %s：%s" % (path, exc))
    if trash:
        shutil.rmtree(trash, ignore_errors=True)


def login(username: Any, password: Any, ip: str = "", ua: str = "") -> Tuple[Dict[str, Any], str]:
    if not accounts_enabled():
        raise AuthError("登录体系未启用", 403, "auth_disabled")
    name = normalize_username(username)
    user = store.get_user_by_username(name) if name else None
    # 用户不存在与密码错误给同一句提示，避免暴露账号是否存在
    if not user or not passwords.verify_password(password, user["password_hash"]):
        raise AuthError("用户名或密码不正确", 401, "bad_credentials")
    if str(user.get("status")) != "active":
        raise AuthError("账号已被停用", 403, "user_disabled")
    store.delete_expired_sessions(now_seconds())
    token = _issue_session(user["id"], ip, ua)
    _run_claim_hook(user)
    return user, token


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
    """启动时引导首个管理员：仅在账号体系可用、users 为空、环境变量齐全时执行。"""
    if not accounts_enabled():
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
    """账号相关接口（我的账户 / 改密码 / 管理面）：可选登录、必须登录两种模式都可用。"""
    if not accounts_enabled():
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
