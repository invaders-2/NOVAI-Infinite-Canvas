import asyncio
import json
import os
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-web-image-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main
from server import web_image_search


def _image_bytes(width, height, fmt="PNG"):
    from PIL import Image
    buffer = BytesIO()
    Image.new("RGB", (width, height), (180, 40, 40)).save(buffer, format=fmt)
    return buffer.getvalue()


class ImageItemTests(unittest.TestCase):
    def test_item_requires_http_original_url(self):
        self.assertIsNone(web_image_search._make_item(""))
        self.assertIsNone(web_image_search._make_item("/assets/uploads/a.jpg"))
        self.assertIsNone(web_image_search._make_item("data:image/png;base64,AAAA"))

    def test_item_fields_and_site(self):
        item = web_image_search._make_item(
            "https://img.example.com/a.jpg", "https://img.example.com/a_thumb.jpg", "  标题 <b>一</b> ",
            "2048", "1280", "https://www.page.com/post/1", "")
        self.assertEqual(item["original_url"], "https://img.example.com/a.jpg")
        self.assertEqual(item["thumb_url"], "https://img.example.com/a_thumb.jpg")
        self.assertEqual(item["title"], "标题 <b>一</b>".strip())
        self.assertEqual((item["width"], item["height"]), (2048, 1280))
        self.assertEqual(item["source_page"], "https://www.page.com/post/1")
        self.assertEqual(item["source_site"], "page.com")
        self.assertEqual(item["id"], web_image_search._image_id("https://img.example.com/a.jpg"))

    def test_missing_size_stays_null(self):
        item = web_image_search._make_item("https://example.com/a.jpg", "", "图", None, None)
        self.assertIsNone(item["width"])
        self.assertIsNone(item["height"])

    def test_merge_dedupes_by_original_url_and_prefers_more_info(self):
        bing = [web_image_search._make_item("https://a.com/1.jpg", "https://a.com/t1.jpg", "甲"),
                web_image_search._make_item("https://a.com/2.jpg", "", "乙")]
        so360 = [web_image_search._make_item("https://a.com/1.jpg", "", "甲", 1200, 800, "https://page.com/1"),
                 web_image_search._make_item("https://a.com/3.jpg", "", "丙", 900, 600)]
        merged = web_image_search._merge_items([bing, so360], 24)
        # 轮转交替取：bing 的 1、360 的 3（与 bing 的 1 重复时跳过）、bing 的 2
        self.assertEqual([item["original_url"] for item in merged],
                         ["https://a.com/1.jpg", "https://a.com/2.jpg", "https://a.com/3.jpg"])
        self.assertEqual(merged[0]["width"], 1200)
        self.assertEqual(merged[0]["thumb_url"], "https://a.com/t1.jpg")

    def test_orientation_filter_uses_real_size_only(self):
        landscape = web_image_search._make_item("https://a.com/1.jpg", "", "", 1600, 900)
        portrait = web_image_search._make_item("https://a.com/2.jpg", "", "", 900, 1600)
        unknown = web_image_search._make_item("https://a.com/3.jpg", "", "", None, None)
        self.assertTrue(web_image_search._orientation_matches(landscape, "landscape"))
        self.assertFalse(web_image_search._orientation_matches(portrait, "landscape"))
        self.assertTrue(web_image_search._orientation_matches(unknown, "landscape"))

    def test_sniff_image_ext_by_magic_bytes(self):
        self.assertEqual(web_image_search.sniff_image_ext(_image_bytes(8, 8, "PNG")), ".png")
        self.assertEqual(web_image_search.sniff_image_ext(_image_bytes(8, 8, "JPEG")), ".jpg")
        self.assertEqual(web_image_search.sniff_image_ext(b"GIF89a" + b"\x00" * 20), ".gif")
        self.assertEqual(web_image_search.sniff_image_ext(b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 8), ".webp")
        self.assertEqual(web_image_search.sniff_image_ext(b"\x00\x00\x00\x18ftypavif" + b"\x00" * 8), ".avif")
        self.assertEqual(web_image_search.sniff_image_ext(b"BM" + b"\x00" * 20), ".bmp")
        self.assertEqual(web_image_search.sniff_image_ext(b"<html>not an image</html>"), "")

    def test_image_size_reads_real_dimensions(self):
        self.assertEqual(web_image_search.image_size(_image_bytes(640, 480)), (640, 480))
        self.assertEqual(web_image_search.image_size(b"not an image"), (None, None))


