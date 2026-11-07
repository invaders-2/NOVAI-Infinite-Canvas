#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T49/T52 局域网分享后端单测：存取 / 权限 / 过期 / 撤销 / 克隆 / 路径脱敏 / 媒体本地化。

不依赖 main.py：把依赖用 server.routes.deps 绑成测试桩，用 fastapi TestClient 跑真实路由；
媒体用一个本地 HTTP 线程服务当「分享者的机器」（校验口令、404、超大文件）。
用法：venv/bin/python tests/test_canvas_share_store.py（node tests/test_novai_canvas_share.js 会自动调用）
"""
from __future__ import annotations

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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.routes.deps import deps  # noqa: E402
from server.routes import canvas_share as share  # noqa: E402

FAILED = 0

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
MEDIA_TOKEN = "peer-lan-token-1234567890"


class MediaHandler(BaseHTTPRequestHandler):
    """模拟分享者的机器：/output/a.png 要口令；/output/missing.png 404；/output/big.png 报 60MB。"""

    def log_message(self, *args):  # 安静
        pass

    def do_GET(self):
        parsed = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        token = str((query.get("token") or [""])[0] or self.headers.get("X-NOVAI-Token", ""))
        if parsed.path in ("/output/a.png", "/output/b.png", "/output/c.png"):
            if token != MEDIA_TOKEN:
                self.send_response(401)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG_BYTES)))
            self.end_headers()
            self.wfile.write(PNG_BYTES)
            return
        if parsed.path == "/output/big.png":
            if token != MEDIA_TOKEN:
                self.send_response(401)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(60 * 1024 * 1024))
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-share-test-")
    canvases = {}

    source = {
        "id": "canvas-source",
        "title": "主图工作流",
        "icon": "🧩",
        "kind": "classic",
        "created_at": 1700000000000,
        "updated_at": 1700000000000,
        "nodes": [
            {
                "id": "n1", "kind": "image", "x": 0, "y": 0, "w": 320, "h": 320, "text": "",
                "data": {"gen": {"title": "主图", "prompt": "白色背景商品图",
                                 "params": {"ratio": "1:1"},
                                 "hist": [{"url": os.path.join(data_dir, "output", "shot.png")}], "hi": 0}},
            },
            {"id": "n2", "kind": "text", "x": 400, "y": 0, "w": 320, "h": 160, "text": "卖点：轻"},
        ],
        "connections": [{"id": "e1", "from": "n2", "to": "n1"}],
        "viewport": {"x": 0, "y": 0, "scale": 1},
    }
    canvases[source["id"]] = copy.deepcopy(source)

    def load_canvas(canvas_id):
        from fastapi import HTTPException
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
        _DATA_ROOT=os.path.dirname(data_dir),
        LOAD_CANVAS=load_canvas,
        SAVE_CANVAS=save_canvas,
        REQUIRE_CANVAS_ACCESS=lambda canvas, request, need: None,
        REQUEST_AUTH_USER=lambda request: None,
        LAN_AUTH_ENABLED=lambda: False,
        LOAD_LAN_TOKEN=lambda: "",
    )

    app = FastAPI()
    app.include_router(share.router)
    client = TestClient(app)

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

    media_server = ThreadingHTTPServer(("127.0.0.1", 0), MediaHandler)
    media_port = media_server.server_address[1]
    threading.Thread(target=media_server.serve_forever, daemon=True).start()
    media_base = "http://127.0.0.1:%d" % media_port
    # 服务端 clone 取自己 /output 绝对地址时会用本机局域网口令；测试里让它等于媒体服务的口令
    deps.bind(LAN_AUTH_ENABLED=lambda: True, LOAD_LAN_TOKEN=lambda: MEDIA_TOKEN)

    # 1. 生成 view 分享
    created = client.post("/api/canvas-share", json={"canvas_id": "canvas-source", "permission": "view", "expires_in_days": 7, "owner_name": "老板"})
    check("创建 view 分享 200", created.status_code == 200, str(created.status_code))
    link = created.json().get("share") or {}
    token = str(link.get("token") or "")
    check("token 长度 >= 24", len(token) >= 24, str(len(token)))
    check("返回局域网链接", "/static/canvas.html?share=" in str(link.get("url") or ""), str(link.get("url")))
    check("view 不能克隆", link.get("can_clone") is False and link.get("can_save_template") is False)
    check("分享者昵称落库", link.get("owner_name") == "老板", str(link.get("owner_name")))
    check("store 文件存在", os.path.isfile(os.path.join(data_dir, share.SHARE_FILE_NAME)))

    # 2. 按画布查询
    got = client.get("/api/canvas-share/by-canvas/canvas-source")
    check("按画布查询返回同一 token", (got.json().get("share") or {}).get("token") == token)

    # 3. 公开快照 + 路径脱敏
    snapshot = client.get("/api/canvas-share/" + token)
    check("公开读取 200", snapshot.status_code == 200, str(snapshot.status_code))
    body = snapshot.json()
    node = (body.get("canvas", {}).get("nodes") or [{}])[0]
    raw_url = str(((node.get("data") or {}).get("gen") or {}).get("hist", [{}])[0].get("url") or "")
    check("绝对路径转成相对 URL", raw_url == "/output/shot.png", raw_url)
    check("快照不含本机数据目录", data_dir not in json.dumps(body, ensure_ascii=False))
    check("快照标题", body.get("title") == "主图工作流", str(body.get("title")))
    check("快照连线保留", len(body.get("canvas", {}).get("connections") or []) == 1)

    # 4. view 克隆被拒
    denied = client.post("/api/canvas-share/" + token + "/clone")
    check("view 克隆返回 403", denied.status_code == 403, str(denied.status_code))

    # 5. 提升到 clone / template（同一 token 不变）
    promoted = client.post("/api/canvas-share", json={"canvas_id": "canvas-source", "permission": "clone", "expires_in_days": 7})
    promoted_link = promoted.json().get("share") or {}
    check("更新权限后 token 不变", promoted_link.get("token") == token)
    check("clone 可克隆不可存模板", promoted_link.get("can_clone") is True and promoted_link.get("can_save_template") is False)
    cloned = client.post("/api/canvas-share/" + token + "/clone")
    check("clone 克隆 200", cloned.status_code == 200, str(cloned.status_code))
    clone_body = cloned.json()
    check("克隆是新画布", bool(clone_body.get("canvas_id")) and clone_body.get("canvas_id") != "canvas-source")
    check("克隆标题是『副本』", str(clone_body.get("title") or "").endswith(" 副本"), str(clone_body.get("title")))
    saved_clone = canvases.get(str(clone_body.get("canvas_id"))) or {}
    check("克隆画布节点数一致", len(saved_clone.get("nodes") or []) == 2, str(len(saved_clone.get("nodes") or [])))

    promoted2 = client.post("/api/canvas-share", json={"canvas_id": "canvas-source", "permission": "template", "expires_in_days": 7})
    promoted2_link = promoted2.json().get("share") or {}
    check("template 可克隆 + 可存模板", promoted2_link.get("can_clone") is True and promoted2_link.get("can_save_template") is True)

    # 6. 过期：直接把 expires_at 改到过去
    share.upsert_share("canvas-source", title="主图工作流", permission="view", expires_in_days=1, now=1)
    expired = client.get("/api/canvas-share/" + token)
    check("过期链接返回 410", expired.status_code == 410, str(expired.status_code))
    check("过期链接不返回画布", "canvas" not in (expired.json() or {}))

    # 7. 撤销
    share.upsert_share("canvas-source", title="主图工作流", permission="view", expires_in_days=7)
    revoked = client.delete("/api/canvas-share/by-canvas/canvas-source")
    check("撤销 200", revoked.status_code == 200)
    after = client.get("/api/canvas-share/" + token)
    check("撤销后 404", after.status_code == 404, str(after.status_code))
    check("撤销后查询为空", client.get("/api/canvas-share/by-canvas/canvas-source").json().get("share") is None)

    # 8. 无效 token / 参数
    check("无效 token 404", client.get("/api/canvas-share/not-a-real-token-1234567890").status_code == 404)
    check("非法权限 400", client.post("/api/canvas-share", json={"canvas_id": "canvas-source", "permission": "edit"}).status_code == 400)
    check("非法有效期 400", client.post("/api/canvas-share", json={"canvas_id": "canvas-source", "expires_in_days": 5}).status_code == 400)
    check("不存在的画布 404", client.post("/api/canvas-share", json={"canvas_id": "missing"}).status_code == 404)

    # 9. 媒体本地化（T52）：成功落盘 / 绝对地址重写 / 幂等
    share_url = media_base + "/static/canvas.html?share=media-token-abcdefghijklmnop&token=" + MEDIA_TOKEN
    media_canvas = {
        "id": "canvas-media", "title": "带媒体的画布", "icon": "🧩", "kind": "classic",
        "created_at": 1700000000000, "updated_at": 1700000000000,
        "nodes": [
            {"id": "m1", "kind": "image", "x": 0, "y": 0, "w": 320, "h": 320, "text": "",
             "data": {"gen": {"hist": [{"url": media_base + "/output/a.png", "frame": media_base + "/output/b.png"}], "hi": 0}}},
            {"id": "m2", "kind": "video", "x": 400, "y": 0, "w": 320, "h": 320, "text": "", "url": media_base + "/output/c.png"},
            {"id": "m3", "kind": "image", "x": 0, "y": 400, "w": 320, "h": 320, "text": "", "url": "/output/relative.png"},
        ],
        "connections": [],
    }
    canvases["canvas-media"] = copy.deepcopy(media_canvas)
    client.post("/api/canvas-share", json={"canvas_id": "canvas-media", "permission": "template", "expires_in_days": 7})
    media_token = (share.find_share_for_canvas("canvas-media") or {}).get("token") or ""

    localize = client.post("/api/canvas-share/localize-media", json={"urls": [media_base + "/output/a.png", "/output/relative.png", "data:image/png;base64,AAAA"], "share_url": share_url})
    localize_body = localize.json()
    check("localize 200", localize.status_code == 200, str(localize.status_code))
    check("localize 复制成功计数", localize_body.get("copied") == 1, str(localize_body.get("copied")))
    check("localize 非 http 计 skipped", localize_body.get("skipped") == 2, str(localize_body.get("skipped")))
    localized_url = str((localize_body.get("items") or [{}])[0].get("local") or "")
    check("localize 返回本机相对地址", localized_url.startswith("/assets/uploads/") and "token=" not in localized_url, localized_url)
    check("localize 文件真的落盘", os.path.isfile(os.path.join(uploads_dir, os.path.basename(localized_url))))

    first_clone = client.post("/api/canvas-share/" + media_token + "/clone")
    first_body = first_clone.json()
    first_id = str(first_body.get("canvas_id") or "")
    check("带媒体 clone 200", first_clone.status_code == 200, str(first_clone.status_code))
    # 前面 localize 已经存过 a.png，这里 b/c 新下载 + a 命中缓存，共 3 个可复制
    check("clone 复制所有可复制媒体", int(first_body.get("copied") or 0) == 3, str(first_body.get("copied")))
    check("clone 没有失败", int(first_body.get("failed") or 0) == 0, str(first_body.get("failed")))
    first_nodes = (canvases.get(first_id) or {}).get("nodes") or []
    urls = [str(n.get("url") or "") for n in first_nodes] + [str(((n.get("data") or {}).get("gen") or {}).get("hist", [{}])[0].get("url") or "") for n in first_nodes]
    urls = [u for u in urls if u]
    check("clone 后媒体地址指向本机", all(u.startswith("/assets/uploads/") or u.startswith("/output/") for u in urls), json.dumps(urls))
    check("clone 后不含对方主机", media_base not in json.dumps(first_nodes, ensure_ascii=False))
    file_count_first = len([name for name in os.listdir(uploads_dir) if name.startswith("up_")])

    second_clone = client.post("/api/canvas-share/" + media_token + "/clone")
    second_body = second_clone.json()
    file_count_second = len([name for name in os.listdir(uploads_dir) if name.startswith("up_")])
    check("重复 clone 仍成功", second_clone.status_code == 200)
    check("重复 clone 命中缓存不重复落盘", file_count_second == file_count_first, str(file_count_first) + " -> " + str(file_count_second))
    first_local = str((localize_body.get("items") or [{}])[0].get("local") or "")
    check("重复 clone 节点地址一致", str((((canvases.get(str(second_body.get("canvas_id") or "")) or {}).get("nodes") or [{}])[0].get("data", {}).get("gen", {}).get("hist", [{}])[0].get("url") or "")) == first_local, first_local)

    # 10. 失败不静默：404 / 超大 / 口令错 / 超总预算
    canvases["canvas-media-fail"] = {
        "id": "canvas-media-fail", "title": "失败用例", "icon": "🧩", "kind": "classic",
        "created_at": 1, "updated_at": 1,
        "nodes": [
            {"id": "f1", "kind": "image", "x": 0, "y": 0, "w": 320, "h": 320, "text": "",
             "data": {"gen": {"hist": [{"url": media_base + "/output/a.png"}], "hi": 0}}},
            {"id": "f2", "kind": "image", "x": 400, "y": 0, "w": 320, "h": 320, "text": "", "url": media_base + "/output/missing.png"},
            {"id": "f3", "kind": "image", "x": 800, "y": 0, "w": 320, "h": 320, "text": "", "url": media_base + "/output/big.png"},
        ],
        "connections": [],
    }
    client.post("/api/canvas-share", json={"canvas_id": "canvas-media-fail", "permission": "template", "expires_in_days": 7})
    fail_token = (share.find_share_for_canvas("canvas-media-fail") or {}).get("token") or ""
    fail_clone = client.post("/api/canvas-share/" + fail_token + "/clone")
    fail_body = fail_clone.json()
    check("失败用例 clone 仍 200", fail_clone.status_code == 200)
    check("失败计数 = 2", int(fail_body.get("failed") or 0) == 2, str(fail_body.get("failed")))
    fail_nodes = (canvases.get(str(fail_body.get("canvas_id") or "")) or {}).get("nodes") or []
    by_id = {str(n.get("id")): n for n in fail_nodes}
    check("失败节点保留原地址", str(by_id.get("f2", {}).get("url") or "") == media_base + "/output/missing.png")
    check("超大文件不动地址", str(by_id.get("f3", {}).get("url") or "") == media_base + "/output/big.png")

    bad_token = client.post("/api/canvas-share/localize-media", json={"urls": [media_base + "/output/a.png"], "share_url": media_base + "/static/canvas.html?share=x&token=wrong-token-value"})
    bad_body = bad_token.json()
    check("口令错计 failed", int(bad_body.get("failed") or 0) == 1, str(bad_body.get("failed")))
    check("口令错文案明确", "口令" in str((bad_body.get("items") or [{}])[0].get("error") or ""), str(bad_body.get("items")))

    original_budget = share.MEDIA_MAX_TOTAL_BYTES
    try:
        share.MEDIA_MAX_TOTAL_BYTES = 1
        budget_body = client.post("/api/canvas-share/localize-media", json={"urls": [media_base + "/output/b.png", media_base + "/output/c.png"], "share_url": share_url}).json()
    finally:
        share.MEDIA_MAX_TOTAL_BYTES = original_budget
    check("超出累计预算被拦下", int(budget_body.get("failed") or 0) >= 1, json.dumps(budget_body.get("items"), ensure_ascii=False))

    media_server.shutdown()
    shutil.rmtree(data_dir, ignore_errors=True)
    print("")
    if FAILED:
        print("分享后端单测失败 %d 项" % FAILED)
        return 1
    print("分享后端单测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
