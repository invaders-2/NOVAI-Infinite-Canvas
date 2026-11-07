"""资产库子文件夹（分类层级 parent_id）：建/列/存条目/递归删除/移动/旧数据兼容/磁盘嵌套。"""
import asyncio
import copy
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


def make_library(categories=None):
    cats = categories if categories is not None else [
        {"id": "characters", "name": "角色", "type": "image", "dir": "角色", "items": []},
        {"id": "scenes", "name": "场景", "type": "image", "items": []},
        {"id": "workflows", "name": "工作流", "type": "workflow", "items": []},
    ]
    library = {"id": "default", "name": "默认资产库", "type": "asset", "categories": cats}
    return {"active_library_id": "default", "libraries": [library], "categories": cats}


class FakeHierarchy:
    def __init__(self, lib):
        self.lib = lib
        self.saved = []
        self.removed = []
        self.tmp = tempfile.TemporaryDirectory()
        self.dir_created = []

    def bindings(self):
        categories = self.lib["libraries"][0]["categories"]

        def find_category(lib_obj, category_id, library_id=""):
            return next((cat for cat in categories if str(cat.get("id") or "") == str(category_id or "")), None)

        def find_with_library(lib_obj, category_id, library_id=""):
            cat = find_category(lib_obj, category_id, library_id)
            return (self.lib["libraries"][0] if cat else None), cat

        def unique_dir(library, name):
            base = str(name or "分组")
            existing = {str(cat.get("dir") or "") for cat in categories if cat.get("dir")}
            candidate, index = base, 2
            while candidate in existing:
                candidate = f"{base}_{index}"
                index += 1
            return candidate

        def make_item(src, name="", subdir=""):
            self.dir_created.append(subdir)
            return name, {"id": f"item_{len(self.removed)}_{name}", "name": name, "kind": "image",
                          "url": f"/assets/library/{subdir}/x.png", "created_at": 1}

        def save(lib_obj):
            self.saved.append(copy.deepcopy(lib_obj))

        return {
            "load_asset_library": lambda: self.lib,
            "find_asset_library": lambda lib_obj, library_id="": next(
                (item for item in lib_obj.get("libraries") or [] if not library_id or item.get("id") == library_id), None),
            "find_asset_category_in_library": find_category,
            "find_asset_category_with_library": find_with_library,
            "save_asset_library": save,
            "remove_asset_library_file": lambda item: self.removed.append(item),
            "sanitize_asset_name": lambda name, default="": str(name or default).strip() or default,
            "unique_asset_category_dir": unique_dir,
            "make_asset_library_item": make_item,
            "generation_meta_for_url": lambda url: {},
            "classify_asset_image_best_effort": lambda *a: None,
            "output_file_from_url": lambda url: f"{self.tmp.name}/{os.path.basename(str(url))}",
            "asset_library_media_kind": main.asset_library_media_kind,
            "ASSET_LIBRARY_DIR": self.tmp.name,
        }

    def patched(self, testcase):
        patcher = unittest.mock.patch.dict(deps._bound, self.bindings())
        patcher.start()
        testcase.addCleanup(patcher.stop)

    def category(self, category_id):
        return next((cat for cat in self.lib["libraries"][0]["categories"] if cat.get("id") == category_id), None)


class CreateChildTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeHierarchy(make_library())
        self.fake.patched(self)

    def create(self, name, cat_type="image", parent_id=""):
        payload = assets_routes.AssetLibraryCategoryRequest(name=name, type=cat_type, library_id="default",
                                                           parent_id=parent_id)
        return run(assets_routes.create_asset_library_category(payload))

    def test_create_child_under_parent(self):
        result = self.create("男主", parent_id="characters")
        category = result["category"]
        self.assertEqual(category["parent_id"], "characters")
        self.assertEqual(category["type"], "image")
        self.assertEqual(category["dir"], "角色/男主")
        self.assertTrue(os.path.isdir(os.path.join(self.fake.tmp.name, "角色", "男主")))
        self.assertEqual(len(self.fake.saved), 1)

    def test_create_grandchild_nested_dir(self):
        child = self.create("男主", parent_id="characters")["category"]
        grandchild = self.create("童年", parent_id=child["id"])["category"]
        self.assertEqual(grandchild["parent_id"], child["id"])
        self.assertEqual(grandchild["dir"], "角色/男主/童年")
        self.assertTrue(os.path.isdir(os.path.join(self.fake.tmp.name, "角色", "男主", "童年")))

    def test_create_child_with_type_mismatch_is_rejected(self):
        with self.assertRaises(main.HTTPException) as caught:
            self.create("视频子集", cat_type="video", parent_id="characters")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("必须与父分类一致", str(caught.exception.detail))

    def test_create_child_with_missing_parent_is_404(self):
        with self.assertRaises(main.HTTPException) as caught:
            self.create("孤儿", parent_id="nope")
        self.assertEqual(caught.exception.status_code, 404)
        self.assertIn("父分类不存在", str(caught.exception.detail))

    def test_top_level_category_gets_empty_parent_and_unique_dir(self):
        first = self.create("角色")["category"]
        second = self.create("角色")["category"]
        self.assertEqual(first["parent_id"], "")
        self.assertNotEqual(first["dir"], second["dir"])

    def test_create_child_under_workflow_parent_keeps_workflow_type(self):
        result = self.create("子工作流", cat_type="workflow", parent_id="workflows")
        self.assertEqual(result["category"]["type"], "workflow")
        self.assertNotIn("dir", result["category"])


class ListHierarchyTests(unittest.TestCase):
    def test_normalize_adds_parent_id_and_breaks_orphans_and_cycles(self):
        lib = make_library([
            {"id": "a", "name": "A", "type": "image", "items": []},
            {"id": "b", "name": "B", "type": "image", "parent_id": "a", "items": []},
            {"id": "c", "name": "C", "type": "image", "parent_id": "missing", "items": []},
            {"id": "d", "name": "D", "type": "image", "parent_id": "d", "items": []},
        ])
        normalized = main.normalize_asset_library(copy.deepcopy(lib))
        cats = {cat["id"]: cat for cat in normalized["libraries"][0]["categories"]}
        self.assertEqual(cats["a"]["parent_id"], "")
        self.assertEqual(cats["b"]["parent_id"], "a")
        self.assertEqual(cats["c"]["parent_id"], "")       # 父不存在 -> 顶级
        self.assertEqual(cats["d"]["parent_id"], "")       # 自指 -> 顶级

    def test_normalize_breaks_two_node_cycle(self):
        lib = make_library([
            {"id": "a", "name": "A", "type": "image", "parent_id": "b", "items": []},
            {"id": "b", "name": "B", "type": "image", "parent_id": "a", "items": []},
        ])
        normalized = main.normalize_asset_library(copy.deepcopy(lib))
        cats = {cat["id"]: cat for cat in normalized["libraries"][0]["categories"]}
        # 栈不再成环：从任一分类沿父链走一定能到顶级
        for cat_id in ("a", "b"):
            seen = set()
            cursor = cats[cat_id]["parent_id"]
            while cursor:
                self.assertNotIn(cursor, seen)
                seen.add(cursor)
                cursor = cats[cursor]["parent_id"]
        # 只数 a/b 里的顶级（normalize 会额外补一个默认工作流分类）
        self.assertEqual(sum(1 for cat_id in ("a", "b") if cats[cat_id]["parent_id"] == ""), 1)

    def test_get_asset_library_returns_parent_id_field(self):
        lib = make_library()
        fake = FakeHierarchy(lib)
        fake.patched(self)
        with unittest.mock.patch.object(deps, "_bound", {**deps._bound, "load_asset_library": lambda: main.normalize_asset_library(copy.deepcopy(lib))}):
            data = run(assets_routes.get_asset_library())
        for cat in data["library"]["libraries"][0]["categories"]:
            self.assertIn("parent_id", cat)


class ItemsInChildTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeHierarchy(make_library([
            {"id": "characters", "name": "角色", "type": "image", "dir": "角色", "items": []},
            {"id": "male", "name": "男主", "type": "image", "dir": "角色/男主", "parent_id": "characters", "items": []},
        ]))
        self.fake.patched(self)

    def test_add_item_to_child_category_uses_child_dir(self):
        payload = assets_routes.AssetLibraryAddRequest(category_id="male", url="/output/a.png", name="男主图",
                                                       classify=False)
        result = run(assets_routes.add_asset_library_item(payload))
        self.assertEqual(result["category"]["id"], "male")
        self.assertEqual(self.fake.dir_created[-1], "角色/男主")
        self.assertEqual(len(self.fake.category("male")["items"]), 1)
        self.assertEqual(self.fake.category("characters")["items"], [])


class DeleteHierarchyTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeHierarchy(make_library([
            {"id": "characters", "name": "角色", "type": "image", "dir": "角色", "items": [
                {"id": "p1", "kind": "image", "url": "/assets/library/角色/p1.png"}]},
            {"id": "male", "name": "男主", "type": "image", "dir": "角色/男主", "parent_id": "characters", "items": [
                {"id": "c1", "kind": "image", "url": "/assets/library/角色/男主/c1.png"}]},
            {"id": "female", "name": "女主", "type": "image", "dir": "角色/女主", "parent_id": "characters", "items": []},
        ]))
        self.fake.patched(self)
        os.makedirs(os.path.join(self.fake.tmp.name, "角色", "男主"), exist_ok=True)

    def test_delete_parent_recursively_with_counts(self):
        result = run(assets_routes.delete_asset_library_category("characters", "default"))
        self.assertEqual(result["deleted_categories"], 3)
        self.assertEqual(result["deleted_items"], 2)
        self.assertEqual(len(self.fake.removed), 2)
        self.assertEqual(self.fake.lib["libraries"][0]["categories"], [])
        self.assertFalse(os.path.isdir(os.path.join(self.fake.tmp.name, "角色")))
        self.assertEqual(len(self.fake.saved), 1)

    def test_delete_with_force_false_reports_counts(self):
        with self.assertRaises(main.HTTPException) as caught:
            run(assets_routes.delete_asset_library_category("characters", "default", False))
        self.assertEqual(caught.exception.status_code, 400)
        message = str(caught.exception.detail)
        self.assertIn("2 个素材", message)
        self.assertIn("2 个子分类", message)
        self.assertEqual(self.fake.saved, [])

    def test_delete_leaf_child(self):
        result = run(assets_routes.delete_asset_library_category("female", "default"))
        self.assertEqual(result["deleted_categories"], 1)
        self.assertEqual(result["deleted_items"], 0)
        self.assertIsNone(self.fake.category("female"))
        self.assertIsNotNone(self.fake.category("characters"))

    def test_default_workflow_category_still_protected(self):
        self.fake.lib["libraries"][0]["categories"].append(
            {"id": "workflows", "name": "工作流", "type": "workflow", "items": []})
        with unittest.mock.patch.dict(deps._bound, {"find_asset_category_with_library": lambda lib, cid, lid="": (
                self.fake.lib["libraries"][0], self.fake.category("workflows"))}):
            with self.assertRaises(main.HTTPException) as caught:
                run(assets_routes.delete_asset_library_category("workflows", "default"))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("默认工作流分类不能删除", str(caught.exception.detail))


class MoveCategoryTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeHierarchy(make_library([
            {"id": "characters", "name": "角色", "type": "image", "dir": "角色", "items": []},
            {"id": "scenes", "name": "场景", "type": "image", "dir": "场景", "items": []},
            {"id": "free", "name": "临时", "type": "image", "dir": "临时", "items": []},
        ]))
        self.fake.patched(self)
        os.makedirs(os.path.join(self.fake.tmp.name, "临时"), exist_ok=True)

    def move(self, category_id, parent_id):
        payload = assets_routes.AssetLibraryRenameRequest(name="", library_id="default", parent_id=parent_id)
        return run(assets_routes.rename_asset_library_category(category_id, payload))

    def test_move_empty_category_into_parent_and_rename_disk_dir(self):
        result = self.move("free", "characters")
        self.assertEqual(result["category"]["parent_id"], "characters")
        self.assertEqual(result["category"]["dir"], "角色/临时")
        self.assertFalse(os.path.isdir(os.path.join(self.fake.tmp.name, "临时")))
        self.assertTrue(os.path.isdir(os.path.join(self.fake.tmp.name, "角色", "临时")))

    def test_move_empty_category_to_top(self):
        changed = self.move("free", "characters")["category"]
        back = self.move(changed["id"], "")["category"]
        self.assertEqual(back["parent_id"], "")
        self.assertEqual(back["dir"], "临时")

    def test_move_into_its_own_descendant_rejected(self):
        child = run(assets_routes.create_asset_library_category(
            assets_routes.AssetLibraryCategoryRequest(name="子集", type="image", library_id="default",
                                                      parent_id="characters")))["category"]
        with self.assertRaises(main.HTTPException) as caught:
            self.move("characters", child["id"])
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("子分类", str(caught.exception.detail))

    def test_move_category_with_items_rejected(self):
        self.fake.category("free")["items"] = [{"id": "x", "kind": "image", "url": "/assets/library/x.png"}]
        with self.assertRaises(main.HTTPException) as caught:
            self.move("free", "characters")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("还有素材", str(caught.exception.detail))


if __name__ == "__main__":
    unittest.main()
