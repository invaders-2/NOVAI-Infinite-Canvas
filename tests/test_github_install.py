# -*- coding: utf-8 -*-
"""GitHub 技能安装：重试、限流文案、省配额（已知分支/路径不查 API）、备用源、可读报错。

全程 monkeypatch github_install.urlopen，不打真实网络。
"""
import os
import re
import ssl
import sys
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.skills import github_install  # noqa: E402

def setUpModule():
    # 直连用例不该被开发机上的中转配置影响
    for key in ("NOVAI_GITHUB_RELAY", "NOVAI_GITHUB_RELAY_TOKEN"):
        os.environ.pop(key, None)


MARKDOWN = "---\nname: retry-test-skill\ndescription: 测试技能\n---\n正文"
REPO = "https://github.com/acme/tools"
RAW_HOST = "raw.githubusercontent.com"
API_HOST = "api.github.com"
CDN_HOST = "cdn.jsdelivr.net"
REPO_API = "https://%s/repos/acme/tools" % API_HOST


class FakeResponse:
    def __init__(self, body, status=200):
        self.body = body.encode("utf-8") if isinstance(body, str) else body
        self.status = status

    def read(self, size=-1):
        return self.body if size is None or size < 0 else self.body[:size]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def ssl_eof():
    return ssl.SSLEOFError(8, "EOF occurred in violation of protocol")


def http_error(url, code, headers=None):
    return urllib.error.HTTPError(url, code, "err", headers or {}, None)


def is_raw(url):
    return RAW_HOST in url


def is_api(url):
    return API_HOST in url


def is_cdn(url):
    return CDN_HOST in url


def is_repos(url):
    return url == REPO_API


def is_tree(url):
    return "/git/trees/" in url


def is_contents(url):
    return "/contents/" in url


def install(handler):
    """返回 (fake_urlopen, calls, sleep_mock 上下文外的调用记录)。"""
    calls = []

    def fake(request, timeout=None):
        calls.append(request.full_url)
        return handler(request.full_url)

    return fake, calls


def tree_payload(*paths):
    return {"tree": [{"type": "blob", "path": p} for p in paths]}


def fetch(caller, url=REPO, path="", ref=""):
    return caller(url, path=path, ref=ref)


class RetryTests(unittest.TestCase):

    def test_ssl_eof_is_retried_then_succeeds(self):
        def handler(url):
            if len(calls) == 1:
                raise ssl_eof()
            return FakeResponse(MARKDOWN)

        calls = []

        def fake(request, timeout=None):
            calls.append(request.full_url)
            return handler(request.full_url)

        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep") as sleep:
            result = fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")

        self.assertEqual(result["markdown"], MARKDOWN)
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0].startswith("https://%s/acme/tools/main/" % RAW_HOST))
        sleep.assert_called_once_with(0.4)

    def test_5xx_retried_once_then_jsdelivr(self):
        calls = []

        def fake(request, timeout=None):
            calls.append(request.full_url)
            if is_raw(request.full_url):
                raise http_error(request.full_url, 503)
            return FakeResponse(MARKDOWN)

        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")

        self.assertEqual(sum(1 for url in calls if is_raw(url)), 2)      # 5xx 只重试一次
        self.assertTrue(result["source_url"].startswith("https://%s/gh/acme/tools@main/" % CDN_HOST))
        self.assertFalse(any(is_api(url) for url in calls))              # 不花 API 配额

    def test_probe_network_failure_reports_hosts_without_pretending_404(self):
        def fake(request, timeout=None):
            raise ssl_eof()

        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep") as sleep:
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")

        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn(RAW_HOST, message)
        self.assertIn(CDN_HOST, message)
        self.assertIn("EOF occurred in violation of protocol", message)
        self.assertIn("请检查网络或代理", message)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.4, 0.9, 0.4, 0.9])


