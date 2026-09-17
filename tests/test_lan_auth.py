import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class LanAuthPureFunctionTests(unittest.TestCase):
    def test_loopback_hosts(self):
        for host in ("127.0.0.1", "127.0.0.2", "::1", "localhost", "LocalHost", "testclient"):
            self.assertTrue(main.is_loopback_host(host), host)
        for host in ("192.168.1.5", "10.0.0.7", "", None, "0.0.0.0"):
            self.assertFalse(main.is_loopback_host(host), repr(host))

    def test_loopback_always_allowed(self):
        self.assertTrue(main.lan_token_ok("127.0.0.1", "", "", "", "secret"))
        self.assertTrue(main.lan_token_ok("testclient", "", "", "", "secret"))

    def test_non_loopback_requires_token(self):
        self.assertFalse(main.lan_token_ok("192.168.1.5", "", "", "", "secret"))
        self.assertFalse(main.lan_token_ok("192.168.1.5", "wrong", "", "", "secret"))
        self.assertFalse(main.lan_token_ok("192.168.1.5", "", "wrong", "", "secret"))

    def test_token_from_each_channel(self):
        self.assertTrue(main.lan_token_ok("192.168.1.5", "secret", "", "", "secret"))
        self.assertTrue(main.lan_token_ok("192.168.1.5", "", "secret", "", "secret"))
        self.assertTrue(main.lan_token_ok("192.168.1.5", "", "", "secret", "secret"))

    def test_no_expected_token_denies_non_loopback(self):
        self.assertFalse(main.lan_token_ok("192.168.1.5", "x", "x", "x", ""))

    def test_none_client_treated_as_non_loopback(self):
        self.assertFalse(main.lan_token_ok(None, "", "", "", "secret"))

    def test_disabled_allows_everything(self):
        self.assertTrue(main.lan_token_ok("192.168.1.5", "", "", "", "secret", auth_enabled=False))

    def test_auth_enabled_env(self):
        with patch.dict(os.environ, {"NOVAI_LAN_AUTH": "0"}):
            self.assertFalse(main.lan_auth_enabled())
        for value in ("1", "true", "yes", ""):
            with patch.dict(os.environ, {"NOVAI_LAN_AUTH": value}):
                self.assertTrue(main.lan_auth_enabled(), value)

    def test_public_paths(self):
        # 只有静态外壳放行
        for path in ("/", "/index.html", "/static/index.html", "/static/js/smart-canvas.js", "/static/css/smart-canvas.css"):
            self.assertTrue(main.lan_path_public_for_unauthenticated(path, "GET"), path)
            self.assertTrue(main.lan_path_public_for_unauthenticated(path, "HEAD"), path)
        # 用户数据挂载点 / 应用资源 / API / 写接口都不放行
        for path in ("/api/canvases", "/assets/output/x.png", "/assets/models/a.onnx", "/output/x.mp4", "/apps/foo/manifest.json", "/generate"):
            self.assertFalse(main.lan_path_public_for_unauthenticated(path, "GET"), path)
        self.assertFalse(main.lan_path_public_for_unauthenticated("/", "POST"), "POST / 不该放行")
        self.assertFalse(main.lan_path_public_for_unauthenticated("/static/index.html", "POST"), "POST 静态资源不该放行")


class LanTokenStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name) / "data"
        self.data.mkdir(parents=True, exist_ok=True)
        self.security = self.data / "security.json"
        self.patches = [
            patch.object(main, "DATA_DIR", str(self.data)),
            patch.object(main, "SECURITY_FILE", str(self.security)),
            patch.object(main, "_lan_token_cache", None),
        ]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_creates_and_reuses(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NOVAI_LAN_TOKEN", None)
            token = main.load_lan_token()
            self.assertTrue(token and len(token) >= 16, token)
            self.assertTrue(self.security.is_file())
            saved = json.loads(self.security.read_text(encoding="utf-8"))
            self.assertEqual(saved["lan_token"], token)
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(os.stat(self.security).st_mode), 0o600)
            main._lan_token_cache = None
            self.assertEqual(main.load_lan_token(), token)

    def test_env_override(self):
        with patch.dict(os.environ, {"NOVAI_LAN_TOKEN": "env-token"}):
            self.assertEqual(main.load_lan_token(), "env-token")
            self.assertFalse(self.security.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
