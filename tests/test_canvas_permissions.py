#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M3 画布权限回归测试（owner / admin / editor / viewer + 共享列表 + 审计）。

跑法：
    venv/bin/python -m unittest tests.test_canvas_permissions -v
    venv/bin/python -m unittest tests.test_cloud_auth tests.test_cloud_isolation tests.test_canvas_permissions

注意：与其它 cloud 测试同进程运行时 main 会复用已加载的 DATA_DIR；
本文件所有用户都用唯一用户名，断言只针对自己创建的画布，不依赖空库。
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-canvas-perms-test-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)
os.environ.setdefault("NOVAI_ADMIN_USER", "admin")
os.environ.setdefault("NOVAI_ADMIN_PASSWORD", "test-pass-123")
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "5000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "5000"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.auth import ratelimit, service, store  # noqa: E402

ADMIN_USER = os.environ.get("NOVAI_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("NOVAI_ADMIN_PASSWORD", "test-pass-123")


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


def unique_name(prefix: str = "perm") -> str:
    return (prefix + uuid.uuid4().hex[:10])[:32]


class A_AuthOffTest(unittest.TestCase):
    """auth 关闭：不校验、不返回 access_role，权限接口不可用。"""

    def setUp(self) -> None:
        set_auth(False)
        ratelimit.reset()
        self.client = fresh_client()

    def test_canvas_untouched_without_auth(self) -> None:
        created = self.client.post("/api/canvases", json={"title": "auth-off-perm"})
        self.assertEqual(created.status_code, 200, created.text)
        canvas_id = created.json()["canvas"]["id"]

        listed = self.client.get("/api/canvases?scope=mine").json()["canvases"]
        row = next(item for item in listed if item["id"] == canvas_id)
        self.assertNotIn("access_role", row)
        self.assertNotIn("owner_username", row)

        self.assertEqual(self.client.get("/api/canvases/%s" % canvas_id).status_code, 200)
        self.assertEqual(self.client.put("/api/canvases/%s" % canvas_id, json={}).status_code, 200)
        self.assertEqual(self.client.get("/api/canvases/%s/permissions" % canvas_id).status_code, 403)
        self.assertEqual(
            self.client.post("/api/canvases/%s/members" % canvas_id, json={"username": "x", "role": "viewer"}).status_code,
            403,
        )


class B_CanvasPermissionTest(unittest.TestCase):
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
        response = login(client, ADMIN_USER, ADMIN_PASS)
        self.assertEqual(response.status_code, 200, response.text)
        return client

    def make_user(self, admin: TestClient, prefix: str = "perm") -> tuple:
        issued = admin.post("/api/admin/invites", json={})
        self.assertEqual(issued.status_code, 200, issued.text)
        username = unique_name(prefix)
        client = fresh_client()
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "perm-pass-123",
            "invite_code": issued.json()["code"],
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client, registered.json()["user"]

    def make_canvas(self, client: TestClient, title: str = "perm canvas") -> dict:
        response = client.post("/api/canvases", json={"title": title})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["canvas"]

    def add_member(self, owner: TestClient, canvas_id: str, username: str, role: str):
        return owner.post(
            "/api/canvases/%s/members" % canvas_id,
            json={"username": username, "role": role},
        )

    def permission_row(self, client: TestClient, canvas_id: str, username: str):
        permissions = client.get("/api/canvases/%s/permissions" % canvas_id)
        self.assertEqual(permissions.status_code, 200, permissions.text)
        return next((m for m in permissions.json()["members"] if m["username"] == username), None)

    # ---------------------------------------------------------------- viewer
    def test_viewer_can_open_but_not_write(self) -> None:
        admin = self.admin_client()
        owner, owner_user = self.make_user(admin, "viewowner")
        viewer, viewer_user = self.make_user(admin, "viewer")
        canvas = self.make_canvas(owner)

        shared = self.add_member(owner, canvas["id"], viewer_user["username"], "viewer")
        self.assertEqual(shared.status_code, 200, shared.text)

        listed = viewer.get("/api/canvases").json()["canvases"]
        row = next(item for item in listed if item["id"] == canvas["id"])
        self.assertEqual(row["access_role"], "viewer")
        self.assertEqual(row["owner_username"], owner_user["username"])

        shared_scope = viewer.get("/api/canvases?scope=shared").json()["canvases"]
        self.assertIn(canvas["id"], {item["id"] for item in shared_scope})
        mine_scope = viewer.get("/api/canvases?scope=mine").json()["canvases"]
        self.assertNotIn(canvas["id"], {item["id"] for item in mine_scope})

        self.assertEqual(viewer.get("/api/canvases/%s" % canvas["id"]).status_code, 200)
        self.assertEqual(viewer.get("/api/canvases/%s/meta" % canvas["id"]).status_code, 200)
        self.assertEqual(viewer.get("/api/canvases/%s/versions" % canvas["id"]).status_code, 200)
        self.assertEqual(viewer.put("/api/canvases/%s" % canvas["id"], json={}).status_code, 403)
        self.assertEqual(viewer.post("/api/canvases/%s/touch" % canvas["id"]).status_code, 403)
        self.assertEqual(viewer.post("/api/canvases/%s/meta" % canvas["id"], json={"title": "hijack"}).status_code, 403)
        self.assertEqual(viewer.delete("/api/canvases/%s" % canvas["id"]).status_code, 403)
        self.assertEqual(viewer.get("/api/canvases/%s/permissions" % canvas["id"]).json()["my_role"], "viewer")

    # ---------------------------------------------------------------- editor
    def test_editor_can_save_but_not_manage(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "editowner")
        editor, editor_user = self.make_user(admin, "editor")
        canvas = self.make_canvas(owner)
        self.assertEqual(self.add_member(owner, canvas["id"], editor_user["username"], "editor").status_code, 200)

        row = self.permission_row(owner, canvas["id"], editor_user["username"])
        self.assertEqual(row["role"], "editor")

        self.assertEqual(editor.put("/api/canvases/%s" % canvas["id"], json={"title": "edited"}).status_code, 200)
        self.assertEqual(editor.post("/api/canvases/%s/touch" % canvas["id"]).status_code, 200)
        # meta 非标题字段可改；重命名仍然只有 owner/admin
        self.assertEqual(editor.post("/api/canvases/%s/meta" % canvas["id"], json={"color": "#ff0000"}).status_code, 200)
        rename = editor.post("/api/canvases/%s/meta" % canvas["id"], json={"title": "renamed-by-editor"})
        self.assertEqual(rename.status_code, 403)
        self.assertEqual(editor.delete("/api/canvases/%s" % canvas["id"]).status_code, 403)
        self.assertEqual(editor.get("/api/canvases/%s/permissions" % canvas["id"]).json()["my_role"], "editor")
        # editor 不能改权限
        other = unique_name("nobody")
        self.assertEqual(self.add_member(editor, canvas["id"], other, "viewer").status_code, 403)

    # ---------------------------------------------------------------- 移除
    def test_removing_member_revokes_access(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "removeowner")
        viewer, viewer_user = self.make_user(admin, "removed")
        canvas = self.make_canvas(owner)
        self.assertEqual(self.add_member(owner, canvas["id"], viewer_user["username"], "viewer").status_code, 200)
        member = self.permission_row(owner, canvas["id"], viewer_user["username"])
        removed = owner.delete("/api/canvases/%s/members/%d" % (canvas["id"], member["user_id"]))
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertNotIn(canvas["id"], {item["id"] for item in viewer.get("/api/canvases").json()["canvases"]})
        self.assertEqual(viewer.get("/api/canvases/%s" % canvas["id"]).status_code, 403)
        self.assertEqual(viewer.get("/api/canvases/%s/permissions" % canvas["id"]).status_code, 403)

    # ---------------------------------------------------------------- 参数错误
    def test_member_validation_errors(self) -> None:
        admin = self.admin_client()
        owner, owner_user = self.make_user(admin, "valowner")
        target, target_user = self.make_user(admin, "valtarget")
        canvas = self.make_canvas(owner)
        canvas_id = canvas["id"]

        self.assertEqual(self.add_member(owner, canvas_id, "no-such-" + uuid.uuid4().hex[:6], "viewer").status_code, 404)
        self.assertEqual(self.add_member(owner, canvas_id, target_user["username"], "owner").status_code, 400)
        self.assertEqual(self.add_member(owner, canvas_id, owner_user["username"], "viewer").status_code, 409)
        self.assertEqual(self.add_member(owner, canvas_id, target_user["username"], "viewer").status_code, 200)
        self.assertEqual(self.add_member(owner, canvas_id, target_user["username"], "editor").status_code, 409)

        self.assertEqual(
            owner.patch("/api/canvases/%s/members/%d" % (canvas_id, 999999), json={"role": "editor"}).status_code,
            404,
        )
        self.assertEqual(
            owner.delete("/api/canvases/%s/members/%d" % (canvas_id, 999999)).status_code,
            404,
        )
        self.assertEqual(
            owner.patch("/api/canvases/%s/members/%d" % (canvas_id, target_user["id"]), json={"role": "root"}).status_code,
            400,
        )
        row = self.permission_row(owner, canvas_id, target_user["username"])
        self.assertEqual(row["role"], "viewer")
        self.assertEqual(
            owner.patch("/api/canvases/%s/members/%d" % (canvas_id, target_user["id"]), json={"role": "editor"}).status_code,
            200,
        )
        self.assertEqual(self.permission_row(owner, canvas_id, target_user["username"])["role"], "editor")

    # ---------------------------------------------------------------- 越权
    def test_unrelated_user_cannot_read_or_manage(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "strangerowner")
        viewer, viewer_user = self.make_user(admin, "strangerviewer")
        stranger, _stranger_user = self.make_user(admin, "stranger")
        canvas = self.make_canvas(owner)
        self.assertEqual(self.add_member(owner, canvas["id"], viewer_user["username"], "viewer").status_code, 200)
        member = self.permission_row(owner, canvas["id"], viewer_user["username"])

        self.assertEqual(stranger.get("/api/canvases/%s/permissions" % canvas["id"]).status_code, 403)
        self.assertEqual(self.add_member(stranger, canvas["id"], viewer_user["username"], "editor").status_code, 403)
        self.assertEqual(
            stranger.patch("/api/canvases/%s/members/%d" % (canvas["id"], member["user_id"]), json={"role": "editor"}).status_code,
            403,
        )
        self.assertEqual(stranger.delete("/api/canvases/%s/members/%d" % (canvas["id"], member["user_id"])).status_code, 403)

    # ---------------------------------------------------------------- admin
    def test_admin_can_manage_any_canvas(self) -> None:
        admin = self.admin_client()
        owner, owner_user = self.make_user(admin, "adminowner")
        member, member_user = self.make_user(admin, "adminmember")
        canvas = self.make_canvas(owner)
        self.assertEqual(self.add_member(owner, canvas["id"], member_user["username"], "viewer").status_code, 200)
        member_row = self.permission_row(owner, canvas["id"], member_user["username"])

        permissions = admin.get("/api/canvases/%s/permissions" % canvas["id"])
        self.assertEqual(permissions.status_code, 200)
        self.assertEqual(permissions.json()["my_role"], "admin")
        self.assertEqual(permissions.json()["owner"]["username"], owner_user["username"])

        self.assertEqual(
            admin.patch("/api/canvases/%s/members/%d" % (canvas["id"], member_row["user_id"]), json={"role": "editor"}).status_code,
            200,
        )
        self.assertEqual(self.permission_row(admin, canvas["id"], member_user["username"])["role"], "editor")

        admin_list = admin.get("/api/canvases?all=1").json()["canvases"]
        row = next(item for item in admin_list if item["id"] == canvas["id"])
        self.assertEqual(row["access_role"], "admin")
        self.assertEqual(row["owner_username"], owner_user["username"])

        self.assertEqual(admin.delete("/api/canvases/%s/members/%d" % (canvas["id"], member_row["user_id"])).status_code, 200)

    # ---------------------------------------------------------------- 列表 scope
    def test_scope_filters(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "scopeowner")
        other, other_user = self.make_user(admin, "scopeother")
        own_canvas = self.make_canvas(owner)
        shared_canvas = self.make_canvas(other)
        self.assertEqual(self.add_member(other, shared_canvas["id"], _owner_user["username"], "viewer").status_code, 200)

        ids_all = {item["id"] for item in owner.get("/api/canvases").json()["canvases"]}
        self.assertIn(own_canvas["id"], ids_all)
        self.assertIn(shared_canvas["id"], ids_all)
        self.assertNotIn(own_canvas["id"], {item["id"] for item in owner.get("/api/canvases?scope=shared").json()["canvases"]})
        self.assertIn(own_canvas["id"], {item["id"] for item in owner.get("/api/canvases?scope=mine").json()["canvases"]})
        self.assertIn(shared_canvas["id"], {item["id"] for item in owner.get("/api/canvases?scope=shared").json()["canvases"]})
        self.assertEqual(owner.get("/api/canvases?scope=invalid").status_code, 400)

    # ---------------------------------------------------------------- 审计
    def test_share_actions_are_audited(self) -> None:
        admin = self.admin_client()
        owner, _owner_user = self.make_user(admin, "auditowner")
        member, member_user = self.make_user(admin, "auditmember")
        canvas = self.make_canvas(owner)
        self.assertEqual(self.add_member(owner, canvas["id"], member_user["username"], "viewer").status_code, 200)
        row = self.permission_row(owner, canvas["id"], member_user["username"])
        owner.patch("/api/canvases/%s/members/%d" % (canvas["id"], row["user_id"]), json={"role": "editor"})
        owner.delete("/api/canvases/%s/members/%d" % (canvas["id"], row["user_id"]))

        entries = store.list_audit(limit=300)
        targets = {(entry["action"], entry["target"].split(":")[-1], entry["result"]) for entry in entries}
        for action in ("canvas_share_add", "canvas_share_update", "canvas_share_remove"):
            self.assertIn((action, member_user["username"], "ok"), targets)


if __name__ == "__main__":
    unittest.main(verbosity=2)
