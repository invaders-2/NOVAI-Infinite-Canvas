"""资产库保存：不再触发 AI 分类 + 保存即时广播 + 分类管理返回结构。"""
import asyncio
import copy
import json
import os
import sys
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from server.routes import assets as assets_routes
from server.routes import page_import
from server.routes.deps import deps


def run(coro):
    return asyncio.run(coro)


def make_library(extra_categories=None, items=None):
    categories = [
        {"id": "characters", "name": "角色", "type": "image", "items": list(items or [])},
        {"id": "scenes", "name": "场景", "type": "image", "items": []},
        {"id": "workflows", "name": "工作流", "type": "workflow", "items": []},
    ]
    categories.extend(extra_categories or [])
    library = {"id": "default", "name": "默认资产库", "type": "asset", "categories": categories}
    return {"active_library_id": "default", "libraries": [library], "categories": categories}


class FakeAssetLibrary:
    def __init__(self, lib, media_ok=True):
        self.lib = lib
        self.saved = []
        self.remove_calls = []
        self.media_ok = media_ok
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup = self.tmp.cleanup

    def bindings(self):
        categories = self.lib["libraries"][0]["categories"]

        def find_category(lib_obj, category_id, library_id=""):
            return next((cat for cat in categories if cat.get("id") == category_id), None)

        def find_with_library(lib_obj, category_id, library_id=""):
            cat = find_category(lib_obj, category_id, library_id)
            return (self.lib["libraries"][0] if cat else None), cat

        def make_item(src, name="", subdir=""):
            kind = main.asset_library_media_kind(src)
            item_id = f"asset_{len(self.saved)}_{name}_{time.time_ns()}"
            return name, {"id": item_id, "name": name, "url": f"/assets/library/{item_id}.png",
                          "kind": kind, "created_at": 1}

        def save(lib_obj):
            self.saved.append(copy.deepcopy(lib_obj))

        def output_url(url):
            return f"{self.tmp.name}/{os.path.basename(str(url))}" if str(url).startswith(("/assets/", "/output/")) else None

        return {
            "load_asset_library": lambda: self.lib,
            "find_asset_library": lambda lib_obj, library_id="": next(
                (item for item in lib_obj.get("libraries") or [] if not library_id or item.get("id") == library_id), None),
            "find_asset_category_in_library": find_category,
            "find_asset_category_with_library": find_with_library,
            "output_file_from_url": output_url,
            "make_asset_library_item": make_item,
            "generation_meta_for_url": lambda url: {},
            "save_asset_library": save,
            "remove_asset_library_file": lambda item: self.remove_calls.append(item),
            "sanitize_asset_name": lambda name, default="": name or default,
            "unique_asset_category_dir": lambda library, name: name or "分组",
            "asset_library_media_kind": main.asset_library_media_kind,
            "ASSET_LIBRARY_DIR": self.tmp.name,
        }

    def item_by_id(self, item_id):
        for cat in self.lib["libraries"][0]["categories"]:
            for item in cat.get("items") or []:
                if item.get("id") == item_id:
                    return item
        return None


