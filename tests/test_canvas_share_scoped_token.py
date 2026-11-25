#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分享链接改用「分享令牌」的回归测试（2026-11）。

背景：以前画布分享链接里 ?token= 带的是整机局域网口令，拿到链接的人能调这台 NOVAI 的全部接口。
现在要求：
  1) 分享链接不再出现整机口令，token 位置放这条分享自己的令牌；
  2) 分享令牌只能：读这条分享的快照、读这张画布引用的 /output 媒体；别的接口 / 别的文件 / 克隆一律 401；
  3) 撤销 / 过期后立刻失效；
  4) 浏览器直接打开分享页时靠 cookie 认领范围，图片也能显示；
  5) 升级首次启动换一次整机口令（旧链接作废），旧口令只再认聊天媒体；全新安装不换；
  6) /api/lan-token/rotate 只许本机调用。

跑真实 main.app，局域网来源用 TestClient(client=("192.168.1.50", …)) 模拟；数据目录用临时目录。
用法：python tests/test_canvas_share_scoped_token.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TEMP_ROOT = tempfile.mkdtemp(prefix="novai-share-scope-")
os.environ["NOVAI_DATA_DIR"] = TEMP_ROOT
os.environ.pop("NOVAI_LAN_TOKEN", None)
os.environ["NOVAI_LAN_AUTH"] = "1"
os.environ["NOVAI_SHARE_PAGE_URL"] = "http://192.168.1.9:3000/static/canvas.html"

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from server.routes import canvas_share as share  # noqa: E402

LAN_CLIENT = ("192.168.1.50", 50123)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def _write_output(name: str) -> str:
    os.makedirs(main.OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(main.OUTPUT_DIR, name), "wb") as handle:
        handle.write(PNG)
    return "/output/" + name


class ScopedShareTokenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.local = TestClient(main.app)
        cls.remote = TestClient(main.app, client=LAN_CLIENT)
        cls.lan_token = main.load_lan_token()
        cls.in_canvas = _write_output("scope_in_canvas.png")
        cls.not_in_canvas = _write_output("scope_secret.png")
        main.save_canvas({
            "id": "scopecanvas01",
            "title": "分享范围测试",
            "nodes": [
                {"id": "n1", "type": "image", "data": {"url": cls.in_canvas}},
                {"id": "n2", "type": "image", "data": {"url": "http://192.168.1.9:3000/output/scope_in_canvas.png?token=x"}},
            ],
            "connections": [],
            "settings": {},
            "created_at": main.now_ms(),
        })
        main.save_canvas({"id": "scopecanvas02", "title": "别的画布", "nodes": [], "connections": [],
                          "settings": {}, "created_at": main.now_ms()})

    def setUp(self):
        self.remote.cookies.clear()
        share.forget_share_scope()

    def _create(self, canvas_id="scopecanvas01", permission="clone", days=7):
        response = self.local.post("/api/canvas-share", json={
            "canvas_id": canvas_id, "permission": permission, "expires_in_days": days})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["share"]

    def test_link_has_share_token_not_lan_token(self):
        link = self._create()
        url = link["url"]
        self.assertNotIn(self.lan_token, url)
        self.assertIn("share=" + link["token"], url)
        self.assertIn("token=" + link["token"], url)

    def test_scope_allows_only_snapshot_and_referenced_media(self):
        token = self._create()["token"]
        # 快照：路径里的令牌就是凭据
        self.assertEqual(self.remote.get("/api/canvas-share/" + token).status_code, 200)
        # 画布里引用的媒体：带 ?token= / X-NOVAI-Token 都行
        self.assertEqual(self.remote.get(self.in_canvas, params={"token": token}).status_code, 200)
        self.remote.cookies.clear()
        self.assertEqual(self.remote.get(self.in_canvas, headers={"X-NOVAI-Token": token}).status_code, 200)
        self.remote.cookies.clear()
        # 没引用的文件、其它接口、写接口都不行
        self.assertEqual(self.remote.get(self.not_in_canvas, params={"token": token}).status_code, 401)
        self.assertEqual(self.remote.get("/api/canvases", params={"token": token}).status_code, 401)
        self.assertEqual(self.remote.get("/api/settings", params={"token": token}).status_code, 401)
        self.assertEqual(self.remote.get("/api/canvas-share/by-canvas/scopecanvas01",
                                         params={"token": token}).status_code, 401)
        self.assertEqual(self.remote.post("/api/canvas-share/localize-media", params={"token": token},
                                          json={"urls": []}).status_code, 401)
        clone = self.remote.post("/api/canvas-share/" + token + "/clone", params={"token": token})
        self.assertEqual(clone.status_code, 401)
        self.assertIn("打开分享链接", clone.json().get("detail", ""))
        # 不会被种上整机口令 cookie
        self.assertNotIn(main.LAN_COOKIE_NAME, self.remote.cookies)

    def test_path_traversal_not_in_scope(self):
        token = self._create()["token"]
        response = self.remote.get("/output/../data/security.json", params={"token": token})
        self.assertNotEqual(response.status_code, 200)

    def test_token_of_other_share_cannot_read_this_canvas_media(self):
        other = self._create(canvas_id="scopecanvas02")["token"]
        self.assertEqual(self.remote.get(self.in_canvas, params={"token": other}).status_code, 401)

    def test_cookie_lets_browser_page_load_images(self):
        token = self._create()["token"]
        first = self.remote.get("/api/canvas-share/" + token)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(self.remote.cookies.get(share.SHARE_COOKIE_NAME), token)
        # 之后 <img src="/output/…"> 不带 query 也能取
        self.assertEqual(self.remote.get(self.in_canvas).status_code, 200)
        # cookie 不扩大范围
        self.assertEqual(self.remote.get(self.not_in_canvas).status_code, 401)
        self.assertEqual(self.remote.get("/api/canvases").status_code, 401)

    def test_revoke_and_expire_kill_access(self):
        token = self._create()["token"]
        self.assertEqual(self.remote.get(self.in_canvas, params={"token": token}).status_code, 200)
        self.assertEqual(self.local.delete("/api/canvas-share/by-canvas/scopecanvas01").status_code, 200)
        self.remote.cookies.clear()
        self.assertEqual(self.remote.get(self.in_canvas, params={"token": token}).status_code, 401)
        self.assertEqual(self.remote.get("/api/canvas-share/" + token).status_code, 404)
        token = self._create(days=1)["token"]
        with patch.object(share, "now_ms", return_value=main.now_ms() + 2 * 86400000):
            self.assertEqual(self.remote.get(self.in_canvas, params={"token": token}).status_code, 401)
            self.assertEqual(self.remote.get("/api/canvas-share/" + token).status_code, 410)

    def test_lan_token_still_full_access(self):
        self.assertEqual(self.remote.get("/api/canvases", params={"token": self.lan_token}).status_code, 200)
        self.assertEqual(self.remote.get(self.not_in_canvas, params={"token": self.lan_token}).status_code, 200)

    def test_rotate_endpoint_loopback_only(self):
        self.assertEqual(self.remote.post("/api/lan-token/rotate", params={"token": self.lan_token}).status_code, 403)


class LanTokenRotationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)
        self.security = self.data / "security.json"
        self.patches = [
            patch.object(main, "DATA_DIR", str(self.data)),
            patch.object(main, "SECURITY_FILE", str(self.security)),
            patch.object(main, "_lan_token_cache", None),
            patch.dict(os.environ, {}, clear=False),
        ]
        for item in self.patches:
            item.start()
        os.environ.pop("NOVAI_LAN_TOKEN", None)

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_upgrade_rotates_once_and_retires_old(self):
        self.security.write_text(json.dumps({"lan_token": "old-leaked-token"}), encoding="utf-8")
        self.assertTrue(main.migrate_share_scope_once())
        saved = json.loads(self.security.read_text(encoding="utf-8"))
        self.assertNotEqual(saved["lan_token"], "old-leaked-token")
        self.assertEqual(main.load_lan_token(), saved["lan_token"])
        self.assertEqual(saved["retired_lan_tokens"], ["old-leaked-token"])
        self.assertTrue(saved.get(main.SHARE_SCOPE_MIGRATION_KEY))
        self.assertFalse(main.lan_token_ok("192.168.1.5", "", "old-leaked-token", "", main.load_lan_token()))
        # 第二次启动不再换
        self.assertFalse(main.migrate_share_scope_once())
        self.assertEqual(json.loads(self.security.read_text(encoding="utf-8"))["lan_token"], saved["lan_token"])

    def test_fresh_install_marks_without_rotating(self):
        self.assertFalse(main.migrate_share_scope_once())
        token = main.load_lan_token()
        saved = json.loads(self.security.read_text(encoding="utf-8"))
        self.assertEqual(saved["lan_token"], token)
        self.assertTrue(saved.get(main.SHARE_SCOPE_MIGRATION_KEY), "生成口令时不能把迁移标记冲掉")
        self.assertEqual(main.retired_lan_tokens(), [])

    def test_env_token_never_rotated(self):
        with patch.dict(os.environ, {"NOVAI_LAN_TOKEN": "fixed-env-token"}):
            self.assertFalse(main.migrate_share_scope_once())
            self.assertEqual(main.rotate_lan_token(), "fixed-env-token")
        self.assertFalse(self.security.exists())

    def test_retired_list_is_bounded(self):
        main.load_lan_token()
        for _ in range(main.RETIRED_LAN_TOKENS_MAX + 3):
            main.rotate_lan_token()
        self.assertEqual(len(main.retired_lan_tokens()), main.RETIRED_LAN_TOKENS_MAX)
        self.assertNotIn(main.load_lan_token(), main.retired_lan_tokens())


if __name__ == "__main__":
    unittest.main(verbosity=2)
