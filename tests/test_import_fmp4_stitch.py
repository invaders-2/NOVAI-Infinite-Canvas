# -*- coding: utf-8 -*-
"""import-fmp4 分片拼接单测：init + 有序分片 → 落一份可播的整段视频。

覆盖：
- 正常：init(ftyp) + 两段分片按顺序拼接，落盘字节完全等于拼接结果，item 带 kind/宽高/时长；
- 缺 init（第一段是 .m4s 分片）→ 400 且文案点明「不是 init 段」；
- 某段 404 → 400 且文案带段号与 HTTP 状态；
- 超过段数上限 → 400，且一个请求都不发；
- 总大小超限 → 400，且不落盘；
- 重复 init 段跳过（两张 ftyp 连排会拼出放不出来的文件）；
- 非 http(s) 地址 → 400。
跑法：venv/bin/python -m unittest tests.test_import_fmp4_stitch -v
"""
import asyncio
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402  （import 时完成 deps 绑定）
from server.routes import assets as assets_routes  # noqa: E402
from server.routes.deps import deps  # noqa: E402

# ffmpeg / 站点产出的 init.mp4：4 字节长度 + 'ftyp'
INIT_BYTES = b"\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41" + b"\x00" * 40 + b"\x00\x00\x00\x08moov"
# .m4s 分片：styp/moof 开头，单段 2~6 秒
SEG1_BYTES = b"\x00\x00\x00\x18stypmsdh" + b"\x01" * 60 + b"\x00\x00\x00\x10moof"
SEG2_BYTES = b"\x00\x00\x00\x18stypmsdh" + b"\x02" * 80 + b"\x00\x00\x00\x10moof"


class FakeResponse:
    def __init__(self, content, status_code=200, content_type="video/mp4"):
        self.content = content
        self.status_code = status_code
        self.headers = {"Content-Type": content_type}

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("GET", "https://cdn.example.com/x")
            raise httpx.HTTPStatusError("status " + str(self.status_code), request=request, response=httpx.Response(self.status_code))


class FakeAsyncClient:
    """按 URL 返回预置响应；记录每次请求（顺序 / 头）。"""

    routes = {}
    calls = []

    def __init__(self, *args, **kwargs):
        self.headers = (kwargs or {}).get("headers") or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def get(self, url, headers=None):
        merged = dict(self.headers)
        merged.update(headers or {})
        type(self).calls.append({"url": url, "headers": merged, "range": merged.get("Range", "")})
        route = type(self).routes.get(url)
        if route is None:
            return FakeResponse(b"", status_code=404)
        if callable(route):
            return route(merged)
        return route