class SearchTests(unittest.TestCase):
    def _patch_adapters(self, mapping):
        return patch.object(web_image_search, "_source_adapters", lambda: dict(mapping))

    def _client_ctx(self):
        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        return patch.object(web_image_search.httpx, "AsyncClient", lambda **kwargs: FakeClient())

    def _item(self, kind, url, title="图", width=None, height=None):
        return web_image_search._make_item(url, "", title, width, height,
                                           f"https://{kind}.example/page", f"{kind}.example",
                                           source_kind=kind)

    def test_merges_sources_dedupes_and_counts(self):
        bing_item = self._item("bing", "https://a.com/1.jpg", "甲")
        so_dup = self._item("360", "https://a.com/1.jpg", "甲", 1200, 800)
        hub = self._item("huaban", "https://gd-hbimg.huabanimg.com/k1", "丙", 800, 1200)

        async def fake_bing(client, query, count, orientation):
            return [bing_item]

        async def fake_360(client, query, count, orientation):
            return [so_dup]

        async def fake_huaban(client, query, count, orientation):
            return [hub]

        with self._client_ctx(), self._patch_adapters(
                {"bing": fake_bing, "360": fake_360, "huaban": fake_huaban}):
            result = asyncio.run(web_image_search.search_images(
                "客厅", 6, sources=["bing", "360", "huaban"]))
        self.assertEqual(result["engine"], "multi")
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(result["items"][0]["original_url"], "https://a.com/1.jpg")
        self.assertEqual(result["items"][0]["width"], 1200)      # 去重时补齐了 360 的宽高
        self.assertEqual(result["sources"], {"bing": 1, "huaban": 1})
        self.assertIsNone(result.get("note"))
        self.assertTrue(all(item["source_kind"] for item in result["items"]))

    def test_default_sources_are_the_four_stable_sites(self):
        calls = []

        def make(name):
            async def adapter(client, query, count, orientation):
                calls.append(name)
                return [self._item(name, f"https://{name}.example/{name}.jpg")]
            return adapter

        mapping = {name: make(name) for name in web_image_search.DEFAULT_SOURCES}
        with self._client_ctx(), self._patch_adapters(mapping):
            result = asyncio.run(web_image_search.search_images("客厅", 8))
        self.assertEqual(sorted(calls), sorted(web_image_search.DEFAULT_SOURCES))
        self.assertEqual(result["sources"], {name: 1 for name in web_image_search.DEFAULT_SOURCES})

    def test_partial_failure_notes_single_site_reason(self):
        async def ok_huaban(client, query, count, orientation):
            return [self._item("huaban", "https://gd-hbimg.huabanimg.com/k1")]

        async def failing_360(client, query, count, orientation):
            raise web_image_search.WebImageSearchError(
                "360 图片检索失败（已重试 1 次）：返回的不是 JSON（HTTP 200，3354 字节）")

        async def empty_bing(client, query, count, orientation):
            return []

        with self._client_ctx(), self._patch_adapters(
                {"huaban": ok_huaban, "360": failing_360, "bing": empty_bing}):
            result = asyncio.run(web_image_search.search_images(
                "客厅", 6, sources=["huaban", "360", "bing"]))
        self.assertEqual(len(result["items"]), 1)
        self.assertIn("360 图片检索失败", result["note"])
        self.assertIn("已重试 1 次", result["note"])
        self.assertIn("必应图片：没有搜到原图", result["note"])

    def test_unsupported_sources_go_to_note_and_do_not_break_search(self):
        async def ok_huaban(client, query, count, orientation):
            return [self._item("huaban", "https://gd-hbimg.huabanimg.com/k1")]

        with self._client_ctx(), self._patch_adapters({"huaban": ok_huaban}):
            result = asyncio.run(web_image_search.search_images(
                "客厅", 4, sources=["huaban", "xiaohongshu", "pinterest", "baidu"]))
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["sources"], {"huaban": 1})
        note = result["note"]
        self.assertIn("小红书", note)
        self.assertIn("签名", note)
        self.assertIn("Pinterest", note)
        self.assertIn("百度图片", note)
        self.assertIn("Forbid spider access", note)

    def test_unknown_source_is_rejected(self):
        with self.assertRaises(web_image_search.WebImageSearchError) as ctx:
            asyncio.run(web_image_search.search_images("客厅", 4, sources=["myspace"]))
        self.assertIn("不支持的图片来源", str(ctx.exception))

    def test_all_sources_failed_returns_empty_with_real_reasons(self):
        async def bad(client, query, count, orientation):
            raise web_image_search.WebImageSearchError("站点挂了")

        with self._client_ctx(), self._patch_adapters({"huaban": bad, "bing": bad}):
            result = asyncio.run(web_image_search.search_images(
                "完全不存在的词", 4, sources=["huaban", "bing"]))
        self.assertEqual(result["items"], [])
        self.assertEqual(result["sources"], {})
        self.assertIn("花瓣：站点挂了", result["note"])
        self.assertIn("必应图片：站点挂了", result["note"])

    def test_source_timeout_does_not_break_other_sources(self):
        async def slow(client, query, count, orientation):
            raise asyncio.TimeoutError()

        async def ok(client, query, count, orientation):
            return [self._item("bing", "https://a.com/1.jpg")]

        with self._client_ctx(), self._patch_adapters({"huaban": slow, "bing": ok}):
            result = asyncio.run(web_image_search.search_images(
                "客厅", 4, sources=["huaban", "bing"]))
        self.assertEqual(len(result["items"]), 1)
        self.assertIn("花瓣：请求超时", result["note"])

    def test_normalize_sources_accepts_chinese_names_and_rejects_unknown(self):
        self.assertEqual(web_image_search.normalize_sources(["花瓣", "必应"]), ["huaban", "bing"])
        self.assertEqual(web_image_search.normalize_sources("花瓣,堆糖"), ["huaban", "duitang"])
        self.assertEqual(web_image_search.normalize_sources(None), list(web_image_search.DEFAULT_SOURCES))
        self.assertEqual(web_image_search.normalize_sources(["xiaohongshu"]), ["xiaohongshu"])
        with self.assertRaises(web_image_search.WebImageSearchError):
            web_image_search.normalize_sources(["myspace"])


    def test_search_rejects_empty_query(self):
        with self.assertRaises(web_image_search.WebImageSearchError):
            asyncio.run(web_image_search.search_images("   ", 6, "any"))


