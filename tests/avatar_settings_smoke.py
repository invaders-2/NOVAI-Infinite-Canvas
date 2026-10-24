#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M7 头像 + API 设置仅管理员 真机冒烟（httpx，服务 8897）。"""
from __future__ import annotations

import base64
import os
import sys

import httpx

BASE = os.environ.get("NOVAI_BASE", "http://127.0.0.1:8897")
ADMIN_USER = os.environ.get("NOVAI_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("NOVAI_ADMIN_PASSWORD", "test-pass-123")
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
FAILED = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def main() -> int:
    admin = httpx.Client(base_url=BASE, timeout=15)
    check("管理员登录", admin.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASS}).status_code == 200)

    def register(name: str) -> httpx.Client:
        code = admin.post("/api/admin/invites", json={}).json()["code"]
        client = httpx.Client(base_url=BASE, timeout=15)
        response = client.post("/api/auth/register", json={
            "username": name, "password": "avatar-pass-123", "invite_code": code,
        })
        check("注册 " + name, response.status_code == 200)
        return client

    alice = register("alice")
    bob = register("bob")
    alice_user = alice.get("/api/auth/me").json()
    bob_user = bob.get("/api/auth/me").json()

    upload = alice.post("/api/auth/avatar", files={"file": ("a.png", PNG, "image/png")})
    url = upload.json().get("avatar_url", "") if upload.status_code == 200 else ""
    check("上传头像 200", upload.status_code == 200, url)
    check("avatar_url 绝对路径", url.startswith("/api/auth/avatar/%d?v=" % alice_user["id"]))
    check("me 带 avatar_url", alice.get("/api/auth/me").json().get("avatar_url") == url)

    fetched = bob.get(url)
    check("他人可读头像 200", fetched.status_code == 200 and fetched.content == PNG)
    check("头像带 ETag/Cache-Control", bool(fetched.headers.get("etag")) and "private" in fetched.headers.get("cache-control", ""))
    check("If-None-Match 304", bob.get(url, headers={"if-none-match": fetched.headers["etag"]}).status_code == 304)

    users = admin.get("/api/admin/users").json()["users"]
    row = next(u for u in users if u["id"] == alice_user["id"])
    check("admin 列表带 avatar_url", row.get("avatar_url") == url)

    replaced = alice.post("/api/auth/avatar", files={"file": ("a.jpg", JPEG, "image/jpeg")})
    check("替换头像为 jpg", replaced.status_code == 200 and replaced.json()["avatar_url"] != url)
    check("替换后内容更新", bob.get(replaced.json()["avatar_url"]).content == JPEG)

    invalid = alice.post("/api/auth/avatar", files={"file": ("a.txt", b"hello", "text/plain")})
    check("非法格式 415", invalid.status_code == 415)
    huge = alice.post("/api/auth/avatar", files={
        "file": ("big.png", b"\x89PNG\r\n\x1a\n" + b"0" * (2 * 1024 * 1024), "image/png"),
    })
    check("超过 2MB 413", huge.status_code == 413)

    admin_upload = admin.post("/api/admin/users/%d/avatar" % bob_user["id"], files={"file": ("b.png", PNG, "image/png")})
    check("admin 替成员换头像 200", admin_upload.status_code == 200)
    check("成员 me 看到新头像", bob.get("/api/auth/me").json().get("avatar_url") == admin_upload.json()["avatar_url"])
    check("成员调管理员头像接口 403", bob.post(
        "/api/admin/users/%d/avatar" % alice_user["id"], files={"file": ("a.png", PNG, "image/png")}
    ).status_code == 403)

    deleted = alice.delete("/api/auth/avatar")
    check("删除头像 200 / 置空", deleted.status_code == 200 and deleted.json()["avatar_url"] == "")
    check("删除后 GET 404", bob.get(replaced.json()["avatar_url"]).status_code == 404)

    # B. API 设置仅管理员
    check("成员 settings/storage 403", bob.get("/api/settings/storage").status_code == 403)
    check("admin settings/storage 200", admin.get("/api/settings/storage").status_code == 200)
    check("成员 config/token 403", bob.get("/api/config/token").status_code == 403)
    check("成员 PUT providers 403", bob.put("/api/providers", json=[]).status_code == 403)
    check("成员 pick-folder 403", bob.post("/api/pick-folder").status_code == 403)
    check("成员列表 /api/models 200", bob.get("/api/models").status_code == 200)
    check("成员列表 /api/config 200", bob.get("/api/config").status_code == 200)
    check("成员列表 /api/providers 200", bob.get("/api/providers").status_code == 200)
    check("成员设置页 302 回首页", bob.get("/static/api-settings.html").status_code == 302 and
          bob.get("/static/api-settings.html").headers.get("location") == "/")
    check("admin 设置页 200", admin.get("/static/api-settings.html").status_code == 200)
    anon_page = httpx.Client(base_url=BASE, timeout=15).get("/static/api-settings.html")
    check("匿名设置页 302 去登录", anon_page.status_code == 302 and "/login" in anon_page.headers.get("location", ""))

    for client in (admin, alice, bob):
        client.close()
    print("\nSUMMARY failed=%d" % FAILED)
    return FAILED


if __name__ == "__main__":
    sys.exit(main())
