import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-web-proxy-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import httpx
from fastapi.testclient import TestClient

import main
from server import net_proxy, web_access


SCUTIL_HTTP_ONLY = """<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 0
  SOCKSEnable : 0
}"""

SCUTIL_HTTPS_ONLY = """<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : 10.0.0.2
  SOCKSEnable : 0
}"""

SCUTIL_SOCKS_ONLY = """<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}"""

SCUTIL_ALL_OFF = """<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
}"""


class ScutilProxyParseTests(unittest.TestCase):
    def test_http_proxy_wins_when_all_enabled(self):
        text = """<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}"""
        self.assertEqual(net_proxy.parse_scutil_proxy(text), "http://127.0.0.1:7897")

    def test_http_only(self):
        self.assertEqual(net_proxy.parse_scutil_proxy(SCUTIL_HTTP_ONLY), "http://127.0.0.1:7897")

    def test_https_only(self):
        self.assertEqual(net_proxy.parse_scutil_proxy(SCUTIL_HTTPS_ONLY), "https://10.0.0.2:8443")

    def test_socks_only_becomes_socks5h(self):
        self.assertEqual(net_proxy.parse_scutil_proxy(SCUTIL_SOCKS_ONLY), "socks5h://127.0.0.1:1080")

    def test_all_disabled_returns_none(self):
        self.assertIsNone(net_proxy.parse_scutil_proxy(SCUTIL_ALL_OFF))

    def test_enabled_without_host_or_port_is_ignored(self):
        text = """<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
}"""
        self.assertIsNone(net_proxy.parse_scutil_proxy(text))
        self.assertIsNone(net_proxy.parse_scutil_proxy(""))
        self.assertIsNone(net_proxy.parse_scutil_proxy("garbage"))


class WindowsProxyServerParseTests(unittest.TestCase):
    def test_bare_host_port(self):
        self.assertEqual(net_proxy.parse_windows_proxy_server("10.0.0.2:8080"), "http://10.0.0.2:8080")

    def test_mapping_prefers_http_then_https_then_socks(self):
        self.assertEqual(net_proxy.parse_windows_proxy_server("http=10.0.0.2:8080;https=10.0.0.2:8443"),
                         "http://10.0.0.2:8080")
        self.assertEqual(net_proxy.parse_windows_proxy_server("socks=10.0.0.2:1080;https=10.0.0.2:8443"),
                         "https://10.0.0.2:8443")
        self.assertEqual(net_proxy.parse_windows_proxy_server("socks=10.0.0.2:1080"),
                         "socks5h://10.0.0.2:1080")

    def test_full_url_and_empty_values(self):
        self.assertEqual(net_proxy.parse_windows_proxy_server("http://10.0.0.2:8080"), "http://10.0.0.2:8080")
        self.assertIsNone(net_proxy.parse_windows_proxy_server(""))
        self.assertIsNone(net_proxy.parse_windows_proxy_server(None))
        self.assertIsNone(net_proxy.parse_windows_proxy_server("ftp=10.0.0.2:21"))


class ProxyParamTests(unittest.TestCase):
    def test_http_and_https_proxies(self):
        self.assertEqual(net_proxy.httpx_proxy("http://127.0.0.1:7897"), {"proxy": "http://127.0.0.1:7897"})
        self.assertEqual(net_proxy.httpx_proxy("127.0.0.1:7897"), {"proxy": "http://127.0.0.1:7897"})
        self.assertEqual(net_proxy.httpx_proxy("https://10.0.0.2:8443"), {"proxy": "https://10.0.0.2:8443"})

    def test_socks_requires_socksio(self):
        self.assertEqual(net_proxy.httpx_proxy("socks5://127.0.0.1:1080"), {"proxy": "socks5://127.0.0.1:1080"})
        with patch.dict(sys.modules, {"socksio": None}):
            with redirect_stdout(io.StringIO()) as out:
                self.assertEqual(net_proxy.httpx_proxy("socks5h://127.0.0.1:1080"),
                                 {"mounts": {"all://": None, "http://": None, "https://": None}})
            self.assertIn("socksio", out.getvalue())

    def test_none_and_invalid_disable_env_proxy(self):
        # trust_env 在 macOS 会读到系统代理；direct 必须显式关掉 mounts 才是真直连
        disabled = {"mounts": {"all://": None, "http://": None, "https://": None}}
        self.assertEqual(net_proxy.httpx_proxy(None), disabled)
        self.assertEqual(net_proxy.httpx_proxy(""), disabled)
        self.assertEqual(net_proxy.httpx_proxy("ftp://127.0.0.1:21"), disabled)


