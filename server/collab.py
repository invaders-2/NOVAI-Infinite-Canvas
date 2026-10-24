#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""画布实时协作（M4）：/ws/canvas/{canvasId} 的房间、presence、patch 与 cursor。

设计口径：
- 只做转发与内存 patch 历史，不解释、不落盘 patch；画布文档始终以 CANVAS_DIR/{id}.json 为准。
- auth-off 时不启用：握手后直接 4403，不碰 users.db / canvas_shares。
- 权限复用 server.perms：owner/admin 全权，editor 可发 patch，viewer 只读。
- 颜色按 userId 从固定调色板取，跨房间一致。
"""
from __future__ import annotations

import asyncio
import itertools
import json
import math
import time
from collections import deque
from typing import Any, Callable, Dict, List, Optional

from fastapi import WebSocket, WebSocketDisconnect

from server.auth import service
from server import perms

ROOM_CAPACITY = 10
PATCH_HISTORY = 500
PATCH_MAX_BYTES = 512 * 1024
CURSOR_MIN_INTERVAL = 0.030  # 服务端二次限速：同一个人 30ms 内只转发一次
HEARTBEAT_SECONDS = 10.0

COLORS = (
    "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
    "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
)

_rooms: Dict[str, "Room"] = {}
_ids = itertools.count(1)


def color_for(user_id: int) -> str:
    return COLORS[int(user_id) % len(COLORS)]


def _owner_id(canvas: Dict[str, Any]) -> Optional[int]:
    value = (canvas or {}).get("owner_id")
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class Client:
    __slots__ = ("client_id", "ws", "user_id", "username", "color", "role", "last_cursor_at", "loop")

    def __init__(self, ws: WebSocket, user_id: int, username: str, role: str) -> None:
        self.client_id = "c%d" % next(_ids)
        self.ws = ws
        # TestClient 每个 websocket 会话有独立事件循环；广播时必须回到目标连接自己的 loop
        self.loop = asyncio.get_running_loop()
        self.user_id = int(user_id)
        self.username = str(username or "")
        self.color = color_for(self.user_id)
        self.role = str(role or "")
        self.last_cursor_at = 0.0

    def public(self) -> Dict[str, Any]:
        return {"id": self.user_id, "username": self.username, "color": self.color, "role": self.role}


class Room:
    def __init__(self, canvas_id: str) -> None:
        self.canvas_id = canvas_id
        self.clients: Dict[str, Client] = {}
        self.patches: deque = deque(maxlen=PATCH_HISTORY)
        self.revision = 0

    def users(self) -> List[Dict[str, Any]]:
        return [client.public() for client in self.clients.values()]


def get_room(canvas_id: str) -> Room:
    room = _rooms.get(canvas_id)
    if room is None:
        room = Room(canvas_id)
        _rooms[canvas_id] = room
    return room


def active_rooms() -> Dict[str, int]:
    return {cid: len(room.clients) for cid, room in _rooms.items() if room.clients}


async def _safe_send(client: Client, payload: Dict[str, Any]) -> bool:
    try:
        if client.loop is asyncio.get_running_loop():
            await client.ws.send_json(payload)
        else:
            future = asyncio.run_coroutine_threadsafe(client.ws.send_json(payload), client.loop)
            await asyncio.wrap_future(future)
        return True
    except Exception:
        return False


async def _broadcast(room: Room, payload: Dict[str, Any], exclude: Optional[Client] = None) -> None:
    dead = []
    for client in list(room.clients.values()):
        if exclude is not None and client is exclude:
            continue
        if not await _safe_send(client, payload):
            dead.append(client)
    if dead:
        for client in dead:
            room.clients.pop(client.client_id, None)
        await _broadcast(room, {"type": "presence", "users": room.users()})


async def _send_error(ws: WebSocket, code: str, message: str = "") -> None:
    await ws.send_json({"type": "error", "code": code, "message": message})


# ---------------------------------------------------------------- patch 校验

def validate_patch(patch: Any) -> Optional[str]:
    """只校验结构，不解释画布语义。合法返回 None，否则返回错误文案。"""
    if not isinstance(patch, dict) or not patch:
        return "patch 必须是非空对象"
    try:
        encoded = json.dumps(patch, ensure_ascii=False, default=str).encode("utf-8")
    except (TypeError, ValueError):
        return "patch 无法序列化"
    if len(encoded) > PATCH_MAX_BYTES:
        return "patch 超过 512KB"
    unknown = set(patch.keys()) - {"title", "nodes", "connections"}
    if unknown:
        return "patch 含未知字段：%s" % ",".join(sorted(unknown))
    if "title" in patch and not isinstance(patch["title"], str):
        return "patch.title 必须是字符串"
    for key in ("nodes", "connections"):
        if key not in patch:
            continue
        section = patch[key]
        if not isinstance(section, dict):
            return "patch.%s 必须是对象" % key
        bad_keys = set(section.keys()) - {"add", "remove", "update"}
        if bad_keys:
            return "patch.%s 含未知字段" % key
        add = section.get("add", [])
        remove = section.get("remove", [])
        update = section.get("update", [])
        if not isinstance(add, list) or not all(isinstance(item, dict) for item in add):
            return "patch.%s.add 必须是对象数组" % key
        if not isinstance(remove, list) or not all(isinstance(item, str) for item in remove):
            return "patch.%s.remove 必须是 id 字符串数组" % key
        if not isinstance(update, list):
            return "patch.%s.update 必须是数组" % key
        for item in update:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                return "patch.%s.update 每项必须有字符串 id" % key
            if "fields" in item and not isinstance(item.get("fields"), dict):
                return "patch.%s.update.fields 必须是对象" % key
    return None


def _valid_cursor(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


# ---------------------------------------------------------------- 主流程

async def serve(websocket: WebSocket, canvas_id: str, load_canvas: Callable[[str], Dict[str, Any]]) -> None:
    await websocket.accept()

    if not service.auth_enabled():
        await _send_error(websocket, "FORBIDDEN", "实时协作未启用（NOVAI_AUTH_ENABLED=0）")
        await websocket.close(code=4403)
        return

    token = websocket.cookies.get(service.COOKIE_NAME, "")
    user = service.session_user(token) if token else None
    if not user:
        await _send_error(websocket, "AUTH_REQUIRED", "未登录或会话已过期")
        await websocket.close(code=4401)
        return

    try:
        canvas = load_canvas(canvas_id)
    except Exception:
        await _send_error(websocket, "FORBIDDEN", "画布不存在或已在回收站")
        await websocket.close(code=4403)
        return

    user_id = int(user["id"])
    share = perms.get_share(canvas_id, user_id)
    role = perms.resolve_role(_owner_id(canvas), user, share)
    if not perms.can(role, "view"):
        await _send_error(websocket, "FORBIDDEN", "没有这个画布的访问权限")
        await websocket.close(code=4403)
        return

    room = get_room(canvas_id)
    if len(room.clients) >= ROOM_CAPACITY:
        await _send_error(websocket, "ROOM_FULL", "房间已满（最多 %d 人）" % ROOM_CAPACITY)
        await websocket.close(code=4409)
        return

    client = Client(websocket, user_id, user.get("username") or "", role)
    room.clients[client.client_id] = client
    try:
        # 新加入者：先 snapshot（磁盘文档），再 hello（含在线列表），再补发历史 patch，最后广播 presence
        await websocket.send_json({"type": "snapshot", "doc": canvas, "revision": room.revision})
        await websocket.send_json({
            "type": "hello",
            "self": {"id": user_id, "username": client.username, "color": client.color},
            "role": role,
            "users": room.users(),
            "revision": room.revision,
        })
        for record in room.patches:
            await websocket.send_json({
                "type": "patch",
                "from": record["from"],
                "patch": record["patch"],
                "revision": record["revision"],
            })
        await _broadcast(room, {"type": "presence", "users": room.users()})

        while True:
            try:
                message = await asyncio.wait_for(websocket.receive_json(), timeout=HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                try:
                    await websocket.close(code=1000)
                except Exception:
                    pass
                break
            if not isinstance(message, dict):
                await _send_error(websocket, "BAD_MESSAGE", "消息必须是 JSON 对象")
                continue
            await _handle_message(room, client, message, load_canvas)
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001 - 连接内异常不能带崩整个服务
        print("[collab] 连接异常：%s" % exc)
    finally:
        room.clients.pop(client.client_id, None)
        try:
            await _broadcast(room, {"type": "presence", "users": room.users()})
        except Exception:
            pass
        if not room.clients:
            _rooms.pop(canvas_id, None)


async def _handle_message(room: Room, client: Client, message: Dict[str, Any], load_canvas) -> None:
    mtype = str(message.get("type") or "").strip()

    if mtype == "ping":
        await _safe_send(client, {"type": "pong"})
        return

    if mtype == "cursor":
        x, y = message.get("x"), message.get("y")
        if not _valid_cursor(x) or not _valid_cursor(y):
            await _send_error(client.ws, "BAD_MESSAGE", "cursor 需要数字 x/y")
            return
        now = time.monotonic()
        if now - client.last_cursor_at < CURSOR_MIN_INTERVAL:
            return
        client.last_cursor_at = now
        await _broadcast(room, {
            "type": "cursor",
            "userId": client.user_id,
            "x": float(x),
            "y": float(y),
        }, exclude=client)
        return

    if mtype == "patch":
        if client.role == "viewer":
            await _send_error(client.ws, "READ_ONLY", "只读成员不能修改画布")
            return
        patch = message.get("patch")
        reason = validate_patch(patch)
        if reason:
            code = "PAYLOAD_TOO_LARGE" if "512KB" in reason else "INVALID_PATCH"
            await _send_error(client.ws, code, reason)
            return
        room.revision += 1
        record = {"from": client.user_id, "patch": patch, "revision": room.revision}
        room.patches.append(record)
        await _broadcast(room, {
            "type": "patch",
            "from": client.user_id,
            "patch": patch,
            "revision": room.revision,
        }, exclude=client)
        return

    if mtype == "request-snapshot":
        try:
            doc = load_canvas(room.canvas_id)
        except Exception:
            await _send_error(client.ws, "FORBIDDEN", "画布已不可读")
            return
        await _safe_send(client, {"type": "snapshot", "doc": doc, "revision": room.revision})
        return

    await _send_error(client.ws, "BAD_MESSAGE", "未知消息类型：%s" % (mtype or "(空)"))
