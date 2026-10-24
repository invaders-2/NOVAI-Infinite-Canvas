#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M6 分享链接真机冒烟（httpx，服务跑在 8897）。

用法：
    NOVAI_DATA_DIR=/tmp/novai-share-links-data venv/bin/python tests/share_links_smoke.py
"""
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
            "username": name, "password": "share-pass-123", "invite_code": code,
        })
        check("注册 " + name, response.status_code == 200)
        return client

    owner = register("alice")
    viewer = register("viewer")
    owner_user = owner.get("/api/auth/me").json()
    viewer_user = viewer.get("/api/auth/me").json()
    anonymous = httpx.Client(base_url=BASE, timeout=15)

    def upload(client: httpx.Client, marker: bytes) -> str:
        response = client.post("/api/ai/upload", files=[("files", ("sl-%s.png" % marker.hex(), PNG + marker, "image/png"))])
        check("上传素材 " + marker.hex(), response.status_code == 200)
        return response.json()["files"][0]["url"]

    referenced = upload(owner, b"ref")
    unreferenced = upload(owner, b"other")
    canvas = owner.post("/api/canvases", json={"title": "分享冒烟"}).json()["canvas"]
    saved = owner.put("/api/canvases/%s" % canvas["id"], json={
        "title": "分享冒烟", "nodes": [{"id": "n1", "images": [{"url": referenced}]}],
        "connections": [], "logs": [], "settings": {},
    })
    check("保存带图画布", saved.status_code == 200)

    created = owner.post("/api/canvases/%s/share-link" % canvas["id"], json={})
    link = created.json()["link"]
    check("创建链接", created.status_code == 200 and len(link["token"]) == 10, link.get("url", ""))
    check("默认 7 天 / viewer / 无密码", link["expires_in_days"] == 7 and link["role"] == "viewer" and not link["has_password"])
    got = owner.get("/api/canvases/%s/share-link" % canvas["id"]).json()["link"]
    check("GET 链接 token 一致", got["token"] == link["token"])

    unauth = anonymous.get("/api/share/" + link["token"])
    check("未登录文档 401 AUTH_REQUIRED", unauth.status_code == 401 and unauth.json().get("code") == "AUTH_REQUIRED")
    page = anonymous.get("/c/" + link["token"])
    check("分享页 200 html", page.status_code == 200 and "text/html" in page.headers.get("content-type", ""))

    public = viewer.get("/api/share/" + link["token"])
    body = public.json() if public.status_code == 200 else {}
    check("登录后公开读 200", public.status_code == 200)
    check("authenticated=true / viewer / can_clone=false",
          body.get("authenticated") is True and body.get("role") == "viewer" and body.get("can_clone") is False)
    members = owner.get("/api/canvases/%s/permissions" % canvas["id"]).json()["members"]
    check("自动加入 viewer 成员", viewer_user["username"] in [m["username"] for m in members])
    check("成员可读被引用素材", viewer.get(referenced).status_code == 200)
    check("未引用素材仍 403", viewer.get(unreferenced).status_code == 403)

    updated = owner.post("/api/canvases/%s/share-link" % canvas["id"], json={
        "expires_in_days": 1, "password": "share-secret-123", "allow_clone": True,
    }).json()["link"]
    check("更新保持 token", updated["token"] == link["token"])
    check("更新为 1 天 / 有密码 / 允许克隆", updated["expires_in_days"] == 1 and updated["has_password"] and updated["allow_clone"])

    locked = viewer.get("/api/share/" + link["token"])
    check("需要密码 401 PASSWORD_REQUIRED", locked.status_code == 401 and locked.json().get("code") == "PASSWORD_REQUIRED")
    wrong = viewer.post("/api/share/" + link["token"] + "/unlock", json={"password": "nope"})
    check("错密码 403 BAD_PASSWORD", wrong.status_code == 403 and wrong.json().get("code") == "BAD_PASSWORD")
    good = viewer.post("/api/share/" + link["token"] + "/unlock", json={"password": "share-secret-123"})
    check("正确密码 unlock 200", good.status_code == 200)
    unlocked = viewer.get("/api/share/" + link["token"])
    check("解锁后文档 200 / can_clone=true", unlocked.status_code == 200 and unlocked.json().get("can_clone") is True)

    cloned = viewer.post("/api/share/" + link["token"] + "/clone")
    check("克隆 201", cloned.status_code == 201, cloned.text)
    new_id = cloned.json()["canvas_id"] if cloned.status_code == 201 else ""
    if new_id:
        doc = viewer.get("/api/canvases/%s" % new_id).json()["canvas"]
        check("克隆归属当前用户", int(doc["owner_id"]) == int(viewer_user["id"]))
        check("克隆标题带副本", doc["title"].endswith("的副本"))
        check("克隆内容一致", doc["nodes"] == viewer.get("/api/canvases/%s" % canvas["id"]).json()["canvas"]["nodes"])

    revoked = owner.delete("/api/canvases/%s/share-link" % canvas["id"])
    check("撤销 200", revoked.status_code == 200)
    check("撤销后文档 404", viewer.get("/api/share/" + link["token"]).status_code == 404)

    for client in (admin, owner, viewer, anonymous):
        client.close()
    print("\nSUMMARY failed=%d" % FAILED)
    return FAILED


if __name__ == "__main__":
    sys.exit(main())
