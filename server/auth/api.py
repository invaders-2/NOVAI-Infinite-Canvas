#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""邀请制登录 HTTP 接口（/api/auth/*）、管理面（/api/admin/*）、登录页与管理员后台页。"""
from __future__ import annotations

import json
import os
from email.utils import formatdate
from typing import Any, Dict, Optional

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field

from server import avatars
from server.auth import service, store
from server.auth.errors import AuthError

router = APIRouter()
_STATIC_DIR = ""
_CANVAS_DIR = ""


def set_static_dir(path: str) -> None:
    global _STATIC_DIR
    _STATIC_DIR = str(path or "")


def set_canvas_dir(path: str) -> None:
    global _CANVAS_DIR
    _CANVAS_DIR = str(path or "")


def _static_page(filename: str) -> str:
    static_dir = _STATIC_DIR or os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "static",
    )
    return os.path.join(static_dir, filename)


def _login_page_path() -> str:
    return _static_page("login.html")


def _admin_page_path() -> str:
    return _static_page("admin.html")


class RegisterPayload(BaseModel):
    username: str = ""
    password: str = ""
    invite_code: str = ""


class LoginPayload(BaseModel):
    username: str = ""
    password: str = ""


class PasswordPayload(BaseModel):
    old_password: str = Field(default="", max_length=256)
    new_password: str = Field(default="", max_length=256)


class UsernamePayload(BaseModel):
    new_username: str = Field(default="", max_length=64)
    password: str = Field(default="", max_length=256)


class ResetPasswordPayload(BaseModel):
    username: str = Field(default="", max_length=64)
    code: str = Field(default="", max_length=32)
    new_password: str = Field(default="", max_length=256)


class InvitePayload(BaseModel):
    uses: int = Field(default=1, ge=1, le=1000)
    days: Optional[int] = Field(default=service.INVITE_DEFAULT_DAYS, ge=0, le=3650)
    role: str = Field(default="user", max_length=16)


class RolePayload(BaseModel):
    role: str = Field(default="", max_length=16)


def _client_ip(request: Request) -> str:
    client_host = request.client.host if request.client else ""
    if str(os.getenv("NOVAI_TRUST_PROXY", "")).strip().lower() in ("1", "true", "yes", "on"):
        forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if forwarded:
            return forwarded[:64]
    return str(client_host or "")[:64]


def _client_meta(request: Request) -> Dict[str, str]:
    return {
        "ip": _client_ip(request),
        "ua": request.headers.get("user-agent") or "",
    }


def _is_secure_request(request: Request) -> bool:
    if request.url.scheme == "https":
        return True
    proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return proto == "https"


def _set_session_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        service.COOKIE_NAME,
        token,
        max_age=service.SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=_is_secure_request(request),
        path="/",
    )


# ---------------------------------------------------------------- 登录 / 注册

@router.post("/api/auth/register")
def register(payload: RegisterPayload, request: Request, response: Response) -> Dict[str, Any]:
    meta = _client_meta(request)
    user, token = service.register(payload.username, payload.password, payload.invite_code, meta["ip"], meta["ua"])
    _set_session_cookie(request, response, token)
    return {"user": service.user_payload(user)}


@router.post("/api/auth/login")
def login(payload: LoginPayload, request: Request, response: Response) -> Dict[str, Any]:
    meta = _client_meta(request)
    user, token = service.login(payload.username, payload.password, meta["ip"], meta["ua"])
    _set_session_cookie(request, response, token)
    return {"user": service.user_payload(user)}


@router.post("/api/auth/logout")
def logout(request: Request, response: Response) -> Dict[str, Any]:
    service.logout(request.cookies.get(service.COOKIE_NAME, ""))
    response.delete_cookie(service.COOKIE_NAME, path="/")
    return {"ok": True}


async def _read_avatar_file(file: UploadFile) -> bytes:
    content = await file.read(avatars.MAX_BYTES + 1)
    if len(content) > avatars.MAX_BYTES:
        raise AuthError("头像不能超过 2MB", 413, "avatar_too_large")
    return content


