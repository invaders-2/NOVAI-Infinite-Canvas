#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨机克隆 / 生成链路的「私网素材」回归测试。

背景（用户实测）：A 把画布分享给 B，B 克隆后用自己的模型生成失败：
  reference image[0]: refusing to fetch image from http://<A 的局域网 IP>:3000/...?token=***
上游只接受公网地址。要求：
  1) 下载对方素材时用「对方的口令」（URL 自带优先 / 分享链接里的其次），不能替换成 B 自己的口令；
  2) 克隆必须把媒体落到本机，失败的节点要标成素材缺失并带回原因，不能静默保留对方地址；
  3) 生成前兜底：参考素材里的私网地址先落本机，再走后续上传 / 公网化链路。

不依赖 main.py：把 server.routes.deps 绑成测试桩，媒体用本地 HTTP 线程模拟「对方的电脑」，
并记录每次请求带来的口令，断言 B 自己的口令不会被发给对方。
用法：venv/bin/python tests/test_canvas_share_lan_media.py
"""
from __future__ import annotations

import asyncio
import base64
import copy
import json
import os
import shutil
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.routes.deps import deps  # noqa: E402
from server.routes import canvas_share as share  # noqa: E402

FAILED = 0
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
PEER_TOKEN = "peer-token-aaaaaaaaaaaaaaaa-1234"
MY_TOKEN = "my-own-token-bbbbbbbbbbbbbb-5678"


class MediaHandler(BaseHTTPRequestHandler):
    """模拟分享者的电脑：/output/ok*.png 要对方口令；记录收到过的口令。"""

    seen_tokens = []
    ok_requests = 0

    def log_message(self, *args):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        token = str((query.get("token") or [""])[0] or self.headers.get("X-NOVAI-Token", ""))
        MediaHandler.seen_tokens.append(token)
        if parsed.path.startswith("/output/ok") or parsed.path.startswith("/output/settings"):
            if token != PEER_TOKEN:
                self.send_response(401)
                self.end_headers()
                return
            MediaHandler.ok_requests += 1
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG_BYTES)))
            self.end_headers()
            self.wfile.write(PNG_BYTES)
            return
        self.send_response(404)
        self.end_headers()


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-share-lan-")
    canvases = {}

    def load_canvas(canvas_id):
        if canvas_id not in canvases:
            raise HTTPException(status_code=404, detail="画布不存在")
        return copy.deepcopy(canvases[canvas_id])

    def save_canvas(canvas):
        canvas["updated_at"] = share.now_ms()
        canvases[canvas["id"]] = copy.deepcopy(canvas)

    deps.bind(
        DATA_DIR=data_dir,
        OUTPUT_DIR=os.path.join(data_dir, "output"),
        ASSETS_DIR=os.path.join(data_dir, "assets"),
        BASE_DIR=ROOT,
        LOAD_CANVAS=load_canvas,
        SAVE_CANVAS=save_canvas,
        REQUIRE_CANVAS_ACCESS=lambda canvas, request, need: None,
        REQUEST_AUTH_USER=lambda request: None,
        # B 本机局域网鉴权是开着的，口令和对方不一样：绝不能用它去下载对方素材
        LAN_AUTH_ENABLED=lambda: True,
        LOAD_LAN_TOKEN=lambda: MY_TOKEN,
    )
    os.makedirs(os.path.join(data_dir, "output"), exist_ok=True)
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
        if ct.startswith("audio/"):
            return "audio", ".mp3"
        return None, ""

    deps.bind(
        _local_upload_safe_folder=safe_folder,
        _local_upload_kind_ext=kind_ext,
        _local_upload_item=lambda rel: {"url": "/assets/uploads/" + str(rel).lstrip("/"), "file": str(rel)},
        _sniff_image_ext_bytes=lambda head: ".png" if head else "",
        _SSL_CONTEXT=True,
        _TRUST_ENV=False,
    )

    server = ThreadingHTTPServer(("127.0.0.1", 0), MediaHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    share_link = base + "/static/canvas.html?share=share-token-abcdefghijklmnop&token=" + PEER_TOKEN

    app = FastAPI()
    app.include_router(share.router)
    client = TestClient(app)

    # 1. 私网地址识别
    for value, expected in [
        ("http://10.25.128.164:3000/output/a.png", True),
        ("http://172.18.2.143:3000/output/a.png", True),
        ("http://192.168.1.9:3000/output/a.png", True),
        ("http://127.0.0.1:3948/output/a.png", True),
        ("http://localhost/x.png", True),
        ("http://my-laptop.local/x.png", True),
        ("http://8.8.8.8/x.png", False),
        ("https://example.com/a.png", False),
        ("/output/local.png", False),
        ("data:image/png;base64,AAAA", False),
    ]:
        check("私网地址识别 " + value.split("/")[2] if "://" in value else "本地/非 http 不处理 " + value,
              share.is_private_media_url(value) is expected, str(share.is_private_media_url(value)))

    # 2. 口令：URL 自带的对方口令必须优先，不能被 B 自己的口令覆盖
    url_with_token = base + "/output/ok1.png?token=" + PEER_TOKEN
    MediaHandler.seen_tokens = []
    localized = client.post("/api/canvas-share/localize-media",
                            json={"urls": [url_with_token], "share_url": base + "/static/canvas.html?share=x&token=wrong-token"})
    body = localized.json()
    check("URL 自带对方口令时下载成功", body.get("copied") == 1, json.dumps(body, ensure_ascii=False))
    check("下载对方素材从不发 B 自己的口令", MY_TOKEN not in MediaHandler.seen_tokens, str(MediaHandler.seen_tokens))

    # 3. URL 没口令、分享链接里有时，用分享链接里的对方口令
    MediaHandler.seen_tokens = []
    via_share = client.post("/api/canvas-share/localize-media",
                            json={"urls": [base + "/output/ok2.png"], "share_url": share_link})
    check("分享链接里的对方口令可用", via_share.json().get("copied") == 1,
          json.dumps(via_share.json(), ensure_ascii=False))
    check("分享链接口令路径也不发 B 自己的口令", MY_TOKEN not in MediaHandler.seen_tokens, str(MediaHandler.seen_tokens))

    # 4. 两边都没口令：明确报「口令失效，请让对方重新分享」，且不发 B 的口令
    MediaHandler.seen_tokens = []
    no_token = client.post("/api/canvas-share/localize-media",
                           json={"urls": [base + "/output/ok3.png"], "share_url": ""})
    no_token_body = no_token.json()
    first_error = str((no_token_body.get("items") or [{}])[0].get("error") or "")
    check("缺口令时下载失败", no_token_body.get("failed") == 1, json.dumps(no_token_body, ensure_ascii=False))
    check("缺口令文案让人重新分享", "重新分享" in first_error, first_error)
    check("缺口令时也没发 B 自己的口令", MY_TOKEN not in MediaHandler.seen_tokens, str(MediaHandler.seen_tokens))

    # 5. 生成侧兜底：私网参考素材先落本机 + 缓存命中
    MediaHandler.ok_requests = 0
    refs = [{"url": url_with_token, "name": "参考图", "role": "", "kind": "image", "mime": ""},
            {"url": "/output/local.png", "name": "本机图"},
            {"url": "https://example.com/public.png", "name": "公网图"}]
    localized_refs = asyncio.run(share.localize_private_reference_urls(refs))
    first_local = str(localized_refs[0].get("url") or "")
    check("生成前私网参考图变成本机地址", first_local.startswith("/assets/uploads/"), first_local)
    check("本机相对地址不动", localized_refs[1].get("url") == "/output/local.png")
    check("公网地址不动", localized_refs[2].get("url") == "https://example.com/public.png")
    check("本机真的落盘", os.path.isfile(os.path.join(uploads_dir, os.path.basename(first_local))), first_local)
    hits_after_first = MediaHandler.ok_requests
    again = asyncio.run(share.localize_private_reference_urls([{"url": url_with_token}]))
    check("重复取同一素材命中缓存不重复下载",
          str(again[0].get("url") or "") == first_local and MediaHandler.ok_requests == hits_after_first,
          str(hits_after_first) + " -> " + str(MediaHandler.ok_requests))
    try:
        asyncio.run(share.localize_private_reference_urls([{"url": base + "/output/ok4.png"}]))
        bad_guard = ""
    except HTTPException as exc:
        bad_guard = str(exc.detail)
    check("生成前取不到对方素材时明确报错", "重新分享" in bad_guard or "不在线" in bad_guard, bad_guard)

    # 6. 克隆：媒体落到本机（含 settings），失败节点标素材缺失并带回原因
    good_url = base + "/output/ok5.png?token=" + PEER_TOKEN
    bad_url = base + "/output/missing.png"
    canvases["canvas-lan"] = {
        "id": "canvas-lan", "title": "跨机克隆", "icon": "🧩", "kind": "classic",
        "created_at": 1, "updated_at": 1,
        "nodes": [
            {"id": "ok", "kind": "image", "x": 0, "y": 0, "w": 320, "h": 320, "text": "",
             "data": {"gen": {"title": "参考图", "hist": [{"url": good_url}], "hi": 0}}},
            {"id": "bad", "kind": "image", "x": 400, "y": 0, "w": 320, "h": 320, "text": "",
             "url": bad_url, "originalUrl": bad_url, "title": "丢失的图"},
        ],
        "connections": [],
        "settings": {"reference": {"url": base + "/output/settings.png?token=" + PEER_TOKEN}},
    }
    client.post("/api/canvas-share", json={"canvas_id": "canvas-lan", "permission": "clone", "expires_in_days": 7})
    token = (share.find_share_for_canvas("canvas-lan") or {}).get("token") or ""
    cloned = client.post("/api/canvas-share/" + token + "/clone")
    cloned_body = cloned.json()
    check("克隆 200", cloned.status_code == 200, str(cloned.status_code))
    saved = canvases.get(str(cloned_body.get("canvas_id") or "")) or {}
    ok_node = next((n for n in (saved.get("nodes") or []) if n.get("id") == "ok"), {})
    bad_node = next((n for n in (saved.get("nodes") or []) if n.get("id") == "bad"), {})
    ok_hist = str((((ok_node.get("data") or {}).get("gen") or {}).get("hist") or [{}])[0].get("url") or "")
    check("克隆后参考图指向本机", ok_hist.startswith("/assets/uploads/"), ok_hist)
    check("克隆后不含对方主机", base not in json.dumps(ok_node, ensure_ascii=False))
    settings_url = str((((saved.get("settings") or {}).get("reference") or {}).get("url")) or "")
    check("settings 里的媒体也落到本机", settings_url.startswith("/assets/uploads/"), settings_url)
    missing = ((bad_node.get("data") or {}).get("mediaMissing") or [])
    check("失败节点标成素材缺失", bool(missing) and str(missing[0].get("url")) == bad_url, json.dumps(missing, ensure_ascii=False))
    check("克隆响应带失败清单与原因", bool(cloned_body.get("failed_items"))
          and "素材缺失" in str(cloned_body.get("warning") or ""), json.dumps(cloned_body, ensure_ascii=False)[:300])
    check("克隆响应说明是哪个节点", any(str(item.get("node_id")) == "bad" for item in (cloned_body.get("missing") or [])),
          json.dumps(cloned_body.get("missing"), ensure_ascii=False)[:300])

    server.shutdown()
    shutil.rmtree(data_dir, ignore_errors=True)
    print("")
    if FAILED:
        print("跨机克隆私网素材测试失败 %d 项" % FAILED)
        return 1
    print("跨机克隆私网素材测试全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
