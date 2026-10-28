#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""API 设置仅管理员（M7-B）。

跑法：
    venv/bin/python -m unittest tests.test_api_settings_admin -v
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

_TMP_DATA = tempfile.mkdtemp(prefix="novai-settings-admin-test-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)
os.environ.setdefault("NOVAI_ADMIN_USER", "admin")
os.environ.setdefault("NOVAI_ADMIN_PASSWORD", "test-pass-123")
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "5000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "5000"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.auth import ratelimit, service  # noqa: E402

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


class A_AuthOffTest(unittest.TestCase):
    def setUp(self) -> None:
        set_auth(False)
        ratelimit.reset()

    def test_settings_open_when_auth_off(self) -> None:
        client = fresh_client()
        self.assertEqual(client.get("/api/settings/storage").status_code, 200)
        self.assertEqual(client.get("/static/api-settings.html").status_code, 200)


class B_SettingsAdminTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        set_auth(True)
        service.bootstrap_admin()

    def setUp(self) -> None:
        set_auth(True)
        ratelimit.reset()

    def admin_client(self) -> TestClient:
        client = fresh_client()
        self.assertEqual(login(client, ADMIN_USER, ADMIN_PASS).status_code, 200)
        return client

    def make_member(self, admin: TestClient) -> TestClient:
        issued = admin.post("/api/admin/invites", json={})
        username = ("settings" + uuid.uuid4().hex[:10])[:32]
        client = fresh_client()
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "settings-pass-123",
            "invite_code": issued.json()["code"],
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client

    def test_member_denied_admin_allowed(self) -> None:
        admin = self.admin_client()
        member = self.make_member(admin)

        for path in (
            "/api/settings/storage",
            "/api/settings/output-dir",
            "/api/settings/asr",
            "/api/config/token",
            "/api/config/storage",
        ):
            denied = member.get(path)
            self.assertEqual(denied.status_code, 403, path)
            self.assertEqual(denied.json()["code"], "forbidden")
            self.assertEqual(admin.get(path).status_code, 200, path)

        self.assertEqual(member.put("/api/providers", json=[]).status_code, 403)
        self.assertEqual(member.post("/api/pick-folder").status_code, 403)
        self.assertEqual(member.post("/api/providers/test-connection", json={}).status_code, 403)
        self.assertEqual(member.post("/api/providers/fetch-models", json={}).status_code, 403)

    def test_list_endpoints_unaffected(self) -> None:
        admin = self.admin_client()
        member = self.make_member(admin)
        for path in ("/api/models", "/api/config", "/api/providers", "/api/provider-registry"):
            self.assertEqual(member.get(path).status_code, 200, path)

    def test_static_settings_page(self) -> None:
        admin = self.admin_client()
        member = self.make_member(admin)

        anonymous = fresh_client().get("/static/api-settings.html")
        self.assertEqual(anonymous.status_code, 302)
        self.assertIn("/login", anonymous.headers["location"])

        denied = member.get("/static/api-settings.html")
        self.assertEqual(denied.status_code, 302)
        self.assertEqual(denied.headers["location"], "/")

        self.assertEqual(admin.get("/static/api-settings.html").status_code, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
