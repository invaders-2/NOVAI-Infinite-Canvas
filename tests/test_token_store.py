# -*- coding: utf-8 -*-
"""GitHub 令牌存储：env 优先、0600 权限、保留其它键、掩码规则（/tmp 隔离）。"""
import contextlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.skills import token_store  # noqa: E402

GOOD_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
OTHER_TOKEN = "github_pat_11ABCDEFG0123456789_zyxw"


@contextlib.contextmanager
def token_env(data_dir=None, **extra):
    """清掉令牌相关环境变量，必要时指定独立数据目录。"""
    env = {k: v for k, v in os.environ.items()
           if k not in ("NOVAI_GITHUB_TOKEN", "GITHUB_TOKEN", "NOVAI_DATA_DIR",
                         "NOVAI_GITHUB_RELAY", "NOVAI_GITHUB_RELAY_TOKEN")}
    if data_dir is not None:
        env["NOVAI_DATA_DIR"] = data_dir
    env.update(extra)
    with mock.patch.dict(os.environ, env, clear=True):
        yield


class TokenStoreCase(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-token-store-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def path(self):
        return os.path.join(self.root, "config.json")

    def write_config(self, data):
        with open(self.path(), "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)

    def read_config(self):
        with open(self.path(), "r", encoding="utf-8") as fh:
            return json.load(fh)

    def mode(self):
        return stat.S_IMODE(os.stat(self.path()).st_mode)


class ConfigFileTests(TokenStoreCase):

    def test_config_file_follows_data_dir(self):
        with token_env("/tmp/novai-token-demo"):
            self.assertEqual(token_store.config_file(), "/tmp/novai-token-demo/config.json")

    def test_config_file_defaults_to_home_novai(self):
        with token_env():
            self.assertEqual(token_store.config_file(),
                             os.path.join(os.path.expanduser("~/.NOVAI"), "config.json"))


class SavedTokenTests(TokenStoreCase):

    def test_missing_file_means_no_token(self):
        with token_env(self.root):
            self.assertEqual(token_store.saved_token(), "")
            self.assertEqual(token_store.active_token(), "")
            self.assertEqual(token_store.token_source(), "")

    def test_bad_json_means_no_token(self):
        with open(self.path(), "w", encoding="utf-8") as fh:
            fh.write("{not json")
        with token_env(self.root):
            self.assertEqual(token_store.saved_token(), "")
            self.assertEqual(token_store.token_source(), "")

    def test_non_string_value_means_no_token(self):
        self.write_config({"github_token": 12345, "storage_path": "/data"})
        with token_env(self.root):
            self.assertEqual(token_store.saved_token(), "")

    def test_saved_token_is_stripped(self):
        self.write_config({"github_token": "  %s  " % GOOD_TOKEN})
        with token_env(self.root):
            self.assertEqual(token_store.saved_token(), GOOD_TOKEN)
            self.assertEqual(token_store.token_source(), "settings")

    def test_env_wins_over_saved_token(self):
        self.write_config({"github_token": GOOD_TOKEN})
        with token_env(self.root, NOVAI_GITHUB_TOKEN=OTHER_TOKEN):
            self.assertEqual(token_store.active_token(), OTHER_TOKEN)
            self.assertEqual(token_store.token_source(), "env")
        with token_env(self.root, GITHUB_TOKEN=OTHER_TOKEN):
            self.assertEqual(token_store.active_token(), OTHER_TOKEN)
            self.assertEqual(token_store.token_source(), "env")
        with token_env(self.root):
            self.assertEqual(token_store.active_token(), GOOD_TOKEN)
            self.assertEqual(token_store.token_source(), "settings")


class SaveTokenTests(TokenStoreCase):

    def test_save_writes_0600_and_keeps_other_keys(self):
        self.write_config({"storage_path": "/data/novai", "theme": "dark"})
        with token_env(self.root):
            token_store.save_token(GOOD_TOKEN)
            self.assertEqual(token_store.saved_token(), GOOD_TOKEN)
        data = self.read_config()
        self.assertEqual(data["github_token"], GOOD_TOKEN)
        self.assertEqual(data["storage_path"], "/data/novai")
        self.assertEqual(data["theme"], "dark")
        self.assertEqual(self.mode(), 0o600)

    def test_save_creates_missing_directory(self):
        target = os.path.join(self.root, "nested", "dir")
        with token_env(target):
            token_store.save_token(GOOD_TOKEN)
            self.assertTrue(os.path.isfile(os.path.join(target, "config.json")))

    def test_save_leaves_no_temp_file(self):
        with token_env(self.root):
            token_store.save_token(GOOD_TOKEN)
        leftovers = [name for name in os.listdir(self.root) if name != "config.json"]
        self.assertEqual(leftovers, [])

    def test_save_strips_whitespace(self):
        with token_env(self.root):
            self.assertEqual(token_store.save_token("  %s\n" % GOOD_TOKEN), GOOD_TOKEN)

    def test_invalid_tokens_are_rejected(self):
        bad_tokens = ("", "   ", "short", "ghp_" + "a" * 300,
                      "ghp_abcdefghij klmnopqrstuvwxyz", "ghp_abcdefghijklm点nopqrstuvwxyz",
                      GOOD_TOKEN[:19])
        with token_env(self.root):
            for token in bad_tokens:
                with self.subTest(token=token[:24]):
                    with self.assertRaises(ValueError):
                        token_store.save_token(token)
            self.assertEqual(token_store.saved_token(), "")

    def test_prefix_is_advice_not_a_rule(self):
        with token_env(self.root):
            saved = token_store.save_token("abcdefghijklmnopqrstuvwxyz")
            self.assertEqual(saved, "abcdefghijklmnopqrstuvwxyz")


class ClearTokenTests(TokenStoreCase):

    def test_clear_removes_only_the_token(self):
        self.write_config({"github_token": GOOD_TOKEN, "storage_path": "/data"})
        with token_env(self.root):
            self.assertTrue(token_store.clear_token())
            self.assertEqual(token_store.saved_token(), "")
            self.assertEqual(token_store.token_source(), "")
        data = self.read_config()
        self.assertNotIn("github_token", data)
        self.assertEqual(data["storage_path"], "/data")

    def test_clear_without_token_is_noop(self):
        self.write_config({"storage_path": "/data"})
        with token_env(self.root):
            self.assertFalse(token_store.clear_token())
        self.assertEqual(self.read_config(), {"storage_path": "/data"})

    def test_clear_missing_file_is_noop(self):
        with token_env(self.root):
            self.assertFalse(token_store.clear_token())
            self.assertFalse(os.path.exists(self.path()))


class MaskTests(unittest.TestCase):

    def test_long_token_shows_four_and_four(self):
        self.assertEqual(token_store.mask(GOOD_TOKEN), GOOD_TOKEN[:4] + "…" + GOOD_TOKEN[-4:])

    def test_exactly_twelve_chars(self):
        token = "abcdefghijkl"
        self.assertEqual(token_store.mask(token), "abcd…ijkl")

    def test_short_token_shows_two(self):
        self.assertEqual(token_store.mask("abcdefghijk"), "ab…")

    def test_empty_token_is_empty(self):
        self.assertEqual(token_store.mask(""), "")
        self.assertEqual(token_store.mask(None), "")

    def test_mask_never_returns_whole_token(self):
        for token in (GOOD_TOKEN, "abcdefghijkl", "abc"):
            with self.subTest(token=token):
                self.assertNotEqual(token_store.mask(token), token)


class PublicStateTests(TokenStoreCase):

    def test_state_has_no_plaintext(self):
        with token_env(self.root):
            token_store.save_token(GOOD_TOKEN)
            state = token_store.public_state()
            self.assertEqual(state["source"], "settings")
            self.assertTrue(state["configured"])
            self.assertNotIn(GOOD_TOKEN, json.dumps(state))
            self.assertEqual(state["masked"], token_store.mask(GOOD_TOKEN))




class RelayConfigTests(TokenStoreCase):

    def test_normalize_accepts_https_and_local_http(self):
        self.assertEqual(token_store.normalize_relay_url("https://relay.example.com/"),
                         "https://relay.example.com")
        self.assertEqual(token_store.normalize_relay_url("http://127.0.0.1:4180"),
                         "http://127.0.0.1:4180")
        self.assertEqual(token_store.normalize_relay_url("http://localhost:4180/"),
                         "http://localhost:4180")

    def test_normalize_rejects_plain_http_and_bad_values(self):
        for value in ("", "   ", "http://relay.example.com", "relay.example.com",
                      "ftp://relay.example.com", "https://user:pass@relay.example.com",
                      "https://relay.example.com/" + "a" * 500):
            with self.subTest(value=str(value)[:40]):
                with self.assertRaises(ValueError):
                    token_store.normalize_relay_url(value)

    def test_env_wins_over_saved_relay(self):
        with token_env(self.root):
            token_store.save_relay("https://saved.example.com", "saved-secret")
            self.assertEqual(token_store.relay_url(), "https://saved.example.com")
            self.assertEqual(token_store.relay_source(), "settings")
        with token_env(self.root, NOVAI_GITHUB_RELAY="https://env.example.com",
                       NOVAI_GITHUB_RELAY_TOKEN="env-secret"):
            self.assertEqual(token_store.relay_url(), "https://env.example.com")
            self.assertEqual(token_store.relay_secret(), "env-secret")
            self.assertEqual(token_store.relay_source(), "env")

    def test_invalid_env_relay_is_ignored(self):
        with token_env(self.root, NOVAI_GITHUB_RELAY="http://relay.example.com"):
            self.assertEqual(token_store.relay_url(), "")
            self.assertFalse(token_store.relay_state()["configured"])

    def test_save_relay_persists_and_masks(self):
        self.write_config({"storage_path": "/data"})
        with token_env(self.root):
            state = token_store.save_relay("https://relay.example.com/", "s3cret-token-123")
            self.assertTrue(state["configured"])
            self.assertEqual(state["url"], "https://relay.example.com")
            self.assertEqual(state["masked_secret"], token_store.mask("s3cret-token-123"))
            self.assertNotIn("s3cret-token-123", json.dumps(state))
        data = self.read_config()
        self.assertEqual(data[token_store.RELAY_KEY], "https://relay.example.com")
        self.assertEqual(data[token_store.RELAY_SECRET_KEY], "s3cret-token-123")
        self.assertEqual(data["storage_path"], "/data")
        self.assertEqual(self.mode(), 0o600)

    def test_save_relay_without_secret_keeps_old_one(self):
        with token_env(self.root):
            token_store.save_relay("https://a.example.com", "keep-me")
            token_store.save_relay("https://b.example.com")
            self.assertEqual(token_store.relay_url(), "https://b.example.com")
            self.assertEqual(token_store.relay_secret(), "keep-me")
            token_store.save_relay("https://c.example.com", "")
            self.assertEqual(token_store.relay_secret(), "")

    def test_save_relay_rejects_bad_secret(self):
        with token_env(self.root):
            with self.assertRaises(ValueError):
                token_store.save_relay("https://a.example.com", "has space")
            self.assertEqual(token_store.relay_url(), "")

    def test_clear_relay_removes_both_keys(self):
        self.write_config({"storage_path": "/data"})
        with token_env(self.root):
            token_store.save_relay("https://a.example.com", "s3cret")
            self.assertTrue(token_store.clear_relay())
            self.assertEqual(token_store.relay_url(), "")
            self.assertEqual(token_store.relay_secret(), "")
        data = self.read_config()
        self.assertNotIn(token_store.RELAY_KEY, data)
        self.assertNotIn(token_store.RELAY_SECRET_KEY, data)
        self.assertEqual(data["storage_path"], "/data")

    def test_clear_relay_without_config_is_noop(self):
        with token_env(self.root):
            self.assertFalse(token_store.clear_relay())
            self.assertFalse(os.path.exists(self.path()))

    def test_saved_relay_with_bad_url_is_ignored(self):
        self.write_config({"github_relay": "http://relay.example.com"})
        with token_env(self.root):
            self.assertEqual(token_store.relay_url(), "")
            self.assertEqual(token_store.relay_source(), "")


class GitIgnoreTests(unittest.TestCase):
    """令牌落盘的 config.json 不能被 git 跟踪：它是本地配置，不该进仓库/安装包。"""

    def test_config_json_is_git_ignored_and_untracked(self):
        root = Path(__file__).resolve().parents[1]
        try:
            probe = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   encoding="utf-8", timeout=10)
        except (OSError, subprocess.SubprocessError):
            self.skipTest("git 不可用")
        if probe.returncode != 0:
            self.skipTest("不在 git 仓库里")
        toplevel = (probe.stdout or "").strip()
        with token_env(str(root)):
            path = token_store.config_file()
        self.assertEqual(os.path.realpath(path),
                         os.path.realpath(os.path.join(toplevel, "config.json")))
        ignore = subprocess.run(["git", "-C", str(root), "check-ignore", "-v", path],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                encoding="utf-8", timeout=10)
        self.assertEqual(ignore.returncode, 0,
                         "config.json 没有被 .gitignore 覆盖：%s" % (ignore.stderr or ""))
        self.assertIn("config.json", ignore.stdout or "")
        tracked = subprocess.run(["git", "-C", str(root), "ls-files", "--error-unmatch", "config.json"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 encoding="utf-8", timeout=10)
        self.assertNotEqual(tracked.returncode, 0, "config.json 已被 git 跟踪，需要从索引里移除")


if __name__ == "__main__":
    unittest.main()