class ThumbnailRuleTests(unittest.TestCase):
    def test_bing_thumbnail_hosts_detected(self):
        for url, host in (
            ("https://ts2.mm.bing.net/th?id=OIP.abc&pid=15.1", "ts2.mm.bing.net"),
            ("https://ts1.mm.bing.net/th?id=x", "ts1.mm.bing.net"),
            ("https://tse4.mm.bing.net/th?id=x", "tse4.mm.bing.net"),
            # Lead 复验的真实形态：474x449 的缩略图，300px 阈值拦不住，只能靠域名规则
            ("https://ts1.explicit.bing.net/th?id=OIP.MO9xxx&pid=15.1", "ts1.explicit.bing.net"),
            ("https://ts4.explicit.bing.net/th?id=OIP.abc&pid=15.1", "ts4.explicit.bing.net"),
            ("https://tse1.mm.bing.net/th?id=OIP.def", "tse1.mm.bing.net"),
            ("https://th.bing.com/th/id/OIP.MO9xxx?pid=ImgDet&w=300", "th.bing.com"),
        ):
            reason = web_image_search.known_thumbnail_reason(url)
            self.assertIn("必应缩略图", reason)
            self.assertIn(host, reason)
        self.assertEqual(web_image_search.known_thumbnail_reason("https://cdn.pixabay.com/photo/a.jpg"), "")
        self.assertEqual(web_image_search.known_thumbnail_reason("https://mm.bing.net/th?id=x"), "")
        # 必应站内但不是 /th/ 路径（例如图片搜索页）不算缩略图
        self.assertEqual(web_image_search.known_thumbnail_reason("https://cn.bing.com/images/search?q=x"), "")

    def test_360_thumbnail_hosts_detected(self):
        self.assertIn("360 缩略图", web_image_search.known_thumbnail_reason(
            "https://p3.ssl.qhimgs1.com/t04c1388cf732ec80b9.jpg"))
        self.assertIn("360 缩略图", web_image_search.known_thumbnail_reason(
            "https://p1.ssl.qhimgs1.com/sdr/_240_/t018a6bd838b8afe92b.gif"))
        # 原图在 qhimg.com（没有 s），不能误杀
        self.assertEqual(web_image_search.known_thumbnail_reason(
            "http://p0.so.qhimg.com/t04c1388cf732ec80b9.jpg"), "")
        self.assertEqual(web_image_search.known_thumbnail_reason(
            "https://p3.ssl.qhimgs1.com/abc123.jpg"), "")


    def test_huaban_size_suffix_is_thumbnail_and_can_be_stripped(self):
        original = "https://gd-hbimg.huabanimg.com/abc-2sgkVJ"
        for suffix in ("_fw236", "_fw658", "_sq75", "_fw", "_sq"):
            with self.subTest(suffix=suffix):
                url = original + suffix
                self.assertIn("花瓣缩略图", web_image_search.known_thumbnail_reason(url))
                self.assertTrue(web_image_search.is_huaban_thumbnail(url))
                self.assertEqual(web_image_search.huaban_original_url(url), original)
        self.assertEqual(web_image_search.known_thumbnail_reason(original), "")
        self.assertFalse(web_image_search.is_huaban_thumbnail(original))
        self.assertEqual(web_image_search.huaban_original_url(original), original)

    def test_duitang_resize_url_is_thumbnail(self):
        thumb = ("https://a-ho-img.dtstatic.com/uploads/item/x.jpeg"
                 "?x-image-process=image/resize,m_fixed,w_400/ignore-error,1")
        self.assertIn("堆糖缩略图", web_image_search.known_thumbnail_reason(thumb))
        self.assertEqual(web_image_search.known_thumbnail_reason(
            "https://a-ho-img.dtstatic.com/uploads/item/x.jpeg"), "")

    def test_zcool_scaled_url_is_thumbnail(self):
        self.assertIn("站酷缩略图", web_image_search.known_thumbnail_reason(
            "https://img.zcool.cn/community/x.png!/small"))
        self.assertEqual(web_image_search.known_thumbnail_reason(
            "https://img.zcool.cn/community/x.png"), "")


class SourceAdapterTests(unittest.TestCase):
    """新来源解析：只测「返回结构 → 统一 ImageItem」，不联网。"""

    class _Resp:
        def __init__(self, content=b"", headers=None, payload=None, status=200):
            self.content = content
            self.headers = headers or {}
            self.status_code = status
            self._payload = payload

        def raise_for_status(self):
            if self.status_code >= 400:
                raise web_image_search.WebImageSearchError(f"HTTP {self.status_code}")

        def json(self):
            return self._payload

    class _Client:
        def __init__(self, response):
            self.response = response
            self.calls = []

        async def get(self, url, params=None, headers=None):
            self.calls.append({"url": url, "params": params, "headers": headers})
            return self.response

    def test_huaban_adapter_builds_original_from_bucket_and_key(self):
        payload = {"pins": [{"pin_id": 123, "raw_text": "北欧风客厅",
                             "file": {"bucket": "gd-hbimg", "key": "abc-key", "width": 777, "height": 864}}]}
        client = self._Client(self._Resp(payload=payload))
        items = asyncio.run(web_image_search._search_huaban(client, "北欧风客厅", 10))
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item["original_url"], "https://gd-hbimg.huabanimg.com/abc-key")
        self.assertEqual(item["thumb_url"], "https://hbimg.huabanimg.com/abc-key_fw236")
        self.assertEqual((item["width"], item["height"]), (777, 864))
        self.assertEqual(item["source_kind"], "huaban")
        self.assertEqual(item["source_site"], "huaban.com")
        self.assertEqual(item["source_page"], "https://huaban.com/pins/123/")
        self.assertIn("huaban.com/v3/search", client.calls[0]["url"])

    def test_duitang_adapter_strips_resize_param_and_skips_avatars(self):
        html = ('<img alt="北欧风客厅" data-rootid="42" '
                'src="https://a-ho-img.dtstatic.com/uploads/item/x.jpeg?x-image-process=image/resize,m_fixed,w_400">'
                '<img src="https://a-ho-img.dtstatic.com/uploads/people/2015/a.jpeg">')
        resp = self._Resp(html.encode("utf-8"), headers={"content-type": "text/html; charset=utf-8"})
        items = asyncio.run(web_image_search._search_duitang(self._Client(resp), "北欧风客厅", 10))
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item["original_url"], "https://a-ho-img.dtstatic.com/uploads/item/x.jpeg")
        self.assertIn("x-image-process", item["thumb_url"])
        self.assertEqual(item["source_page"], "https://www.duitang.com/blog/?id=42")
        self.assertEqual(item["source_kind"], "duitang")

    def test_zcool_adapter_reports_real_reason_when_no_images(self):
        resp = self._Resp(b"<html><body>please login</body></html>",
                          headers={"content-type": "text/html; charset=utf-8"})
        with self.assertRaises(web_image_search.WebImageSearchError) as ctx:
            asyncio.run(web_image_search._search_zcool(self._Client(resp), "北欧风客厅", 10))
        self.assertIn("403", str(ctx.exception))


