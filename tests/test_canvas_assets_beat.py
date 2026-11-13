#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BEAT（canvas-next）生成物在素材库里的可见性回归测试。

背景：智能画布BEAT 的画布文档 kind=classic，节点形如
{type:'smart-image', kind:'image', url, data:{gen:{prompt, params, hist:[{url,w,h,meta}], hi}}}
旧实现只把 images[...] 当「节点自己的产出」，于是 data.gen.hist 里的生成物：
  · /api/canvas-assets 没有 gen_prompt / gen_model / gen_at（详情面板生成信息为空）
  · natural_w/h 取的是画布显示尺寸（w/h），不是素材像素
  · 分类名还叫「普通画布」，与画布列表的「智能画布」错位
另外生成物落在 assets/output，「本地素材」只扫 assets/uploads，素材库列表里永远看不到。
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from server.routes import assets as assets_routes
from server.routes.deps import deps

BEAT_IMAGE = "/assets/output/gen_beat_image.webp"
BEAT_VIDEO = "/assets/output/gen_beat_video.mp4"
BEAT_VARIANT = "/assets/output/gen_beat_variant.webp"
UPLOAD_REF = "/assets/input/ai_ref_upload.jpg"


def beat_canvas():
    return {
        "id": "beatcanvas0000000000000000000001",
        "title": "BEAT 测试画布",
        "icon": "layers",
        "kind": "classic",
        "created_at": 1793500000000,
        "updated_at": 1793500001000,
        "nodes": [
            {
                "id": "n_image",
                "type": "smart-image",
                "kind": "image",
                "x": 0, "y": 0, "w": 320, "h": 240,
                "url": BEAT_IMAGE,
                "variants": [BEAT_VARIANT],
                "data": {"gen": {
                    "title": "图片",
                    "prompt": "棚拍产品图，柔和侧逆光",
                    "params": {"model": "apimart::gpt-image-2.6-sunburst", "ratio": "4:3"},
                    "hist": [
                        {"url": BEAT_IMAGE, "w": 1792, "h": 2400, "meta": {"model": "gpt-image-2.6-sunburst", "at": 1793500001000}},
                        {"url": BEAT_VARIANT, "w": 1024, "h": 1024, "meta": {"model": "gpt-image-2.6-sunburst", "at": 1793500002000}},
                    ],
                    "hi": 0,
                    "order": [],
                }},
            },
            {
                "id": "n_video",
                "type": "smart-video",
                "kind": "video",
                "x": 400, "y": 0, "w": 568, "h": 320,
                "url": BEAT_VIDEO,
                "data": {"gen": {
                    "title": "视频",
                    "prompt": "产品在桌面缓慢旋转",
                    "params": {"model": "apimart::veo-3.1", "ratio": "16:9", "res": "720p", "dur": 5},
                    "hist": [
                        {"url": BEAT_VIDEO, "frame": "/assets/output/gen_beat_poster.jpg", "dur": 5,
                         "res": "720p", "w": 1280, "h": 720, "meta": {"model": "veo-3.1", "at": 1793500003000}},
                    ],
                    "hi": 0,
                    "order": [],
                }},
            },
            {
                "id": "n_upload",
                "type": "smart-image",
                "kind": "image",
                "x": 0, "y": 400, "w": 240, "h": 160,
                "url": UPLOAD_REF,
                "data": {"gen": {
                    "title": "参考图",
                    "prompt": "",
                    "params": {"model": "agnes-ai::agnes-image-2.0-flash", "ratio": "1:1"},
                    "hist": [{"url": UPLOAD_REF, "w": 1080, "h": 1440}],
                    "hi": 0,
                    "order": [],
                    "uploaded": True,
                }},
            },
        ],
        "connections": [],
    }


