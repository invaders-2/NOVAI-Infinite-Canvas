#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M5 共享画布素材 ACL 回归测试。

跑法：
    venv/bin/python -m unittest tests.test_asset_acl -v

覆盖：成员可读被引用素材 / 未共享画布素材拒绝 / 无关系 403 / 匿名 401 /
editor 可读 / admin 可读 / 忽略 query / 缓存与成员变更、删除画布后 clear_cache 生效 /
auth-off 不校验。
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-asset-acl-test-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)
os.environ.setdefault("NOVAI_ADMIN_USER", "admin")
os.environ.setdefault("NOVAI_ADMIN_PASSWORD", "test-pass-123")
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "5000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "5000"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import asset_acl  # noqa: E402
from server.auth import ratelimit, service  # noqa: E402

ADMIN_USER = os.environ.get("NOVAI_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("NOVAI_ADMIN_PASSWORD", "test-pass-123")
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


def unique_name(prefix: str = "asset") -> str:
    return (prefix + uuid.uuid4().hex[:10])[:32]


class A_AuthOffTest(unittest.TestCase):
    """auth 关闭：素材不校验，谁都能读。"""

    def setUp(self) -> None:
        set_auth(False)
        ratelimit.reset()

    def test_public_read_when_auth_off(self) -> None:
        folder = Path(main.ASSETS_DIR) / "users" / "999" / "input"
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / ("off-%s.png" % uuid.uuid4().hex[:8])
        target.write_bytes(PNG)
        response = fresh_client().get("/assets/users/999/input/%s" % target.name)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, PNG)


class B_AssetAclTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        set_auth(True)
        service.bootstrap_admin()

    def setUp(self) -> None:
        set_auth(True)
        asset_acl.clear_cache()
        ratelimit.reset()

    # ---------------------------------------------------------------- helpers
    def admin_client(self) -> TestClient:
        client = fresh_client()
        self.assertEqual(login(client, ADMIN_USER, ADMIN_PASS).status_code, 200)
        return client

    def make_user(self, admin: TestClient, prefix: str = "asset") -> tuple:
        issued = admin.post("/api/admin/invites", json={})
        self.assertEqual(issued.status_code, 200, issued.text)
        username = unique_name(prefix)
        client = fresh_client()
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "asset-pass-123",
            "invite_code": issued.json()["code"],
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client, registered.json()["user"]

    def upload(self, client: TestClient, marker: bytes) -> str:
        response = client.post(
            "/api/ai/upload",
            files=[("files", ("asset-%s.png" % uuid.uuid4().hex[:8], PNG + marker, "image/png"))],
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["files"][0]["url"]

    def make_canvas_with_asset(self, owner: TestClient, asset_url: str, title: str = "带图用的画布") -> str:
        canvas = owner.post("/api/canvases", json={"title": title}).json()["canvas"]
        payload = {
            "title": title,
            "nodes": [{"id": "n1", "type": "image", "images": [{"url": asset_url, "name": "x.png"}]}],
            "connections": [],
            "logs": [],
            "settings": {},
        }
        saved = owner.put("/api/canvases/%s" % canvas["id"], json=payload)
        self.assertEqual(saved.status_code, 200, saved.text)
        return canvas["id"]

    def share(self, owner: TestClient, canvas_id: str, username: str, role: str = "viewer") -> dict:
        response = owner.post("/api/canvases/%s/members" % canvas_id, json={"username": username, "role": role})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    # ---------------------------------------------------------------- cases
    def test_shared_canvas_asset_visible_to_members(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "ac-owner")
        viewer, viewer_user = self.make_user(admin, "ac-viewer")
        editor, editor_user = self.make_user(admin, "ac-editor")
        asset = self.upload(owner, b"a")
        canvas_id = self.make_canvas_with_asset(owner, asset)
        self.share(owner, canvas_id, viewer_user["username"], "viewer")
        self.share(owner, canvas_id, editor_user["username"], "editor")

        self.assertEqual(owner.get(asset).status_code, 200)
        self.assertEqual(viewer.get(asset).status_code, 200)
        self.assertEqual(editor.get(asset).status_code, 200)
        self.assertEqual(admin.get(asset).status_code, 200)
        # URL 带 query 仍按路径比较
        self.assertEqual(viewer.get(asset + "?v=123&x=1").status_code, 200)

    def test_unshared_and_unrelated_denied(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "ac-owner2")
        viewer, viewer_user = self.make_user(admin, "ac-viewer2")
        stranger, _stranger_user = self.make_user(admin, "ac-stranger")

        shared_asset = self.upload(owner, b"b")
        shared_canvas = self.make_canvas_with_asset(owner, shared_asset, "已共享")
        self.share(owner, shared_canvas, viewer_user["username"], "viewer")

        other_asset = self.upload(owner, b"c")
        self.make_canvas_with_asset(owner, other_asset, "未共享")

        self.assertEqual(viewer.get(shared_asset).status_code, 200)
        # 同一 owner 的另一个未共享画布里的图片：拒绝
        self.assertEqual(viewer.get(other_asset).status_code, 403)
        # 无关系用户：拒绝；匿名：401
        self.assertEqual(stranger.get(shared_asset).status_code, 403)
        self.assertEqual(fresh_client().get(shared_asset).status_code, 401)

    def test_asset_not_referenced_denied(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "ac-owner3")
        viewer, viewer_user = self.make_user(admin, "ac-viewer3")
        referenced = self.upload(owner, b"d")
        unreferenced = self.upload(owner, b"e")
        canvas_id = self.make_canvas_with_asset(owner, referenced)
        self.share(owner, canvas_id, viewer_user["username"], "viewer")
        self.assertEqual(viewer.get(referenced).status_code, 200)
        self.assertEqual(viewer.get(unreferenced).status_code, 403)

    def test_cache_and_membership_changes(self) -> None:
        self.assertGreaterEqual(asset_acl.ttl_seconds(), 30)
        self.assertLessEqual(asset_acl.ttl_seconds(), 60)

        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "ac-owner4")
        viewer, viewer_user = self.make_user(admin, "ac-viewer4")
        asset = self.upload(owner, b"f")
        canvas_id = self.make_canvas_with_asset(owner, asset)
        self.share(owner, canvas_id, viewer_user["username"], "viewer")
        self.assertEqual(viewer.get(asset).status_code, 200)

        # 移除成员：TTL 内仍可能命中旧缓存（这是缓存策略允许的），清缓存后立即 403
        row = next(m for m in owner.get("/api/canvases/%s/permissions" % canvas_id).json()["members"]
                   if m["username"] == viewer_user["username"])
        self.assertEqual(owner.delete("/api/canvases/%s/members/%d" % (canvas_id, row["user_id"])).status_code, 200)
        self.assertEqual(viewer.get(asset).status_code, 200)  # 缓存内允许
        asset_acl.clear_cache()
        self.assertEqual(viewer.get(asset).status_code, 403)

        # 重新加入：清缓存后恢复 200
        self.share(owner, canvas_id, viewer_user["username"], "editor")
        asset_acl.clear_cache()
        self.assertEqual(viewer.get(asset).status_code, 200)

        # 删除画布：清缓存后拒绝
        self.assertEqual(owner.delete("/api/canvases/%s" % canvas_id).status_code, 200)
        asset_acl.clear_cache()
        self.assertEqual(viewer.get(asset).status_code, 403)

    def test_auth_off_skips_check(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "ac-owner5")
        asset = self.upload(owner, b"g")
        self.make_canvas_with_asset(owner, asset)
        set_auth(False)
        try:
            self.assertEqual(fresh_client().get(asset).status_code, 200)
        finally:
            set_auth(True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