class ImportFmp4Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self._prev = {}
        override = {
            "_local_upload_safe_folder": lambda folder: ("", self.root),
            "_local_upload_kind_ext": main._local_upload_kind_ext,
            "_sniff_image_ext_bytes": main._sniff_image_ext_bytes,
            "_local_upload_item": self._fake_item,
            "local_output_readonly_name": lambda folder: False,
            "_SSL_CONTEXT": True,
            "_TRUST_ENV": False,
            "probe_video_dimensions": lambda path: (320, 180),
            "probe_video_file_duration_seconds": lambda path: 4.0,
        }
        for key in override:
            self._prev[key] = deps.get(key)
        deps.bind(**override)
        FakeAsyncClient.routes = {}
        FakeAsyncClient.calls = []
        self._url_patch = patch.object(assets_routes, "_assert_public_fmp4_url", self._noop_public)
        self._url_patch.start()
        self._client_patch = patch.object(assets_routes.httpx, "AsyncClient", FakeAsyncClient)
        self._client_patch.start()

    def tearDown(self):
        self._client_patch.stop()
        self._url_patch.stop()
        deps.bind(**self._prev)
        self.tmp.cleanup()

    @staticmethod
    async def _noop_public(url, index):
        return None

    @staticmethod
    def _fake_item(rel):
        return {
            "id": rel,
            "file": rel,
            "name": os.path.basename(rel),
            "url": "/assets/uploads/" + rel,
            "kind": "video",
        }

    def _run(self, urls=None, items=None, referer="", page_url="", name=""):
        payload = assets_routes.LocalAssetFmp4ImportRequest(
            urls=urls or [], items=items or [], referer=referer, page_url=page_url, name=name
        )
        return asyncio.run(assets_routes.import_local_assets_from_fmp4(payload))

    def _bind_routes(self, mapping):
        FakeAsyncClient.routes = dict(mapping)

    @staticmethod
    def _serve_ranges(file_bytes):
        """按请求头 Range 返回字节区间（模拟 CDN 的 206）。"""
        def serve(headers):
            match = re.match(r"^bytes=(\d+)-(\d+)$", headers.get("Range", ""))
            if not match:
                return FakeResponse(file_bytes, status_code=200)
            start, end = int(match.group(1)), int(match.group(2))
            return FakeResponse(file_bytes[start:end + 1], status_code=206)
        return serve

    def test_stitch_order_and_file(self):
        urls = [
            "https://cdn.example.com/init.mp4",
            "https://cdn.example.com/seg_000.m4s",
            "https://cdn.example.com/seg_001.m4s",
        ]
        self._bind_routes({
            urls[0]: FakeResponse(INIT_BYTES),
            urls[1]: FakeResponse(SEG1_BYTES, content_type="video/iso.segment"),
            urls[2]: FakeResponse(SEG2_BYTES, content_type="video/iso.segment"),
        })
        data = self._run(urls, referer="https://www.xiaohongshu.com/explore/abc", name="在线视频")
        self.assertTrue(data["ok"], data)
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["segments"], 3)
        item = data["files"][0]
        self.assertTrue(item["file"].endswith(".mp4"), item["file"])
        self.assertIn("在线视频", item["file"])
        self.assertEqual(item["kind"], "video")
        # 宽高时长复用 ffprobe 探测（deps 注入）
        self.assertEqual((item["width"], item["height"]), (320, 180))
        self.assertEqual(item["duration"], 4.0)
        written = Path(self.root) / item["file"]
        self.assertEqual(written.read_bytes(), INIT_BYTES + SEG1_BYTES + SEG2_BYTES)
        # 下载顺序 = 传入顺序，且带 Referer / UA
        self.assertEqual([c["url"] for c in FakeAsyncClient.calls], urls)
        headers = FakeAsyncClient.calls[0]["headers"]
        self.assertEqual(headers.get("Referer"), "https://www.xiaohongshu.com/explore/abc")
        self.assertIn("Mozilla", headers.get("User-Agent", ""))
        # 拼出来的文件是 ftyp 开头 → 分片守卫不会误伤
        self.assertFalse(assets_routes._is_fmp4_fragment(written.read_bytes()[:64]))
        self.assertTrue(assets_routes._is_fmp4_init_segment(written.read_bytes()[:64]))
        # 返回结构与 import-urls 一致
        self.assertEqual(data["items"][0]["ok"], True)
        self.assertEqual(data["items"][0]["item"], item)

    def test_missing_init_rejected(self):
        urls = ["https://cdn.example.com/seg_000.m4s", "https://cdn.example.com/seg_001.m4s"]
        self._bind_routes({
            urls[0]: FakeResponse(SEG1_BYTES, content_type="video/iso.segment"),
            urls[1]: FakeResponse(SEG2_BYTES, content_type="video/iso.segment"),
        })
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(urls)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("不是 init 段", ctx.exception.detail)
        self.assertIn("ftyp", ctx.exception.detail)
        self.assertEqual(os.listdir(self.root), [], "缺 init 不能落盘")
        # 只下了第一段就停（确认是校验失败而不是把两段都拼了）
        self.assertEqual([c["url"] for c in FakeAsyncClient.calls], urls[:1])

    def test_segment_404_reports_index_and_status(self):
        urls = [
            "https://cdn.example.com/init.mp4",
            "https://cdn.example.com/seg_000.m4s",
            "https://cdn.example.com/seg_001.m4s",
        ]
        self._bind_routes({
            urls[0]: FakeResponse(INIT_BYTES),
            urls[1]: FakeResponse(SEG1_BYTES, content_type="video/iso.segment"),
            urls[2]: FakeResponse(b"", status_code=404),
        })
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(urls)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("第 3 段下载失败", ctx.exception.detail)
        self.assertIn("404", ctx.exception.detail)
        self.assertEqual(os.listdir(self.root), [])

    def test_too_many_segments_rejected_before_download(self):
        urls = ["https://cdn.example.com/init.mp4"] + ["https://cdn.example.com/seg_%03d.m4s" % i for i in range(600)]
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(urls)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("分片太多", ctx.exception.detail)
        self.assertEqual(FakeAsyncClient.calls, [], "超限时一个请求都不该发")

    def test_total_size_limit(self):
        urls = ["https://cdn.example.com/init.mp4", "https://cdn.example.com/seg_000.m4s"]
        self._bind_routes({
            urls[0]: FakeResponse(INIT_BYTES),
            urls[1]: FakeResponse(SEG1_BYTES, content_type="video/iso.segment"),
        })
        with patch.object(assets_routes, "_FMP4_MAX_TOTAL_BYTES", len(INIT_BYTES) + 10):
            with self.assertRaises(assets_routes.HTTPException) as ctx:
                self._run(urls)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("拼接总大小超过", ctx.exception.detail)
        self.assertEqual(os.listdir(self.root), [], "超限不落盘")

    def test_duplicate_init_skipped(self):
        urls = [
            "https://cdn.example.com/init.mp4",
            "https://cdn.example.com/init.mp4?again=1",
            "https://cdn.example.com/seg_000.m4s",
        ]
        self._bind_routes({
            urls[0]: FakeResponse(INIT_BYTES),
            urls[1]: FakeResponse(INIT_BYTES),
            urls[2]: FakeResponse(SEG1_BYTES, content_type="video/iso.segment"),
        })
        data = self._run(urls)
        self.assertEqual(data["segments"], 2)
        item = data["files"][0]
        self.assertEqual((Path(self.root) / item["file"]).read_bytes(), INIT_BYTES + SEG1_BYTES)

    def test_non_http_url_rejected(self):
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(["file:///tmp/init.mp4"])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("不是 http(s) 地址", ctx.exception.detail)

    def test_empty_urls_rejected(self):
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run([])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("没有可拼接的分片地址", ctx.exception.detail)

    def test_single_fragment_url_rejected(self):
        urls = ["https://cdn.example.com/seg_000.m4s"]
        self._bind_routes({urls[0]: FakeResponse(SEG1_BYTES, content_type="video/iso.segment")})
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(urls)
        self.assertIn("不是 init 段", ctx.exception.detail)

    def test_whole_file_single_url_takes_shortcut(self):
        # B 站 fnval=1 的 durl 整段直链 / DASH 的 baseUrl 整轨：一条、无 range、ftyp 开头 → 直存不拼接
        url = "https://h2i438c.edge.mountaintoys.cn:4483/upgcxcode/99/91/137649199/137649199_da2-1-16.mp4"
        full = INIT_BYTES + SEG1_BYTES
        self._bind_routes({url: FakeResponse(full)})
        data = self._run(items=[{"url": url}], name="bili-durl")
        self.assertTrue(data["ok"], data)
        self.assertTrue(data["whole_file"])
        self.assertEqual(data["segments"], 1)
        self.assertEqual(data["bytes"], len(full))
        written = Path(self.root) / data["files"][0]["file"]
        self.assertEqual(written.read_bytes(), full)
        self.assertEqual(len(FakeAsyncClient.calls), 1)
        self.assertEqual(FakeAsyncClient.calls[0]["range"], "", "整段捷径不发 Range")
        self.assertTrue(data["files"][0]["file"].endswith(".mp4"))

    def test_whole_file_without_ftyp_rejected(self):
        url = "https://cdn.example.com/not-mp4"
        self._bind_routes({url: FakeResponse(SEG1_BYTES, content_type="video/iso.segment")})
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(items=[{"url": url}])
        self.assertIn("不是 init 段", ctx.exception.detail)
        self.assertEqual(os.listdir(self.root), [])

    def test_range_items_same_url_stitch(self):
        url = "https://85u819t.edge.mountaintoys.cn:4483/upgcxcode/99/91/137649199/137649199_da2-1-100022.m4s"
        full = INIT_BYTES + SEG1_BYTES + SEG2_BYTES
        init_end = len(INIT_BYTES) - 1
        seg1_end = len(INIT_BYTES) + len(SEG1_BYTES) - 1
        items = [
            {"url": url, "range": "0-%d" % init_end},
            {"url": url, "range": "%d-%d" % (init_end + 1, seg1_end)},
            {"url": url, "range": "%d-%d" % (seg1_end + 1, len(full) - 1)},
        ]
        self._bind_routes({url: self._serve_ranges(full)})
        data = self._run(items=items, referer="https://www.bilibili.com/video/BV1GJ411x7h7", name="bili-dash")
        self.assertTrue(data["ok"], data)
        self.assertFalse(data["whole_file"])
        self.assertEqual(data["segments"], 3)
        written = Path(self.root) / data["files"][0]["file"]
        self.assertEqual(written.read_bytes(), full)
        self.assertEqual([c["range"] for c in FakeAsyncClient.calls], ["bytes=0-%d" % init_end, "bytes=%d-%d" % (init_end + 1, seg1_end), "bytes=%d-%d" % (seg1_end + 1, len(full) - 1)])
        self.assertEqual(FakeAsyncClient.calls[0]["headers"].get("Referer"), "https://www.bilibili.com/video/BV1GJ411x7h7")
        self.assertIn("Mozilla", FakeAsyncClient.calls[0]["headers"].get("User-Agent", ""))

    def test_items_dedupe_by_url_and_range(self):
        url = "https://cdn.example.com/track.m4s"
        full = INIT_BYTES + SEG1_BYTES
        segments = [
            {"url": url, "range": "0-%d" % (len(INIT_BYTES) - 1)},
            {"url": url, "range": "%d-%d" % (len(INIT_BYTES), len(full) - 1)},
        ]
        self._bind_routes({url: self._serve_ranges(full)})
        data = self._run(items=segments + [dict(segments[0]), dict(segments[1])])
        self.assertEqual(data["segments"], 2, "同一 (url, range) 只下一次")
        self.assertEqual(len(FakeAsyncClient.calls), 2)
        self.assertEqual((Path(self.root) / data["files"][0]["file"]).read_bytes(), full)

    def test_later_zero_start_init_skipped(self):
        url = "https://cdn.example.com/track.m4s"
        full = INIT_BYTES + SEG1_BYTES
        self._bind_routes({url: self._serve_ranges(full)})
        data = self._run(items=[
            {"url": url, "range": "0-%d" % (len(INIT_BYTES) - 1)},
            {"url": url, "range": "0-%d" % (len(INIT_BYTES) - 2)},
            {"url": url, "range": "%d-%d" % (len(INIT_BYTES), len(full) - 1)},
        ])
        self.assertEqual(data["segments"], 2, "第二个 0 起点 range 也是 ftyp → 跳过，不拼两张 ftyp")
        self.assertEqual((Path(self.root) / data["files"][0]["file"]).read_bytes(), full)

    def test_first_range_not_from_zero_rejected(self):
        url = "https://cdn.example.com/track.m4s"
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(items=[{"url": url, "range": "1683-71791"}])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("第一段不是 init 段", ctx.exception.detail)
        self.assertEqual(FakeAsyncClient.calls, [], "顺序不对时一个请求都不发")

    def test_invalid_range_rejected(self):
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(items=[{"url": "https://cdn.example.com/track.m4s", "range": "abc"}])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("range 不合法", ctx.exception.detail)
        self.assertEqual(FakeAsyncClient.calls, [])

    def test_range_length_mismatch_rejected(self):
        url = "https://cdn.example.com/track.m4s"
        self._bind_routes({url: lambda headers: FakeResponse(INIT_BYTES[:100], status_code=206)})
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(items=[{"url": url, "range": "0-1011"}])
        self.assertIn("Range 长度不符", ctx.exception.detail)

    def test_range_ignored_by_server_rejected(self):
        url = "https://cdn.example.com/track.m4s"
        self._bind_routes({url: FakeResponse(INIT_BYTES + SEG1_BYTES)})
        with self.assertRaises(assets_routes.HTTPException) as ctx:
            self._run(items=[{"url": url, "range": "0-11"}])
        self.assertIn("没按 Range 返回", ctx.exception.detail)

    def test_items_override_urls(self):
        items_url = "https://cdn.example.com/track.m4s"
        urls_url = "https://cdn.example.com/other.m4s"
        full = INIT_BYTES + SEG1_BYTES
        self._bind_routes({items_url: self._serve_ranges(full)})
        data = self._run(urls=[urls_url], items=[
            {"url": items_url, "range": "0-%d" % (len(INIT_BYTES) - 1)},
            {"url": items_url, "range": "%d-%d" % (len(INIT_BYTES), len(full) - 1)},
        ])
        self.assertTrue(data["ok"], data)
        self.assertEqual([c["url"] for c in FakeAsyncClient.calls], [items_url, items_url])


