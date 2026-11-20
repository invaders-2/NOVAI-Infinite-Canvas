# -*- coding: utf-8 -*-
"""素材按账号归属/隔离（2026-11）：认领/新库落 users/{uid}/注销清理/提示词库隔离/越权 404。"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import main  # noqa: E402
from server import asset_meta  # noqa: E402
from server.auth import tenant  # noqa: E402
from server.routes import assets as routes  # noqa: E402
from server.routes.deps import deps  # noqa: E402

PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c6360000000000200015e2b0a3d0000000049454e44ae426082")
USER_A = {"id": 101, "username": "user-a", "role": "user"}
USER_B = {"id": 202, "username": "user-b", "role": "user"}


def run(coro):
    return asyncio.run(coro)


def _library(lib_id, name, owner_id=None, items=None):
    library = {"id": lib_id, "name": name, "type": "asset", "categories": [
        {"id": "cat_%s" % lib_id, "name": "未分组", "type": "image", "items": list(items or [])},
        {"id": "wf_%s" % lib_id, "name": "工作流", "type": "workflow", "items": []},
    ]}
    if owner_id is not None:
        library["owner_id"] = owner_id
    return library


class AssetOwnershipTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-asset-owner-")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.assets = os.path.join(self.root, "assets")
        os.makedirs(os.path.join(self.assets, "uploads"), exist_ok=True)
        os.makedirs(os.path.join(self.assets, "library"), exist_ok=True)
        os.makedirs(os.path.join(self.assets, "output"), exist_ok=True)
        self.lib_path = os.path.join(self.root, "asset_library.json")
        self.owner_path = os.path.join(self.root, "asset_ownership.json")
        self.prompt_path = os.path.join(self.root, "prompt_libraries.json")
        self.canvas_dir = os.path.join(self.root, "canvases")
        os.makedirs(self.canvas_dir, exist_ok=True)
        self._patches = [
            mock.patch.object(main, "ASSET_LIBRARY_PATH", self.lib_path),
            mock.patch.object(main, "ASSET_OWNERSHIP_PATH", self.owner_path),
            mock.patch.object(main, "PROMPT_LIBRARY_PATH", self.prompt_path),
            mock.patch.object(main, "ASSET_LIBRARY_DIR", os.path.join(self.assets, "library")),
            mock.patch.object(main, "LOCAL_UPLOAD_DIR", os.path.join(self.assets, "uploads")),
            mock.patch.object(main, "OUTPUT_OUTPUT_DIR", os.path.join(self.assets, "output")),
            mock.patch.object(main, "CANVAS_DIR", self.canvas_dir),
            mock.patch.object(main, "ASSETS_DIR", self.assets),
            mock.patch.object(main, "current_tenant_user_id", return_value=None),
        ]
        for patcher in self._patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(tenant.set_assets_dir, tenant.assets_dir())
        tenant.set_assets_dir(self.assets)
        self.addCleanup(tenant.set_assets_dir, "")
        main._LEGACY_ASSET_OWNER_CACHE.clear()
        if os.path.isfile(main.ASSET_LIBRARY_PATH):
            os.remove(main.ASSET_LIBRARY_PATH)
        for path in (self.owner_path, self.prompt_path):
            if os.path.isfile(path):
                os.remove(path)

    def as_user(self, user):
        return mock.patch.object(main, "current_tenant_user_id", return_value=user["id"] if user else None)

    def seed_library(self):
        lib = main.default_asset_library()
        lib["libraries"] = [
            _library("default", "默认资产库", items=[{"id": "asset_old", "name": "旧图", "kind": "image",
                                                     "url": "/assets/library/old.png", "created_at": 1}]),
            _library("lib_team", "团队素材", items=[{"id": "asset_team", "name": "团队图", "kind": "image",
                                                    "url": "/assets/library/team.png", "created_at": 2}]),
        ]
        Path(os.path.join(self.assets, "library", "old.png")).write_bytes(PNG)
        Path(os.path.join(self.assets, "library", "team.png")).write_bytes(PNG)
        main.save_asset_library(lib)
        return lib

    def test_unlogged_sees_everything_and_owner_absent(self):
        self.seed_library()
        view = main.visible_asset_library(None)
        self.assertEqual({l["id"] for l in view["libraries"]}, {"default", "lib_team"})
        self.assertNotIn("owner_id", view["libraries"][0])

    def test_first_login_claims_and_later_account_gets_empty_library(self):
        self.seed_library()
        Path(os.path.join(self.assets, "uploads", "legacy.png")).write_bytes(PNG)
        result = main.claim_unowned_assets(USER_A)
        self.assertEqual(result["libraries"], 2)
        self.assertFalse(result["created_library"])
        marker = json.loads(Path(self.owner_path).read_text(encoding="utf-8"))
        self.assertEqual(marker["claimed_by"], USER_A["id"])
        self.assertEqual(marker["legacy_upload_owner_id"], USER_A["id"])
        view_a = main.visible_asset_library(USER_A["id"])
        self.assertEqual({l["id"] for l in view_a["libraries"]}, {"default", "lib_team"})
        self.assertTrue(all(l.get("owner_id") == USER_A["id"] for l in view_a["libraries"]))

        result_b = main.claim_unowned_assets(USER_B)
        self.assertTrue(result_b["created_library"])
        view_b = main.visible_asset_library(USER_B["id"])
        self.assertEqual([l["name"] for l in view_b["libraries"]], ["我的素材库"])
        self.assertNotIn("default", {l["id"] for l in view_b["libraries"]})

    def test_cross_account_writes_are_404(self):
        self.seed_library()
        main.claim_unowned_assets(USER_A)
        with self.as_user(USER_B):
            with self.assertRaises(main.HTTPException) as caught:
                run(routes.rename_asset_library("default", routes.AssetLibraryRenameRequest(name="hijack")))
            self.assertEqual(caught.exception.status_code, 404)
            with self.assertRaises(main.HTTPException) as caught:
                run(routes.delete_asset_library("default"))
            self.assertEqual(caught.exception.status_code, 404)
            with self.assertRaises(main.HTTPException) as caught:
                run(routes.create_asset_library_category(routes.AssetLibraryCategoryRequest(
                    name="偷建", type="image", library_id="default")))
            self.assertEqual(caught.exception.status_code, 404)
            with self.assertRaises(main.HTTPException) as caught:
                run(routes.rename_asset_library_item("asset_old", routes.AssetLibraryItemPatchRequest(name="x")))
            self.assertEqual(caught.exception.status_code, 404)
            with self.assertRaises(main.HTTPException) as caught:
                run(routes.get_asset_library_item_workflow("asset_old"))
            self.assertEqual(caught.exception.status_code, 404)

    def test_new_upload_and_library_files_go_to_user_dir(self):
        with self.as_user(USER_A):
            upload_dir = main.local_upload_dir()
            self.assertEqual(upload_dir, os.path.join(self.assets, "users", "101", "uploads"))
            url = main.store_uploaded_bytes(PNG, "a.png", "output", "a.png")
            self.assertTrue(url.startswith("/assets/users/101/output/"), url)
            output_path = main.output_path_for("a.png", "output")
            self.assertTrue(output_path.startswith(main._user_assets_root(101)))
            library_root = main.asset_library_dir()
            self.assertEqual(library_root, os.path.join(self.assets, "users", "101", "library"))
            src = os.path.join(self.root, "src.png")
            Path(src).write_bytes(PNG)
            dest_name, item = main.make_asset_library_item(src, "封面")
            self.assertEqual(item["owner_id"], 101)
            self.assertTrue(item["url"].startswith("/assets/users/101/library/"), item["url"])
            rel = urllib.parse.unquote(item["url"].split("/library/")[1])
            self.assertTrue(os.path.isfile(os.path.join(main._user_asset_library_dir(101), rel)))

    def test_claim_is_idempotent(self):
        self.seed_library()
        main.claim_unowned_assets(USER_A)
        before = json.loads(Path(self.lib_path).read_text(encoding="utf-8"))
        main.claim_unowned_assets(USER_A)
        after = json.loads(Path(self.lib_path).read_text(encoding="utf-8"))
        self.assertEqual(len(after["libraries"]), len(before["libraries"]))
        self.assertEqual({l["id"] for l in after["libraries"]}, {"default", "lib_team"})

    def test_prompt_library_isolation(self):
        data = main.default_prompt_libraries()
        data["libraries"].append({**("prompt-a" and {"id": "prompt-a", "name": "A 的提示词", "type": "prompt",
                                                     "categories": [], "items": [], "owner_id": USER_A["id"]})})
        data["libraries"].append({"id": "prompt-b", "name": "B 的提示词", "type": "prompt",
                                  "categories": [], "items": [], "owner_id": USER_B["id"]})
        main.save_prompt_libraries(data)
        view_a = main.visible_prompt_libraries(USER_A["id"])
        names = {l["id"] for l in view_a["libraries"]}
        self.assertIn("system", names)
        self.assertIn("prompt-a", names)
        self.assertNotIn("prompt-b", names)
        with self.as_user(USER_B):
            with self.assertRaises(main.HTTPException) as caught:
                run(routes.rename_prompt_library("prompt-a", routes.PromptLibraryRequest(name="hijack")))
            self.assertEqual(caught.exception.status_code, 404)
            with self.assertRaises(main.HTTPException) as caught:
                run(routes.add_prompt_library_item(routes.PromptLibraryItemRequest(
                    library_id="system", name="x", positive="x")))
            self.assertEqual(caught.exception.status_code, 404)

    def test_purge_deletes_own_only_and_keeps_machine_files(self):
        self.seed_library()
        main.claim_unowned_assets(USER_A)
        main.claim_unowned_assets(USER_B)
        os.makedirs(os.path.join(self.assets, "users", "101", "uploads"), exist_ok=True)
        Path(os.path.join(self.assets, "users", "101", "uploads", "own.png")).write_bytes(PNG)
        Path(os.path.join(self.assets, "users", "202", "uploads")).mkdir(parents=True, exist_ok=True)
        Path(os.path.join(self.assets, "users", "202", "uploads", "b.png")).write_bytes(PNG)
        legacy = Path(os.path.join(self.assets, "uploads", "legacy.png"))
        legacy.write_bytes(PNG)

        counts = main.purge_user_asset_data(USER_A["id"])
        self.assertEqual(counts["asset_libraries"], 2)
        self.assertGreaterEqual(counts["asset_files"], 1)
        self.assertFalse(os.path.exists(os.path.join(self.assets, "users", "101")))
        self.assertTrue(os.path.isfile(os.path.join(self.assets, "users", "202", "uploads", "b.png")))
        self.assertTrue(legacy.is_file())
        self.assertTrue(os.path.isfile(os.path.join(self.assets, "library", "old.png")))
        remaining = {l["id"] for l in json.loads(Path(self.lib_path).read_text(encoding="utf-8"))["libraries"]}
        self.assertNotIn("default", remaining)
        self.assertNotIn("lib_team", remaining)
        self.assertTrue(any(str(l.get("owner_id")) == str(USER_B["id"])
                            for l in json.loads(Path(self.lib_path).read_text(encoding="utf-8"))["libraries"]))

    def test_legacy_library_url_still_resolves(self):
        self.seed_library()
        main.claim_unowned_assets(USER_A)
        path = main.output_file_from_url("/assets/library/old.png")
        self.assertEqual(path, os.path.join(self.assets, "library", "old.png"))
        self.assertTrue(os.path.isfile(path))

    def test_save_asset_carries_owner_with_tenant_context(self):
        main.claim_unowned_assets(USER_A)
        src = os.path.join(self.assets, "users", "101", "output", "gen.png")
        os.makedirs(os.path.dirname(src), exist_ok=True)
        Path(src).write_bytes(PNG)
        token = tenant.bind_user(USER_A)
        try:
            with self.as_user(USER_A):
                lib, pairs, errors = routes.save_urls_to_asset_library(
                    [{"url": "/assets/users/101/output/gen.png", "name": "生成图"}])
        finally:
            tenant.reset_user(token)
        self.assertEqual(errors, [])
        self.assertEqual(len(pairs), 1)
        item = pairs[0][1]
        self.assertEqual(item.get("owner_id"), USER_A["id"])
        self.assertTrue(item.get("url", "").startswith("/assets/users/101/library/"))

    def test_owner_context_survives_async_thread(self):
        """agent 后台任务用 asyncio.to_thread / create_task 时租户 contextvar 要能带过去。"""
        main.claim_unowned_assets(USER_A)
        src = os.path.join(self.assets, "users", "101", "output", "async.png")
        os.makedirs(os.path.dirname(src), exist_ok=True)
        Path(src).write_bytes(PNG)

        async def job():
            return await asyncio.to_thread(
                lambda: routes.save_urls_to_asset_library(
                    [{"url": "/assets/users/101/output/async.png", "name": "异步图"}]))

        token = tenant.bind_user(USER_A)
        try:
            with mock.patch.object(main, "current_tenant_user_id",
                                   side_effect=lambda: tenant.current_user_id()):
                lib, pairs, errors = asyncio.run(job())
        finally:
            tenant.reset_user(token)
        self.assertEqual(errors, [])
        self.assertEqual(pairs[0][1].get("owner_id"), USER_A["id"])
        self.assertTrue(pairs[0][1].get("url", "").startswith("/assets/users/101/library/"))

    def test_canvas_assets_filtered_by_canvas_owner(self):
        for name, owner in (("canvas_a.json", USER_A["id"]), ("canvas_b.json", USER_B["id"])):
            doc = {
                "id": name[:-5], "title": name, "kind": "classic", "owner_id": owner,
                "nodes": [{"id": "n1", "kind": "image", "data": {"gen": {"hist": [{"url": "/assets/library/old.png"}]}}}],
                "connections": [],
            }
            Path(self.canvas_dir, name).write_text(json.dumps(doc), encoding="utf-8")
        with self.as_user(USER_A), mock.patch.dict(deps._bound, {
                "canvas_shared_roles_for_user": lambda uid: {}}):
            data = run(routes.list_canvas_assets())
        self.assertEqual({c["id"] for c in data["canvases"]}, {"canvas_a"})
        self.assertTrue(all(it.get("canvas_id") == "canvas_a" for it in data["items"]))


if __name__ == "__main__":
    unittest.main()
