import asyncio
import io
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1]))
import main
from server import web_access, web_image_search


def _png(width, height):
    from PIL import Image
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (30, 120, 200)).save(buffer, "PNG")
    return buffer.getvalue()


class ThumbProxyHelperTests(unittest.TestCase):
    def setUp(self):
        web_image_search.clear_thumb_cache()
        self.addCleanup(web_image_search.clear_thumb_cache)

    def _patch_fetch(self, data, ext=".png", width=1600, height=1000):
        calls = []

        async def fake_fetch(client, url, referer="", max_bytes=web_image_search.MAX_DOWNLOAD_BYTES):
            calls.append({"url": url, "referer": referer, "max_bytes": max_bytes})
            return {"data": data, "ext": ext, "final_url": url, "content_type": "image/png",
                    "width": width, "height": height}

        return patch.object(web_image_search, "fetch_image", fake_fetch), calls

    def test_scales_to_requested_width_and_converts_to_jpeg(self):
        png = _png(1600, 1000)
        patcher, calls = self._patch_fetch(png, width=1600, height=1000)
        with patcher:
            thumb = asyncio.run(web_image_search.fetch_thumb_bytes("https://example.com/a.png", 400))
        self.assertEqual(thumb["content_type"], "image/jpeg")
        self.assertTrue(thumb["scaled"])
        self.assertLess(len(thumb["data"]), len(png))
        from PIL import Image
        with Image.open(io.BytesIO(thumb["data"])) as img:
            self.assertEqual(img.size, (400, 250))
        self.assertEqual((thumb["width"], thumb["height"]), (400, 250))
        self.assertEqual(calls[0]["referer"], "")          # 代理不带 Referer
        self.assertEqual(calls[0]["max_bytes"], web_image_search.THUMB_PROXY_MAX_BYTES)

    def test_cache_hit_avoids_second_download(self):
        png = _png(800, 600)
        patcher, calls = self._patch_fetch(png, width=800, height=600)
        with patcher:
            first = asyncio.run(web_image_search.fetch_thumb_bytes("https://example.com/b.png", 300))
            second = asyncio.run(web_image_search.fetch_thumb_bytes("https://example.com/b.png", 300))
        self.assertEqual(len(calls), 1)
        self.assertFalse(first["cache"])
        self.assertTrue(second["cache"])
        self.assertEqual(first["data"], second["data"])

    def test_small_image_returned_unchanged(self):
        png = _png(300, 200)
        patcher, _calls = self._patch_fetch(png, width=300, height=200)
        with patcher:
            thumb = asyncio.run(web_image_search.fetch_thumb_bytes("https://example.com/s.png", 480))
        self.assertEqual(thumb["content_type"], "image/png")
        self.assertFalse(thumb["scaled"])
        self.assertEqual(thumb["data"], png)
        self.assertEqual((thumb["width"], thumb["height"]), (300, 200))

    def test_unscalable_bytes_fall_back_to_original(self):
        broken = b"\x89PNG\r\n\x1a\nnot-a-real-png"
        patcher, _calls = self._patch_fetch(broken, width=None, height=None)
        with patcher:
            thumb = asyncio.run(web_image_search.fetch_thumb_bytes("https://example.com/x.png", 400))
        self.assertEqual(thumb["content_type"], "image/png")
        self.assertFalse(thumb["scaled"])
        self.assertEqual(thumb["data"], broken)

    def test_private_and_local_urls_are_rejected(self):
        for url in ("http://127.0.0.1:3000/a.png", "http://localhost/a.png", "file:///tmp/a.png"):
            with self.subTest(url=url):
                with self.assertRaises(web_access.WebAccessError):
                    asyncio.run(web_image_search.fetch_thumb_bytes(url, 480))

    def test_non_image_error_propagates(self):
        async def fake_fetch(client, url, referer="", max_bytes=1):
            raise web_image_search.WebImageSearchError("下载到的不是图片（Content-Type: text/html）")

        with patch.object(web_image_search, "fetch_image", fake_fetch):
            with self.assertRaises(web_image_search.WebImageSearchError):
                asyncio.run(web_image_search.fetch_thumb_bytes("https://example.com/a.html", 480))

    def test_width_is_clamped(self):
        self.assertEqual(web_image_search.clamp_thumb_width(50), web_image_search.THUMB_PROXY_MIN_WIDTH)
        self.assertEqual(web_image_search.clamp_thumb_width("5000"), web_image_search.THUMB_PROXY_MAX_WIDTH)
        self.assertEqual(web_image_search.clamp_thumb_width("abc"),
                         web_image_search.THUMB_PROXY_DEFAULT_WIDTH)

    def test_cache_evicts_old_entries(self):
        png = _png(10, 10)
        patcher, _calls = self._patch_fetch(png, width=10, height=10)
        with patcher:
            for index in range(5):
                asyncio.run(web_image_search.fetch_thumb_bytes(f"https://example.com/{index}.png", 300))
        self.assertLessEqual(len(web_image_search._thumb_cache), web_image_search._THUMB_CACHE_LIMIT)


