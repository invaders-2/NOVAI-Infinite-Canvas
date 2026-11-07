"""素材库支持视频/音频条目：分类类型、自动建「视频」「音频」、url 直传识别（含 /api/ai/upload-base64）。"""
import asyncio
import base64
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from server.routes import assets as assets_routes
from server.routes.deps import deps


def run(coro):
    return asyncio.run(coro)


def make_library(extra_categories=None):
    categories = [
        {"id": "characters", "name": "角色", "type": "image", "items": []},
        {"id": "scenes", "name": "场景", "type": "image", "items": []},
        {"id": "workflows", "name": "工作流", "type": "workflow", "items": []},
    ]
    categories.extend(extra_categories or [])
    library = {"id": "default", "name": "默认资产库", "type": "asset", "categories": categories}
    lib = {"active_library_id": "default", "libraries": [library], "categories": categories}
    return lib


class AssetLibraryMediaTests(unittest.TestCase):
    def setUp(self):
        self.classify_calls = []
        self.saved = []
        self.files = {}
        self.lib = None

    def build_patches(self, lib):
        self.lib = lib
        categories = lib["libraries"][0]["categories"]

        def find_category(lib_obj, category_id, library_id=""):
            return next((cat for cat in categories if cat.get("id") == category_id), None)

        def make_item(src, name="", subdir=""):
            kind = main.asset_library_media_kind(src)
            return name, {"id": f"asset_{len(self.files)}", "name": name,
                          "url": f"/assets/library/lib_{len(self.files)}", "kind": kind, "created_at": 1}

        async def classify(_src):
            self.classify_calls.append(_src)
            return {"summary": "一张图"}

        def output_url(url):
            return self.files.get(str(url))

        return {
            "load_asset_library": lambda: self.lib,
            "find_asset_library": lambda lib_obj, library_id="": next(
                (item for item in lib_obj.get("libraries") or [] if not library_id or item.get("id") == library_id), None),
            "find_asset_category_in_library": find_category,
            "output_file_from_url": output_url,
            "make_asset_library_item": make_item,
            "generation_meta_for_url": lambda url: {},
            "classify_asset_image_best_effort": classify,
            "save_asset_library": lambda lib_obj: self.saved.append(lib_obj),
            "asset_library_media_kind": main.asset_library_media_kind,
        }

    def add(self, lib, url, category_id="", name="素材"):
        self.files = {url: f"/tmp/fake{os.path.splitext(url)[1]}"} if url.startswith(("/output/", "/assets/")) else {}
        with unittest.mock.patch.dict(deps._bound, self.build_patches(lib)):
            return run(assets_routes.add_asset_library_item(
                assets_routes.AssetLibraryAddRequest(url=url, name=name, category_id=category_id, library_id="default")))

    def batch(self, lib, items, category_id=""):
        self.files = {item["url"]: f"/tmp/fake{os.path.splitext(item['url'])[1]}"
                      for item in items if item["url"].startswith(("/output/", "/assets/"))}
        with unittest.mock.patch.dict(deps._bound, self.build_patches(lib)):
            return run(assets_routes.batch_add_asset_library_items(
                assets_routes.AssetLibraryBatchAddRequest(category_id=category_id, library_id="default", items=items)))

    def category(self, lib, category_id):
        cats = lib["libraries"][0]["categories"]
        return next((cat for cat in cats if cat.get("id") == category_id), None)

    def test_image_item_into_image_category_and_classified(self):
        lib = make_library()
        result = self.add(lib, "/output/cover.png", category_id="characters")
        self.assertEqual(result["item"]["kind"], "image")
        self.assertEqual(result["category"]["id"], "characters")
        self.assertEqual(self.category(lib, "characters")["items"][0]["id"], result["item"]["id"])
        self.assertEqual(len(self.classify_calls), 1)

    def test_video_item_auto_creates_video_category(self):
        lib = make_library()
        result = self.add(lib, "/assets/output/clip.mp4", category_id="")
        self.assertEqual(result["item"]["kind"], "video")
        self.assertEqual(result["category"]["id"], "videos")
        self.assertEqual(result["category"]["type"], "video")
        self.assertEqual(self.category(lib, "videos")["items"][0]["kind"], "video")
        self.assertEqual(self.classify_calls, [])
        # 自动建分类是追加，不修改既有 characters/scenes/workflows
        cats = lib["libraries"][0]["categories"]
        self.assertEqual([c["id"] for c in cats[:3]], ["characters", "scenes", "workflows"])
        self.assertEqual([c["type"] for c in cats[:3]], ["image", "image", "workflow"])

    def test_audio_item_auto_creates_audio_category(self):
        lib = make_library()
        result = self.add(lib, "/assets/input/voice.mp3", category_id="auto")
        self.assertEqual(result["item"]["kind"], "audio")
        self.assertEqual(result["category"]["id"], "audios")
        self.assertEqual(result["category"]["name"], "音频")
        self.assertEqual(self.category(lib, "audios")["items"][0]["kind"], "audio")

    def test_video_into_image_category_gets_clear_error(self):
        lib = make_library()
        with self.assertRaises(main.HTTPException) as caught:
            self.add(lib, "/assets/output/clip.mp4", category_id="characters")
        self.assertEqual(caught.exception.status_code, 400)
        message = str(caught.exception.detail)
        self.assertIn("图片分类", message)
        self.assertIn("视频", message)
        self.assertEqual(self.category(lib, "characters")["items"], [])

    def test_image_into_video_category_gets_clear_error(self):
        lib = make_library([{"id": "videos", "name": "视频", "type": "video", "items": []}])
        with self.assertRaises(main.HTTPException) as caught:
            self.add(lib, "/output/cover.png", category_id="videos")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("视频分类", str(caught.exception.detail))
        self.assertIn("图片", str(caught.exception.detail))

    def test_unknown_category_is_404(self):
        lib = make_library()
        with self.assertRaises(main.HTTPException) as caught:
            self.add(lib, "/output/cover.png", category_id="nope")
        self.assertEqual(caught.exception.status_code, 404)
        self.assertIn("分类不存在", str(caught.exception.detail))

    def test_invalid_url_is_rejected(self):
        lib = make_library()
        with self.assertRaises(main.HTTPException) as caught:
            self.add(lib, "https://example.com/remote.png")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("只支持保存本地", str(caught.exception.detail))

    def test_workflow_file_rejected_by_media_endpoint(self):
        lib = make_library()
        with self.assertRaises(main.HTTPException) as caught:
            self.add(lib, "/assets/library/workflow.zip")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("工作流", str(caught.exception.detail))

    def test_batch_mixed_media_lands_in_matching_categories(self):
        lib = make_library()
        result = self.batch(lib, [
            {"url": "/output/cover.png", "name": "封面"},
            {"url": "/assets/output/clip.mp4", "name": "短片"},
            {"url": "/assets/input/voice.mp3", "name": "配音"},
        ])
        self.assertEqual(result["errors"], [])
        self.assertEqual([item["kind"] for item in result["items"]], ["image", "video", "audio"])
        self.assertEqual(len(self.category(lib, "characters")["items"]), 1)
        self.assertEqual(len(self.category(lib, "videos")["items"]), 1)
        self.assertEqual(len(self.category(lib, "audios")["items"]), 1)

    def test_batch_reports_invalid_and_mismatched_items(self):
        lib = make_library()
        result = self.batch(lib, [
            {"url": "https://example.com/x.png"},
            {"url": "/assets/output/clip.mp4"},
        ], category_id="characters")
        self.assertEqual(len(result["errors"]), 2)
        self.assertIn("只支持保存本地", result["errors"][0]["error"])
        self.assertIn("图片分类", result["errors"][1]["error"])
        self.assertEqual(result["items"], [])


