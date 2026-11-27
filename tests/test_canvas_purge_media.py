import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class CanvasPurgeMediaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "assets"
        self.generated = self.assets / "output"
        self.inputs = self.assets / "input"
        self.legacy = self.root / "output"
        self.data = self.root / "data"
        self.canvases = self.data / "canvases"
        self.previews = self.data / "media_previews"
        self.versions = self.data / "canvas_versions"
        self.threads = self.data / "agent_threads"
        for path in (self.generated, self.inputs, self.legacy, self.canvases,
                     self.previews, self.versions, self.threads):
            path.mkdir(parents=True, exist_ok=True)
        self.history = self.root / "history.json"
        self.history.write_text("[]", encoding="utf-8")
        self.asset_library = self.data / "asset_library.json"
        self.registry = self.data / "assets_registry.json"
        self.asset_hashes = self.data / "asset_hashes.json"
        self.patches = [
            patch.object(main, "ASSETS_DIR", str(self.assets)),
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.generated)),
            patch.object(main, "OUTPUT_DIR", str(self.legacy)),
            patch.object(main, "DATA_DIR", str(self.data)),
            patch.object(main, "CANVAS_DIR", str(self.canvases)),
            patch.object(main, "MEDIA_PREVIEW_DIR", str(self.previews)),
            patch.object(main, "CANVAS_VERSIONS_DIR", str(self.versions)),
            patch.object(main, "AGENT_THREADS_DIR", str(self.threads)),
            patch.object(main, "HISTORY_FILE", str(self.history)),
            patch.object(main, "ASSET_LIBRARY_PATH", str(self.asset_library)),
            patch.object(main, "CANVAS_ASSETS_REGISTRY_PATH", str(self.registry)),
            patch.object(main, "ASSET_HASH_FILE", str(self.asset_hashes)),
            patch.object(main, "_agent_v2_memory_forget_canvas", lambda *a, **k: {}),
        ]
        for item in self.patches:
            item.start()
        main._CANVAS_RECORD_CACHE.clear()
        main.reset_asset_hash_cache()

    def tearDown(self):
        main._CANVAS_RECORD_CACHE.clear()
        main.reset_asset_hash_cache()
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    # ── 构造工具 ──────────────────────────────────────────────
    def media(self, name, content=b"image", root=None):
        folder = root or self.generated
        path = folder / name
        path.write_bytes(content)
        prefix = "/output/" if root is self.legacy else "/assets/output/"
        return path, prefix + name

    def write_canvas(self, canvas_id, urls, deleted_at=0):
        value = {
            "id": canvas_id,
            "title": canvas_id,
            "nodes": [{"id": "node-1", "type": "smart-image", "images": [{"url": u} for u in urls]}],
            "connections": [],
            "logs": [],
            "deleted_at": deleted_at,
            "updated_at": 1,
        }
        (self.canvases / f"{canvas_id}.json").write_text(json.dumps(value), encoding="utf-8")
        return value

    def write_history(self, entries):
        self.history.write_text(json.dumps(entries), encoding="utf-8")

    def write_library(self, items):
        lib = main.default_asset_library()
        lib["libraries"][0]["categories"][0]["items"] = items
        self.asset_library.write_text(json.dumps(lib), encoding="utf-8")

    def read_library(self):
        lib = json.loads(self.asset_library.read_text(encoding="utf-8"))
        return lib["libraries"][0]["categories"][0]["items"]

    def write_registry(self, assets):
        self.registry.write_text(json.dumps({"assets": assets}), encoding="utf-8")

    def write_hash_entries(self, entries):
        index = {}
        for i, (url, path) in enumerate(entries):
            index[f"digest{i}"] = {"url": url, "path": str(path), "size": 1, "name": "x", "updated_at": 1}
        self.asset_hashes.write_text(json.dumps(index), encoding="utf-8")
        main.reset_asset_hash_cache()

    def write_preview(self, path):
        preview = Path(main.media_preview_cache_paths(str(path), 256)[0])
        preview.write_bytes(b"preview")
        return preview

    # ── 独占 / 共用 ───────────────────────────────────────────
    async def test_purge_removes_exclusive_media(self):
        exclusive, exclusive_url = self.media("exclusive.png")
        canvas = self.write_canvas("trash_a", [exclusive_url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertFalse(exclusive.exists())
        self.assertEqual(stats["removed_files"], ["exclusive.png"])
        self.assertEqual(stats["removed_bytes"], 5)
        self.assertEqual(stats["skipped_referenced"], [])

    async def test_purge_keeps_media_referenced_by_a_live_canvas(self):
        exclusive, exclusive_url = self.media("exclusive.png")
        shared, shared_url = self.media("shared.png")
        self.write_canvas("live_b", [shared_url])
        canvas = self.write_canvas("trash_a", [exclusive_url, shared_url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertFalse(exclusive.exists())
        self.assertTrue(shared.exists())
        self.assertEqual(stats["removed_files"], ["exclusive.png"])
        self.assertEqual(stats["skipped_referenced"], ["shared.png"])

    async def test_purge_keeps_media_referenced_by_another_trashed_canvas(self):
        # 单张彻底删除时，别的回收站画布之后可能被恢复，它引用的图必须留着
        shared_by_trash, url = self.media("shared-by-trash.png")
        self.write_canvas("trash_b", [url], deleted_at=200)
        canvas = self.write_canvas("trash_a", [url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertTrue(shared_by_trash.exists())
        self.assertEqual(stats["removed_files"], [])
        self.assertEqual(stats["skipped_referenced"], ["shared-by-trash.png"])

    async def test_clear_trash_removes_media_shared_by_other_trashed_canvases(self):
        # 清空回收站是整批全清：两个回收站画布共用的图可以删；正常画布引用的不删
        shared, shared_url = self.media("clear-shared.png")
        live_only, live_url = self.media("clear-live.png")
        self.write_canvas("live_l", [live_url])
        self.write_canvas("trash_a", [shared_url, live_url], deleted_at=100)
        self.write_canvas("trash_b", [shared_url], deleted_at=200)

        stats = main._clear_canvas_trash()

        self.assertFalse(shared.exists())
        self.assertTrue(live_only.exists())
        self.assertEqual(stats["ok"], True)
        self.assertEqual(stats["cleared"], 2)
        self.assertEqual(stats["removed_files"], ["clear-shared.png"])
        self.assertEqual(stats["skipped_referenced"], ["clear-live.png"])
        self.assertFalse((self.canvases / "trash_a.json").exists())
        self.assertFalse((self.canvases / "trash_b.json").exists())
        self.assertTrue((self.canvases / "live_l.json").exists())

    async def test_clear_trash_aggregates_stats_and_survives_failure(self):
        first, first_url = self.media("first.png")
        second, second_url = self.media("second.png", content=b"second-image")
        third, third_url = self.media("third.png")
        self.write_canvas("trash_1", [first_url], deleted_at=100)
        self.write_canvas("trash_2", [second_url], deleted_at=200)
        self.write_canvas("trash_3", [third_url], deleted_at=300)
        original = main._purge_canvas_media

        def flaky(canvas, *args, **kwargs):
            if canvas.get("id") == "trash_3":
                raise RuntimeError("boom")
            return original(canvas, *args, **kwargs)

        with patch.object(main, "_purge_canvas_media", flaky):
            stats = main._clear_canvas_trash()

        self.assertEqual(stats["cleared"], 2)
        self.assertEqual([item["id"] for item in stats["failed"]], ["trash_3"])
        self.assertIn("boom", stats["failed"][0]["reason"])
        self.assertEqual(stats["removed_files"], ["first.png", "second.png"])
        self.assertEqual(stats["removed_bytes"], len(b"image") + len(b"second-image"))
        self.assertFalse(first.exists())
        self.assertFalse(second.exists())
        self.assertTrue(third.exists())
        self.assertTrue((self.canvases / "trash_3.json").exists())

    async def test_purge_removes_asset_hash_entries(self):
        path, url = self.media("hash-exclusive.png")
        kept, kept_url = self.media("hash-kept.png")
        self.write_canvas("live_l", [kept_url])
        self.write_hash_entries([(url, path), (kept_url, kept)])
        canvas = self.write_canvas("trash_a", [url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertEqual(stats["removed_asset_hashes"], 1)
        index = json.loads(self.asset_hashes.read_text(encoding="utf-8"))
        self.assertEqual([entry["url"] for entry in index.values()], [kept_url])

    async def test_purge_skips_everything_when_a_canvas_json_is_unreadable(self):
        path, url = self.media("maybe-shared.png")
        (self.canvases / "being-written.json").write_text("{", encoding="utf-8")
        canvas = self.write_canvas("trash_a", [url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertTrue(path.exists())
        self.assertEqual(stats["removed_files"], [])
        self.assertEqual(stats["skipped_referenced"], ["maybe-shared.png"])

    async def test_purge_handles_legacy_output_mount(self):
        path, url = self.media("legacy.mp4", content=b"video", root=self.legacy)
        canvas = self.write_canvas("trash_a", [url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertFalse(path.exists())
        self.assertEqual(stats["removed_files"], ["legacy.mp4"])

    async def test_purge_never_touches_paths_outside_the_mount(self):
        secret = self.root / "secret.png"
        secret.write_bytes(b"secret")
        canvas = self.write_canvas("trash_a", ["/assets/output/../secret.png"], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertTrue(secret.exists())
        self.assertEqual(stats["removed_files"], [])

    async def test_purge_keeps_user_uploaded_inputs(self):
        reference = self.inputs / "reference.png"
        reference.write_bytes(b"reference")
        canvas = self.write_canvas("trash_a", ["/assets/input/reference.png"], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertTrue(reference.exists())
        self.assertEqual(stats["removed_files"], [])

    async def test_purge_removes_preview_cache(self):
        path, url = self.media("with-preview.png")
        preview = self.write_preview(path)
        canvas = self.write_canvas("trash_a", [url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertFalse(preview.exists())
        self.assertEqual(stats["removed_previews"], 1)
        self.assertEqual(stats["removed_bytes"], 5 + len(b"preview"))

    # ── 历史 / 素材库 / 资产注册表 ────────────────────────────
    async def test_purge_prunes_history_entries_for_removed_media(self):
        path, url = self.media("history.png")
        kept, kept_url = self.media("kept.png")
        self.write_canvas("live_b", [kept_url])
        self.write_history([
            {"timestamp": 1, "url": url, "images": [url]},
            {"timestamp": 2, "url": kept_url, "images": [kept_url]},
        ])
        canvas = self.write_canvas("trash_a", [url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertEqual(stats["removed_history"], 1)
        remaining = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual([item["timestamp"] for item in remaining], [2])

    async def test_purge_removes_asset_library_items_for_removed_media(self):
        path, url = self.media("library.png")
        other = self.inputs / "other.png"
        other.write_bytes(b"other")
        self.write_library([
            {"id": "item-1", "name": "生成的图", "url": url, "kind": "image"},
            {"id": "item-2", "name": "自己传的图", "url": "/assets/input/other.png", "kind": "image"},
        ])
        canvas = self.write_canvas("trash_a", [url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertEqual(stats["removed_library"], 1)
        self.assertEqual([item["id"] for item in self.read_library()], ["item-2"])

    async def test_purge_removes_asset_registry_entries_for_removed_media(self):
        path, url = self.media("registry.png")
        self.write_registry([
            {"asset_id": "asset-1", "url": url, "canvas_ids": ["trash_a"]},
            {"asset_id": "asset-2", "url": "/assets/input/other.png", "canvas_ids": ["live_b"]},
        ])
        canvas = self.write_canvas("trash_a", [url], deleted_at=100)

        stats = main._purge_canvas_media(canvas)

        self.assertEqual(stats["removed_assets_registry"], 1)
        registry = json.loads(self.registry.read_text(encoding="utf-8"))
        self.assertEqual([item["asset_id"] for item in registry["assets"]], ["asset-2"])

    async def test_purge_can_skip_asset_library_cleanup(self):
        path, url = self.media("keep-library.png")
        self.write_library([{"id": "item-1", "name": "图", "url": url, "kind": "image"}])
        canvas = self.write_canvas("trash_a", [url], deleted_at=100)

        stats = main._purge_canvas_media(canvas, allow_asset_library_removal=False)

        self.assertFalse(path.exists())
        self.assertEqual(stats["removed_library"], 0)
        self.assertEqual([item["id"] for item in self.read_library()], ["item-1"])

    # ── 入口：purge API / 回收站过期清理 ──────────────────────
    async def test_purge_canvas_endpoint_deletes_json_and_reports_stats(self):
        path, url = self.media("endpoint.png")
        self.write_canvas("trash_a", [url], deleted_at=100)
        request = SimpleNamespace(state=SimpleNamespace())

        result = await main.purge_canvas("trash_a", request)

        self.assertTrue(result["ok"])
        self.assertFalse((self.canvases / "trash_a.json").exists())
        self.assertFalse(path.exists())
        self.assertEqual(result["removed_files"], ["endpoint.png"])
        self.assertEqual(result["removed_bytes"], 5)
        self.assertNotIn("_removed_paths", result)      # 私有字段不能泄进对外 JSON

    async def test_expired_trash_cleanup_purges_media_and_survives_one_failure(self):
        expired_path, expired_url = self.media("expired.png")
        self.write_canvas("expired", [expired_url], deleted_at=main.now_ms() - main.CANVAS_TRASH_RETENTION_MS - 1000)
        self.write_canvas("broken", [], deleted_at=main.now_ms() - main.CANVAS_TRASH_RETENTION_MS - 1000)
        main._CANVAS_RECORD_CACHE.clear()
        self.write_history([{"timestamp": 1, "url": expired_url, "images": [expired_url]}])
        original = main._purge_canvas_media

        def flaky(canvas, *args, **kwargs):
            if canvas.get("id") == "broken":
                raise RuntimeError("boom")
            return original(canvas, *args, **kwargs)

        output = io.StringIO()
        with patch.object(main, "_purge_canvas_media", flaky), contextlib.redirect_stdout(output):
            main.cleanup_expired_canvas_trash()

        self.assertFalse((self.canvases / "expired.json").exists())
        self.assertFalse(expired_path.exists())
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [])
        # 失败的那张画布保留下来，日志里有一行可查
        self.assertTrue((self.canvases / "broken.json").exists())
        self.assertIn("回收站过期清理失败 broken.json", output.getvalue())

    async def test_clear_trash_prunes_history_only_once(self):
        urls = []
        for i in range(3):
            path, url = self.media(f"once-{i}.png", content=f"img{i}".encode())
            urls.append((path, url))
            self.write_canvas(f"trash_{i}", [url], deleted_at=100 + i)
        self.write_history([{"timestamp": i, "url": url, "images": [url]} for i, (_p, url) in enumerate(urls)])
        writes = []
        original_write = main.write_json_atomic

        def counting_write(path, data, *args, **kwargs):
            if os.path.abspath(str(path)) == os.path.abspath(str(self.history)):
                writes.append(str(path))
            return original_write(path, data, *args, **kwargs)

        with patch.object(main, "write_json_atomic", counting_write):
            stats = main._clear_canvas_trash()

        # 3 张画布整批只写一次 history.json
        self.assertEqual(len(writes), 1)
        self.assertEqual(stats["removed_history"], 3)
        self.assertEqual(json.loads(self.history.read_text(encoding="utf-8")), [])

    async def test_clear_trash_aggregates_history_count_from_single_prune(self):
        for i in range(3):
            _path, url = self.media(f"agg-{i}.png", content=f"agg{i}".encode())
            self.write_canvas(f"trash_{i}", [url], deleted_at=100 + i)
        self.write_history([
            {"timestamp": 1, "url": "/assets/output/agg-0.png", "images": ["/assets/output/agg-0.png"]},
            {"timestamp": 2, "url": "/assets/output/agg-1.png", "images": ["/assets/output/agg-1.png"]},
            {"timestamp": 3, "url": "/assets/output/agg-2.png", "images": ["/assets/output/agg-2.png"]},
            {"timestamp": 4, "url": "/assets/output/unrelated.png", "images": ["/assets/output/unrelated.png"]},
        ])
        prune_calls = []
        original_prune = main.prune_history_for_media_paths

        def counting_prune(paths):
            prune_calls.append(set(paths))
            return original_prune(paths)

        with patch.object(main, "prune_history_for_media_paths", counting_prune):
            stats = main._clear_canvas_trash()

        self.assertEqual(len(prune_calls), 1)
        self.assertEqual(stats["removed_history"], 3)
        remaining = json.loads(self.history.read_text(encoding="utf-8"))
        self.assertEqual([item["timestamp"] for item in remaining], [4])

    async def test_expired_cleanup_clears_shared_media_and_hashes(self):
        # 过期批次整批全清：两张过期画布共用的图可以删，内容去重索引里的条目一起摘掉
        shared, shared_url = self.media("expired-shared.png")
        self.write_hash_entries([(shared_url, shared)])
        old = main.now_ms() - main.CANVAS_TRASH_RETENTION_MS - 1000
        self.write_canvas("expired-a", [shared_url], deleted_at=old)
        self.write_canvas("expired-b", [shared_url], deleted_at=old)
        main._CANVAS_RECORD_CACHE.clear()

        main.cleanup_expired_canvas_trash()

        self.assertFalse(shared.exists())
        self.assertFalse((self.canvases / "expired-a.json").exists())
        self.assertFalse((self.canvases / "expired-b.json").exists())
        self.assertEqual(json.loads(self.asset_hashes.read_text(encoding="utf-8")), {})

    # ── 备份口径 ─────────────────────────────────────────────
    async def test_backup_skips_trashed_canvas_json(self):
        exclusive, exclusive_url = self.media("trash-only.png")
        shared, shared_url = self.media("backup-shared.png")
        self.write_canvas("live_b", [shared_url])
        self.write_canvas("trash_a", [exclusive_url], deleted_at=100)

        arcs = [arc for _abs, arc in main._backup_data_files(False, False)]

        self.assertIn("data/canvases/live_b.json", arcs)
        self.assertNotIn("data/canvases/trash_a.json", arcs)

    async def test_backup_canvas_count_counts_only_live_canvases(self):
        self.write_canvas("live_b", [])
        self.write_canvas("trash_a", [], deleted_at=100)

        self.assertEqual(main._backup_canvas_count(), 1)

    async def test_backup_all_assets_excludes_trash_only_files(self):
        exclusive, exclusive_url = self.media("trash-only.png")
        shared, shared_url = self.media("backup-shared.png")
        self.write_canvas("live_b", [shared_url])
        self.write_canvas("trash_a", [exclusive_url, shared_url], deleted_at=100)

        data_files = main._backup_data_files(False, False)
        referenced = main._backup_referenced_assets(data_files)
        all_assets = main._backup_all_assets(data_files)

        self.assertEqual(sorted(referenced), ["assets/output/backup-shared.png"])
        self.assertNotIn("assets/output/trash-only.png", all_assets)
        self.assertIn("assets/output/backup-shared.png", all_assets)

    async def test_backup_skips_legacy_canvases_bak_dirs(self):
        legacy_dir = self.data / "canvases.bak-20260101-000000"
        legacy_dir.mkdir(parents=True)
        (legacy_dir / "old.json").write_text("{}", encoding="utf-8")

        arcs = [arc for _abs, arc in main._backup_data_files(False, False)]

        self.assertFalse(any(arc.startswith("data/canvases.bak") for arc in arcs))


if __name__ == "__main__":
    unittest.main()