class Fmp4UrlGuardTests(unittest.TestCase):
    """素材下载放行任意端口，但私网/本机照样拒绝（安全不放松）。"""

    def test_guard_passes_allow_any_port(self):
        from server.routes import page_import as pi
        seen = []

        async def fake_assert(url, allow_any_port=False):
            seen.append((url, allow_any_port))
            return url, "cdn.example.com", 4483

        with patch.object(pi, "assert_public_url", fake_assert):
            asyncio.run(assets_routes._assert_public_fmp4_url("https://cdn.example.com:4483/a.m4s", 1))
        self.assertEqual(seen, [("https://cdn.example.com:4483/a.m4s", True)])

    def test_guard_keeps_private_blocked(self):
        from server.routes import page_import as pi
        with patch.object(
            pi,
            "assert_public_url",
            side_effect=pi.PageImportError("这个链接指向内网/本机地址，出于安全考虑不允许访问", "unsafe_url"),
        ):
            with self.assertRaises(assets_routes.HTTPException) as ctx:
                asyncio.run(assets_routes._assert_public_fmp4_url("http://127.0.0.1:4483/a.m4s", 2))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("第 2 段", ctx.exception.detail)
        self.assertIn("内网", ctx.exception.detail)


class Fmp4HelpersTests(unittest.TestCase):
    def test_init_detection(self):
        self.assertTrue(assets_routes._is_fmp4_init_segment(INIT_BYTES))
        self.assertFalse(assets_routes._is_fmp4_init_segment(SEG1_BYTES))
        self.assertFalse(assets_routes._is_fmp4_init_segment(b""))

    def test_fragment_guard_still_rejects_bare_segment(self):
        # 守卫保留：单段分片仍不能当整段视频过 import-urls 那一关
        self.assertTrue(assets_routes._is_fmp4_fragment(SEG1_BYTES))


if __name__ == "__main__":
    unittest.main()
