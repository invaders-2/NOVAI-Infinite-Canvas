#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""积分制后端：main.py 只需在登录模块之后接三行。

    from server.credits import install, set_data_dir
    set_data_dir(DATA_DIR)
    install(app)

契约、计费口径、价格来源见 server/credits/README.md。
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from server.credits import api, config, pricing, service, store  # noqa: F401
from server.credits.errors import CreditsError, InsufficientBalance, InsufficientCredits

__all__ = [
    "config",
    "install",
    "pricing",
    "reset_for_tests",
    "service",
    "set_data_dir",
    "store",
]


def set_data_dir(path: str) -> None:
    store.set_data_dir(path)


def reset_for_tests() -> None:
    """测试切换数据目录/价目文件后调用：清掉显式路径与价目缓存，下一次调用重新解析。"""
    store.reset_for_tests()
    pricing.reset_cache()


def _error_handler(error: CreditsError) -> JSONResponse:
    payload = dict(error.payload or {})
    payload.setdefault("code", error.code)
    payload.setdefault("detail", error.message)
    return JSONResponse(status_code=error.status_code, content=payload)


def install(app: FastAPI) -> None:
    """注册路由 + 错误映射；幂等。

    注意：install 只注册，不碰数据库。过期 pending 的清理放到应用 startup 事件里，
    这样 import main.py（单测/CLI）不会提前创建 users.db，也不会抢在 auth 模块之前初始化。
    """
    app.include_router(api.router)
    app.add_exception_handler(CreditsError, lambda request, exc: _error_handler(exc))

    @app.on_event("startup")
    def _credits_startup_cleanup() -> None:
        try:
            expired = store.expire_pending_charges()
            if expired:
                print("[credits] 启动清理过期 pending 扣费单：%d 条已退款" % expired)
        except Exception as exc:  # noqa: BLE001 - 清理失败不能阻断启动
            print("[credits] 启动清理 pending 扣费单失败：%s" % exc)
