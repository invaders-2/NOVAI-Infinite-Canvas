#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""邀请制登录（M1）。

main.py 只需要三行：

    from server.auth import install, bootstrap_admin, set_data_dir
    set_data_dir(DATA_DIR); install(app); bootstrap_admin()

详细用法见 server/auth/README.md。
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from server.auth import passwords, service, store  # noqa: F401  （import 顺序：底层先）
from server.auth import api, middleware, pages, tenant
from server.auth.errors import AuthError

__all__ = [
    "AuthError",
    "api",
    "auth_enabled",
    "bootstrap_admin",
    "install",
    "middleware",
    "pages",
    "passwords",
    "service",
    "set_assets_dir",
    "set_canvas_dir",
    "set_data_dir",
    "set_static_dir",
    "store",
    "tenant",
]


def set_data_dir(path: str) -> None:
    store.set_data_dir(path)


def set_static_dir(path: str) -> None:
    api.set_static_dir(path)
    pages.set_static_dir(path)


def set_canvas_dir(path: str) -> None:
    api.set_canvas_dir(path)


def set_assets_dir(path: str) -> None:
    tenant.set_assets_dir(path)


def audit(action: str, actor: Any, target: str = "", result: str = "ok", detail: str = "") -> None:
    store.audit(action, actor, target, result, detail)


def auth_enabled() -> bool:
    return service.auth_enabled()


def bootstrap_admin():
    return service.bootstrap_admin()


async def _auth_error_handler(request: Any, exc: AuthError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.message, "code": exc.code},
    )


def install(app: FastAPI) -> None:
    """接入路由 + 鉴权中间件 + 错误映射；幂等（重复调用只是重复注册）。"""
    app.include_router(api.router)
    app.include_router(pages.router)
    app.add_exception_handler(AuthError, _auth_error_handler)
    app.middleware("http")(middleware.auth_guard)