class QuotaTests(unittest.TestCase):
    """能确定分支和路径时不碰 api.github.com。"""

    def test_known_ref_and_path_never_calls_api(self):
        fake, calls = install(lambda url: FakeResponse(MARKDOWN))
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown, path="skills/pdf/SKILL.md", ref="main")

        self.assertEqual(result["path"], "skills/pdf/SKILL.md")
        self.assertEqual(len(calls), 1)
        self.assertFalse(any(is_api(url) for url in calls))

    def test_tree_url_with_subdirectory_uses_raw_only(self):
        # 用户粘的 https://github.com/.../tree/main/skills/pdf 会解析成 ref=main + path=skills/pdf
        fake, calls = install(lambda url: FakeResponse(MARKDOWN))
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown,
                           url="https://github.com/anthropics/skills/tree/main/skills/pdf")

        self.assertEqual(result["ref"], "main")
        self.assertEqual(result["path"], "skills/pdf/SKILL.md")
        self.assertTrue(result["source_url"].endswith("/skills/pdf/SKILL.md"))
        self.assertFalse(any(is_api(url) for url in calls))

    def test_missing_ref_guesses_main_then_master_without_api(self):
        def handler(url):
            if "/acme/tools/main/" in url:
                raise http_error(url, 404)
            return FakeResponse(MARKDOWN)

        fake, calls = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown, path="skills/pdf/SKILL.md")

        self.assertEqual(result["ref"], "master")
        self.assertEqual([url.split("/")[5] for url in calls], ["main", "master"])

    def test_missing_ref_falls_back_to_api_default_branch(self):
        def handler(url):
            if is_repos(url):
                return FakeResponse('{"default_branch": "develop"}')
            if "/develop/" in url:
                return FakeResponse(MARKDOWN)
            raise http_error(url, 404)

        fake, calls = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown, path="skills/pdf/SKILL.md")

        self.assertEqual(result["ref"], "develop")
        self.assertEqual([url for url in calls if is_api(url)], [REPO_API])   # 只烧 1 次配额

    def test_missing_path_resolves_through_tree(self):
        def handler(url):
            if is_repos(url):
                return FakeResponse('{"default_branch": "main"}')
            if is_tree(url):
                return FakeResponse('{"tree": [{"type": "blob", "path": "skills/pdf/SKILL.md"}]}')
            return FakeResponse(MARKDOWN)

        fake, calls = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown)

        self.assertEqual(result["path"], "skills/pdf/SKILL.md")
        self.assertEqual(sum(1 for url in calls if is_api(url)), 2)           # repos + tree
        self.assertEqual(sum(1 for url in calls if is_raw(url)), 1)

    def test_subdirectory_without_direct_skill_md_uses_scoped_tree(self):
        # 用户给的是子目录，但 SKILL.md 在更深一层：直接猜 raw 会 404，只能靠目录树定位
        def handler(url):
            if is_tree(url):
                return FakeResponse('{"tree": [{"type": "blob", "path": "other/SKILL.md"},'
                                    ' {"type": "blob", "path": "skills/pdf/nested/SKILL.md"}]}')
            if is_raw(url) and not url.endswith("/nested/SKILL.md"):
                raise http_error(url, 404)
            return FakeResponse(MARKDOWN)

        fake, calls = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown, path="skills/pdf", ref="main")

        self.assertEqual(result["path"], "skills/pdf/nested/SKILL.md")
        self.assertFalse(any(is_repos(url) for url in calls))                 # 分支已知就不查仓库

    def test_multiple_skill_md_requires_path(self):
        def handler(url):
            if is_repos(url):
                return FakeResponse('{"default_branch": "main"}')
            return FakeResponse(json_dumps_tree("a/SKILL.md", "b/SKILL.md"))

        fake, _calls = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaisesRegex(github_install.GitHubSkillError, "多个 SKILL.md"):
                fetch(github_install.fetch_skill_markdown)


def json_dumps_tree(*paths):
    return '{"tree": [%s]}' % ", ".join('{"type": "blob", "path": "%s"}' % p for p in paths)


