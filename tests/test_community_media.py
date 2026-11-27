#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区发布「素材打包」单测（pytest）。

守的是真实故障：作者画布里的图 / 视频 / 音频发布后别人打开全是空白，作品详情「媒体 0 张」。
覆盖：四类引用真进包（站内文件 / 社区媒体地址 / http(s) / data:）、全缺时 422、
allow_partial 部分发布、克隆清死链、发布弹窗的来源预览口径。

远端下载用 COMMUNITY_REMOTE_FETCH 桩，不出网；数据目录用临时目录，绝不碰日常数据。
用法：venv/bin/python -m pytest tests/test_community_media.py -q
"""
from __future__ import annotations

import base64
import contextlib
import copy
import json
import os
import shutil
import sys
import tempfile
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.community import packager, store, transport  # noqa: E402
from server.routes import community  # noqa: E402
from server.routes.deps import deps  # noqa: E402

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode("ascii")
DEAD_DATA_URL = "data:image/svg+xml;base64,PHN2Zy8+"
PEER_ID = "999999-zzzzzz"
DEAD_FILE = "/Users/nobody/Desktop/dead-shot.png"
PEER_BASE = "http://peer-a:3931"
REMOTE_URL = "https://cdn.example.com/tmp/gen-1.png?sign=abc"
CLONE_ITEM_ID = "111111-aaaaaa"


class _Env(object):
    """临时数据目录 + TestClient + 桩传输。"""

    def __init__(self) -> None:
        self.canvases = {}
        self.remote_calls = []
        self.remote_dead = set()
        self.peer_items = {}
        self.peer_payloads = {}
        self.peer_media = {}
        self.prompts = {"active_library_id": "system", "libraries": [
            {"id": "system", "name": "系统提示词库", "type": "prompt", "categories": [], "items": []}]}
        self.data_dir = tempfile.mkdtemp(prefix="novai-community-media-")
        self.output_dir = os.path.join(self.data_dir, "output")
        self.assets_dir = os.path.join(self.data_dir, "assets")
        os.makedirs(self.output_dir, exist_ok=True)
        os.makedirs(self.assets_dir, exist_ok=True)
        # 先把 deps 绑到临时目录，之后所有 store.* 路径写入都落在临时目录里（不碰日常数据）
        self._bind()
        with open(os.path.join(self.output_dir, "shot.png"), "wb") as handle:
            handle.write(PNG_BYTES)
        with open(os.path.join(self.assets_dir, "upload.png"), "wb") as handle:
            handle.write(PNG_BYTES)
        # 别人作品的缓存素材（克隆来的画布引用的就是这种地址）
        cache_media = os.path.join(store.cache_item_dir(PEER_ID), "media")
        os.makedirs(cache_media, exist_ok=True)
        for name in ("shared.png", "shared2.png"):
            with open(os.path.join(cache_media, name), "wb") as handle:
                handle.write(PNG_BYTES)
        self.client = TestClient(self._app())

    # ---------------------------------------------------------------- 桩
    def _bind(self) -> None:
        deps.bind(
            DATA_DIR=self.data_dir, OUTPUT_DIR=self.output_dir, ASSETS_DIR=self.assets_dir,
            BASE_DIR=ROOT,
            LOAD_CANVAS=self.load_canvas, SAVE_CANVAS=self.save_canvas, NEW_CANVAS=self.new_canvas,
            load_prompt_libraries=lambda: copy.deepcopy(self.prompts),
            save_prompt_libraries=self.save_prompts,
            normalize_prompt_library_item=lambda item: dict(item),
            COMMUNITY_NODES=self.community_nodes,
            COMMUNITY_HTTP=self.fake_http,
            COMMUNITY_REMOTE_FETCH=self.fake_remote,
            CURRENT_CANVAS_OWNER_ID=lambda request: 42,
            _local_upload_safe_folder=lambda rel: (
                str(rel or "").strip("/"),
                os.path.join(self.assets_dir, "uploads", str(rel or "").strip("/"))),
            _local_upload_kind_ext=lambda name, ctype: (
                ("image", ".png") if "png" in str(ctype) or str(name).endswith(".png") else (None, "")),
            _local_upload_item=lambda rel: {"url": "/assets/uploads/" + str(rel).lstrip("/")},
            _sniff_image_ext_bytes=lambda head: ".png" if head else "",
        )
        community.RATE_READ_PER_MIN = 5000
        community._RATE.clear()
        transport.clear_feed_cache()

    def _app(self) -> FastAPI:
        app = FastAPI()
        app.include_router(community.router)
        return app

    def fake_remote(self, url, dest_path, max_bytes):
        self.remote_calls.append(url)
        if url in self.remote_dead:
            return "下载失败：连接超时"
        with open(dest_path, "wb") as handle:
            handle.write(PNG_BYTES)
        return ""

    def community_nodes(self):
        return [{"id": "peer-account-a", "nickname": "同事 A", "base": PEER_BASE,
                 "token": "peer-token-1234567890", "online": True}]

    def fake_http(self, method, url, headers, body, timeout):
        path = urllib.parse.urlsplit(url).path
        if path == "/api/community/public/items":
            return 200, json.dumps({"author": {"account_id": "peer-account-a", "nickname": "同事 A"},
                                    "items": list(self.peer_items.values())}).encode("utf-8")
        if path.startswith("/api/community/public/items/"):
            rest = path[len("/api/community/public/items/"):]
            parts = rest.split("/")
            item_id = parts[0]
            if item_id not in self.peer_items:
                return 404, b"{}"
            if len(parts) == 1:
                return 200, json.dumps({"item": self.peer_items[item_id],
                                        "payload": self.peer_payloads.get(item_id, {})}).encode("utf-8")
            if parts[1] == "package":
                item = self.peer_items[item_id]
                package = {
                    "schema": 1, "item_id": item_id, "kind": item["kind"], "version": item["version"],
                    "title": item["title"], "desc": "", "tags": [], "category": "",
                    "cover": "cover.webp", "author": item["author"], "allow_clone": True,
                    "include_media": True, "created_at": item["created_at"],
                    "updated_at": item["updated_at"], "meta": item["meta"],
                    "payload": self.peer_payloads.get(item_id, {}),
                }
                return 200, json.dumps({"package": package}).encode("utf-8")
        if path.startswith("/api/community/public/media/"):
            rest = urllib.parse.unquote(path[len("/api/community/public/media/"):])
            content = self.peer_media.get(rest)
            return (200, content) if content else (404, b"")
        if path.endswith("/event"):
            return 200, b'{"ok": true}'
        return 404, b""

    def load_canvas(self, canvas_id):
        if canvas_id not in self.canvases:
            raise HTTPException(status_code=404, detail="画布不存在")
        return copy.deepcopy(self.canvases[canvas_id])

    def save_canvas(self, canvas):
        self.canvases[canvas["id"]] = copy.deepcopy(canvas)

    def new_canvas(self, title):
        made = {"id": "clone-%d" % (len(self.canvases) + 1), "title": title, "kind": "classic",
                "nodes": [], "connections": [], "created_at": store.now_ms(),
                "updated_at": store.now_ms()}
        self.save_canvas(made)
        return copy.deepcopy(made)

    def save_prompts(self, data):
        self.prompts.clear()
        self.prompts.update(copy.deepcopy(data))
        return copy.deepcopy(self.prompts)

    # ---------------------------------------------------------------- 便捷
    def add_canvas(self, canvas_id, nodes, title="测试画布"):
        self.canvases[canvas_id] = {
            "id": canvas_id, "title": title, "icon": "layers", "kind": "classic",
            "created_at": store.now_ms(), "updated_at": store.now_ms(),
            "nodes": nodes, "connections": [], "viewport": {"x": 0, "y": 0, "scale": 1},
            "settings": {},
        }
        return canvas_id

    def publish(self, canvas_id, **extra):
        body = {"kind": "canvas", "source_id": canvas_id, "title": "发布测试", "include_media": True}
        body.update(extra)
        return self.client.post("/api/community/publish", json=body)

    def package_payload(self, item_id):
        package = packager.read_package(item_id) or {}
        return package.get("payload") or {}

    def package_names(self, item_id):
        media_dir = os.path.join(store.package_dir(item_id), "media")
        return sorted(os.listdir(media_dir)) if os.path.isdir(media_dir) else []

    def close(self):
        shutil.rmtree(self.data_dir, ignore_errors=True)


@contextlib.contextmanager
def community_env():
    env = _Env()
    try:
        yield env
    finally:
        community._RATE.clear()
        env.close()


def _node(node_id, **fields):
    node = {"id": node_id, "kind": "image", "x": 0, "y": 0, "w": 320, "h": 320, "text": ""}
    node.update(fields)
    return node


def _hist_url(node):
    hist = (((node or {}).get("data") or {}).get("gen") or {}).get("hist") or [{}]
    return str((hist[0] or {}).get("url") or "")


def _without_missing(value):
    """去掉「素材缺失」提示子树：里面的原地址是给人看的诊断信息，不是可渲染引用。"""
    if isinstance(value, dict):
        return {key: _without_missing(item) for key, item in value.items()
                if key not in ("mediaMissing", "media_missing")}
    if isinstance(value, list):
        return [_without_missing(item) for item in value]
    return value


def test_publish_packages_all_four_url_shapes():
    """站内文件 / 两类社区媒体地址 / http(s) / data: 都要真进包，payload 里不留死链。"""
    with community_env() as env:
        env.add_canvas("canvas-four", [
            _node("n1", url=os.path.join(env.output_dir, "shot.png")),
            _node("n2", url="/api/community/media/" + PEER_ID + "/shared.png"),
            _node("n3", url="/api/community/public/media/" + PEER_ID + "/shared2.png"),
            _node("n4", url=REMOTE_URL),
            _node("n5", url=PNG_DATA_URL),
            # 时间线缩略图：不是 url 字段，但也是真媒体（MEDIA_KEYS 补的字段）
            _node("n6", kind="timeline", clips=[{"id": "c1", "url": "/assets/upload.png",
                                                 "mediaKind": "image", "inPoint": 0, "outPoint": 1,
                                                 "order": 0, "thumb": "/assets/upload.png"}]),
            # 生成历史 + 视频封面 + 自参考图（同一份素材，必须去重成一条）
            _node("n7", data={"gen": {"title": "图", "hi": 0, "hist": [
                {"url": "/output/shot.png", "frame": "/assets/upload.png",
                 "meta": {"selfSrc": "/output/shot.png"}}]}}),
        ])
        published = env.publish("canvas-four")
        assert published.status_code == 200, published.text[:400]
        body = published.json()
        item_id = str((body.get("item") or {}).get("id") or "")
        assert store.valid_item_id(item_id)
        report = body.get("media") or {}
        # 6 个去重后的引用：/output/shot.png、/assets/upload.png、两个社区媒体地址、远程、data:
        assert report.get("packaged") == 6, report
        assert report.get("missing") == 0, report
        assert report.get("total") == 6
        assert report.get("include_media") is True
        assert body.get("media_incomplete") is False
        # 远程确实走服务端下载了（不是静默跳过）
        assert REMOTE_URL in env.remote_calls
        names = env.package_names(item_id)
        assert len(names) == 6, names
        # payload 里每个媒体引用都落在包前缀下，且不再有作者机器路径 / 远程临时链接 / base64
        payload_json = json.dumps(env.package_payload(item_id), ensure_ascii=False)
        assert "/api/community/public/media/" + item_id + "/" in payload_json
        assert "/output/" not in payload_json
        assert "/assets/" not in payload_json
        assert "cdn.example.com" not in payload_json
        assert "data:image" not in payload_json
        assert "/api/community/media/" not in payload_json
        # 包里的素材能对外取到，且是图片类型（不是 octet-stream）
        served = env.client.get("/api/community/public/media/" + item_id + "/" + names[0])
        assert served.status_code == 200
        assert served.content == PNG_BYTES
        assert served.headers.get("content-type", "").startswith("image/")
        item = next(entry for entry in store.load_items() if entry["id"] == item_id)
        assert int((item.get("meta") or {}).get("media") or 0) == 6
        assert int((item.get("media_report") or {}).get("packaged") or 0) == 6


def test_publish_rejects_when_no_media_can_be_packaged():
    """有引用但一个都打不进包 → 422，detail 说清多少张图 / 多少段视频 + 两条出路。"""
    with community_env() as env:
        env.add_canvas("canvas-dead", [
            _node("n1", url="blob:http://127.0.0.1:3000/dead-blob"),
            _node("n2", url=DEAD_FILE),
            _node("n3", url=DEAD_DATA_URL),
            _node("n4", url="relative/path.png"),
            _node("n5", url="/output/gone.png"),
        ])
        rejected = env.publish("canvas-dead")
        assert rejected.status_code == 422, rejected.text[:400]
        detail = str((rejected.json() or {}).get("detail") or "")
        assert "4 张图片" in detail, detail          # dead.png / relative / gone.png / svg
        assert "1 个其它素材" in detail, detail      # blob:
        assert "不含素材发布" in detail
        assert "仍然发布" in detail
        assert "没能打进发布包" in detail
        # 没发出去就不留作品、不留半成品包
        assert all(str(entry.get("source_id")) != "canvas-dead" for entry in store.load_items())
        packages_dir = os.path.join(env.data_dir, "community", "packages")
        assert not os.path.isdir(packages_dir) or not os.listdir(packages_dir)


def test_publish_allow_partial_keeps_report_and_clears_dead_links():
    """allow_partial=true：照发，把明细落到作品上，并把打不进包的引用清空。"""
    with community_env() as env:
        env.add_canvas("canvas-partial", [
            _node("n1", url=os.path.join(env.output_dir, "shot.png")),
            _node("n2", url="blob:http://127.0.0.1:3000/dead-blob"),
            _node("n3", url=DEAD_FILE),
        ])
        published = env.publish("canvas-partial", allow_partial=True)
        assert published.status_code == 200, published.text[:400]
        body = published.json()
        item_id = str((body.get("item") or {}).get("id") or "")
        report = body.get("media") or {}
        assert report.get("packaged") == 1, report
        assert report.get("missing") == 2, report
        assert report.get("total") == 3
        assert body.get("media_incomplete") is True
        codes = sorted(str(entry.get("code") or "") for entry in report.get("items") or [])
        assert codes == ["blob", "outside_mount"], report.get("items")
        reasons = [str(entry.get("reason") or "") for entry in report.get("items") or []]
        assert all(reasons), report.get("items")
        assert set((report.get("codes") or {}).keys()) == {"blob", "outside_mount"}
        # 明细落到作品上（/mine 里读回来）
        mine = env.client.get("/api/community/mine").json()
        stored = next(entry for entry in mine.get("items") or [] if entry.get("id") == item_id)
        assert int((stored.get("media_report") or {}).get("missing") or 0) == 2, stored.get("media_report")
        # 死链清空，好素材改写成包内地址
        payload_json = json.dumps(env.package_payload(item_id), ensure_ascii=False)
        assert "blob:" not in payload_json
        assert "/Users/nobody" not in payload_json
        assert "/api/community/public/media/" + item_id + "/" in payload_json
        assert env.client.get("/api/community/public/items/" + item_id).status_code == 200


def test_clone_clears_dead_media_and_keeps_data_url():
    """克隆：下载不到的素材把节点地址清空 + 留 mediaMissing；data: 素材原样保留。"""
    with community_env() as env:
        env.peer_items[CLONE_ITEM_ID] = {
            "id": CLONE_ITEM_ID, "kind": "canvas", "title": "别人的画布", "desc": "", "tags": [],
            "category": "", "cover": "cover.webp",
            "author": {"account_id": "peer-account-a", "nickname": "同事 A"},
            "version": 1, "created_at": store.now_ms(), "updated_at": store.now_ms(),
            "allow_clone": True, "meta": {"nodes": 3, "media": 2, "size_bytes": 0},
            "stats": {"likes": 0, "clones": 0, "views": 0, "reports": 0}, "status": "published",
        }
        env.peer_payloads[CLONE_ITEM_ID] = {"title": "别人的画布", "icon": "", "nodes": [
            {"id": "n1", "kind": "image", "x": 0, "y": 0, "w": 320, "h": 320, "text": "",
             "data": {"gen": {"title": "坏的", "hi": 0, "hist": [
                 {"url": "/api/community/public/media/" + CLONE_ITEM_ID + "/missing.png"}]}}},
            {"id": "n2", "kind": "image", "x": 400, "y": 0, "w": 320, "h": 320, "text": "",
             "data": {"gen": {"title": "好的", "hi": 0, "hist": [
                 {"url": "/api/community/public/media/" + CLONE_ITEM_ID + "/ok.png"}]}}},
            {"id": "n3", "kind": "image", "x": 800, "y": 0, "w": 320, "h": 320, "text": "",
             "url": PNG_DATA_URL},
        ], "connections": [], "settings": {}}
        env.peer_media[CLONE_ITEM_ID + "/ok.png"] = PNG_BYTES

        cloned = env.client.post("/api/community/items/" + CLONE_ITEM_ID + "/clone")
        assert cloned.status_code == 200, cloned.text[:500]
        body = cloned.json()
        assert int(body.get("copied") or 0) == 1, body
        assert int(body.get("missing") or 0) == 1, body
        saved = env.canvases.get(str(body.get("target_id") or "")) or {}
        nodes = {str(node.get("id")): node for node in saved.get("nodes") or []}
        dead_url = _hist_url(nodes.get("n1"))
        good_url = _hist_url(nodes.get("n2"))
        assert dead_url == "", dead_url
        assert good_url.startswith("/assets/uploads/"), good_url
        assert str(nodes["n3"].get("url") or "") == PNG_DATA_URL
        missing_items = ((nodes.get("n1") or {}).get("data") or {}).get("mediaMissing") or []
        assert missing_items, (nodes.get("n1") or {}).get("data")
        # 诊断信息里保留原地址给前端显示，但节点上已经没有任何指向作者作品的死链
        assert missing_items[0].get("url", "").endswith("/missing.png"), missing_items
        assert missing_items[0].get("error")
        assert "/api/community/public/media/" not in json.dumps(_without_missing(saved), ensure_ascii=False)
        # 再发布一次：克隆出来的画布必须能带上素材（诊断用的 mediaMissing 不能被当成媒体引用，
        # 否则「克隆 → 再发布」又会变成一个素材都打不进包 / 又变成坏图）
        again = env.publish(str(body.get("target_id") or ""))
        assert again.status_code == 200, again.text[:400]
        again_report = again.json().get("media") or {}
        assert again_report.get("packaged") == 2, again_report   # data: + 已本地化的 /assets/uploads
        assert again_report.get("missing") == 0, again_report


def test_republish_with_missing_media_keeps_previous_package():
    """重新发布时素材不全 → 422，但上一版已经发出去的包必须原样还在（不能被清空）。"""
    with community_env() as env:
        shot = os.path.join(env.output_dir, "shot.png")
        env.add_canvas("canvas-repub", [_node("n1", url=shot)])
        first = env.publish("canvas-repub")
        assert first.status_code == 200, first.text[:300]
        item_id = str((first.json().get("item") or {}).get("id") or "")
        names = env.package_names(item_id)
        assert len(names) == 1, names
        # 素材被删掉后再发一次
        os.remove(shot)
        env.canvases["canvas-repub"]["updated_at"] = store.now_ms() + 5000
        republish = env.client.patch("/api/community/mine/" + item_id, json={"republish": True})
        assert republish.status_code == 422, republish.text[:300]
        assert os.path.isfile(os.path.join(store.package_dir(item_id), "package.json"))
        assert env.package_names(item_id) == names
        served = env.client.get("/api/community/public/media/" + item_id + "/" + names[0])
        assert served.status_code == 200
        assert int(env.client.get("/api/community/public/items/" + item_id).status_code) == 200


def test_source_preview_counts_ready_and_missing():
    """发布弹窗：media 仍是引用总数，media_ready / media_missing 才是真能不能打包。"""
    with community_env() as env:
        env.add_canvas("canvas-preview", [
            _node("n1", url=os.path.join(env.output_dir, "shot.png")),
            _node("n2", url=REMOTE_URL),
            _node("n3", url=PNG_DATA_URL),
            _node("n4", url="blob:http://127.0.0.1:3000/dead-blob"),
        ])
        preview = env.client.get("/api/community/source",
                                 params={"kind": "canvas", "source_id": "canvas-preview"})
        assert preview.status_code == 200, preview.text[:300]
        source = preview.json().get("source") or {}
        assert source.get("media") == 4, source            # 引用总数（原语义不变）
        assert source.get("media_ready") == 3, source      # 站内文件 + 远程 + data:
        assert source.get("media_missing") == 1, source    # blob:
        missing = source.get("media_missing_items") or []
        assert missing and missing[0].get("code") == "blob", missing
        assert missing[0].get("reason")


def test_remote_failure_blocks_publish_instead_of_silently_dropping():
    """远程链接预览时算「能打包」，真下载失败时发布要挡住，不能静默发出去。"""
    with community_env() as env:
        env.remote_dead.add(REMOTE_URL)
        env.add_canvas("canvas-remote-dead", [
            _node("n1", url=os.path.join(env.output_dir, "shot.png")),
            _node("n2", url=REMOTE_URL),
        ])
        preview = env.client.get("/api/community/source",
                                 params={"kind": "canvas", "source_id": "canvas-remote-dead"}).json()
        assert int((preview.get("source") or {}).get("media_ready") or 0) == 2
        rejected = env.publish("canvas-remote-dead")
        assert rejected.status_code == 422, rejected.text[:300]
        detail = str((rejected.json() or {}).get("detail") or "")
        assert "1 张图片" in detail, detail

def test_summary_media_refs_distinguishes_missing_from_no_media():
    """详情 summary：media=包内文件数不变，media_refs=引用数——前端才不会把纯文本画布误报成「没带素材」。"""
    with community_env() as env:
        # 1) 有图但一个都没打进包（只发工作流结构：media=0，引用还在 payload 里）
        env.add_canvas("canvas-textref", [_node("n1", url=os.path.join(env.output_dir, "shot.png"))])
        published = env.publish("canvas-textref", include_media=False)
        assert published.status_code == 200, published.text[:300]
        item_id = str((published.json().get("item") or {}).get("id") or "")
        summary = (env.client.get("/api/community/items/" + item_id).json().get("summary") or {})
        assert int(summary.get("media") or 0) == 0, summary
        assert int(summary.get("media_refs") or 0) >= 1, summary
        assert summary.get("type_label") == "画布", summary
        assert "nodes" in summary and "size_bytes" in summary, summary

        # 2) 纯文本画布（本来就没有图片 / 视频 / 音频）：media=0 且 media_refs=0，不应提示缺素材
        env.add_canvas("canvas-puretext", [
            _node("t1", kind="text", text="卖点：轻、透气"),
            _node("t2", kind="note", text="参考同事的排版"),
        ])
        text_published = env.publish("canvas-puretext")
        assert text_published.status_code == 200, text_published.text[:300]
        text_id = str((text_published.json().get("item") or {}).get("id") or "")
        text_summary = (env.client.get("/api/community/items/" + text_id).json().get("summary") or {})
        assert int(text_summary.get("media") or 0) == 0, text_summary
        assert int(text_summary.get("media_refs") or 0) == 0, text_summary


def test_cover_generated_for_remote_only_canvas():
    """只有远程图片的画布：素材进包的同时封面也要出（信息流卡片不能是灰的）。"""
    with community_env() as env:
        env.add_canvas("canvas-remote-cover", [_node("n1", url=REMOTE_URL)])
        published = env.publish("canvas-remote-cover")
        assert published.status_code == 200, published.text[:400]
        body = published.json()
        item_id = str((body.get("item") or {}).get("id") or "")
        report = body.get("media") or {}
        assert report.get("packaged") == 1 and report.get("missing") == 0, report
        assert int(((body.get("item") or {}).get("meta") or {}).get("media") or 0) == 1
        package_dir = store.package_dir(item_id)
        cover_path = os.path.join(package_dir, "cover.webp")
        assert os.path.isfile(cover_path), sorted(os.listdir(package_dir))
        with open(cover_path, "rb") as handle:
            head = handle.read(16)
        assert head[:4] == b"RIFF" and head[8:12] == b"WEBP", head


def test_cover_generated_for_data_url_only_canvas():
    """只有 data:image/png 内嵌图的画布：同样要出封面。"""
    with community_env() as env:
        env.add_canvas("canvas-data-cover", [_node("n1", url=PNG_DATA_URL)])
        published = env.publish("canvas-data-cover")
        assert published.status_code == 200, published.text[:400]
        body = published.json()
        item_id = str((body.get("item") or {}).get("id") or "")
        report = body.get("media") or {}
        assert report.get("packaged") == 1 and report.get("missing") == 0, report
        assert int(((body.get("item") or {}).get("meta") or {}).get("media") or 0) == 1
        package_dir = store.package_dir(item_id)
        cover_path = os.path.join(package_dir, "cover.webp")
        assert os.path.isfile(cover_path), sorted(os.listdir(package_dir))
        with open(cover_path, "rb") as handle:
            head = handle.read(16)
        assert head[:4] == b"RIFF" and head[8:12] == b"WEBP", head

