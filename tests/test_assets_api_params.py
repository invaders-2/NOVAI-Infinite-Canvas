"""素材库三件套的查询参数/字段契约：canvas-assets 过滤 + natural_w/h、local-assets folder、asset-library 分类。"""
import asyncio
import sys
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.routes import assets as assets_routes
from server.routes.deps import deps


def run(coro):
    return asyncio.run(coro)


FAKE_INDEX = {
    "categories": [
        {"id": "all", "name": "全部画布", "count": 3, "canvas_count": 2},
        {"id": "smart", "name": "智能画布", "count": 2, "canvas_count": 1},
        {"id": "classic", "name": "普通画布", "count": 1, "canvas_count": 1},
    ],
    "canvases": [
        {"id": "c_smart", "title": "智能画布A", "kind": "smart", "asset_count": 2, "updated_at": 20},
        {"id": "c_classic", "title": "普通画布B", "kind": "classic", "asset_count": 1, "updated_at": 10},
    ],
    "items": [
        {"id": "i1", "url": "/assets/output/a.png", "name": "海报A", "kind": "image",
         "canvas_id": "c_smart", "canvas_title": "智能画布A", "canvas_kind": "smart",
         "node_title": "图片1", "natural_w": 1024, "natural_h": 1536},
        {"id": "i2", "url": "/assets/output/b.mp4", "name": "短片B", "kind": "video",
         "canvas_id": "c_smart", "canvas_title": "智能画布A", "canvas_kind": "smart",
         "node_title": "视频1", "gen_prompt": "海边日落"},
        {"id": "i3", "url": "/assets/output/c.png", "name": "海报C", "kind": "image",
         "canvas_id": "c_classic", "canvas_title": "普通画布B", "canvas_kind": "classic",
         "node_title": "图片2"},
    ],
}

FAKE_REGISTRY = {"assets": [
    {"asset_id": "a2", "url": "/assets/output/b.mp4", "natural_w": 1280, "natural_h": 720},
    {"asset_id": "a3", "url": "/assets/output/c.png", "natural_w": 800, "natural_h": 600},
]}

FAKE_TREE = [{"id": "__root__", "path": "", "name": "全部上传", "items": []},
             {"id": "sub", "path": "sub", "name": "sub", "items": []}]
FAKE_LOCAL_ITEMS = [
    {"id": "up_1.png", "file": "up_1.png", "name": "根图.png", "url": "/assets/uploads/up_1.png",
     "kind": "image", "folder": "", "natural_w": 320, "natural_h": 240, "caption": "一只猫"},
    {"id": "sub/up_2.png", "file": "sub/up_2.png", "name": "子图.png", "url": "/assets/uploads/sub/up_2.png",
     "kind": "image", "folder": "sub"},
    {"id": "sub/deep/up_3.png", "file": "sub/deep/up_3.png", "name": "深层.png",
     "url": "/assets/uploads/sub/deep/up_3.png", "kind": "image", "folder": "sub/deep"},
]


class CanvasAssetsParamsTests(unittest.TestCase):
    def call(self, **params):
        with unittest.mock.patch.dict(deps._bound, {"canvas_assets_index": lambda: FAKE_INDEX,
                                                    "load_assets_registry": lambda: FAKE_REGISTRY,
                                                    "output_file_from_url": lambda url: None}):
            return run(assets_routes.list_canvas_assets(**params))

    def test_fills_missing_natural_size_from_local_file(self):
        # 注册表也没有尺寸的旧数据：读本地图片头兜底（这里 patch 成 640x480）
        from PIL import Image
        import tempfile
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        Image.new("RGB", (640, 480)).save(tmp.name)
        tmp.close()
        try:
            with unittest.mock.patch.dict(deps._bound, {
                    "canvas_assets_index": lambda: {"categories": [], "canvases": [], "items": [
                        {"id": "old", "url": "/assets/output/old.png", "name": "老图", "kind": "image",
                         "canvas_id": "c1", "canvas_title": "旧画布", "canvas_kind": "classic"}]},
                    "load_assets_registry": lambda: {"assets": []},
                    "output_file_from_url": lambda url: tmp.name}):
                data = run(assets_routes.list_canvas_assets())
            item = data["items"][0]
            self.assertEqual((item["natural_w"], item["natural_h"]), (640, 480))
            self.assertIsInstance(item["natural_w"], int)
        finally:
            import os
            os.remove(tmp.name)

    def test_asset_kind_category_keeps_canvases_that_contain_it(self):
        # category=image 时画布列表不能被过滤成空：保留含该素材的画布
        data = self.call(category="image")
        self.assertEqual({c["id"] for c in data["canvases"]}, {"c_smart", "c_classic"})
        video = self.call(category="video")
        self.assertEqual({c["id"] for c in video["canvases"]}, {"c_smart"})
        self.assertEqual([item["kind"] for item in video["items"]], ["video"])

    def test_default_contract_unchanged(self):
        data = self.call()
        self.assertEqual(set(data) >= {"categories", "canvases", "items"}, True)
        self.assertEqual(len(data["items"]), 3)
        self.assertEqual(len(data["canvases"]), 2)
        self.assertEqual(data["count"], 3)
        self.assertEqual(data["total"], 3)

    def test_fills_missing_natural_size_from_registry(self):
        data = self.call()
        by_url = {item["url"]: item for item in data["items"]}
        self.assertEqual((by_url["/assets/output/b.mp4"]["natural_w"], by_url["/assets/output/b.mp4"]["natural_h"]), (1280, 720))
        self.assertEqual((by_url["/assets/output/c.png"]["natural_w"], by_url["/assets/output/c.png"]["natural_h"]), (800, 600))
        self.assertIsInstance(by_url["/assets/output/a.png"]["natural_w"], int)

    def test_category_filters_by_asset_kind_or_canvas_kind(self):
        by_kind = self.call(category="image")
        self.assertEqual({item["kind"] for item in by_kind["items"]}, {"image"})
        self.assertEqual(by_kind["count"], 2)
        self.assertNotIn("categories", [])  # categories 仍返回（契约不变）
        by_canvas_kind = self.call(category="classic")
        self.assertEqual([item["canvas_id"] for item in by_canvas_kind["items"]], ["c_classic"])
        self.assertEqual(self.call(category="all")["count"], 3)

    def test_canvas_filter_matches_id_or_title(self):
        self.assertEqual(self.call(canvas="c_smart")["count"], 2)
        by_title = self.call(canvas="智能画布A")
        self.assertEqual(by_title["count"], 2)
        self.assertEqual(len(by_title["canvases"]), 1)
        self.assertEqual(self.call(canvas="不存在")["count"], 0)

    def test_q_searches_name_video_prompt_and_titles(self):
        self.assertEqual(self.call(q="海报")["count"], 2)
        self.assertEqual(self.call(q="海边")["count"], 1)
        self.assertEqual(self.call(q="视频1")["count"], 1)

    def test_q_keeps_canvases_containing_matched_assets(self):
        # q 是素材名搜索：命中素材所属画布要保留在 canvases 里（不能因为画布标题不含关键词就清空）
        data = self.call(q="海报")
        self.assertEqual(len(data["items"]), 2)
        self.assertEqual({c["id"] for c in data["canvases"]}, {"c_smart", "c_classic"})
        self.assertEqual(self.call(q="不存在的素材")["count"], 0)

    def test_limit_caps_items_but_keeps_total(self):
        data = self.call(limit=1)
        self.assertEqual(len(data["items"]), 1)
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["total"], 3)


