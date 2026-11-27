# -*- coding: utf-8 -*-
"""画布拖入大文件的单文件上限：按类型分档 + 413 文案可执行。

背景：画布端（novai-canvas-ui 的 MEDIA_UPLOAD_LIMIT）承诺 200MB，后端只有图片 200MB、
其它 50MB，于是 50~200MB 的视频必然 413，又被前端静默吞掉 —— 用户看到的是「拖进画布毫无反应」。
现在：图片 / 视频 / 音频 200MB，其它（文档等）50MB；超限 413 带文件名 / 实际大小 / 上限 / 怎么处理。

不造 200MB 大对象：上限判定抽成纯函数，端点测试把常量 patch 小。
跑法：NOVAI_DATA_DIR=/tmp/novai-test-upload-limits python3 -m unittest tests.test_upload_media_limits -v
"""
import asyncio
import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

MB = 1024 * 1024


class FakeUpload:
    """只实现路由用到的三个属性，避免为一个路由拉起整条 multipart 链路。"""

    def __init__(self, content, filename, content_type):
        self._content = content
        self.filename = filename
        self.content_type = content_type

    async def read(self):
        return self._content


class LimitByKindTests(unittest.TestCase):
    """upload_limit_for_kind / upload_over_limit_detail 的纯逻辑。"""

    def test_limits_by_kind(self):
        self.assertEqual(main.upload_limit_for_kind("image"), 200 * MB)
        self.assertEqual(main.upload_limit_for_kind("video"), 200 * MB)
        self.assertEqual(main.upload_limit_for_kind("audio"), 200 * MB)
        self.assertEqual(main.upload_limit_for_kind("file"), 50 * MB)
        self.assertEqual(main.upload_limit_for_kind(""), 50 * MB, "未知类型按文档档处理")

    def test_limits_follow_patched_constants(self):
        with patch.object(main, "UPLOAD_MEDIA_MAX_BYTES", 7 * MB):
            self.assertEqual(main.upload_limit_for_kind("video"), 7 * MB)
            self.assertEqual(main.upload_limit_for_kind("image"), 200 * MB)
        with patch.object(main, "UPLOAD_IMAGE_HARD_MAX_BYTES", 9 * MB):
            self.assertEqual(main.upload_limit_for_kind("image"), 9 * MB)

    def test_video_detail_has_name_size_limit_and_advice(self):
        detail = main.upload_over_limit_detail("clip.mp4", 225 * MB, "video")
        self.assertIn("clip.mp4", detail)
        self.assertIn("225.0MB", detail)
        self.assertIn("200.0MB", detail)
        self.assertIn("超过视频单文件", detail)
        self.assertIn("压缩", detail)
        self.assertIn("裁短", detail)
        self.assertIn("转码", detail)

    def test_audio_image_file_details(self):
        audio = main.upload_over_limit_detail("song.wav", 3 * MB, "audio")
        self.assertIn("song.wav", audio)
        self.assertIn("超过音频单文件", audio)
        self.assertIn("转成 mp3", audio)
        image = main.upload_over_limit_detail("big.png", 260 * MB, "image")
        self.assertIn("超过图片单文件", image)
        self.assertIn("长边不超过 6144 像素", image)
        doc = main.upload_over_limit_detail("a.zip", 60 * MB, "file")
        self.assertIn("超过文件单文件", doc)
        self.assertIn("50.0MB", doc)