class SearchToolSourcesTests(unittest.TestCase):
    """工具层 sources 参数：中文名归一、未知来源报 invalid_args。"""

    def test_validate_normalizes_sources(self):
        args = main._agent_tool_search_images_validate({"query": "客厅", "sources": ["花瓣", "必应"]})
        self.assertEqual(args["sources"], ["huaban", "bing"])

    def test_validate_rejects_unknown_source(self):
        with self.assertRaises(main.AgentToolError) as ctx:
            main._agent_tool_search_images_validate({"query": "客厅", "sources": ["myspace"]})
        self.assertEqual(ctx.exception.code, "invalid_args")
        self.assertIn("不支持的图片来源", ctx.exception.message)

    def test_validate_without_sources_keeps_none(self):
        args = main._agent_tool_search_images_validate({"query": "客厅"})
        self.assertIsNone(args["sources"])


class So360EngineTests(unittest.TestCase):
    class _Resp:
        def __init__(self, status, body):
            self.status_code = status
            self.content = body

        @property
        def text(self):
            return self.content.decode("utf-8", errors="replace")

    class _Client:
        def __init__(self, responses):
            self.responses = list(responses)
            self.calls = []

        async def get(self, url, params=None, headers=None):
            self.calls.append({"url": url, "params": params, "headers": headers})
            return self.responses.pop(0)

    def test_retries_once_on_html_error_page_then_json(self):
        html = "<html><body>360图片_访问异常出错</body></html>".encode("utf-8")
        payload = json.dumps({"list": [{"img": "https://a.com/1.jpg",
                                        "thumb": "https://p1.ssl.qhimgs1.com/t0001.jpg",
                                        "title": "图", "width": "1200", "height": "800",
                                        "link": "https://page.com/1", "site": "page.com"}]},
                             ensure_ascii=False).encode("utf-8")
        client = self._Client([self._Resp(200, html), self._Resp(200, payload)])
        items = asyncio.run(web_image_search._search_360_images(client, "猫", 6, "any"))
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]["width"], items[0]["height"]), (1200, 800))
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(client.calls[0]["headers"]["Referer"], "https://image.so.com/")
        self.assertEqual(client.calls[0]["headers"]["Accept"], "application/json, text/plain, */*")

    def test_raises_with_real_reason_after_retry(self):
        html = "<html><body>360图片_访问异常出错</body></html>".encode("utf-8")
        client = self._Client([self._Resp(200, html), self._Resp(200, html)])
        with self.assertRaises(web_image_search.WebImageSearchError) as ctx:
            asyncio.run(web_image_search._search_360_images(client, "猫", 6, "any"))
        message = str(ctx.exception)
        self.assertIn("已重试 1 次", message)
        self.assertIn("不是 JSON", message)
        self.assertIn("360图片_访问异常出错", message)
        self.assertEqual(len(client.calls), 2)