class DetectSystemProxyTests(unittest.TestCase):
    def setUp(self):
        net_proxy.clear_proxy_cache()
        self.addCleanup(net_proxy.clear_proxy_cache)

    def test_platform_probe_is_cached_for_30s(self):
        calls = []

        def fake_platform():
            calls.append(1)
            return "http://127.0.0.1:7897"

        with patch.object(net_proxy, "_platform_proxy", side_effect=fake_platform), \
                patch.object(net_proxy, "_env_proxy", return_value=None):
            self.assertEqual(net_proxy.detect_system_proxy(), "http://127.0.0.1:7897")
            self.assertEqual(net_proxy.detect_system_proxy(), "http://127.0.0.1:7897")
            self.assertEqual(len(calls), 1)
            net_proxy.detect_system_proxy(force=True)
            self.assertEqual(len(calls), 2)

    def test_env_proxy_is_the_fallback(self):
        with patch.object(net_proxy, "_platform_proxy", return_value=None), \
                patch.dict(os.environ, {"HTTPS_PROXY": "127.0.0.1:7897"}):
            self.assertEqual(net_proxy.detect_system_proxy(force=True), "http://127.0.0.1:7897")

    def test_no_proxy_anywhere_returns_none(self):
        env = {key: "" for key in net_proxy._ENV_KEYS}
        with patch.object(net_proxy, "_platform_proxy", return_value=None), \
                patch.dict(os.environ, env):
            self.assertIsNone(net_proxy.detect_system_proxy(force=True))


class ResolveWebProxyTests(unittest.TestCase):
    def test_auto_is_default_and_uses_detected(self):
        with patch.object(net_proxy, "detect_system_proxy", return_value="http://127.0.0.1:7897"):
            self.assertEqual(net_proxy.resolve_web_proxy({}), "http://127.0.0.1:7897")
            self.assertEqual(net_proxy.resolve_web_proxy({"agent_web_proxy": "auto"}), "http://127.0.0.1:7897")

    def test_direct_never_uses_detected(self):
        with patch.object(net_proxy, "detect_system_proxy", return_value="http://127.0.0.1:7897"):
            self.assertIsNone(net_proxy.resolve_web_proxy({"agent_web_proxy": "direct"}))

    def test_custom_url_mode(self):
        settings = {"agent_web_proxy": "url", "agent_web_proxy_url": "socks5://127.0.0.1:1080"}
        self.assertEqual(net_proxy.resolve_web_proxy(settings), "socks5://127.0.0.1:1080")

    def test_legacy_value_that_is_already_a_url(self):
        self.assertEqual(net_proxy.resolve_web_proxy({"agent_web_proxy": "http://127.0.0.1:7897"}),
                         "http://127.0.0.1:7897")

    def test_invalid_custom_falls_back_to_auto(self):
        with patch.object(net_proxy, "detect_system_proxy", return_value="http://127.0.0.1:7897"):
            self.assertEqual(net_proxy.resolve_web_proxy(
                {"agent_web_proxy": "url", "agent_web_proxy_url": "ftp://1.2.3.4:21"}),
                "http://127.0.0.1:7897")

    def test_status_contract(self):
        with patch.object(net_proxy, "detect_system_proxy", return_value="http://127.0.0.1:7897"):
            body = net_proxy.web_proxy_status({})
        self.assertEqual(set(body), {"mode", "proxy", "detected", "note"})
        self.assertEqual(body["mode"], "auto")
        self.assertEqual(body["detected"], "http://127.0.0.1:7897")
        self.assertIsNone(body["proxy"])
        self.assertIn("跟随系统代理", body["note"])

    def test_status_reports_missing_proxy_and_custom(self):
        with patch.object(net_proxy, "detect_system_proxy", return_value=None):
            body = net_proxy.web_proxy_status({"agent_web_proxy": "auto"})
        self.assertIsNone(body["detected"])
        self.assertIn("未检测到系统代理", body["note"])
        body = net_proxy.web_proxy_status({"agent_web_proxy": "url",
                                           "agent_web_proxy_url": "http://127.0.0.1:7898"})
        self.assertEqual(body["proxy"], "http://127.0.0.1:7898")
        self.assertIn("自定义", body["note"])


