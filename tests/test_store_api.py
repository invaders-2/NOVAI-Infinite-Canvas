# -*- coding: utf-8 -*-
"""应用市场（/api/store/*）：数据源是 server/store_data 里市场来源的 83 条。

覆盖：
  1. catalog：83 条、counts 自洽、categories 5 个、featured / trending 有值、封面已本地化；
  2. 详情：5 个分支（generic / app / collection / studio / preset_wall）各自的关键字段；
  3. launch：带 preset_id / 不带 preset（starter_prompt）/ 空 inputs 不留空行 / 参考素材 /
     画布真的被创建（能在 CANVAS_DIR 读回）；未知 preset → 400；
  4. install / uninstall：落盘 data/store_installed.json、幂等、未知条目 404；
  5. 只有市场来源这 83 条：不含 NOVAI 既有技能 / 智能体；
  6. 回归：/api/capabilities、/api/agents 照旧。

用临时数据目录（NOVAI_DATA_DIR），安装态写临时目录；目录与详情读仓库自带的 data/store。
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

_TMP_DATA = tempfile.mkdtemp(prefix="novai-store-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main
from server.routes import store


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def client():
    return TestClient(main.app)


def detail_of(kind, name):
    return store.load_detail(kind, name) or {}


class StoreCatalogTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        store.save_installed([])
        self.data = self.c.get("/api/store/catalog").json()

    def test_catalog_has_83_items(self):
        items = self.data["items"]
        self.assertEqual(len(items), 83)
        self.assertEqual(self.data["counts"], {"all": 83, "skill": 60, "app": 23})
        keys = {(item["kind"], item["name"]) for item in items}
        self.assertEqual(len(keys), 83)                       # 没有重复条目
        for item in items:
            self.assertIn(item["kind"], ("skill", "app"))
            self.assertTrue(item["display_name"])
            self.assertTrue(item["name"])
            self.assertIsInstance(item["installed"], bool)

    def test_categories_featured_trending(self):
        categories = self.data["categories"]
        self.assertEqual(len(categories), 5)
        for category in categories:
            self.assertEqual(set(category), {"id", "label"})
        self.assertGreater(len(self.data["featured"]), 0)
        self.assertGreater(len(self.data["trending_use_cases"]), 0)
        self.assertTrue(self.data["content_version"])

    def test_covers_are_local_webp_and_compressed(self):
        covers_dir = os.path.join(str(ROOT), "static", "store", "covers")
        local = [item for item in self.data["items"]
                 if str(item.get("cover_url") or "").startswith("/static/store/covers/")]
        self.assertGreaterEqual(len(local), 40)
        for item in local[:5]:
            self.assertTrue(item["cover_url"].endswith(".webp"), item["cover_url"])
            path = os.path.join(str(ROOT), item["cover_url"].lstrip("/"))
            self.assertTrue(os.path.isfile(path), item["cover_url"])
        files = os.listdir(covers_dir)
        self.assertGreaterEqual(len(files), 240)                            # 封面 + 图标 + 达人形象 + 海报
        self.assertTrue(all(name.endswith(".webp") for name in files))     # 原 jpg/png 已删
        total = sum(os.path.getsize(os.path.join(covers_dir, name)) for name in files)
        self.assertLessEqual(total, 12 * 1024 * 1024, "封面总大小应 ≤12MB")
        biggest = max(os.path.getsize(os.path.join(covers_dir, name)) for name in files)
        self.assertLess(biggest, 2 * 1024 * 1024)
        # 视频封面 URL 因含品牌域名已被清空；海报兜底图仍保留（本地 webp）
        brand = "tap" + "now"
        self.assertFalse([item for item in self.data["items"]
                          if brand in str(item.get("cover_video_url") or "").lower()])
        poster = [item for item in self.data["items"]
                  if str(item.get("cover_poster_url") or "").startswith("/static/store/covers/")]
        self.assertGreater(len(poster), 0)
        self.assertTrue(all(p.endswith(".webp") for p in (item["cover_poster_url"] for item in poster)))

    def test_no_novai_builtin_entries(self):
        names = {item["name"] for item in self.data["items"]}
        # 这些是 NOVAI 自带技能/智能体的 id（见 server/skills/builtin_skills.json），市场里不应出现
        for novai_id in ("advantage-money", "keyword-money", "keyword-money-model"):
            self.assertNotIn(novai_id, names)
        self.assertEqual(len(names), 83)                      # 只有从市场抓下来的 83 个 id


class StoreDataLocationTests(unittest.TestCase):
    """数据放在可提交的 server/store_data；data/store 已不存在（data/ 被 .gitignore 忽略）。"""

    def test_store_dir_is_committable_location(self):
        self.assertEqual(store.store_dir(), os.path.join(str(ROOT), "server", "store_data"))
        self.assertTrue(os.path.isfile(os.path.join(store.store_dir(), "catalog.json")))
        self.assertEqual(len(os.listdir(os.path.join(store.store_dir(), "details"))), 83)
        self.assertFalse(os.path.isdir(os.path.join(str(ROOT), "data", "store")))

    def test_skill_instructions_copied(self):
        folder = os.path.join(store.store_dir(), "skill_instructions")
        names = os.listdir(folder)
        self.assertEqual(len([n for n in names if n.endswith(".md")]), 26)     # 上游原始正文
        self.assertIn("_index.json", names)
        self.assertIn(store.SKILL_GENERATED_DIRNAME, names)                    # 整理稿目录
        index = store._skill_index()
        self.assertEqual(len(index), 26)
        self.assertEqual(sum(int(v.get("chars") or 0) for v in index.values()), 355703)
        generated = os.listdir(os.path.join(folder, store.SKILL_GENERATED_DIRNAME))
        self.assertTrue(generated)
        self.assertTrue(all(n.endswith(".md") for n in generated))
        # 每条整理稿都必须带「非原文」声明
        sample = os.path.join(folder, store.SKILL_GENERATED_DIRNAME, sorted(generated)[0])
        with open(sample, "r", encoding="utf-8") as fh:
            self.assertIn("原始执行手册未随客户端下发", fh.read())


class StoreBrandScrubTests(unittest.TestCase):
    """产品界面不能出现抓取来源品牌词：数据里 0 命中（README 例外，仓库文档不算界面）。"""

    BRAND = "tap" + "now"

    def _assert_clean(self, text, where):
        self.assertNotIn(self.BRAND, text.lower(), where)

    def test_json_data_has_no_brand(self):
        store_dir = store.store_dir()
        json_paths = [os.path.join(store_dir, "catalog.json"),
                      os.path.join(store_dir, "skill_instructions", "_index.json")]
        json_paths += sorted(Path(store_dir, "details").glob("*.json"))
        for path in json_paths:
            with open(str(path), "r", encoding="utf-8") as fh:
                self._assert_clean(fh.read(), str(path))
        self.assertGreaterEqual(len(json_paths), 85)

    def test_markdown_manuals_have_no_brand(self):
        store_dir = store.store_dir()
        instructions = Path(store_dir, "skill_instructions")
        md_paths = sorted(instructions.glob("*.md")) + sorted((instructions / "generated").glob("*.md"))
        self.assertEqual(len(md_paths), 48)                 # 26 原始 + 22 整理稿
        for path in md_paths:
            with open(str(path), "r", encoding="utf-8") as fh:
                self._assert_clean(fh.read(), str(path))

    def test_display_names_are_clean(self):
        data = client().get("/api/store/catalog").json()
        for item in data["items"]:
            with self.subTest(name=item["name"]):
                display = item["display_name"]
                self.assertTrue(display.strip(), "display_name 不能为空")
                self.assertNotIn("  ", display, "display_name 不能有连续空格")
                self._assert_clean(display, item["name"])
                self._assert_clean(item["description"], item["name"])
                self.assertNotIn("  ", item["description"])


class StoreDetailTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        store.save_installed([])

    def _find(self, predicate):
        data = self.c.get("/api/store/catalog").json()["items"]
        for item in data:
            detail = detail_of(item["kind"], item["name"])
            if predicate(detail):
                return item, detail
        self.fail("data/store 里找不到满足条件的分支样本")

    def test_generic_branch_has_guide(self):
        item, _detail = self._find(lambda d: d and d.get("guide") and not d.get("install_mode")
                                   and not d.get("collection") and not d.get("influencer_studio")
                                   and not d.get("preset_gallery"))
        resp = self.c.get("/api/store/items/%s/%s" % (item["kind"], item["name"]))
        self.assertEqual(resp.status_code, 200)
        got = resp.json()["item"]
        self.assertIn("guide", got)
        self.assertIn("summary", got["guide"])

    def test_app_branch_has_install_mode(self):
        item, _detail = self._find(lambda d: d and d.get("install_mode"))
        got = self.c.get("/api/store/items/app/%s" % item["name"]).json()["item"]
        self.assertEqual(got["kind"], "app")
        self.assertTrue(got["install_mode"])

    def test_collection_branch_has_collection(self):
        item, _detail = self._find(lambda d: d and d.get("collection"))
        got = self.c.get("/api/store/items/skill/%s" % item["name"]).json()["item"]
        self.assertIn("entries", got["collection"])
        self.assertGreater(len(got["collection"]["entries"]), 0)

    def test_studio_branch_has_influencer_studio(self):
        item, _detail = self._find(lambda d: d and d.get("influencer_studio"))
        got = self.c.get("/api/store/items/skill/%s" % item["name"]).json()["item"]
        studio = got["influencer_studio"]
        self.assertIsInstance(studio, dict)
        self.assertTrue(studio, "influencer_studio 不该是空对象")
        # 两条 studio 条目的字段集不同（一条是 {agent, clips, personas...}，一条是 {view:'hub', studio, heroes...}），
        # 只断言保留了上游的原始结构，不硬编码单一形态
        self.assertTrue(set(studio) & {"agent", "clips", "personas", "heroes", "studio", "view"})

    def test_preset_wall_branch_has_preset_gallery(self):
        item, _detail = self._find(lambda d: d and d.get("preset_gallery"))
        got = self.c.get("/api/store/items/skill/%s" % item["name"]).json()["item"]
        gallery = got["preset_gallery"]
        self.assertGreaterEqual(len(gallery["presets"]), 1)
        self.assertGreaterEqual(len(gallery["categories"]), 1)

    def test_null_detail_falls_back_to_catalog_item(self):
        # 上游 404 的两条（本地详情为 null）也要能看详情，不 500
        got = self.c.get("/api/store/items/app/baidupan").json()["item"]
        self.assertEqual(got["kind"], "app")
        self.assertEqual(got["name"], "baidupan")
        self.assertIn("installed", got)

    def test_skill_body_flags(self):
        got = self.c.get("/api/store/items/skill/primordia-art-director").json()["item"]
        self.assertTrue(got["has_skill_body"])
        self.assertGreater(got["skill_body_chars"], 30000)     # 最大的一份，launch 时会截断
        # 没有正文的条目：两个字段都给默认值，不报错
        plain = self.c.get("/api/store/items/app/baidupan").json()["item"]
        self.assertFalse(plain["has_skill_body"])
        self.assertEqual(plain["skill_body_chars"], 0)

    def test_skill_body_source_three_states(self):
        original = self.c.get("/api/store/items/skill/trending-recast-gallery").json()["item"]
        self.assertEqual(original["skill_body_source"], "original")
        generated = self.c.get("/api/store/items/skill/3d-studio").json()["item"]
        self.assertEqual(generated["skill_body_source"], "generated")
        self.assertTrue(generated["has_skill_body"])
        self.assertGreater(generated["skill_body_chars"], 0)
        missing = self.c.get("/api/store/items/app/baidupan").json()["item"]
        self.assertEqual(missing["skill_body_source"], "")
        self.assertFalse(missing["has_skill_body"])

    def test_detail_unavailable_for_upstream_404(self):
        for name in ("baidupan", "descript"):
            with self.subTest(name=name):
                item = self.c.get("/api/store/items/app/%s" % name).json()["item"]
                self.assertTrue(item["detail_unavailable"])
                self.assertTrue(item["detail_unavailable_reason"])
                self.assertEqual(item["name"], name)
                self.assertIn("installed", item)
        # 正常详情不带降级标记
        normal = self.c.get("/api/store/items/skill/3d-studio").json()["item"]
        self.assertNotIn("detail_unavailable", normal)

    def test_generated_body_priority_and_lookup_in_temp_store(self):
        """同名同时存在原文与整理稿时用原文；只有整理稿时用整理稿。"""
        tmp = tempfile.mkdtemp(prefix="novai-manual-priority-")
        try:
            os.makedirs(os.path.join(tmp, "details"))
            os.makedirs(os.path.join(tmp, "skill_instructions", store.SKILL_GENERATED_DIRNAME))
            with open(os.path.join(tmp, "catalog.json"), "w", encoding="utf-8") as fh:
                json.dump({"code": 200, "data": {"items": [
                    {"kind": "skill", "name": "dup-skill", "display_name": "重复"},
                    {"kind": "skill", "name": "gen-only", "display_name": "只有整理稿"},
                ], "categories": []}}, fh, ensure_ascii=False)
            for name in ("dup-skill", "gen-only"):
                with open(os.path.join(tmp, "details", "skill__%s.json" % name), "w", encoding="utf-8") as fh:
                    json.dump({"kind": "skill", "name": name}, fh, ensure_ascii=False)
            with open(os.path.join(tmp, "skill_instructions", "dup-skill.md"), "w", encoding="utf-8") as fh:
                fh.write("原始正文内容")
            with open(os.path.join(tmp, "skill_instructions", store.SKILL_GENERATED_DIRNAME,
                                   "dup-skill.md"), "w", encoding="utf-8") as fh:
                fh.write("整理稿内容")
            with open(os.path.join(tmp, "skill_instructions", store.SKILL_GENERATED_DIRNAME,
                                   "gen-only.md"), "w", encoding="utf-8") as fh:
                fh.write("只有整理稿")

            with patch.object(store, "store_dir", return_value=tmp):
                dup = {"name": "dup-skill"}
                self.assertEqual(store.skill_body_source(dup), "original")
                self.assertEqual(store.load_skill_body(dup), "原始正文内容")
                self.assertEqual(store.skill_body_by_id("dup-skill"), "原始正文内容")
                gen = {"name": "gen-only"}
                self.assertEqual(store.skill_body_source(gen), "generated")
                self.assertEqual(store.skill_body_by_id("gen-only"), "只有整理稿")
                self.assertEqual(store.skill_body_source({"name": "no-such"}), "")
                self.assertEqual(store.skill_body_by_id("no-such"), "")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_unknown_item_is_404(self):
        for url in ("/api/store/items/skill/no-such-item",
                    "/api/store/items/app/no-such-app",
                    "/api/store/items/agent/advantage-money",
                    "/api/store/items/skill/"):
            with self.subTest(url=url):
                self.assertEqual(self.c.get(url).status_code, 404)


class StoreLaunchTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        store.save_installed([])

    def test_launch_with_preset_compiles_prompt_no_manual(self):
        detail = detail_of("skill", "trending-recast-gallery")
        preset = detail["preset_gallery"]["presets"][0]
        resp = self.c.post("/api/store/items/skill/trending-recast-gallery/launch",
                           json={"preset_id": preset["id"],
                                 "inputs": {"theme": "国足最被高估的球员"}})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["auto_send"])
        self.assertEqual(set(body), {"canvas_id", "prompt", "auto_send", "skill_ref"})
        self.assertIn(preset["title"], body["prompt"])                        # 模板名
        self.assertIn(preset["agent"]["skill_mention"], body["prompt"])        # skill_mention 原样
        self.assertIn("要排什么？：国足最被高估的球员", body["prompt"])         # 字段名：值

        # 画布真的创建了（能按 id 读回）
        path = os.path.join(main.CANVAS_DIR, body["canvas_id"] + ".json")
        self.assertTrue(os.path.isfile(path))
        with open(path, "r", encoding="utf-8") as fh:
            canvas = json.load(fh)
        self.assertEqual(canvas["id"], body["canvas_id"])
        self.assertTrue(canvas["title"])

    def test_launch_without_preset_uses_starter_prompt(self):
        item = None
        for candidate in self.c.get("/api/store/catalog").json()["items"]:
            detail = detail_of(candidate["kind"], candidate["name"])
            if detail.get("starter_prompt"):
                item = candidate
                break
        self.assertIsNotNone(item)
        detail = detail_of(item["kind"], item["name"])
        resp = self.c.post("/api/store/items/%s/%s/launch" % (item["kind"], item["name"]), json={})
        self.assertEqual(resp.status_code, 200)
        prompt = resp.json()["prompt"]
        self.assertIn(detail["starter_prompt"].strip(), prompt)
        self.assertNotIn("模板：", prompt)
        self.assertNotIn("输入：", prompt)          # 空 inputs 不产生空段落

    def test_empty_input_values_do_not_create_blank_lines(self):
        resp = self.c.post("/api/store/items/skill/trending-recast-gallery/launch",
                           json={"preset_id": "ranking-board-roast",
                                 "inputs": {"theme": "", "extra": "   "}})
        self.assertEqual(resp.status_code, 200)
        prompt = resp.json()["prompt"]
        self.assertNotIn("输入：", prompt)
        for line in prompt.split("\n"):
            self.assertTrue(line.strip(), "prompt 里不该有空行：%r" % prompt)

    def test_references_are_appended(self):
        resp = self.c.post("/api/store/items/skill/trending-recast-gallery/launch",
                           json={"preset_id": "ranking-board-roast",
                                 "inputs": {"theme": "咖啡"},
                                 "references": [{"url": "/assets/input/a.png", "name": "产品图"}]})
        prompt = resp.json()["prompt"]
        self.assertIn("参考素材：", prompt)
        self.assertIn("- 产品图：/assets/input/a.png", prompt)

    def test_launch_returns_skill_ref_without_manual(self):
        item = self.c.get("/api/store/items/skill/primordia-art-director").json()["item"]
        self.assertTrue(item["has_skill_body"])
        resp = self.c.post("/api/store/items/skill/primordia-art-director/launch", json={})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(set(body), {"canvas_id", "prompt", "auto_send", "skill_ref"})
        self.assertEqual(body["skill_ref"], "store:primordia-art-director")
        # 正文不再进 instruction：prompt 里没有手册，长度也远低于 4000 字上限
        self.assertNotIn("【技能执行手册】", body["prompt"])
        self.assertNotIn("【用户输入】", body["prompt"])
        self.assertLess(len(body["prompt"]), 4000)

    def test_launch_without_body_returns_empty_skill_ref(self):
        # baidupan 的 activation_skill=baidupan-files 没有正文
        body = self.c.post("/api/store/items/app/baidupan/launch", json={}).json()
        self.assertEqual(body["skill_ref"], "")
        self.assertNotIn("【技能执行手册】", body["prompt"])

    def test_launch_returns_skill_ref_for_generated_manual(self):
        body = self.c.post("/api/store/items/skill/3d-studio/launch", json={}).json()
        self.assertEqual(body["skill_ref"], "store:3d-studio")
        self.assertNotIn("【技能执行手册】", body["prompt"])
        self.assertLess(len(body["prompt"]), 4000)

    def test_include_skill_body_is_deprecated_and_ignored(self):
        plain = self.c.post("/api/store/items/skill/primordia-art-director/launch", json={}).json()
        legacy = self.c.post("/api/store/items/skill/primordia-art-director/launch",
                             json={"include_skill_body": True}).json()
        self.assertEqual(legacy["prompt"], plain["prompt"])       # 旧参数不再改变提示词
        self.assertEqual(legacy["skill_ref"], plain["skill_ref"])
        self.assertNotIn("【技能执行手册】", legacy["prompt"])

    def test_skill_manual_text_truncates_at_30000(self):
        manual = store.skill_manual_text("字" * 40000)
        self.assertTrue(manual.startswith("【技能执行手册】"))
        self.assertIn(store.SKILL_BODY_TRUNCATED_NOTE, manual)
        body_text = manual.split("\n", 1)[1].strip()
        self.assertEqual(len(body_text),
                         store.SKILL_BODY_MAX_CHARS + len(store.SKILL_BODY_TRUNCATED_NOTE))
        short = store.skill_manual_text("短正文")
        self.assertEqual(short, "【技能执行手册】\n短正文")

    def test_skill_body_by_id_maps_name_and_activation(self):
        self.assertGreater(len(store.skill_body_by_id("primordia-art-director")), 0)     # 直接文件名
        self.assertGreater(len(store.skill_body_by_id("character-asset-pack")), 0)      # name → activation_skill
        self.assertGreater(len(store.skill_body_by_id("primordia-character-asset-pack")), 0)
        self.assertEqual(store.skill_body_by_id("no-such-skill"), "")
        self.assertEqual(store.skill_body_by_id(""), "")

    def test_unknown_preset_is_400(self):
        resp = self.c.post("/api/store/items/skill/trending-recast-gallery/launch",
                           json={"preset_id": "no-such-preset"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("预设不存在", resp.json()["detail"])


class StoreInstallTests(unittest.TestCase):

    def setUp(self):
        self.c = client()
        store.save_installed([])

    def _saved(self):
        with open(store.installed_path(), "r", encoding="utf-8") as fh:
            return json.load(fh)

    def test_install_and_uninstall_skill(self):
        url = "/api/store/items/skill/trending-recast-gallery/install"
        self.assertEqual(self.c.post(url).json(), {"installed": True})
        self.assertEqual(self._saved(), ["skill:trending-recast-gallery"])
        self.assertEqual(self.c.post(url).json(), {"installed": True})       # 幂等
        self.assertEqual(self._saved(), ["skill:trending-recast-gallery"])

        catalog = self.c.get("/api/store/catalog").json()["items"]
        self.assertTrue(next(i for i in catalog if i["name"] == "trending-recast-gallery")["installed"])
        self.assertTrue(self.c.get("/api/store/items/skill/trending-recast-gallery")
                        .json()["item"]["installed"])

        self.assertEqual(self.c.delete(url).json(), {"installed": False})
        self.assertEqual(self._saved(), [])
        self.assertEqual(self.c.delete(url).json(), {"installed": False})    # 幂等

    def test_install_app_and_mix(self):
        self.c.post("/api/store/items/skill/trending-recast-gallery/install")
        self.c.post("/api/store/items/app/brainstorm/install")
        self.assertEqual(self._saved(), ["skill:trending-recast-gallery", "app:brainstorm"])

    def test_unknown_item_is_404_and_not_written(self):
        for url in ("/api/store/items/skill/no-such-item/install",
                    "/api/store/items/app/no-such-app/install",
                    "/api/store/items/agent/advantage-money/install"):
            with self.subTest(url=url):
                self.assertEqual(self.c.post(url).status_code, 404)
                self.assertEqual(self.c.delete(url).status_code, 404)
        self.assertEqual(self._saved(), [])


class StoreRegressionTests(unittest.TestCase):

    def test_capabilities_and_agents_still_work(self):
        c = client()
        caps = c.get("/api/capabilities")
        self.assertEqual(caps.status_code, 200)
        self.assertIn("capabilities", caps.json())
        agents = c.get("/api/agents")
        self.assertEqual(agents.status_code, 200)
        self.assertIn("agents", agents.json())


if __name__ == "__main__":
    unittest.main()
