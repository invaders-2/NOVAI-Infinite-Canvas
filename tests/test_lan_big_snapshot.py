#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T54 大快照不截断：lan 代取流式读取 + 分享快照接口无体量上限。

不依赖 main.py：
- 本地线程 HTTP 服务返回 5MB/15MB JSON（模拟对方画布快照），验证默认不限、env 上限、超时；
- 用 FastAPI TestClient 直接调 /api/lan/share-preview 的错误映射（413/504/200）；
- 用 canvas_share 路由造 1000 节点 / ≥15MB 画布，验证 GET 快照完整返回（不被截断）。
用法：venv/bin/python tests/test_lan_big_snapshot.py
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.routes.deps import deps  # noqa: E402
from server.routes import lan_account as lan  # noqa: E402
from server.routes import canvas_share as share  # noqa: E402

FAILED = 0
BIG15 = 15 * 1024 * 1024
BIG5 = 5 * 1024 * 1024


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


class BigHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, payload: bytes, content_type: str = "application/json", delay: float = 0.0):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if delay:
            time.sleep(delay)
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/big15":
            body = json.dumps({"pad": "x" * BIG15, "title": "big15"}).encode("utf-8")
            self._send(body)
        elif path == "/big5":
            body = json.dumps({"pad": "y" * BIG5, "title": "big5"}).encode("utf-8")
            self._send(body)
        elif path == "/small":
            self._send(json.dumps({"title": "small"}).encode("utf-8"))
        elif path == "/slow":
            body = json.dumps({"pad": "z" * 4096, "title": "slow"}).encode("utf-8")
            self._send(body, delay=2.0)
        else:
            self.send_response(404)
            self.end_headers()


