#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区路由单测：发布 / 编辑 / 重新发布版本号 / 下架 / 删除 / 可见开关 / 公开接口 / 事件去重 / 限流 / 白名单。

不依赖 main.py：LOAD_CANVAS / SAVE_CANVAS / NEW_CANVAS / 提示词库都用桩，用 fastapi TestClient 跑真实路由。
用法：venv/bin/python tests/test_community_routes.py
"""
from __future__ import annotations

import base64
import copy
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.community import packager, store, transport  # noqa: E402
from server.routes import community  # noqa: E402
from server.routes.deps import deps  # noqa: E402

FAILED = 0
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-community-routes-")
    output_dir = os.path.join(data_dir, "output")
    assets_dir = os.path.join(data_dir, "assets")
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(assets_dir, exist_ok=True)
    with open(os.path.join(output_dir, "shot.png"), "wb") as handle:
        handle.write(PNG_BYTES)

    canvases = {
        "canvas-1": {
            "id": "canvas-1", "title": "莫卡辛详情页", "icon": "layers", "kind": "classic",
            "created_at": 1700000000000, "updated_at": 1700000000000,
            "nodes": [
                {"id": "n1", "kind": "image", "x": 0, "y": 0, "w": 320, "h": 320, "text": "",
                 "data": {"gen": {"title": "主图", "prompt": "白色背景商品图",
                                  "params": {"ratio": "1:1"},
                                  "hist": [{"url": os.path.join(output_dir, "shot.png")}], "hi": 0}}},
                {"id": "n2", "kind": "text", "x": 400, "y": 0, "w": 320, "h": 160, "text": "卖点：轻"},
            ],
            "connections": [{"id": "e1", "from": "n2", "to": "n1"}],
            "viewport": {"x": 0, "y": 0, "scale": 1},
            "settings": {"provider": "volcengine", "api_key": "sk-should-not-leak", "ratio": "1:1"},
        },
        "canvas-2": {
            "id": "canvas-2", "title": "冬季卖点分屏", "icon": "layers", "kind": "classic",
            "created_at": 1700000001000, "updated_at": 1700000001000,
            "nodes": [{"id": "m1", "kind": "text", "x": 0, "y": 0, "w": 200, "h": 100, "text": "hi"}],
            "connections": [],
        },
    }

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
        {"id": "system", "name": "系统提示词库", "type": "prompt", "categories": [],
         "items": [{"id": "tpl_test", "name": "暖调棚拍", "category": "lighting",
                    "positive": "米色无缝背景，柔和侧逆光", "negative": ""}]},
    ]}

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
        COMMUNITY_NODES=lambda: [],
        _local_upload_safe_folder=lambda rel: (str(rel or "").strip("/"), os.path.join(assets_dir, "uploads", str(rel or "").strip("/"))),
        _local_upload_kind_ext=lambda name, ctype: ("image", ".png") if "png" in str(ctype) or str(name).endswith(".png") else (None, ""),
        _local_upload_item=lambda rel: {"url": "/assets/uploads/" + str(rel).lstrip("/")},
        _sniff_image_ext_bytes=lambda head: ".png" if head else "",
    )
    original_limit = community.RATE_READ_PER_MIN
    community.RATE_READ_PER_MIN = 5000
    app = FastAPI()
    app.include_router(community.router)
    client = TestClient(app)

    # 1. 发布画布
    published = client.post("/api/community/publish", json={
        "kind": "canvas", "source_id": "canvas-1", "title": "莫卡辛详情页 · 换款",
        "desc": "参考图 + 白底图 → 4 张大片", "tags": ["服装", "大片"], "category": "电商",
        "cover": "", "allow_clone": True, "include_media": True,
    })
    check("发布画布 200", published.status_code == 200, str(published.status_code) + " " + published.text[:200])
    body = published.json() if published.status_code == 200 else {}
    item = body.get("item") or {}
    item_id = str(item.get("id") or "")
    check("作品 ID 是 <账号码>-<随机>", bool(store.valid_item_id(item_id)), item_id)
    check("发布后自动打开局域网可见", body.get("visible") is True)
    package_dir = store.package_dir(item_id) if item_id else ""
    check("发布包落盘", os.path.isfile(os.path.join(package_dir, "package.json")))
    check("媒体副本进包", os.path.isdir(os.path.join(package_dir, "media")) and
          len(os.listdir(os.path.join(package_dir, "media"))) == 1)
    check("封面生成 cover.webp", os.path.isfile(os.path.join(package_dir, "cover.webp")))
    raw_package = json.load(open(os.path.join(package_dir, "package.json"), encoding="utf-8"))
    package_json = json.dumps(raw_package, ensure_ascii=False)
    check("包里不带 API Key", "sk-should-not-leak" not in package_json)
    check("包里不带本机绝对路径", data_dir not in package_json)
    check("包里媒体地址写成公开地址",
          "/api/community/public/media/" + item_id in package_json, package_json[:200])
    check("meta 记了节点数和体积", int((raw_package.get("meta") or {}).get("nodes") or 0) == 2)

    # 2. 同一来源重复发布
    again = client.post("/api/community/publish", json={"kind": "canvas", "source_id": "canvas-1"})
    check("同一来源重复发布 409", again.status_code == 409, str(again.status_code))

    # 3. 我的发布 + 画布发布状态
    mine = client.get("/api/community/mine").json()
    check("我的发布里有它", any(entry["id"] == item_id for entry in mine.get("items") or []))
    status_body = client.get("/api/community/mine", params={"source_id": "canvas-1"}).json()
    check("按画布查发布状态", (status_body.get("item") or {}).get("id") == item_id)
    check("刚发布没有新改动", (status_body.get("item") or {}).get("has_changes") is False)

    # 4. 画布改动 → has_changes；重新发布 → 版本 +1
    canvases["canvas-1"]["updated_at"] = store.now_ms() + 5000
    canvases["canvas-1"]["nodes"].append({"id": "n3", "kind": "text", "x": 0, "y": 400, "w": 200, "h": 80, "text": "新增"})
    changed = client.get("/api/community/mine", params={"source_id": "canvas-1"}).json()
    check("画布改过后 has_changes 为真", (changed.get("item") or {}).get("has_changes") is True)
    check("改动节点数 >= 1", int((changed.get("item") or {}).get("changed_nodes") or 0) >= 1)
    # 重新发布时画布已经存过（真实情况：包时间晚于画布最后保存时间）
    canvases["canvas-1"]["updated_at"] = store.now_ms()
    republished = client.patch("/api/community/mine/" + item_id, json={"republish": True})
    check("重新发布 200", republished.status_code == 200, republished.text[:200])
    check("重新发布后版本 v2", int((republished.json().get("item") or {}).get("version") or 0) == 2)
    check("重新发布后没有新改动", (republished.json().get("item") or {}).get("has_changes") is False)
    check("重新发布后包里节点变 3 个", int((json.load(open(os.path.join(package_dir, "package.json"), encoding="utf-8")).get("meta") or {}).get("nodes") or 0) == 3)

    # 5. 编辑信息（不重新发布）
    patched = client.patch("/api/community/mine/" + item_id, json={"title": "改过的标题", "desc": "新简介"})
    check("编辑标题 200", patched.status_code == 200)
    check("标题改掉", (patched.json().get("item") or {}).get("title") == "改过的标题")

    # 6. 公开接口（可见开启时）
    listed = client.get("/api/community/public/items")
    check("公开作品列表 200", listed.status_code == 200)
    check("公开列表里有作品", len(listed.json().get("items") or []) == 1)
    detail = client.get("/api/community/public/items/" + item_id)
    check("公开详情 200", detail.status_code == 200)
    check("公开详情带只读快照", isinstance(detail.json().get("payload"), dict))
    pack = client.get("/api/community/public/items/" + item_id + "/package")
    check("公开发布包 200", pack.status_code == 200)
    media_name = sorted(os.listdir(os.path.join(package_dir, "media")))[0]
    served = client.get("/api/community/public/media/" + item_id + "/" + media_name)
    check("公开媒体 200", served.status_code == 200, str(served.status_code))
    cover = client.get("/api/community/public/items/" + item_id + "/cover")
    check("公开封面 200", cover.status_code == 200)

    # 7. 事件上报：需要好友凭据 + 去重
    token = str(community._account().get("token") or "")
    no_token = client.post("/api/community/public/items/" + item_id + "/event",
                           json={"type": "like", "account_id": "acc-peer"})
    check("没有好友凭据的事件 403", no_token.status_code == 403)
    headers = {"X-NOVAI-Friend-Token": token}
    first = client.post("/api/community/public/items/" + item_id + "/event", headers=headers,
                        json={"type": "like", "account_id": "acc-peer"})
    check("点赞事件 200", first.status_code == 200)
    check("点赞数 +1", int(first.json()["stats"]["likes"]) == 1)
    dup = client.post("/api/community/public/items/" + item_id + "/event", headers=headers,
                      json={"type": "like", "account_id": "acc-peer"})
    check("同一 account_id 重复点赞不叠加", int(dup.json()["stats"]["likes"]) == 1)
    clone_evt = client.post("/api/community/public/items/" + item_id + "/event", headers=headers,
                            json={"type": "clone", "account_id": "acc-peer2"})
    check("克隆事件 +1", int(clone_evt.json()["stats"]["clones"]) == 1)
    view1 = client.post("/api/community/public/items/" + item_id + "/event", headers=headers,
                        json={"type": "view", "account_id": "acc-peer3"}).json()
    view2 = client.post("/api/community/public/items/" + item_id + "/event", headers=headers,
                        json={"type": "view", "account_id": "acc-peer3"}).json()
    check("浏览事件按 account_id/时间窗去重", int(view2["stats"]["views"]) == int(view1["stats"]["views"]))
    report_evt = client.post("/api/community/public/items/" + item_id + "/event", headers=headers,
                             json={"type": "report", "account_id": "acc-peer4", "reason": "与描述不符"})
    check("举报事件记原因", "与描述不符" in ((client.get("/api/community/mine").json()["items"][0]).get("report_reasons") or []))

    # 8. 下架 / 上架
    unlisted = client.post("/api/community/mine/" + item_id + "/unlist")
    check("下架 200", unlisted.status_code == 200)
    check("下架后公开列表为空", len(client.get("/api/community/public/items").json().get("items") or []) == 0)
    check("下架后公开详情 404", client.get("/api/community/public/items/" + item_id).status_code == 404)
    relisted = client.post("/api/community/mine/" + item_id + "/relist")
    check("重新上架 200", relisted.status_code == 200)
    check("重新上架后公开列表有 1 条", len(client.get("/api/community/public/items").json().get("items") or []) == 1)

    # 9. 可见开关关闭 → 公开接口一律 404
    settings = client.get("/api/community/settings").json()
    check("设置读回 visible", settings.get("visible") is True)
    client.put("/api/community/settings", json={"visible": False})
    check("关闭可见后公开列表 404", client.get("/api/community/public/items").status_code == 404)
    check("关闭可见后公开详情 404", client.get("/api/community/public/items/" + item_id).status_code == 404)
    check("关闭可见后发布包也 404", client.get("/api/community/public/items/" + item_id + "/package").status_code == 404)
    client.put("/api/community/settings", json={"visible": True})

    # 10. allow_clone=false → 发布包 403，详情仍可看
    canvases["canvas-2"]["nodes"].append({"id": "m2", "kind": "image", "x": 0, "y": 0, "w": 200, "h": 200,
                                          "url": "/output/shot.png"})
    second = client.post("/api/community/publish", json={
        "kind": "canvas", "source_id": "canvas-2", "title": "不许克隆的画布",
        "allow_clone": False, "include_media": False,
    })
    second_id = str((second.json().get("item") or {}).get("id") or "")
    check("发布 allow_clone=false 的画布", second.status_code == 200 and bool(second_id))
    check("allow_clone=false 的发布包 403",
          client.get("/api/community/public/items/" + second_id + "/package").status_code == 403)
    check("allow_clone=false 的详情仍可看",
          client.get("/api/community/public/items/" + second_id).status_code == 200)

    # 11. 路径穿越 / 非法 ID
    traversal = client.get("/api/community/public/media/" + item_id + "/..%2F..%2Fsecret.json")
    check("媒体文件名穿越被拒", traversal.status_code in (400, 404), str(traversal.status_code))
    bad_id = client.get("/api/community/public/media/bad..id/x.png")
    check("非法作品 ID 被拒", bad_id.status_code in (400, 404), str(bad_id.status_code))
    check("本地媒体路由不穿越", client.get("/api/community/media/" + item_id + "/../package.json").status_code in (400, 404, 422))

    # 12. 发布技能 / 提示词 + 作品流筛选
    from server.skills import registry
    registry.set_data_dir(data_dir)
    skill = registry.import_skill({"id": "my-skill", "name": "鞋履白底精修", "category": "电商",
                                   "description": "去背、补光、统一投影", "enabled": True,
                                   "skill_prompt": "把背景去掉", "env": {"API_KEY": "x"}})[0]
    skill_pub = client.post("/api/community/publish", json={
        "kind": "skill", "source_id": "my-skill", "title": "鞋履白底精修",
        "category": "电商", "allow_clone": True, "include_media": False,
    })
    check("发布技能 200", skill_pub.status_code == 200, skill_pub.text[:200])
    prompt_pub = client.post("/api/community/publish", json={
        "kind": "prompt", "source_id": "tpl_test", "title": "暖调棚拍",
        "category": "光影", "allow_clone": True, "include_media": False,
    })
    check("发布提示词 200", prompt_pub.status_code == 200, prompt_pub.text[:200])
    feed = client.get("/api/community/feed").json()
    counts = feed.get("counts") or {}
    check("作品流三种类型都在", counts.get("canvas") == 2 and counts.get("skill") == 1 and counts.get("prompt") == 1,
          json.dumps(counts))
    skill_feed = client.get("/api/community/feed", params={"kind": "skill"}).json()
    check("按类型筛选", len(skill_feed.get("items") or []) == 1 and skill_feed["items"][0]["kind"] == "skill")
    q_feed = client.get("/api/community/feed", params={"q": "白底"}).json()
    check("搜索命中技能", any(item["kind"] == "skill" for item in q_feed.get("items") or []))
    sorted_feed = client.get("/api/community/feed", params={"sort": "hot"}).json()
    check("最热排序首位是有点赞的画布", (sorted_feed.get("items") or [{}])[0].get("id") == item_id)

    # 13. 首页精选：近 7 天 likes + 2*clones 取前 5，不足 4 张用最新补
    featured = client.get("/api/community/featured").json()
    check("精选有数据", len(featured.get("items") or []) >= 4, str(len(featured.get("items") or [])))
    check("精选首位是有赞的作品", (featured.get("items") or [{}])[0].get("id") == item_id)

    # 14. 主页背景：上传 / 焦点 / 恢复默认
    data_url = "data:image/png;base64," + base64.b64encode(PNG_BYTES).decode("ascii")
    profile = client.put("/api/community/profile", json={"action": "upload", "data_url": data_url})
    check("上传背景 200", profile.status_code == 200, profile.text[:200])
    check("背景有 cover_url", bool((profile.json().get("profile") or {}).get("cover_url")))
    check("背景图能取到", client.get("/api/community/profile-cover").status_code == 200)
    focus = client.put("/api/community/profile", json={"action": "focus", "focus_x": 20, "focus_y": 80})
    check("焦点位置保存", (focus.json().get("profile") or {}).get("focus_x") == 20)
    reset = client.put("/api/community/profile", json={"action": "reset"})
    check("恢复默认背景", (reset.json().get("profile") or {}).get("default") is True)
    check("恢复默认后取不到图", client.get("/api/community/profile-cover").status_code == 404)

    # 15. 单包超限要报错（不是静默丢媒体）
    canvases["canvas-1b"] = {
        "id": "canvas-1b", "title": "超限画布", "nodes": [
            {"id": "z1", "kind": "image", "x": 0, "y": 0, "w": 100, "h": 100,
             "url": "/output/shot.png"}], "connections": []}
    original_max = packager.MAX_PACKAGE_BYTES
    try:
        packager.MAX_PACKAGE_BYTES = 1
        too_big = client.post("/api/community/publish", json={
            "kind": "canvas", "source_id": "canvas-1b", "title": "超限", "include_media": True,
        })
    finally:
        packager.MAX_PACKAGE_BYTES = original_max
    check("包超 200MB 报 413", too_big.status_code == 413, too_big.text[:200])
    check("超限错误说明原因", "200MB" in str((too_big.json() or {}).get("detail") or ""))

    # 16. 删除发布（不删源画布）
    deleted = client.delete("/api/community/mine/" + item_id)
    check("删除发布 200", deleted.status_code == 200)
    check("删除后我的发布里没了", all(entry["id"] != item_id for entry in client.get("/api/community/mine").json().get("items") or []))
    check("删除发布不动源画布", "canvas-1" in canvases)
    check("删除后发布包目录也没了", not os.path.isdir(package_dir))

    # 17. 限流：读接口每分钟 120 次
    community._RATE.clear()
    community.RATE_READ_PER_MIN = 2
    try:
        codes = [client.get("/api/community/public/items").status_code for _ in range(4)]
    finally:
        community.RATE_READ_PER_MIN = original_limit
        community._RATE.clear()
    check("超过每分钟读次数的请求 429", codes[:2] == [200, 200] and 429 in codes, str(codes))

    shutil.rmtree(data_dir, ignore_errors=True)
    print("")
    if FAILED:
        print("社区路由单测失败 %d 项" % FAILED)
        return 1
    print("社区路由单测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
