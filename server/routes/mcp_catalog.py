#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""应用市场 → MCP 插件接口（Photoshop 精修）。

契约（冻结，前端按这个消费）：
    GET  /api/mcp/catalog                        -> {ok, items:[Item]}
    POST /api/mcp/catalog/{item_id}/install      -> {ok, state}
    GET  /api/mcp/catalog/{item_id}/install      -> {ok, state, step, log, error}
    POST /api/mcp/catalog/{item_id}/uninstall    -> {ok, state}

安装逻辑全在 server/mcp/catalog.py：后台线程 + 每 id 一把锁，重复点不会起第二个线程。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from server.mcp import catalog

router = APIRouter(prefix="/api/mcp", tags=["mcp"])


def set_data_dir(path: str) -> None:
    """main.py 启动时把 DATA_DIR 注入进来，安装目录与状态文件跟着数据目录走。"""
    catalog.set_data_dir(path)


def _http_error(exc: catalog.CatalogError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=str(exc))


@router.get("/catalog")
def mcp_catalog_list() -> Dict[str, Any]:
    return {"ok": True, "items": catalog.items()}


@router.post("/catalog/{item_id}/install")
def mcp_catalog_install(item_id: str) -> Dict[str, Any]:
    try:
        state = catalog.start_install(item_id)
    except catalog.CatalogError as exc:
        raise _http_error(exc)
    return {"ok": True, "state": state}


@router.get("/catalog/{item_id}/install")
def mcp_catalog_install_status(item_id: str) -> Dict[str, Any]:
    try:
        return catalog.install_status(item_id)
    except catalog.CatalogError as exc:
        raise _http_error(exc)


@router.post("/catalog/{item_id}/uninstall")
def mcp_catalog_uninstall(item_id: str) -> Dict[str, Any]:
    try:
        catalog.uninstall(item_id)
    except catalog.CatalogError as exc:
        raise _http_error(exc)
    return {"ok": True, "state": "idle"}