def legacy_canvas():
    """旧画布（smart-canvas / 传统画布）节点：产出在 images[]，生成信息在 runAt/runPrompt/runSettings。"""
    return {
        "id": "legacycanvas00000000000000000001",
        "title": "旧画布",
        "kind": "smart",
        "created_at": 1793000000000,
        "updated_at": 1793000001000,
        "nodes": [
            {
                "id": "n_old",
                "type": "image",
                "x": 0, "y": 0, "width": 1024, "height": 768,
                "images": [{"url": "/assets/output/legacy_out.png", "natural_w": 1024, "natural_h": 768}],
                "runAt": 1793000001000,
                "runPrompt": "旧画布提示词",
                "runSettings": {"model": "gemini-3-pro-image-preview", "provider_id": "apimart", "ratio": "4:3"},
            }
        ],
        "connections": [],
    }


class BeatExtractTests(unittest.TestCase):
    def items(self, canvas=None):
        return main.extract_canvas_assets(canvas or beat_canvas())

    def by_url(self, canvas=None):
        return {it["url"]: it for it in self.items(canvas)}

    def test_hist_output_has_generation_meta_and_canvas_owner(self):
        item = self.by_url()[BEAT_IMAGE]
        self.assertEqual(item["canvas_kind"], "classic")
        self.assertEqual(item["canvas_title"], "BEAT 测试画布")
        self.assertEqual(item["kind"], "image")
        self.assertEqual(item["gen_prompt"], "棚拍产品图，柔和侧逆光")
        self.assertEqual(item["gen_model"], "gpt-image-2.6-sunburst")
        self.assertEqual(item["gen_provider"], "apimart")
        self.assertEqual(item["gen_at"], 1793500001000)
        self.assertEqual(item["gen_ratio"], "4:3")
        self.assertTrue(item.get("generated"))

    def test_natural_size_comes_from_hist_not_canvas_box(self):
        # 节点 w/h 是画布显示尺寸（320×240），素材像素在 data.gen.hist[].w/h
        item = self.by_url()[BEAT_IMAGE]
        self.assertEqual((item["natural_w"], item["natural_h"]), (1792, 2400))

    def test_video_output_is_video_kind_with_dims(self):
        item = self.by_url()[BEAT_VIDEO]
        self.assertEqual(item["kind"], "video")
        self.assertEqual((item["natural_w"], item["natural_h"]), (1280, 720))
        self.assertEqual(item["gen_model"], "veo-3.1")
        self.assertEqual(item["gen_kind"], "video")

    def test_variants_are_deduped_and_counted_as_output(self):
        items = self.items()
        urls = [it["url"] for it in items]
        self.assertEqual(len(urls), len(set(urls)), "同一 URL 只能出现一次")
        variant = self.by_url()[BEAT_VARIANT]
        self.assertEqual(variant["gen_prompt"], "棚拍产品图，柔和侧逆光")
        self.assertTrue(variant.get("generated"))

    def test_uploaded_node_has_no_generation_meta(self):
        item = self.by_url()[UPLOAD_REF]
        self.assertNotIn("gen_prompt", item)
        self.assertNotIn("gen_model", item)
        self.assertFalse(item.get("generated"))

    def test_cover_frame_is_not_marked_as_generated_output(self):
        poster = self.by_url().get("/assets/output/gen_beat_poster.jpg")
        if poster is not None:
            self.assertFalse(poster.get("generated"))
            self.assertNotIn("gen_prompt", poster)

    def test_legacy_images_generation_meta_unchanged(self):
        item = self.by_url(legacy_canvas())["/assets/output/legacy_out.png"]
        self.assertEqual(item["gen_prompt"], "旧画布提示词")
        self.assertEqual(item["gen_model"], "gemini-3-pro-image-preview")
        self.assertEqual(item["gen_provider"], "apimart")
        self.assertEqual(item["gen_ratio"], "4:3")
        self.assertEqual((item["natural_w"], item["natural_h"]), (1024, 768))


class CanvasAssetsIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.canvases = Path(self.temp.name) / "canvases"
        self.canvases.mkdir(parents=True, exist_ok=True)
        (self.canvases / "beat.json").write_text(json.dumps(beat_canvas(), ensure_ascii=False), encoding="utf-8")
        (self.canvases / "legacy.json").write_text(json.dumps(legacy_canvas(), ensure_ascii=False), encoding="utf-8")
        self.patch = patch.object(main, "CANVAS_DIR", str(self.canvases))
        self.patch.start()
        main._CANVAS_RECORD_CACHE.clear()

    def tearDown(self):
        self.patch.stop()
        main._CANVAS_RECORD_CACHE.clear()
        self.temp.cleanup()

    def test_beat_canvas_assets_are_indexed_under_beat_category(self):
        index = main.canvas_assets_index()
        categories = {c["id"]: c for c in index["categories"]}
        self.assertIn("classic", categories)
        # 与画布列表口径一致：classic 对外叫「智能画布」，smart（历史画布）叫「旧版智能画布」
        self.assertEqual(categories["classic"]["name"], "智能画布")
        self.assertEqual(categories["smart"]["name"], "旧版智能画布")
        self.assertGreaterEqual(categories["classic"]["canvas_count"], 1)
        beat_items = [it for it in index["items"] if it["canvas_id"] == "beatcanvas0000000000000000000001"]
        self.assertTrue(any(it["url"] == BEAT_IMAGE and it.get("gen_prompt") for it in beat_items))
        self.assertTrue(any(it["url"] == BEAT_VIDEO and it["kind"] == "video" for it in beat_items))

    def test_legacy_canvas_counts_and_items_still_work(self):
        index = main.canvas_assets_index()
        categories = {c["id"]: c for c in index["categories"]}
        self.assertGreaterEqual(categories["smart"]["canvas_count"], 1)
        legacy_items = [it for it in index["items"] if it["canvas_id"] == "legacycanvas00000000000000000001"]
        self.assertEqual(len(legacy_items), 1)
        self.assertEqual(legacy_items[0]["gen_prompt"], "旧画布提示词")