class ImportTests(unittest.TestCase):
    def _import(self, urls, name=""):
        with tempfile.TemporaryDirectory() as dest:
            return asyncio.run(web_image_search.import_images(
                urls, dest, "/assets/uploads/agent-web", name)), dest

    def test_import_saves_original_and_reports_real_size(self):
        payload = _image_bytes(1600, 1000)

        async def fake_fetch(client, url, referer="", max_bytes=web_image_search.MAX_DOWNLOAD_BYTES):
            return {"data": payload, "ext": ".png", "final_url": url, "content_type": "image/png",
                    "width": 1600, "height": 1000}

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                result = asyncio.run(web_image_search.import_images(
                    ["https://example.com/a.png"], dest, "/assets/uploads/agent-web", "海报 参考"))
            item = result["items"][0]
            self.assertTrue(item["ok"])
            self.assertEqual((item["width"], item["height"]), (1600, 1000))
            self.assertEqual(item["bytes"], len(payload))
            self.assertTrue(item["url"].startswith("/assets/uploads/agent-web/"))
            saved = os.listdir(dest)
            self.assertEqual(len(saved), 1)
            self.assertTrue(saved[0].startswith("up_"))
            self.assertTrue(saved[0].endswith(".png"))

    def test_import_rejects_known_thumbnail_without_downloading(self):
        called = []

        async def fake_fetch(*args, **kwargs):
            called.append(args)
            raise AssertionError("已知缩略图不应触发下载")

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                result = asyncio.run(web_image_search.import_images(
                    ["https://ts2.mm.bing.net/th?id=OIP.x&pid=15.1"], dest, "/assets/uploads/agent-web"))
            item = result["items"][0]
            self.assertFalse(item["ok"])
            self.assertEqual(item["error"], "只拿到缩略图")
            self.assertEqual(item["code"], "thumbnail_only")
            self.assertIn("ts2.mm.bing.net", item["detail"])
            self.assertEqual(called, [])
            self.assertEqual(os.listdir(dest), [])

    def test_import_rejects_huaban_and_duitang_thumbnails_without_downloading(self):
        urls = [
            "https://gd-hbimg.huabanimg.com/abc-key_fw236",
            "https://hbimg.huabanimg.com/abc-key_sq75",
            "https://a-ho-img.dtstatic.com/uploads/item/x.jpeg?x-image-process=image/resize,m_fixed,w_400",
        ]
        called = []

        async def fake_fetch(*args, **kwargs):
            called.append(args)
            raise AssertionError("已知缩略图不应触发下载")

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                result = asyncio.run(web_image_search.import_images(urls, dest, "/assets/uploads/agent-web"))
            self.assertEqual(called, [])
            self.assertEqual(os.listdir(dest), [])
        for item in result["items"]:
            self.assertFalse(item["ok"])
            self.assertEqual(item["code"], "thumbnail_only")
            self.assertEqual(item["error"], "只拿到缩略图")

    def test_import_rejects_all_known_bing_thumbnail_forms_without_downloading(self):
        urls = [
            "https://ts1.explicit.bing.net/th?id=OIP.MO9xxx&pid=15.1",
            "https://tse1.mm.bing.net/th?id=OIP.def",
            "https://th.bing.com/th/id/OIP.MO9xxx?pid=ImgDet&w=300",
        ]
        called = []

        async def fake_fetch(*args, **kwargs):
            called.append(args)
            raise AssertionError("已知缩略图不应触发下载")

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                result = asyncio.run(web_image_search.import_images(urls, dest, "/assets/uploads/agent-web"))
            self.assertEqual(called, [])
            self.assertEqual(os.listdir(dest), [])
        for item in result["items"]:
            self.assertFalse(item["ok"])
            self.assertEqual(item["error"], "只拿到缩略图")
            self.assertEqual(item["code"], "thumbnail_only")
            self.assertIn("必应缩略图地址", item["detail"])

    def test_import_uses_source_page_origin_as_referer(self):
        payload = _image_bytes(900, 700)
        seen = {}

        async def fake_fetch(client, url, referer="", max_bytes=web_image_search.MAX_DOWNLOAD_BYTES):
            seen["referer"] = referer
            return {"data": payload, "ext": ".png", "final_url": url, "content_type": "image/png",
                    "width": 900, "height": 700}

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                result = asyncio.run(web_image_search.import_images(
                    [{"url": "https://img.example.com/a.jpg",
                      "source_page": "https://www.58pic.com/some/page?x=1"}],
                    dest, "/assets/uploads/agent-web"))
        self.assertEqual(seen["referer"], "https://www.58pic.com")
        self.assertTrue(result["items"][0]["ok"])

    def test_import_referer_falls_back_to_image_origin(self):
        payload = _image_bytes(900, 700)
        seen = {}

        async def fake_fetch(client, url, referer="", max_bytes=web_image_search.MAX_DOWNLOAD_BYTES):
            seen["referer"] = referer
            return {"data": payload, "ext": ".png", "final_url": url, "content_type": "image/png",
                    "width": 900, "height": 700}

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                asyncio.run(web_image_search.import_images(
                    ["https://img.example.com/a.jpg"], dest, "/assets/uploads/agent-web"))
        self.assertEqual(seen["referer"], "https://img.example.com")

    def test_import_rejects_redirect_to_thumbnail_host(self):
        payload = _image_bytes(1600, 1000)

        async def fake_fetch(client, url, referer="", max_bytes=web_image_search.MAX_DOWNLOAD_BYTES):
            return {"data": payload, "ext": ".png",
                    "final_url": "https://p3.ssl.qhimgs1.com/t04c1388cf732ec80b9.jpg",
                    "content_type": "image/png", "width": 1600, "height": 1000}

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                result = asyncio.run(web_image_search.import_images(
                    ["https://example.com/a.jpg"], dest, "/assets/uploads/agent-web"))
            item = result["items"][0]
            self.assertFalse(item["ok"])
            self.assertEqual(item["code"], "thumbnail_only")
            self.assertIn("跳转到了缩略图地址", item["detail"])
            self.assertEqual(os.listdir(dest), [])

    def test_thumbnail_only_is_rejected_and_not_saved(self):
        payload = _image_bytes(200, 150)

        async def fake_fetch(client, url, referer="", max_bytes=web_image_search.MAX_DOWNLOAD_BYTES):
            return {"data": payload, "ext": ".png", "final_url": url, "content_type": "image/png",
                    "width": 200, "height": 150}

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                result = asyncio.run(web_image_search.import_images(
                    ["https://example.com/small.png"], dest, "/assets/uploads/agent-web"))
            item = result["items"][0]
            self.assertFalse(item["ok"])
            self.assertEqual(item["error"], "只拿到缩略图")
            self.assertEqual(item["code"], "thumbnail_only")
            self.assertEqual(os.listdir(dest), [])

    def test_import_reports_real_download_error(self):
        async def fake_fetch(client, url, referer="", max_bytes=web_image_search.MAX_DOWNLOAD_BYTES):
            raise web_image_search.WebImageSearchError("下载原图失败：HTTP 403")

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                result = asyncio.run(web_image_search.import_images(
                    ["https://example.com/forbidden.jpg"], dest, "/assets/uploads/agent-web"))
        item = result["items"][0]
        self.assertFalse(item["ok"])
        self.assertIn("HTTP 403", item["error"])
        self.assertEqual(item["code"], "download_failed")

    def test_import_rejects_bad_url_list(self):
        with self.assertRaises(web_image_search.WebImageSearchError):
            asyncio.run(web_image_search.import_images([], "/tmp/x", "/assets/uploads/agent-web"))
        with self.assertRaises(web_image_search.WebImageSearchError):
            asyncio.run(web_image_search.import_images(
                ["https://example.com/%d.jpg" % i for i in range(13)], "/tmp/x", "/assets/uploads/agent-web"))


class ReverseTests(unittest.TestCase):
    def test_reverse_requires_real_vision_result(self):
        async def no_vision(url):
            raise web_image_search.WebImageSearchError("没有可用的看图模型")

        with self.assertRaises(web_image_search.WebImageSearchError):
            asyncio.run(web_image_search.find_similar_images(
                "https://example.com/a.jpg", 6, describe=None))     # 没有看图链路
        with self.assertRaises(web_image_search.WebImageSearchError):
            asyncio.run(web_image_search.find_similar_images(
                "https://example.com/a.jpg", 6, describe=no_vision))  # 看图链路直接失败

    def test_reverse_merges_queries(self):
        async def describe(url):
            return {"description": "一只白底咖啡杯", "queries": ["咖啡杯 白底", "陶瓷杯 俯拍"]}

        async def fake_search_images(query, count=12, orientation="any", verify=None, trust_env=None):
            return {"engine": "bing", "query": query,
                    "items": [web_image_search._make_item("https://a.com/%s.jpg" % query, "", query, 1200, 800)]}

        with patch.object(web_image_search, "search_images", fake_search_images):
            result = asyncio.run(web_image_search.find_similar_images(
                "https://example.com/a.jpg", 12, describe=describe))
        self.assertEqual(result["queries"], ["咖啡杯 白底", "陶瓷杯 俯拍"])
        self.assertEqual(result["query"], "咖啡杯 白底")
        self.assertEqual(result["description"], "一只白底咖啡杯")
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual(result["engine"], "merged")


