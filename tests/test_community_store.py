#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区存储层单测：作品读写 / 可见开关 / 主页背景 / ID 与文件名白名单 / 原子写。

不依赖 main.py：把 DATA_DIR 用 server.routes.deps 绑成临时目录（与 lan_account / canvas_share 单测同一套写法）。
用法：venv/bin/python tests/test_community_store.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server.community import packager, store  # noqa: E402
from server.routes.deps import deps  # noqa: E402

FAILED = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-community-store-")
    deps.bind(DATA_DIR=data_dir, OUTPUT_DIR=os.path.join(data_dir, "output"),
              ASSETS_DIR=os.path.join(data_dir, "assets"), BASE_DIR=ROOT)

    # 1. 目录约定
    check("community 目录落在 DATA_DIR 下", store.community_dir() == os.path.join(data_dir, "community"))
    check("包目录按作品 ID 分", store.package_dir("483920-abc123").endswith(os.path.join("packages", "483920-abc123")))
    check("缓存目录按作品 ID 分", store.cache_item_dir("483920-abc123").endswith(os.path.join("cache", "483920-abc123")))

    # 2. ID / 文件名白名单
    check("合法作品 ID", store.valid_item_id("483920-k7f2q9"))
    check("含斜杠的 ID 被拒", not store.valid_item_id("483920/../x"))
    check("空 ID 被拒", not store.valid_item_id(""))
    check("合法文件名", store.valid_file_name("shot-abc123.png"))
    check("目录穿越文件名被拒", not store.valid_file_name("../secret.json"))
    check("隐藏文件被拒", not store.valid_file_name(".env"))
    for bad in ("a..b.png", "a/b.png", ""):
        check("非法文件名被拒: %r" % bad, not store.valid_file_name(bad))

    # 3. 作品读写
    item = store._normalize_item({
        "id": "483920-abc123", "kind": "canvas", "source_id": "canvas-1",
        "title": "莫卡辛详情页", "desc": "换款工作流",
        "tags": ["电商", "鞋"], "category": "电商", "cover": "cover.webp",
        "author": {"account_id": "acc-1", "nickname": "林小鹿", "avatar": "🙂"},
        "version": 3, "created_at": 1, "updated_at": 2, "package_updated_at": 2,
        "allow_clone": True, "status": "published",
        "meta": {"nodes": 12, "media": 4, "size_bytes": 1024},
        "stats": {"likes": 5, "clones": 2, "views": 9, "reports": 1},
        "report_reasons": ["与描述不符"],
        "liked_by": ["acc-2"], "cloned_by": ["acc-3"],
    })
    check("作品字段归一", item is not None and item["version"] == 3)
    store.save_items([item])
    loaded = store.load_items()
    check("作品落盘并读回", len(loaded) == 1 and loaded[0]["title"] == "莫卡辛详情页")
    check("items.json 是原子写产物（无 .partial 残留）",
          not [name for name in os.listdir(store.community_dir()) if name.endswith(".partial")])
    public = store.item_public(loaded[0])
    check("对外字段不带本机点赞名单", "liked_by" not in public and "cloned_by" not in public)
    check("对外字段带统计", public["stats"]["likes"] == 5)
    check("对外字段带 online", public["online"] is True)

    # 4. 兼容脏数据：坏条目直接丢弃，不炸整份列表
    with open(store.items_path(), "w", encoding="utf-8") as handle:
        json.dump({"version": 1, "items": [item, {"id": "bad id"}, "not-a-dict"]}, handle, ensure_ascii=False)
    check("坏条目被过滤", len(store.load_items()) == 1)

    # 5. 可见开关（默认关）
    me = store.load_me()
    check("可见开关默认关闭", me["visible"] is False)
    store.set_visible(True)
    check("可见开关可打开", store.visible() is True)
    store.set_visible(False)
    check("可见开关可关闭", store.visible() is False)
    check("me.json 落盘", os.path.isfile(store.me_path()))

    # 6. 收藏 / 点赞 / 克隆记录
    def mutate(state):
        state["favorites"] = ["483920-abc123"]
        state["likes"] = ["483920-abc123"]
        state["clones"] = [{"item_id": "483920-abc123", "kind": "canvas", "target_id": "new-1", "at": 1}]
        state["blocked_authors"] = ["acc-9"]
    store.me_update(mutate)
    again = store.load_me()
    check("收藏记下来", again["favorites"] == ["483920-abc123"])
    check("克隆记录记下来", len(again["clones"]) == 1)
    check("屏蔽作者记下来", again["blocked_authors"] == ["acc-9"])

    # 7. 主页背景
    profile = store.load_profile()
    check("默认没有背景图", profile["cover"] == "" and profile["focus_x"] == 50)
    saved = store.save_profile({"cover": "cover-1.png", "focus_x": 30, "focus_y": 70})
    check("背景图落盘", saved["cover"] == "cover-1.png")
    reloaded = store.load_profile()
    check("焦点位置读回", reloaded["focus_x"] == 30 and reloaded["focus_y"] == 70)
    check("焦点越界被夹回 0-100", store.save_profile({"cover": "cover-1.png", "focus_x": 999})["focus_x"] <= 100)

    # 8. 媒体 URL → 本机文件
    os.makedirs(os.path.join(data_dir, "output"), exist_ok=True)
    media_path = os.path.join(data_dir, "output", "shot.png")
    with open(media_path, "wb") as handle:
        handle.write(b"png")
    check("站内地址解析到本机文件", packager.local_path_for_url("/output/shot.png") == media_path)
    check("解析不到返回 None", packager.local_path_for_url("/output/missing.png") is None)
    check("目录穿越解析被拒", packager.local_path_for_url("/output/../../etc/passwd") is None)
    check("媒体地址识别", packager.is_media_url("/output/shot.png") and packager.is_media_url("http://x/y.png"))
    check("非媒体地址不识别", not packager.is_media_url("/api/canvases"))
    name = packager.media_file_name("/output/shot.png")
    check("包内文件名稳定", name == packager.media_file_name("/output/shot.png") and name.endswith(".png"))

    # 9. 清洗：API Key / provider / 大 data URL 都不进包
    dirty = {
        "settings": {"provider": "volcengine", "api_key": "sk-secret", "ratio": "1:1"},
        "nodes": [{"id": "n1", "kind": "image", "url": "/Users/wepingli/x/output/shot.png",
                   "data": {"gen": {"token": "t", "inline": "data:image/png;base64," + "A" * 8192}}}],
    }
    clean = packager.strip_private(dirty)
    check("provider 被去掉", "provider" not in clean["settings"])
    check("api_key 被去掉", "api_key" not in clean["settings"])
    check("普通配置保留", clean["settings"].get("ratio") == "1:1")
    check("token 被去掉", "token" not in clean["nodes"][0]["data"]["gen"])
    check("大 data URL 被清空", clean["nodes"][0]["data"]["gen"]["inline"] == "")

    shutil.rmtree(data_dir, ignore_errors=True)
    print("")
    if FAILED:
        print("社区存储层单测失败 %d 项" % FAILED)
        return 1
    print("社区存储层单测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
