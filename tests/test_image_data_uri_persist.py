"""上游返回 data URI 时必须解码落盘，而不是把几百 KB 的 data URI 原样写进任务结果。

真实故障（/tmp/novai-relay-e2e-evidence/REPORT.md 缺陷 3）：中转站返回
{"url": "data:image/jpeg;base64,..."} 时，save_ai_image_to_output 把它当普通 URL 走
httpx.get(data:...)，失败后原样返回 -> /assets/output/ 无文件、result.images 是 data URI。
"""
import asyncio
import base64
import io
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def png_bytes(width=96, height=64):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (210, 40, 40)).save(buf, "PNG")
    return buf.getvalue()


def jpeg_bytes(width=80, height=48):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (40, 120, 210)).save(buf, "JPEG")
    return buf.getvalue()


def png_size(raw):
    # PNG: 8-byte signature + 4-byte length + "IHDR" + width + height
    return struct.unpack(">II", raw[16:24])


class DataUriPersistTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name in ("OUTPUT_OUTPUT_DIR", "ASSETS_DIR"):
            patcher = patch.object(main, name, self.tmp.name)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_png_data_uri_is_decoded_and_saved(self):
        raw = png_bytes(96, 64)
        data_uri = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
        url = asyncio.run(main.save_ai_image_to_output({"type": "url", "value": data_uri}))
        self.assertTrue(url.startswith("/assets/output/"), url)
        self.assertNotIn("base64", url)
        path = os.path.join(self.tmp.name, os.path.basename(url))
        self.assertTrue(os.path.isfile(path), path)
        with open(path, "rb") as f:
            saved = f.read()
        self.assertEqual(saved, raw)
        self.assertEqual(png_size(saved), (96, 64))

    def test_jpeg_data_uri_keeps_jpeg_extension(self):
        raw = jpeg_bytes(80, 48)
        data_uri = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
        url = asyncio.run(main.save_ai_image_to_output({"type": "url", "value": data_uri}))
        self.assertTrue(url.endswith(".jpg"), url)
        path = os.path.join(self.tmp.name, os.path.basename(url))
        from PIL import Image
        with Image.open(path) as img:
            self.assertEqual(img.size, (80, 48))

    def test_b64_item_still_saves(self):
        raw = png_bytes(32, 32)
        url = asyncio.run(main.save_ai_image_to_output(
            {"type": "b64", "value": base64.b64encode(raw).decode("ascii"), "mime_type": "image/png"}))
        self.assertTrue(url.startswith("/assets/output/"), url)
        self.assertTrue(os.path.isfile(os.path.join(self.tmp.name, os.path.basename(url))))

    def test_local_url_is_returned_unchanged(self):
        for value in ("/assets/output/keep.png", "/output/keep.png"):
            self.assertEqual(asyncio.run(main.save_ai_image_to_output({"type": "url", "value": value})), value)


if __name__ == "__main__":
    unittest.main()
