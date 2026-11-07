# -*- coding: utf-8 -*-
"""relay/python_relay.py 契约测试：本地起服务，上游 _fetch 全部打桩（不访问 GitHub）。"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
RELAY_DIR = ROOT / "relay"
if str(RELAY_DIR) not in sys.path:
    sys.path.insert(0, str(RELAY_DIR))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import python_relay  # noqa: E402

TREE = {
    "tree": [
        {"type": "blob", "path": "README.md"},
        {"type": "blob", "path": "SKILL.md"},
        {"type": "tree", "path": "skills"},
        {"type": "blob", "path": "skills/pdf/SKILL.md"},
    ]
}
MARKDOWN = "# PDF 技能\n正文"


class RelayCase(unittest.TestCase):
    token = ""
    secret = ""

    def setUp(self):
        self.upstream_calls = []
        self.upstream = {}
        self.server = python_relay.make_server("127.0.0.1", 0, token=self.token, secret=self.secret)
        self.port = self.server.server_address[1]
        thread = threading.Thread(target=self.server.serve_forever,
                                  kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        patcher = mock.patch.object(python_relay, "_fetch", side_effect=self.fake_fetch)
        patcher.start()
        self.addCleanup(patcher.stop)

    def stub(self, url_prefix, status, body):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8") if isinstance(body, dict) else str(body).encode("utf-8")
        self.upstream[url_prefix] = (status, body)

    def fake_fetch(self, url, token):
        self.upstream_calls.append((url, token))
        for prefix, result in self.upstream.items():
            if url.startswith(prefix):
                return result
        return 404, b"not found"

    def get(self, path, headers=None):
        request = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path), headers=headers or {})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.headers.get("Content-Type"), response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
            try:
                exc.close()
            except Exception:
                pass
            return exc.code, exc.headers.get("Content-Type"), body

    def post(self, path):
        request = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path), data=b"{}", method="POST")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
            try:
                exc.close()
            except Exception:
                pass
            return exc.code, body


class BasicContractTests(RelayCase):

    def test_health_is_open(self):
        status, ctype, body = self.get("/v1/health")
        self.assertEqual(status, 200)
        self.assertIn("application/json", ctype)
        self.assertEqual(json.loads(body.decode("utf-8")), {"ok": True})
        self.assertEqual(self.upstream_calls, [])            # 健康检查不碰上游

    def test_only_get_is_allowed(self):
        status, body = self.post("/v1/health")
        self.assertEqual(status, 405)
        self.assertEqual(json.loads(body.decode("utf-8"))["error"], "method not allowed")

    def test_unknown_route_is_404(self):
        status, _ctype, body = self.get("/v1/nope")
        self.assertEqual(status, 404)
        self.assertIn("not found", body.decode("utf-8"))

    def test_default_branch(self):
        self.stub("https://api.github.com/repos/acme/tools", 200, {"default_branch": "main"})
        status, _ctype, body = self.get("/v1/default-branch?owner=acme&repo=tools")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body.decode("utf-8"))["branch"], "main")
        self.assertTrue(self.upstream_calls[0][0].startswith("https://api.github.com/repos/acme/tools"))

    def test_default_branch_missing_repo(self):
        self.stub("https://api.github.com/repos/acme/tools", 404, b"")
        status, _ctype, body = self.get("/v1/default-branch?owner=acme&repo=tools")
        self.assertEqual(status, 404)
        self.assertIn("仓库不存在或名字不对：acme/tools", body.decode("utf-8"))

    def test_list_returns_only_skill_md(self):
        self.stub("https://api.github.com/repos/acme/tools/git/trees/main", 200, TREE)
        status, _ctype, body = self.get("/v1/list?owner=acme&repo=tools&ref=main")
        self.assertEqual(status, 200)
        files = json.loads(body.decode("utf-8"))["files"]
        self.assertEqual(files, ["SKILL.md", "skills/pdf/SKILL.md"])
        self.assertIn("recursive=1", self.upstream_calls[0][0])

    def test_raw_returns_markdown(self):
        self.stub("https://raw.githubusercontent.com/acme/tools/main/", 200, MARKDOWN)
        status, ctype, body = self.get("/v1/raw?owner=acme&repo=tools&ref=main&path=skills/pdf/SKILL.md")
        self.assertEqual(status, 200)
        self.assertIn("text/markdown", ctype)
        self.assertIn("charset=utf-8", ctype)
        self.assertEqual(body.decode("utf-8"), MARKDOWN)
        self.assertEqual(self.upstream_calls[0][0],
                         "https://raw.githubusercontent.com/acme/tools/main/skills/pdf/SKILL.md")

    def test_raw_missing_file(self):
        self.stub("https://raw.githubusercontent.com/acme/tools/main/", 404, b"")
        status, _ctype, body = self.get("/v1/raw?owner=acme&repo=tools&ref=main&path=nope/SKILL.md")
        self.assertEqual(status, 404)
        self.assertIn("文件不存在", body.decode("utf-8"))

    def test_raw_upstream_403_maps_to_403(self):
        self.stub("https://raw.githubusercontent.com/acme/tools/main/", 403, b"")
        status, _ctype, body = self.get("/v1/raw?owner=acme&repo=tools&ref=main&path=SKILL.md")
        self.assertEqual(status, 403)
        self.assertIn("GitHub 拒绝访问", body.decode("utf-8"))

    def test_oversize_markdown_is_413(self):
        self.stub("https://raw.githubusercontent.com/acme/tools/main/", 200, b"x" * (python_relay.MAX_BODY_BYTES + 1))
        status, _ctype, body = self.get("/v1/raw?owner=acme&repo=tools&ref=main&path=SKILL.md")
        self.assertEqual(status, 413)
        self.assertIn("1MB", body.decode("utf-8"))

    def test_bad_params_are_400(self):
        for path in ("/v1/default-branch?owner=a/../b&repo=tools",
                     "/v1/list?owner=acme&repo=tools",
                     "/v1/list?owner=acme&repo=tools&ref=../main",
                     "/v1/raw?owner=acme&repo=tools&ref=main&path=../etc/passwd",
                     "/v1/raw?owner=acme&repo=tools&ref=/main&path=SKILL.md"):
            with self.subTest(path=path):
                status, _ctype, body = self.get(path)
                self.assertEqual(status, 400, body)
                self.assertIn("不合法", body.decode("utf-8"))
        self.assertEqual(self.upstream_calls, [])            # 参数不合法不碰上游

    def test_upstream_is_whitelisted(self):
        self.stub("https://api.github.com/repos/acme/tools", 200, {"default_branch": "main"})
        self.get("/v1/default-branch?owner=acme&repo=tools")
        self.stub("https://raw.githubusercontent.com/acme/tools/main/", 200, MARKDOWN)
        self.get("/v1/raw?owner=acme&repo=tools&ref=main&path=SKILL.md")
        for url, _token in self.upstream_calls:
            host = url.split("/")[2]
            self.assertIn(host, ("api.github.com", "raw.githubusercontent.com"))
            self.assertTrue(url.startswith("https://"))

    def test_upstream_network_error_is_502(self):
        def boom(url, token):
            raise urllib.error.URLError("boom")
        with mock.patch.object(python_relay, "_fetch", side_effect=boom):
            status, _ctype, body = self.get("/v1/default-branch?owner=acme&repo=tools")
        self.assertEqual(status, 502)
        self.assertIn("无法连接 GitHub", body.decode("utf-8"))


class SecretTests(RelayCase):
    secret = "s3cret"

    def test_health_needs_no_secret(self):
        status, _ctype, _body = self.get("/v1/health")
        self.assertEqual(status, 200)

    def test_other_routes_need_matching_secret(self):
        self.stub("https://api.github.com/repos/acme/tools/git/trees/main", 200, TREE)
        status, _ctype, body = self.get("/v1/list?owner=acme&repo=tools&ref=main")
        self.assertEqual(status, 401)
        self.assertIn("unauthorized", body.decode("utf-8"))
        status, _ctype, body = self.get("/v1/list?owner=acme&repo=tools&ref=main",
                                        headers={"x-relay-token": "wrong"})
        self.assertEqual(status, 401)
        status, _ctype, body = self.get("/v1/list?owner=acme&repo=tools&ref=main",
                                        headers={"x-relay-token": "s3cret"})
        self.assertEqual(status, 200)


class TokenTests(RelayCase):
    token = "ghp_testtoken"

    def test_token_only_goes_upstream(self):
        self.stub("https://raw.githubusercontent.com/acme/tools/main/", 200, MARKDOWN)
        status, _ctype, body = self.get("/v1/raw?owner=acme&repo=tools&ref=main&path=SKILL.md")
        self.assertEqual(status, 200)
        self.assertEqual(self.upstream_calls[0][1], "ghp_testtoken")
        self.assertNotIn(b"ghp_testtoken", body)            # 响应里不能回令牌


class ValidatorTests(unittest.TestCase):

    def test_valid_name(self):
        self.assertEqual(python_relay.valid_name("acme", "owner"), "acme")
        for bad in ("", "a/b", "../x", "a b", "x" * 101):
            with self.subTest(bad=bad):
                with self.assertRaises(python_relay.BadRequest):
                    python_relay.valid_name(bad, "owner")

    def test_valid_ref(self):
        self.assertEqual(python_relay.valid_ref("feature/x"), "feature/x")
        for bad in ("", "../main", "/main", "a/../b", "x" * 256):
            with self.subTest(bad=bad):
                with self.assertRaises(python_relay.BadRequest):
                    python_relay.valid_ref(bad)

    def test_valid_path(self):
        self.assertEqual(python_relay.valid_path("skills/pdf/SKILL.md"), "skills/pdf/SKILL.md")
        for bad in ("", "../SKILL.md", "a/../b", "x" * 513, "a//b"):
            with self.subTest(bad=bad):
                with self.assertRaises(python_relay.BadRequest):
                    python_relay.valid_path(bad)


if __name__ == "__main__":
    unittest.main()
