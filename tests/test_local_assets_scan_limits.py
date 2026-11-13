#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地素材扫描加固回归：只扫 NOVAI 管理的目录、不跟链接、深度/条目硬上限、超限截断有提示。

Boss 反馈：素材库读本地文件时不能把系统里所有文件都读（目录可能是 symlink / Windows junction）。
"""
import asyncio
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


def write_media(path: Path, payload=b"x" * 8):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


class ScanLimitsBase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.assets = root / "assets"
        self.uploads = self.assets / "uploads"
        self.output = self.assets / "output"
        self.other = self.assets / "other"
        self.external = root / "system-big-dir"
        for p in (self.uploads, self.output, self.other, self.external):
            p.mkdir(parents=True, exist_ok=True)
        self.patches = [
            patch.object(main, "ASSETS_DIR", str(self.assets)),
            patch.object(main, "LOCAL_UPLOAD_DIR", str(self.uploads)),
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.output)),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def scan(self):
        return main._local_upload_tree_and_items()

    def call_route(self, **params):
        with patch.dict(deps._bound, {"_local_upload_tree_and_items": main._local_upload_tree_and_items}):
            return asyncio.run(assets_routes.list_local_assets(**params))


class ScanScopeTests(ScanLimitsBase):
    def test_only_novai_directories_are_scanned(self):
        write_media(self.uploads / "up_a.png")
        write_media(self.output / "gen_a.jpg")
        write_media(self.other / "not_mine.png")        # assets/other 不属于本地素材
        write_media(self.external / "system.png")       # 系统里的大目录
        tree, items = self.scan()
        names = {it["name"] for it in items}
        self.assertEqual(names, {"up_a.png", "gen_a.jpg"})
        self.assertNotIn("not_mine.png", names)
        self.assertNotIn("system.png", names)
        # 生成物仍在「画布生成」只读文件夹里
        children = {c["name"]: c for c in tree["children"]}
        self.assertEqual(children[main.LOCAL_OUTPUT_FOLDER]["count"], 1)

    @unittest.skipUnless(hasattr(os, "symlink"), "平台不支持 symlink")
    def test_symlinked_directory_is_not_followed(self):
        try:
            os.symlink(self.external, self.uploads / "system-link", target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("当前环境不允许建目录 symlink")
        write_media(self.external / "huge_1.png")
        write_media(self.external / "huge_2.png")
        write_media(self.uploads / "up_a.png")
        tree, items = self.scan()
        names = {it["name"] for it in items}
        self.assertIn("up_a.png", names)
        self.assertNotIn("huge_1.png", names)
        self.assertGreaterEqual(tree["scan"]["skipped_links"], 1)
        self.assertTrue(all(it["folder"] != "system-link" for it in items))

    @unittest.skipUnless(hasattr(os, "symlink"), "平台不支持 symlink")
    def test_symlinked_file_is_skipped(self):
        target = self.external / "outside.png"
        write_media(target)
        try:
            os.symlink(target, self.uploads / "link.png")
        except (OSError, NotImplementedError):
            self.skipTest("当前环境不允许建文件 symlink")
        write_media(self.uploads / "up_a.png")
        tree, items = self.scan()
        self.assertEqual({it["name"] for it in items}, {"up_a.png"})
        self.assertGreaterEqual(tree["scan"]["skipped_links"], 1)


class ScanLimitTests(ScanLimitsBase):
    def test_max_entries_truncates_and_reports(self):
        for i in range(6):
            write_media(self.uploads / f"up_{i}.png")
        with patch.object(main, "LOCAL_SCAN_MAX_ENTRIES", 3):
            tree, items = self.scan()
            data = self.call_route()
        self.assertLessEqual(len(items), 3)
        self.assertTrue(tree["scan"]["truncated"])
        self.assertEqual(tree["scan"]["max_entries"], 3)
        self.assertTrue(data["truncated"])
        self.assertIn("超过扫描上限", data["notice"])
        self.assertLessEqual(data["total"], 3)

    def test_output_scan_shares_the_entry_budget(self):
        for i in range(4):
            write_media(self.output / f"gen_{i}.jpg")
        write_media(self.uploads / "up_a.png")
        with patch.object(main, "LOCAL_SCAN_MAX_ENTRIES", 3):
            tree, items = self.scan()
        self.assertLessEqual(len(items), 3)
        self.assertEqual(tree["scan"]["max_entries"], 3)
        self.assertTrue(tree["scan"]["truncated"])

    def test_max_depth_marks_truncated(self):
        deep = self.uploads / "a" / "b" / "c" / "d" / "e"
        write_media(deep / "too_deep.png")
        write_media(self.uploads / "up_a.png")
        with patch.object(main, "LOCAL_SCAN_MAX_DEPTH", 2):
            tree, items = self.scan()
        self.assertTrue(tree["scan"]["truncated"])
        self.assertGreaterEqual(tree["scan"]["skipped_depth"], 1)
        self.assertNotIn("too_deep.png", {it["name"] for it in items})
        self.assertIn("up_a.png", {it["name"] for it in items})

    def test_scan_meta_shape_and_counts(self):
        write_media(self.uploads / "up_a.png")
        write_media(self.uploads / "sub" / "up_b.png")
        write_media(self.output / "gen_a.jpg")
        tree, items = self.scan()
        scan = tree["scan"]
        for key in ("truncated", "skipped_links", "skipped_depth", "max_depth", "max_entries", "count"):
            self.assertIn(key, scan)
        self.assertFalse(scan["truncated"])
        self.assertEqual(scan["count"], 3)
        self.assertEqual(scan["upload_count"], 2)
        self.assertEqual(scan["output_count"], 1)


class RouteContractTests(ScanLimitsBase):
    def test_route_reports_scan_fields_and_keeps_generated_scope(self):
        write_media(self.uploads / "up_a.png")
        write_media(self.output / "gen_a.jpg")
        root = self.call_route()
        self.assertEqual(root["total"], 1)
        self.assertEqual(root["generated_hidden"], 1)
        self.assertFalse(root["truncated"])
        self.assertEqual(root["notice"], "")
        self.assertIn("scan", root)
        self.assertEqual(root["scan"]["count"], 2)
        gen = self.call_route(folder=main.LOCAL_OUTPUT_FOLDER)
        self.assertEqual(gen["total"], 1)
        self.assertTrue(gen["items"][0]["readonly"])

    def test_route_tolerates_non_dict_tree_from_mocks(self):
        fake_tree = [{"id": "__root__", "path": "", "name": "全部上传", "items": []}]
        fake_items = [{"id": "up_1.png", "file": "up_1.png", "name": "a.png", "url": "/assets/uploads/up_1.png",
                       "kind": "image", "folder": ""}]
        with patch.dict(deps._bound, {"_local_upload_tree_and_items": lambda: (fake_tree, fake_items)}):
            data = asyncio.run(assets_routes.list_local_assets())
        self.assertFalse(data["truncated"])
        self.assertEqual(data["scan"], {})
        self.assertEqual(data["total"], 1)


if __name__ == "__main__":
    unittest.main()