@router.post("/api/auth/avatar")
async def upload_my_avatar(request: Request, file: UploadFile = File(...)) -> Dict[str, Any]:
    """登录用户上传自己的头像（multipart 字段名 file，png/jpg/webp，≤2MB）。"""
    service.ensure_auth_enabled()
    user = service.session_user(request.cookies.get(service.COOKIE_NAME, ""))
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    content = await _read_avatar_file(file)
    url = avatars.save_bytes(user["id"], content, file.content_type or "")
    _audit(user, "user_avatar_update", str(user.get("username") or ""), "ok", "self")
    return {"avatar_url": url}


@router.delete("/api/auth/avatar")
def delete_my_avatar(request: Request) -> Dict[str, Any]:
    service.ensure_auth_enabled()
    user = service.session_user(request.cookies.get(service.COOKIE_NAME, ""))
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    avatars.delete(user["id"])
    _audit(user, "user_avatar_delete", str(user.get("username") or ""), "ok")
    return {"avatar_url": ""}


@router.get("/api/auth/avatar/{user_id}")
def get_avatar(user_id: int, request: Request):
    """登录用户可读任意用户头像；带 ETag/Last-Modified，URL 带 ?v= 便于缓存。"""
    if not service.auth_enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    user = service.session_user(request.cookies.get(service.COOKIE_NAME, ""))
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    path = avatars.file_for(user_id)
    if not path:
        raise AuthError("头像不存在", 404, "avatar_not_found")
    etag = avatars.etag_for(path)
    headers = {
        "ETag": etag,
        "Last-Modified": formatdate(os.path.getmtime(path), usegmt=True),
        "Cache-Control": "private, max-age=300",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return FileResponse(path, media_type=avatars.mime_for(path), headers=headers)


@router.post("/api/auth/password")
def change_password(payload: PasswordPayload, request: Request) -> Dict[str, Any]:
    """自助改密码：保留当前会话，踢掉该用户其它设备，并写审计。"""
    service.ensure_auth_enabled()
    token = request.cookies.get(service.COOKIE_NAME, "")
    user = service.session_user(token)
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    try:
        service.change_password(
            user,
            payload.old_password,
            payload.new_password,
            keep_token_hash=service.session_token_hash(token) if token else "",
        )
    except AuthError as exc:
        _audit(user, "user_change_password", str(user.get("username") or ""), "error", exc.code)
        raise
    _audit(user, "user_change_password", str(user.get("username") or ""), "ok")
    return {"ok": True, "username": user.get("username")}


@router.post("/api/auth/username")
def change_username(payload: UsernamePayload, request: Request) -> Dict[str, Any]:
    """自助改用户名：需要当前密码；成功后当前会话继续有效，用户名立刻生效。"""
    service.ensure_auth_enabled()
    user = service.session_user(request.cookies.get(service.COOKIE_NAME, ""))
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    try:
        updated = service.change_username(user, payload.new_username, payload.password)
    except AuthError as exc:
        _audit(user, "user_change_username", payload.new_username.strip(), "error", exc.code)
        raise
    _audit(user, "user_change_username", updated.get("username") or "", "ok", "from=%s" % (user.get("username") or ""))
    return {"ok": True, "user": updated}


@router.post("/api/auth/reset-password")
def reset_password(payload: ResetPasswordPayload, request: Request) -> Dict[str, Any]:
    """公开接口：用户名 + 管理员发的 6 位重置码 + 新密码。成功即作废码并踢掉该用户全部会话。"""
    target = payload.username.strip()
    try:
        user = service.reset_password_with_code(
            payload.username,
            payload.code,
            payload.new_password,
            _client_ip(request),
        )
    except AuthError as exc:
        # 429 不写审计：被限流的请求可以无限重试，写审计等于把库撑大
        if exc.code != "rate_limited":
            _audit(None, "user_reset_code_use", target, "error", exc.code)
        raise
    _audit({"id": user["id"], "username": user["username"]}, "user_reset_code_use", user["username"], "ok")
    return {"ok": True, "user": service.user_payload(user)}


@router.get("/api/auth/account")
def account(request: Request) -> Dict[str, Any]:
    """我的账户页数据：注册时间 + 画布数（按 owner_id 统计）。"""
    service.ensure_auth_enabled()
    user = service.session_user(request.cookies.get(service.COOKIE_NAME, ""))
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    row = store.get_user_by_id(int(user["id"])) or {}
    payload: Dict[str, Any] = dict(service.user_payload(user) or {})
    payload["created_at"] = int(row.get("created_at") or 0)
    payload["status"] = str(row.get("status") or "active")
    counts = _canvas_counts()
    return {"user": payload, "canvas_count": int(counts.get(int(user["id"]), 0))}


@router.get("/api/auth/me")
def me(request: Request) -> Dict[str, Any]:
    if not service.auth_enabled():
        # auth 关闭时前端也能安全探测：明确告诉它没有登录体系
        return {"auth_enabled": False, "id": None, "username": None, "role": None}
    user = service.session_user(request.cookies.get(service.COOKIE_NAME, ""))
    if not user:
        raise AuthError("未登录或会话已过期", 401, "unauthorized")
    payload: Dict[str, Any] = {"auth_enabled": True}
    payload.update(user)
    return payload


# ---------------------------------------------------------------- 管理面

def _admin_user(request: Request) -> Dict[str, Any]:
    service.ensure_auth_enabled()
    user = service.session_user(request.cookies.get(service.COOKIE_NAME, ""))
    return service.require_admin(user)


def _audit(actor: Optional[Dict[str, Any]], action: str, target: str, result: str = "ok", detail: str = "") -> None:
    store.audit(action, actor, target, result, detail)


def _canvas_counts() -> Dict[int, int]:
    """每个用户拥有的画布数：只数 owner_id 明确的文件，旧画布（无字段）不计入任何人。"""
    counts: Dict[int, int] = {}
    canvas_dir = _CANVAS_DIR
    if not canvas_dir or not os.path.isdir(canvas_dir):
        return counts
    try:
        names = os.listdir(canvas_dir)
    except Exception:
        return counts
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(canvas_dir, name), "r", encoding="utf-8") as fh:
                data = json.load(fh)
            owner = data.get("owner_id")
            if owner is None:
                continue
            owner_id = int(owner)
        except Exception:
            continue
        counts[owner_id] = counts.get(owner_id, 0) + 1
    return counts