class SaveAssetTests(unittest.TestCase):
    def setUp(self):
        self.lib = make_library()
        self.fake = FakeAssetLibrary(self.lib)

    def patched(self):
        patcher = unittest.mock.patch.dict(deps._bound, self.fake.bindings())
        patcher.start()
        self.addCleanup(patcher.stop)

    def add(self, url="/output/cover.png", **kwargs):
        payload = assets_routes.AssetLibraryAddRequest(url=url, name="封面", category_id="characters",
                                                       library_id="default", **kwargs)
        self.patched()
        return run(assets_routes.add_asset_library_item(payload))

    def test_save_no_longer_classifies(self):
        result = self.add()
        # 保存只落库：响应里没有分类进度字段，条目里也没有 classification
        self.assertNotIn("classification_pending", result)
        self.assertNotIn("classification", result["item"])
        self.assertEqual(len(self.fake.saved), 1)
        self.assertNotIn("classification", self.fake.item_by_id(result["item"]["id"]))

    def test_classify_fields_and_endpoints_are_removed(self):
        self.assertNotIn("classify", assets_routes.AssetLibraryAddRequest.model_fields)
        self.assertNotIn("classify", assets_routes.AssetLibraryBatchAddRequest.model_fields)
        self.assertNotIn("classify", assets_routes.LocalAssetUrlImportRequest.model_fields)
        self.assertNotIn("classify", page_import.PageImportRequest.model_fields)
        routes = {(route.path, method) for route in assets_routes.router.routes
                  for method in (route.methods or ())}
        self.assertNotIn(("/api/local-assets/classify", "POST"), routes)
        self.assertNotIn(("/api/asset-library/items/classify", "POST"), routes)
        self.assertFalse(hasattr(assets_routes, "classify_local_assets"))
        self.assertFalse(hasattr(assets_routes, "classify_asset_library_items"))
        # 分类 helper 不再注入 deps，后台分类线程也不存在
        self.assertNotIn("classify_asset_image_best_effort", deps._bound)
        self.assertNotIn("classify_image_with_provider", deps._bound)
        self.assertNotIn("_write_local_upload_classification", deps._bound)
        self.assertFalse(hasattr(assets_routes, "_spawn_asset_library_classification"))

    def test_batch_saves_without_classification(self):
        items = [assets_routes.AssetLibraryAddRequest(url="/output/a.png", name="图A"),
                 assets_routes.AssetLibraryAddRequest(url="/output/b.png", name="图B")]
        payload = assets_routes.AssetLibraryBatchAddRequest(category_id="characters", library_id="default", items=items)
        self.patched()
        result = run(assets_routes.batch_add_asset_library_items(payload))
        self.assertNotIn("classification_pending", result)
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(len(self.fake.saved), 1)
        for item in result["items"]:
            self.assertNotIn("classification", self.fake.item_by_id(item["id"]))


