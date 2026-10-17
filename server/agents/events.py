#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""智能体运行的 SSE 事件总线（进程内，单事件循环）。

POST /api/agents/{id}/run 在后台跑生产循环，把 SSE 分片 publish 到这里；
GET /api/agents/runs/{run_id}/stream 订阅同一 run 的分片。事件分片与
/api/agent/run 完全一致（同一个 _agent_run_producer 产出）。

先订阅后发布，或先发布后订阅都支持：subscribe 先把已缓冲的分片回放，再挂队列。
"""
from __future__ import annotations

import asyncio
from typing import Any, AsyncGenerator, Dict, List, Optional


class RunEventBus:
    def __init__(self) -> None:
        self._items: Dict[str, List[str]] = {}
        self._subs: Dict[str, List[asyncio.Queue]] = {}
        self._done: Dict[str, bool] = {}

    def publish(self, run_id: str, chunk: str) -> None:
        run_id = str(run_id or "")
        if not run_id or chunk is None:
            return
        self._items.setdefault(run_id, []).append(chunk)
        for queue in list(self._subs.get(run_id) or []):
            queue.put_nowait(chunk)

    def finish(self, run_id: str) -> None:
        run_id = str(run_id or "")
        if not run_id:
            return
        self._done[run_id] = True
        for queue in list(self._subs.get(run_id) or []):
            queue.put_nowait(None)

    def is_done(self, run_id: str) -> bool:
        return bool(self._done.get(str(run_id or "")))

    def drop(self, run_id: str) -> None:
        run_id = str(run_id or "")
        self._items.pop(run_id, None)
        self._done.pop(run_id, None)

    async def subscribe(self, run_id: str) -> AsyncGenerator[str, None]:
        run_id = str(run_id or "")
        queue: asyncio.Queue = asyncio.Queue()
        # 同步完成「回放快照 + 注册队列」，中间没有 await，不会漏事件也不会重复
        items = list(self._items.get(run_id) or [])
        done = self.is_done(run_id)
        self._subs.setdefault(run_id, []).append(queue)
        try:
            for chunk in items:
                yield chunk
            if done:
                return
            while True:
                chunk = await queue.get()
                if chunk is None:
                    break
                yield chunk
        finally:
            subs = self._subs.get(run_id)
            if subs and queue in subs:
                subs.remove(queue)
            if subs is not None and not subs:
                self._subs.pop(run_id, None)


bus = RunEventBus()