@router.post("/api/admin/invites")
def admin_create_invite(request: Request, payload: Optional[InvitePayload] = None) -> Dict[str, Any]:
    actor = _admin_user(request)
    body = payload or InvitePayload()
    try:
        invite = service.create_invite_for(actor, uses=body.uses, days=body.days, role=body.role)
    except AuthError as exc:
        _audit(actor, "invite_create", "", "error", exc.code)
        raise
    _audit(
        actor,
        "invite_create",
        invite["code"],
        "ok",
        "role=%s uses=%s days=%s" % (invite["role"], invite["max_uses"], body.days),
    )
    return {"invite": invite, "code": invite["code"]}


@router.get("/api/admin/invites")
def admin_list_invites(request: Request) -> Dict[str, Any]:
    _admin_user(request)
    return {"invites": service.list_invites_admin()}


@router.post("/api/admin/invites/{code}/disable")
def admin_disable_invite(code: str, request: Request) -> Dict[str, Any]:
    actor = _admin_user(request)
    try:
        invite = service.disable_invite(code)
    except AuthError as exc:
        _audit(actor, "invite_disable", str(code), "error", exc.code)
        raise
    _audit(actor, "invite_disable", invite["code"], "ok")
    return {"ok": True, "invite": invite}


@router.post("/api/admin/users/{user_id}/avatar")
async def admin_upload_avatar(user_id: int, request: Request, file: UploadFile = File(...)) -> Dict[str, Any]:
    """管理员替成员换头像。"""
    actor = _admin_user(request)
    target = store.get_user_by_id(int(user_id))
    if not target:
        raise AuthError("用户不存在", 404, "user_not_found")
    content = await _read_avatar_file(file)
    url = avatars.save_bytes(int(user_id), content, file.content_type or "")
    _audit(actor, "user_avatar_update", str(target.get("username") or user_id), "ok", "admin")
    return {"avatar_url": url}


