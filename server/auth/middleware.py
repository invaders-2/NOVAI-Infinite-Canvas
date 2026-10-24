#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全站鉴权中间件：/api/* 未登录返回 401 JSON，页面请求 302 到 /login。

豁免清单（决定哪些东西在没登录时也必须可达）：
- /api/auth/*：登录、注册、登出、me 本身
- /static、/output：页面依赖的静态资源与用户媒体
- /login、/login.html：登录页
- /health、/api/apps/health：探活

素材例外：
- /assets/users/{uid}/**：租户目录，开启鉴权后必须登录且只能访问自己的（admin 可读全部）；
- /assets/ 其它路径（历史素材、内置资源）：保持公共只读。理由：ASSETS_DIR 同时承载安装包
  自带的 library/models 等页面资源，一刀切 admin-only 会把普通用户的界面资源也挡掉；
  M2 先把新数据收进 users/{uid}/，存量素材治理留给下一轮。
"""
from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse

from server.auth import service, tenant

PUBLIC_EXACT_PATHS = frozenset({
    "/login",
    "/login.html",
    "/reset",
    "/reset.html",
    "/favicon.ico",
    "/health",
    "/api/apps/health",
})
PUBLIC_PREFIXES = (
    "/api/auth/",
    "/static/",
    "/assets/",
    "/output/",
    "/c/",
    "/api/share/",
)


SETTINGS_EXACT_PATHS = frozenset({
    "/api/config/token",
    "/api/config/storage",
    "/api/pick-folder",
})
SETTINGS_PREFIXES = ("/api/settings/", "/api/providers/")


def is_admin_only_settings(path: str, method: str = "GET") -> bool:
    """API 设置相关入口：非 admin 一律 403（auth-off 时中间件提前放行，不生效）。

    列表型只读接口（/api/models、/api/config、GET /api/providers）不在此列，其余页面照常可用。
    """
    value = str(path or "")
    if value in SETTINGS_EXACT_PATHS:
        return True
    if any(value.startswith(prefix) for prefix in SETTINGS_PREFIXES):
        return True
    if value == "/api/providers" and str(method or "").upper() in ("PUT", "POST", "PATCH", "DELETE"):
        return True
    return False


def is_public_path(path: str) -> bool:
    value = str(path or "")
    if value in PUBLIC_EXACT_PATHS:
        return True
    return any(value.startswith(prefix) for prefix in PUBLIC_PREFIXES)


# 无扩展名但确实是页面路由的路径：必须按页面处理。
# 只靠 Accept 判断会漏掉 curl / 内嵌 WebView / fetch 这类不带 text/html 的请求，
# 用户会看到 401 JSON 而不是登录页（/account 会话过期时就踩过）。
HTML_PAGE_PATHS = frozenset({
    "/",
    "/legacy",
    "/v2",
    "/admin",
    "/account",
})


def _wants_html(request: Request) -> bool:
    """浏览器地址栏/iframe 的页面请求返回 302，XHR/fetch 拿 401 JSON。"""
    if request.method not in ("GET", "HEAD"):
        return False
    path = request.url.path
    if path in HTML_PAGE_PATHS:
        return True
    if path.endswith(".html"):
        return True
    return "text/html" in (request.headers.get("accept") or "").lower()


def _login_redirect(path: str) -> str:
    value = str(path or "")
    if value and value != "/":
        return "/login?next=" + quote(value, safe="/")
    return "/login"


def _session_user(request: Request):
    token = request.cookies.get(service.COOKIE_NAME, "")
    if not token:
        return None
    try:
        return service.session_user(token)
    except Exception as exc:
        # 数据库损坏等异常时按未登录处理：不能让所有请求一起 500
        print("[auth] 会话校验失败：%s" % exc)
        return None


def _assets_allowed(path: str, user) -> bool:
    """/assets/users/{uid}/... 只允许本人；admin 全部可读。"""
    if str(user.get("role")) == "admin":
        return True
    segments = [part for part in str(path or "").split("/") if part]
    if len(segments) < 3 or segments[0] != "assets" or segments[1] != "users":
        return False
    try:
        owner_id = int(segments[2])
        user_id = int(user.get("id"))
    except (TypeError, ValueError):
        return False
    return owner_id == user_id


def _assets_owner_uid(path: str) -> Optional[int]:
    segments = [part for part in str(path or "").split("/") if part]
    if len(segments) < 3 or segments[0] != "assets" or segments[1] != "users":
        return None
    try:
        return int(segments[2])
    except (TypeError, ValueError):
        return None


async def _call_with_tenant(user, request: Request, call_next: Any):
    """给下游请求绑定当前用户：素材/生成结果据此落 users/{uid}/。"""
    token = tenant.bind_user(user)
    try:
        return await call_next(request)
    finally:
        tenant.reset_user(token)


async def auth_guard(request: Request, call_next: Any):
    if not service.auth_enabled() or request.method == "OPTIONS":
        return await call_next(request)

    path = request.url.path
    user = _session_user(request)
    if user:
        request.state.auth_user = user

    # 旧 API 设置页：非 admin 不放行（未登录去登录，登录的成员回首页）
    if path in ("/static/api-settings.html", "/api-settings.html"):
        if not user:
            return RedirectResponse(url=_login_redirect(path), status_code=302)
        if str(user.get("role")) != "admin":
            return RedirectResponse(url="/", status_code=302)

    # API 设置接口：仅 admin；auth-off 已在上方提前放行，保持旧行为
    if path.startswith("/api/") and is_admin_only_settings(path, request.method):
        if not user:
            return JSONResponse(
                status_code=401,
                content={"detail": "未登录或会话已过期", "code": "unauthorized"},
            )
        if str(user.get("role")) != "admin":
            return JSONResponse(
                status_code=403,
                content={"detail": "需要管理员权限", "code": "forbidden"},
            )

    # 租户素材目录：登录 + 本人（或 admin）才能读
    if path.startswith("/assets/users/"):
        if not user:
            return JSONResponse(
                status_code=401,
                content={"detail": "未登录或会话已过期", "code": "unauthorized"},
            )
        if not _assets_allowed(path, user):
            # M5：共享画布成员可读该画布引用的素材（owner/admin/editor/viewer 复用 perms）
            allowed = False
            owner_uid = _assets_owner_uid(path)
            if owner_uid is not None:
                try:
                    from server import asset_acl
                    allowed = asset_acl.can_read_asset(owner_uid, path, user)
                except Exception as exc:
                    print("[asset-acl] 共享素材判定失败：%s" % exc)
            if not allowed:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "无权访问该素材", "code": "forbidden"},
                )
        return await _call_with_tenant(user, request, call_next)

    if is_public_path(path):
        return await call_next(request)

    if user:
        return await _call_with_tenant(user, request, call_next)

    if not path.startswith("/api/") and _wants_html(request):
        return RedirectResponse(url=_login_redirect(path), status_code=302)
    return JSONResponse(
        status_code=401,
        content={"detail": "未登录或会话已过期", "code": "unauthorized"},
    )
