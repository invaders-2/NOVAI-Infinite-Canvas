#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M4 实时协作真机冒烟：httpx 走 HTTP，websockets 走 /ws/canvas/{id}。

用法（服务已用 NOVAI_AUTH_ENABLED=1 跑在 8897）：
    NOVAI_DATA_DIR=/tmp/novai-collab-data venv/bin/python tests/collab_smoke.py

覆盖：匿名 4401 / 无关用户 4403 / owner+editor hello+presence / patch revision /
cursor / viewer READ_ONLY / snapshot=磁盘 / 11 人 4409。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

BASE = os.environ.get("NOVAI_BASE", "http://127.0.0.1:8897")
WS_BASE = BASE.replace("http://", "ws://").replace("https://", "wss://")
ADMIN_USER = os.environ.get("NOVAI_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("NOVAI_ADMIN_PASSWORD", "test-pass-123")
DATA_DIR = os.environ.get("NOVAI_DATA_DIR", "/tmp/novai-collab-data")

FAILED = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def cookie_header(client: httpx.Client) -> str:
    token = client.cookies.get("novai_session")
    return "novai_session=" + (token or "")


async def recv_until(ws, wanted: str, limit: int = 30) -> dict:
    for _ in range(limit):
        message = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if message.get("type") == wanted:
            return message
    raise AssertionError("等不到 %s" % wanted)


async def main() -> int:
    admin = httpx.Client(base_url=BASE, timeout=10)
    response = admin.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASS})
    check("管理员登录", response.status_code == 200, str(response.status_code))
    admin_cookie = cookie_header(admin)

    def register(name: str) -> httpx.Client:
        code = admin.post("/api/admin/invites", json={}).json()["code"]
        client = httpx.Client(base_url=BASE, timeout=10)
        res = client.post("/api/auth/register", json={"username": name, "password": "collab-pass-123", "invite_code": code})
        if res.status_code != 200:
            raise SystemExit("注册 %s 失败：%s %s" % (name, res.status_code, res.text))
        return client

    owner = register("alice")
    editor = register("editor")
    viewer = register("viewer")
    stranger = register("stranger")
    canvas = owner.post("/api/canvases", json={"title": "协作冒烟"}).json()["canvas"]
    canvas_id = canvas["id"]
    owner.post("/api/canvases/%s/members" % canvas_id, json={"username": "editor", "role": "editor"})
    owner.post("/api/canvases/%s/members" % canvas_id, json={"username": "viewer", "role": "viewer"})
    url = WS_BASE + "/ws/canvas/" + canvas_id

    # 1) 匿名：4401
    async with websockets.connect(url) as ws:
        message = json.loads(await ws.recv())
        check("匿名 error AUTH_REQUIRED", message.get("code") == "AUTH_REQUIRED", json.dumps(message, ensure_ascii=False))
        try:
            await ws.recv()
            check("匿名 close 4401", False, "连接未关闭")
        except ConnectionClosed as exc:
            check("匿名 close 4401", exc.code == 4401, "code=%s" % exc.code)

    # 2) 无关用户：4403
    async with websockets.connect(url, additional_headers={"Cookie": cookie_header(stranger)}) as ws:
        message = json.loads(await ws.recv())
        check("无关用户 error FORBIDDEN", message.get("code") == "FORBIDDEN", json.dumps(message, ensure_ascii=False))
        try:
            await ws.recv()
            check("无关用户 close 4403", False, "连接未关闭")
        except ConnectionClosed as exc:
            check("无关用户 close 4403", exc.code == 4403, "code=%s" % exc.code)

    # 3) owner + editor：snapshot / hello / presence / patch / cursor / ping
    async with websockets.connect(url, additional_headers={"Cookie": cookie_header(owner)}) as ws_owner:
        snapshot = json.loads(await ws_owner.recv())
        check("owner snapshot", snapshot.get("type") == "snapshot" and snapshot.get("revision") == 0)
        hello = json.loads(await ws_owner.recv())
        check("owner hello role=owner", hello.get("type") == "hello" and hello.get("role") == "owner",
              json.dumps(hello.get("self"), ensure_ascii=False))
        await ws_owner.recv()  # presence

        async with websockets.connect(url, additional_headers={"Cookie": cookie_header(editor)}) as ws_editor:
            await ws_editor.recv()  # snapshot
            editor_hello = json.loads(await ws_editor.recv())
            check("editor hello role=editor", editor_hello.get("role") == "editor")
            check("editor hello 在线 2 人", len(editor_hello.get("users") or []) == 2)
            await ws_editor.recv()  # presence
            presence = await recv_until(ws_owner, "presence")
            check("owner 收到 editor presence", any(u.get("username") == "editor" for u in presence.get("users") or []))

            patch = {"title": "协作新标题", "nodes": {"add": [{"id": "n1", "type": "text"}], "remove": [], "update": []}}
            await ws_owner.send(json.dumps({"type": "patch", "patch": patch}))
            received = await recv_until(ws_editor, "patch")
            check("editor 收到 patch 且 revision=1", received.get("revision") == 1 and received.get("patch") == patch)

            await ws_editor.send(json.dumps({"type": "cursor", "x": 10, "y": 20}))
            cursor = await recv_until(ws_owner, "cursor")
            check("owner 收到 cursor", cursor.get("userId") is not None and cursor.get("x") == 10.0)

            await ws_editor.send(json.dumps({"type": "ping"}))
            pong = json.loads(await ws_editor.recv())
            check("ping→pong", pong.get("type") == "pong")

            # 4) viewer：只读 + snapshot 对齐磁盘
            async with websockets.connect(url, additional_headers={"Cookie": cookie_header(viewer)}) as ws_viewer:
                viewer_snapshot = json.loads(await ws_viewer.recv())
                viewer_hello = json.loads(await ws_viewer.recv())
                check("viewer hello role=viewer", viewer_hello.get("role") == "viewer")
                disk_path = Path(DATA_DIR) / "data" / "canvases" / (canvas_id + ".json")
                disk_doc = json.loads(disk_path.read_text(encoding="utf-8"))
                check("新加入 snapshot=磁盘画布", viewer_snapshot.get("doc") == disk_doc)
                await ws_viewer.send(json.dumps({"type": "patch", "patch": {"title": "viewer-edit"}}))
                denied = await recv_until(ws_viewer, "error")
                check("viewer patch 被拒 READ_ONLY", denied.get("code") == "READ_ONLY", json.dumps(denied, ensure_ascii=False))

                # 5) 房间满：当前 3 人，再加 7 人 = 10，第 11 个 4409
                extras = []
                for _ in range(7):
                    extra = await websockets.connect(url, additional_headers={"Cookie": cookie_header(owner)})
                    extras.append(extra)
                try:
                    async with websockets.connect(url, additional_headers={"Cookie": cookie_header(owner)}) as ws_eleventh:
                        message = json.loads(await ws_eleventh.recv())
                        check("第 11 人 error ROOM_FULL", message.get("code") == "ROOM_FULL", json.dumps(message, ensure_ascii=False))
                        try:
                            await ws_eleventh.recv()
                            check("第 11 人 close 4409", False, "连接未关闭")
                        except ConnectionClosed as exc:
                            check("第 11 人 close 4409", exc.code == 4409, "code=%s" % exc.code)
                finally:
                    for extra in extras:
                        await extra.close()

    admin.close(); owner.close(); editor.close(); viewer.close(); stranger.close()
    print("\nSUMMARY failed=%d" % FAILED)
    return FAILED


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