class _FakeResponse:
    def __init__(self, chunks, status_code=200, headers=None):
        self.chunks = list(chunks)
        self.status_code = status_code
        self.headers = {"content-type": "text/html; charset=utf-8"}
        self.headers.update(headers or {})

    def iter_bytes(self):
        for chunk in self.chunks:
            yield chunk

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeClient:
    def __init__(self, error=None, chunks=(b"<p>ok</p>",)):
        self.error = error
        self.chunks = list(chunks)
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def stream(self, method, url, headers=None):
        self.calls.append({"method": method, "url": url, "headers": dict(headers or {})})
        if self.error:
            raise self.error
        return _FakeResponse(self.chunks)


class DownloadProxyTests(unittest.TestCase):
    def _fake_client_factory(self, created, error_for_proxy=None):
        def factory(timeout, proxy):
            client = _FakeClient(error=error_for_proxy if proxy else None)
            created.append((proxy, client))
            return client
        return factory

    def test_proxy_connect_failure_falls_back_to_direct(self):
        created = []
        out = io.StringIO()
        factory = self._fake_client_factory(created, error_for_proxy=httpx.ProxyError("proxy down"))
        with patch.object(web_access, "_web_proxy", return_value="http://127.0.0.1:7897"), \
                patch.object(web_access, "_client", side_effect=factory), \
                redirect_stdout(out):
            data, content_type, final_url = web_access.download("https://www.pinterest.com/pin/1/")
        self.assertEqual(data, b"<p>ok</p>")
        self.assertEqual(content_type, "text/html")
        self.assertEqual(final_url, "https://www.pinterest.com/pin/1/")
        self.assertEqual([proxy for proxy, _client in created], ["http://127.0.0.1:7897", None])
        self.assertIn("已回退直连", out.getvalue())
        # 不能再向服务器要 br：本机 brotlicffi 解 br 会抛 DecodingError
        self.assertEqual(created[-1][1].calls[0]["headers"].get("Accept-Encoding"), "gzip, deflate")
        self.assertNotIn("br", created[-1][1].calls[0]["headers"].get("Accept-Encoding", ""))

    def test_proxy_success_does_not_retry_direct(self):
        created = []
        factory = self._fake_client_factory(created)
        with patch.object(web_access, "_web_proxy", return_value="http://127.0.0.1:7897"), \
                patch.object(web_access, "_client", side_effect=factory):
            data, _ctype, _url = web_access.download("https://www.pinterest.com/pin/1/")
        self.assertEqual(data, b"<p>ok</p>")
        self.assertEqual([proxy for proxy, _client in created], ["http://127.0.0.1:7897"])

    def test_no_proxy_goes_direct_once(self):
        created = []
        factory = self._fake_client_factory(created)
        with patch.object(web_access, "_web_proxy", return_value=None), \
                patch.object(web_access, "_client", side_effect=factory):
            web_access.download("https://example.com/")
        self.assertEqual([proxy for proxy, _client in created], [None])


class NetworkErrorMessageTests(unittest.TestCase):
    def _download_error(self, error, proxy=None):
        def factory(timeout, proxy_url):
            return _FakeClient(error=error)
        with patch.object(web_access, "_web_proxy", return_value=proxy), \
                patch.object(web_access, "_client", side_effect=factory):
            with self.assertRaises(web_access.WebAccessError) as ctx:
                web_access.download("https://www.pinterest.com/pin/123456789012345678/")
        return str(ctx.exception)

    def test_timeout_mentions_domain_timeout_and_proxy_hint(self):
        message = self._download_error(httpx.ConnectTimeout("timed out"))
        self.assertIn("www.pinterest.com", message)
        self.assertIn("超时", message)
        self.assertIn("设置 ›", message)
        self.assertIn("画布助手联网", message)

    def test_dns_failure_mentions_domain_and_hint(self):
        message = self._download_error(
            httpx.ConnectError("[Errno 8] nodename nor servname provided, or not known"))
        self.assertIn("www.pinterest.com", message)
        self.assertIn("解析失败", message)
        self.assertIn("设置 ›", message)

    def test_proxy_and_direct_both_failed_are_reported(self):
        message = self._download_error(httpx.ConnectError("[Errno 61] Connection refused"),
                                       proxy="http://127.0.0.1:7897")
        self.assertIn("代理 http://127.0.0.1:7897 与直连都失败", message)


