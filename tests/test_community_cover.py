#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区封面单测：观看方代理取别人作品的封面。

封面写在发布包根目录 cover.webp，远端的 /public/media/<id>/<file> 只服务 media/ 子目录，
必须走 /public/items/<id>/cover 才取得到（作者本人走 mine 分支，看不出这个问题）。

用法：venv/bin/python tests/test_community_cover.py
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import sys
import tempfile
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.community import store, transport  # noqa: E402
from server.routes import community  # noqa: E402
from server.routes.deps import deps  # noqa: E402

FAILED = 0
REMOTE_ID = "111111-abcdef"
NODE_BASE = "http://192.168.1.9:3000"
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
CALLS = []


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def fake_http(method, url, headers, body, timeout):
    """模拟作者节点：封面只在 /public/items/<id>/cover 上，media/ 里没有。"""
    path = urllib.parse.urlsplit(str(url)).path
    CALLS.append((method, path))
    if path == "/api/community/public/items":
        return 200, json.dumps({
            "author": {"account_id": "acct1", "nickname": "LIWEIPING", "avatar": ""},
            "items": [{
                "id": REMOTE_ID, "kind": "canvas", "title": "复刻视频", "desc": "",
                "tags": [], "category": "海报", "cover": "cover.webp",
                "author": {"account_id": "acct1", "nickname": "LIWEIPING", "avatar": ""},
                "version": 1, "created_at": 1700000000000, "updated_at": 1700000000000,
                "package_updated_at": 1700000000000, "allow_clone": True,
                "meta": {"nodes": 3, "media": 0, "size_bytes": 0},
                "stats": {"likes": 1, "clones": 0, "views": 0, "reports": 0},
                "status": "published", "report_reasons": [], "online": True,
            }],
        }, ensure_ascii=False).encode("utf-8")
    if path == "/api/community/public/items/" + REMOTE_ID + "/cover":
        return 200, PNG_BYTES
    if path == "/api/community/public/media/" + REMOTE_ID + "/cover.webp":
        return 404, b""
    return 404, b""


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-community-cover-")
    try:
        deps.bind(
            DATA_DIR=data_dir,
            COMMUNITY_NODES=lambda: [{"id": "node-a", "nickname": "LIWEIPING",
                                      "base": NODE_BASE, "token": "", "online": True}],
            COMMUNITY_HTTP=fake_http,
        )
        transport.clear_feed_cache()
        original_limit = community.RATE_READ_PER_MIN
        community.RATE_READ_PER_MIN = 5000
        app = FastAPI()
        app.include_router(community.router)
        client = TestClient(app)

        feed = client.get("/api/community/feed")
        items = (feed.json() or {}).get("items") or [] if feed.status_code == 200 else []
        listed = next((it for it in items if str(it.get("id")) == REMOTE_ID), None)
        check("远端作品出现在 feed 且带封面", bool(listed) and listed.get("cover") == "cover.webp",
              str(feed.status_code) + " " + feed.text[:160])

        CALLS.clear()
        first = client.get("/api/community/cover/" + REMOTE_ID)
        check("观看方代理取封面 200", first.status_code == 200,
              str(first.status_code) + " " + first.text[:120])
        check("封面字节与作者一致", first.content == PNG_BYTES, str(len(first.content)) + " bytes")
        check("走的是 public/items/<id>/cover",
              ("GET", "/api/community/public/items/" + REMOTE_ID + "/cover") in CALLS,
              str(CALLS))
        cached_path = os.path.join(store.cache_item_dir(REMOTE_ID), "cover.webp")
        check("封面落到本机缓存", os.path.isfile(cached_path) and os.path.getsize(cached_path) > 0,
              cached_path)

        CALLS.clear()
        second = client.get("/api/community/cover/" + REMOTE_ID)
        check("二次请求命中缓存不再打远端", second.status_code == 200 and not CALLS, str(CALLS))

        community.RATE_READ_PER_MIN = original_limit
    finally:
        shutil.rmtree(data_dir, ignore_errors=True)

    print("")
    if FAILED:
        print("FAILED " + str(FAILED))
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def test_community_cover_suite():
    """pytest 入口：脚本里那套 check() 断言原样跑一遍（python tests/xxx.py 也照旧可用）。"""
    assert main() == 0
