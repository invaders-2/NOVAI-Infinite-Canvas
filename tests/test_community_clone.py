#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区克隆单测：画布（媒体本地化）/ 技能（默认停用、id 不覆盖内置）/ 提示词（进「社区」分组）/ 作者离线。

远端节点用 COMMUNITY_HTTP 桩模拟（不建真连接）：
    http://peer-a:3931/api/community/public/...  返回固定的作品 / 发布包 / 媒体
用法：venv/bin/python tests/test_community_clone.py
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
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.community import packager, store, transport  # noqa: E402
from server.routes import community  # noqa: E402
from server.routes.deps import deps  # noqa: E402

FAILED = 0
PEER_BASE = "http://peer-a:3931"
PEER_TOKEN = "peer-token-1234567890"
CANVAS_ID = "111111-aaaaaa"
SKILL_ID = "222222-bbbbbb"
PROMPT_ID = "333333-cccccc"
CLOSED_ID = "444444-dddddd"
COLD_ID = "555555-eeeeee"
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def peer_item(item_id, kind, title):
    return {
        "id": item_id, "kind": kind, "title": title, "desc": "来自同事 A", "tags": ["测试"],
        "category": "电商", "cover": "cover.webp",
        "author": {"account_id": "peer-account-a", "nickname": "同事 A", "avatar": "🙂"},
        "version": 2, "created_at": store.now_ms(), "updated_at": store.now_ms(),
        "allow_clone": item_id != CLOSED_ID,
        "meta": {"nodes": 1, "media": 1, "size_bytes": len(PNG_BYTES)},
        "stats": {"likes": 3, "clones": 1, "views": 8, "reports": 0},
        "status": "published",
    }


def canvas_payload(item_id, allow_media=True):
    nodes = [
        {"id": "n1", "kind": "image", "x": 0, "y": 0, "w": 320, "h": 320, "text": "",
         "data": {"gen": {"title": "主图", "prompt": "白色背景商品图",
                          "hist": [{"url": "/api/community/public/media/" + item_id + "/shot.png"}], "hi": 0}}},
        {"id": "n2", "kind": "text", "x": 400, "y": 0, "w": 320, "h": 160, "text": "卖点：轻"},
    ]
    if not allow_media:
        nodes = [{"id": "n2", "kind": "text", "x": 0, "y": 0, "w": 200, "h": 80, "text": "只有文字"}]
    return {"title": "莫卡辛详情页", "icon": "layers", "nodes": nodes,
            "connections": [{"id": "e1", "from": "n2", "to": "n1"}], "settings": {}}


