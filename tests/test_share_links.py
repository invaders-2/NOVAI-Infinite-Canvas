#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M6 分享链接回归测试（登录后访问 + 自动加 viewer 成员）。

跑法：
    venv/bin/python -m unittest tests.test_share_links -v
"""
from __future__ import annotations

import base64
import json
import os
import re
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-share-links-test-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)
os.environ.setdefault("NOVAI_ADMIN_USER", "admin")
os.environ.setdefault("NOVAI_ADMIN_PASSWORD", "test-pass-123")
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "5000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "5000"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import asset_acl, share_links  # noqa: E402
from server.auth import ratelimit, service, store as auth_store  # noqa: E402

ADMIN_USER = os.environ.get("NOVAI_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("NOVAI_ADMIN_PASSWORD", "test-pass-123")
TOKEN_RE = re.compile(r"^[A-HJ-NP-Z2-9]{10}$")
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


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


def unique_name(prefix: str = "share") -> str:
    return (prefix + uuid.uuid4().hex[:10])[:32]


class A_AuthOffTest(unittest.TestCase):
    """auth 关闭：分享接口/页面一律 404，不影响旧行为。"""

    def setUp(self) -> None:
        set_auth(False)
        ratelimit.reset()

    def test_share_apis_disabled(self) -> None:
        client = fresh_client()
        self.assertEqual(client.get("/api/canvases/whatever/share-link").status_code, 404)
        self.assertEqual(client.post("/api/canvases/whatever/share-link", json={}).status_code, 404)
        self.assertEqual(client.get("/api/share/ABCDEFGHJK").status_code, 404)
        self.assertEqual(client.post("/api/share/ABCDEFGHJK/unlock", json={"password": "x"}).status_code, 404)
        self.assertEqual(client.post("/api/share/ABCDEFGHJK/clone").status_code, 404)
        self.assertEqual(client.get("/c/ABCDEFGHJK").status_code, 404)


class B_ShareLinkTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        set_auth(True)
        service.bootstrap_admin()

    def setUp(self) -> None:
        set_auth(True)
        asset_acl.clear_cache()
        share_links.clear_unlock_hits()
        os.environ.pop("NOVAI_SHARE_UNLOCK_LIMIT", None)
        ratelimit.reset()

    # ---------------------------------------------------------------- helpers
    def admin_client(self) -> TestClient:
        client = fresh_client()
        self.assertEqual(login(client, ADMIN_USER, ADMIN_PASS).status_code, 200)
        return client

    def make_user(self, admin: TestClient, prefix: str = "share") -> tuple:
        issued = admin.post("/api/admin/invites", json={})
        self.assertEqual(issued.status_code, 200, issued.text)
        username = unique_name(prefix)
        client = fresh_client()
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "share-pass-123",
            "invite_code": issued.json()["code"],
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client, registered.json()["user"]

    def make_canvas(self, owner: TestClient, title: str = "分享画布") -> dict:
        response = owner.post("/api/canvases", json={"title": title})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["canvas"]

    def upload(self, owner: TestClient, marker: bytes) -> str:
        response = owner.post(
            "/api/ai/upload",
            files=[("files", ("share-%s.png" % uuid.uuid4().hex[:8], PNG + marker, "image/png"))],
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["files"][0]["url"]

    def create_link(self, owner: TestClient, canvas_id: str, **body) -> dict:
        response = owner.post("/api/canvases/%s/share-link" % canvas_id, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["link"]

    def share_member(self, owner: TestClient, canvas_id: str, username: str, role: str = "viewer") -> None:
        response = owner.post("/api/canvases/%s/members" % canvas_id, json={"username": username, "role": role})
        self.assertEqual(response.status_code, 200, response.text)

    # ---------------------------------------------------------------- 生命周期
    def test_owner_link_lifecycle(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "sl-owner")
        viewer, viewer_user = self.make_user(admin, "sl-viewer")
        canvas = self.make_canvas(owner)
        self.share_member(owner, canvas["id"], viewer_user["username"], "viewer")

        self.assertEqual(owner.get("/api/canvases/%s/share-link" % canvas["id"]).json(), {"link": None})

        link = self.create_link(owner, canvas["id"], expires_in_days=7, allow_clone=False)
        self.assertRegex(link["token"], TOKEN_RE)
        self.assertEqual(link["role"], "viewer")
        self.assertEqual(link["expires_in_days"], 7)
        self.assertFalse(link["has_password"])
        self.assertFalse(link["allow_clone"])
        self.assertTrue(link["url"].endswith("/c/" + link["token"]))
        self.assertGreater(link["expires_at"], int(time.time() * 1000))

        again = owner.get("/api/canvases/%s/share-link" % canvas["id"]).json()["link"]
        self.assertEqual(again["token"], link["token"])

        updated = self.create_link(owner, canvas["id"], expires_in_days=1, password="share-secret", allow_clone=True)
        self.assertEqual(updated["token"], link["token"])
        self.assertEqual(updated["expires_in_days"], 1)
        self.assertTrue(updated["has_password"])
        self.assertTrue(updated["allow_clone"])

        # 非 owner/admin：403
        self.assertEqual(viewer.get("/api/canvases/%s/share-link" % canvas["id"]).status_code, 403)
        self.assertEqual(viewer.post("/api/canvases/%s/share-link" % canvas["id"], json={}).status_code, 403)
        self.assertEqual(viewer.delete("/api/canvases/%s/share-link" % canvas["id"]).status_code, 403)
        # admin：200
        self.assertEqual(admin.get("/api/canvases/%s/share-link" % canvas["id"]).status_code, 200)
        # 画布不存在
        self.assertEqual(owner.get("/api/canvases/%s/share-link" % uuid.uuid4().hex).status_code, 404)

        # 撤销 → owner GET null，登录用户公开访问 404
        self.assertEqual(owner.delete("/api/canvases/%s/share-link" % canvas["id"]).status_code, 200)
        self.assertEqual(owner.get("/api/canvases/%s/share-link" % canvas["id"]).json(), {"link": None})
        self.assertEqual(viewer.get("/api/share/" + link["token"]).status_code, 404)

        # 重新 POST：同 token 恢复
        revived = self.create_link(owner, canvas["id"], expires_in_days=7)
        self.assertEqual(revived["token"], link["token"])
        self.assertTrue(revived["has_password"] is False)
        self.assertEqual(viewer.get("/api/share/" + revived["token"]).status_code, 200)

    # ---------------------------------------------------------------- 登录 + 自动成员
    def test_login_required_and_auto_member(self) -> None:
        admin = self.admin_client()
        owner, owner_user = self.make_user(admin, "sl-owner2")
        viewer, viewer_user = self.make_user(admin, "sl-viewer2")
        stranger, _stranger_user = self.make_user(admin, "sl-stranger")
        canvas = self.make_canvas(owner)
        asset = self.upload(owner, b"member")
        owner.put("/api/canvases/%s" % canvas["id"], json={
            "title": "带图分享", "nodes": [{"id": "n1", "images": [{"url": asset}]}],
            "connections": [], "logs": [], "settings": {},
        })
        link = self.create_link(owner, canvas["id"], expires_in_days=7)
        token = link["token"]

        anonymous = fresh_client().get("/api/share/" + token)
        self.assertEqual(anonymous.status_code, 401)
        self.assertEqual(anonymous.json()["code"], "AUTH_REQUIRED")

        shared = viewer.get("/api/share/" + token)
        self.assertEqual(shared.status_code, 200, shared.text)
        body = shared.json()
        self.assertTrue(body["authenticated"])
        self.assertFalse(body["can_clone"])
        self.assertEqual(body["role"], "viewer")
        self.assertEqual(body["owner_username"], owner_user["username"])
        self.assertEqual(body["canvas"]["id"], canvas["id"])

        # 自动加为 viewer 成员
        members = owner.get("/api/canvases/%s/permissions" % canvas["id"]).json()["members"]
        self.assertIn(viewer_user["username"], [m["username"] for m in members])
        self.assertEqual(viewer.get("/api/canvases/%s" % canvas["id"]).status_code, 200)
        # 素材复用 M5「共享画布引用」：自动成为成员后可读
        self.assertEqual(viewer.get(asset).status_code, 200)

        # 第二个登录用户也能通过链接访问（同样自动加成员）
        self.assertEqual(stranger.get("/api/share/" + token).status_code, 200)
        self.assertEqual(stranger.get(asset).status_code, 200)

    # ---------------------------------------------------------------- 过期/撤销
    def test_expired_and_revoked_require_login_first(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "sl-owner3")
        viewer, _viewer_user = self.make_user(admin, "sl-viewer3")
        canvas = self.make_canvas(owner)
        link = self.create_link(owner, canvas["id"], expires_in_days=7)

        conn = auth_store.connect()
        try:
            conn.execute(
                "UPDATE canvas_share_links SET expires_at = ? WHERE canvas_id = ?",
                (int(time.time() * 1000) - 1000, canvas["id"]),
            )
        finally:
            conn.close()
        expired = viewer.get("/api/share/" + link["token"])
        self.assertEqual(expired.status_code, 410)
        self.assertEqual(expired.json()["code"], "EXPIRED")

        # 未登录仍优先 401
        self.assertEqual(fresh_client().get("/api/share/" + link["token"]).status_code, 401)

        # 撤销后登录用户也是 404
        self.assertEqual(owner.delete("/api/canvases/%s/share-link" % canvas["id"]).status_code, 200)
        self.assertEqual(viewer.get("/api/share/" + link["token"]).status_code, 404)

    # ---------------------------------------------------------------- 密码
    def test_password_unlock_and_cookie_scope(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "sl-owner4")
        viewer, _viewer_user = self.make_user(admin, "sl-viewer4")
        canvas = self.make_canvas(owner)
        link = self.create_link(owner, canvas["id"], expires_in_days=7, password="share-secret-123")
        token = link["token"]

        self.assertEqual(viewer.get("/api/share/" + token).status_code, 401)
        self.assertEqual(viewer.get("/api/share/" + token).json()["code"], "PASSWORD_REQUIRED")
        wrong = viewer.post("/api/share/" + token + "/unlock", json={"password": "wrong-pass"})
        self.assertEqual(wrong.status_code, 403)
        self.assertEqual(wrong.json()["code"], "BAD_PASSWORD")
        ok = viewer.post("/api/share/" + token + "/unlock", json={"password": "share-secret-123"})
        self.assertEqual(ok.status_code, 200)
        self.assertTrue(ok.json()["ok"])
        self.assertIsNotNone(viewer.cookies.get(share_links.COOKIE_NAME))
        self.assertEqual(viewer.get("/api/share/" + token).status_code, 200)

        # cookie 只对当前 token 有效
        other_canvas = self.make_canvas(owner, "另一个画布")
        other = self.create_link(owner, other_canvas["id"], expires_in_days=7, password="other-secret-123")
        self.assertEqual(viewer.get("/api/share/" + other["token"]).status_code, 401)
        self.assertEqual(viewer.get("/api/share/" + other["token"]).json()["code"], "PASSWORD_REQUIRED")

        # 解锁限速：3 次/分钟后第 4 次 429
        os.environ["NOVAI_SHARE_UNLOCK_LIMIT"] = "3"
        share_links.clear_unlock_hits()
        try:
            statuses = []
            for _ in range(4):
                statuses.append(viewer.post("/api/share/" + other["token"] + "/unlock", json={"password": "wrong"}).status_code)
            self.assertEqual(statuses[-1], 429)
        finally:
            os.environ.pop("NOVAI_SHARE_UNLOCK_LIMIT", None)
            share_links.clear_unlock_hits()

    # ---------------------------------------------------------------- clone
    def test_clone_permissions_and_content(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "sl-owner5")
        viewer, viewer_user = self.make_user(admin, "sl-viewer5")
        canvas = self.make_canvas(owner, "可克隆画布")
        owner.put("/api/canvases/%s" % canvas["id"], json={
            "title": "可克隆画布",
            "nodes": [{"id": "n1", "type": "text", "text": "hi"}],
            "connections": [{"id": "c1", "from": "n1", "to": "n1"}],
            "logs": [], "settings": {},
        })
        no_clone = self.create_link(owner, canvas["id"], expires_in_days=7, allow_clone=False)
        self.assertEqual(fresh_client().post("/api/share/%s/clone" % no_clone["token"]).status_code, 401)
        denied = viewer.post("/api/share/%s/clone" % no_clone["token"])
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.json()["code"], "CLONE_NOT_ALLOWED")

        allow = self.create_link(owner, canvas["id"], expires_in_days=7, allow_clone=True)
        cloned = viewer.post("/api/share/%s/clone" % allow["token"])
        self.assertEqual(cloned.status_code, 201, cloned.text)
        new_id = cloned.json()["canvas_id"]
        self.assertNotEqual(new_id, canvas["id"])

        new_canvas = viewer.get("/api/canvases/%s" % new_id)
        self.assertEqual(new_canvas.status_code, 200)
        doc = new_canvas.json()["canvas"]
        self.assertEqual(int(doc["owner_id"]), int(viewer_user["id"]))
        self.assertTrue(doc["title"].endswith("的副本"))
        original = owner.get("/api/canvases/%s" % canvas["id"]).json()["canvas"]
        self.assertEqual(doc["nodes"], original["nodes"])
        self.assertEqual(doc["connections"], original["connections"])

        # 密码链接未解锁时 clone 需要先解锁
        password_link = self.create_link(owner, canvas["id"], expires_in_days=7, allow_clone=True, password="share-secret-123")
        self.assertEqual(viewer.post("/api/share/%s/clone" % password_link["token"]).status_code, 401)
        self.assertEqual(
            viewer.post("/api/share/%s/clone" % password_link["token"]).json()["code"],
            "PASSWORD_REQUIRED",
        )
        viewer.post("/api/share/%s/unlock" % password_link["token"], json={"password": "share-secret-123"})
        self.assertEqual(viewer.post("/api/share/%s/clone" % password_link["token"]).status_code, 201)

    # ---------------------------------------------------------------- 素材
    def test_public_asset_via_auto_membership(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "sl-owner6")
        viewer, _viewer_user = self.make_user(admin, "sl-viewer6")
        referenced = self.upload(owner, b"ref")
        unreferenced = self.upload(owner, b"other")
        canvas = self.make_canvas(owner, "素材分享")
        owner.put("/api/canvases/%s" % canvas["id"], json={
            "title": "素材分享", "nodes": [{"id": "n1", "images": [{"url": referenced}]}],
            "connections": [], "logs": [], "settings": {},
        })
        link = self.create_link(owner, canvas["id"], expires_in_days=7)
        token = link["token"]

        # 登录但还不是成员：素材 403
        self.assertEqual(viewer.get(referenced).status_code, 403)
        # 访问分享链接后自动成为 viewer
        self.assertEqual(viewer.get("/api/share/" + token).status_code, 200)
        asset_acl.clear_cache()
        self.assertEqual(viewer.get(referenced).status_code, 200)
        self.assertEqual(viewer.get(unreferenced).status_code, 403)
        # 匿名无 cookie：401
        self.assertEqual(fresh_client().get(referenced).status_code, 401)

    # ---------------------------------------------------------------- 页面
    def test_share_page_route(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "sl-owner7")
        canvas = self.make_canvas(owner)
        link = self.create_link(owner, canvas["id"])
        page = fresh_client().get("/c/" + link["token"])
        self.assertEqual(page.status_code, 200)
        self.assertIn("text/html", page.headers.get("content-type", ""))
        # 无效 token 也返回页面（页面自己处理状态）
        self.assertEqual(fresh_client().get("/c/NOTATOKEN1").status_code, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