class UploadEndpointLimitTests(unittest.TestCase):
    """/api/ai/upload 按 kind 分档；/api/ai/upload-base64 仍是 50MB 但文案可执行。"""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.assets = root / "assets"
        self.inputs = self.assets / "input"
        self.outputs = self.assets / "output"
        self.data = root / "data"
        for path in (self.inputs, self.outputs, self.data):
            path.mkdir(parents=True, exist_ok=True)
        self.patches = [
            patch.object(main, "ASSETS_DIR", str(self.assets)),
            patch.object(main, "OUTPUT_INPUT_DIR", str(self.inputs)),
            patch.object(main, "OUTPUT_OUTPUT_DIR", str(self.outputs)),
            patch.object(main, "DATA_DIR", str(self.data)),
            patch.object(main, "ASSET_HASH_FILE", str(self.data / "asset_hashes.json")),
        ]
        for item in self.patches:
            item.start()
        main.reset_asset_hash_cache()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        main.reset_asset_hash_cache()
        self.temp.cleanup()

    def upload(self, files):
        return asyncio.run(main.upload_ai_reference(files=files))

    def assert413(self, files, *needles):
        with self.assertRaises(main.HTTPException) as caught:
            self.upload(files)
        self.assertEqual(caught.exception.status_code, 413)
        detail = str(caught.exception.detail)
        for needle in needles:
            self.assertIn(needle, detail)
        return detail

    def test_video_200mb_matches_ui_promise(self):
        # 3.5MB 的「视频」在 3MB 上限下必须 413；文案带文件名 / 实际大小 / 上限 / 改法
        with patch.object(main, "UPLOAD_MEDIA_MAX_BYTES", 3 * MB):
            detail = self.assert413(
                [FakeUpload(b"\x00" * (4 * MB), "clip.mp4", "video/mp4")],
                "clip.mp4", "4.0MB", "3.0MB", "超过视频单文件", "裁短",
            )
        self.assertIn("压缩", detail)

    def test_video_under_the_raised_limit_is_stored(self):
        # 同一份 4MB 视频，默认的 200MB 档下必须落盘并返回 /assets 地址（旧代码这里是 50MB 硬顶）
        with patch.object(main, "UPLOAD_MEDIA_MAX_BYTES", 200 * MB):
            result = self.upload([FakeUpload(b"\x00" * (4 * MB), "clip.mp4", "video/mp4")])
        row = result["files"][0]
        self.assertEqual(row["kind"], "video")
        self.assertTrue(row["url"].startswith("/assets/input/"), row["url"])
        self.assertTrue(row["url"].endswith(".mp4"), row["url"])
        self.assertTrue((self.inputs / os.path.basename(row["url"])).is_file())

    def test_audio_over_limit_413(self):
        with patch.object(main, "UPLOAD_MEDIA_MAX_BYTES", 2 * MB):
            self.assert413([FakeUpload(b"\x00" * (3 * MB), "song.m4a", "audio/mp4")],
                           "song.m4a", "3.0MB", "2.0MB", "超过音频单文件")

    def test_document_stays_50mb(self):
        with patch.object(main, "UPLOAD_OTHER_MAX_BYTES", 2 * MB):
            self.assert413([FakeUpload(b"\x00" * (3 * MB), "data.zip", "application/zip")],
                           "data.zip", "超过文件单文件", "2.0MB")

    def test_image_hard_limit_413(self):
        with patch.object(main, "UPLOAD_IMAGE_HARD_MAX_BYTES", 3 * MB):
            self.assert413([FakeUpload(b"\x00" * (4 * MB), "shot.png", "image/png")],
                           "shot.png", "4.0MB", "超过图片单文件", "长边不超过 6144 像素")

    def test_image_over_compress_target_is_compressed_not_413(self):
        # 50MB 压缩路径的接线还在：把压缩目标 patch 成 1MB，2.3MB 噪声 PNG 要压成 jpg 落盘
        import io

        import numpy as np
        from PIL import Image

        rng = np.random.default_rng(3)
        buf = io.BytesIO()
        Image.fromarray(rng.integers(0, 256, size=(900, 900, 3), dtype=np.uint8), "RGB").save(buf, format="PNG")
        source = buf.getvalue()
        self.assertGreater(len(source), 200 * 1024)
        with patch.object(main, "UPLOAD_IMAGE_COMPRESS_TARGET_BYTES", 1 * MB):
            result = self.upload([FakeUpload(source, "noise.png", "image/png")])
        row = result["files"][0]
        self.assertEqual(row["kind"], "image")
        self.assertTrue(row["url"].endswith(".jpg"), row["url"])
        stored = self.inputs / os.path.basename(row["url"])
        self.assertLess(stored.stat().st_size, len(source), "压缩路径生效：落盘体积小于原图")
        self.assertLessEqual(stored.stat().st_size, 1 * MB)

    def test_base64_still_50mb_with_actionable_detail(self):
        with patch.object(main, "UPLOAD_BASE64_MAX_BYTES", 1024):
            payload = main.Base64UploadRequest(
                data=base64.b64encode(b"\x00" * (512 * 1024)).decode("ascii"),
                name="big.mp4", content_type="video/mp4",
            )
            with self.assertRaises(main.HTTPException) as caught:
                asyncio.run(main.upload_ai_base64(payload))
        self.assertEqual(caught.exception.status_code, 413)
        detail = str(caught.exception.detail)
        self.assertIn("big.mp4", detail)
        self.assertIn("0.5MB", detail)
        self.assertIn("/api/ai/upload", detail, "告诉调用方改走 multipart")
        self.assertIn("1/3", detail, "说清为什么 base64 上限更低")


if __name__ == "__main__":
    unittest.main()