class FallbackTests(unittest.TestCase):

    def test_contents_api_used_when_raw_network_fails(self):
        def handler(url):
            if is_repos(url):
                return FakeResponse('{"default_branch": "main"}')
            if is_tree(url):
                return FakeResponse('{"tree": [{"type": "blob", "path": "skills/pdf/SKILL.md"}]}')
            if is_raw(url):
                raise ssl_eof()
            if is_contents(url):
                return FakeResponse(MARKDOWN)
            raise AssertionError("不该请求 %s" % url)

        fake, _calls = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown)

        self.assertTrue(result["source_url"].startswith(
            "https://%s/repos/acme/tools/contents/skills/pdf/SKILL.md?ref=main" % API_HOST))

    def test_all_three_hosts_fail_reports_all_of_them(self):
        def handler(url):
            if is_repos(url):
                return FakeResponse('{"default_branch": "main"}')
            if is_tree(url):
                return FakeResponse('{"tree": [{"type": "blob", "path": "skills/pdf/SKILL.md"}]}')
            raise ssl_eof()

        fake, calls = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown)

        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 502)
        for host in (RAW_HOST, API_HOST, CDN_HOST):
            self.assertIn(host, message)
        self.assertIn("EOF occurred in violation of protocol", message)
        self.assertIn("请检查网络或代理", message)
        self.assertNotIn("Traceback", message)
        self.assertEqual(sum(1 for url in calls if is_contents(url)), 3)

    def test_http_404_is_not_retried(self):
        calls = []

        def fake(request, timeout=None):
            calls.append(request.full_url)
            raise http_error(request.full_url, 404)

        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep") as sleep:
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")

        self.assertEqual(ctx.exception.status_code, 404)
        self.assertEqual(len(calls), 1)          # 同宿主不重试，404 也不用再问 jsdelivr
        sleep.assert_not_called()

    def test_directory_404_reports_not_found(self):
        def fake(request, timeout=None):
            raise http_error(request.full_url, 404)

        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown, path="skills/pdf/SKILL.md", ref="main")

        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("不存在", str(ctx.exception))

    def test_oversize_markdown_is_rejected(self):
        body = b"x" * (github_install.MAX_MARKDOWN_BYTES + 1)
        with mock.patch.object(github_install, "urlopen", return_value=FakeResponse(body)):
            with self.assertRaisesRegex(github_install.GitHubSkillError, "1MB"):
                fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")


class RateLimitTests(unittest.TestCase):

    def test_forbidden_with_zero_remaining_is_readable_rate_limit(self):
        reset = str(int(time.time()) + 660)

        def fake(request, timeout=None):
            raise http_error(request.full_url, 403,
                             {"X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "0",
                              "X-RateLimit-Reset": reset})

        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown)

        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertIn("访问次数已达上限", message)
        self.assertRegex(message, r"等待 \d+ 分钟后再试")
        self.assertIn("NOVAI_GITHUB_TOKEN", message)
        self.assertIn("带分支和目录的地址", message)
        self.assertIn("不消耗 API 次数", message)

    def test_forbidden_with_quota_left_keeps_permission_message(self):
        def fake(request, timeout=None):
            raise http_error(request.full_url, 403, {"X-RateLimit-Remaining": "42"})

        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")

        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("拒绝访问", str(ctx.exception))
        self.assertNotIn("访问次数已达上限", str(ctx.exception))

    def test_rate_limit_without_reset_header_stays_readable(self):
        def fake(request, timeout=None):
            raise http_error(request.full_url, 403, {"X-RateLimit-Remaining": "0"})

        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown)

        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertIn("访问次数已达上限", message)
        self.assertIn("请稍后重试", message)

    def test_http_429_is_rate_limit_message(self):
        def fake(request, timeout=None):
            raise http_error(request.full_url, 429, {"Retry-After": "60"})

        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")

        self.assertEqual(ctx.exception.status_code, 429)
        self.assertIn("访问次数已达上限", str(ctx.exception))


