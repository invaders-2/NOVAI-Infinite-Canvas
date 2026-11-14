# -*- coding: utf-8 -*-
"""画布助手 use_asset 检索：所有资产库、AI 标签 / 摘要、本地上传、跟随存储设置的上传目录。"""
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

_TMP = tempfile.mkdtemp(prefix="novai-use-asset-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main  # noqa: E402


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def _cls(summary, *tags):
    return {"summary": summary, "flat": [{"dimension": "subject", "label": "主体", "tag": t} for t in tags],
            "tags": list(tags)}


LIBRARY = {
    "active_library_id": "default",
    "libraries": [
        {"id": "default", "name": "默认资产库", "categories": [
            {"id": "characters", "name": "角色", "type": "image", "items": [
                {"id": "a1", "name": "IMG_2033", "url": "/assets/library/lib_1_IMG_2033.jpg", "kind": "image",
                 "created_at": 1_700_000_000_000, "classification": _cls("白色运动鞋棚拍正面", "运动鞋", "白色", "棚拍")},
            ]},
        ]},
        {"id": "lib_b", "name": "产品库", "categories": [
            {"id": "c_prod", "name": "产品", "type": "image", "items": [
                {"id": "b1", "name": "棕色手提包", "url": "/assets/library/lib_2_bag.png", "kind": "image",
                 "created_at": 1_700_000_100_000},
            ]},
            {"id": "c_vid", "name": "源视频", "type": "video", "items": [
                {"id": "b2", "name": "走秀原片", "url": "/assets/library/lib_3_walk.mp4", "kind": "video",
                 "created_at": 1_700_000_200_000},
            ]},
        ]},
    ],
}
# normalize 后 categories 只镜像当前激活库：旧实现只读它，所以「产品库」里的素材会搜不到
LIBRARY["categories"] = LIBRARY["libraries"][0]["categories"]

LOCAL_ITEMS = [
    {"url": "/assets/uploads/model/girl.png", "name": "girl", "kind": "image", "folder": "model",
     "created_at": 1_700_000_300, "caption": "女模特全身站姿", "classification": _cls("女模特全身", "女性模特", "全身")},
    {"url": "/assets/output/gen_1.png", "name": "gen_1", "kind": "image", "folder": "画布生成",
     "created_at": 1_700_000_400, "source": "output"},
]


class UseAssetSearchTest(unittest.TestCase):
    def setUp(self):
        self.in_dir = tempfile.mkdtemp(prefix="novai-input-", dir=_TMP)
        for name in ("depth_walk.mp4", "note.txt", ".hidden.png"):
            Path(self.in_dir, name).write_bytes(b"x")
        patches = [
            mock.patch.object(main, "load_asset_library", return_value=LIBRARY),
            mock.patch.object(main, "_local_upload_tree_and_items", return_value=({}, LOCAL_ITEMS)),
            mock.patch.object(main, "OUTPUT_INPUT_DIR", self.in_dir),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_tool(self, **args):
        return main._agent_tool_use_asset_run(main._agent_tool_use_asset_validate(args))

    def urls(self, result):
        return [hit["url"] for hit in result["items"]]

    def test_matches_ai_tags_inside_unspaced_chinese_query(self):
        result = self.run_tool(query="白色运动鞋")
        self.assertEqual(self.urls(result)[0], "/assets/library/lib_1_IMG_2033.jpg")
        hit = result["items"][0]
        self.assertEqual(hit["summary"], "白色运动鞋棚拍正面")
        self.assertIn("运动鞋", hit["tags"])
        self.assertEqual(hit["library"], "默认资产库")

    def test_searches_every_library_not_just_active(self):
        result = self.run_tool(query="手提包")
        self.assertEqual(self.urls(result), ["/assets/library/lib_2_bag.png"])
        self.assertEqual(result["items"][0]["library"], "产品库")
        self.assertEqual(result["items"][0]["category"], "产品")

    def test_category_name_matches(self):
        self.assertIn("/assets/library/lib_3_walk.mp4", self.urls(self.run_tool(query="源视频")))

    def test_local_uploads_searchable_by_caption_and_tags(self):
        result = self.run_tool(query="女模特 全身")
        self.assertEqual(self.urls(result)[0], "/assets/uploads/model/girl.png")
        self.assertEqual(result["items"][0]["source"], "local")

    def test_generated_outputs_are_not_assets(self):
        self.assertNotIn("/assets/output/gen_1.png", self.urls(self.run_tool(query="", limit=20)))

    def test_upload_dir_follows_storage_setting(self):
        result = self.run_tool(query="depth", kind="video")
        self.assertEqual(self.urls(result), ["/assets/input/depth_walk.mp4"])
        self.assertEqual(result["items"][0]["source"], "upload")

    def test_kind_filter_and_no_match(self):
        self.assertEqual({h["kind"] for h in self.run_tool(kind="video", limit=20)["items"]}, {"video"})
        self.assertEqual(self.run_tool(query="不存在的东西")["items"], [])

    def test_empty_query_lists_newest_library_first_and_respects_limit(self):
        result = self.run_tool(limit=2)
        self.assertEqual(result["total"], 2)
        self.assertEqual(self.urls(result), ["/assets/library/lib_3_walk.mp4", "/assets/library/lib_2_bag.png"])
        self.assertEqual(result["results"], result["items"])


if __name__ == "__main__":
    unittest.main()
