# -*- coding: utf-8 -*-
"""删除画布时清理历史版本快照 + tools/cleanup_orphan_canvas_versions.py 的孤儿清理。

用真实 TestClient(main.app) + 临时数据目录；模型不参与。脚本部分用子进程跑真实入口，
环境变量 NOVAI_DATA_DIR 指向另一个临时目录，和 main 的数据目录互不影响。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-canvas-versions-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

CLIENT = TestClient(main.app)


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def new_canvas(title="版本清理画布"):
    resp = CLIENT.post("/api/canvases", json={"title": title, "kind": "classic"})
    assert resp.status_code == 200, resp.text
    return resp.json()["canvas"]["id"]


def seed_versions(canvas_id, count=2):
    """用真实快照函数写 count 个版本文件（force=True 绕过内容去重）。"""
    canvas = main.load_canvas_any(canvas_id)
    for index in range(count):
        canvas["nodes"] = [{"id": "n%d" % index}]
        main.snapshot_canvas_version(canvas, force=True)
    assert os.path.isdir(main.canvas_versions_dir(canvas_id))


def versions_in(canvas_id):
    vdir = main.canvas_versions_dir(canvas_id)
    if not os.path.isdir(vdir):
        return []
    return sorted(os.listdir(vdir))


class PurgeCleansVersionsTests(unittest.TestCase):

    def test_purge_removes_only_its_own_versions(self):
        live_id = new_canvas("留下的画布")
        purge_id = new_canvas("要彻底删的画布")
        trashed_id = new_canvas("回收站画布")
        for canvas_id in (live_id, purge_id, trashed_id):
            seed_versions(canvas_id)

        # 软删除：进回收站，版本目录必须保留（30 天内可恢复）
        resp = CLIENT.delete("/api/canvases/%s" % trashed_id)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(len(versions_in(trashed_id)), 2)

        resp = CLIENT.delete("/api/canvases/%s/purge" % purge_id)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertFalse(os.path.exists(main.canvas_path(purge_id)))
        self.assertFalse(os.path.isdir(main.canvas_versions_dir(purge_id)))
        # 别的画布一个都不许动
        self.assertEqual(len(versions_in(live_id)), 2)
        self.assertEqual(len(versions_in(trashed_id)), 2)
        # 缓存也要跟着清：否则重建同名画布会拿到旧元信息 / 被旧 digest 判定成「没变化」
        self.assertFalse(any(path.startswith(main.canvas_versions_dir(purge_id) + os.sep)
                             for path in main._VERSION_META_CACHE))
        self.assertNotIn(purge_id, main._LAST_SNAPSHOT_DIGEST)

    def test_invalid_id_is_noop_without_raising(self):
        self.assertEqual(main._remove_canvas_versions("!!!"), 0)
        self.assertEqual(main._remove_canvas_versions(""), 0)


class TrashCleanupCleansVersionsTests(unittest.TestCase):

    def test_expired_trash_removes_versions_recent_keeps(self):
        expired_id = new_canvas("过期画布")
        fresh_id = new_canvas("刚进回收站画布")
        seed_versions(expired_id)
        seed_versions(fresh_id)
        now = main.now_ms()
        for canvas_id, deleted_at in (
            (expired_id, now - main.CANVAS_TRASH_RETENTION_MS - 60000),
            (fresh_id, now - 1000),
        ):
            canvas = main.load_canvas_any(canvas_id)
            canvas["deleted_at"] = deleted_at
            main.save_canvas(canvas)

        main.cleanup_expired_canvas_trash()

        self.assertFalse(os.path.exists(main.canvas_path(expired_id)))
        self.assertFalse(os.path.isdir(main.canvas_versions_dir(expired_id)))
        self.assertTrue(os.path.exists(main.canvas_path(fresh_id)))
        self.assertEqual(len(versions_in(fresh_id)), 2)


class OrphanCleanupScriptTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-orphan-script-")
        self.canvases = os.path.join(self.root, "data", "canvases")
        self.versions = os.path.join(self.root, "data", "canvas_versions")
        os.makedirs(self.canvases)
        os.makedirs(self.versions)
        self._write_canvas("cv_live.json", {"id": "cv_live", "title": "存活画布"})
        # 回收站画布算存活，版本目录绝不能被当成孤儿
        self._write_canvas("cv_trash.json", {"id": "cv_trash", "title": "回收站画布", "deleted_at": 1})
        for name in ("cv_live", "cv_trash", "gone_canvas", "gone_canvas_two"):
            self._seed_dir(name)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _write_canvas(self, filename, doc):
        with open(os.path.join(self.canvases, filename), "w", encoding="utf-8") as handle:
            json.dump(doc, handle, ensure_ascii=False)

    def _seed_dir(self, name, files=2):
        folder = os.path.join(self.versions, name)
        os.makedirs(folder, exist_ok=True)
        for index in range(files):
            with open(os.path.join(folder, "v%d.json" % (index + 1)), "w", encoding="utf-8") as handle:
                handle.write('{"version": %d}' % (index + 1))

    def _run(self, *args):
        env = dict(os.environ)
        env["NOVAI_DATA_DIR"] = self.root
        return subprocess.run(
            [sys.executable, str(ROOT / "tools" / "cleanup_orphan_canvas_versions.py")] + list(args),
            cwd=str(ROOT), env=env, capture_output=True, text=True,
        )

    def test_dry_run_keeps_everything_then_apply_removes_only_orphans(self):
        dry = self._run()
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn("存活画布：1", dry.stdout)
        self.assertIn("回收站画布：1", dry.stdout)
        self.assertIn("孤儿目录：2", dry.stdout)
        self.assertIn("孤儿快照文件：4", dry.stdout)
        for name in ("cv_live", "cv_trash", "gone_canvas", "gone_canvas_two"):
            self.assertTrue(os.path.isdir(os.path.join(self.versions, name)), name)

        applied = self._run("--apply")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertIn("已清理 2 个孤儿目录", applied.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.versions, "gone_canvas")))
        self.assertFalse(os.path.exists(os.path.join(self.versions, "gone_canvas_two")))
        self.assertEqual(sorted(os.listdir(os.path.join(self.versions, "cv_live"))), ["v1.json", "v2.json"])
        self.assertEqual(sorted(os.listdir(os.path.join(self.versions, "cv_trash"))), ["v1.json", "v2.json"])

    def test_unreadable_canvas_blocks_deletion(self):
        with open(os.path.join(self.canvases, "broken.json"), "w", encoding="utf-8") as handle:
            handle.write("{not json")
        applied = self._run("--apply")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertIn("无法判断归属", applied.stdout)
        self.assertTrue(os.path.isdir(os.path.join(self.versions, "gone_canvas")))


if __name__ == "__main__":
    unittest.main()