def package_of(item, payload):
    return {
        "schema": 1, "item_id": item["id"], "kind": item["kind"], "version": item["version"],
        "title": item["title"], "desc": item["desc"], "tags": item["tags"],
        "category": item["category"], "cover": "cover.webp", "author": item["author"],
        "allow_clone": item["allow_clone"], "include_media": True,
        "created_at": item["created_at"], "updated_at": item["updated_at"],
        "meta": item["meta"], "payload": payload,
    }


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-community-clone-")
    output_dir = os.path.join(data_dir, "output")
    assets_dir = os.path.join(data_dir, "assets")
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(assets_dir, exist_ok=True)

    items = {
        CANVAS_ID: peer_item(CANVAS_ID, "canvas", "莫卡辛详情页 · 批量换款"),
        SKILL_ID: peer_item(SKILL_ID, "skill", "鞋履白底精修"),
        PROMPT_ID: peer_item(PROMPT_ID, "prompt", "暖调棚拍"),
        CLOSED_ID: peer_item(CLOSED_ID, "canvas", "不许克隆的画布"),
        COLD_ID: peer_item(COLD_ID, "canvas", "从没打开过的画布"),
    }
    payloads = {
        CANVAS_ID: canvas_payload(CANVAS_ID),
        # 故意塞 skill_type=system / env / 未知字段：接收端必须按白名单剔除
        SKILL_ID: {"id": "peer-skill", "name": "鞋履白底精修", "category": "电商", "icon": "wand2",
                   "description": "去背、补光、统一投影", "tags": ["电商"], "skill_prompt": "把背景去掉",
                   "enabled": True, "skill_type": "system", "unknown_field": "leak",
                   "env": {"API_KEY": "sk-should-not-survive"},
                   "author": {"account_id": "peer-account-a", "nickname": "同事 A"}},
        PROMPT_ID: {"name": "暖调棚拍", "category": "lighting",
                    "positive": "米色无缝背景，柔和侧逆光", "negative": ""},
        CLOSED_ID: canvas_payload(CLOSED_ID, allow_media=False),
        COLD_ID: canvas_payload(COLD_ID, allow_media=False),
    }
    state = {"online": True}

    def fake_http(method, url, headers, body, timeout):
        if not state["online"]:
            return 0, b""
        path = urllib.parse.urlsplit(url).path
        if path == "/api/community/public/items":
            return 200, json.dumps({"author": {"account_id": "peer-account-a", "nickname": "同事 A"},
                                    "items": [items[key] for key in (CANVAS_ID, SKILL_ID, PROMPT_ID, CLOSED_ID, COLD_ID)]}).encode()
        for prefix in ("/api/community/public/items/",):
            if path.startswith(prefix):
                rest = path[len(prefix):]
                parts = rest.split("/")
                item_id = parts[0]
                if item_id not in items:
                    return 404, b"{}"
                if len(parts) == 1:
                    return 200, json.dumps({"item": items[item_id],
                                            "payload": payloads[item_id]}).encode()
                if parts[1] == "package":
                    if item_id == CLOSED_ID:
                        return 403, b"{}"
                    return 200, json.dumps({"package": package_of(items[item_id], payloads[item_id])}).encode()
        if path.startswith("/api/community/public/media/"):
            rest = path[len("/api/community/public/media/"):]
            if rest.endswith("/shot.png"):
                return 200, PNG_BYTES
            return 404, b""
        if path.endswith("/event"):
            return 200, b'{"ok": true}'
        if path == "/api/community/public/profile":
            return 200, json.dumps({"author": {"account_id": "peer-account-a", "nickname": "同事 A"},
                                    "profile": {"focus_x": 40, "focus_y": 60, "has_cover": True},
                                    "stats": {"items": 4, "likes": 3, "clones": 1, "views": 8, "friends": 2},
                                    "items": [items[CANVAS_ID]]}).encode()
        return 404, b""

    canvases = {}

    def load_canvas(canvas_id):
        if canvas_id not in canvases:
            raise HTTPException(status_code=404, detail="画布不存在")
        return copy.deepcopy(canvases[canvas_id])

    def save_canvas(canvas):
        canvases[canvas["id"]] = copy.deepcopy(canvas)

    def new_canvas(title):
        made = {"id": "clone-%d" % (len(canvases) + 1), "title": title, "kind": "classic",
                "nodes": [], "connections": [], "created_at": store.now_ms(),
                "updated_at": store.now_ms()}
        save_canvas(made)
        return copy.deepcopy(made)

    prompts = {"active_library_id": "system", "libraries": [
        {"id": "system", "name": "系统提示词库", "type": "prompt", "categories": [], "items": []}]}

    def load_prompt_libraries():
        return copy.deepcopy(prompts)

    def save_prompt_libraries(data):
        prompts.clear()
        prompts.update(copy.deepcopy(data))
        return copy.deepcopy(prompts)

    deps.bind(
        DATA_DIR=data_dir, OUTPUT_DIR=output_dir, ASSETS_DIR=assets_dir, BASE_DIR=ROOT,
        LOAD_CANVAS=load_canvas, SAVE_CANVAS=save_canvas, NEW_CANVAS=new_canvas,
        load_prompt_libraries=load_prompt_libraries, save_prompt_libraries=save_prompt_libraries,
        normalize_prompt_library_item=lambda item: dict(item),
        COMMUNITY_NODES=lambda: [{"id": "peer-account-a", "nickname": "同事 A", "base": PEER_BASE,
                                  "token": PEER_TOKEN, "online": True}],
        COMMUNITY_HTTP=fake_http,
        _local_upload_safe_folder=lambda rel: (str(rel or "").strip("/"),
                                               os.path.join(assets_dir, "uploads", str(rel or "").strip("/"))),
        _local_upload_kind_ext=lambda name, ctype: ("image", ".png") if "png" in str(ctype) or str(name).endswith(".png") else (None, ""),
        _local_upload_item=lambda rel: {"url": "/assets/uploads/" + str(rel).lstrip("/")},
        _sniff_image_ext_bytes=lambda head: ".png" if head else "",
    )
    from server.skills import registry
    registry.set_data_dir(data_dir)
    transport.clear_feed_cache()

    app = FastAPI()
    app.include_router(community.router)
    client = TestClient(app)

    # 1. 作品流能看到在线节点的作品
    feed = client.get("/api/community/feed").json()
    check("在线节点的作品进作品流", len(feed.get("items") or []) == 5, str(len(feed.get("items") or [])))
    check("在线作者计数 >= 1", int(feed.get("creators_online") or 0) >= 1)
    check("作品带 online 标记", all(item.get("online") for item in feed.get("items") or []))

    # 2. 打开详情：远端快照经本机代理，媒体地址换成本机代理地址，发布包缓存下来
    detail = client.get("/api/community/items/" + CANVAS_ID)
    check("远端详情 200", detail.status_code == 200, detail.text[:200])
    detail_body = detail.json()
    payload = detail_body.get("payload") or {}
    payload_json = json.dumps(payload, ensure_ascii=False)
    check("详情快照换成代理媒体地址",
          "/api/community/media/" + CANVAS_ID + "/shot.png" in payload_json, payload_json[:300])
    check("详情不再是作者主机地址", PEER_BASE not in payload_json)
    check("发布包已缓存", os.path.isfile(os.path.join(store.cache_item_dir(CANVAS_ID), "package.json")))
    check("详情带统计摘要", bool((detail_body.get("summary") or {}).get("type_label")))
    check("本地代理媒体能取到", client.get("/api/community/media/" + CANVAS_ID + "/shot.png").status_code == 200)

    # 3. 详情预缓存媒体：本机把素材落到 cache/media（作者离线后还能克隆）
    asyncio.run(transport.prefetch_media(CANVAS_ID, ["shot.png"]))
    check("媒体进了本机缓存", bool(transport.cached_media_path(CANVAS_ID, "shot.png")))

    # 4. 克隆画布：新画布 + 媒体全部本地化 + 写 source
    cloned = client.post("/api/community/items/" + CANVAS_ID + "/clone")
    check("克隆画布 200", cloned.status_code == 200, cloned.text[:300])
    clone_body = cloned.json()
    target_id = str(clone_body.get("target_id") or "")
    check("克隆得到新画布", bool(target_id) and target_id in canvases)
    saved = canvases.get(target_id) or {}
    check("克隆标题带（克隆）", str(saved.get("title") or "").endswith("（克隆）"), str(saved.get("title")))
    check("克隆画布节点数一致", len(saved.get("nodes") or []) == 2)
    check("克隆写了来源信息",
          (saved.get("source") or {}).get("item_id") == CANVAS_ID and (saved.get("source") or {}).get("version") == 2)
    node_url = str((((saved.get("nodes") or [{}])[0].get("data") or {}).get("gen") or {}).get("hist", [{}])[0].get("url") or "")
    check("克隆后媒体指向本机", node_url.startswith("/assets/uploads/"), node_url)
    check("克隆后不含作者主机", PEER_BASE not in json.dumps(saved, ensure_ascii=False))
    check("克隆后素材文件真实存在",
          os.path.isfile(os.path.join(assets_dir, "uploads", os.path.basename(node_url))))
    check("克隆计数返回", int(clone_body.get("copied") or 0) == 1)
    clone_log = client.get("/api/community/clones").json()
    check("克隆记录进「我克隆的」", any((entry.get("clone") or {}).get("item_id") == CANVAS_ID
                                       for entry in clone_log.get("items") or []))

    # 5. 克隆技能：新 id + 默认停用 + needs_enable
    skill_clone = client.post("/api/community/items/" + SKILL_ID + "/clone")
    check("克隆技能 200", skill_clone.status_code == 200, skill_clone.text[:300])
    skill_body = skill_clone.json()
    new_skill = registry.get_skill(str(skill_body.get("target_id") or ""))
    check("技能 id 加了 -cXXXX 后缀", str(skill_body.get("target_id") or "").startswith("peer-skill-c"),
          str(skill_body.get("target_id")))
    check("克隆来的技能默认停用", new_skill is not None and new_skill.get("enabled") is False)
    check("返回 needs_enable 让前端弹确认", skill_body.get("needs_enable") is True)
    check("返回里带作者昵称", "同事 A" in str(skill_body.get("message") or ""), str(skill_body.get("message")))
    skill_file = os.path.join(data_dir, "skills", str(skill_body.get("target_id") or "") + ".json")
    check("技能落盘在 data/skills 下", os.path.isfile(skill_file))
    raw_skill = {}
    if os.path.isfile(skill_file):
        with open(skill_file, encoding="utf-8") as handle:
            raw_skill = json.load(handle)
    check("对端的 skill_type=system 被强制改成 mine",
          str(raw_skill.get("skill_type") or "") == "mine", raw_skill.get("skill_type"))
    check("未知字段被白名单剔除", "unknown_field" not in raw_skill, json.dumps(list(raw_skill.keys())[:14]))
    check("对端的 env / API Key 没有落盘", "env" not in raw_skill and "sk-should-not-survive" not in json.dumps(raw_skill, ensure_ascii=False))
    source = raw_skill.get("source") or {}
    check("source 写了社区来源", source.get("type") == "community" and source.get("item_id") == SKILL_ID,
          json.dumps(source, ensure_ascii=False)[:160])
    check("source 保留作者署名",
          str((source.get("author") or {}).get("nickname") or "") == "同事 A",
          json.dumps(source.get("author") or {}, ensure_ascii=False))
    check("source 记了发布版本", int(source.get("version") or 0) == int(items[SKILL_ID]["version"]), str(source.get("version")))
    # /api/skills 走的就是 registry.public_skill，这里直接验这个投影，避免为一条断言再起一套路由
    listed = registry.public_skill(registry.get_skill(str(skill_body.get("target_id") or "")) or {})
    check("技能列表字段带 source，前端能显示「来自 XXX」",
          str((listed.get("source") or {}).get("type")) == "community" and listed.get("skill_type") == "mine",
          json.dumps(listed.get("source") or {}, ensure_ascii=False)[:120])

    # 6. 内置技能 id 不能被覆盖
    original_builtin = registry.load_builtin
    try:
        registry.load_builtin = lambda: [{"id": "builtin-fixed", "name": "内置"}]
        try:
            registry.import_skill({"id": "builtin-fixed", "name": "冒名顶替"})
            blocked = False
        except ValueError:
            blocked = True
    finally:
        registry.load_builtin = original_builtin
    check("内置技能 id 导入被拒", blocked)

    # 7. 克隆提示词：进「社区」分组
    prompt_clone = client.post("/api/community/items/" + PROMPT_ID + "/clone")
    check("克隆提示词 200", prompt_clone.status_code == 200, prompt_clone.text[:300])
    library = next((lib for lib in prompts.get("libraries") or []
                    if str(lib.get("id")) == "community"), None)
    check("自动建了「社区」分组", library is not None and library.get("name") == "社区")
    check("提示词进了社区分组", bool(library and library.get("items")))
    check("提示词正文保留",
          "米色无缝背景" in json.dumps(library.get("items") or [], ensure_ascii=False))

    # 8. allow_clone=false：克隆 403
    denied = client.post("/api/community/items/" + CLOSED_ID + "/clone")
    check("允许克隆=false 的克隆 403", denied.status_code == 403, str(denied.status_code))

    # 9. 作者离线：卡片标灰但缓存过的仍能克隆
    state["online"] = False
    transport.clear_feed_cache()
    offline_feed = client.get("/api/community/feed").json()
    offline_item = next((entry for entry in offline_feed.get("items") or []
                         if entry.get("id") == CANVAS_ID), None)
    check("作者离线后卡片还在（走缓存）", offline_item is not None)
    check("作者离线后 online=false", offline_item is not None and offline_item.get("online") is False)
    offline_detail = client.get("/api/community/items/" + CANVAS_ID)
    check("离线仍能打开缓存过的详情", offline_detail.status_code == 200)
    check("离线详情标记 online=false", offline_detail.json().get("online") is False)
    offline_clone = client.post("/api/community/items/" + CANVAS_ID + "/clone")
    check("离线仍能克隆缓存过的画布", offline_clone.status_code == 200, offline_clone.text[:200])
    never_cached = client.post("/api/community/items/" + COLD_ID + "/clone")
    check("没缓存过的离线作品克隆 409/404", never_cached.status_code in (404, 409), str(never_cached.status_code))

    # 10. 举报 / 收藏在离线时也能用（本地状态）
    check("离线也能收藏", client.post("/api/community/items/" + CANVAS_ID + "/favorite").json().get("favorited") is True)
    check("离线点赞被拒（统计归作者）",
          client.post("/api/community/items/" + CANVAS_ID + "/like").status_code in (409, 502))
    check("举报本地立即隐藏",
          client.post("/api/community/items/" + CANVAS_ID + "/report",
                      json={"reason": "与描述不符"}).json().get("hidden") is True)
    transport.clear_feed_cache()
    hidden_feed = client.get("/api/community/feed").json()
    check("举报后作品流里看不到", all(entry.get("id") != CANVAS_ID for entry in hidden_feed.get("items") or []))

    # 11. 别人主页（本机代理）
    state["online"] = True
    transport.clear_feed_cache()
    profile = client.get("/api/community/author/" + SKILL_ID)
    check("别人主页 200", profile.status_code == 200, profile.text[:200])
    check("主页带作者昵称", (profile.json().get("author") or {}).get("nickname") == "同事 A")
    check("主页带统计", int((profile.json().get("stats") or {}).get("items") or 0) == 4)

    shutil.rmtree(data_dir, ignore_errors=True)
    print("")
    if FAILED:
        print("社区克隆单测失败 %d 项" % FAILED)
        return 1
    print("社区克隆单测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
