#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""局域网克隆 / 社区「大画布、视频多」回归测试（2026-11-24）。

背景（用户反馈）：画布节点多、特别是视频多时，局域网分享克隆失败、社区作品时有时无 / 打不开。
根因：克隆素材「单个 10s 总时长 / 单文件 50MB / 累计 200MB / 总 60s」；社区拉列表 1.5s 超时、
失败即从列表消失；详情要把整份画布传两遍。这里锁住修复后的行为：
  1) 慢但一直在传的素材不再被 10s 总时长掐断（只看「多久没收到数据」+ 按体量给的总时长）；
  2) 对方卡住不传数据会按空闲超时报错；整体太慢按体量预算报「下载太慢」；
  3) 单文件上限 500MB，与社区发布单个素材上限一致（整包 2GB）；
  4) 社区节点第一次超时会重试；一次没拉到时作品不消失（标 online:false），且只短缓存；
  5) 社区详情带 ?lite=1，不再重复传画布数据。

不依赖 main.py。用法：venv/bin/python tests/test_lan_media_budget.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server.routes.deps import deps  # noqa: E402
from server.routes import canvas_share as share  # noqa: E402

FAILED = 0
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
CHUNK = b"\0" * 4096


class SlowHandler(BaseHTTPRequestHandler):
    """/trickle：每 0.4s 传一小块，共约 4s；/stall：传一块后停 3s；/huge：报 600MB。"""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/output/huge.mp4":
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(600 * 1024 * 1024))
            self.end_headers()
            return
        body_chunks = [PNG_BYTES] + [CHUNK] * 10
        total = sum(len(c) for c in body_chunks)
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(total))
        self.end_headers()
        try:
            for index, chunk in enumerate(body_chunks):
                self.wfile.write(chunk)
                self.wfile.flush()
                if path.startswith("/output/stall") and index == 0:
                    time.sleep(3.0)
                else:
                    time.sleep(0.4)
        except (BrokenPipeError, ConnectionResetError):
            pass


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def bind_share_deps(data_dir: str) -> str:
    uploads_dir = os.path.join(data_dir, "assets", "uploads")

    def safe_folder(rel):
        name = str(rel or "").strip("/")
        return name, (os.path.join(uploads_dir, name) if name else uploads_dir)

    def kind_ext(name_path, content_type):
        ct = str(content_type or "").lower()
        if ct.startswith("image/"):
            return "image", ".png"
        if ct.startswith("video/"):
            return "video", ".mp4"
        return None, ""

    deps.bind(
        DATA_DIR=data_dir,
        LAN_AUTH_ENABLED=lambda: False,
        LOAD_LAN_TOKEN=lambda: "",
        _local_upload_safe_folder=safe_folder,
        _local_upload_kind_ext=kind_ext,
        _local_upload_item=lambda rel: {"url": "/assets/uploads/" + str(rel).lstrip("/"), "file": str(rel)},
        _sniff_image_ext_bytes=lambda head: ".png" if head else "",
        _SSL_CONTEXT=True,
        _TRUST_ENV=False,
    )
    return uploads_dir


