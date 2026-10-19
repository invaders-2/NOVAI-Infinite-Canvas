# -*- coding: utf-8 -*-
"""page_import 纯逻辑单测：URL/SSRF 校验、HTML 主图解析、反爬页识别。

不联网：DNS 相关的用例只用 IP 字面量或直接调用 _assert_ips_public。
跑法：venv/bin/python -m unittest tests.test_page_import -v
"""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.routes import page_import as pi  # noqa: E402


class UrlGuardTests(unittest.TestCase):
    def test_rejects_non_http_scheme(self):
        for url in ("ftp://example.com/a.png", "file:///etc/passwd", "javascript:alert(1)", ""):
            with self.assertRaises(pi.PageImportError) as ctx:
                pi.split_public_url(url)
            self.assertEqual(ctx.exception.code, "unsafe_url" if url else "bad_request")

    def test_rejects_userinfo(self):
        with self.assertRaises(pi.PageImportError) as ctx:
            pi.split_public_url("https://user:pass@example.com/a")
        self.assertEqual(ctx.exception.code, "unsafe_url")

    def test_rejects_non_default_port(self):
        for url in ("http://example.com:8080/a", "https://example.com:8443/a", "http://example.com:22/"):
            with self.assertRaises(pi.PageImportError) as ctx:
                pi.split_public_url(url)
            self.assertEqual(ctx.exception.code, "unsafe_url")

    def test_accepts_default_ports(self):
        for url in ("https://huaban.com/pins/1", "http://example.com/a", "https://example.com:443/a", "http://example.com:80/a"):
            normalized, host, port = pi.split_public_url(url)
            self.assertEqual(normalized, url)
            self.assertTrue(host)
            self.assertIn(port, (None, 80, 443))

    def test_rejects_missing_host(self):
        with self.assertRaises(pi.PageImportError) as ctx:
            pi.split_public_url("https:///a")
        self.assertEqual(ctx.exception.code, "unsafe_url")

    def test_ip_is_public(self):
        private = ["127.0.0.1", "10.1.2.3", "172.16.5.5", "172.31.255.254",
                   "192.168.1.1", "169.254.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1",
                   "::ffff:127.0.0.1", "100.64.0.1", "198.18.0.1"]
        for ip in private:
            self.assertFalse(pi.ip_is_public(ip), ip)
        for ip in ("8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "203.0.113.9" if False else "93.184.216.34"):
            self.assertTrue(pi.ip_is_public(ip), ip)
        self.assertFalse(pi.ip_is_public("not-an-ip"))

    def test_assert_ips_public_blocks_private(self):
        with self.assertRaises(pi.PageImportError) as ctx:
            pi._assert_ips_public("internal.example", ["192.168.1.10"])
        self.assertEqual(ctx.exception.code, "unsafe_url")
        # 一个域名解析出公网+私网混合地址也要拒绝
        with self.assertRaises(pi.PageImportError):
            pi._assert_ips_public("mixed.example", ["8.8.8.8", "10.0.0.5"])
        pi._assert_ips_public("public.example", ["8.8.8.8"])

    def test_private_allowlist_env(self):
        os.environ["NOVAI_PAGE_IMPORT_PRIVATE_HOSTS"] = "127.0.0.1"
        try:
            pi._assert_ips_public("127.0.0.1", ["127.0.0.1"])
            with self.assertRaises(pi.PageImportError):
                pi._assert_ips_public("localhost", ["127.0.0.1"])
        finally:
            os.environ.pop("NOVAI_PAGE_IMPORT_PRIVATE_HOSTS", None)


class ParsePageTests(unittest.TestCase):
    def test_meta_priority_og_first(self):
        html = """
        <html><head>
          <title>花瓣 · 示例</title>
          <meta property="og:image" content="https://cdn.example.com/og.jpg">
          <meta name="twitter:image" content="https://cdn.example.com/tw.jpg">
          <link rel="image_src" href="https://cdn.example.com/link.jpg">
        </head><body><img src="https://cdn.example.com/body.jpg" width="900" height="900"></body></html>
        """
        # 普通站点（不在"og 常是品牌图"名单里）维持 og 优先
        parsed = pi.parse_page_images(html, "https://example.com/post/1", 4)
        self.assertEqual(parsed["title"], "花瓣 · 示例")
        urls = [c["url"] for c in parsed["candidates"]]
        self.assertEqual(urls[0], "https://cdn.example.com/og.jpg")
        self.assertIn("https://cdn.example.com/tw.jpg", urls)
        self.assertIn("https://cdn.example.com/link.jpg", urls)
        self.assertIn("https://cdn.example.com/body.jpg", urls)
        self.assertEqual(parsed["candidate_total"], 4)
        self.assertEqual(parsed["picked"], "og")

    def test_relative_and_protocol_relative(self):
        html = """
        <meta property="og:image" content="/img/og.png">
        <img src="//cdn2.example.com/x.webp" width="400" height="400">
        """
        parsed = pi.parse_page_images(html, "https://site.example.com/post/1", 3)
        urls = [c["url"] for c in parsed["candidates"]]
        self.assertEqual(urls[0], "https://site.example.com/img/og.png")
        self.assertIn("https://cdn2.example.com/x.webp", urls)

    def test_base_href_changes_join_base(self):
        html = """
        <head><base href="https://cdn.example.com/pins/"></head>
        <body><img src="big.jpg" width="800" height="600"></body>
        """
        parsed = pi.parse_page_images(html, "https://site.example.com/post/1", 1)
        self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/pins/big.jpg")

    def test_srcset_picks_largest(self):
        html = (
            '<img src="https://cdn.example.com/small.jpg" '
            'srcset="https://cdn.example.com/s.jpg 200w, https://cdn.example.com/l.jpg 1600w" '
            'width="300" height="300">'
        )
        parsed = pi.parse_page_images(html, "https://example.com/", 1)
        self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/l.jpg")
        self.assertEqual(parsed["candidates"][0]["width"], 1600)

    def test_small_and_avatar_filtered(self):
        html = """
        <img src="https://cdn.example.com/logo.png" width="64" height="64">
        <img src="https://cdn.example.com/user/avatar/1.jpg" width="800" height="800">
        <img src="https://cdn.example.com/big.jpg" width="500" height="500">
        <img src="https://cdn.example.com/icon.svg" width="900" height="900">
        """
        parsed = pi.parse_page_images(html, "https://example.com/", 5)
        urls = [c["url"] for c in parsed["candidates"]]
        self.assertEqual(urls, ["https://cdn.example.com/big.jpg"])

    def test_preferred_domain_wins_among_imgs(self):
        html = """
        <img src="https://other.example.com/a.jpg" width="1200" height="1200">
        <img src="https://i.pinimg.com/736x/aa/bb/cc.jpg" width="300" height="300">
        """
        # 普通站点：同优先级 <img> 里优先 pinimg 系域名
        parsed = pi.parse_page_images(html, "https://example.com/pin/1/", 2)
        urls = [c["url"] for c in parsed["candidates"]]
        self.assertEqual(urls[0], "https://i.pinimg.com/736x/aa/bb/cc.jpg")
        self.assertTrue(parsed["candidates"][0]["preferred"])
        self.assertEqual(parsed["picked"], "img")

    def test_huaban_family_domains_preferred(self):
        for host in ("huabanimg.com", "hbimg.huaban.com", "gd-hbimg.huaban.com", "img.xhscdn.com"):
            parsed = pi.parse_page_images(
                '<img src="https://%s/a.jpg" width="400" height="400">' % host,
                "https://example.com/",
                1,
            )
            self.assertTrue(parsed["candidates"][0]["preferred"], host)

    def test_meta_logo_named_image_kept(self):
        # og:image 是站点指定的分享图，文件名带 logo 也要用（<img> 里的 logo 才挡）
        html = '<meta property="og:image" content="https://cdn.example.com/site-logo-1200.png">'
        parsed = pi.parse_page_images(html, "https://example.com/", 1)
        self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/site-logo-1200.png")

    def test_img_logo_with_big_size_still_filtered(self):
        html = '<img src="https://cdn.example.com/assets/logo-main.jpg" width="1200" height="800">'
        parsed = pi.parse_page_images(html, "https://example.com/", 1)
        self.assertEqual(parsed["candidates"], [])

    def test_meta_svg_dropped(self):
        html = '<meta property="og:image" content="https://cdn.example.com/share.svg">'
        parsed = pi.parse_page_images(html, "https://example.com/", 1)
        self.assertEqual(parsed["candidates"], [])

    def test_auto_site_prefers_largest_img_over_brand_og(self):
        # 需求场景：小红书页 og:image 是品牌 logo，正文有大图 → 取大图
        html = """
        <meta property="og:image" content="https://www.xiaohongshu.com/fe-platform/logo.png">
        <img src="https://sns-img.example.com/content.jpg" width="1200" height="1600">
        """
        parsed = pi.parse_page_images(html, "https://www.xiaohongshu.com/explore/abc", 2)
        self.assertEqual(parsed["picked"], "largest")
        self.assertEqual(parsed["candidates"][0]["url"], "https://sns-img.example.com/content.jpg")
        self.assertNotIn(
            "https://www.xiaohongshu.com/fe-platform/logo.png",
            [c["url"] for c in parsed["candidates"]],
        )

    def test_pinterest_and_huaban_also_prefer_largest(self):
        html = """
        <meta property="og:image" content="https://cdn.example.com/og.jpg">
        <img src="https://cdn.example.com/big.jpg" width="800" height="1200">
        """
        for page in ("https://www.pinterest.com/pin/1/", "https://huaban.com/pins/1"):
            parsed = pi.parse_page_images(html, page, 1)
            self.assertEqual(parsed["picked"], "largest", page)
            self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/big.jpg", page)

    def test_auto_site_keeps_og_when_img_too_small(self):
        html = """
        <meta property="og:image" content="https://cdn.example.com/og.jpg">
        <img src="https://cdn.example.com/s1.jpg" width="300" height="300">
        <img src="https://cdn.example.com/s2.jpg" width="260" height="260">
        """
        parsed = pi.parse_page_images(html, "https://huaban.com/pins/1", 3)
        self.assertEqual(parsed["picked"], "og")
        self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/og.jpg")

    def test_prefer_og_forces_og_on_share_site(self):
        html = """
        <meta property="og:image" content="https://cdn.example.com/og.jpg">
        <img src="https://cdn.example.com/big.jpg" width="1200" height="1600">
        """
        parsed = pi.parse_page_images(html, "https://www.xiaohongshu.com/explore/abc", 2, "og")
        self.assertEqual(parsed["picked"], "og")
        self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/og.jpg")

    def test_prefer_largest_on_normal_site(self):
        html = """
        <meta property="og:image" content="https://cdn.example.com/og.jpg">
        <img src="https://cdn.example.com/big.jpg" width="1200" height="1600">
        """
        parsed = pi.parse_page_images(html, "https://example.com/post/1", 2, "largest")
        self.assertEqual(parsed["picked"], "largest")
        self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/big.jpg")

    def test_unknown_prefer_falls_back_to_auto(self):
        html = """
        <meta property="og:image" content="https://cdn.example.com/og.jpg">
        <img src="https://cdn.example.com/big.jpg" width="1200" height="1600">
        """
        parsed = pi.parse_page_images(html, "https://www.xiaohongshu.com/explore/abc", 1, "bogus")
        self.assertEqual(parsed["picked"], "largest")

    def test_largest_img_without_size_uses_dom_order(self):
        html = """
        <img src="https://cdn.example.com/first.jpg">
        <img src="https://cdn.example.com/second.jpg">
        """
        parsed = pi.parse_page_images(html, "https://www.pinterest.com/pin/1/", 1, "largest")
        # 两张都拿不到尺寸时，DOM 靠后的更可能是正文图
        self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/second.jpg")
        self.assertEqual(parsed["picked"], "largest")

    def test_brand_og_skipped_when_other_candidates_exist(self):
        html = """
        <meta property="og:image" content="https://cdn.example.com/brand/logo-share.png">
        <img src="https://cdn.example.com/content/pic.jpg" width="800" height="800">
        """
        parsed = pi.parse_page_images(html, "https://example.com/post/1", 2)
        urls = [c["url"] for c in parsed["candidates"]]
        self.assertEqual(parsed["picked"], "img")
        self.assertNotIn("https://cdn.example.com/brand/logo-share.png", urls)
        self.assertEqual(urls[0], "https://cdn.example.com/content/pic.jpg")

    def test_brand_og_kept_when_it_is_the_only_candidate(self):
        html = '<meta property="og:image" content="https://cdn.example.com/assets/logo.png">'
        parsed = pi.parse_page_images(html, "https://example.com/post/1", 1)
        self.assertEqual(parsed["picked"], "og")
        self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/assets/logo.png")

    def test_picked_image_src_and_img(self):
        src_html = (
            '<link rel="image_src" href="https://cdn.example.com/link.jpg">'
            '<img src="https://cdn.example.com/x.jpg" width="800" height="800">'
        )
        parsed = pi.parse_page_images(src_html, "https://example.com/post/1", 2)
        self.assertEqual(parsed["picked"], "image_src")
        self.assertEqual(parsed["candidates"][0]["url"], "https://cdn.example.com/link.jpg")

        img_html = '<img src="https://cdn.example.com/x.jpg" width="800" height="800">'
        parsed_img = pi.parse_page_images(img_html, "https://example.com/post/1", 1)
        self.assertEqual(parsed_img["picked"], "img")

    def test_data_and_svg_skipped(self):
        html = """
        <meta property="og:image" content="data:image/png;base64,AAAA">
        <img src="data:image/png;base64,BBBB">
        """
        parsed = pi.parse_page_images(html, "https://example.com/", 3)
        self.assertEqual(parsed["candidates"], [])

    def test_max_images_clamped(self):
        html = "".join(
            '<img src="https://cdn.example.com/%d.jpg" width="800" height="800">' % i for i in range(10)
        )
        self.assertEqual(len(pi.parse_page_images(html, "https://example.com/", 0)["candidates"]), 1)
        self.assertEqual(len(pi.parse_page_images(html, "https://example.com/", 100)["candidates"]), pi.MAX_IMAGES_CAP)

    def test_truncated_html_does_not_crash(self):
        # 页面被截断（标签闭合、正文没写完）时，已解析出的 meta 仍要能用
        parsed = pi.parse_page_images(
            '<html><head><meta property="og:image" content="https://c.d/a.jpg"><body><div class="x">',
            "https://e.com/",
            1,
        )
        self.assertEqual(parsed["candidates"][0]["url"], "https://c.d/a.jpg")
        # 连标签都没闭合的残缺输入不能抛异常
        pi.parse_page_images('<meta property="og:image" content="https://c.d/a.jpg"', "https://e.com/", 1)


class BlockPageTests(unittest.TestCase):
    def test_huaban_challenge_is_blocked(self):
        snippet = (
            "<html><head><title>出错了-花瓣网</title></head><body>"
            "<script>document.cookie='EO_Bot_Ssid='</script></body></html>"
        )
        self.assertTrue(pi._looks_like_block_page(snippet, "text/html"))

    def test_normal_page_not_blocked(self):
        html = "<html><head><title>正常页面</title></head><body>" + ("x" * 4096) + "</body></html>"
        self.assertFalse(pi._looks_like_block_page(html, "text/html"))

    def test_title_slug(self):
        self.assertEqual(pi._page_title_slug("  花瓣网 | 灵感/收集：好物  "), "花瓣网_灵感_收集_好物")
        self.assertEqual(pi._page_title_slug(""), "")

    def test_error_codes_map_to_http(self):
        self.assertEqual(pi.PageImportError("x", "blocked").status_code, 422)
        self.assertEqual(pi.PageImportError("x", "unsafe_url").status_code, 400)
        self.assertEqual(pi.PageImportError("x", "too_large").status_code, 413)
        self.assertEqual(pi.PageImportError("x", "not_html").status_code, 415)
        self.assertEqual(pi.PageImportError("x", "fetch_failed").status_code, 502)
        self.assertEqual(pi.PageImportError("x", "unknown-code").code, "fetch_failed")


if __name__ == "__main__":
    unittest.main()