@router.get("/api/admin/users")
def admin_list_users(request: Request) -> Dict[str, Any]:
    actor = _admin_user(request)
    counts = _canvas_counts()
    users = []
    for row in service.list_users_admin(actor):
        row["canvas_count"] = int(counts.get(int(row["id"]), 0))
        users.append(row)
    return {"users": users, "stats": service.admin_stats()}


@router.post("/api/admin/users/{user_id}/disable")
def admin_disable_user(user_id: int, request: Request) -> Dict[str, Any]:
    actor = _admin_user(request)
    try:
        user = service.disable_user(actor, user_id)
    except AuthError as exc:
        _audit(actor, "user_disable", str(user_id), "error", exc.code)
        raise
    _audit(actor, "user_disable", user["username"], "ok", "uid=%d" % user["id"])
    return {"ok": True, "user": user}


@router.post("/api/admin/users/{user_id}/enable")
def admin_enable_user(user_id: int, request: Request) -> Dict[str, Any]:
    actor = _admin_user(request)
    try:
        user = service.enable_user(actor, user_id)
    except AuthError as exc:
        _audit(actor, "user_enable", str(user_id), "error", exc.code)
        raise
    _audit(actor, "user_enable", user["username"], "ok", "uid=%d" % user["id"])
    return {"ok": True, "user": user}


@router.post("/api/admin/users/{user_id}/role")
def admin_change_role(user_id: int, payload: RolePayload, request: Request) -> Dict[str, Any]:
    actor = _admin_user(request)
    before = store.get_user_by_id(int(user_id)) or {}
    try:
        user = service.change_user_role(actor, user_id, payload.role)
    except AuthError as exc:
        _audit(actor, "user_role", str(user_id), "error", exc.code)
        raise
    _audit(
        actor,
        "user_role",
        user["username"],
        "ok",
        "%s->%s" % (before.get("role") or "?", user["role"]),
    )
    return {"ok": True, "user": user}


@router.post("/api/admin/users/{user_id}/reset-password")
def admin_reset_password(user_id: int, request: Request) -> Dict[str, Any]:
    actor = _admin_user(request)
    try:
        user, temp_password = service.reset_user_password(actor, user_id)
    except AuthError as exc:
        _audit(actor, "user_reset_password", str(user_id), "error", exc.code)
        raise
    _audit(actor, "user_reset_password", user["username"], "ok", "uid=%d" % user["id"])
    # 临时密码只在这里返回一次，库里只有 scrypt 哈希
    return {"ok": True, "user": user, "temp_password": temp_password}


@router.post("/api/admin/users/{user_id}/reset-code")
def admin_reset_code(user_id: int, request: Request) -> Dict[str, Any]:
    """生成 6 位一次性重置码（15 分钟）：新码会作废旧码，库里只存哈希。"""
    actor = _admin_user(request)
    try:
        user, code, expires_at = service.create_reset_code(actor, user_id)
    except AuthError as exc:
        _audit(actor, "user_reset_code", str(user_id), "error", exc.code)
        raise
    _audit(actor, "user_reset_code", user["username"], "ok", "uid=%d ttl=%d" % (user["id"], service.RESET_CODE_TTL_SECONDS))
    return {"ok": True, "user": user, "code": code, "expires_at": expires_at}


# ---------------------------------------------------------------- 页面

@router.get("/login", include_in_schema=False)
@router.get("/login.html", include_in_schema=False)
def login_page() -> FileResponse:
    path = _login_page_path()
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="登录页缺失：static/login.html")
    return FileResponse(
        path,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/admin", include_in_schema=False)
@router.get("/admin.html", include_in_schema=False)
def admin_page(request: Request):
    """管理员后台：auth 未开启不存在；未登录由中间件 302；非 admin 也 302 到登录页。"""
    if not service.auth_enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    user = service.session_user(request.cookies.get(service.COOKIE_NAME, ""))
    if not user or str(user.get("role")) != "admin":
        return RedirectResponse(url="/login?next=/admin", status_code=302)
    path = _admin_page_path()
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="管理页缺失：static/admin.html")
    return FileResponse(
        path,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )
