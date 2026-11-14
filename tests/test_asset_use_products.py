# -*- coding: utf-8 -*-
"""素材用途 / 产品档案 / 深度视频关联，以及画布助手的 save_asset、save_product、use_asset(use/product)。"""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-asset-use-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main  # noqa: E402
from server import asset_meta  # noqa: E402
from server.routes import assets as routes  # noqa: E402

PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000000000200015e2b0a3d0000000049454e44ae426082")


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def run(coro):
    return asyncio.run(coro)


class InferUseTest(unittest.TestCase):
    def test_kind_name_folder_and_classification(self):
        self.assertEqual(asset_meta.infer_use({"kind": "audio"}), "sound")
        self.assertEqual(asset_meta.infer_use({"kind": "video", "name": "走秀"}), "source")
        self.assertEqual(asset_meta.infer_use({"kind": "video", "name": "走秀 · 深度"}), "depth")
        self.assertEqual(asset_meta.infer_use({"kind": "image", "name": "a"}, "产品"), "product")
        self.assertEqual(asset_meta.infer_use({"kind": "image", "name": "a"}, "角色"), "model")
        cls_model = {"categories": {"model": ["单人模特", "全身模特"]}}
        self.assertEqual(asset_meta.infer_use({"kind": "image", "classification": cls_model}), "model")
        cls_prod = {"categories": {"model": ["无人"], "subject": ["产品", "鞋"]}}
        self.assertEqual(asset_meta.infer_use({"kind": "image", "classification": cls_prod}), "product")
        cls_scene = {"categories": {"model": ["无人"], "scene": ["室外"]}}
        self.assertEqual(asset_meta.infer_use({"kind": "image", "classification": cls_scene}), "scene")
        self.assertEqual(asset_meta.infer_use({"kind": "image", "name": "IMG_1"}), "")

    def test_manual_use_survives_auto_refresh(self):
        item = {"kind": "image", "name": "x", "classification": {"categories": {"model": ["单人模特"]}}}
        self.assertEqual(asset_meta.set_manual_use(item, "产品"), "product")
        self.assertFalse(asset_meta.apply_auto_use(item))
        self.assertEqual(item["use"], "product")
        asset_meta.set_manual_use(item, "")
        asset_meta.apply_auto_use(item)
        self.assertEqual((item["use"], item["use_source"]), ("model", "auto"))
        self.assertEqual(asset_meta.normalize_use("深度视频"), "depth")
        self.assertEqual(asset_meta.normalize_use("胡说"), "")


class NodeAssetSummaryTest(unittest.TestCase):
    def test_beat_node_exposes_source_asset(self):
        node = {"id": "n1", "kind": "image", "data": {"gen": {"title": "白鞋", "uploaded": True,
                "hist": [{"url": "/assets/library/a.png"}], "asset": {"id": "asset_1", "use": "product", "productId": "prod_1"}}}}
        self.assertEqual(main._agent_beat_asset(node), {"item_id": "asset_1", "use": "product", "product_id": "prod_1"})
        self.assertIsNone(main._agent_beat_asset({"id": "n2", "kind": "image", "data": {"gen": {"title": "x"}}}))


class LibraryFlowTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="lib-", dir=_TMP)
        self.out = os.path.join(self.dir, "output")
        os.makedirs(self.out)
        os.makedirs(os.path.join(self.dir, "library"))
        for name in ("shoe_front.png", "shoe_side.png", "model.png"):
            Path(self.out, name).write_bytes(PNG)
        Path(self.out, "walk.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
        Path(self.out, "walk_depth.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
        patches = [
            mock.patch.object(main, "OUTPUT_DIR", self.out),
            mock.patch.object(main, "ASSET_LIBRARY_DIR", os.path.join(self.dir, "library")),
            mock.patch.object(main, "ASSET_LIBRARY_PATH", os.path.join(self.dir, "asset_library.json")),
            mock.patch.object(routes, "_spawn_asset_library_classification", return_value=False),
            mock.patch.object(main, "generation_meta_for_url", return_value=None),
            mock.patch.object(main, "_local_upload_tree_and_items", return_value=({}, [])),
            mock.patch.object(main, "OUTPUT_INPUT_DIR", os.path.join(self.dir, "none")),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tool(self, tool_name, **args):
        spec = main.AGENT_TOOLS[tool_name]
        return spec["run"](spec["validate"](args))

    def test_save_asset_with_product_then_search_by_product_and_use(self):
        r = self.tool("save_asset", items=[{"url": "/output/shoe_front.png", "name": "白鞋正面", "label": "正面"},
                                           {"url": "/output/shoe_side.png", "name": "白鞋侧面", "label": "侧面"}],
                      product="白色运动鞋")
        self.assertTrue(r["ok"], r)
        self.assertEqual([s["use"] for s in r["saved"]], ["product", "product"])
        self.assertEqual(r["product"]["angle_count"], 2)
        self.assertEqual([a["label"] for a in r["product"]["angles"]], ["正面", "侧面"])
        lib = main.load_asset_library()
        _, cat, _ = asset_meta.find_item(lib, item_id=r["saved"][0]["item_id"])
        self.assertEqual(cat["name"], "产品", "没给文件夹时按用途落到「产品」，不再进「角色」")

        found = self.tool("use_asset", product="白色运动鞋")
        self.assertEqual([h["label"] for h in found["items"]], ["正面", "侧面"])
        self.assertEqual(found["product"]["name"], "白色运动鞋")
        missing = self.tool("use_asset", product="不存在")
        self.assertEqual(missing["items"], [])
        self.assertIn("白色运动鞋", missing["available_products"])

        self.tool("save_asset", items=[{"url": "/output/model.png", "name": "模特全身"}], use="模特", folder="模特图")
        models = self.tool("use_asset", use="model")
        self.assertEqual([h["name"] for h in models["items"]], ["模特全身"])
        self.assertEqual(self.tool("use_asset", query="运动鞋")["products"], ["白色运动鞋"])

    def test_save_asset_twice_does_not_duplicate(self):
        first = self.tool("save_asset", items=[{"url": "/output/model.png"}])
        url = first["saved"][0]["url"]
        again = self.tool("save_asset", items=[{"url": url}], use="model")
        self.assertEqual(again["saved"][0]["item_id"], first["saved"][0]["item_id"])
        lib = main.load_asset_library()
        self.assertEqual(sum(1 for _ in asset_meta.iter_items(lib)), 1)
        self.assertEqual(asset_meta.find_item(lib, url=url)[2]["use"], "model")

    def test_depth_video_links_to_source_and_bad_url_reports_error(self):
        src = self.tool("save_asset", items=[{"url": "/output/walk.mp4", "name": "走秀原片"}])
        self.assertEqual(src["saved"][0]["use"], "source")
        depth = self.tool("save_asset", items=[{"url": "/output/walk_depth.mp4", "name": "走秀深度"}],
                          use="depth", derived_from=src["saved"][0]["url"])
        lib = main.load_asset_library()
        item = asset_meta.find_item(lib, item_id=depth["saved"][0]["item_id"])[2]
        self.assertEqual(item["derived_from"], src["saved"][0]["item_id"])
        hit = self.tool("use_asset", use="depth")["items"][0]
        self.assertEqual(hit["derived_from"], src["saved"][0]["item_id"])
        bad = self.tool("save_asset", items=[{"url": "https://example.com/x.png"}])
        self.assertFalse(bad["ok"])
        self.assertEqual(len(bad["errors"]), 1)

    def test_save_product_and_routes(self):
        a = self.tool("save_asset", items=[{"url": "/output/shoe_front.png"}, {"url": "/output/shoe_side.png"}])
        ids = [s["item_id"] for s in a["saved"]]
        r = self.tool("save_product", name="白色运动鞋", selling_points="轻量透气",
                      angles=[{"item_id": ids[0], "label": "正面"}, {"url": a["saved"][1]["url"], "label": "侧面"},
                              {"url": "/output/nope.png"}])
        self.assertEqual(r["product"]["angle_count"], 2)
        self.assertEqual(r["missing"], ["/output/nope.png"])
        lib = main.load_asset_library()
        self.assertEqual({asset_meta.find_item(lib, item_id=i)[2]["use"] for i in ids}, {"product"})

        listed = run(routes.list_asset_products())
        self.assertEqual([p["name"] for p in listed["products"]], ["白色运动鞋"])
        pid = listed["products"][0]["id"]
        upd = run(routes.update_asset_product(pid, routes.AssetProductRequest(angles=[ids[1]])))
        self.assertEqual(upd["product"]["angle_count"], 1)
        patched = run(routes.rename_asset_library_item(ids[0], routes.AssetLibraryItemPatchRequest(use="场景")))
        self.assertEqual((patched["item"]["use"], patched["item"]["use_source"]), ("scene", "manual"))
        with self.assertRaises(Exception):
            run(routes.rename_asset_library_item(ids[0], routes.AssetLibraryItemPatchRequest(use="胡说")))
        renamed = run(routes.rename_asset_library_item(ids[0], routes.AssetLibraryItemPatchRequest(name="新名字")))
        self.assertEqual(renamed["item"]["name"], "新名字")
        self.assertEqual(renamed["item"]["use"], "scene", "只改名不动用途")
        self.assertTrue(run(routes.delete_asset_product(pid))["ok"])
        lib = main.load_asset_library()
        self.assertNotIn("product_id", asset_meta.find_item(lib, item_id=ids[1])[2])

    def test_validation_errors(self):
        with self.assertRaises(main.AgentToolError):
            main.AGENT_TOOLS["save_asset"]["validate"]({"items": []})
        with self.assertRaises(main.AgentToolError):
            main.AGENT_TOOLS["save_asset"]["validate"]({"items": [{"url": "/output/a.png"}], "use": "胡说"})
        with self.assertRaises(main.AgentToolError):
            main.AGENT_TOOLS["save_product"]["validate"]({})
        with self.assertRaises(main.AgentToolError):
            main.AGENT_TOOLS["use_asset"]["validate"]({"use": "胡说"})
        self.assertIn("save_asset", main.AGENT_FREE_TOOLS)
        self.assertFalse(main.AGENT_TOOLS["save_asset"]["mutates_canvas"])


if __name__ == "__main__":
    unittest.main()