def make_canvas_snapshot_large(nodes: int = 1000, text_len: int = 16000) -> dict:
    rows = []
    for index in range(nodes):
        rows.append({
            "id": "n%d" % index,
            "kind": "text",
            "x": index * 10 % 4000,
            "y": (index // 20) * 180,
            "w": 320,
            "h": 160,
            "text": ("%05d " % index) + ("长文本提示词" * (text_len // 6)),
            "data": {"gen": {"title": "节点 %d" % index, "prompt": "prompt-%d" % index, "hist": [{"text": "结果 %d" % index}], "hi": 0}},
        })
    return {"id": "big-canvas", "title": "大画布", "icon": "🧩", "kind": "classic", "created_at": 1, "updated_at": 1, "nodes": rows, "connections": []}


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), BigHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port

    os.environ.pop("NOVAI_LAN_JSON_MAX_BYTES", None)
    started = time.monotonic()
    status, body = asyncio.run(lan._http_json_stream(base + "/big15", "GET", {}, base_timeout=10.0))
    elapsed = time.monotonic() - started
    check("默认不限：15MB 快照完整读出", status == 200 and isinstance(body, dict) and len(str(body.get("pad") or "")) == BIG15, "len=%d" % len(str(body.get("pad") or "")))
    check("15MB 代取耗时 < 30s", elapsed < 30.0, "%.2fs" % elapsed)
    print("      15MB 流式读取耗时：%.2fs" % elapsed)

    sync_started = time.monotonic()
    status5, body5 = lan._http_json(base + "/big5", "GET", None, {}, 30.0)
    sync_elapsed = time.monotonic() - sync_started
    check("旧 4MB 边界：5MB 也能完整读出", status5 == 200 and len(str(body5.get("pad") or "")) == BIG5, "len=%d" % len(str(body5.get("pad") or "")))
    print("      5MB 同步读取耗时：%.2fs" % sync_elapsed)

    os.environ["NOVAI_LAN_JSON_MAX_BYTES"] = str(1024 * 1024)
    try:
        try:
            asyncio.run(lan._http_json_stream(base + "/big5", "GET", {}, base_timeout=10.0))
            check("env 上限 1MB 时抛 LanResponseTooLarge", False, "没有抛异常")
        except lan.LanResponseTooLarge:
            check("env 上限 1MB 时抛 LanResponseTooLarge", True)
        try:
            lan._http_json(base + "/big5", "GET", None, {}, 10.0)
            check("env 上限对同步读取同样生效", False, "没有抛异常")
        except lan.LanResponseTooLarge:
            check("env 上限对同步读取同样生效", True)
    finally:
        os.environ.pop("NOVAI_LAN_JSON_MAX_BYTES", None)

    try:
        asyncio.run(lan._http_json_stream(base + "/slow", "GET", {}, base_timeout=0.3))
        check("慢响应按无进展超时抛 LanPeerTimeout", False, "没有抛异常")
    except lan.LanPeerTimeout:
        check("慢响应按无进展超时抛 LanPeerTimeout", True)

    # 路由错误映射：413 / 504 / 200 / 测试钩子优先
    app = FastAPI()
    app.include_router(lan.router)
    client = TestClient(app)
    good = base + "/static/canvas.html?share=share_token_1234567890&token=x"

    original = lan._http_json_stream

    async def fake_too_large(*args, **kwargs):
        raise lan.LanResponseTooLarge("响应超过 1 MB")

    async def fake_timeout(*args, **kwargs):
        raise lan.LanPeerTimeout("读取对方响应超时")

    async def fake_ok(*args, **kwargs):
        return 200, {"title": "大画布", "canvas": {"nodes": [1, 2, 3]}}

    try:
        lan._http_json_stream = fake_too_large
        resp = client.get("/api/lan/share-preview", params={"url": good})
        check("路由映射 413", resp.status_code == 413 and "分享快照上限" in str(resp.json().get("detail")), str(resp.status_code))
        lan._http_json_stream = fake_timeout
        resp = client.get("/api/lan/share-preview", params={"url": good})
        check("路由映射 504", resp.status_code == 504 and "超时" in str(resp.json().get("detail")), str(resp.status_code))
        lan._http_json_stream = fake_ok
        resp = client.get("/api/lan/share-preview", params={"url": good})
        check("路由正常 200", resp.status_code == 200 and (resp.json().get("snapshot") or {}).get("title") == "大画布", str(resp.status_code))
    finally:
        lan._http_json_stream = original

    hook = lambda url, method, payload, headers, timeout: (404, {"detail": "hook"})
    deps.bind(LAN_HTTP_JSON=hook)
    try:
        resp = client.get("/api/lan/share-preview", params={"url": good})
        check("LAN_HTTP_JSON 钩子仍优先", resp.status_code == 404, str(resp.status_code))
    finally:
        deps._bound.pop("LAN_HTTP_JSON", None)  # noqa: SLF001 - 测试清理

    # 分享快照接口本身不截断：1000 节点 / ≥15MB 画布完整返回
    data_dir = tempfile.mkdtemp(prefix="novai-share-big-")
    canvas = make_canvas_snapshot_large()
    deps.bind(
        DATA_DIR=data_dir,
        LOAD_CANVAS=lambda canvas_id: copy.deepcopy(canvas),
        SAVE_CANVAS=lambda value: None,
        REQUIRE_CANVAS_ACCESS=lambda value, request, need: None,
        REQUEST_AUTH_USER=lambda request: None,
        LAN_AUTH_ENABLED=lambda: False,
        LOAD_LAN_TOKEN=lambda: "",
    )
    share_app = FastAPI()
    share_app.include_router(share.router)
    share_client = TestClient(share_app)
    created = share_client.post("/api/canvas-share", json={"canvas_id": "big-canvas", "permission": "clone", "expires_in_days": 7})
    token = str((created.json().get("share") or {}).get("token") or "")
    before = time.monotonic()
    snapshot = share_client.get("/api/canvas-share/" + token)
    snapshot_elapsed = time.monotonic() - before
    payload = snapshot.content
    body = snapshot.json()
    node_count = len((body.get("canvas") or {}).get("nodes") or [])
    print("      快照体积：%.1f MB；快照接口耗时：%.2fs" % (len(payload) / 1048576.0, snapshot_elapsed))
    check("大画布快照 200", snapshot.status_code == 200, str(snapshot.status_code))
    check("快照体积 ≥ 15MB", len(payload) >= 15 * 1024 * 1024, "%.1f MB" % (len(payload) / 1048576.0))
    check("快照节点数 1000 完整", node_count == 1000, str(node_count))
    check("快照第一个节点文本未被截断", len(str(((body.get("canvas") or {}).get("nodes") or [{}])[0].get("text") or "")) >= 16000, str(len(str(((body.get("canvas") or {}).get("nodes") or [{}])[0].get("text") or ""))))
    shutil.rmtree(data_dir, ignore_errors=True)

    server.shutdown()
    print("")
    if FAILED:
        print("大快照测试失败 %d 项" % FAILED)
        return 1
    print("大快照测试全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
