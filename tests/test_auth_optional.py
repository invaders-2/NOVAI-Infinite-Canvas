#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""可选登录（2026-11-07）：默认模式下不登录照常用；能注册 / 登录 / 退出；
注册方式由管理员在「需要邀请码 / 开放注册」之间切换；第一个账号是管理员。

跑法：venv/bin/python -m pytest -q tests/test_auth_optional.py
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

os.environ.setdefault("NOVAI_DATA_DIR", tempfile.mkdtemp(prefix="novai-auth-optional-"))
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "1000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "1000"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.auth import ratelimit, service, store  # noqa: E402

_PREV_DATA_DIR = ""
_TMP = ""
_ENV_KEYS = ("NOVAI_AUTH_ENABLED", "NOVAI_AUTH_DISABLED", "NOVAI_AUTH_MODE")
_PREV_ENV = {}


def setUpModule():
    global _PREV_DATA_DIR, _TMP
    _PREV_DATA_DIR = store._DATA_DIR
    _TMP = tempfile.mkdtemp(prefix="novai-auth-optional-db-")
    store.set_data_dir(_TMP)
    for key in _ENV_KEYS:
        _PREV_ENV[key] = os.environ.pop(key, None)


def tearDownModule():
    store.set_data_dir(_PREV_DATA_DIR)
    for key, value in _PREV_ENV.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def client() -> TestClient:
    return TestClient(main.app, client=("127.0.0.1", 50000), follow_redirects=False)


def uname(prefix: str = "u") -> str:
    return prefix + uuid.uuid4().hex[:8]


PASS = "test-pass-123"


class A_OptionalModeTest(unittest.TestCase):
    """顺序有意义：先验证「还没有任何账号」时的行为。"""

    def setUp(self):
        ratelimit.reset()

    def test_1_default_mode_is_optional_and_not_guarded(self):
        self.assertEqual(service.auth_mode(), "optional")
        self.assertFalse(service.auth_enabled())
        c = client()
        self.assertEqual(c.get("/", headers={"accept": "text/html"}).status_code, 200)
        self.assertNotEqual(c.get("/api/canvases").status_code, 401)
        me = c.get("/api/auth/me").json()
        self.assertEqual(me["auth_mode"], "optional")
        self.assertFalse(me["auth_enabled"])
        self.assertFalse(me["logged_in"])

    def test_2_first_account_is_admin_without_invite(self):
        cfg = client().get("/api/auth/config").json()
        self.assertEqual(cfg["auth_mode"], "optional")
        self.assertTrue(cfg["invite_required"])        # 默认仍需要邀请码
        self.assertFalse(cfg["has_users"])
        c = client()
        r = c.post("/api/auth/register", json={"username": "owner1", "password": PASS})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["user"]["role"], "admin")
        me = c.get("/api/auth/me").json()
        self.assertTrue(me["logged_in"])
        self.assertEqual(me["username"], "owner1")
        self.assertFalse(me["auth_enabled"])            # 可选登录：不触发前端的管理员门禁
        self.assertTrue(client().get("/api/auth/config").json()["has_users"])

    def test_3_second_account_needs_invite_by_default(self):
        r = client().post("/api/auth/register", json={"username": uname(), "password": PASS})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "invite_required")

    def test_4_admin_switches_to_open_registration(self):
        admin = client()
        self.assertEqual(admin.post("/api/auth/login", json={"username": "owner1", "password": PASS}).status_code, 200)
        self.assertTrue(admin.get("/api/admin/auth-settings").json()["invite_required"])
        r = admin.put("/api/admin/auth-settings", json={"invite_required": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["invite_required"])
        self.assertFalse(client().get("/api/auth/config").json()["invite_required"])

        name = uname()
        c = client()
        r = c.post("/api/auth/register", json={"username": name, "password": PASS})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["user"]["role"], "user")
        # 重名
        dup = client().post("/api/auth/register", json={"username": name, "password": PASS})
        self.assertEqual(dup.json()["code"], "username_taken")
        # 普通用户不能改注册方式
        self.assertEqual(c.put("/api/admin/auth-settings", json={"invite_required": True}).status_code, 403)
        # 未登录也不能
        self.assertEqual(client().put("/api/admin/auth-settings", json={"invite_required": True}).status_code, 401)

    def test_5_invite_still_works_when_open(self):
        admin = client()
        admin.post("/api/auth/login", json={"username": "owner1", "password": PASS})
        code = admin.post("/api/admin/invites", json={"uses": 1, "days": 7, "role": "team"}).json()["code"]
        r = client().post("/api/auth/register", json={"username": uname(), "password": PASS, "invite_code": code})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["user"]["role"], "team")

    def test_6_login_logout_and_bad_password(self):
        c = client()
        self.assertEqual(c.post("/api/auth/login", json={"username": "owner1", "password": "wrong-pass-1"}).status_code, 401)
        self.assertEqual(c.post("/api/auth/login", json={"username": "owner1", "password": PASS}).status_code, 200)
        self.assertTrue(c.get("/api/auth/me").json()["logged_in"])
        self.assertEqual(c.post("/api/auth/logout").status_code, 200)
        self.assertFalse(c.get("/api/auth/me").json()["logged_in"])

    def test_7_login_page_serves_new_ui(self):
        r = client().get("/login", headers={"accept": "text/html"})
        self.assertEqual(r.status_code, 200)
        self.assertIn('id="app"', r.text)

    def test_8_switch_back_to_invite_required(self):
        admin = client()
        admin.post("/api/auth/login", json={"username": "owner1", "password": PASS})
        self.assertTrue(admin.put("/api/admin/auth-settings", json={"invite_required": True}).json()["invite_required"])
        r = client().post("/api/auth/register", json={"username": uname(), "password": PASS})
        self.assertEqual(r.json()["code"], "invite_required")


class B_ModeSwitchTest(unittest.TestCase):
    def tearDown(self):
        for key in _ENV_KEYS:
            os.environ.pop(key, None)

    def test_off_mode(self):
        os.environ["NOVAI_AUTH_MODE"] = "off"
        c = client()
        me = c.get("/api/auth/me").json()
        self.assertEqual(me["auth_mode"], "off")
        r = c.post("/api/auth/register", json={"username": uname(), "password": PASS})
        self.assertEqual(r.json()["code"], "auth_disabled")
        self.assertFalse(c.get("/api/auth/config").json()["accounts_enabled"])

    def test_required_mode_via_legacy_env(self):
        os.environ["NOVAI_AUTH_ENABLED"] = "1"
        self.assertEqual(service.auth_mode(), "required")
        self.assertTrue(service.auth_enabled())
        self.assertEqual(client().get("/api/canvases").status_code, 401)

    def test_disabled_env_wins(self):
        os.environ["NOVAI_AUTH_ENABLED"] = "1"
        os.environ["NOVAI_AUTH_DISABLED"] = "1"
        self.assertEqual(service.auth_mode(), "off")


if __name__ == "__main__":
    unittest.main(verbosity=2)
