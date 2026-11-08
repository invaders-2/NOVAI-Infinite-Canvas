#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""图片输出格式（output_format）后端链路：归一、能力校验、落盘扩展名、SVG URL 识别。

跑法：
    venv/bin/python -m unittest tests.test_image_output_format -v

覆盖：
  1. normalize_image_output_format：空/static/静态图 -> 空，jpg -> jpeg，未登记的值 -> 空；
  2. image_output_format_fields：空不发字段、能力表支持才发、没声明或不在其中 -> 400 并列出可选项；
  3. image_output_extension：MIME 优先，缺失/octet-stream 按 URL 扩展名兜底，都不认识回退 .png；
  4. looks_like_generated_image_url 识别 .svg（含 query 串与大小写）；
  5. apimart_output_format_fields：SVG 强制 n=1、带参考图/蒙版 400，其它格式不带 n；
  6. image_output_extension_from_bytes：按魔数识别 SVG（含 <?xml 声明）/ GIF，其它返回空。
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

os.environ.setdefault("NOVAI_DATA_DIR", tempfile.mkdtemp(prefix="novai-image-format-test-"))
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)

import main  # noqa: E402
from fastapi import HTTPException  # noqa: E402


class NormalizeImageOutputFormatTests(unittest.TestCase):

    def test_static_values_become_empty(self):
        for value in ("", None, "   ", "static", "STATIC", "静态图"):
            self.assertEqual(main.normalize_image_output_format(value), "", value)

    def test_supported_values_are_lowercased(self):
        for value in ("png", "jpeg", "webp", "gif", "svg"):
            self.assertEqual(main.normalize_image_output_format(value.upper()), value)

    def test_jpg_alias_maps_to_jpeg(self):
        self.assertEqual(main.normalize_image_output_format("jpg"), "jpeg")
        self.assertEqual(main.normalize_image_output_format(" JPG "), "jpeg")

    def test_unknown_values_become_empty(self):
        for value in ("bmp", "tiff", "avif", "pngx", "视频"):
            self.assertEqual(main.normalize_image_output_format(value), "", value)


class ImageOutputFormatFieldsTests(unittest.TestCase):

    CAPS = {"output_formats": ("png", "jpeg", "webp", "svg", "gif")}

    def test_empty_format_sends_nothing(self):
        self.assertEqual(main.image_output_format_fields("gpt-image-2.6-sunburst", self.CAPS, ""), {})
        self.assertEqual(main.image_output_format_fields("gpt-image-2.6-sunburst", self.CAPS, "static"), {})
        self.assertEqual(main.image_output_format_fields("gpt-image-2.6-sunburst", self.CAPS, "静态图"), {})

    def test_supported_format_passes_through(self):
        self.assertEqual(main.image_output_format_fields("gpt-image-2.6-sunburst", self.CAPS, "SVG"),
                         {"output_format": "svg"})
        self.assertEqual(main.image_output_format_fields("gpt-image-2.6-sunburst", self.CAPS, "gif"),
                         {"output_format": "gif"})
        self.assertEqual(main.image_output_format_fields("muse-image-ext", {"output_formats": ("webp",)}, "webp"),
                         {"output_format": "webp"})

    def test_unsupported_format_raises_400_with_options(self):
        with self.assertRaises(HTTPException) as caught:
            main.image_output_format_fields("muse-image-ext", {"output_formats": ("webp",)}, "svg")
        self.assertEqual(caught.exception.status_code, 400)
        detail = str(caught.exception.detail)
        self.assertIn("不支持", detail)
        self.assertIn("svg", detail)
        self.assertIn("webp", detail)

    def test_model_without_output_formats_raises_400(self):
        for caps in (None, {}, {"ratios": ("1:1",)}):
            with self.assertRaises(HTTPException) as caught:
                main.image_output_format_fields("cogview-4", caps, "png")
            self.assertEqual(caught.exception.status_code, 400)
            self.assertIn("不支持", str(caught.exception.detail))


