# -*- coding: utf-8 -*-
"""历史智能分类数据一次性清理：dry-run 不落盘，apply 归档旁车 / 清库字段 / 移走提示词，再跑 no-op。"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import classification_cleanup as cleanup  # noqa: E402

LIBRARY = {
    "active_library_id": "default",
    "libraries": [{
        "id": "default",
        "name": "默认资产库",
        "categories": [{
            "id": "characters",
            "name": "角色",
            "type": "image",
            "items": [
                {"id": "a1", "name": "图1", "kind": "image", "classification": {"summary": "一张海报"}},
                {"id": "a2", "name": "图2", "kind": "image", "classification": {"categories": {"model": ["单人模特"]}}},
                {"id": "a3", "name": "图3", "kind": "image"},
            ],
        }],
    }],
}


def _classification_keys(node):
    if isinstance(node, dict):
        return (1 if "classification" in node else 0) + sum(_classification_keys(v) for v in node.values())
    if isinstance(node, list):
        return sum(_classification_keys(v) for v in node)
    return 0


class ClassificationCleanupTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-classify-cleanup-")
        self.addCleanup(shutil.rmtree, self.root, True)
        uploads = os.path.join(self.root, "assets", "uploads")
        os.makedirs(os.path.join(uploads, "model"))
        Path(uploads, "top.classification.json").write_text('{"summary": "顶层"}', encoding="utf-8")
        Path(uploads, "model", "girl.png").write_bytes(b"png")
        Path(uploads, "model", "girl.classification.json").write_text('{"summary": "模特"}', encoding="utf-8")
        data = os.path.join(self.root, "data")
        os.makedirs(data)
        self.library_path = os.path.join(data, "asset_library.json")
        Path(self.library_path).write_text(json.dumps(LIBRARY, ensure_ascii=False, indent=2), encoding="utf-8")
        self.prompt_path = os.path.join(data, "asset_classification_prompt.txt")
        Path(self.prompt_path).write_text("旧分类规则", encoding="utf-8")

    @property
    def stamp_path(self):
        return os.path.join(self.root, cleanup.STAMP_NAME)

    def migrated(self):
        base = os.path.join(self.root, "_migrated")
        if not os.path.isdir(base):
            return []
        return sorted(os.listdir(base))

    def test_dry_run_only_counts_and_changes_nothing(self):
        lib_before = Path(self.library_path).read_text(encoding="utf-8")
        summary = cleanup.run(self.root)
        self.assertTrue(summary["ok"])
        self.assertFalse(summary["applied"])
        self.assertEqual(summary["sidecars_found"], 2)
        self.assertEqual(summary["sidecars_moved"], 0)
        self.assertEqual(summary["library_items_cleaned"], 2)
        self.assertTrue(summary["prompt_found"])
        self.assertFalse(summary["prompt_moved"])
        self.assertEqual(self.migrated(), [])
        self.assertFalse(os.path.exists(self.stamp_path))
        self.assertEqual(Path(self.library_path).read_text(encoding="utf-8"), lib_before)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "assets", "uploads", "top.classification.json")))
        self.assertTrue(os.path.isfile(self.prompt_path))

    def test_apply_archives_everything_and_writes_stamp(self):
        summary = cleanup.run(self.root, apply=True)
        self.assertTrue(summary["ok"], summary)
        self.assertEqual(summary["errors"], [])
        self.assertEqual(summary["sidecars_moved"], 2)
        self.assertEqual(summary["library_items_cleaned"], 2)
        self.assertTrue(summary["prompt_moved"])
        self.assertTrue(summary["library_backup"])
        self.assertTrue(os.path.isfile(self.stamp_path))

        dirs = self.migrated()
        self.assertEqual(len(dirs), 1)
        archive = os.path.join(self.root, "_migrated", dirs[0])
        self.assertEqual(summary["migrated_dir"], "_migrated/" + dirs[0])
        # 旁车按原相对路径归档，子目录结构保留
        self.assertTrue(os.path.isfile(os.path.join(archive, "assets", "uploads", "top.classification.json")))
        self.assertTrue(os.path.isfile(os.path.join(archive, "assets", "uploads", "model", "girl.classification.json")))
        self.assertFalse(os.path.exists(os.path.join(self.root, "assets", "uploads", "top.classification.json")))
        self.assertFalse(os.path.exists(os.path.join(self.root, "assets", "uploads", "model", "girl.classification.json")))
        # 分类提示词移到同一个 _migrated（仍是 data/ 下的相对位置）
        self.assertFalse(os.path.exists(self.prompt_path))
        self.assertTrue(os.path.isfile(os.path.join(archive, "data", "asset_classification_prompt.txt")))

        # 资产库里 classification 键全部消失，文字素材本身保留
        lib = json.loads(Path(self.library_path).read_text(encoding="utf-8"))
        self.assertEqual(_classification_keys(lib), 0)
        names = [item["name"] for item in lib["libraries"][0]["categories"][0]["items"]]
        self.assertEqual(names, ["图1", "图2", "图3"])

        # 备份是原样（仍带 classification）
        backup = os.path.join(self.root, summary["library_backup"])
        self.assertTrue(os.path.isfile(backup))
        self.assertEqual(_classification_keys(json.loads(Path(backup).read_text(encoding="utf-8"))), 2)

        stamp = json.loads(Path(self.stamp_path).read_text(encoding="utf-8"))
        self.assertEqual(stamp["sidecars_moved"], 2)
        self.assertEqual(stamp["library_items_cleaned"], 2)
        self.assertTrue(stamp["prompt_moved"])

    def test_second_run_is_noop(self):
        cleanup.run(self.root, apply=True)
        dirs_before = self.migrated()
        stamp_before = Path(self.stamp_path).read_text(encoding="utf-8")
        again = cleanup.run(self.root, apply=True)
        self.assertTrue(again["skipped"])
        self.assertEqual(again["stamp"], cleanup.STAMP_NAME)
        self.assertEqual(self.migrated(), dirs_before)
        self.assertEqual(Path(self.stamp_path).read_text(encoding="utf-8"), stamp_before)
        self.assertEqual(again["sidecars_moved"], 0)

    def test_library_without_classification_is_left_untouched(self):
        Path(self.library_path).write_text(json.dumps(
            {"libraries": [{"id": "default", "categories": [{"id": "c", "items": [{"id": "x", "name": "n"}]}]}]},
            ensure_ascii=False), encoding="utf-8")
        before = Path(self.library_path).read_text(encoding="utf-8")
        summary = cleanup.run(self.root, apply=True)
        self.assertEqual(summary["library_items_cleaned"], 0)
        self.assertEqual(summary["library_backup"], "")
        self.assertEqual(Path(self.library_path).read_text(encoding="utf-8"), before)
        self.assertTrue(os.path.isfile(self.stamp_path))

    def test_missing_data_dir_is_reported_not_raised(self):
        summary = cleanup.run(os.path.join(self.root, "does-not-exist"))
        self.assertFalse(summary["ok"])
        self.assertIn("数据目录不存在", summary.get("error") or "")


if __name__ == "__main__":
    unittest.main()
