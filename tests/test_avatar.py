#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用户头像回归测试（M7）。

跑法：
    venv/bin/python -m unittest tests.test_avatar -v
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-avatar-test-")
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
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"


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


def unique_name(prefix: str = "avatar") -> str:
    return (prefix + uuid.uuid4().hex[:10])[:32]


class A_AuthOffTest(unittest.TestCase):
    def setUp(self) -> None:
        set_auth(False)
        ratelimit.reset()

    def test_avatar_disabled(self) -> None:
        client = fresh_client()
        self.assertEqual(client.get("/api/auth/avatar/1").status_code, 404)
        response = client.post("/api/auth/avatar", files={"file": ("a.png", PNG, "image/png")})
        self.assertIn(response.status_code, (401, 403))


class B_AvatarTest(unittest.TestCase):
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

    def make_user(self, admin: TestClient, prefix: str = "avatar") -> tuple:
        issued = admin.post("/api/admin/invites", json={})
        self.assertEqual(issued.status_code, 200, issued.text)
        username = unique_name(prefix)
        client = fresh_client()
        registered = client.post("/api/auth/register", json={
            "username": username,
            "password": "avatar-pass-123",
            "invite_code": issued.json()["code"],
        })
        self.assertEqual(registered.status_code, 200, registered.text)
        return client, registered.json()["user"]

    def upload(self, client: TestClient, content: bytes = PNG, name: str = "a.png", content_type: str = "image/png"):
        return client.post("/api/auth/avatar", files={"file": (name, content, content_type)})

    # ---------------------------------------------------------------- cases
    def test_upload_me_get_replace_delete(self) -> None:
        admin = self.admin_client()
        alice, alice_user = self.make_user(admin, "alice")
        bob, _bob_user = self.make_user(admin, "bob")

        uploaded = self.upload(alice)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        url = uploaded.json()["avatar_url"]
        self.assertTrue(url.startswith("/api/auth/avatar/%d?v=" % alice_user["id"]), url)

        me = alice.get("/api/auth/me").json()
        self.assertEqual(me["avatar_url"], url)

        fetched = bob.get(url)
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.content, PNG)
        self.assertEqual(fetched.headers.get("content-type"), "image/png")
        self.assertTrue(fetched.headers.get("etag"))
        self.assertTrue(fetched.headers.get("last-modified"))
        self.assertIn("private", (fetched.headers.get("cache-control") or ""))
        self.assertEqual(bob.get(url, headers={"if-none-match": fetched.headers["etag"]}).status_code, 304)

        users = admin.get("/api/admin/users").json()["users"]
        row = next(item for item in users if item["id"] == alice_user["id"])
        self.assertEqual(row["avatar_url"], url)

        time.sleep(0.01)
        replaced = self.upload(alice, JPEG, "a.jpg", "image/jpeg")
        self.assertEqual(replaced.status_code, 200, replaced.text)
        new_url = replaced.json()["avatar_url"]
        self.assertNotEqual(new_url, url)
        self.assertEqual(bob.get(new_url).content, JPEG)
        self.assertEqual(alice.get("/api/auth/me").json()["avatar_url"], new_url)
        # ?v= 只做缓存破环；旧 URL 仍解析到当前头像
        self.assertEqual(bob.get(url).content, JPEG)

        deleted = alice.delete("/api/auth/avatar")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["avatar_url"], "")
        self.assertEqual(alice.get("/api/auth/me").json()["avatar_url"], "")
        self.assertEqual(bob.get(new_url).status_code, 404)
        self.assertEqual(bob.get(url).status_code, 404)

    def test_validation(self) -> None:
        admin = self.admin_client()
        alice, _alice_user = self.make_user(admin, "val")

        text = alice.post("/api/auth/avatar", files={"file": ("a.txt", b"hello", "text/plain")})
        self.assertEqual(text.status_code, 415)
        self.assertEqual(text.json()["code"], "invalid_avatar_type")

        gif = alice.post("/api/auth/avatar", files={"file": ("a.gif", b"GIF89a" + b"0" * 32, "image/gif")})
        self.assertEqual(gif.status_code, 415)

        huge = alice.post("/api/auth/avatar", files={
            "file": ("big.png", b"\x89PNG\r\n\x1a\n" + b"0" * (2 * 1024 * 1024), "image/png"),
        })
        self.assertEqual(huge.status_code, 413)
        self.assertEqual(huge.json()["code"], "avatar_too_large")

        anonymous = fresh_client().post("/api/auth/avatar", files={"file": ("a.png", PNG, "image/png")})
        self.assertEqual(anonymous.status_code, 401)

    def test_admin_avatar_and_permissions(self) -> None:
        admin = self.admin_client()
        alice, alice_user = self.make_user(admin, "alice2")
        bob, bob_user = self.make_user(admin, "bob2")

        uploaded = admin.post(
            "/api/admin/users/%d/avatar" % bob_user["id"],
            files={"file": ("b.png", PNG, "image/png")},
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertTrue(uploaded.json()["avatar_url"].startswith("/api/auth/avatar/%d" % bob_user["id"]))
        self.assertEqual(bob.get("/api/auth/me").json()["avatar_url"], uploaded.json()["avatar_url"])

        forbidden = bob.post(
            "/api/admin/users/%d/avatar" % alice_user["id"],
            files={"file": ("a.png", PNG, "image/png")},
        )
        self.assertEqual(forbidden.status_code, 403)
        self.assertEqual(forbidden.json()["code"], "forbidden")

        missing = admin.post(
            "/api/admin/users/999999/avatar",
            files={"file": ("a.png", PNG, "image/png")},
        )
        self.assertEqual(missing.status_code, 404)

        # 任意登录用户可读他人头像
        self.assertEqual(alice.get(uploaded.json()["avatar_url"]).status_code, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
