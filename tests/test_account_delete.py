#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自助注销（2026-11）：删干净、不碰别人的数据、密码 + 账号名双重确认、
失败整体回滚、最后一个管理员 / 最后一个账号的两种处理。

跑法：venv/bin/python -m pytest -q tests/test_account_delete.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

os.environ.setdefault("NOVAI_DATA_DIR", tempfile.mkdtemp(prefix="novai-account-delete-"))
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "1000"
os.environ["NOVAI_REGISTER_GLOBAL_LIMIT"] = "1000"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import asset_acl, perms, share_links  # noqa: E402
from server.auth import api as auth_api, ratelimit, store, tenant  # noqa: E402
from server.credits import store as credit_store  # noqa: E402
from server.routes import lan_account  # noqa: E402
from server.routes.deps import deps  # noqa: E402

PASS = "delete-pass-123"
_ENV_KEYS = ("NOVAI_AUTH_ENABLED", "NOVAI_AUTH_DISABLED", "NOVAI_AUTH_MODE")


def client() -> TestClient:
    return TestClient(main.app, client=("127.0.0.1", 52000), follow_redirects=False)


class AccountDeleteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="novai-account-delete-case-")
        self._prev_data_dir = store._DATA_DIR
        self._prev_canvas_dir = auth_api._CANVAS_DIR
        self._prev_main_canvas_dir = main.CANVAS_DIR
        self._prev_deps_data_dir = deps.get("DATA_DIR", None)
        store.set_data_dir(os.path.join(self.root, "db"))
        self.canvas_dir = os.path.join(self.root, "canvases")
        os.makedirs(self.canvas_dir, exist_ok=True)
        auth_api.set_canvas_dir(self.canvas_dir)
        # 让 main 的画布接口和注销扫描用同一个临时目录，避免串到别的测试/真实数据
        main.CANVAS_DIR = self.canvas_dir
        main._CANVAS_RECORD_CACHE.clear()
        deps.bind(DATA_DIR=self.root)          # 局域网数据（lan_*.json / lan_chat）也进临时目录
        self.assets_dir = os.path.join(self.root, "assets")
        tenant.set_assets_dir(self.assets_dir)
        asset_acl.clear_cache()
        credit_store.reset_for_tests()
        for key in _ENV_KEYS:
            os.environ.pop(key, None)
        ratelimit.reset()

    def tearDown(self) -> None:
        store.set_data_dir(self._prev_data_dir)
        auth_api.set_canvas_dir(self._prev_canvas_dir)
        main.CANVAS_DIR = self._prev_main_canvas_dir
        main._CANVAS_RECORD_CACHE.clear()
        if self._prev_deps_data_dir is not None:
            deps.bind(DATA_DIR=self._prev_deps_data_dir)
        tenant.set_assets_dir("")
        credit_store.reset_for_tests()
        asset_acl.clear_cache()
        for key in _ENV_KEYS:
            os.environ.pop(key, None)

    # ------------------------------------------------------------ 小工具

    def register(self, name: str):
        c = client()
        r = c.post("/api/auth/register", json={"username": name, "password": PASS})
        self.assertEqual(r.status_code, 200, r.text)
        return c, r.json()["user"]

    def login(self, name: str):
        c = client()
        r = c.post("/api/auth/login", json={"username": name, "password": PASS})
        self.assertEqual(r.status_code, 200, r.text)
        return c

    def write_canvas(self, canvas_id: str, owner_id: int, deleted: bool = False) -> str:
        doc = {
            "id": canvas_id, "title": canvas_id, "owner_id": int(owner_id),
            "created_at": 1, "updated_at": 1, "nodes": [], "connections": [],
        }
        if deleted:
            doc["deleted_at"] = 1
        path = os.path.join(self.canvas_dir, canvas_id + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        return path

    def write_unowned_canvas(self, canvas_id: str) -> str:
        """模拟历史画布：JSON 里没有 owner_id（老版本建的画布）。"""
        doc = {"id": canvas_id, "title": canvas_id, "created_at": 1, "updated_at": 1, "nodes": [], "connections": []}
        path = os.path.join(self.canvas_dir, canvas_id + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        return path

    def promote(self, actor, user_id: int) -> None:
        r = actor.post("/api/admin/users/%d/role" % int(user_id), json={"role": "admin"})
        self.assertEqual(r.status_code, 200, r.text)

    def count(self, sql: str, params=()):
        conn = store.connect()
        try:
            return int(conn.execute(sql, params).fetchone()["n"])
        finally:
            conn.close()

    # ------------------------------------------------------------ 用例

    def test_self_delete_removes_own_data_only(self) -> None:
        a_client, a = self.register("del-a")
        self.assertEqual(a["role"], "admin")
        _b_client, b = self.register("del-b")
        self.assertEqual(b["role"], "user")

        a_path = self.write_canvas("canvas-a", a["id"])
        a_trash = self.write_canvas("canvas-a-deleted", a["id"], deleted=True)
        b_path = self.write_canvas("canvas-b", b["id"])
        perms.add_member("canvas-a", b["id"], "viewer", a["id"])      # A 的成员
        perms.add_member("canvas-b", a["id"], "editor", b["id"])      # 别人共享给 A
        share_links.upsert_link("canvas-a", a["id"], 7, None, False)

        issued = a_client.post("/api/admin/invites", json={"uses": 1, "days": 7, "role": "user"})
        self.assertEqual(issued.status_code, 200, issued.text)
        invite_code = issued.json()["code"]
        credit_store.adjust_credits(a["id"], 10, kind="admin_adjust")
        asset_root = tenant.user_asset_root(a["id"])
        os.makedirs(asset_root, exist_ok=True)
        with open(os.path.join(asset_root, "keep.png"), "wb") as fh:
            fh.write(b"x")
        b_asset_root = tenant.user_asset_root(b["id"])
        os.makedirs(b_asset_root, exist_ok=True)
        with open(os.path.join(b_asset_root, "keep-b.png"), "wb") as fh:
            fh.write(b"y")
        # 机器级旧素材：注销不删（只删账号自己的 users/{uid}）
        legacy_root = os.path.join(self.assets_dir, "uploads")
        os.makedirs(legacy_root, exist_ok=True)
        with open(os.path.join(legacy_root, "legacy.png"), "wb") as fh:
            fh.write(b"z")

        # A 是唯一管理员：先把 B 也设成管理员，否则会被「最后一个管理员」拦住
        self.promote(a_client, b["id"])

        impact = a_client.get("/api/auth/delete-account")
        self.assertEqual(impact.status_code, 200, impact.text)
        body = impact.json()
        self.assertEqual(body["counts"]["canvases"], 2)              # 含回收站
        self.assertEqual(body["counts"]["canvas_members"], 1)        # A 的画布上还有 B
        self.assertEqual(body["counts"]["shared_canvases"], 1)       # 别人共享给 A 的画布
        self.assertEqual(body["counts"]["invites"], 1)
        self.assertEqual(body["counts"]["share_links"], 1)
        self.assertGreaterEqual(body["counts"]["credit_records"], 1)
        self.assertEqual(body["counts"]["asset_files"], 1)
        self.assertEqual(body["blocked"], "")
        self.assertFalse(body["last_account"])

        # 密码不对 / 账号名不对：拒绝，而且一行都不删
        bad = a_client.post("/api/auth/delete-account", json={"password": "wrong-pass-1", "confirm_username": "del-a"})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.json()["code"], "bad_password")
        mismatch = a_client.post("/api/auth/delete-account", json={"password": PASS, "confirm_username": "del-b"})
        self.assertEqual(mismatch.status_code, 400)
        self.assertEqual(mismatch.json()["code"], "confirm_mismatch")
        self.assertIsNotNone(store.get_user_by_id(a["id"]))
        self.assertGreater(self.count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", (a["id"],)), 0)
        self.assertTrue(os.path.isfile(a_path))

        done = a_client.post("/api/auth/delete-account", json={"password": PASS, "confirm_username": "del-a"})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertFalse(done.json()["last_account"])
        self.assertEqual(done.json()["counts"]["users"], 1)

        # 账号 / 会话 / 邀请码 / 共享记录 / 分享链接 / 积分流水
        self.assertIsNone(store.get_user_by_id(a["id"]))
        self.assertIsNone(store.get_user_by_username("del-a"))
        self.assertEqual(self.count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", (a["id"],)), 0)
        self.assertIsNone(store.get_invite(invite_code))
        self.assertIsNone(perms.get_share("canvas-a", b["id"]))
        self.assertIsNone(perms.get_share("canvas-b", a["id"]))
        self.assertIsNone(share_links.get_link("canvas-a"))
        self.assertEqual(self.count("SELECT COUNT(*) AS n FROM credit_transactions WHERE user_id = ?", (a["id"],)), 0)

        # 文件：A 的画布（含回收站）与 users/{uid} 素材目录一起删；B 的画布/素材不动；机器级旧素材不删
        self.assertFalse(os.path.exists(a_path))
        self.assertFalse(os.path.exists(a_trash))
        self.assertTrue(os.path.isfile(b_path))
        self.assertFalse(os.path.exists(os.path.join(asset_root, "keep.png")))
        self.assertTrue(os.path.isfile(os.path.join(b_asset_root, "keep-b.png")))
        self.assertTrue(os.path.isfile(os.path.join(legacy_root, "legacy.png")))
        self.assertEqual([name for name in os.listdir(self.canvas_dir) if name.startswith(".account-delete-")], [])

        # B 的数据与共享仍在：还能登录，画布 owner 不变
        b_client = self.login("del-b")
        self.assertEqual(b_client.get("/api/auth/me").json()["username"], "del-b")
        with open(b_path, "r", encoding="utf-8") as fh:
            self.assertEqual(int(json.load(fh)["owner_id"]), b["id"])
        # A 登录失败；注销后旧会话立即失效
        self.assertEqual(client().post("/api/auth/login", json={"username": "del-a", "password": PASS}).status_code, 401)
        self.assertEqual(a_client.get("/api/auth/delete-account").status_code, 401)

    def test_last_admin_with_other_users_is_blocked(self) -> None:
        a_client, a = self.register("solo-admin")
        self.register("plain-user")
        canvas = self.write_canvas("solo-canvas", a["id"])

        impact = a_client.get("/api/auth/delete-account").json()
        self.assertEqual(impact["blocked"], "last_admin")
        self.assertFalse(impact["last_account"])

        r = a_client.post("/api/auth/delete-account", json={"password": PASS, "confirm_username": "solo-admin"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["code"], "last_admin")
        self.assertIsNotNone(store.get_user_by_id(a["id"]))
        self.assertTrue(os.path.isfile(canvas))

    def test_last_account_delete_returns_to_first_run(self) -> None:
        a_client, a = self.register("only-one")
        done = a_client.post("/api/auth/delete-account", json={"password": PASS, "confirm_username": "only-one"})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertTrue(done.json()["last_account"])
        cfg = client().get("/api/auth/config").json()
        self.assertFalse(cfg["has_users"])
        self.assertFalse(cfg["invite_required"])
        _c, first = self.register("after-delete")
        self.assertEqual(first["role"], "admin")

    def test_service_failure_rolls_back_canvas_files(self) -> None:
        a_client, a = self.register("rollback-a")
        _b_client, b = self.register("rollback-b")
        self.promote(a_client, b["id"])
        canvas = self.write_canvas("rollback-canvas", a["id"])

        with mock.patch.object(store, "purge_account", side_effect=sqlite3.OperationalError("boom")):
            r = a_client.post("/api/auth/delete-account", json={"password": PASS, "confirm_username": "rollback-a"})
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json()["code"], "delete_failed")

        self.assertTrue(os.path.isfile(canvas))
        self.assertIsNotNone(store.get_user_by_id(a["id"]))
        self.assertEqual(a_client.get("/api/auth/me").json()["username"], "rollback-a")
        self.assertEqual(os.listdir(self.canvas_dir), ["rollback-canvas.json"])

    def test_db_transaction_rolls_back_on_failure(self) -> None:
        a_client, a = self.register("txn-a")
        _b_client, b = self.register("txn-b")
        perms.add_member("txn-canvas", b["id"], "viewer", a["id"])

        conn = store.connect()
        try:
            conn.execute("CREATE TRIGGER no_user_delete BEFORE DELETE ON users "
                         "BEGIN SELECT RAISE(ABORT, 'blocked by test trigger'); END")
        finally:
            conn.close()
        try:
            with self.assertRaises(sqlite3.Error):
                store.purge_account(a["id"], "txn-a", [])
        finally:
            conn = store.connect()
            try:
                conn.execute("DROP TRIGGER IF EXISTS no_user_delete")
            finally:
                conn.close()

        # 事务回滚：账号、会话、共享记录一条都没少
        self.assertIsNotNone(store.get_user_by_id(a["id"]))
        self.assertGreater(self.count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", (a["id"],)), 0)
        self.assertEqual((perms.get_share("txn-canvas", b["id"]) or {}).get("role"), "viewer")


    # ------------------------------------------------------------ 默认 optional：登录即隔离 + 画布共享可用

    def test_optional_login_isolates_and_sharing_works(self) -> None:
        """新规则：登录就按账号隔离（管理员也一样）；共享后能看到/打开，未登录=本机全量。"""
        a_client, a = self.register("opt-a")
        b_client, b = self.register("opt-b")
        anon = client()

        # 未登录（本机模式）先建一张画布：没有 owner，登录时会被认领
        local_canvas = anon.post("/api/canvases", json={"title": "本机画布"}).json()["canvas"]
        with open(os.path.join(self.canvas_dir, local_canvas["id"] + ".json"), "r", encoding="utf-8") as fh:
            self.assertIsNone(json.load(fh).get("owner_id"))

        # a 登录态建画布：写 owner_id
        owned = a_client.post("/api/canvases", json={"title": "a 的画布"}).json()["canvas"]
        with open(os.path.join(self.canvas_dir, owned["id"] + ".json"), "r", encoding="utf-8") as fh:
            self.assertEqual(int(json.load(fh)["owner_id"]), int(a["id"]))

        # b 登录后只看到自己的 + 共享的：看不到 a 的画布，也看不到登录前那张（已被 a 认领）
        b_ids = [c["id"] for c in b_client.get("/api/canvases").json()["canvases"]]
        self.assertNotIn(owned["id"], b_ids)
        self.assertNotIn(local_canvas["id"], b_ids)
        self.assertEqual(b_client.get("/api/canvases/" + owned["id"]).status_code, 403)
        self.assertEqual(b_client.get("/api/canvases/" + local_canvas["id"]).status_code, 403)

        # 管理员也没有特权：a 看不到 b 的画布，?all=1 也不放大
        b_owned = b_client.post("/api/canvases", json={"title": "b 的画布"}).json()["canvas"]
        self.assertNotIn(b_owned["id"], [c["id"] for c in a_client.get("/api/canvases").json()["canvases"]])
        self.assertNotIn(b_owned["id"], [c["id"] for c in a_client.get("/api/canvases?all=1").json()["canvases"]])
        self.assertEqual(a_client.get("/api/canvases/" + b_owned["id"]).status_code, 403)

        # 未登录 = 本机模式：看到全部
        anon_ids = [c["id"] for c in anon.get("/api/canvases").json()["canvases"]]
        for canvas_id in (owned["id"], b_owned["id"], local_canvas["id"]):
            self.assertIn(canvas_id, anon_ids)

        # 共享在登录态可用：a 把画布共享给 b（viewer）
        member = a_client.post("/api/canvases/%s/members" % owned["id"], json={"username": "opt-b", "role": "viewer"})
        self.assertEqual(member.status_code, 200, member.text)
        b_ids = [c["id"] for c in b_client.get("/api/canvases").json()["canvases"]]
        self.assertIn(owned["id"], b_ids)
        self.assertEqual(b_client.get("/api/canvases/" + owned["id"]).status_code, 200)
        # viewer 不能改名；owner 可以
        self.assertEqual(b_client.post("/api/canvases/%s/meta" % owned["id"], json={"title": "改名"}).status_code, 403)
        self.assertEqual(a_client.post("/api/canvases/%s/meta" % owned["id"], json={"title": "改名"}).status_code, 200)
        # editor 可以改内容（touch），但仍不能改名
        role = a_client.patch("/api/canvases/%s/members/%d" % (owned["id"], int(b["id"])), json={"role": "editor"})
        self.assertEqual(role.status_code, 200, role.text)
        self.assertEqual(b_client.post("/api/canvases/%s/touch" % owned["id"]).status_code, 200)
        self.assertEqual(b_client.post("/api/canvases/%s/meta" % owned["id"], json={"title": "再改"}).status_code, 403)
        # 未登录不能共享
        self.assertEqual(anon.post("/api/canvases/%s/members" % owned["id"], json={"username": "opt-b", "role": "viewer"}).status_code, 403)

    def test_login_claims_unowned_canvases(self) -> None:
        """未登录建的无归属画布，登录时认领给当前账号；已有归属的不碰；每次登录都认领当次的无归属画布。"""
        anon = client()
        first = anon.post("/api/canvases", json={"title": "登录前 1"}).json()["canvas"]
        first_path = os.path.join(self.canvas_dir, first["id"] + ".json")
        self.assertIsNone(json.load(open(first_path, encoding="utf-8")).get("owner_id"))

        a_client, a = self.register("claim-a")
        self.assertEqual(int(json.load(open(first_path, encoding="utf-8"))["owner_id"]), int(a["id"]))

        # b 登录后拿不到 a 认领的画布，也不会把它抢走
        b_client, b = self.register("claim-b")
        self.assertNotIn(first["id"], [c["id"] for c in b_client.get("/api/canvases").json()["canvases"]])
        self.assertEqual(b_client.get("/api/canvases/" + first["id"]).status_code, 403)
        self.assertEqual(int(json.load(open(first_path, encoding="utf-8"))["owner_id"]), int(a["id"]))

        # 退出后（本机模式）再建一张，a 重新登录时被认领
        second = anon.post("/api/canvases", json={"title": "登录前 2"}).json()["canvas"]
        second_path = os.path.join(self.canvas_dir, second["id"] + ".json")
        self.assertIsNone(json.load(open(second_path, encoding="utf-8")).get("owner_id"))
        a_again = self.login("claim-a")
        self.assertEqual(int(json.load(open(second_path, encoding="utf-8"))["owner_id"]), int(a["id"]))
        self.assertIn(second["id"], [c["id"] for c in a_again.get("/api/canvases").json()["canvases"]])
        self.assertNotIn(second["id"], [c["id"] for c in b_client.get("/api/canvases").json()["canvases"]])

    def test_optional_delete_removes_owned_but_keeps_unowned(self) -> None:
        a_client, a = self.register("opt-del-a")
        b_client, b = self.register("opt-del-b")
        self.promote(a_client, b["id"])
        owned = a_client.post("/api/canvases", json={"title": "有主画布"}).json()["canvas"]
        owned_path = os.path.join(self.canvas_dir, owned["id"] + ".json")
        # 登录之后才出现的无归属历史画布（例如本机模式下别的进程建的）
        unowned_path = self.write_unowned_canvas("legacy-unowned")

        impact = a_client.get("/api/auth/delete-account").json()
        self.assertEqual(impact["counts"]["canvases"], 1)
        self.assertEqual(impact["counts"]["unowned_canvases"], 1)
        self.assertFalse(impact["delete_unowned"])            # 还有别的账号：无归属画布不动
        self.assertFalse(impact["last_account"])

        done = a_client.post("/api/auth/delete-account", json={"password": PASS, "confirm_username": "opt-del-a"})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertFalse(os.path.exists(owned_path))
        self.assertTrue(os.path.exists(unowned_path))         # 历史无归属画布保留
        self.assertEqual(b_client.get("/api/canvases/" + owned["id"]).status_code, 404)
        # 登录态看不到无归属画布（本机模式下才能看到）
        self.assertEqual(b_client.get("/api/canvases/legacy-unowned").status_code, 403)
        self.assertEqual(client().get("/api/canvases/legacy-unowned").status_code, 200)

    def test_optional_last_account_deletes_unowned_canvases(self) -> None:
        a_client, a = self.register("opt-only")
        unowned_path = self.write_unowned_canvas("legacy-only")
        impact = a_client.get("/api/auth/delete-account").json()
        self.assertTrue(impact["last_account"])
        self.assertTrue(impact["delete_unowned"])
        self.assertEqual(impact["counts"]["unowned_canvases"], 1)
        done = a_client.post("/api/auth/delete-account", json={"password": PASS, "confirm_username": "opt-only"})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertTrue(done.json()["last_account"])
        self.assertFalse(os.path.exists(unowned_path))


    def test_required_mode_keeps_isolation_and_sharing(self) -> None:
        """required 模式回归：隔离、共享、注销都不变。"""
        os.environ["NOVAI_AUTH_MODE"] = "required"
        a_client, a = self.register("req-a")
        b_client, b = self.register("req-b")
        created = a_client.post("/api/canvases", json={"title": "required 画布"})
        self.assertEqual(created.status_code, 200, created.text)
        canvas = created.json()["canvas"]
        path = os.path.join(self.canvas_dir, canvas["id"] + ".json")
        with open(path, "r", encoding="utf-8") as fh:
            self.assertEqual(int(json.load(fh)["owner_id"]), int(a["id"]))

        self.assertEqual(client().get("/api/canvases").status_code, 401)
        bob_ids = [c["id"] for c in b_client.get("/api/canvases").json()["canvases"]]
        self.assertNotIn(canvas["id"], bob_ids)
        self.assertEqual(b_client.get("/api/canvases/" + canvas["id"]).status_code, 403)
        member = a_client.post("/api/canvases/%s/members" % canvas["id"], json={"username": "req-b", "role": "viewer"})
        self.assertEqual(member.status_code, 200, member.text)
        self.assertEqual(b_client.get("/api/canvases/" + canvas["id"]).status_code, 200)

        self.promote(a_client, b["id"])
        done = a_client.post("/api/auth/delete-account", json={"password": PASS, "confirm_username": "req-a"})
        self.assertEqual(done.status_code, 200, done.text)
        self.assertIsNone(store.get_user_by_id(a["id"]))
        self.assertEqual(b_client.get("/api/canvases/" + canvas["id"]).status_code, 404)

    def test_delete_removes_only_own_lan_bucket(self) -> None:
        """局域网数据按账号分桶：只删自己那桶，别人的桶不动。"""
        a_client, a = self.register("lan-a")
        _b_client, b = self.register("lan-b")
        self.promote(a_client, b["id"])
        friend_id = "feedface1234"
        keys = {"u%d" % int(a["id"]): a["id"], "u%d" % int(b["id"]): b["id"]}
        for key in keys:
            lan_account.load_account(owner=key)
            lan_account.save_friends([{"id": friend_id, "nickname": "好友", "avatar": "🙂"}], owner=key)
            chat_file = lan_account.chat_path(friend_id, owner=key)
            os.makedirs(os.path.dirname(chat_file), exist_ok=True)
            with open(chat_file, "w", encoding="utf-8") as fh:
                json.dump({"version": lan_account.SCHEMA_VERSION, "friend_id": friend_id,
                           "messages": [{"id": "m1", "kind": "text", "text": "hi", "ts": 1}]}, fh)

        impact = a_client.get("/api/auth/delete-account").json()["counts"]
        self.assertEqual(impact["lan_account"], 1)
        self.assertEqual(impact["lan_friends"], 1)
        self.assertEqual(impact["lan_chat_messages"], 1)

        done = a_client.post("/api/auth/delete-account", json={"password": PASS, "confirm_username": "lan-a"})
        self.assertEqual(done.status_code, 200, done.text)
        removed = done.json()["counts"]
        self.assertEqual(removed["lan_accounts_removed"], 1)
        self.assertEqual(removed["lan_friends_removed"], 1)
        self.assertEqual(removed["lan_chats_removed"], 1)
        key_a, key_b = "u%d" % int(a["id"]), "u%d" % int(b["id"])
        self.assertNotIn(key_a, lan_account.load_accounts())
        self.assertIn(key_b, lan_account.load_accounts())
        self.assertEqual(lan_account.load_friends(owner=key_a), [])
        self.assertEqual(len(lan_account.load_friends(owner=key_b)), 1)
        self.assertFalse(os.path.isdir(os.path.join(self.root, lan_account.CHAT_DIR, key_a)))
        self.assertTrue(os.path.isfile(lan_account.chat_path(friend_id, owner=key_b)))

    def test_optional_assets_stay_public_but_required_requires_login(self) -> None:
        """素材隔离只在 required：optional 下 /assets/users/{uid}/ 不被登录拦截（原行为）。"""
        anon = client()
        self.assertEqual(anon.get("/assets/users/1/uploads/nope.png").status_code, 404)
        os.environ["NOVAI_AUTH_MODE"] = "required"
        self.assertEqual(client().get("/assets/users/1/uploads/nope.png").status_code, 401)

    def test_required_lan_middleware_keeps_peer_delivery_open(self) -> None:
        """required 模式：好友机投递接口只认口令，不能被会话 401 拦掉；其它 LAN 接口仍要登录。"""
        os.environ["NOVAI_AUTH_MODE"] = "required"
        anon = client()
        self.assertEqual(anon.get("/api/lan/ping").status_code, 200)
        self.assertEqual(anon.get("/api/lan/me").status_code, 401)
        posted = anon.post("/api/lan/messages", json={})
        body = posted.json() if posted.headers.get("content-type", "").startswith("application/json") else {}
        self.assertFalse(posted.status_code == 401 and body.get("code") == "unauthorized",
                         (posted.status_code, posted.text))

    def test_requires_login(self) -> None:
        self.assertEqual(client().get("/api/auth/delete-account").status_code, 401)
        r = client().post("/api/auth/delete-account", json={"password": "x", "confirm_username": "x"})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["code"], "unauthorized")


if __name__ == "__main__":
    unittest.main(verbosity=2)