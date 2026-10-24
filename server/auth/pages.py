#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""登录体系的自助页面：/account（我的账户）与 /reset（忘记密码）。

放这里而不是 api.py / main.py：main.py 由并行分支维护，页面与接口解耦能少改一处；
auth 未开启时两页都 404，本地桌面版行为完全不变。
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse

from server.auth import service

router = APIRouter()
_STATIC_DIR = ""


def set_static_dir(path: str) -> None:
    global _STATIC_DIR
    _STATIC_DIR = str(path or "")


def _static_page(filename: str) -> str:
    static_dir = _STATIC_DIR or os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "static",
    )
    return os.path.join(static_dir, filename)


def _session_user(request: Request) -> Optional[Dict[str, Any]]:
    return service.session_user(request.cookies.get(service.COOKIE_NAME, ""))


def _page(filename: str) -> FileResponse:
    path = _static_page(filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="页面缺失：static/%s" % filename)
    return FileResponse(
        path,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


@router.get("/account", include_in_schema=False)
@router.get("/account.html", include_in_schema=False)
def account_page(request: Request):
    if not service.auth_enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    if not _session_user(request):
        return RedirectResponse(url="/login?next=/account", status_code=302)
    return _page("account.html")


@router.get("/reset", include_in_schema=False)
@router.get("/reset.html", include_in_schema=False)
def reset_page():
    if not service.auth_enabled():
        raise HTTPException(status_code=404, detail="Not Found")
    return _page("reset.html")