class ApimartOutputFormatFieldsTests(unittest.TestCase):

    CAPS = {"output_formats": ("png", "jpeg", "webp", "svg", "gif")}

    def test_svg_forces_single_image(self):
        self.assertEqual(
            main.apimart_output_format_fields("gpt-image-2.6-sunburst", self.CAPS, "svg", n=4),
            {"output_format": "svg", "n": 1})

    def test_svg_with_references_raises_400(self):
        with self.assertRaises(HTTPException) as caught:
            main.apimart_output_format_fields(
                "gpt-image-2.6-sunburst", self.CAPS, "svg", n=1, has_refs=True)
        self.assertEqual(caught.exception.status_code, 400)
        detail = str(caught.exception.detail)
        self.assertIn("SVG", detail)
        self.assertIn("参考图", detail)

    def test_other_formats_do_not_send_n(self):
        self.assertEqual(
            main.apimart_output_format_fields("gpt-image-2.6-sunburst", self.CAPS, "gif", n=4),
            {"output_format": "gif"})
        self.assertEqual(
            main.apimart_output_format_fields("gpt-image-2.6-sunburst", self.CAPS, "", n=4), {})
        self.assertEqual(
            main.apimart_output_format_fields("gpt-image-2.6-sunburst", self.CAPS, "static", n=4), {})


class ImageOutputExtensionTests(unittest.TestCase):

    def test_mime_type_wins(self):
        self.assertEqual(main.image_output_extension("image/svg+xml"), ".svg")
        self.assertEqual(main.image_output_extension("image/gif"), ".gif")
        self.assertEqual(main.image_output_extension("image/jpeg"), ".jpg")
        self.assertEqual(main.image_output_extension("image/webp"), ".webp")
        self.assertEqual(main.image_output_extension("image/png"), ".png")

    def test_url_fallback_when_content_type_missing_or_octet_stream(self):
        self.assertEqual(main.image_output_extension("", "https://cdn.example.com/a/b.svg?token=1"), ".svg")
        self.assertEqual(main.image_output_extension("application/octet-stream", "https://cdn.example.com/a.gif"), ".gif")
        self.assertEqual(main.image_output_extension("application/octet-stream", "/output/a.JPEG"), ".jpg")
        self.assertEqual(main.image_output_extension("", "https://cdn.example.com/a.webp#frag"), ".webp")

    def test_unknown_falls_back_to_png(self):
        self.assertEqual(main.image_output_extension(), ".png")
        self.assertEqual(main.image_output_extension("", ""), ".png")
        self.assertEqual(main.image_output_extension("application/octet-stream", "https://cdn.example.com/a.bin"), ".png")
        self.assertEqual(main.image_output_extension("text/html", "https://cdn.example.com/a.html"), ".png")


class ImageOutputExtensionFromBytesTests(unittest.TestCase):

    def test_svg_magic(self):
        self.assertEqual(main.image_output_extension_from_bytes(b'<svg xmlns="http://www.w3.org/2000/svg"></svg>'), ".svg")
        self.assertEqual(main.image_output_extension_from_bytes(b"\xef\xbb\xbf  <svg></svg>"), ".svg")
        self.assertEqual(main.image_output_extension_from_bytes(
            b'<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), ".svg")

    def test_gif_magic(self):
        self.assertEqual(main.image_output_extension_from_bytes(b"GIF87a\x01\x00"), ".gif")
        self.assertEqual(main.image_output_extension_from_bytes(b"GIF89a\x01\x00"), ".gif")

    def test_other_bytes_return_empty(self):
        self.assertEqual(main.image_output_extension_from_bytes(b"\x89PNG\r\n\x1a\n"), "")
        self.assertEqual(main.image_output_extension_from_bytes(b"RIFF....WEBP"), "")
        self.assertEqual(main.image_output_extension_from_bytes(b"<?xml version='1.0'?><root/>"), "")
        self.assertEqual(main.image_output_extension_from_bytes(b""), "")
        self.assertEqual(main.image_output_extension_from_bytes(None), "")


class GeneratedImageUrlSvgTests(unittest.TestCase):

    def test_svg_urls_are_recognized(self):
        self.assertTrue(main.looks_like_generated_image_url("https://cdn.example.com/a.svg"))
        self.assertTrue(main.looks_like_generated_image_url("/output/a.svg?token=1"))
        self.assertTrue(main.looks_like_generated_image_url("/assets/a.SVG"))
        self.assertTrue(main.looks_like_generated_image_url("data:image/svg+xml;base64,PHN2Zy8+"))

    def test_gif_and_raster_formats_still_recognized(self):
        self.assertTrue(main.looks_like_generated_image_url("https://cdn.example.com/a.gif"))
        self.assertTrue(main.looks_like_generated_image_url("https://cdn.example.com/a.jpeg"))
        self.assertTrue(main.looks_like_generated_image_url("/output/a.webp"))

    def test_non_image_urls_are_rejected(self):
        self.assertFalse(main.looks_like_generated_image_url("https://cdn.example.com/a.svgz"))
        self.assertFalse(main.looks_like_generated_image_url("https://cdn.example.com/a.json"))
        self.assertFalse(main.looks_like_generated_image_url(""))


if __name__ == "__main__":
    unittest.main()
