#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""邀请制登录（M1）回归测试：默认关闭不拦、开启后鉴权 / 6 位邀请码 / 限流 / 管理面。

跑法（必须用项目 venv，系统 python 没有 fastapi）：
    venv/bin/python -m unittest tests.test_cloud_auth -v

设计说明：
- 直接 import main，用真实 app 的中间件与路由；NOVAI_AUTH_ENABLED 是每次请求动态读取的，
  所以同一个进程里能在“关闭”和“开启”两种模式之间切换（关闭态用例先跑）。
- DATA_DIR 指向临时目录，不碰本地 data/users.db。
"""
from __future__ import annotations

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

_TMP_DATA = tempfile.mkdtemp(prefix="novai-cloud-auth-test-")
os.environ["NOVAI_DATA_DIR"] = _TMP_DATA
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)
os.environ["NOVAI_ADMIN_USER"] = "admin"
os.environ["NOVAI_ADMIN_PASSWORD"] = "test-pass-123"
# 默认放宽，避免正常用例互相挤占；限流用例自己调小再恢复
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "1000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "1000"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.auth import passwords, ratelimit, service, store  # noqa: E402

ADMIN_USER = os.environ["NOVAI_ADMIN_USER"]
ADMIN_PASS = os.environ["NOVAI_ADMIN_PASSWORD"]
CODE_RE = re.compile(r"^\d{6}$")


def set_auth(enabled: bool) -> None:
    if enabled:
        os.environ["NOVAI_AUTH_ENABLED"] = "1"
        os.environ.pop("NOVAI_AUTH_DISABLED", None)
    else:
        os.environ.pop("NOVAI_AUTH_ENABLED", None)


def unique_name(prefix: str = "u") -> str:
    return (prefix + uuid.uuid4().hex[:12])[:32]


def fresh_client(ip: str = "127.0.0.1") -> TestClient:
    # 每个 client 独立 cookie jar（会话隔离）；ip 用于限流用例区分来源
    return TestClient(main.app, client=(ip, 50000), follow_redirects=False)


def login(client: TestClient, username: str, password: str):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def create_invite_via_admin(client: TestClient, **payload):
    return client.post("/api/admin/invites", json=payload)


def register(client: TestClient, username: str, password: str, code: str):
    return client.post(
        "/api/auth/register",
        json={"username": username, "password": password, "invite_code": code},
    )


class A_DefaultOffTest(unittest.TestCase):
    """auth 默认关闭：本地桌面版不能被拦截。"""

    def setUp(self) -> None:
        set_auth(False)
        ratelimit.reset()

    def test_page_not_redirected(self) -> None:
        client = fresh_client("127.0.0.1")
        response = client.get("/", headers={"accept": "text/html"})
        self.assertEqual(response.status_code, 200)

    def test_api_not_guarded(self) -> None:
        client = fresh_client("127.0.0.1")
        me = client.get("/api/auth/me")
        self.assertEqual(me.status_code, 200)
        self.assertFalse(me.json().get("auth_enabled"))
        self.assertNotEqual(client.get("/api/canvases").status_code, 401)

    def test_login_page_served(self) -> None:
        client = fresh_client("127.0.0.1")
        response = client.get("/login")
        self.assertEqual(response.status_code, 200)
        self.assertIn("NOVAI", response.text)


class B_AuthEnabledTest(unittest.TestCase):
    """开启后：401/302、6 位码注册、登录/登出/me、邀请码与用户管理。"""

    @classmethod
    def setUpClass(cls) -> None:
        set_auth(True)
        service.bootstrap_admin()

    def setUp(self) -> None:
        set_auth(True)
        ratelimit.reset()

    def admin_client(self) -> TestClient:
        client = fresh_client("127.0.0.1")
        response = login(client, ADMIN_USER, ADMIN_PASS)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["user"]["role"], "admin")
        return client

    def register_user(self, client: TestClient, admin: TestClient, ip: str = "127.0.0.1", **invite) -> str:
        issued = create_invite_via_admin(admin, **invite)
        self.assertEqual(issued.status_code, 200, issued.text)
        code = issued.json()["code"]
        username = unique_name("member")
        response = register(client, username, "member-pass-123", code)
        self.assertEqual(response.status_code, 200, response.text)
        return username

    def test_unauthorized_api_401(self) -> None:
        client = fresh_client("127.0.0.1")
        response = client.get("/api/canvases")
        self.assertEqual(response.status_code, 401)
        body = response.json()
        self.assertEqual(body.get("code"), "unauthorized")
        self.assertIn("detail", body)

    def test_page_redirects_to_login(self) -> None:
        client = fresh_client("127.0.0.1")
        response = client.get("/", headers={"accept": "text/html"})
        self.assertEqual(response.status_code, 302)
        self.assertTrue(response.headers["location"].startswith("/login"))
        page = client.get("/some-page.html", headers={"accept": "text/html"})
        self.assertEqual(page.status_code, 302)
        # 登录成功后要能跳回原地址
        self.assertIn("next=/some-page.html", page.headers["location"])
        static = client.get("/static/login.html")
        self.assertEqual(static.status_code, 200)

    def test_six_digit_invite_and_register(self) -> None:
        admin = self.admin_client()
        codes = []
        for _ in range(3):
            issued = create_invite_via_admin(admin)
            self.assertEqual(issued.status_code, 200, issued.text)
            code = issued.json()["code"]
            self.assertRegex(code, CODE_RE)
            codes.append(code)
        self.assertEqual(len(set(codes)), 3)

        client = fresh_client("127.0.0.1")
        username = unique_name("six")
        response = register(client, username, "member-pass-123", codes[0])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["user"]["username"], username)
        self.assertEqual(response.json()["user"]["role"], "user")

        me = client.get("/api/auth/me")
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["username"], username)

        # 一次一码：同一码第二次注册必须失败
        second = register(fresh_client("127.0.0.1"), unique_name("six2"), "member-pass-123", codes[0])
        self.assertEqual(second.status_code, 400)
        self.assertEqual(second.json()["code"], "invite_exhausted")

    def test_expired_invite_rejected(self) -> None:
        admin = self.admin_client()
        issued = create_invite_via_admin(admin, days=0)
        self.assertEqual(issued.status_code, 200, issued.text)
        response = register(fresh_client("127.0.0.1"), unique_name("exp"), "member-pass-123", issued.json()["code"])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "invite_expired")

    def test_disabled_invite_rejected(self) -> None:
        admin = self.admin_client()
        issued = create_invite_via_admin(admin)
        self.assertEqual(issued.status_code, 200, issued.text)
        code = issued.json()["code"]
        disabled = admin.post("/api/admin/invites/%s/disable" % code)
        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertTrue(disabled.json()["ok"])
        self.assertEqual(disabled.json()["invite"]["status"], "disabled")

        listed = admin.get("/api/admin/invites").json()["invites"]
        row = next(item for item in listed if item["code"] == code)
        self.assertEqual(row["status"], "disabled")

        response = register(fresh_client("127.0.0.1"), unique_name("dis"), "member-pass-123", code)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "invite_disabled")

    def test_legacy_invite_code_readable(self) -> None:
        legacy = "NOVAI-ABCD-EFGH-JKLM"
        store.insert_invite(legacy, "user", 1, int(time.time()) + 3600, "legacy-test")
        response = register(fresh_client("127.0.0.1"), unique_name("legacy"), "member-pass-123", legacy.lower())
        self.assertEqual(response.status_code, 200, response.text)

    def test_register_rate_limited_429(self) -> None:
        os.environ["NOVAI_REGISTER_IP_LIMIT"] = "2"
        try:
            ratelimit.reset()
            client = fresh_client("127.0.0.7")
            for index in range(2):
                response = register(client, unique_name("enum"), "member-pass-123", "12345%d" % index)
                self.assertEqual(response.status_code, 400, response.text)
            blocked = register(client, unique_name("enum"), "member-pass-123", "999999")
            self.assertEqual(blocked.status_code, 429, blocked.text)
            self.assertEqual(blocked.json()["code"], "rate_limited")
        finally:
            os.environ["NOVAI_REGISTER_IP_LIMIT"] = "1000"
            ratelimit.reset()

    def test_register_global_rate_limit_429(self) -> None:
        os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "1"
        try:
            ratelimit.reset()
            first = register(fresh_client("127.0.0.8"), unique_name("glob"), "member-pass-123", "111111")
            self.assertEqual(first.status_code, 400, first.text)
            second = register(fresh_client("127.0.0.9"), unique_name("glob"), "member-pass-123", "222222")
            self.assertEqual(second.status_code, 429, second.text)
            self.assertEqual(second.json()["code"], "rate_limited")
        finally:
            os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "1000"
            ratelimit.reset()

    def test_login_logout_me(self) -> None:
        admin = self.admin_client()
        client = fresh_client("127.0.0.1")
        username = self.register_user(client, admin)
        client.post("/api/auth/logout")

        bad = login(client, username, "wrong-password")
        self.assertEqual(bad.status_code, 401)
        self.assertEqual(bad.json()["code"], "bad_credentials")

        ok = login(client, username, "member-pass-123")
        self.assertEqual(ok.status_code, 200, ok.text)
        me = client.get("/api/auth/me")
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["username"], username)

        logout = client.post("/api/auth/logout")
        self.assertEqual(logout.status_code, 200)
        self.assertEqual(client.get("/api/auth/me").status_code, 401)

    def test_change_password_requires_login(self) -> None:
        response = fresh_client("127.0.0.1").post(
            "/api/auth/password",
            json={"old_password": "whatever-123", "new_password": "another-pass-123"},
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "unauthorized")

    def test_change_password_wrong_old_and_weak_new_rejected(self) -> None:
        admin = self.admin_client()
        client = fresh_client("127.0.0.1")
        self.register_user(client, admin)

        wrong_old = client.post(
            "/api/auth/password",
            json={"old_password": "not-the-password", "new_password": "brand-new-pass-123"},
        )
        self.assertEqual(wrong_old.status_code, 400)
        self.assertEqual(wrong_old.json()["code"], "bad_credentials")

        weak = client.post(
            "/api/auth/password",
            json={"old_password": "member-pass-123", "new_password": "short"},
        )
        self.assertEqual(weak.status_code, 400)
        self.assertIn(weak.json()["code"], ("invalid_password", "weak_password"))
        # 失败不影响当前会话
        self.assertEqual(client.get("/api/auth/me").status_code, 200)

    def test_change_password_updates_and_kicks_other_sessions(self) -> None:
        admin = self.admin_client()
        current = fresh_client("127.0.0.1")
        username = self.register_user(current, admin)

        other = fresh_client("127.0.0.1")
        self.assertEqual(login(other, username, "member-pass-123").status_code, 200)
        self.assertEqual(other.get("/api/auth/me").status_code, 200)

        changed = current.post(
            "/api/auth/password",
            json={"old_password": "member-pass-123", "new_password": "member-pass-456"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertTrue(changed.json()["ok"])

        # 当前会话保留；其它会话立刻失效
        self.assertEqual(current.get("/api/auth/me").status_code, 200)
        self.assertEqual(other.get("/api/auth/me").status_code, 401)

        self.assertEqual(login(fresh_client("127.0.0.1"), username, "member-pass-123").status_code, 401)
        self.assertEqual(login(fresh_client("127.0.0.1"), username, "member-pass-456").status_code, 200)

    def test_change_password_is_audited(self) -> None:
        admin = self.admin_client()
        client = fresh_client("127.0.0.1")
        username = self.register_user(client, admin)
        client.post(
            "/api/auth/password",
            json={"old_password": "member-pass-123", "new_password": "member-pass-456"},
        )
        entries = store.list_audit(limit=200)
        matched = [
            row for row in entries
            if row["action"] == "user_change_password" and row["target"] == username
        ]
        self.assertTrue(matched, "缺少改密码审计记录")
        self.assertTrue(any(row["result"] == "ok" and row["actor"] == username for row in matched))

    def test_admin_requires_admin_role(self) -> None:
        admin = self.admin_client()
        member = fresh_client("127.0.0.1")
        self.register_user(member, admin)
        forbidden = member.get("/api/admin/users")
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(forbidden.json()["code"], "forbidden")

    def test_admin_list_and_disable_user(self) -> None:
        admin = self.admin_client()
        member = fresh_client("127.0.0.1")
        username = self.register_user(member, admin)

        users = admin.get("/api/admin/users")
        self.assertEqual(users.status_code, 200)
        row = next(item for item in users.json()["users"] if item["username"] == username)
        self.assertEqual(row["status"], "active")

        disabled = admin.post("/api/admin/users/%d/disable" % row["id"])
        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertEqual(disabled.json()["user"]["status"], "disabled")

        # 停用立刻生效：旧会话 401，重新登录 403
        self.assertEqual(member.get("/api/auth/me").status_code, 401)
        relogin = login(member, username, "member-pass-123")
        self.assertEqual(relogin.status_code, 403)
        self.assertEqual(relogin.json()["code"], "user_disabled")

        # 管理员不能停用自己（否则会把自己锁在门外）
        admin_id = login(fresh_client("127.0.0.1"), ADMIN_USER, ADMIN_PASS).json()["user"]["id"]
        mine = admin.post("/api/admin/users/%d/disable" % admin_id)
        self.assertEqual(mine.status_code, 400)
        self.assertEqual(mine.json()["code"], "cannot_disable_self")

    def test_admin_cannot_create_invite_when_logged_out(self) -> None:
        response = fresh_client("127.0.0.1").post("/api/admin/invites", json={})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json().get("code"), "unauthorized")


class C_ResetCodeTest(unittest.TestCase):
    """重置码：生成 6 位/15 分钟、一次性、作废旧码、过期、错误码、限流、审计。"""

    @classmethod
    def setUpClass(cls) -> None:
        set_auth(True)
        service.bootstrap_admin()

    def setUp(self) -> None:
        set_auth(True)
        ratelimit.reset()
        self.admin = self.admin_client()

    def admin_client(self) -> TestClient:
        client = fresh_client("127.0.0.1")
        response = login(client, ADMIN_USER, ADMIN_PASS)
        self.assertEqual(response.status_code, 200, response.text)
        return client

    def make_member(self, prefix: str = "rst") -> tuple:
        client = fresh_client("127.0.0.1")
        issued = self.admin.post("/api/admin/invites", json={})
        self.assertEqual(issued.status_code, 200, issued.text)
        username = unique_name(prefix)
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "member-pass-123",
            "invite_code": issued.json()["code"],
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client, username, registered.json()["user"]

    def generate_code(self, user_id) -> dict:
        response = self.admin.post("/api/admin/users/%d/reset-code" % int(user_id))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def reset_with_code(self, username, code, new_password: str = "reset-pass-123", ip: str = "127.0.0.1"):
        return fresh_client(ip).post("/api/auth/reset-password", json={
            "username": username,
            "code": code,
            "new_password": new_password,
        })

    def test_generate_returns_six_digit_code_with_ttl_and_only_hash(self) -> None:
        _client, _username, user = self.make_member()
        body = self.generate_code(user["id"])
        self.assertRegex(body["code"], CODE_RE)
        self.assertEqual(int(body["user"]["id"]), int(user["id"]))
        delta = int(body["expires_at"]) - int(time.time())
        self.assertGreaterEqual(delta, service.RESET_CODE_TTL_SECONDS - 60)
        self.assertLessEqual(delta, service.RESET_CODE_TTL_SECONDS)
        # 库里只存哈希：明文不能落库
        record = store.get_reset_code(int(user["id"]))
        self.assertIsNotNone(record)
        self.assertNotEqual(record["code_hash"], body["code"])
        self.assertTrue(str(record["code_hash"]).startswith("scrypt$"))

    def test_regenerate_invalidates_old_code(self) -> None:
        _client, username, user = self.make_member()
        first = self.generate_code(user["id"])["code"]
        second = first
        for _ in range(5):
            second = self.generate_code(user["id"])["code"]
            if second != first:
                break
        self.assertNotEqual(first, second)

        old = self.reset_with_code(username, first)
        self.assertEqual(old.status_code, 400, old.text)
        self.assertEqual(old.json()["code"], "invalid_reset_code")

        ok = self.reset_with_code(username, second)
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertTrue(ok.json()["ok"])

    def test_use_resets_password_and_kicks_all_sessions(self) -> None:
        client, username, user = self.make_member()
        other = fresh_client("127.0.0.1")
        self.assertEqual(login(other, username, "member-pass-123").status_code, 200)
        code = self.generate_code(user["id"])["code"]

        ok = self.reset_with_code(username, code, new_password="reset-pass-123")
        self.assertEqual(ok.status_code, 200, ok.text)

        self.assertEqual(login(fresh_client("127.0.0.1"), username, "member-pass-123").status_code, 401)
        self.assertEqual(login(fresh_client("127.0.0.1"), username, "reset-pass-123").status_code, 200)
        # 重置成功后该用户所有旧会话失效
        self.assertEqual(client.get("/api/auth/me").status_code, 401)
        self.assertEqual(other.get("/api/auth/me").status_code, 401)

        # 一次性：同一个码不能再用
        again = self.reset_with_code(username, code, new_password="another-pass-123")
        self.assertEqual(again.status_code, 400, again.text)
        self.assertEqual(again.json()["code"], "invalid_reset_code")

    def test_expired_code_rejected(self) -> None:
        _client, username, user = self.make_member()
        now = int(time.time())
        store.set_reset_code(int(user["id"]), passwords.hash_password("123456"), now - 1, now - 901)
        response = self.reset_with_code(username, "123456")
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["code"], "reset_code_expired")

    def test_wrong_code_unknown_user_and_weak_password(self) -> None:
        _client, username, user = self.make_member()
        code = self.generate_code(user["id"])["code"]
        wrong = "000000" if code != "000000" else "111111"

        bad_code = self.reset_with_code(username, wrong)
        self.assertEqual(bad_code.status_code, 400, bad_code.text)
        self.assertEqual(bad_code.json()["code"], "invalid_reset_code")

        # 未知用户不能暴露账号是否存在：与错误码同一个 400
        ghost = self.reset_with_code(unique_name("ghost"), "123456")
        self.assertEqual(ghost.status_code, 400, ghost.text)
        self.assertEqual(ghost.json()["code"], "invalid_reset_code")

        weak = self.reset_with_code(username, code, new_password="short")
        self.assertEqual(weak.status_code, 400, weak.text)
        self.assertEqual(weak.json()["code"], "invalid_password")

    def test_reset_code_rate_limited_429(self) -> None:
        os.environ["NOVAI_RESET_IP_LIMIT"] = "2"
        try:
            ratelimit.reset()
            _client, username, _user = self.make_member()
            ip = "127.0.0.31"
            for _ in range(2):
                response = self.reset_with_code(username, "123456", ip=ip)
                self.assertEqual(response.status_code, 400, response.text)
            blocked = self.reset_with_code(username, "123456", ip=ip)
            self.assertEqual(blocked.status_code, 429, blocked.text)
            self.assertEqual(blocked.json()["code"], "rate_limited")
        finally:
            os.environ["NOVAI_RESET_IP_LIMIT"] = "10"
            ratelimit.reset()

    def test_temp_password_reset_invalidates_pending_code(self) -> None:
        _client, username, user = self.make_member()
        code = self.generate_code(user["id"])["code"]
        temp = self.admin.post("/api/admin/users/%d/reset-password" % int(user["id"]))
        self.assertEqual(temp.status_code, 200, temp.text)
        self.assertGreaterEqual(len(temp.json()["temp_password"]), 8)
        # 管理员已经发了临时密码：未用的重置码必须一起作废，避免两条后门同时有效
        response = self.reset_with_code(username, code)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["code"], "invalid_reset_code")

    def test_reset_code_requires_admin(self) -> None:
        member, _username, user = self.make_member()
        self.assertEqual(member.post("/api/admin/users/%d/reset-code" % int(user["id"])).status_code, 403)
        self.assertEqual(fresh_client("127.0.0.1").post("/api/admin/users/%d/reset-code" % int(user["id"])).status_code, 401)
        self.assertEqual(self.admin.post("/api/admin/users/999999/reset-code").status_code, 404)

    def test_reset_code_is_audited(self) -> None:
        client, username, user = self.make_member()
        code = self.generate_code(user["id"])["code"]
        self.reset_with_code(username, code)

        entries = store.list_audit(limit=200)
        generated = [row for row in entries if row["action"] == "user_reset_code" and row["target"] == username]
        self.assertTrue(generated, "缺少生成重置码审计")
        self.assertTrue(any(row["result"] == "ok" and row["actor"] == ADMIN_USER for row in generated))

        used = [row for row in entries if row["action"] == "user_reset_code_use" and row["target"] == username]
        self.assertTrue(used, "缺少使用重置码审计")
        self.assertTrue(any(row["result"] == "ok" and row["actor"] == username for row in used))

        failed = self.reset_with_code(username, code)
        self.assertEqual(failed.status_code, 400)
        entries = store.list_audit(limit=200)
        errors = [row for row in entries if row["action"] == "user_reset_code_use" and row["target"] == username and row["result"] == "error"]
        self.assertTrue(errors, "缺少重置码失败审计")


class D_UsernameTest(unittest.TestCase):
    """自助改用户名：唯一 / 格式 / 密码校验 / 审计 / 登录生效。"""

    @classmethod
    def setUpClass(cls) -> None:
        set_auth(True)
        service.bootstrap_admin()

    def setUp(self) -> None:
        set_auth(True)
        ratelimit.reset()
        self.admin = self.admin_client()

    def admin_client(self) -> TestClient:
        client = fresh_client("127.0.0.1")
        response = login(client, ADMIN_USER, ADMIN_PASS)
        self.assertEqual(response.status_code, 200, response.text)
        return client

    def make_member(self, prefix: str = "name") -> tuple:
        client = fresh_client("127.0.0.1")
        issued = self.admin.post("/api/admin/invites", json={})
        self.assertEqual(issued.status_code, 200, issued.text)
        username = unique_name(prefix)
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "member-pass-123",
            "invite_code": issued.json()["code"],
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client, username, registered.json()["user"]

    def change_username(self, client: TestClient, new_username: str, password: str = "member-pass-123"):
        return client.post("/api/auth/username", json={"new_username": new_username, "password": password})

    def test_change_username_success_and_login_with_new_name(self) -> None:
        client, username, _user = self.make_member()
        new_name = unique_name("renamed")
        response = self.change_username(client, new_name)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(response.json()["user"]["username"], new_name)
        self.assertEqual(client.get("/api/auth/me").json()["username"], new_name)

        self.assertEqual(login(fresh_client("127.0.0.1"), username, "member-pass-123").status_code, 401)
        self.assertEqual(login(fresh_client("127.0.0.1"), new_name, "member-pass-123").status_code, 200)

        entries = store.list_audit(limit=200)
        matched = [row for row in entries if row["action"] == "user_change_username" and row["target"] == new_name]
        self.assertTrue(matched, "缺少改用户名审计")
        self.assertTrue(any(row["result"] == "ok" and row["actor"] == username for row in matched))

    def test_change_username_duplicate_rejected(self) -> None:
        _client_a, _username_a, _user_a = self.make_member("dupa")
        client_b, _username_b, _user_b = self.make_member("dupb")
        taken = _username_a
        response = self.change_username(client_b, taken)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["code"], "username_taken")
        # 失败不改任何东西
        self.assertEqual(client_b.get("/api/auth/me").json()["username"], _username_b)

    def test_change_username_invalid_format_rejected(self) -> None:
        client, username, _user = self.make_member()
        for bad in ("ab", "has space", "a" * 33):
            response = self.change_username(client, bad)
            self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(response.json()["code"], "invalid_username", bad)
        self.assertEqual(client.get("/api/auth/me").json()["username"], username)

    def test_change_username_wrong_password_rejected(self) -> None:
        client, username, _user = self.make_member()
        response = self.change_username(client, unique_name("other"), password="not-the-password")
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["code"], "bad_credentials")
        self.assertEqual(client.get("/api/auth/me").json()["username"], username)

    def test_change_username_requires_login(self) -> None:
        response = fresh_client("127.0.0.1").post("/api/auth/username", json={
            "new_username": unique_name("anon"),
            "password": "whatever-123",
        })
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["code"], "unauthorized")


class E_AccountPageTest(unittest.TestCase):
    """我的账户页 / 重置页：页面可达性、账户数据（注册时间/画布数）。"""

    @classmethod
    def setUpClass(cls) -> None:
        set_auth(True)
        service.bootstrap_admin()

    def setUp(self) -> None:
        set_auth(True)
        ratelimit.reset()
        self.admin = self.admin_client()

    def admin_client(self) -> TestClient:
        client = fresh_client("127.0.0.1")
        response = login(client, ADMIN_USER, ADMIN_PASS)
        self.assertEqual(response.status_code, 200, response.text)
        return client

    def make_member(self, prefix: str = "acct") -> tuple:
        client = fresh_client("127.0.0.1")
        issued = self.admin.post("/api/admin/invites", json={})
        self.assertEqual(issued.status_code, 200, issued.text)
        username = unique_name(prefix)
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "member-pass-123",
            "invite_code": issued.json()["code"],
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client, username, registered.json()["user"]

    def test_anonymous_account_redirects_to_login(self) -> None:
        response = fresh_client("127.0.0.1").get("/account", headers={"accept": "text/html"})
        self.assertEqual(response.status_code, 302)
        self.assertIn("/login", response.headers["location"])
        self.assertIn("next=/account", response.headers["location"])

    def test_account_page_served_for_logged_in_user(self) -> None:
        client, _username, _user = self.make_member()
        response = client.get("/account", headers={"accept": "text/html"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("我的账户", response.text)
        self.assertIn("修改用户名", response.text)
        self.assertIn("修改密码", response.text)

    def test_account_api_has_created_at_and_canvas_count(self) -> None:
        client, username, user = self.make_member()
        empty = client.get("/api/auth/account")
        self.assertEqual(empty.status_code, 200, empty.text)
        body = empty.json()
        self.assertEqual(body["user"]["username"], username)
        self.assertEqual(int(body["user"]["id"]), int(user["id"]))
        self.assertGreater(int(body["user"]["created_at"]), 0)
        self.assertEqual(body["canvas_count"], 0)

        created = client.post("/api/canvases", json={"title": "账户页计数"})
        self.assertEqual(created.status_code, 200, created.text)
        counted = client.get("/api/auth/account").json()
        self.assertEqual(counted["canvas_count"], 1)

    def test_reset_page_is_public_and_explains_invite_flow(self) -> None:
        response = fresh_client("127.0.0.1").get("/reset", headers={"accept": "text/html"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("重置码", response.text)
        self.assertIn("向管理员索取", response.text)


class F_AuthOffPagesTest(unittest.TestCase):
    """auth 关闭：新页面全部不存在，新接口一律 auth_disabled。"""

    def setUp(self) -> None:
        set_auth(False)
        ratelimit.reset()

    def test_account_and_reset_pages_absent(self) -> None:
        client = fresh_client("127.0.0.1")
        self.assertEqual(client.get("/account", headers={"accept": "text/html"}).status_code, 404)
        self.assertEqual(client.get("/reset", headers={"accept": "text/html"}).status_code, 404)

    def test_new_auth_apis_disabled(self) -> None:
        client = fresh_client("127.0.0.1")
        reset = client.post("/api/auth/reset-password", json={
            "username": "anyone",
            "code": "123456",
            "new_password": "whatever-pass-123",
        })
        self.assertEqual(reset.status_code, 403)
        self.assertEqual(reset.json()["code"], "auth_disabled")

        username = client.post("/api/auth/username", json={"new_username": "anyone", "password": "whatever-pass-123"})
        self.assertEqual(username.status_code, 403)
        self.assertEqual(username.json()["code"], "auth_disabled")

        account = client.get("/api/auth/account")
        self.assertEqual(account.status_code, 403)
        self.assertEqual(account.json()["code"], "auth_disabled")


class G_PageDetectionTest(unittest.TestCase):
    """页面 vs 接口判定：HTML 页面未登录 302，/api/* 未登录 401 JSON。

    回归点：/account 曾因 Accept 里没有 text/html（curl、内嵌 WebView、会话过期后的 fetch）
    落进 API 分支，用户看到一坨 401 JSON 而不是登录页。
    """

    @classmethod
    def setUpClass(cls) -> None:
        set_auth(True)
        service.bootstrap_admin()

    def setUp(self) -> None:
        set_auth(True)
        ratelimit.reset()

    def admin_client(self) -> TestClient:
        client = fresh_client("127.0.0.1")
        self.assertEqual(login(client, ADMIN_USER, ADMIN_PASS).status_code, 200)
        return client

    def test_account_redirects_without_html_accept(self) -> None:
        # httpx / curl 默认 Accept: */*，不能因为缺 text/html 就把页面当接口
        response = fresh_client("127.0.0.1").get("/account")
        self.assertEqual(response.status_code, 302, response.text)
        self.assertTrue(response.headers["location"].startswith("/login"), response.headers["location"])
        self.assertIn("next=/account", response.headers["location"])

    def test_account_redirects_with_json_accept(self) -> None:
        response = fresh_client("127.0.0.1").get("/account", headers={"accept": "application/json"})
        self.assertEqual(response.status_code, 302, response.text)
        self.assertIn("next=/account", response.headers["location"])

    def test_account_page_served_when_logged_in_without_html_accept(self) -> None:
        client = self.admin_client()
        response = client.get("/account")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("我的账户", response.text)

    def test_account_html_alias_redirects(self) -> None:
        response = fresh_client("127.0.0.1").get("/account.html")
        self.assertEqual(response.status_code, 302, response.text)
        self.assertIn("next=/account.html", response.headers["location"])

    def test_account_api_stays_401_json(self) -> None:
        response = fresh_client("127.0.0.1").get("/api/auth/account")
        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(response.headers.get("content-type", "").split(";")[0], "application/json")
        self.assertEqual(response.json()["code"], "unauthorized")

    def test_api_path_keeps_401_json_without_accept(self) -> None:
        response = fresh_client("127.0.0.1").get("/api/canvases")
        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(response.json()["code"], "unauthorized")

    def test_admin_page_redirects_without_html_accept(self) -> None:
        response = fresh_client("127.0.0.1").get("/admin")
        self.assertEqual(response.status_code, 302, response.text)
        self.assertIn("next=/admin", response.headers["location"])

    def test_other_html_pages_redirect_with_next(self) -> None:
        client = fresh_client("127.0.0.1")
        for path in ("/", "/legacy", "/v2"):
            response = client.get(path)
            self.assertEqual(response.status_code, 302, path)
            location = response.headers["location"]
            self.assertTrue(location.startswith("/login"), path + " -> " + location)
            if path != "/":
                self.assertIn("next=" + path, location)

    def test_reset_page_is_public_without_accept(self) -> None:
        response = fresh_client("127.0.0.1").get("/reset")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("重置码", response.text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
