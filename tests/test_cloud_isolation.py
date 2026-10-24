#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M2 用户管理 + 数据隔离回归测试。

跑法（必须用项目 venv）：
    venv/bin/python -m unittest tests.test_cloud_isolation -v

覆盖：
- auth-off：列表/上传与旧版一致（不写 owner_id、不过滤、落 assets/input）
- auth-on：画布列表/打开/保存/删除/回收站/版本按 owner 隔离，admin ?all=1 可见、可认领
- 素材：新上传落 assets/users/{uid}/，跨用户 403、admin 200、匿名 401
- 管理面：停用/启用、改角色、重置密码、非 admin 403、/admin 页面权限
- 审计：管理操作与认领都写 audit_log
"""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-cloud-iso-test-")
os.environ["NOVAI_DATA_DIR"] = _TMP_DATA
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)
os.environ["NOVAI_ADMIN_USER"] = "admin"
os.environ["NOVAI_ADMIN_PASSWORD"] = "test-pass-123"
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "5000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "5000"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.auth import ratelimit, service, store  # noqa: E402

ADMIN_USER = os.environ["NOVAI_ADMIN_USER"]
ADMIN_PASS = os.environ["NOVAI_ADMIN_PASSWORD"]
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def set_auth(enabled: bool) -> None:
    if enabled:
        os.environ["NOVAI_AUTH_ENABLED"] = "1"
        os.environ.pop("NOVAI_AUTH_DISABLED", None)
    else:
        os.environ.pop("NOVAI_AUTH_ENABLED", None)


def fresh_client() -> TestClient:
    return TestClient(main.app, client=("127.0.0.1", 50000), follow_redirects=False)


def login(client: TestClient, username: str, password: str):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def unique_name(prefix: str = "iso") -> str:
    return (prefix + uuid.uuid4().hex[:10])[:32]


class A_AuthOffTest(unittest.TestCase):
    """auth 关闭：行为必须与旧版一致。"""

    def setUp(self) -> None:
        set_auth(False)
        ratelimit.reset()
        self.client = fresh_client()

    def test_canvas_has_no_owner_and_list_is_global(self) -> None:
        first = self.client.post("/api/canvases", json={"title": "off-1"})
        self.assertEqual(first.status_code, 200, first.text)
        canvas = first.json()["canvas"]
        self.assertNotIn("owner_id", canvas)
        self.assertFalse(bool(canvas.get("owner_id")))
        second = self.client.post("/api/canvases", json={"title": "off-2"})
        self.assertEqual(second.status_code, 200)

        listed = self.client.get("/api/canvases").json()["canvases"]
        ids = {item["id"] for item in listed}
        self.assertIn(canvas["id"], ids)
        self.assertGreaterEqual(len(ids), 2)

        on_disk = json.loads((Path(main.CANVAS_DIR) / (canvas["id"] + ".json")).read_text(encoding="utf-8"))
        self.assertNotIn("owner_id", on_disk)
        self.assertEqual(self.client.get("/api/canvases/%s" % canvas["id"]).status_code, 200)

    def test_admin_page_absent_when_auth_off(self) -> None:
        self.assertEqual(self.client.get("/admin").status_code, 404)

    def test_upload_keeps_legacy_path(self) -> None:
        response = self.client.post(
            "/api/ai/upload",
            files=[("files", ("legacy.png", PNG_1PX, "image/png"))],
        )
        self.assertEqual(response.status_code, 200, response.text)
        url = response.json()["files"][0]["url"]
        self.assertTrue(url.startswith("/assets/input/"), url)
        fetched = self.client.get(url)
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.content, PNG_1PX)


class B_IsolationTest(unittest.TestCase):
    """auth 开启：画布/素材/管理面的隔离与权限。"""

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

    def make_user(self, admin: TestClient, prefix: str = "iso") -> tuple:
        issued = admin.post("/api/admin/invites", json={"uses": 1, "days": 7})
        self.assertEqual(issued.status_code, 200, issued.text)
        code = issued.json()["code"]
        username = unique_name(prefix)
        client = fresh_client()
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "isolation-pass-123",
            "invite_code": code,
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client, registered.json()["user"]

    def make_canvas(self, client: TestClient, title: str = "test") -> dict:
        response = client.post("/api/canvases", json={"title": title})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["canvas"]

    # ---------------------------------------------------------------- canvas
    def test_canvas_isolation_and_admin_claim(self) -> None:
        admin = self.admin_client()
        client_a, user_a = self.make_user(admin, "alice")
        client_b, user_b = self.make_user(admin, "bob")

        canvas = self.make_canvas(client_a, "A 的画布")
        self.assertEqual(int(canvas["owner_id"]), int(user_a["id"]))

        a_ids = {item["id"] for item in client_a.get("/api/canvases").json()["canvases"]}
        self.assertIn(canvas["id"], a_ids)
        b_ids = {item["id"] for item in client_b.get("/api/canvases").json()["canvases"]}
        self.assertNotIn(canvas["id"], b_ids)

        self.assertEqual(client_b.get("/api/canvases/%s" % canvas["id"]).status_code, 403)
        self.assertEqual(client_b.put("/api/canvases/%s" % canvas["id"], json={}).status_code, 403)
        self.assertEqual(client_b.delete("/api/canvases/%s" % canvas["id"]).status_code, 403)
        self.assertEqual(client_b.get("/api/canvases/%s/versions" % canvas["id"]).status_code, 403)
        self.assertEqual(client_b.post("/api/canvases/%s/meta" % canvas["id"], json={"title": "hijack"}).status_code, 403)

        # admin 默认可读全部（单条），但列表默认只看自己，?all=1 才全量
        self.assertEqual(admin.get("/api/canvases/%s" % canvas["id"]).status_code, 200)
        self.assertNotIn(canvas["id"], {item["id"] for item in admin.get("/api/canvases").json()["canvases"]})
        all_ids = {item["id"] for item in admin.get("/api/canvases?all=1").json()["canvases"]}
        self.assertIn(canvas["id"], all_ids)

        # 认领后 owner 变成 admin，原用户看不到
        claimed = admin.post("/api/canvases/%s/claim" % canvas["id"])
        self.assertEqual(claimed.status_code, 200, claimed.text)
        self.assertEqual(int(claimed.json()["canvas"]["owner_id"]), int(login(admin, ADMIN_USER, ADMIN_PASS).json()["user"]["id"]))
        self.assertNotIn(canvas["id"], {item["id"] for item in client_a.get("/api/canvases").json()["canvases"]})
        self.assertEqual(client_a.get("/api/canvases/%s" % canvas["id"]).status_code, 403)
        self.assertEqual(client_b.get("/api/canvases/%s" % canvas["id"]).status_code, 403)

    def test_trash_isolation(self) -> None:
        admin = self.admin_client()
        client_a, _user_a = self.make_user(admin, "trash")
        client_b, _user_b = self.make_user(admin, "trash")

        canvas = self.make_canvas(client_a, "回收站画布")
        self.assertEqual(client_a.delete("/api/canvases/%s" % canvas["id"]).status_code, 200)

        a_trash = {item["id"] for item in client_a.get("/api/canvases/trash").json()["canvases"]}
        self.assertIn(canvas["id"], a_trash)
        self.assertNotIn(canvas["id"], {item["id"] for item in client_b.get("/api/canvases/trash").json()["canvases"]})
        admin_trash = {item["id"] for item in admin.get("/api/canvases/trash?all=1").json()["canvases"]}
        self.assertIn(canvas["id"], admin_trash)
        self.assertEqual(client_b.post("/api/canvases/%s/restore" % canvas["id"]).status_code, 403)
        self.assertEqual(client_a.post("/api/canvases/%s/restore" % canvas["id"]).status_code, 200)

    # ---------------------------------------------------------------- assets
    def test_asset_isolation(self) -> None:
        admin = self.admin_client()
        client_a, user_a = self.make_user(admin, "asset")
        client_b, user_b = self.make_user(admin, "asset")

        uploaded = client_a.post("/api/ai/upload", files=[("files", ("a.png", PNG_1PX, "image/png"))])
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        url = uploaded.json()["files"][0]["url"]
        self.assertTrue(url.startswith("/assets/users/%d/input/" % int(user_a["id"])), url)

        rel = url[len("/assets/"):]
        path = Path(main.ASSETS_DIR) / rel
        self.assertTrue(path.is_file(), path)
        self.assertEqual(path.read_bytes(), PNG_1PX)

        self.assertEqual(client_a.get(url).status_code, 200)
        self.assertEqual(client_a.get(url).content, PNG_1PX)
        self.assertEqual(client_b.get(url).status_code, 403)
        self.assertEqual(admin.get(url).status_code, 200)
        self.assertEqual(fresh_client().get(url).status_code, 401)

        # 同一份字节由 B 再传：必须落 B 自己的目录，不能复用 A 的 URL
        uploaded_b = client_b.post("/api/ai/upload", files=[("files", ("b.png", PNG_1PX, "image/png"))])
        self.assertEqual(uploaded_b.status_code, 200, uploaded_b.text)
        url_b = uploaded_b.json()["files"][0]["url"]
        self.assertTrue(url_b.startswith("/assets/users/%d/input/" % int(user_b["id"])), url_b)
        self.assertNotEqual(url, url_b)
        self.assertEqual(client_b.get(url_b).status_code, 200)
        self.assertEqual(client_a.get(url_b).status_code, 403)

    def test_legacy_assets_stay_public_read(self) -> None:
        # 约定：不在 users/ 下的历史素材保持公共只读（理由见 server/auth/middleware.py 文档）
        legacy_dir = Path(main.ASSETS_DIR) / "input"
        legacy_dir.mkdir(parents=True, exist_ok=True)
        legacy = legacy_dir / "legacy_public.png"
        legacy.write_bytes(PNG_1PX)
        response = fresh_client().get("/assets/input/legacy_public.png")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, PNG_1PX)

    def test_generated_output_uses_tenant_dir(self) -> None:
        # 生成结果与上传共用 output_storage：绑定租户后必须落到 users/{uid}/output
        from server.auth import tenant

        token = tenant.bind_user({"id": 4242, "username": "tenant-probe"})
        try:
            output_path = main.output_path_for("probe.png", "output")
            output_url = main.output_url_for("probe.png", "output")
            input_path = main.output_path_for("probe.png", "input")
        finally:
            tenant.reset_user(token)
        self.assertEqual(output_url, "/assets/users/4242/output/probe.png")
        self.assertIn(str(Path("users") / "4242" / "output"), output_path)
        self.assertIn(str(Path("users") / "4242" / "input"), input_path)
        self.assertIsNone(tenant.current_user_id())

    # ---------------------------------------------------------------- admin
    def test_admin_page_and_permissions(self) -> None:
        admin = self.admin_client()
        client_b, _user_b = self.make_user(admin, "page")

        page = admin.get("/admin")
        self.assertEqual(page.status_code, 200, page.text)
        self.assertIn("管理后台", page.text)

        denied = client_b.get("/admin")
        self.assertEqual(denied.status_code, 302)
        self.assertIn("next=/admin", denied.headers["location"])

        anonymous = fresh_client().get("/admin")
        self.assertEqual(anonymous.status_code, 302)
        self.assertIn("/login", anonymous.headers["location"])
        self.assertEqual(client_b.get("/api/admin/users").status_code, 403)

    def test_admin_user_management(self) -> None:
        admin = self.admin_client()
        client_b, user_b = self.make_user(admin, "member")

        listed = admin.get("/api/admin/users")
        self.assertEqual(listed.status_code, 200)
        row = next(item for item in listed.json()["users"] if item["username"] == user_b["username"])
        self.assertEqual(row["canvas_count"], 0)
        self.assertIn("stats", listed.json())
        self.assertGreaterEqual(listed.json()["stats"]["users"], 2)

        # 停用：旧会话 401、重登 403；启用后恢复
        self.assertEqual(admin.post("/api/admin/users/%d/disable" % user_b["id"]).status_code, 200)
        self.assertEqual(client_b.get("/api/auth/me").status_code, 401)
        disabled_login = login(client_b, user_b["username"], "isolation-pass-123")
        self.assertEqual(disabled_login.status_code, 403)
        self.assertEqual(admin.post("/api/admin/users/%d/enable" % user_b["id"]).status_code, 200)
        self.assertEqual(login(client_b, user_b["username"], "isolation-pass-123").status_code, 200)

        # 改角色
        changed = admin.post("/api/admin/users/%d/role" % user_b["id"], json={"role": "team"})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()["user"]["role"], "team")
        self.assertEqual(client_b.get("/api/auth/me").json()["role"], "team")
        self.assertEqual(admin.post("/api/admin/users/%d/role" % user_b["id"], json={"role": "root"}).status_code, 400)

        # 管理员不能降自己的权
        me = login(fresh_client(), ADMIN_USER, ADMIN_PASS).json()["user"]
        self.assertEqual(admin.post("/api/admin/users/%d/role" % me["id"], json={"role": "user"}).status_code, 400)

        # 重置密码：旧密码失效、临时密码可登录
        reset = admin.post("/api/admin/users/%d/reset-password" % user_b["id"])
        self.assertEqual(reset.status_code, 200, reset.text)
        temp = reset.json()["temp_password"]
        self.assertGreaterEqual(len(temp), 8)
        self.assertEqual(login(fresh_client(), user_b["username"], "isolation-pass-123").status_code, 401)
        self.assertEqual(login(fresh_client(), user_b["username"], temp).status_code, 200)

        # 邀请码参数校验
        self.assertEqual(admin.post("/api/admin/invites", json={"uses": 0}).status_code, 422)
        self.assertEqual(admin.post("/api/admin/invites", json={"days": 99999}).status_code, 422)
        self.assertEqual(admin.post("/api/admin/invites", json={"role": "root"}).status_code, 400)

    def test_canvas_count_in_admin_list(self) -> None:
        admin = self.admin_client()
        client_c, user_c = self.make_user(admin, "count")
        self.make_canvas(client_c, "C 的画布")
        users = admin.get("/api/admin/users").json()["users"]
        row = next(item for item in users if item["username"] == user_c["username"])
        self.assertEqual(row["canvas_count"], 1)

    def test_audit_log_records_admin_actions(self) -> None:
        admin = self.admin_client()
        client_x, user_x = self.make_user(admin, "audit")
        # 先建画布再动账号：停用/重置会作废会话
        canvas = self.make_canvas(client_x, "待认领")
        claim = admin.post("/api/canvases/%s/claim" % canvas["id"])
        self.assertEqual(claim.status_code, 200, claim.text)

        issued = admin.post("/api/admin/invites", json={})
        self.assertEqual(issued.status_code, 200)
        code = issued.json()["code"]
        admin.post("/api/admin/invites/%s/disable" % code)
        admin.post("/api/admin/users/%d/disable" % user_x["id"])
        admin.post("/api/admin/users/%d/enable" % user_x["id"])
        admin.post("/api/admin/users/%d/role" % user_x["id"], json={"role": "team"})
        admin.post("/api/admin/users/%d/reset-password" % user_x["id"])

        entries = store.list_audit(limit=200)
        actions = {(row["action"], row["target"], row["result"], row["actor"]) for row in entries}
        for action in ("invite_create", "invite_disable", "user_disable", "user_enable", "user_role", "user_reset_password"):
            self.assertTrue(any(item[0] == action and item[2] == "ok" for item in actions), action)
        self.assertIn(("canvas_claim", canvas["id"], "ok", ADMIN_USER), actions)
        # 管理操作的操作者必须是 admin；自助改密码等用户操作不在此断言内
        admin_actions = [row for row in entries if row["action"] in (
            "invite_create", "invite_disable", "user_disable", "user_enable",
            "user_role", "user_reset_password", "canvas_claim",
        )]
        self.assertTrue(admin_actions)
        self.assertTrue(all(row["actor"] == ADMIN_USER for row in admin_actions))


if __name__ == "__main__":
    unittest.main(verbosity=2)