class AgentWebImageGateTests(unittest.TestCase):
    def test_disabled_tools_rejected_and_hidden_from_catalog(self):
        cases = (
            ("search_images", {"query": "猫"}),
            ("find_similar_images", {"image_url": "https://example.com/a.jpg"}),
            ("add_image_to_canvas", {"canvas_id": "c1", "url": "https://example.com/a.jpg"}),
        )
        with patch.object(main, "load_settings", return_value={}):
            for tool, args in cases:
                with self.subTest(tool=tool):
                    result = asyncio.run(main.agent_execute_step(tool, args))
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["code"], "web_access_disabled")
            names = {item["name"] for item in main._agent_build_tools_catalog()}
            for tool, _args in cases:
                self.assertNotIn(tool, names)

    def test_enabled_tools_are_in_catalog(self):
        with patch.object(main, "load_settings", return_value={"agent_web_enabled": True}):
            names = {item["name"] for item in main._agent_build_tools_catalog()}
            for tool in ("search_images", "find_similar_images", "add_image_to_canvas"):
                self.assertIn(tool, names)

    def test_canvas_run_tools_include_web_tools_only_when_enabled(self):
        ctx = main._CanvasRunContext({"canvas_id": "c1"})
        with patch.object(main, "load_settings", return_value={}):
            names = set(ctx.tools())
            for tool in ("search_images", "find_similar_images", "add_image_to_canvas"):
                self.assertNotIn(tool, names)
        with patch.object(main, "load_settings", return_value={"agent_web_enabled": True}):
            names = set(ctx.tools())
            for tool in ("web_search", "fetch_url", "search_images", "find_similar_images",
                         "add_image_to_canvas"):
                self.assertIn(tool, names)

    def test_task_snapshot_keeps_step_code(self):
        bus = {"run_id": "run_test", "events": [
            {"name": "step_result", "seq": 3,
             "data": {"index": 0, "tool": "search_images", "ok": False,
                      "error": "画布助手联网功能未开启", "code": "web_access_disabled"}},
            {"name": "step_result", "seq": 4,
             "data": {"index": 1, "tool": "search_images", "ok": True, "result": {"items": []}}},
        ], "created_at": 1.0}
        snapshot = main._agent_run_task_snapshot(bus)
        failed, succeeded = snapshot["events"]
        self.assertEqual(failed["eventType"], "tool.execution.failed")
        self.assertEqual(failed["safePayload"]["code"], "web_access_disabled")
        self.assertEqual(failed["safePayload"]["toolId"], "search_images")
        self.assertEqual(succeeded["eventType"], "tool.execution.succeeded")
        self.assertIsNone(succeeded["safePayload"]["code"])

    def test_http_endpoints_return_403_with_code_when_disabled(self):
        payloads = (
            main.AgentImagesImportPayload(urls=["https://example.com/a.jpg"]),
            main.AgentImagesAddToCanvasPayload(canvas_id="c1", url="https://example.com/a.jpg"),
            main.AgentImagesReversePayload(image_url="https://example.com/a.jpg", count=6),
        )
        handlers = (main.agent_images_import, main.agent_images_add_to_canvas, main.agent_images_reverse)
        with patch.object(main, "load_settings", return_value={}):
            for handler, payload in zip(handlers, payloads):
                with self.subTest(handler=handler.__name__):
                    response = asyncio.run(handler(payload))
                    self.assertEqual(response.status_code, 403)
                    body = json.loads(response.body.decode("utf-8"))
                    self.assertEqual(body["code"], "web_access_disabled")
                    self.assertIn("设置", body["message"])


class AgentReverseChainTests(unittest.TestCase):
    """反图必须真读图：走现有看图链路拿描述 + 检索词；拿不到图/没有视觉模型一律报错，不猜词。"""

    def setUp(self):
        # _AGENT_VISION_DENY 是进程级黑名单：每个用例从干净状态开始，避免互相污染
        main._AGENT_VISION_DENY.clear()
        self.addCleanup(main._AGENT_VISION_DENY.clear)

    def _fake_model(self):
        return {"provider": "fake", "base": "http://127.0.0.1:1/v1", "headers": {}, "model": "fake-vision"}

    def test_reverse_uses_vision_model_and_returns_queries(self):
        reply = json.dumps({"description": "白底咖啡杯", "queries": ["咖啡杯 白底", "陶瓷杯 俯拍"]},
                           ensure_ascii=False)
        captured = {}

        async def fake_payload(url):
            return "data:image/jpeg;base64,AAAA"

        async def fake_chat(chat, messages):
            captured["chat"] = chat
            captured["messages"] = messages
            return reply

        async def fake_search_images(query, count=12, orientation="any", verify=None, trust_env=None):
            return {"engine": "bing", "query": query,
                    "items": [web_image_search._make_item("https://a.com/%s.jpg" % query, "", query, 1200, 800)]}

        with patch.object(main, "_agent_vision_image_payload", fake_payload), \
             patch.object(main, "_agent_pick_caption_model", lambda exclude_key="": self._fake_model()), \
             patch.object(main, "_agent_run_chat", fake_chat), \
             patch.object(web_image_search, "search_images", fake_search_images):
            result = asyncio.run(main._agent_reverse_image_search("/assets/uploads/a.jpg", 8))
        self.assertEqual(result["description"], "白底咖啡杯")
        self.assertEqual(result["queries"], ["咖啡杯 白底", "陶瓷杯 俯拍"])
        self.assertEqual(result["engine"], "merged")
        self.assertEqual(captured["chat"]["model"], "fake-vision")
        self.assertIn("queries", json.dumps(captured["messages"], ensure_ascii=False))

    def test_reverse_without_vision_model_reports_error(self):
        async def fake_payload(url):
            return "data:image/jpeg;base64,AAAA"

        with patch.object(main, "_agent_vision_image_payload", fake_payload), \
             patch.object(main, "_agent_pick_caption_model", lambda exclude_key="": None):
            with self.assertRaises(main.AgentToolError) as ctx:
                asyncio.run(main._agent_reverse_image_search("/assets/uploads/a.jpg", 8))
        self.assertEqual(ctx.exception.code, "vision_unavailable")
        self.assertIn("看图模型", ctx.exception.message)

    def test_reverse_reports_vision_call_failure(self):
        async def fake_payload(url):
            return "data:image/jpeg;base64,AAAA"

        async def bad_chat(chat, messages):
            raise main.AgentRunError("上游模型接口错误 400 不支持图片", code="provider_http_error")

        with patch.object(main, "_agent_vision_image_payload", fake_payload), \
             patch.object(main, "_agent_pick_caption_model", lambda exclude_key="": self._fake_model()), \
             patch.object(main, "_agent_run_chat", bad_chat):
            with self.assertRaises(main.AgentToolError) as ctx:
                asyncio.run(main._agent_reverse_image_search("/assets/uploads/a.jpg", 8))
        self.assertEqual(ctx.exception.code, "vision_failed")
        self.assertIn("视觉模型读图失败", ctx.exception.message)

    def test_reverse_reports_unparseable_vision_reply(self):
        async def fake_payload(url):
            return "data:image/jpeg;base64,AAAA"

        async def bad_reply(chat, messages):
            return "我觉得这张图挺好看的"

        with patch.object(main, "_agent_vision_image_payload", fake_payload), \
             patch.object(main, "_agent_pick_caption_model", lambda exclude_key="": self._fake_model()), \
             patch.object(main, "_agent_run_chat", bad_reply):
            with self.assertRaises(main.AgentToolError) as ctx:
                asyncio.run(main._agent_reverse_image_search("/assets/uploads/a.jpg", 8))
        self.assertEqual(ctx.exception.code, "vision_failed")