class BodyLimitTests(unittest.TestCase):
    def _download(self, chunks, max_bytes=web_access.MAX_BODY_BYTES):
        def factory(timeout, proxy):
            return _FakeClient(chunks=chunks)
        with patch.object(web_access, "_web_proxy", return_value=None), \
                patch.object(web_access, "_client", side_effect=factory):
            return web_access.download("https://example.com/big", max_bytes=max_bytes)

    def test_limit_is_three_megabytes(self):
        self.assertEqual(web_access.MAX_BODY_BYTES, 3 * 1024 * 1024)

    def test_exactly_three_megabytes_is_allowed(self):
        data, _ctype, _url = self._download([b"x" * (1024 * 1024)] * 3)
        self.assertEqual(len(data), 3 * 1024 * 1024)

    def test_more_than_three_megabytes_raises_with_size(self):
        with self.assertRaises(web_access.WebAccessError) as ctx:
            self._download([b"x" * (1024 * 1024)] * 3 + [b"x"])
        self.assertIn("3MB", str(ctx.exception))


class ReadableSummaryTests(unittest.TestCase):
    def test_js_shell_uses_title_and_meta_description(self):
        page = ('<html><head><title>北欧客厅 | Pinterest</title>'
                '<meta property="og:description" content="一组北欧风客厅参考图，原木色为主。">'
                '</head><body><div id="app"></div><script>boot()</script></body></html>').encode("utf-8")
        text = web_access.readable_text(page)
        self.assertIn("北欧客厅 | Pinterest", text)
        self.assertIn("一组北欧风客厅参考图，原木色为主。", text)
        self.assertIn("这个站点主要靠 JS 渲染", text)
        self.assertNotIn("请开启 JavaScript", text)

    def test_meta_description_priority(self):
        page = ('<html><head><title>T</title>'
                '<meta name="description" content="普通描述">'
                '<meta property="og:description" content="og 描述">'
                '</head><body></body></html>').encode("utf-8")
        text = web_access.readable_text(page)
        self.assertIn("普通描述", text)
        self.assertNotIn("og 描述", text)

    def test_json_ld_description_is_the_last_resort(self):
        page = ('<html><head><script type="application/ld+json">'
                '{"@context":"https://schema.org","@graph":[{"@type":"Article","description":"JSON-LD 描述"}]}'
                '</script></head><body><div></div></body></html>').encode("utf-8")
        text = web_access.readable_text(page)
        self.assertIn("JSON-LD 描述", text)
        self.assertIn("这个站点主要靠 JS 渲染", text)

    def test_site_name_only_still_gives_a_title(self):
        page = ('<html><head><meta property="og:site_name" content="Pinterest"></head>'
                '<body><div></div></body></html>').encode("utf-8")
        text = web_access.readable_text(page)
        self.assertIn("Pinterest", text)
        self.assertIn("页面没有提供描述", text)

    def test_short_page_without_metadata_keeps_plain_text(self):
        self.assertEqual(web_access.readable_text(b"<p>Hello world</p>"), "Hello world")
        self.assertEqual(
            web_access.readable_text(b"<html><script>alert(1)</script><style>x</style><p>Hello <b>world</b></p></html>"),
            "Hello world")

    def test_long_page_is_not_replaced_by_summary(self):
        body = ("<p>" + "真实正文 " * 60 + "</p>").encode("utf-8")
        text = web_access.readable_text(body)
        self.assertIn("真实正文", text)
        self.assertNotIn("这个站点主要靠 JS 渲染", text)


class ValidatePublicUrlProxyTests(unittest.TestCase):
    def test_proxy_skips_local_dns_resolution(self):
        with patch.object(web_access, "_web_proxy", return_value="http://127.0.0.1:7897"), \
                patch.object(web_access.socket, "getaddrinfo",
                             side_effect=AssertionError("不应在本地解析代理侧域名")):
            self.assertEqual(web_access.validate_public_url("https://www.pinterest.com/pin/1/"),
                             "https://www.pinterest.com/pin/1/")

    def test_proxy_still_rejects_localhost_and_private_literals(self):
        with patch.object(web_access, "_web_proxy", return_value="http://127.0.0.1:7897"):
            for url in ("http://127.0.0.1:3000", "http://localhost/x", "http://192.168.1.10/",
                        "http://10.0.0.5/", "https://example.com:8443"):
                with self.subTest(url=url):
                    with self.assertRaises(web_access.WebAccessError):
                        web_access.validate_public_url(url)

    def test_without_proxy_dns_failure_is_reported(self):
        with patch.object(web_access, "_web_proxy", return_value=None), \
                patch.object(web_access.socket, "getaddrinfo",
                             side_effect=web_access.socket.gaierror("name not known")):
            with self.assertRaises(web_access.WebAccessError) as ctx:
                web_access.validate_public_url("https://blocked.example/")
        message = str(ctx.exception)
        self.assertIn("blocked.example", message)
        self.assertIn("解析失败", message)
        self.assertIn("设置 ›", message)


class WebProxyEndpointTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.settings_path = os.path.join(self._tmp.name, "settings.json")
        settings_patch = patch.object(main, "SETTINGS_FILE", self.settings_path)
        settings_patch.start()
        self.addCleanup(settings_patch.stop)
        net_proxy.clear_proxy_cache()
        self.addCleanup(net_proxy.clear_proxy_cache)
        # 默认客户端主机是 testclient，属于本机回环，不会被局域网口令拦住
        self.client = TestClient(main.app, follow_redirects=False)

    def _patch_detected(self, proxy="http://127.0.0.1:7897"):
        detect_patch = patch.object(net_proxy, "detect_system_proxy",
                                    side_effect=lambda force=False: proxy)
        detect_patch.start()
        self.addCleanup(detect_patch.stop)

    def _settings(self):
        if not os.path.isfile(self.settings_path):
            return {}
        with open(self.settings_path, encoding="utf-8") as handle:
            return json.load(handle)

    def test_get_returns_contract(self):
        self._patch_detected()
        response = self.client.get("/api/agent/web-proxy")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(set(body), {"mode", "proxy", "detected", "note"})
        self.assertEqual(body["mode"], "auto")
        self.assertEqual(body["detected"], "http://127.0.0.1:7897")
        self.assertIsNone(body["proxy"])

    def test_put_direct_persists_mode(self):
        self._patch_detected()
        body = self.client.put("/api/agent/web-proxy", json={"mode": "direct"}).json()
        self.assertEqual(body["mode"], "direct")
        cfg = self._settings()
        self.assertEqual(cfg["agent_web_proxy"], "direct")
        self.assertNotIn("agent_web_proxy_url", cfg)

    def test_put_custom_url_persists_and_normalizes(self):
        self._patch_detected()
        body = self.client.put("/api/agent/web-proxy",
                               json={"mode": "url", "proxy": "http://127.0.0.1:7898/"}).json()
        self.assertEqual(body["mode"], "url")
        self.assertEqual(body["proxy"], "http://127.0.0.1:7898")
        cfg = self._settings()
        self.assertEqual(cfg["agent_web_proxy"], "url")
        self.assertEqual(cfg["agent_web_proxy_url"], "http://127.0.0.1:7898")

    def test_put_url_without_proxy_keeps_saved_address(self):
        self._patch_detected()
        self.client.put("/api/agent/web-proxy", json={"mode": "url", "proxy": "http://127.0.0.1:7898"})
        body = self.client.put("/api/agent/web-proxy", json={"mode": "url"}).json()
        self.assertEqual(body["proxy"], "http://127.0.0.1:7898")

    def test_put_rejects_invalid_mode_and_proxy(self):
        self._patch_detected()
        for payload in ({"mode": "bogus"}, {"mode": "url", "proxy": "ftp://1.2.3.4:21"},
                        {"mode": "url", "proxy": ""}):
            with self.subTest(payload=payload):
                response = self.client.put("/api/agent/web-proxy", json=payload)
                self.assertEqual(response.status_code, 400)
                body = response.json()
                self.assertFalse(body["ok"])
                self.assertIn(body["message"], ("代理模式只能是 auto（跟随系统）、direct（直连）或 url（自定义地址）",
                                                "自定义代理地址无效，请填 http://127.0.0.1:7897 或 socks5://127.0.0.1:1080"))
        self.assertEqual(self._settings(), {})

    def test_switch_back_to_auto_clears_custom_url(self):
        self._patch_detected()
        self.client.put("/api/agent/web-proxy", json={"mode": "url", "proxy": "http://127.0.0.1:7898"})
        body = self.client.put("/api/agent/web-proxy", json={"mode": "auto"}).json()
        self.assertEqual(body["mode"], "auto")
        self.assertNotIn("agent_web_proxy_url", self._settings())


if __name__ == "__main__":
    unittest.main()
