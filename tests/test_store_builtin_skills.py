# -*- coding: utf-8 -*-
"""应用市场并入内置技能 + 「添加到助手」真正写进技能注册表。

覆盖：
  1. catalog：83 条市场条目之外并入注册表的系统 / 内置技能（builtin=true、installed=true、计数自洽）；
  2. 去重：同名条目整条以注册表为准，不会出现两条；
  3. 容错：注册表读取异常时 catalog / 详情照常返回（内置技能本次缺席），不 500；
  4. 详情：内置技能返回 {item, detail}，正文标记来自注册表；
  5. install：市场技能写进 <DATA_DIR>/skills/<id>.json，/api/skills 立刻能看到、能导出；uninstall 后消失；
  6. 不误删用户自有技能：同名用户技能不被覆盖，卸载也不会删它；
  7. 内置技能 install 幂等返回 {installed:true, builtin:true}，DELETE 不会真的卸掉。

用临时数据目录（NOVAI_DATA_DIR）隔离，不碰日常数据。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-store-builtin-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main
from server.routes import store

# 2026-11-07：仓库里的应用市场只保留内置技能，上游 83 条快照挪到 tests/fixtures/store_upstream，
# 这些测试仍然针对那份快照验证目录 / 详情 / 安装逻辑。
_FIXTURE_STORE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "store_upstream")
_ORIG_STORE_DIR = store.store_dir
_store_dir_patch = None


def setUpModule():
    global _store_dir_patch
    _store_dir_patch = patch.object(store, "store_dir", return_value=_FIXTURE_STORE)
    _store_dir_patch.start()


def tearDownModule():
    if _store_dir_patch:
        _store_dir_patch.stop()

from server.skills import registry as skills_registry

BUILTIN_ID = "fashion-editorial"
BUILTIN_DISPLAY = "服装大片 · 胶片暗房"
MARKET_SKILL = "trending-recast-gallery"


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def client():
    return TestClient(main.app)


def builtin_count():
    return len(store.load_builtin_skills())


def skill_file(skill_id):
    return os.path.join(skills_registry.skills_dir(), "%s.json" % skill_id)


def read_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


class CatalogBuiltinSkillTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        store.save_installed([])
        self.data = self.c.get("/api/store/catalog").json()

    def test_market_items_are_untouched_plus_builtin(self):
        items = self.data["items"]
        market = [item for item in items if not item.get("builtin")]
        builtin = [item for item in items if item.get("builtin")]
        self.assertEqual(len(market), 83)
        self.assertEqual(len(builtin), builtin_count())
        self.assertEqual(self.data["counts"], {"all": 83 + builtin_count(),
                                              "skill": 60 + builtin_count(),
                                              "app": 23})
        self.assertEqual(len(builtin), len({item["name"] for item in builtin}))
        for item in builtin:
            self.assertEqual(item["kind"], "skill")
            self.assertTrue(item["display_name"])
            self.assertTrue(item["installed"])
            self.assertTrue(item["store_visible"])
            self.assertTrue(item["store_available"])
            self.assertTrue(item["enabled"])
            self.assertEqual(item["cover_url"], "")

    def test_builtin_skills_are_in_visible_counts(self):
        visible = [item for item in self.data["items"] if item["store_visible"]]
        self.assertEqual(self.data["visible_counts"],
                         {"all": 20 + builtin_count(), "skill": 20 + builtin_count(), "app": 0})
        self.assertEqual(self.data["visible_counts"]["all"], len(visible))
        self.assertTrue(any(item.get("builtin") for item in visible))

    def test_clothing_editorial_is_listed(self):
        found = [item for item in self.data["items"] if item["name"] == BUILTIN_ID]
        self.assertEqual(len(found), 1)
        item = found[0]
        self.assertTrue(item["builtin"])
        self.assertEqual(item["display_name"], BUILTIN_DISPLAY)
        self.assertIn("服装", item["description"])
        self.assertEqual(item["category"], "服装大片")
        self.assertTrue(item["marketing_line"])

    def test_registry_failure_does_not_break_catalog(self):
        with patch.object(store.skills_registry, "load_skills", side_effect=RuntimeError("boom")):
            resp = self.c.get("/api/store/catalog")
        self.assertEqual(resp.status_code, 200)
        items = resp.json()["items"]
        self.assertEqual(len(items), 83)
        self.assertFalse([item for item in items if item.get("builtin")])
        with patch.object(store.skills_registry, "load_skills", side_effect=RuntimeError("boom")):
            self.assertEqual(self.c.get("/api/store/items/skill/%s" % BUILTIN_ID).status_code, 404)

    def test_dedupe_prefers_registry(self):
        fake = {"id": "3d-studio", "name": "三维空间（注册表版）", "category": "官方技能",
                "description": "注册表里的同 id 技能", "tags": [], "skill_type": "system",
                "builtin_pack": "fake-pack", "skill_prompt": "正文", "enabled": True, "available": True}
        with patch.object(store, "load_builtin_skills", return_value=[fake]):
            items = self.c.get("/api/store/catalog").json()["items"]
        matched = [item for item in items if item["kind"] == "skill" and item["name"] == "3d-studio"]
        self.assertEqual(len(matched), 1, "同 id 的内置技能不能和市场条目重复")
        self.assertTrue(matched[0]["builtin"])
        self.assertEqual(matched[0]["display_name"], "三维空间（注册表版）")
        self.assertEqual(len(items), 83)          # 替换而不是追加：去重后总数不变


class BuiltinSkillDetailTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        store.save_installed([])

    def test_detail_returns_item_and_registry_meta(self):
        body = self.c.get("/api/store/items/skill/%s" % BUILTIN_ID).json()
        self.assertEqual(set(body), {"item", "detail"})
        item = body["item"]
        self.assertTrue(item["builtin"])
        self.assertEqual(item["display_name"], BUILTIN_DISPLAY)
        self.assertTrue(item["installed"])
        self.assertTrue(item["has_skill_body"])
        self.assertGreater(item["skill_body_chars"], 100)
        self.assertEqual(item["skill_body_source"], "registry")
        self.assertEqual(item["skill_export_url"], "/api/skills/%s/export" % BUILTIN_ID)
        self.assertEqual(body["detail"], item)

    def test_market_detail_has_no_detail_alias(self):
        body = self.c.get("/api/store/items/skill/%s" % MARKET_SKILL).json()
        self.assertEqual(set(body), {"item"})


class InstallRegistersSkillTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        store.save_installed([])
        self._cleanup()

    def tearDown(self):
        self._cleanup()

    def _cleanup(self):
        for path in (skill_file(MARKET_SKILL), skill_file("store-own-skill")):
            if os.path.isfile(path):
                os.remove(path)
        try:
            self.c.delete("/api/store/items/skill/%s/install" % MARKET_SKILL)
        except Exception:
            pass
        store.save_installed([])

    def _skills(self):
        return {skill["id"]: skill for skill in self.c.get("/api/skills").json()["skills"]}

    def test_install_writes_skill_and_uninstall_removes_it(self):
        url = "/api/store/items/skill/%s/install" % MARKET_SKILL
        self.assertEqual(self.c.post(url).json(), {"installed": True})
        self.assertIn("skill:%s" % MARKET_SKILL, store.load_installed())
        path = skill_file(MARKET_SKILL)
        self.assertTrue(os.path.isfile(path))
        raw = read_json(path)
        self.assertEqual(raw["id"], MARKET_SKILL)
        self.assertEqual(raw["store_ref"], "skill:%s" % MARKET_SKILL)
        self.assertEqual(raw["skill_type"], "mine")
        self.assertTrue(raw["enabled"])
        self.assertGreater(len(raw["skill_prompt"]), 1000)      # 手册正文一起带过去

        listed = self._skills().get(MARKET_SKILL)
        self.assertIsNotNone(listed)
        self.assertEqual(listed["skill_type"], "mine")
        self.assertEqual(self.c.get("/api/skills/%s/export" % MARKET_SKILL).status_code, 200)

        self.assertEqual(self.c.delete(url).json(), {"installed": False})
        self.assertFalse(os.path.isfile(path))
        self.assertNotIn(MARKET_SKILL, self._skills())
        self.assertEqual(store.load_installed(), [])

    def test_user_own_skill_with_same_name_is_not_overwritten_or_deleted(self):
        path = skill_file(MARKET_SKILL)
        own = {"id": MARKET_SKILL, "name": "我自己的技能", "category": "我的技能",
               "description": "用户自己写的", "skill_prompt": "用户正文", "enabled": True,
               "available": True, "skill_type": "mine"}
        write_json(path, own)
        url = "/api/store/items/skill/%s/install" % MARKET_SKILL
        body = self.c.post(url).json()
        self.assertEqual(body["installed"], True)
        self.assertTrue(body.get("skill_message"))              # 明确告诉调用方没覆盖
        self.assertEqual(read_json(path), own)
        self.assertEqual(self.c.delete(url).json(), {"installed": False})
        self.assertEqual(read_json(path), own)                  # 卸载也不删用户技能
        self.assertIn(MARKET_SKILL, self._skills())

    def test_uninstall_keeps_other_user_skills(self):
        other = skill_file("store-own-skill")
        write_json(other, {"id": "store-own-skill", "name": "另一个自有技能", "category": "我的技能",
                           "description": "x", "skill_prompt": "y", "enabled": True,
                           "available": True, "skill_type": "mine"})
        url = "/api/store/items/skill/%s/install" % MARKET_SKILL
        self.c.post(url)
        self.c.delete(url)
        self.assertTrue(os.path.isfile(other))

    def test_install_is_idempotent(self):
        url = "/api/store/items/skill/%s/install" % MARKET_SKILL
        self.assertEqual(self.c.post(url).json(), {"installed": True})
        self.assertEqual(self.c.post(url).json(), {"installed": True})
        self.assertEqual(store.load_installed(), ["skill:%s" % MARKET_SKILL])

    def test_register_failure_returns_readable_error_and_keeps_skills_working(self):
        url = "/api/store/items/skill/%s/install" % MARKET_SKILL
        with patch.object(store, "register_market_skill", side_effect=OSError("磁盘只读")):
            resp = self.c.post(url)
        self.assertEqual(resp.status_code, 500)
        self.assertIn("导入画布助手失败", resp.json()["detail"])
        self.assertEqual(store.load_installed(), [])            # 失败时不记安装态
        self.assertEqual(self.c.get("/api/skills").status_code, 200)


class BuiltinSkillInstallTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        store.save_installed([])

    def test_install_is_idempotent_and_stays_installed(self):
        url = "/api/store/items/skill/%s/install" % BUILTIN_ID
        self.assertEqual(self.c.post(url).json(), {"installed": True, "builtin": True})
        self.assertEqual(self.c.post(url).json(), {"installed": True, "builtin": True})
        self.assertEqual(store.load_installed(), [])            # 内置技能不写安装记录
        self.assertEqual(self.c.delete(url).json(), {"installed": True, "builtin": True})
        self.assertIn(BUILTIN_ID, [skill["id"] for skill in self.c.get("/api/skills").json()["skills"]])


class BuiltinSkillLaunchTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        store.save_installed([])

    def test_launch_returns_canvas_prompt_and_skill_ref(self):
        resp = self.c.post("/api/store/items/skill/%s/launch" % BUILTIN_ID,
                           json={"inputs": {"补充描述": "白底 look 图 + 空镜"}})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(set(body), {"canvas_id", "prompt", "auto_send", "skill_ref", "builtin"})
        self.assertTrue(body["builtin"])
        self.assertTrue(body["auto_send"])
        self.assertEqual(body["skill_ref"], BUILTIN_ID)
        self.assertIn(BUILTIN_DISPLAY, body["prompt"])
        self.assertIn("技能 ID：%s" % BUILTIN_ID, body["prompt"])
        self.assertIn("补充描述：白底 look 图 + 空镜", body["prompt"])
        self.assertTrue(os.path.isfile(os.path.join(main.CANVAS_DIR, body["canvas_id"] + ".json")))


if __name__ == "__main__":
    unittest.main()