def test_share_budget(base: str, uploads_dir: str) -> None:
    # 预算函数：30s 起，每 5MB +10s，封顶 900s
    check("单文件时长预算 0B = 30s", share.media_file_deadline(0) == 30.0, str(share.media_file_deadline(0)))
    check("单文件时长预算 100MB = 230s", share.media_file_deadline(100 * 1024 * 1024) == 230.0,
          str(share.media_file_deadline(100 * 1024 * 1024)))
    check("单文件时长预算封顶 900s", share.media_file_deadline(10 * 1024 ** 3) == 900.0)
    check("单文件上限 500MB", share.MEDIA_MAX_FILE_BYTES == 500 * 1024 * 1024)

    original = share.MEDIA_TIMEOUT_SECONDS
    try:
        share.MEDIA_TIMEOUT_SECONDS = 1.0   # 旧逻辑等价于「总时长 3s」，下面的素材要传约 4s
        started = time.monotonic()
        result = asyncio.run(share.localize_media_urls([base + "/output/trickle.mp4"]))
        elapsed = time.monotonic() - started
        check("慢但持续传输的素材不再被总时长掐断", result.get("copied") == 1,
              json.dumps(result, ensure_ascii=False))
        check("慢速素材确实传了 3s 以上", elapsed > 3.0, "%.1fs" % elapsed)
        local = str(((result.get("items") or [{}])[0]).get("local") or "")
        path = os.path.join(uploads_dir, os.path.basename(local))
        check("慢速素材完整落盘", os.path.isfile(path) and os.path.getsize(path) == len(PNG_BYTES) + 10 * len(CHUNK),
              local)
        leftovers = [name for name in os.listdir(uploads_dir) if name.endswith(".part")]
        check("不留临时文件", not leftovers, str(leftovers))

        stalled = asyncio.run(share.localize_media_urls([base + "/output/stall.mp4"]))
        error = str(((stalled.get("items") or [{}])[0]).get("error") or "")
        check("对方停住不传数据按空闲超时失败", stalled.get("failed") == 1 and "没有收到数据" in error, error)
    finally:
        share.MEDIA_TIMEOUT_SECONDS = original

    original_base = share.MEDIA_FILE_BASE_SECONDS
    original_step = share.MEDIA_FILE_STEP_BYTES
    try:
        share.MEDIA_FILE_BASE_SECONDS = 1.0
        share.MEDIA_FILE_STEP_BYTES = 1024 ** 4
        slow = asyncio.run(share.localize_media_urls([base + "/output/trickle2.mp4"]))
        error = str(((slow.get("items") or [{}])[0]).get("error") or "")
        check("整体太慢按体量预算报「下载太慢」", slow.get("failed") == 1 and "太慢" in error, error)
    finally:
        share.MEDIA_FILE_BASE_SECONDS = original_base
        share.MEDIA_FILE_STEP_BYTES = original_step

    huge = asyncio.run(share.localize_media_urls([base + "/output/huge.mp4"]))
    error = str(((huge.get("items") or [{}])[0]).get("error") or "")
    check("超过 500MB 的单文件明确报过大", huge.get("failed") == 1 and "500MB" in error, error)
    leftovers = [name for name in os.listdir(uploads_dir) if name.endswith(".part")]
    check("失败后也不留临时文件", not leftovers, str(leftovers))


def test_community_feed() -> None:
    from server.community import transport

    calls = {"items": 0, "urls": []}
    state = {"mode": "flaky"}
    item = {"id": "483920-abcd1234", "kind": "canvas", "title": "视频分镜", "status": "published",
            "author": {"account_id": "peer", "nickname": "同事"}, "updated_at": 1, "version": 1}

    def fake_http(method, url, headers, body, timeout):
        calls["urls"].append(url)
        path = urllib.parse.urlsplit(url).path
        if path == "/api/community/public/items":
            calls["items"] += 1
            if state["mode"] == "down":
                return 0, b""
            if state["mode"] == "flaky" and calls["items"] == 1:
                return 0, b""          # 第一次超时，第二次才回
            return 200, json.dumps({"author": item["author"], "items": [item]}).encode()
        return 404, b"{}"

    deps.bind(COMMUNITY_HTTP=fake_http,
              COMMUNITY_NODES=lambda: [{"id": "peer", "nickname": "同事", "base": "http://192.168.1.20:3000"}])
    transport.set_transport(transport.LanTransport())
    try:
        first = asyncio.run(transport.get_transport().aggregate(force=True))
        check("节点第一次超时会重试并拿到作品", len(first.get("items") or []) == 1 and calls["items"] == 2,
              "calls=%d" % calls["items"])
        check("列表拉取超时放宽到 4s", transport.FEED_NODE_TIMEOUT >= 4.0)

        state["mode"] = "down"
        second = asyncio.run(transport.get_transport().aggregate(force=True))
        items = second.get("items") or []
        check("节点一次没拉到时作品不消失", len(items) == 1, json.dumps(items, ensure_ascii=False))
        check("沿用的作品标 online:false", items and items[0].get("online") is False
              and (items[0].get("node") or {}).get("online") is False)
        cache = transport.get_transport()._feed_cache
        check("有节点失败时只短缓存", int(cache.get("ttl") or 0) == transport.FEED_CACHE_PARTIAL_MS, str(cache.get("ttl")))

        calls["urls"] = []
        transport.remember_item_node(item["id"], {"id": "peer", "base": "http://192.168.1.20:3000", "token": ""})
        asyncio.run(transport.get_transport().item_detail(item["id"], lite=True))
        check("社区详情带 lite=1，不重复传画布", any("lite=1" in url for url in calls["urls"]), str(calls["urls"]))
    finally:
        deps.bind(COMMUNITY_HTTP=None, COMMUNITY_NODES=None)


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-lan-budget-")
    uploads_dir = bind_share_deps(data_dir)
    os.makedirs(uploads_dir, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), SlowHandler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    try:
        test_share_budget(base, uploads_dir)
        test_community_feed()
    finally:
        server.shutdown()
        shutil.rmtree(data_dir, ignore_errors=True)
    print("")
    if FAILED:
        print("局域网大画布回归测试失败 %d 项" % FAILED)
        return 1
    print("局域网大画布回归测试全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