class CleanErrorTextTests(unittest.TestCase):
    def test_clean_error_text_strips_python_class_prefix(self):
        self.assertEqual(web_image_search.clean_error_text("WebAccessError: 网页域名无法解析"), "网页域名无法解析")
        self.assertEqual(web_image_search.clean_error_text("httpx.ConnectError: [Errno 61] Connection refused"),
                         "[Errno 61] Connection refused")
        self.assertEqual(web_image_search.clean_error_text("HTTP 403"), "HTTP 403")
        self.assertEqual(web_image_search.clean_error_text(""), "")
        self.assertEqual(web_image_search.clean_error_text("TimeoutError:"), "TimeoutError:")

    def test_execute_step_strips_class_prefix_for_web_tools(self):
        from server import web_access

        def boom(*args, **kwargs):
            raise web_access.WebAccessError("网页域名无法解析")

        with patch.object(main, "load_settings", return_value={"agent_web_enabled": True}), \
             patch.object(web_access, "download", boom):
            result = asyncio.run(main.agent_execute_step("fetch_url", {"url": "https://example.com"}))
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "网页域名无法解析")

    def test_http_error_body_strips_class_prefix(self):
        response = main._agent_web_http_error(400, "bad_request", "WebAccessError: 网页域名无法解析")
        body = json.loads(response.body.decode("utf-8"))
        self.assertEqual(body["message"], "网页域名无法解析")
        self.assertEqual(body["error"], "网页域名无法解析")
        self.assertEqual(body["code"], "bad_request")

    def test_import_error_text_has_no_class_prefix(self):
        async def fake_fetch(*args, **kwargs):
            raise RuntimeError("连接被重置")

        with tempfile.TemporaryDirectory() as dest:
            with patch.object(web_image_search, "fetch_image", fake_fetch):
                result = asyncio.run(web_image_search.import_images(
                    ["https://example.com/a.jpg"], dest, "/assets/uploads/agent-web"))
        item = result["items"][0]
        self.assertEqual(item["error"], "连接被重置")
        self.assertEqual(item["code"], "download_failed")

    def test_search_note_has_no_class_prefix(self):
        async def failing_360(client, query, count, orientation):
            raise RuntimeError("解析崩了")

        async def empty_bing(client, query, count, orientation):
            return []

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        with patch.object(web_image_search.httpx, "AsyncClient", lambda **kwargs: FakeClient()), \
             patch.object(web_image_search, "_search_360_images", failing_360), \
             patch.object(web_image_search, "_search_bing_images", empty_bing):
            result = asyncio.run(web_image_search.search_images("猫", 6, "any"))
        self.assertIn("解析崩了", result["note"])
        self.assertNotIn("RuntimeError", result["note"])