class JsdelivrFallbackTests(unittest.TestCase):
    """api.github.com 被限流时降级 jsDelivr Data API（不消耗 GitHub 配额）。"""

    RATE_HEADERS = {"X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "0"}

    def rate_limited(self, url):
        return http_error(url, 403, dict(self.RATE_HEADERS))

    def data_url(self, ref=None):
        if ref is None:
            return "https://%s/v1/packages/gh/acme/tools" % "data.jsdelivr.com"
        return "https://%s/v1/packages/gh/acme/tools@%s?structure=flat" % ("data.jsdelivr.com", ref)

    def test_rate_limited_api_installs_through_jsdelivr(self):
        calls = []

        def handler(url):
            calls.append(url)
            if is_api(url):
                raise self.rate_limited(url)
            if "data.jsdelivr.com" in url:
                return FakeResponse('{"files": [{"name": "/skills/pdf/SKILL.md"},'
                                    ' {"name": "/README.md"}]}')
            if is_raw(url):
                return FakeResponse(MARKDOWN)
            raise AssertionError("不该请求 %s" % url)

        fake, _ = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown)      # 没有 ref / path

        self.assertEqual(result["markdown"], MARKDOWN)
        self.assertEqual(result["ref"], "main")                     # jsDelivr 猜出来的默认分支
        self.assertEqual(result["path"], "skills/pdf/SKILL.md")
        self.assertTrue(any("data.jsdelivr.com" in url for url in calls))
        self.assertEqual(sum(1 for url in calls if is_raw(url)), 1)

    def test_rate_limited_api_and_jsdelivr_missing_reports_repo_not_found(self):
        def handler(url):
            if is_api(url):
                raise self.rate_limited(url)
            raise http_error(url, 404)

        fake, _ = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown,
                      url="https://github.com/tingqi-180403332311/fashion-editorial-skill")

        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("仓库不存在或名字不对", message)
        self.assertIn("tingqi-180403332311/fashion-editorial-skill", message)
        self.assertIn("NOVAI_GITHUB_TOKEN", message)
        self.assertNotIn("访问次数已达上限", message)               # 别用限流文案盖住"仓库不存在"

    def test_rate_limited_api_with_existing_repo_but_no_branch(self):
        def handler(url):
            if is_api(url):
                raise self.rate_limited(url)
            if "data.jsdelivr.com/v1/packages/gh/acme/tools" in url and "?" not in url:
                return FakeResponse('{"versions": [], "tags": {}}')   # 仓库有记录
            raise http_error(url, 404)

        fake, _ = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown)

        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("仓库不存在或名字不对", message)
        self.assertIn("分支/标签可能也不对", message)

    def test_rate_limited_api_and_jsdelivr_unavailable_keeps_rate_limit(self):
        def handler(url):
            if is_api(url):
                raise self.rate_limited(url)
            raise ssl_eof()

        fake, _ = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown)

        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertIn("访问次数已达上限", message)
        self.assertIn("带分支和目录的地址", message)

    def test_contents_rate_limit_falls_through_to_jsdelivr_content(self):
        def handler(url):
            if is_repos(url):
                return FakeResponse('{"default_branch": "main"}')
            if is_tree(url):
                return FakeResponse('{"tree": [{"type": "blob", "path": "skills/pdf/SKILL.md"}]}')
            if is_raw(url):
                raise ssl_eof()
            if is_contents(url):
                raise self.rate_limited(url)
            return FakeResponse(MARKDOWN)          # cdn.jsdelivr.net 兜住

        fake, _ = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown)

        self.assertTrue(result["source_url"].startswith("https://%s/gh/acme/tools@main/" % CDN_HOST))

    def test_rate_limited_default_branch_guess_is_readable(self):
        # 已知完整文件路径但没写分支：raw 猜 main/master 都不中，只能查默认分支，而 API 又被限流
        def handler(url):
            if is_api(url):
                raise self.rate_limited(url)
            raise http_error(url, 404)

        fake, _ = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown, path="skills/x/SKILL.md")

        self.assertEqual(ctx.exception.status_code, 429)
        self.assertIn("访问次数已达上限", str(ctx.exception))

    def test_api_repo_404_uses_unified_message(self):
        def handler(url):
            raise http_error(url, 404)

        fake, calls = install(handler)
        with mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown,
                      url="https://github.com/no-such-owner/no-such-repo")

        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("仓库不存在或名字不对：no-such-owner/no-such-repo", str(ctx.exception))
        self.assertFalse(any("data.jsdelivr.com" in url for url in calls))   # 没限流就不降级


RELAY_BASE = "http://127.0.0.1:4180"


def relay_env(secret=None):
    env = {"NOVAI_GITHUB_RELAY": RELAY_BASE}
    if secret:
        env["NOVAI_GITHUB_RELAY_TOKEN"] = secret
    return mock.patch.dict(os.environ, env, clear=False)