class ThumbRouteTests(unittest.TestCase):
    def _thumb_result(self):
        return {"data": b"\xff\xd8\xfffakejpeg", "content_type": "image/jpeg",
                "width": 400, "height": 250, "scaled": True, "cache": False}

    def test_returns_image_with_cache_headers(self):
        fake = AsyncMock(return_value=self._thumb_result())
        with patch.object(main, "agent_web_enabled", return_value=True), \
             patch.object(web_image_search, "fetch_thumb_bytes", fake):
            response = asyncio.run(main.agent_images_thumb(url="https://example.com/a.jpg", w="400"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.media_type, "image/jpeg")
        self.assertIn("max-age=86400", response.headers["cache-control"])
        self.assertEqual(response.headers["x-novai-thumb-width"], "400")
        self.assertEqual(fake.await_args_list[0].args[1], "400")

    def test_disabled_returns_403_with_code(self):
        with patch.object(main, "agent_web_enabled", return_value=False):
            response = asyncio.run(main.agent_images_thumb(url="https://example.com/a.jpg", w="400"))
        self.assertEqual(response.status_code, 403)
        body = json.loads(response.body.decode("utf-8"))
        self.assertEqual(body["code"], "web_access_disabled")

    def test_missing_url_returns_400(self):
        with patch.object(main, "agent_web_enabled", return_value=True):
            response = asyncio.run(main.agent_images_thumb(url="", w="400"))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(json.loads(response.body.decode("utf-8"))["code"], "invalid_args")

    def test_private_url_returns_invalid_url(self):
        async def boom(target, width, verify=None, trust_env=None):
            raise web_access.WebAccessError("不允许访问本机、内网或保留地址")

        with patch.object(main, "agent_web_enabled", return_value=True), \
             patch.object(web_image_search, "fetch_thumb_bytes", boom):
            response = asyncio.run(main.agent_images_thumb(url="http://127.0.0.1/a.png", w="400"))
        self.assertEqual(response.status_code, 400)
        body = json.loads(response.body.decode("utf-8"))
        self.assertEqual(body["code"], "invalid_url")
        self.assertIn("内网", body["message"])

    def test_non_image_returns_not_image(self):
        async def boom(target, width, verify=None, trust_env=None):
            raise web_image_search.WebImageSearchError("下载到的不是图片（Content-Type: text/html）")

        with patch.object(main, "agent_web_enabled", return_value=True), \
             patch.object(web_image_search, "fetch_thumb_bytes", boom):
            response = asyncio.run(main.agent_images_thumb(url="https://example.com/a", w="400"))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(json.loads(response.body.decode("utf-8"))["code"], "not_image")

    def test_oversized_returns_413(self):
        async def boom(target, width, verify=None, trust_env=None):
            raise web_image_search.WebImageSearchError("原图超过 8MB 上限")

        with patch.object(main, "agent_web_enabled", return_value=True), \
             patch.object(web_image_search, "fetch_thumb_bytes", boom):
            response = asyncio.run(main.agent_images_thumb(url="https://example.com/a.jpg", w="400"))
        self.assertEqual(response.status_code, 413)
        self.assertEqual(json.loads(response.body.decode("utf-8"))["code"], "too_large")


if __name__ == "__main__":
    unittest.main()
