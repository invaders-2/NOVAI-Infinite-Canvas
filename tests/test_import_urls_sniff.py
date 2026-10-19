# -*- coding: utf-8 -*-
"""import-urls 类型兜底单测：Content-Type 缺失/octet-stream 时按魔数识别。

覆盖：
- 图片魔数（jpg/png/webp/gif/bmp/avif）+ application/octet-stream → 按图片落盘；
- 视频魔数（mp4/mov/webm）+ octet-stream → 按视频落盘；
- 识别不出 → 仍是原来的错误文案「不是图片或视频资源：...」；
- 原本正常路径（image/jpeg）行为不变。
跑法：venv/bin/python -m unittest tests.test_import_urls_sniff -v
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

import main  # noqa: E402  （import 时完成 deps 绑定）
from server.routes import assets as assets_routes  # noqa: E402
from server.routes.deps import deps  # noqa: E402

JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01" + b"\x00" * 200
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
WEBP_BYTES = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * 60
GIF_BYTES = b"GIF89a" + b"\x00" * 60
BMP_BYTES = b"BM" + b"\x00" * 60
AVIF_BYTES = b"\x00\x00\x00\x20ftypavif" + b"\x00" * 40 + b"avifmif1"
MP4_BYTES = b"\x00\x00\x00\x20ftypisom" + b"\x00" * 40
MOV_BYTES = b"\x00\x00\x00\x14ftypqt  " + b"\x00" * 40
WEBM_BYTES = b"\x1aE\xdf\xa3" + b"\x9f\x42\x86\x81\x01\x42\xf7\x81\x01" + b"webm" + b"\x00" * 20
HTML_BYTES = b"<!doctype html><html><body>not an image</body></html>"


class SniffMediaExtTests(unittest.TestCase):
    """_sniff_media_ext / _resolve_media_kind_ext 纯逻辑。"""

    def setUp(self):
        deps.bind(
            _local_upload_kind_ext=main._local_upload_kind_ext,
            _sniff_image_ext_bytes=main._sniff_image_ext_bytes,
        )

    def test_image_magic_with_octet_stream(self):
        cases = [
            (JPEG_BYTES, ".jpg"),
            (PNG_BYTES, ".png"),
            (WEBP_BYTES, ".webp"),
            (GIF_BYTES, ".gif"),
            (BMP_BYTES, ".bmp"),
            (AVIF_BYTES, ".avif"),
        ]
        for content, expected_ext in cases:
            kind, ext = assets_routes._resolve_media_kind_ext("", "application/octet-stream", content)
            self.assertEqual((kind, ext), ("image", expected_ext), expected_ext)

    def test_image_magic_with_empty_content_type(self):
        for content_type in ("", None):
            kind, ext = assets_routes._resolve_media_kind_ext("", content_type, JPEG_BYTES)
            self.assertEqual((kind, ext), ("image", ".jpg"), repr(content_type))

    def test_video_magic_with_octet_stream(self):
        cases = [
            (MP4_BYTES, ".mp4"),
            (MOV_BYTES, ".mov"),
            (WEBM_BYTES, ".webm"),
        ]
        for content, expected_ext in cases:
            kind, ext = assets_routes._resolve_media_kind_ext("", "application/octet-stream", content)
            self.assertEqual((kind, ext), ("video", expected_ext), expected_ext)

    def test_unknown_bytes_keeps_unknown(self):
        kind, _ext = assets_routes._resolve_media_kind_ext("/hbimg/abc123", "application/octet-stream", HTML_BYTES)
        self.assertIsNone(kind)
        kind2, _ = assets_routes._resolve_media_kind_ext("/hbimg/abc123", "application/octet-stream", b"")
        self.assertIsNone(kind2)

    def test_normal_content_type_behavior_unchanged(self):
        # image/png 声明 + png 魔数 + 文件名 .jpeg → 仍按真实魔数纠正成 .png
        kind, ext = assets_routes._resolve_media_kind_ext("a.jpeg", "image/png", PNG_BYTES)
        self.assertEqual((kind, ext), ("image", ".png"))
        # video/mp4 正常声明 → 不参与魔数兜底
        kind, ext = assets_routes._resolve_media_kind_ext("v.mp4", "video/mp4", b"garbage")
        self.assertEqual((kind, ext), ("video", ".mp4"))

    def test_svg_is_not_promoted(self):
        kind, _ = assets_routes._resolve_media_kind_ext("/a.svg", "application/octet-stream", b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")
        self.assertIsNone(kind)


class FakeResponse:
    def __init__(self, content, content_type):
        self.content = content
        self.headers = {"Content-Type": content_type}

    def raise_for_status(self):
        return None


class FakeAsyncClient:
    response = None

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def get(self, url):
        return type(self).response


class ImportUrlsEndpointTests(unittest.TestCase):
    """端点级：用假 httpx 客户端喂固定响应，不联网。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self._prev = {}
        override = {
            "_local_upload_safe_folder": lambda folder: ("", self.root),
            "_local_upload_kind_ext": main._local_upload_kind_ext,
            "_sniff_image_ext_bytes": main._sniff_image_ext_bytes,
            "_local_upload_item": self._fake_item,
            "classify_asset_image_best_effort": self._noop_async,
            "_write_local_upload_classification": lambda rel, data: None,
            "_write_local_upload_generation": lambda rel, data: None,
            "generation_meta_for_url": lambda url: None,
            "_SSL_CONTEXT": True,
            "_TRUST_ENV": False,
        }
        for key in override:
            self._prev[key] = deps.get(key)
        deps.bind(**override)

    def tearDown(self):
        deps.bind(**self._prev)
        self.tmp.cleanup()

    @staticmethod
    def _fake_item(rel):
        return {
            "id": rel,
            "file": rel,
            "name": os.path.basename(rel),
            "url": "/assets/uploads/" + rel,
            "kind": "image",
        }

    @staticmethod
    async def _noop_async(*args, **kwargs):
        return None

    def _run(self, items):
        payload = assets_routes.LocalAssetUrlImportRequest(
            items=[assets_routes.LocalAssetUrlImportItem(**item) for item in items]
        )
        with patch.object(assets_routes.httpx, "AsyncClient", FakeAsyncClient):
            return asyncio.run(assets_routes.import_local_assets_from_urls(payload))

    def test_octet_stream_jpeg_saved_ok(self):
        FakeAsyncClient.response = FakeResponse(JPEG_BYTES, "application/octet-stream")
        data = self._run([{"url": "https://gd-hbimg.huaban.com/dec07d9116eb33af0bd85570e66c0c4c1a4c0b6e127b7-Ev9plC"}])
        self.assertEqual(data["count"], 1)
        result = data["items"][0]
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["file"].endswith(".jpg"), result["file"])
        written = Path(self.root) / result["file"]
        self.assertTrue(written.is_file())
        self.assertEqual(written.read_bytes(), JPEG_BYTES)

    def test_octet_stream_mp4_saved_as_video(self):
        FakeAsyncClient.response = FakeResponse(MP4_BYTES, "application/octet-stream")
        data = self._run([{"url": "https://cdn.example.com/video/abc123"}])
        self.assertEqual(data["count"], 1)
        self.assertTrue(data["items"][0]["file"].endswith(".mp4"), data["items"][0])

    def test_octet_stream_unknown_keeps_original_error(self):
        FakeAsyncClient.response = FakeResponse(HTML_BYTES, "application/octet-stream")
        data = self._run([{"url": "https://cdn.example.com/page/abc123"}])
        self.assertEqual(data["count"], 0)
        result = data["items"][0]
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "不是图片或视频资源：application/octet-stream")

    def test_inline_base64_octet_stream_jpeg(self):
        encoded = base64.b64encode(JPEG_BYTES).decode("ascii")
        data = self._run([{
            "url": "",
            "data": "data:application/octet-stream;base64," + encoded,
            "content_type": "application/octet-stream",
        }])
        self.assertEqual(data["count"], 1, data)
        self.assertTrue(data["items"][0]["file"].endswith(".jpg"), data["items"][0])

    def test_normal_image_content_type_unchanged(self):
        FakeAsyncClient.response = FakeResponse(JPEG_BYTES, "image/jpeg")
        data = self._run([{"url": "https://cdn.example.com/a/b.jpeg"}])
        self.assertEqual(data["count"], 1)
        # 老行为：.jpeg 与 .jpg 视为同一种，不互相纠正（保持 .jpeg）
        self.assertTrue(data["items"][0]["file"].endswith(".jpeg"), data["items"][0])


if __name__ == "__main__":
    unittest.main()