class RelayClientTests(unittest.TestCase):
    """配了中转：默认分支 / 列表 / 正文全部走 /v1/*，本地不读令牌也不直连 GitHub。"""

    def relay(self, routes):
        """routes: {路径后缀: (status, body)}；返回 (fake_urlopen, calls)。"""
        calls = []

        def fake(request, timeout=None):
            url = request.full_url
            calls.append((url, dict(request.headers)))
            for suffix, (status, body) in routes.items():
                if suffix in url:
                    if status == 200:
                        return FakeResponse(body, status)
                    raise urllib.error.HTTPError(url, status, "err", {}, None)
            raise AssertionError("不该请求 %s" % url)

        return fake, calls

    def test_raw_for_known_ref_and_path(self):
        fake, calls = self.relay({"/v1/raw": (200, MARKDOWN)})
        with relay_env(), mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown,
                           url="https://github.com/acme/tools/tree/main/skills/pdf")
        self.assertEqual(result["markdown"], MARKDOWN)
        self.assertEqual(result["ref"], "main")
        self.assertEqual(result["path"], "skills/pdf/SKILL.md")
        self.assertTrue(result["source_url"].startswith(RELAY_BASE + "/v1/raw?"))
        self.assertEqual(len(calls), 1)
        self.assertFalse(any("raw.githubusercontent.com" in url or "api.github.com" in url
                             for url, _headers in calls))

    def test_resolves_branch_and_skill_path_through_relay(self):
        fake, calls = self.relay({
            "/v1/default-branch": (200, '{"branch": "main"}'),
            "/v1/list": (200, '{"files": ["skills/pdf/SKILL.md"]}'),
            "/v1/raw": (200, MARKDOWN),
        })
        with relay_env(), mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown)          # 没有 ref / path
        self.assertEqual(result["ref"], "main")
        self.assertEqual(result["path"], "skills/pdf/SKILL.md")
        suffixes = [url.split(RELAY_BASE)[1].split("?")[0] for url, _h in calls]
        self.assertEqual(suffixes, ["/v1/default-branch", "/v1/list", "/v1/raw"])

    def test_directory_path_probes_then_lists(self):
        def fake(request, timeout=None):
            url = request.full_url
            if "/v1/raw" in url:
                path = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("path", [""])[0]
                if path == "skills/pdf/SKILL.md":
                    raise urllib.error.HTTPError(url, 404, "not found", {}, None)
                if path == "skills/pdf":
                    raise urllib.error.HTTPError(url, 404, "not found", {}, None)
                return FakeResponse(MARKDOWN, 200)
            if "/v1/list" in url:
                return FakeResponse('{"files": ["skills/pdf/deep/SKILL.md"]}', 200)
            raise AssertionError("不该请求 %s" % url)

        with relay_env(), mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown, path="skills/pdf", ref="main")
        self.assertEqual(result["path"], "skills/pdf/deep/SKILL.md")

    def test_multiple_skill_md_still_rejected(self):
        fake, _calls = self.relay({
            "/v1/default-branch": (200, '{"branch": "main"}'),
            "/v1/list": (200, '{"files": ["a/SKILL.md", "b/SKILL.md"]}'),
        })
        with relay_env(), mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("多个 SKILL.md", str(ctx.exception))

    def test_unreachable_relay_is_readable(self):
        def fake(request, timeout=None):
            raise ssl_eof()

        with relay_env(), mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown)

        message = str(ctx.exception)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("中转服务连不上：%s" % RELAY_BASE, message)
        self.assertIn("请检查中转是否在线", message)
        self.assertNotIn("仓库不存在", message)

    def test_secret_header_only_when_configured(self):
        fake, calls = self.relay({"/v1/raw": (200, MARKDOWN)})
        with relay_env(), mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")
        self.assertFalse(any(key.lower() == "x-relay-token" for _url, headers in calls
                             for key in headers))

        fake2, calls2 = self.relay({"/v1/raw": (200, MARKDOWN)})
        with relay_env(secret="s3cret"), mock.patch.object(github_install, "urlopen", side_effect=fake2), \
                mock.patch.object(github_install.time, "sleep"):
            fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")
        sent = [headers.get("X-relay-token") or headers.get("x-relay-token")
                for _url, headers in calls2]
        self.assertEqual(sent, ["s3cret"])

    def test_github_token_is_never_sent_to_relay(self):
        fake, calls = self.relay({"/v1/raw": (200, MARKDOWN)})
        env = {"NOVAI_GITHUB_TOKEN": "ghp_should_not_be_used"}
        with relay_env(), mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")
        for _url, headers in calls:
            self.assertNotIn("Authorization", headers)
        self.assertFalse(any("api.github.com" in url or "raw.githubusercontent.com" in url
                             for url, _headers in calls))

    def test_relay_default_branch_404_is_repo_not_found(self):
        fake, _calls = self.relay({"/v1/default-branch": (404, '{"error": "仓库不存在或名字不对：acme/tools"}')})
        with relay_env(), mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("仓库不存在或名字不对", str(ctx.exception))

    def test_relay_raw_404_after_list_is_not_found(self):
        fake, _calls = self.relay({
            "/v1/default-branch": (200, '{"branch": "main"}'),
            "/v1/list": (200, '{"files": ["skills/pdf/SKILL.md"]}'),
            "/v1/raw": (404, '{"error": "文件不存在"}'),
        })
        with relay_env(), mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown)
        self.assertEqual(ctx.exception.status_code, 404)
        self.assertIn("不存在", str(ctx.exception))

    def test_relay_401_means_secret_mismatch(self):
        fake, _calls = self.relay({"/v1/raw": (401, '{"error": "unauthorized"}')})
        with relay_env(secret="wrong"), mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            with self.assertRaises(github_install.GitHubSkillError) as ctx:
                fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertIn("密钥不匹配", str(ctx.exception))

    def test_no_relay_keeps_direct_behavior(self):
        calls = []

        def fake(request, timeout=None):
            calls.append(request.full_url)
            return FakeResponse(MARKDOWN, 200)

        with mock.patch.dict(os.environ, {"NOVAI_GITHUB_RELAY": "https://relay.example.com"}, clear=False), \
                mock.patch.object(github_install.token_store, "relay_url", return_value=""), \
                mock.patch.object(github_install, "urlopen", side_effect=fake), \
                mock.patch.object(github_install.time, "sleep"):
            result = fetch(github_install.fetch_skill_markdown, path="SKILL.md", ref="main")
        self.assertEqual(result["markdown"], MARKDOWN)
        self.assertTrue(calls[0].startswith("https://raw.githubusercontent.com/"))