class CategoryManagementTests(unittest.TestCase):
    def setUp(self):
        self.lib = make_library()
        self.fake = FakeAssetLibrary(self.lib)

    def create(self, name="视频", cat_type="video"):
        payload = assets_routes.AssetLibraryCategoryRequest(name=name, type=cat_type, library_id="default")
        with unittest.mock.patch.dict(deps._bound, self.fake.bindings()):
            return run(assets_routes.create_asset_library_category(payload))

    def test_create_category_accepts_name_and_type(self):
        result = self.create(name="视频素材", cat_type="video")
        self.assertEqual(result["category"]["name"], "视频素材")
        self.assertEqual(result["category"]["type"], "video")
        self.assertEqual(len(self.fake.saved), 1)

    def test_rename_category_name(self):
        created = self.create(name="旧名字", cat_type="image")
        category_id = created["category"]["id"]
        payload = assets_routes.AssetLibraryRenameRequest(name="新名字", library_id="default")
        with unittest.mock.patch.dict(deps._bound, self.fake.bindings()):
            result = run(assets_routes.rename_asset_library_category(category_id, payload))
        self.assertEqual(result["category"]["name"], "新名字")
        self.assertEqual(result["category"]["type"], "image")

    def test_rename_changes_type_when_empty(self):
        created = self.create(name="视频", cat_type="video")
        category_id = created["category"]["id"]
        payload = assets_routes.AssetLibraryRenameRequest(name="", library_id="default", type="audio")
        with unittest.mock.patch.dict(deps._bound, self.fake.bindings()):
            result = run(assets_routes.rename_asset_library_category(category_id, payload))
        self.assertEqual(result["category"]["type"], "audio")

    def test_rename_type_with_items_is_rejected(self):
        created = self.create(name="角色2", cat_type="image")
        category_id = created["category"]["id"]
        self.fake.lib["libraries"][0]["categories"].append(
            {"id": category_id + "_x", "name": "有内容", "type": "video",
             "items": [{"id": "i1", "kind": "video", "url": "/assets/library/x.mp4"}]})
        target_id = category_id + "_x"
        payload = assets_routes.AssetLibraryRenameRequest(name="", library_id="default", type="audio")
        with unittest.mock.patch.dict(deps._bound, self.fake.bindings()):
            with self.assertRaises(main.HTTPException) as caught:
                run(assets_routes.rename_asset_library_category(target_id, payload))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("还有素材", str(caught.exception.detail))

    def test_workflow_type_change_is_rejected(self):
        payload = assets_routes.AssetLibraryRenameRequest(name="工作流", library_id="default", type="image")
        with unittest.mock.patch.dict(deps._bound, self.fake.bindings()):
            with self.assertRaises(main.HTTPException) as caught:
                run(assets_routes.rename_asset_library_category("workflows", payload))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("工作流分类不能改类型", str(caught.exception.detail))

    def test_delete_with_items_requires_force_false_guard(self):
        self.fake.lib["libraries"][0]["categories"].append(
            {"id": "with_items", "name": "有内容", "type": "video",
             "items": [{"id": "i1", "kind": "video", "url": "/assets/library/a.mp4"}]})
        with unittest.mock.patch.dict(deps._bound, self.fake.bindings()):
            with self.assertRaises(main.HTTPException) as caught:
                run(assets_routes.delete_asset_library_category("with_items", "default", False))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("1 个素材", str(caught.exception.detail))
        self.assertEqual(self.fake.saved, [])
        self.assertEqual(self.fake.remove_calls, [])

    def test_delete_cascades_by_default_and_reports_count(self):
        self.fake.lib["libraries"][0]["categories"].append(
            {"id": "with_items", "name": "有内容", "type": "video",
             "items": [{"id": "i1", "kind": "video", "url": "/assets/library/a.mp4"},
                       {"id": "i2", "kind": "video", "url": "/assets/library/b.mp4"}]})
        with unittest.mock.patch.dict(deps._bound, self.fake.bindings()):
            result = run(assets_routes.delete_asset_library_category("with_items", "default"))
        self.assertEqual(result["deleted_items"], 2)
        self.assertEqual(len(self.fake.remove_calls), 2)
        self.assertNotIn("with_items", [cat["id"] for cat in self.fake.lib["libraries"][0]["categories"]])
        self.assertEqual(len(self.fake.saved), 1)

    def test_delete_default_workflow_category_is_protected(self):
        with unittest.mock.patch.dict(deps._bound, self.fake.bindings()):
            with self.assertRaises(main.HTTPException) as caught:
                run(assets_routes.delete_asset_library_category("workflows", "default"))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("默认工作流分类不能删除", str(caught.exception.detail))


class BroadcastTests(unittest.TestCase):
    def test_ws_message_shape(self):
        class FakeConn:
            def __init__(self):
                self.messages = []

            async def send_text(self, data):
                self.messages.append(data)

        conn = FakeConn()
        with unittest.mock.patch.object(main.manager, "active_connections", [conn]):
            run(main.manager.broadcast_asset_library_updated(1793613229297))
        payload = json.loads(conn.messages[0])
        self.assertEqual(payload, {"type": "asset_library_updated", "updated_at": 1793613229297})

    def test_save_asset_library_schedules_broadcast(self):
        lib = make_library()
        scheduled = []
        broadcast = unittest.mock.AsyncMock()

        def fake_run_coroutine_threadsafe(coro, loop):
            scheduled.append(coro)

        with tempfile.TemporaryDirectory() as tmp, \
                unittest.mock.patch.object(main, "ASSET_LIBRARY_PATH", os.path.join(tmp, "asset_library.json")), \
                unittest.mock.patch.object(main, "write_json_atomic", lambda *a, **k: None), \
                unittest.mock.patch.object(main, "GLOBAL_LOOP", object()), \
                unittest.mock.patch.object(main.asyncio, "run_coroutine_threadsafe",
                                            side_effect=fake_run_coroutine_threadsafe), \
                unittest.mock.patch.object(main.manager, "broadcast_asset_library_updated", new=broadcast):
            main.save_asset_library(lib)
            self.assertEqual(len(scheduled), 1)
            run(scheduled[0])
        broadcast.assert_awaited_once()
        self.assertIsInstance(broadcast.await_args.args[0], int)


if __name__ == "__main__":
    unittest.main()