class LocalAssetsParamsTests(unittest.TestCase):
    def call(self, **params):
        with unittest.mock.patch.dict(deps._bound, {"_local_upload_tree_and_items": lambda: (FAKE_TREE, FAKE_LOCAL_ITEMS)}):
            return run(assets_routes.list_local_assets(**params))

    def test_default_contract_and_folders_summary(self):
        data = self.call()
        self.assertEqual(set(data) >= {"items", "tree", "folders"}, True)
        self.assertEqual(len(data["items"]), 3)
        folders = {row["path"]: row for row in data["folders"]}
        self.assertEqual(folders[""]["count"], 1)
        # folders 是按每个文件夹自己的 folder 字段精确统计（子目录单列），tree 仍保留层级
        self.assertEqual(folders["sub"]["count"], 1)
        self.assertEqual(folders["sub/deep"]["count"], 1)
        self.assertEqual(data["total"], 3)

    def test_folder_filter_includes_subtree(self):
        sub = self.call(folder="sub")
        self.assertEqual({item["folder"] for item in sub["items"]}, {"sub", "sub/deep"})
        self.assertEqual(sub["count"], 2)
        self.assertEqual([item["id"] for item in self.call(folder="sub/deep")["items"]], ["sub/deep/up_3.png"])

    def test_folder_filter_root_only(self):
        root = self.call(folder="__root__")
        self.assertEqual([item["id"] for item in root["items"]], ["up_1.png"])
        self.assertEqual(self.call(folder="root")["count"], 1)

    def test_q_and_limit(self):
        self.assertEqual(self.call(q="猫")["count"], 1)
        limited = self.call(limit=2)
        self.assertEqual(len(limited["items"]), 2)
        self.assertEqual(limited["count"], 2)
        self.assertEqual(limited["total"], 3)

    def test_items_expose_folder_and_natural_size(self):
        item = self.call(folder="sub/deep")["items"][0]
        self.assertIn("folder", item)
        first = self.call(folder="__root__")["items"][0]
        self.assertEqual((first["natural_w"], first["natural_h"]), (320, 240))


class AssetLibraryShapeTests(unittest.TestCase):
    def test_asset_library_categories(self):
        library = {"active_library_id": "default", "updated_at": 1, "categories": [], "libraries": [
            {"id": "default", "name": "默认资产库", "categories": [
                {"id": "characters", "name": "角色", "items": []},
                {"id": "scenes", "name": "场景", "items": []},
                {"id": "workflows", "name": "工作流", "items": []},
            ]}]}
        with unittest.mock.patch.dict(deps._bound, {"load_asset_library": lambda: library}):
            data = run(assets_routes.get_asset_library())
        self.assertEqual(data["library"]["libraries"][0]["id"], "default")
        names = [cat["name"] for cat in data["library"]["libraries"][0]["categories"]]
        self.assertEqual(names, ["角色", "场景", "工作流"])

    def test_prompt_libraries(self):
        library = {"active_library_id": "system", "libraries": [{"id": "system", "name": "系统提示词库",
                                                                "categories": [{"id": "view", "name": "视角"}]}]}
        with unittest.mock.patch.dict(deps._bound, {"public_prompt_libraries": lambda: library}):
            data = run(assets_routes.get_prompt_libraries())
        self.assertEqual(data["library"]["libraries"][0]["id"], "system")
        self.assertEqual(data["library"]["libraries"][0]["categories"][0]["name"], "视角")


if __name__ == "__main__":
    unittest.main()
