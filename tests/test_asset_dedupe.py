import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class AssetDedupeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.assets = self.root / "assets"
        self.inputs = self.assets / "input"
        self.outputs = self.assets / "output"
        self.data = self.root / "data"
        self.previews = self.data / "media_previews"
        for path in (self.inputs, self.outputs, self.data, self.previews):
            path.mkdir(parents=True, exist_ok=True)
        self.hash_file = self.data / "asset_hashes.json"
        self.patches = [
            patch.object(main, "ASSETS_DIR", str(self.assets)),
            patch.object(main, "OUTPUT_INPUT_DIR", str(self.inputs)),
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.outputs)),
            patch.object(main, "DATA_DIR", str(self.data)),
            patch.object(main, "MEDIA_PREVIEW_DIR", str(self.previews)),
            patch.object(main, "ASSET_HASH_FILE", str(self.hash_file)),
        ]
        for item in self.patches:
            item.start()
        main.reset_asset_hash_cache()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        main.reset_asset_hash_cache()
        self.temp.cleanup()

    def input_files(self):
        return sorted(p for p in self.inputs.iterdir() if p.is_file())

    def _make_preview(self, name, size, mtime=None):
        path = self.previews / name
        path.write_bytes(b"x" * size)
        if mtime is not None:
            os.utime(str(path), (mtime, mtime))
        return path

    # ── 哈希助手 ──
    def test_sha256_helpers(self):
        data = b"hello novai"
        self.assertEqual(main.sha256_bytes(data), hashlib.sha256(data).hexdigest())
        blob = self.root / "blob.bin"
        blob.write_bytes(data)
        self.assertEqual(main.sha256_file(str(blob)), hashlib.sha256(data).hexdigest())

    # ── 去重：同一内容第二次上传复用 ──
    def test_second_upload_of_same_content_keeps_one_physical_file(self):
        content = b"same-bytes" * 100
        first_url = main.store_uploaded_bytes(content, "a.png", "input", "a.png")
        second_url = main.store_uploaded_bytes(content, "b.png", "input", "b.png")
        files = self.input_files()
        inodes = {os.stat(str(p)).st_ino for p in files}
        self.assertEqual(len(inodes), 1, f"同一内容应只有一份物理文件，实际 {[p.name for p in files]}")
        for url in (first_url, second_url):
            self.assertTrue(url.startswith("/assets/input/"), url)
        self.assertEqual((self.inputs / os.path.basename(first_url)).read_bytes(), content)
        index = json.loads(self.hash_file.read_text(encoding="utf-8"))
        self.assertIn(main.sha256_bytes(content), index)

    def test_hardlink_prefers_new_filename_when_supported(self):
        content = b"hardlink-check" * 10
        first_url = main.store_uploaded_bytes(content, "one.png", "input")
        second_url = main.store_uploaded_bytes(content, "two.png", "input")
        first_path = self.inputs / os.path.basename(first_url)
        if second_url != first_url:
            second_path = self.inputs / os.path.basename(second_url)
            self.assertTrue(second_path.is_file())
            self.assertEqual(os.stat(str(first_path)).st_ino, os.stat(str(second_path)).st_ino)
        self.assertEqual(first_path.read_bytes(), content)

    def test_concurrent_uploads_keep_one_physical_file(self):
        import threading
        content = b"concurrent-" * 50
        urls = []
        errors = []

        def worker(name):
            try:
                urls.append(main.store_uploaded_bytes(content, name, "input"))
            except Exception as exc:  # pragma: no cover - 出错时要能看见
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(f"t{i}.png",)) for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertFalse(errors, errors)
        files = self.input_files()
        inodes = {os.stat(str(p)).st_ino for p in files}
        self.assertEqual(len(inodes), 1, f"并发上传同一内容也只应一份物理文件，实际 {[p.name for p in files]}")

    def test_index_hit_but_file_missing_rewrites(self):
        content = b"gone-file"
        main.store_uploaded_bytes(content, "a.png", "input")
        os.remove(str(self.input_files()[0]))
        url = main.store_uploaded_bytes(content, "b.png", "input")
        target = self.inputs / os.path.basename(url)
        self.assertTrue(target.is_file())
        self.assertEqual(target.read_bytes(), content)
        index = json.loads(self.hash_file.read_text(encoding="utf-8"))
        entry = index[main.sha256_bytes(content)]
        self.assertEqual(os.path.abspath(entry["path"]), os.path.abspath(str(target)))

    def test_corrupt_index_self_heals(self):
        self.hash_file.write_text("{not json", encoding="utf-8")
        main.reset_asset_hash_cache()
        self.assertIsNone(main.asset_hash_lookup("deadbeef"))
        content = b"after-corruption"
        url = main.store_uploaded_bytes(content, "c.png", "input")
        self.assertTrue((self.inputs / os.path.basename(url)).is_file())
        index = json.loads(self.hash_file.read_text(encoding="utf-8"))
        self.assertIn(main.sha256_bytes(content), index)

    # ── 预览缓存清理 ──
    def test_prune_enforces_file_count_oldest_first(self):
        for i in range(6):
            self._make_preview(f"p{i}.webp", 10, mtime=1000 + i)
        result = main.prune_media_previews(max_files=3, max_bytes=0)
        self.assertEqual(result["remaining_files"], 3)
        self.assertEqual(result["removed"], 3)
        self.assertEqual(result["freed_bytes"], 30)
        self.assertEqual(sorted(p.name for p in self.previews.iterdir()), ["p3.webp", "p4.webp", "p5.webp"])

    def test_prune_enforces_byte_size(self):
        for i in range(4):
            self._make_preview(f"b{i}.webp", 100, mtime=1000 + i)
        result = main.prune_media_previews(max_files=0, max_bytes=250)
        self.assertEqual(result["remaining_bytes"], 200)
        self.assertEqual(result["removed"], 2)
        self.assertEqual(sorted(p.name for p in self.previews.iterdir()), ["b2.webp", "b3.webp"])

    def test_prune_zero_limits_is_noop(self):
        self._make_preview("keep.webp", 10)
        result = main.prune_media_previews(max_files=0, max_bytes=0)
        self.assertEqual(result["removed"], 0)
        self.assertTrue((self.previews / "keep.webp").exists())

    def test_prune_leaves_files_outside_cache_dir_untouched(self):
        outside = self.root / "outside.webp"
        outside.write_bytes(b"outside")
        for i in range(4):
            self._make_preview(f"p{i}.webp", 10, mtime=1000 + i)
        result = main.prune_media_previews(max_files=1, max_bytes=0)
        self.assertEqual(result["remaining_files"], 1)
        self.assertTrue(outside.exists())

    def test_prune_skips_symlinks_pointing_outside(self):
        target = self.root / "target.webp"
        target.write_bytes(b"target-content")
        link = self.previews / "link.webp"
        try:
            os.symlink(str(target), str(link))
        except (OSError, NotImplementedError):
            self.skipTest("平台不支持符号链接")
        self._make_preview("real.webp", 10, mtime=1)
        main.prune_media_previews(max_files=0, max_bytes=1)
        self.assertTrue(target.exists())
        self.assertEqual(target.read_bytes(), b"target-content")
        self.assertTrue(link.is_symlink())

    def test_is_within_dir_rejects_outside_and_traversal(self):
        inside = self.previews / "a.webp"
        inside.write_bytes(b"a")
        outside = self.root / "outside.webp"
        outside.write_bytes(b"o")
        self.assertTrue(main.is_within_dir(str(inside), str(self.previews)))
        self.assertFalse(main.is_within_dir(str(outside), str(self.previews)))
        self.assertFalse(main.is_within_dir(str(self.previews), str(self.previews)))
        self.assertFalse(main.is_within_dir(os.path.join(str(self.previews), "..", "escape.webp"), str(self.previews)))

    def test_prune_missing_dir_is_safe(self):
        shutil.rmtree(str(self.previews))
        result = main.prune_media_previews(max_files=1, max_bytes=1)
        self.assertEqual(result, {"removed": 0, "freed_bytes": 0, "remaining_files": 0, "remaining_bytes": 0})

    def test_preview_cache_limits_env_override(self):
        with patch.dict(os.environ, {"NOVAI_PREVIEW_CACHE_MAX_FILES": "12", "NOVAI_PREVIEW_CACHE_MAX_MB": "2"}):
            self.assertEqual(main.preview_cache_limits(), (12, 2 * 1024 * 1024))
        with patch.dict(os.environ, {"NOVAI_PREVIEW_CACHE_MAX_FILES": "0", "NOVAI_PREVIEW_CACHE_MAX_MB": "0"}):
            self.assertEqual(main.preview_cache_limits(), (0, 0))


if __name__ == "__main__":
    unittest.main()