class UploadBase64UrlTests(unittest.TestCase):
    def test_upload_base64_video_url_is_recognizable(self):
        captured = {}

        def fake_store(content, filename, category="input", display_name=""):
            captured.update({"content": content, "filename": filename, "category": category})
            return f"/assets/{category}/{filename}"

        payload = main.Base64UploadRequest(data=base64.b64encode(b"fake-mp4-bytes").decode(),
                                           name="clip.mp4", content_type="video/mp4")
        with unittest.mock.patch.object(main, "store_uploaded_bytes", side_effect=fake_store):
            result = run(main.upload_ai_base64(payload))
        file_info = result["files"][0]
        self.assertEqual(file_info["kind"], "video")
        self.assertTrue(captured["filename"].endswith(".mp4"))
        self.assertEqual(file_info["url"], f"/assets/input/{captured['filename']}")
        # 模拟落盘后确认 output_file_from_url 能识别这个 url（-> /assets/input/...）
        with tempfile.TemporaryDirectory() as tmp:
            input_dir = os.path.join(tmp, "input")
            os.makedirs(input_dir)
            with open(os.path.join(input_dir, captured["filename"]), "wb") as fh:
                fh.write(b"fake-mp4-bytes")
            with unittest.mock.patch.object(main, "ASSETS_DIR", tmp):
                resolved = main.output_file_from_url(file_info["url"])
                self.assertEqual(resolved, os.path.join(input_dir, captured["filename"]))
                self.assertEqual(main.asset_library_media_kind(resolved), "video")

    def test_legacy_category_without_type_is_image(self):
        self.assertEqual(assets_routes._asset_library_media_type({"id": "x", "name": "老分组"}), "image")
        self.assertEqual(assets_routes._asset_library_media_type({"type": "video"}), "video")
        self.assertEqual(assets_routes._asset_library_media_type({"type": "workflow"}), "image")


if __name__ == "__main__":
    unittest.main()
