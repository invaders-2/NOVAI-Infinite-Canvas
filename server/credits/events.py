#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""余额变更事件总线（SSE 用）。

进程内实现：每个用户一个订阅者集合；扣费/充值发生在 FastAPI 线程池或事件循环里，
统一通过 loop.call_soon_threadsafe 投递，避免跨线程直接碰 asyncio.Queue。
单进程多 worker 不共享（本项目本来就是单进程 uvicorn）。
"""
from __future__ import annotations

import asyncio
import threading
from typing import Dict, Set

_LOCK = threading.Lock()
_SUBSCRIBERS: Dict[int, Set[asyncio.Queue]] = {}
_LOOP: asyncio.AbstractEventLoop = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _LOOP
    _LOOP = loop


def subscribe(user_id: int) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=100)
    # closed 标记：unsubscribe 之后即使有在途 publish 拿到旧快照，也不再往队列写
    queue.novai_closed = False
    with _LOCK:
        _SUBSCRIBERS.setdefault(int(user_id), set()).add(queue)
    return queue


def unsubscribe(user_id: int, queue: asyncio.Queue) -> None:
    queue.novai_closed = True
    with _LOCK:
        subscribers = _SUBSCRIBERS.get(int(user_id))
        if subscribers is not None:
            subscribers.discard(queue)
            if not subscribers:
                _SUBSCRIBERS.pop(int(user_id), None)


def publish(user_id: int, balance: float) -> None:
    event = {"type": "balance", "balance": round(float(balance), 6)}
    with _LOCK:
        queues = list(_SUBSCRIBERS.get(int(user_id)) or [])
    loop = _LOOP
    for queue in queues:
        try:
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(_put_nowait, queue, event)
            else:
                _put_nowait(queue, event)
        except RuntimeError:
            continue


def _put_nowait(queue: asyncio.Queue, event: Dict[str, object]) -> None:
    if getattr(queue, "novai_closed", False):
        return
    try:
        queue.put_nowait(event)
    except asyncio.QueueFull:
        # 消费端卡住时丢最旧的一条，保证最新余额能到
        try:
            queue.get_nowait()
            queue.put_nowait(event)
        except Exception:
            pass


def subscriber_count(user_id: int = 0) -> int:
    with _LOCK:
        if user_id:
            return len(_SUBSCRIBERS.get(int(user_id)) or ())
        return sum(len(items) for items in _SUBSCRIBERS.values())
