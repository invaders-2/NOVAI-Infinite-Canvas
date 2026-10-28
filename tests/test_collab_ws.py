#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M4 实时协作 WebSocket 回归测试（fastapi TestClient）。

跑法：
    venv/bin/python -m unittest tests.test_collab_ws -v
    venv/bin/python -m unittest tests.test_cloud_auth tests.test_cloud_isolation tests.test_canvas_permissions tests.test_collab_ws

说明：TestClient 每个 websocket 会话独立事件循环，服务端广播做了跨 loop 调度，
所以这里可以像真实浏览器一样开多个连接。
"""
from __future__ import annotations

import base64
import contextlib
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-collab-test-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)
os.environ.setdefault("NOVAI_ADMIN_USER", "admin")
os.environ.setdefault("NOVAI_ADMIN_PASSWORD", "test-pass-123")
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "5000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "5000"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from server import avatars, collab  # noqa: E402
from server.auth import ratelimit, service  # noqa: E402

ADMIN_USER = os.environ.get("NOVAI_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("NOVAI_ADMIN_PASSWORD", "test-pass-123")
PATCH = {"title": "协作标题", "nodes": {"add": [{"id": "n1", "type": "text"}], "remove": [], "update": []}}


def set_auth(enabled: bool) -> None:
    if enabled:
        os.environ["NOVAI_AUTH_ENABLED"] = "1"
        os.environ.pop("NOVAI_AUTH_DISABLED", None)
    else:
        os.environ.pop("NOVAI_AUTH_ENABLED", None)


def tearDownModule():
    set_auth(False)


def fresh_client() -> TestClient:
    return TestClient(main.app, client=("127.0.0.1", 50000), follow_redirects=False)


def login(client: TestClient, username: str, password: str):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def unique_name(prefix: str = "collab") -> str:
    return (prefix + uuid.uuid4().hex[:10])[:32]


def expect_close(ws, expected_code: int, expected_error: str) -> dict:
    message = ws.receive_json()
    if message.get("type") != "error" or message.get("code") != expected_error:
        raise AssertionError("期望 error %s，收到 %s" % (expected_error, message))
    try:
        ws.receive_json()
        raise AssertionError("连接没有按预期关闭")
    except WebSocketDisconnect as exc:
        if exc.code != expected_code:
            raise AssertionError("close code %s != %s" % (exc.code, expected_code))
    return message


class A_AuthOffTest(unittest.TestCase):
    """auth 关闭：协作端点不启用，直接 4403，不碰权限表。"""

    def setUp(self) -> None:
        set_auth(False)
        ratelimit.reset()

    def test_collab_disabled(self) -> None:
        client = fresh_client()
        created = client.post("/api/canvases", json={"title": "auth-off collab"})
        self.assertEqual(created.status_code, 200)
        canvas_id = created.json()["canvas"]["id"]
        with client.websocket_connect("/ws/canvas/%s" % canvas_id) as ws:
            expect_close(ws, 4403, "FORBIDDEN")


class B_CollabTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        set_auth(True)
        service.bootstrap_admin()

    def setUp(self) -> None:
        set_auth(True)
        ratelimit.reset()

    # ---------------------------------------------------------------- helpers
    def admin_client(self) -> TestClient:
        client = fresh_client()
        self.assertEqual(login(client, ADMIN_USER, ADMIN_PASS).status_code, 200)
        return client

    def make_user(self, admin: TestClient, prefix: str = "collab") -> tuple:
        issued = admin.post("/api/admin/invites", json={})
        self.assertEqual(issued.status_code, 200, issued.text)
        username = unique_name(prefix)
        client = fresh_client()
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "collab-pass-123",
            "invite_code": issued.json()["code"],
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client, registered.json()["user"]

    def setup_canvas(self, admin: TestClient) -> dict:
        owner, owner_user = self.make_user(admin, "owner")
        editor, editor_user = self.make_user(admin, "editor")
        viewer, viewer_user = self.make_user(admin, "viewer")
        canvas = owner.post("/api/canvases", json={"title": "协作画布"}).json()["canvas"]
        self.assertEqual(
            owner.post("/api/canvases/%s/members" % canvas["id"], json={"username": editor_user["username"], "role": "editor"}).status_code,
            200,
        )
        self.assertEqual(
            owner.post("/api/canvases/%s/members" % canvas["id"], json={"username": viewer_user["username"], "role": "viewer"}).status_code,
            200,
        )
        return {
            "canvas": canvas,
            "owner": (owner, owner_user),
            "editor": (editor, editor_user),
            "viewer": (viewer, viewer_user),
        }

    def url(self, canvas_id: str) -> str:
        return "/ws/canvas/%s" % canvas_id

    # ---------------------------------------------------------------- 鉴权
    def test_anonymous_4401_and_stranger_4403(self) -> None:
        admin = self.admin_client()
        ctx = self.setup_canvas(admin)
        canvas_id = ctx["canvas"]["id"]
        stranger, _stranger_user = self.make_user(admin, "stranger")

        with fresh_client().websocket_connect(self.url(canvas_id)) as ws:
            expect_close(ws, 4401, "AUTH_REQUIRED")
        with stranger.websocket_connect(self.url(canvas_id)) as ws:
            expect_close(ws, 4403, "FORBIDDEN")

    # ---------------------------------------------------------------- hello/presence
    def test_join_hello_and_presence(self) -> None:
        admin = self.admin_client()
        ctx = self.setup_canvas(admin)
        owner_client, owner_user = ctx["owner"]
        editor_client, editor_user = ctx["editor"]
        canvas_id = ctx["canvas"]["id"]

        with owner_client.websocket_connect(self.url(canvas_id)) as owner:
            snapshot = owner.receive_json()
            self.assertEqual(snapshot["type"], "snapshot")
            hello = owner.receive_json()
            self.assertEqual(hello["type"], "hello")
            self.assertEqual(hello["role"], "owner")
            self.assertEqual(hello["self"]["id"], owner_user["id"])
            self.assertEqual(hello["self"]["color"], collab.color_for(owner_user["id"]))
            self.assertEqual([u["username"] for u in hello["users"]], [owner_user["username"]])
            self.assertEqual(owner.receive_json()["type"], "presence")

            with editor_client.websocket_connect(self.url(canvas_id)) as editor:
                self.assertEqual(editor.receive_json()["type"], "snapshot")
                editor_hello = editor.receive_json()
                self.assertEqual(editor_hello["type"], "hello")
                self.assertEqual(editor_hello["role"], "editor")
                self.assertEqual(
                    sorted(u["username"] for u in editor_hello["users"]),
                    sorted([owner_user["username"], editor_user["username"]]),
                )
                self.assertEqual(editor.receive_json()["type"], "presence")

                presence = owner.receive_json()
                self.assertEqual(presence["type"], "presence")
                self.assertEqual(
                    sorted(u["username"] for u in presence["users"]),
                    sorted([owner_user["username"], editor_user["username"]]),
                )

    # ---------------------------------------------------------------- patch/cursor
    def test_patch_cursor_and_validation(self) -> None:
        admin = self.admin_client()
        ctx = self.setup_canvas(admin)
        owner_client, owner_user = ctx["owner"]
        editor_client, editor_user = ctx["editor"]
        canvas_id = ctx["canvas"]["id"]

        with owner_client.websocket_connect(self.url(canvas_id)) as owner:
            owner.receive_json(); owner.receive_json(); owner.receive_json()
            with editor_client.websocket_connect(self.url(canvas_id)) as editor:
                editor.receive_json(); editor.receive_json(); editor.receive_json()
                owner.receive_json()  # presence

                owner.send_json({"type": "patch", "patch": PATCH})
                received = editor.receive_json()
                self.assertEqual(received["type"], "patch")
                self.assertEqual(received["from"], owner_user["id"])
                self.assertEqual(received["revision"], 1)
                self.assertEqual(received["patch"], PATCH)

                editor.send_json({"type": "patch", "patch": {"title": "第二版"}})
                second = owner.receive_json()
                self.assertEqual(second["type"], "patch")
                self.assertEqual(second["from"], editor_user["id"])
                self.assertEqual(second["revision"], 2)

                editor.send_json({"type": "cursor", "x": 12.5, "y": -3})
                cursor = owner.receive_json()
                self.assertEqual(cursor, {"type": "cursor", "userId": editor_user["id"], "x": 12.5, "y": -3.0})

                editor.send_json({"type": "ping"})
                self.assertEqual(editor.receive_json(), {"type": "pong"})

                editor.send_json({"type": "patch", "patch": {"bogus": 1}})
                invalid = editor.receive_json()
                self.assertEqual(invalid["type"], "error")
                self.assertEqual(invalid["code"], "INVALID_PATCH")

                huge = {"title": "x" * (collab.PATCH_MAX_BYTES + 128)}
                editor.send_json({"type": "patch", "patch": huge})
                too_big = editor.receive_json()
                self.assertEqual(too_big["type"], "error")
                self.assertEqual(too_big["code"], "PAYLOAD_TOO_LARGE")

                editor.send_json({"type": "nope"})
                self.assertEqual(editor.receive_json()["code"], "BAD_MESSAGE")

    def test_new_joiner_receives_patch_backlog(self) -> None:
        admin = self.admin_client()
        ctx = self.setup_canvas(admin)
        owner_client, _owner_user = ctx["owner"]
        editor_client, _editor_user = ctx["editor"]
        viewer_client, _viewer_user = ctx["viewer"]
        canvas_id = ctx["canvas"]["id"]

        with owner_client.websocket_connect(self.url(canvas_id)) as owner:
            owner.receive_json(); owner.receive_json(); owner.receive_json()
            with editor_client.websocket_connect(self.url(canvas_id)) as editor:
                editor.receive_json(); editor.receive_json(); editor.receive_json()
                owner.receive_json()
                owner.send_json({"type": "patch", "patch": {"title": "历史 patch"}})
                self.assertEqual(editor.receive_json()["revision"], 1)

                # 新加入者：snapshot → hello → 补发历史 patch → presence
                with viewer_client.websocket_connect(self.url(canvas_id)) as viewer:
                    self.assertEqual(viewer.receive_json()["type"], "snapshot")
                    self.assertEqual(viewer.receive_json()["type"], "hello")
                    backlog = viewer.receive_json()
                    self.assertEqual(backlog["type"], "patch")
                    self.assertEqual(backlog["revision"], 1)
                    self.assertEqual(backlog["patch"], {"title": "历史 patch"})
                    self.assertEqual(viewer.receive_json()["type"], "presence")

    # ---------------------------------------------------------------- viewer
    def test_viewer_read_only_and_snapshot(self) -> None:
        admin = self.admin_client()
        ctx = self.setup_canvas(admin)
        viewer_client, viewer_user = ctx["viewer"]
        canvas_id = ctx["canvas"]["id"]
        disk = json.loads((Path(main.CANVAS_DIR) / (canvas_id + ".json")).read_text(encoding="utf-8"))

        with viewer_client.websocket_connect(self.url(canvas_id)) as viewer:
            snapshot = viewer.receive_json()
            self.assertEqual(snapshot["type"], "snapshot")
            self.assertEqual(snapshot["doc"], disk)
            hello = viewer.receive_json()
            self.assertEqual(hello["role"], "viewer")
            viewer.receive_json()  # presence

            viewer.send_json({"type": "patch", "patch": {"title": "viewer edit"}})
            denied = viewer.receive_json()
            self.assertEqual(denied["type"], "error")
            self.assertEqual(denied["code"], "READ_ONLY")

            viewer.send_json({"type": "request-snapshot"})
            again = viewer.receive_json()
            self.assertEqual(again["type"], "snapshot")
            self.assertEqual(again["doc"], disk)
            self.assertEqual(again["revision"], 0)

            viewer.send_json({"type": "ping"})
            self.assertEqual(viewer.receive_json()["type"], "pong")

    # ---------------------------------------------------------------- 头像
    def test_presence_includes_avatar_url(self) -> None:
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        admin = self.admin_client()
        ctx = self.setup_canvas(admin)
        owner_client, owner_user = ctx["owner"]
        editor_client, editor_user = ctx["editor"]
        viewer_client, viewer_user = ctx["viewer"]
        canvas_id = ctx["canvas"]["id"]

        owner_avatar = owner_client.post(
            "/api/auth/avatar", files={"file": ("o.png", png + b"o", "image/png")}
        ).json()["avatar_url"]
        editor_avatar = editor_client.post(
            "/api/auth/avatar", files={"file": ("e.png", png + b"e", "image/png")}
        ).json()["avatar_url"]
        self.assertEqual(owner_avatar, avatars.url_for(owner_user["id"]))
        self.assertEqual(editor_avatar, avatars.url_for(editor_user["id"]))

        with owner_client.websocket_connect(self.url(canvas_id)) as owner:
            owner.receive_json()  # snapshot
            owner_hello = owner.receive_json()
            owner.receive_json()  # presence
            self.assertEqual(owner_hello["self"]["avatar_url"], owner_avatar)
            owner_entry = next(u for u in owner_hello["users"] if u["id"] == owner_user["id"])
            self.assertEqual(owner_entry["avatar_url"], owner_avatar)

            with editor_client.websocket_connect(self.url(canvas_id)) as editor:
                editor.receive_json()  # snapshot
                editor_hello = editor.receive_json()
                editor.receive_json()  # presence
                self.assertEqual(editor_hello["self"]["avatar_url"], editor_avatar)
                users = {u["id"]: u for u in editor_hello["users"]}
                self.assertEqual(users[owner_user["id"]]["avatar_url"], owner_avatar)
                self.assertEqual(users[editor_user["id"]]["avatar_url"], editor_avatar)

                owner_presence = owner.receive_json()
                self.assertEqual(owner_presence["type"], "presence")
                presence_users = {u["id"]: u for u in owner_presence["users"]}
                self.assertEqual(presence_users[owner_user["id"]]["avatar_url"], owner_avatar)
                self.assertEqual(presence_users[editor_user["id"]]["avatar_url"], editor_avatar)

                with viewer_client.websocket_connect(self.url(canvas_id)) as viewer:
                    viewer.receive_json()  # snapshot
                    viewer_hello = viewer.receive_json()
                    viewer.receive_json()  # presence
                    viewer_entry = next(u for u in viewer_hello["users"] if u["id"] == viewer_user["id"])
                    self.assertEqual(viewer_entry["avatar_url"], "")
                    self.assertIn("avatar_url", viewer_hello["self"])
                    self.assertEqual(viewer_hello["self"]["avatar_url"], "")

                    viewer_presence = owner.receive_json()
                    self.assertEqual(viewer_presence["type"], "presence")
                    for entry in viewer_presence["users"]:
                        self.assertIn("avatar_url", entry)
                    by_id = {u["id"]: u for u in viewer_presence["users"]}
                    self.assertEqual(by_id[viewer_user["id"]]["avatar_url"], "")

    # ---------------------------------------------------------------- admin
    def test_admin_can_join_any_canvas(self) -> None:
        admin = self.admin_client()
        ctx = self.setup_canvas(admin)
        canvas_id = ctx["canvas"]["id"]
        with admin.websocket_connect(self.url(canvas_id)) as ws:
            self.assertEqual(ws.receive_json()["type"], "snapshot")
            hello = ws.receive_json()
            self.assertEqual(hello["role"], "admin")
            self.assertIn("admin", [u["username"] for u in hello["users"]])

    # ---------------------------------------------------------------- 房间满
    def test_room_full_4409(self) -> None:
        admin = self.admin_client()
        ctx = self.setup_canvas(admin)
        owner_client, _owner_user = ctx["owner"]
        canvas_id = ctx["canvas"]["id"]
        with contextlib.ExitStack() as stack:
            for _ in range(collab.ROOM_CAPACITY):
                ws = stack.enter_context(owner_client.websocket_connect(self.url(canvas_id)))
                ws.receive_json()  # snapshot
                ws.receive_json()  # hello
            with owner_client.websocket_connect(self.url(canvas_id)) as eleventh:
                expect_close(eleventh, 4409, "ROOM_FULL")


if __name__ == "__main__":
    unittest.main(verbosity=2)