class SecurityTests(unittest.TestCase):
    DATA_URL = "https://data.jsdelivr.com/v1/packages/gh/a/b@main?structure=flat"

    def test_rejects_non_whitelisted_or_plain_http_urls(self):
        for url in ("http://raw.githubusercontent.com/a/b/main/SKILL.md",
                    "https://evil.example.com/acme/tools",
                    "https://api.github.com@evil.example.com/x"):
            with self.subTest(url=url):
                with self.assertRaises(github_install.GitHubSkillError):
                    github_install._assert_allowed_url(url)

    def test_redirect_out_of_whitelist_is_rejected(self):
        handler = github_install._SafeRedirectHandler()
        request = urllib.request.Request("https://raw.githubusercontent.com/acme/tools/main/SKILL.md")
        with self.assertRaises(github_install.GitHubSkillError):
            handler.redirect_request(request, None, 302, "Found", {}, "https://evil.example.com/SKILL.md")

    def test_data_jsdelivr_is_whitelisted_but_gets_no_token(self):
        github_install._assert_allowed_url("https://data.jsdelivr.com/v1/packages/gh/a/b")
        headers = github_install._request_headers(self.DATA_URL, "secret", None)
        self.assertNotIn("Authorization", headers)
        self.assertEqual(headers["Accept"], "application/json")

    def test_token_only_goes_to_github_hosts(self):
        headers = github_install._request_headers("https://cdn.jsdelivr.net/gh/a/b@main/SKILL.md", "secret", "*/*")
        self.assertNotIn("Authorization", headers)
        headers = github_install._request_headers("https://api.github.com/repos/a/b", "secret", None)
        self.assertEqual(headers["Authorization"], "Bearer secret")


class ProxyTests(unittest.TestCase):

    def tearDown(self):
        github_install._SYSTEM_PROXY = None

    def test_parse_scutil_proxy_prefers_https(self):
        text = """<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.2
}"""
        self.assertEqual(github_install._parse_scutil_proxy(text), "http://127.0.0.2:7891")

    def test_parse_scutil_proxy_falls_back_to_http(self):
        text = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n}"
        self.assertEqual(github_install._parse_scutil_proxy(text), "http://127.0.0.1:7890")

    def test_parse_scutil_proxy_disabled(self):
        text = "<dictionary> {\n  HTTPEnable : 0\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n}"
        self.assertEqual(github_install._parse_scutil_proxy(text), "")

    def test_env_proxy_used_and_no_proxy_skipped(self):
        env = {"HTTPS_PROXY": "http://127.0.0.1:7890", "NO_PROXY": ".github.com"}
        with mock.patch.dict(os.environ, env, clear=False):
            self.assertEqual(github_install._proxy_for("https://api.github.com/repos/a/b"), "")
            self.assertEqual(github_install._proxy_for("https://cdn.jsdelivr.net/gh/a/b"),
                             "http://127.0.0.1:7890")

    def test_direct_when_no_proxy_configured(self):
        github_install._SYSTEM_PROXY = ""            # 探过且没有系统代理
        with mock.patch.dict(os.environ, {"NO_PROXY": ""}, clear=False):
            for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
                os.environ.pop(key, None)
            self.assertEqual(github_install._proxy_for("https://api.github.com/repos/a/b"), "")


if __name__ == "__main__":
    unittest.main()