class VisionCandidateFallbackTests(unittest.TestCase):
    """反图/看图：候选列表逐个尝试，失败记黑名单并换下一个，全部失败聚合真实原因。"""

    def setUp(self):
        main._AGENT_VISION_DENY.clear()
        self.addCleanup(main._AGENT_VISION_DENY.clear)

    def _chat(self, provider, model):
        return {"provider": provider, "base": f"https://{provider}.invalid/v1", "headers": {},
                "model": model, "provider_cfg": {}}

    def _patch_providers(self, providers, order):
        def fake_providers():
            return list(order)

        def fake_cfg(pid):
            return providers[pid]

        def fake_resolve(pid, model, ms_model=""):
            return f"https://{pid}.invalid/v1", {}, model

        return (
            patch.object(main, "_agent_available_providers", fake_providers),
            patch.object(main, "get_api_provider", fake_cfg),
            patch.object(main, "resolve_chat_provider", fake_resolve),
        )

    def test_candidate_list_uses_config_order_and_skips_denied(self):
        providers = {"modelscope": {"id": "modelscope", "chat_models": ["Qwen3-VL-235B"]},
                     "apimart": {"id": "apimart", "chat_models": ["gemini-3-flash-preview"]}}
        patches = self._patch_providers(providers, ["modelscope", "apimart"])
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        keys = [main._agent_chat_vision_key(c) for c in main._agent_vision_candidates()]
        self.assertEqual(keys, ["modelscope:Qwen3-VL-235B", "apimart:gemini-3-flash-preview"])
        # 第一个失败进黑名单后，候选列表跳过它
        main._AGENT_VISION_DENY.add("modelscope:Qwen3-VL-235B")
        keys = [main._agent_chat_vision_key(c) for c in main._agent_vision_candidates()]
        self.assertEqual(keys, ["apimart:gemini-3-flash-preview"])

    def test_preferred_run_chat_comes_first(self):
        providers = {"apimart": {"id": "apimart", "chat_models": ["gemini-3-flash-preview"]}}
        patches = self._patch_providers(providers, ["apimart"])
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        preferred = self._chat("runprovider", "gpt-4o")
        keys = [main._agent_chat_vision_key(c) for c in main._agent_vision_candidates(preferred)]
        self.assertEqual(keys[0], "runprovider:gpt-4o")
        self.assertIn("apimart:gemini-3-flash-preview", keys)

    def test_reverse_switches_to_next_candidate_on_failure(self):
        bad = self._chat("modelscope", "Qwen3-VL-235B")
        good = self._chat("apimart", "gemini-3-flash-preview")
        calls = []

        async def fake_chat(chat, messages):
            calls.append(main._agent_chat_vision_key(chat))
            if chat["provider"] == "modelscope":
                raise main.AgentRunError('上游模型接口错误 {"msgCode":"A0211","msg":"user token expired"}',
                                         code="provider_http_error")
            return json.dumps({"description": "白底咖啡杯", "queries": ["咖啡杯 白底", "陶瓷杯 俯拍"]},
                              ensure_ascii=False)

        async def fake_payload(url):
            return "data:image/jpeg;base64,AAAA"

        with patch.object(main, "_agent_vision_image_payload", fake_payload), \
             patch.object(main, "_agent_vision_candidates",
                          lambda preferred=None, exclude_key="": [bad, good]), \
             patch.object(main, "_agent_run_chat", fake_chat):
            result = asyncio.run(main._agent_vision_read_image_for_search("/assets/uploads/a.jpg"))

        self.assertEqual(calls, ["modelscope:Qwen3-VL-235B", "apimart:gemini-3-flash-preview"])
        self.assertIn("modelscope:Qwen3-VL-235B", main._AGENT_VISION_DENY)
        self.assertEqual(result["model"], "gemini-3-flash-preview")
        self.assertEqual(result["queries"], ["咖啡杯 白底", "陶瓷杯 俯拍"])

    def test_reverse_all_candidates_failed_aggregates_reasons(self):
        bad1 = self._chat("modelscope", "Qwen3-VL-235B")
        bad2 = self._chat("apimart", "gemini-3-flash-preview")

        async def fake_chat(chat, messages):
            if chat["provider"] == "modelscope":
                raise main.AgentRunError('上游模型接口错误 {"msgCode":"A0211","msg":"user token expired"}',
                                         code="provider_http_error")
            raise main.AgentRunError("请求上游模型接口出错：timed out", code="provider_unreachable")

        async def fake_payload(url):
            return "data:image/jpeg;base64,AAAA"

        with patch.object(main, "_agent_vision_image_payload", fake_payload), \
             patch.object(main, "_agent_vision_candidates",
                          lambda preferred=None, exclude_key="": [bad1, bad2]), \
             patch.object(main, "_agent_run_chat", fake_chat):
            with self.assertRaises(main.AgentToolError) as ctx:
                asyncio.run(main._agent_vision_read_image_for_search("/assets/uploads/a.jpg"))

        self.assertEqual(ctx.exception.code, "vision_failed")
        message = ctx.exception.message
        self.assertIn("已尝试 2 个候选", message)
        self.assertIn("modelscope:Qwen3-VL-235B", message)
        self.assertIn("user token expired", message)
        self.assertIn("apimart:gemini-3-flash-preview", message)
        self.assertIn("timed out", message)
        self.assertEqual(main._AGENT_VISION_DENY,
                         {"modelscope:Qwen3-VL-235B", "apimart:gemini-3-flash-preview"})

    def test_caption_images_continues_to_next_candidate(self):
        bad = self._chat("modelscope", "Qwen3-VL-235B")
        good = self._chat("apimart", "gemini-3-flash-preview")
        calls = []

        async def fake_chat(chat, messages):
            calls.append(main._agent_chat_vision_key(chat))
            if chat["provider"] == "modelscope":
                raise main.AgentRunError("user token expired", code="provider_http_error")
            return "一只白底咖啡杯"

        failures = []
        with patch.object(main, "_agent_vision_candidates",
                          lambda preferred=None, exclude_key="": [bad, good]), \
             patch.object(main, "_agent_run_chat", fake_chat), \
             patch.object(main, "_agent_image_payload_url", lambda url: "data:image/jpeg;base64,AAAA"), \
             patch.object(main, "_agent_captions_load", return_value={}), \
             patch.object(main, "_agent_captions_save"):
            caps, model_name = asyncio.run(main._agent_caption_images(
                [{"label": "图1", "url": "/output/a.png"}, {"label": "图2", "url": "/output/b.png"}],
                "run:model", failures))

        self.assertEqual([c["caption"] for c in caps], ["一只白底咖啡杯", "一只白底咖啡杯"])
        self.assertEqual(model_name, "gemini-3-flash-preview")
        self.assertEqual(calls, ["modelscope:Qwen3-VL-235B", "apimart:gemini-3-flash-preview",
                                 "apimart:gemini-3-flash-preview"])
        self.assertIn("modelscope:Qwen3-VL-235B", failures[0])


    def test_vision_setup_reports_aggregated_reasons_when_all_fail(self):
        bad = self._chat("modelscope", "Qwen3-VL-235B")
        events = []

        async def fake_chat(chat, messages):
            raise main.AgentRunError("user token expired", code="provider_http_error")

        with patch.object(main, "_agent_vision_candidates",
                          lambda preferred=None, exclude_key="": [bad]), \
             patch.object(main, "_agent_run_chat", fake_chat), \
             patch.object(main, "_agent_image_payload_url", lambda url: "data:image/jpeg;base64,AAAA"), \
             patch.object(main, "_agent_captions_load", return_value={}), \
             patch.object(main, "_agent_captions_save"):
            mode, prompt_text = asyncio.run(main._agent_run_vision_setup(
                [{"label": "图1", "url": "/output/a.png"}],
                {"provider": "run", "model": "gpt-4o", "base": "https://r.invalid/v1", "headers": {}},
                lambda name, data: events.append((name, data))))

        self.assertEqual(mode, "none")
        event_text = events[-1][1]["text"]
        self.assertIn("modelscope:Qwen3-VL-235B", event_text)
        self.assertIn("user token expired", event_text)
        self.assertIn("试过的看图模型都失败", event_text)
        self.assertIn("user token expired", prompt_text)


if __name__ == "__main__":
    unittest.main()