class LocalOutputsScopeTests(unittest.TestCase):
    """根视图（folder 为空）不返回画布生成物：本地上传列表不能被几百个只读生成物淹没。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.uploads = root / "uploads"
        self.output = root / "output"
        (self.uploads / "sub").mkdir(parents=True, exist_ok=True)
        self.output.mkdir(parents=True, exist_ok=True)
        (self.uploads / "up_root.png").write_bytes(b"x" * 8)
        (self.uploads / "sub" / "up_sub.png").write_bytes(b"x" * 8)
        (self.output / "gen_beat_image.webp").write_bytes(b"x" * 32)
        (self.output / "gen_beat_video.mp4").write_bytes(b"x" * 16)
        self.patches = [
            patch.object(main, "LOCAL_UPLOAD_DIR", str(self.uploads)),
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.output)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def call(self, **params):
        with patch.dict(deps._bound, {
            "_local_upload_tree_and_items": main._local_upload_tree_and_items,
        }):
            return asyncio.run(assets_routes.list_local_assets(**params))

    def test_root_view_hides_generated_but_keeps_tree_and_counts(self):
        data = self.call()
        # 根视图沿用「不传 folder 就返回全部上传素材」的既有口径，只额外排除只读生成物
        self.assertEqual({it["name"] for it in data["items"]}, {"up_root.png", "up_sub.png"})
        self.assertEqual(data["total"], 2)
        self.assertEqual(data["generated_hidden"], 2)
        # 左栏文件夹计数仍然包含生成物
        folders = {row["path"]: row["count"] for row in data["folders"]}
        self.assertEqual(folders.get(main.LOCAL_OUTPUT_FOLDER), 2)
        children = {c["name"]: c["count"] for c in (data["tree"] or {}).get("children") or []}
        self.assertEqual(children.get(main.LOCAL_OUTPUT_FOLDER), 2)

    def test_generated_folder_returns_readonly_items(self):
        data = self.call(folder=main.LOCAL_OUTPUT_FOLDER)
        self.assertEqual({it["name"] for it in data["items"]},
                         {"gen_beat_image.webp", "gen_beat_video.mp4"})
        self.assertEqual(data["total"], 2)
        self.assertEqual(data["generated_hidden"], 0)
        self.assertTrue(all(it.get("readonly") and it.get("source") == "output" for it in data["items"]))

    def test_root_marker_also_hides_generated_and_upload_folder_unchanged(self):
        self.assertEqual({it["name"] for it in self.call(folder="__root__")["items"]}, {"up_root.png"})
        sub = self.call(folder="sub")
        self.assertEqual([it["name"] for it in sub["items"]], ["up_sub.png"])
        self.assertEqual(sub["total"], 1)


class LocalOutputsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.uploads = root / "uploads"
        self.output = root / "output"
        self.uploads.mkdir(parents=True, exist_ok=True)
        self.output.mkdir(parents=True, exist_ok=True)
        (self.output / "gen_beat_image.webp").write_bytes(b"x" * 32)
        (self.output / "gen_beat_video.mp4").write_bytes(b"x" * 16)
        self.patches = [
            patch.object(main, "LOCAL_UPLOAD_DIR", str(self.uploads)),
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.output)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_generated_outputs_listed_as_readonly_local_assets(self):
        tree, items = main._local_upload_tree_and_items()
        gen = [it for it in items if it.get("source") == "output"]
        self.assertEqual({it["name"] for it in gen}, {"gen_beat_image.webp", "gen_beat_video.mp4"})
        by_name = {it["name"]: it for it in gen}
        self.assertEqual(by_name["gen_beat_image.webp"]["url"], "/assets/output/gen_beat_image.webp")
        self.assertEqual(by_name["gen_beat_image.webp"]["kind"], "image")
        self.assertEqual(by_name["gen_beat_video.mp4"]["kind"], "video")
        self.assertTrue(by_name["gen_beat_image.webp"]["readonly"])
        self.assertEqual(by_name["gen_beat_image.webp"]["folder"], main.LOCAL_OUTPUT_FOLDER)
        children = {c["name"]: c for c in tree["children"]}
        self.assertIn(main.LOCAL_OUTPUT_FOLDER, children)
        self.assertEqual(children[main.LOCAL_OUTPUT_FOLDER]["count"], 2)

    def test_readonly_name_guard(self):
        self.assertTrue(main.local_output_readonly_name("output:gen_beat_image.webp"))
        self.assertTrue(main.local_output_readonly_name(main.LOCAL_OUTPUT_FOLDER))
        self.assertTrue(main.local_output_readonly_name(main.LOCAL_OUTPUT_FOLDER + "/x.png"))
        self.assertFalse(main.local_output_readonly_name("up_0123456789ab_pic.png"))
        self.assertFalse(main.local_output_readonly_name(""))

    def test_delete_and_move_reject_readonly_entries(self):
        from fastapi import HTTPException

        def call(coro):
            return asyncio.run(coro)

        with patch.dict(deps._bound, {
            "ensure_same_origin_request": lambda request: None,
            "local_output_readonly_name": main.local_output_readonly_name,
            "_local_upload_safe_path": main._local_upload_safe_path,
            "_local_upload_safe_folder": main._local_upload_safe_folder,
            "_local_upload_tree_and_items": main._local_upload_tree_and_items,
            "_local_upload_caption_path": main._local_upload_caption_path,
            "_local_upload_classification_path": main._local_upload_classification_path,
        }):
            with self.assertRaises(HTTPException) as ctx:
                call(assets_routes.delete_local_assets({"names": ["output:gen_beat_image.webp"]}, None))
            self.assertEqual(ctx.exception.status_code, 403)
            with self.assertRaises(HTTPException) as ctx2:
                call(assets_routes.move_local_assets({"names": ["output:gen_beat_image.webp"], "folder": ""}, None))
            self.assertEqual(ctx2.exception.status_code, 403)
            with self.assertRaises(HTTPException) as ctx3:
                call(assets_routes.move_local_assets({"names": ["up_0123456789ab_pic.png"], "folder": main.LOCAL_OUTPUT_FOLDER}, None))
            self.assertEqual(ctx3.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
