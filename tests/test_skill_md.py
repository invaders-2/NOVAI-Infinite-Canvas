# -*- coding: utf-8 -*-
"""SKILL.md 导入/导出（Agent Skills 规范）：round-trip、校验、冲突、metadata 透传、安全。

用真实 TestClient(main.app) + 临时数据目录（技能注册表会 seed 内置技能）。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-skill-md-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402
from server.skills import skill_md  # noqa: E402

CLIENT = TestClient(main.app)


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def skill_md_text(name="md-test-skill", description="一句话说明这个技能", body="正文第一段\n\n正文第二段",
                  extra=""):
    return "---\nname: %s\ndescription: %s\n%s---\n%s" % (name, description, extra, body)


class SkillMdExportTests(unittest.TestCase):

    def test_export_existing_skill(self):
        resp = CLIENT.get("/api/skills/advantage-money/export")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("text/markdown", resp.headers["content-type"])
        self.assertIn('filename="advantage-money.md"', resp.headers["content-disposition"])
        text = resp.text
        self.assertTrue(text.startswith("---\nname: advantage-money"))
        parsed = skill_md.parse_skill_md(text)
        self.assertEqual(parsed["name"], "advantage-money")
        skill = main._skills_registry.get_skill("advantage-money")
        self.assertEqual(parsed["description"], skill["description"])
        self.assertEqual(parsed["body"], skill["skill_prompt"])
        self.assertEqual(parsed["metadata"].get("display_name"), skill["name"])

    def test_export_unknown_is_404(self):
        self.assertEqual(CLIENT.get("/api/skills/no-such-skill/export").status_code, 404)


class SkillMdImportTests(unittest.TestCase):

    def setUp(self):
        # 每个用例前清掉本文件创建的技能，保证用例之间互不影响、可重复跑
        folder = main._skills_registry.skills_dir()
        if not os.path.isdir(folder):
            return
        for filename in os.listdir(folder):
            if filename.startswith(("md-", "json-import-", "big-body-")):
                try:
                    os.remove(os.path.join(folder, filename))
                except OSError:
                    pass

    def _import(self, markdown, overwrite=None):
        payload = {"markdown": markdown}
        if overwrite is not None:
            payload["overwrite"] = overwrite
        return CLIENT.post("/api/skills/import", json=payload)

    def test_round_trip_fields(self):
        markdown = skill_md_text(extra="license: MIT\nmetadata:\n  display_name: 测试技能\n  category: 测试分类\n"
                                        "  tags:\n    - a\n    - b\n  author: me\nallowed-tools:\n  - read_table\n")
        created = self._import(markdown)
        self.assertEqual(created.status_code, 200, created.text)
        body = created.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["skill"]["id"], "md-test-skill")
        self.assertEqual(body["skill"]["name"], "测试技能")

        exported = CLIENT.get("/api/skills/md-test-skill/export")
        self.assertEqual(exported.status_code, 200)
        parsed = skill_md.parse_skill_md(exported.text)
        self.assertEqual(parsed["name"], "md-test-skill")
        self.assertEqual(parsed["description"], "一句话说明这个技能")
        self.assertEqual(parsed["license"], "MIT")
        self.assertEqual(parsed["allowed_tools"], ["read_table"])
        self.assertEqual(parsed["metadata"]["display_name"], "测试技能")
        self.assertEqual(parsed["metadata"]["category"], "测试分类")
        self.assertEqual(parsed["metadata"]["tags"], ["a", "b"])
        self.assertEqual(parsed["metadata"]["author"], "me")
        self.assertEqual(parsed["body"], "正文第一段\n\n正文第二段")

    def test_existing_without_overwrite_is_409_and_overwrite_updates(self):
        first = self._import(skill_md_text(description="第一版说明"))
        self.assertEqual(first.status_code, 200, first.text)
        conflict = self._import(skill_md_text(description="第二版说明"))
        self.assertEqual(conflict.status_code, 409)
        self.assertIn("已存在", conflict.json()["detail"])

        updated = self._import(skill_md_text(description="第二版说明"), overwrite=True)
        self.assertEqual(updated.status_code, 200, updated.text)
        exported = skill_md.parse_skill_md(CLIENT.get("/api/skills/md-test-skill/export").text)
        self.assertEqual(exported["description"], "第二版说明")

        rows = [item for item in CLIENT.get("/api/capabilities").json()["capabilities"]
                if item["id"] == "md-test-skill"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["description"], "第二版说明")

    def test_description_too_long_is_400(self):
        resp = self._import(skill_md_text(description="长" * 1100))
        self.assertEqual(resp.status_code, 400)
        self.assertIn("description", resp.json()["detail"])

    def test_invalid_names_are_400(self):
        for name in ("Bad-Name", "bad name", "../evil", "a/b", "名字", "name.with.dot", "x" * 65):
            with self.subTest(name=name):
                resp = self._import(skill_md_text(name=name))
                self.assertEqual(resp.status_code, 400)
                self.assertTrue(resp.json()["detail"])

    def test_body_too_large_is_400(self):
        resp = self._import(skill_md_text(name="big-body-skill", body="x" * (200 * 1024 + 10)))
        self.assertEqual(resp.status_code, 400)
        self.assertIn("200KB", resp.json()["detail"])

    def test_bad_frontmatter_is_readable_400(self):
        cases = [
            "没有 frontmatter 的纯文本",
            "---\nname md-test\n---\n正文",                                   # 缺冒号
            "---\nname: ok-name\ndescription: x\nunknown_key: y\n---\n正文",  # 未知字段
            "---\nname: ok-name\n---\n正文",                                  # 缺 description
            "---\n name: indented\n---\n正文",                                # 顶层缩进
        ]
        for markdown in cases:
            with self.subTest(markdown=markdown[:40]):
                resp = self._import(markdown)
                self.assertEqual(resp.status_code, 400)
                self.assertTrue(resp.json()["detail"])

    def test_json_import_still_works(self):
        payload = {"id": "json-import-skill", "name": "JSON 导入", "description": "旧格式",
                   "skill_prompt": "正文", "category": "我的技能"}
        resp = CLIENT.post("/api/skills/import", json=payload)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["skill"]["id"], "json-import-skill")


if __name__ == "__main__":
    unittest.main()
