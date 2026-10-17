#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenClaw 按需安装引导路由（只加这一条安装路径，不碰既有聊天 / 能力链路）：

    GET  /api/openclaw/status          -> 检测结果（可执行文件 / 版本 / Gateway / Node），带短缓存
    POST /api/openclaw/install         -> SSE：start / log / verify / done（必须前端显式确认后才调用）
    POST /api/openclaw/install/cancel  -> 终止当前安装进程组
    GET  /api/openclaw/install/status  -> 当前（或最近一次）安装会话快照，页面刷新后可恢复

安装命令来自 config/openclaw.json（环境变量可覆盖），路由层不拼命令、不写死 URL。
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from server.integrations import openclaw_setup

router = APIRouter(prefix="/api/openclaw")


def _sse(event: str, data: Dict[str, Any]) -> str:
    return "event: %s\ndata: %s\n\n" % (event, json.dumps(data, ensure_ascii=False))


@router.get("/status")
async def openclaw_status(force: int = 0):
    """OpenClaw 可用性检测；默认走 30 秒缓存，force=1 强制重测。"""
    return openclaw_setup.detect(force=bool(force))


@router.get("/install/status")
async def openclaw_install_status():
    return {
        "ok": True,
        "running": openclaw_setup.active_install() is not None,
        "session": openclaw_setup.current_snapshot(),
    }


@router.post("/install")
async def openclaw_install():
    try:
        session = openclaw_setup.begin_install()
    except openclaw_setup.InstallError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    async def gen():
        try:
            async for item in session.stream():
                event = str(item.get("event") or "message")
                yield _sse(event, item)
        except asyncio.CancelledError:
            # 客户端断流：终止子进程组后原样上抛，交给事件循环收尾
            session.cancel()
            raise
        except Exception as exc:  # 兜底：绝不让安装异常变成 500 白屏
            session.status = "failed"
            session.error = "安装执行异常：%s: %s" % (type(exc).__name__, exc)
            session.finished_at = int(time.time() * 1000)
            yield _sse("error", {"message": session.error, "code": "install_exception"})
            yield _sse("done", {"ok": False, "message": session.error,
                                "result": session.result, "session": session.snapshot()})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@router.post("/install/cancel")
async def openclaw_install_cancel():
    cancelled = openclaw_setup.cancel_install()
    return {"ok": True, "cancelled": cancelled, "session": openclaw_setup.current_snapshot()}
