import asyncio
import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-web-access-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main
from server import web_access


class WebAccessToolTests(unittest.TestCase):
    def test_disabled_by_default_and_rejected_by_executor(self):
        with patch.object(main, "load_settings", return_value={}):
            self.assertFalse(main.agent_web_enabled())
            self.assertNotIn("web_search", {item["name"] for item in main._agent_build_tools_catalog()})
            result = asyncio.run(main.agent_execute_step("web_search", {"query": "NOVAI"}))
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "web_access_disabled")

    def test_setting_round_trip_and_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "settings.json")
            with patch.object(main, "SETTINGS_FILE", path):
                self.assertFalse(main.get_agent_web_access()["enabled"])
                self.assertTrue(main.set_agent_web_access(main.AgentWebAccessPayload(enabled=True))["enabled"])
                self.assertIn("web_search", {item["name"] for item in main._agent_build_tools_catalog()})
                self.assertIn("fetch_url", {item["name"] for item in main._agent_build_tools_catalog()})
                self.assertFalse(main.set_agent_web_access(main.AgentWebAccessPayload(enabled=False))["enabled"])
                self.assertNotIn("fetch_url", {item["name"] for item in main._agent_build_tools_catalog()})

    def test_readability_removes_scripts_and_truncates(self):
        text = web_access.readable_text(b"<html><script>alert(1)</script><style>x</style><p>Hello <b>world</b></p></html>")
        self.assertEqual(text, "Hello world")
        self.assertLessEqual(len(web_access.readable_text(b"x" * 21000, "text/plain")), 20100)

    def test_search_uses_360_first_and_decodes_result(self):
        html = b'''<ul class="result"><li class="res-list"><h3 class="res-title">
        <a href="https://www.so.com/link?m=abc" data-mdurl="https://example.com/docs">NOVAI &amp; Docs</a></h3>
        <span class="res-list-summary" data-result-summary>A useful &amp; concise result</span></li></ul>'''
        calls = []

        def fake_download(url, timeout=12.0, max_bytes=None, headers=None):
            calls.append(url)
            return html, "text/html", url

        with patch.object(web_access, "download", side_effect=fake_download), \
             patch.object(web_access, "validate_public_url", side_effect=lambda url: url):
            results = web_access.web_search("NOVAI")
        self.assertEqual(results, [{"title": "NOVAI & Docs", "url": "https://example.com/docs",
                                    "snippet": "A useful & concise result"}])
        self.assertIn("so.com", calls[0])

    def test_search_falls_back_to_bing_when_360_fails(self):
        bing_html = b'''<ol id="b_results"><li class="b_algo"><h2><a href="https://example.com/bing">
        Bing &amp; Result</a></h2><p>snippet from bing</p></li></ol>'''

        def fake_download(url, timeout=12.0, max_bytes=None, headers=None):
            if "so.com" in url:
                raise web_access.WebAccessError("网页返回 HTTP 503")
            return bing_html, "text/html", url

        with patch.object(web_access, "download", side_effect=fake_download), \
             patch.object(web_access, "validate_public_url", side_effect=lambda url: url):
            results = web_access.web_search("NOVAI")
        self.assertEqual(results, [{"title": "Bing & Result", "url": "https://example.com/bing",
                                    "snippet": "snippet from bing"}])

    def test_search_reports_real_reasons_when_both_engines_fail(self):
        with patch.object(web_access, "download", side_effect=web_access.WebAccessError("网页域名无法解析")):
            with self.assertRaises(web_access.WebAccessError) as ctx:
                web_access.web_search("NOVAI")
        message = str(ctx.exception)
        self.assertIn("360 搜索", message)
        self.assertIn("必应", message)
        self.assertIn("网页域名无法解析", message)

    def test_decode_html_handles_gbk_pages(self):
        raw = ('<meta charset="gb2312"><p>中文画布搜图</p>').encode("gbk")
        self.assertIn("中文画布搜图", web_access.decode_html(raw))
        self.assertIn("中文画布搜图", web_access.decode_html(raw, "text/html"))

    def test_bing_unwraps_ck_redirect_to_real_url(self):
        # 必应国内版结果包在 cn.bing.com/ck/a?u=a1<base64url> 里，要解包成真实地址
        target = "https://example.com/docs?from=bing"
        encoded = base64.urlsafe_b64encode(target.encode("utf-8")).decode("ascii").rstrip("=")
        bing_html = ('<ol id="b_results"><li class="b_algo"><h2>'
                     '<a href="https://cn.bing.com/ck/a?&amp;u=a1' + encoded + '&amp;ntb=1">Bing 结果</a>'
                     '</h2><p>Bing &amp; snippet</p></li></ol>').encode("utf-8")
        with patch.object(web_access, "download", return_value=(bing_html, "text/html", "https://cn.bing.com/search?q=x")), \
             patch.object(web_access, "validate_public_url", side_effect=lambda url: url):
            results = web_access._search_bing("NOVAI", 5)
        self.assertEqual(results, [{"title": "Bing 结果", "url": target, "snippet": "Bing & snippet"}])

    def test_bing_redirect_unwrap_helper_edges(self):
        target = "https://example.com/page"
        encoded = base64.urlsafe_b64encode(target.encode("utf-8")).decode("ascii").rstrip("=")
        self.assertEqual(web_access._unwrap_bing_redirect("https://cn.bing.com/ck/a?u=a1" + encoded), target)
        # 非必应跳转 / u 不是 a1 前缀 / base64 非法：一律原样返回，不抛错
        self.assertEqual(web_access._unwrap_bing_redirect("https://example.com/x"), "https://example.com/x")
        self.assertEqual(web_access._unwrap_bing_redirect("https://cn.bing.com/ck/a?u=zzz"), "https://cn.bing.com/ck/a?u=zzz")
        self.assertEqual(web_access._unwrap_bing_redirect("https://cn.bing.com/ck/a?u=a1%%%"), "https://cn.bing.com/ck/a?u=a1%%%")

    def test_search_no_results_raises_with_per_engine_reasons(self):
        # 页面能下载但解析不到结果（反爬空壳页）：要报「没有解析到搜索结果」，不能静默返回空
        with patch.object(web_access, "_search_360", return_value=[]), \
                patch.object(web_access, "_search_bing", return_value=[]):
            with self.assertRaises(web_access.WebAccessError) as ctx:
                web_access.web_search("NOVAI")
        message = str(ctx.exception)
        self.assertIn("360 搜索", message)
        self.assertIn("必应", message)
        self.assertIn("没有解析到搜索结果", message)

    def test_rejects_private_and_nonstandard_urls(self):
        for url in ("http://127.0.0.1:3000", "http://localhost", "file:///tmp/a", "https://user:pass@example.com", "https://example.com:8443"):
            with self.subTest(url=url):
                with self.assertRaises(web_access.WebAccessError):
                    web_access.validate_public_url(url)

    def test_fetch_url_returns_final_url_and_text(self):
        with patch.object(web_access, "download", return_value=(b"<p>Hello</p>", "text/html", "https://example.com/final")):
            result = web_access.fetch_url("https://example.com")
        self.assertEqual(result, {"url": "https://example.com/final", "text": "Hello"})


if __name__ == "__main__":
    unittest.main()
