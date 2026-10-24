#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M5 共享画布素材 ACL 真机冒烟（httpx，服务跑在 8897）。

用法：
    NOVAI_DATA_DIR=/tmp/novai-asset-acl-data venv/bin/python tests/asset_acl_smoke.py
"""
from __future__ import annotations

import base64
import json
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


def check(label: str, expected: int, actual: int) -> None:
    global FAILED
    ok = expected == actual
    print(("PASS  " if ok else "FAIL  ") + label + " (expected %d, got %d)" % (expected, actual))
    if not ok:
        FAILED += 1


def main() -> int:
    admin = httpx.Client(base_url=BASE, timeout=15)
    check("管理员登录", 200, admin.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASS}).status_code)

    def register(name: str) -> httpx.Client:
        code = admin.post("/api/admin/invites", json={}).json()["code"]
        client = httpx.Client(base_url=BASE, timeout=15)
        response = client.post("/api/auth/register", json={
            "username": name, "password": "asset-pass-123", "invite_code": code,
        })
        check("注册 " + name, 200, response.status_code)
        return client

    owner = register("alice")
    viewer = register("viewer")
    editor = register("editor")
    stranger = register("stranger")
    anonymous = httpx.Client(base_url=BASE, timeout=15)

    def upload(client: httpx.Client, marker: bytes) -> str:
        response = client.post("/api/ai/upload", files=[
            ("files", ("acl-%s.png" % marker.hex(), PNG + marker, "image/png")),
        ])
        check("上传素材 " + marker.hex(), 200, response.status_code)
        return response.json()["files"][0]["url"]

    def make_canvas(client: httpx.Client, asset_url: str, title: str) -> str:
        canvas = client.post("/api/canvases", json={"title": title}).json()["canvas"]
        response = client.put("/api/canvases/%s" % canvas["id"], json={
            "title": title,
            "nodes": [{"id": "n1", "type": "image", "images": [{"url": asset_url}]}],
            "connections": [], "logs": [], "settings": {},
        })
        check("保存画布 " + title, 200, response.status_code)
        return canvas["id"]

    asset_shared = upload(owner, b"shared")
    canvas_shared = make_canvas(owner, asset_shared, "共享画布")
    check("分享 viewer", 200, owner.post("/api/canvases/%s/members" % canvas_shared,
                                         json={"username": "viewer", "role": "viewer"}).status_code)
    check("分享 editor", 200, owner.post("/api/canvases/%s/members" % canvas_shared,
                                         json={"username": "editor", "role": "editor"}).status_code)

    asset_unshared = upload(owner, b"private")
    make_canvas(owner, asset_unshared, "未共享画布")

    def get(client: httpx.Client, url: str) -> int:
        return client.get(url).status_code

    check("owner 读共享图", 200, get(owner, asset_shared))
    check("viewer 读共享图", 200, get(viewer, asset_shared))
    check("editor 读共享图", 200, get(editor, asset_shared))
    check("admin 读共享图", 200, get(admin, asset_shared))
    check("viewer 带 query 读共享图", 200, get(viewer, asset_shared + "?v=1&x=2"))
    check("viewer 读未共享画布图", 403, get(viewer, asset_unshared))
    check("无关系用户读共享图", 403, get(stranger, asset_shared))
    check("匿名读共享图", 401, get(anonymous, asset_shared))

    # 缓存策略：移除成员后 TTL 内仍可能命中旧缓存；不等待，只记录
    print("NOTE  缓存 TTL=45s：移除成员/删画布最迟一个 TTL 后失效（单测用 clear_cache 验证）")

    for client in (admin, owner, viewer, editor, stranger, anonymous):
        client.close()
    print("\nSUMMARY failed=%d" % FAILED)
    return FAILED


if __name__ == "__main__":
    sys.exit(main())
