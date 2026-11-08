# -*- coding: utf-8 -*-
"""应用市场技能闸门：官方技能默认不可用，RedSkill 条目点「添加」才装。

覆盖：
  1. catalog：4 个 RedSkill 补充条目 + 官方技能（builtin）并存，installed 全 false；
  2. 官方技能安装 → enabled true + 安装标记；卸载 → enabled false、定义文件保留；
  3. RedSkill 安装（打桩取包）→ name 是中文、id 仍是标识符、enabled true；
  4. 重复安装幂等（不会重复取包）；卸载只停用、不删文件；
  5. 一次性迁移只跑一次：标记写入后，用户手动启用的状态不会被再次改掉。

用临时数据目录（NOVAI_DATA_DIR）隔离，不碰日常数据。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-store-gate-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main
from server.routes import store
from server.skills import redskill_install, registry as skills_registry

BUILTIN_ID = "fashion-editorial"
REDSKILL_NAME = "redskill-create-y2k-fashion-images"
REDSKILL_ID = "create-y2k-fashion-images"
REDSKILL_DISPLAY = "千禧 Y2K 时尚大片"
SKILL_MD = "---\nname: %s\ndescription: 测试用 RedSkill 技能\n---\n正文：测试技能内容" % REDSKILL_ID


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def client():
    return TestClient(main.app)


def skill_file(skill_id):
    return os.path.join(skills_registry.skills_dir(), "%s.json" % skill_id)


def read_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


def set_skill_enabled(skill_id, enabled):
    path = skill_file(skill_id)
    raw = read_json(path)
    raw["enabled"] = enabled
    write_json(path, raw)


def reset_gate():
    """回到「迁移已完成、官方技能全停用」的干净状态。"""
    store.save_installed([])
    marker = store.skills_gate_marker_path()
    if os.path.isfile(marker):
        os.remove(marker)
    store.ensure_skills_gate()


def remove_redskill_definition():
    _path, definition = store._find_definition_by_store_ref("skill:%s" % REDSKILL_NAME)
    if definition:
        os.remove(_path)


def fake_fetch(identifier):
    return {
        "markdown": SKILL_MD,
        "identifier": identifier,
        "version": "1.0.0",
        "sha256": "a" * 64,
        "bundle_files": ["SKILL.md"],
        "source_url": "https://cdn.example/skill.zip",
    }


class CatalogGateTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        reset_gate()
        remove_redskill_definition()
        self.items = self.c.get("/api/store/catalog").json()["items"]

    def test_redskill_entries_are_listed_and_not_installed(self):
        extras = [item for item in self.items if item["name"].startswith("redskill-")]
        self.assertEqual(len(extras), 4)
        for item in extras:
            with self.subTest(name=item["name"]):
                self.assertEqual(item["kind"], "skill")
                self.assertFalse(item["builtin"])
                self.assertFalse(item["installed"])
                self.assertTrue(item["display_name"].strip())
                self.assertEqual(item["source"]["type"], "redskill")
                self.assertTrue(item["source"]["identifier"])
                self.assertTrue(item["marketing_line"])
                self.assertLessEqual(len(item["marketing_line"]), store.MARKETING_LINE_MAX_CHARS)
                self.assertTrue(item["store_visible"])
                self.assertTrue(item["store_available"])
                self.assertTrue(item["cover_url"])
                self.assertTrue(item["cover_poster_url"])
                self.assertFalse(item["enabled"])

    def test_redskill_entries_have_cover_files(self):
        covers_dir = ROOT / "static" / "store" / "covers"
        extras = [item for item in self.items if item["name"].startswith("redskill-")]
        self.assertEqual(len(extras), 4)
        for item in extras:
            with self.subTest(name=item["name"]):
                cover = item["cover_url"]
                poster = item["cover_poster_url"]
                self.assertTrue(cover.startswith("/static/store/covers/"))
                self.assertTrue(cover.endswith("-sq.webp"))
                self.assertTrue(poster.startswith("/static/store/covers/"))
                self.assertTrue((covers_dir / os.path.basename(cover)).is_file())
                self.assertTrue((covers_dir / os.path.basename(poster)).is_file())
                detail = self.c.get("/api/store/items/skill/%s" % item["name"]).json()["item"]
                self.assertEqual(detail["cover_url"], cover)
                self.assertEqual(detail["cover_poster_url"], poster)

    def test_builtin_skills_are_installed_only_after_market_add(self):
        builtin = [item for item in self.items if item.get("builtin")]
        self.assertGreaterEqual(len(builtin), 1)
        for item in builtin:
            with self.subTest(name=item["name"]):
                self.assertFalse(item["installed"])
                self.assertFalse(item["enabled"])
        self.assertEqual(len({item["name"] for item in self.items}), len(self.items))

    def test_redskill_detail_is_available(self):
        body = self.c.get("/api/store/items/skill/%s" % REDSKILL_NAME).json()
        self.assertEqual(body["item"]["name"], REDSKILL_NAME)
        self.assertEqual(body["item"]["display_name"], REDSKILL_DISPLAY)
        self.assertFalse(body["item"]["installed"])
        self.assertFalse(body["item"]["enabled"])


class BuiltinSkillGateTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        reset_gate()
        set_skill_enabled(BUILTIN_ID, False)

    def _skills(self):
        return {skill["id"]: skill for skill in self.c.get("/api/skills").json()["skills"]}

    def test_install_and_uninstall_toggle_enabled(self):
        url = "/api/store/items/skill/%s/install" % BUILTIN_ID
        self.assertFalse(self._skills()[BUILTIN_ID]["enabled"])

        self.assertEqual(self.c.post(url).json(), {"installed": True, "builtin": True})
        self.assertTrue(self._skills()[BUILTIN_ID]["enabled"])
        self.assertEqual(store.load_installed(), ["skill:%s" % BUILTIN_ID])

        self.assertEqual(self.c.delete(url).json(), {"installed": False, "builtin": True})
        self.assertFalse(self._skills()[BUILTIN_ID]["enabled"])
        self.assertEqual(store.load_installed(), [])
        self.assertTrue(os.path.isfile(skill_file(BUILTIN_ID)))


class RedSkillInstallTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        reset_gate()
        remove_redskill_definition()

    def tearDown(self):
        remove_redskill_definition()

    def _skills(self):
        return {skill["id"]: skill for skill in self.c.get("/api/skills").json()["skills"]}

    def test_install_uses_chinese_name_and_uninstall_keeps_file(self):
        url = "/api/store/items/skill/%s/install" % REDSKILL_NAME
        with mock.patch.object(redskill_install, "fetch_skill_bundle", side_effect=fake_fetch) as fetch:
            body = self.c.post(url).json()
            self.assertEqual(body["installed"], True)
            self.assertEqual(fetch.call_count, 1)
        self.assertEqual(body["skill_id"], REDSKILL_ID)

        raw = read_json(skill_file(REDSKILL_ID))
        self.assertEqual(raw["id"], REDSKILL_ID)
        self.assertEqual(raw["name"], REDSKILL_DISPLAY)
        self.assertEqual(raw["category"], "时尚")
        self.assertTrue(raw["enabled"])
        self.assertEqual(raw["store_ref"], "skill:%s" % REDSKILL_NAME)
        self.assertEqual(raw["store_source"]["identifier"], REDSKILL_ID)
        self.assertTrue(self._skills()[REDSKILL_ID]["enabled"])
        self.assertEqual(store.load_installed(), ["skill:%s" % REDSKILL_NAME])

        listed = [item for item in self.c.get("/api/store/catalog").json()["items"]
                  if item["name"] == REDSKILL_NAME][0]
        self.assertTrue(listed["installed"])
        self.assertTrue(listed["enabled"])

        self.assertEqual(self.c.delete(url).json(), {"installed": False})
        self.assertFalse(read_json(skill_file(REDSKILL_ID))["enabled"])
        self.assertTrue(os.path.isfile(skill_file(REDSKILL_ID)))
        self.assertEqual(store.load_installed(), [])
        listed = [item for item in self.c.get("/api/store/catalog").json()["items"]
                  if item["name"] == REDSKILL_NAME][0]
        self.assertFalse(listed["installed"])
        self.assertFalse(listed["enabled"])
        detail = self.c.get("/api/store/items/skill/%s" % REDSKILL_NAME).json()["item"]
        self.assertFalse(detail["installed"])
        self.assertFalse(detail["enabled"])

    def test_repeat_install_is_idempotent_and_does_not_refetch(self):
        url = "/api/store/items/skill/%s/install" % REDSKILL_NAME
        with mock.patch.object(redskill_install, "fetch_skill_bundle", side_effect=fake_fetch) as fetch:
            self.assertEqual(self.c.post(url).json()["installed"], True)
            self.assertEqual(self.c.post(url).json()["installed"], True)
            self.assertEqual(fetch.call_count, 1)
        self.assertEqual(store.load_installed(), ["skill:%s" % REDSKILL_NAME])


class SkillsGateMigrationTests(unittest.TestCase):

    def setUp(self):
        reset_gate()

    def tearDown(self):
        reset_gate()

    def test_migration_runs_once_and_never_overrides_user_choice(self):
        marker = store.skills_gate_marker_path()
        os.remove(marker)
        set_skill_enabled(BUILTIN_ID, True)

        self.assertTrue(store.ensure_skills_gate())
        self.assertTrue(os.path.isfile(marker))
        self.assertFalse(read_json(skill_file(BUILTIN_ID))["enabled"])

        # 标记已存在：即使用户重新启用，也不再被迁移改回去
        set_skill_enabled(BUILTIN_ID, True)
        self.assertFalse(store.ensure_skills_gate())
        self.assertTrue(read_json(skill_file(BUILTIN_ID))["enabled"])

    def test_concurrent_first_run_migrates_once(self):
        os.remove(store.skills_gate_marker_path())
        set_skill_enabled(BUILTIN_ID, True)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _i: store.ensure_skills_gate(), range(8)))
        self.assertEqual(results.count(True), 1)
        self.assertTrue(store.skills_gate_initialized())
        self.assertFalse(read_json(skill_file(BUILTIN_ID))["enabled"])


if __name__ == "__main__":
    unittest.main()
