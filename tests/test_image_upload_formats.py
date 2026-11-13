# -*- coding: utf-8 -*-
"""图片上传格式：已知扩展名原样保留、缺失时按 content_type 推、推不出就 415。

背景：_local_upload_kind_ext 以前对任何 image/* 都兜成 .png，字节又不转码 —— SVG/BMP/AVIF/TIFF
都会被存成「叫 .png 的坏文件」。这里锁住新口径：
- 已知图片扩展名（含 svg/bmp/avif/tiff/heic）原样保留；
- 扩展名缺失/不认识时按 content_type 用 mimetypes 推（image/x-ms-bmp 这类非标准写法也能推）；
- 仍推不出返回 None，/api/ai/upload-base64 与 /api/ai/upload 都明确 415，不再塞成 .png。

跑法：NOVAI_DATA_DIR=/tmp/novai-test-imgfmt python -m unittest tests.test_image_upload_formats -v
"""
import asyncio
import base64
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

SVG_BYTES = b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'
BMP_BYTES = b"BM" + b"\x00" * 60
AVIF_BYTES = b"\x00\x00\x00\x20ftypavif" + b"\x00" * 40 + b"avifmif1"
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


class FakeUpload:
    """只实现路由用到的三个属性，避免为一个路由拉起整条 multipart 链路。"""

    def __init__(self, content, filename, content_type):
        self._content = content
        self.filename = filename
        self.content_type = content_type

    async def read(self):
        return self._content


class KindExtTests(unittest.TestCase):
    """_local_upload_kind_ext 的纯逻辑。"""

    def test_known_image_exts_are_kept(self):
        for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp", ".avif", ".tiff", ".tif", ".heic", ".heif"):
            kind, got = main._local_upload_kind_ext("a" + ext, "image/whatever")
            self.assertEqual((kind, got), ("image", ext), ext)

    def test_missing_ext_guessed_from_content_type(self):
        cases = [
            ("", "image/png", ".png"),
            ("noext", "image/jpeg", ".jpg"),
            ("noext", "image/svg+xml", ".svg"),
            ("noext", "image/x-ms-bmp", ".bmp"),
            ("noext", "image/bmp", ".bmp"),
            ("noext", "image/avif", ".avif"),
            ("noext", "image/tiff", ".tiff"),
            ("noext", "image/heic", ".heic"),
            ("noext", "image/png; charset=binary", ".png"),
        ]
        for filename, content_type, expected in cases:
            kind, got = main._local_upload_kind_ext(filename, content_type)
            self.assertEqual((kind, got), ("image", expected), content_type)

    def test_unknown_image_type_returns_none(self):
        kind, ext = main._local_upload_kind_ext("a.cur", "image/x-cursor")
        self.assertIsNone(kind)
        self.assertEqual(ext, ".cur")
        kind, ext = main._local_upload_kind_ext("a.psd", "image/vnd.adobe.photoshop")
        self.assertIsNone(kind)
        self.assertEqual(ext, ".psd")

    def test_non_image_behavior_unchanged(self):
        self.assertEqual(main._local_upload_kind_ext("a.mp4", "video/mp4"), ("video", ".mp4"))
        self.assertEqual(main._local_upload_kind_ext("a.mp3", "audio/mpeg"), ("audio", ".mp3"))
        self.assertEqual(main._local_upload_kind_ext("a.txt", "text/plain"), (None, ".txt"))


class UploadEndpointTests(unittest.TestCase):
    """/api/ai/upload-base64 与 /api/ai/upload：落盘扩展名 / 415。"""

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

    def base64_upload(self, content, name, content_type):
        payload = main.Base64UploadRequest(
            data=base64.b64encode(content).decode("ascii"),
            name=name,
            content_type=content_type,
        )
        return asyncio.run(main.upload_ai_base64(payload))

    def test_base64_keeps_svg_bmp_avif_ext(self):
        for content, name, content_type, expected in (
            (SVG_BYTES, "logo.svg", "image/svg+xml", ".svg"),
            (BMP_BYTES, "shot.bmp", "image/bmp", ".bmp"),
            (AVIF_BYTES, "shot.avif", "image/avif", ".avif"),
        ):
            result = self.base64_upload(content, name, content_type)
            url = result["files"][0]["url"]
            self.assertTrue(url.startswith("/assets/input/"), url)
            self.assertTrue(url.endswith(expected), url)
            self.assertEqual(result["files"][0]["kind"], "image")
            stored = self.inputs / os.path.basename(url)
            self.assertEqual(stored.read_bytes(), content, "字节原样落盘，没有转成 .png")
        self.assertEqual(len([p for p in self.inputs.iterdir() if p.suffix == ".png"]), 0)

    def test_base64_guesses_ext_from_mime(self):
        result = self.base64_upload(SVG_BYTES, "无扩展名", "image/svg+xml")
        self.assertTrue(result["files"][0]["url"].endswith(".svg"), result["files"][0]["url"])

    def test_base64_rejects_unknown_image_type(self):
        with self.assertRaises(main.HTTPException) as ctx:
            self.base64_upload(b"xx", "a.cur", "image/x-cursor")
        self.assertEqual(ctx.exception.status_code, 415)
        self.assertIn("暂不支持", str(ctx.exception.detail))
        self.assertEqual(list(self.inputs.iterdir()), [], "拒绝时什么都不落盘")

    def test_ai_upload_keeps_ext_and_rejects_unknown(self):
        result = asyncio.run(main.upload_ai_reference(files=[FakeUpload(SVG_BYTES, "logo.svg", "image/svg+xml")]))
        self.assertTrue(result["files"][0]["url"].endswith(".svg"), result["files"][0]["url"])
        self.assertEqual(result["files"][0]["kind"], "image")

        with self.assertRaises(main.HTTPException) as ctx:
            asyncio.run(main.upload_ai_reference(files=[FakeUpload(b"xx", "a.cur", "image/x-cursor")]))
        self.assertEqual(ctx.exception.status_code, 415)
        self.assertIn("暂不支持", str(ctx.exception.detail))


if __name__ == "__main__":
    unittest.main()
