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

    def test_export_retired_builtin_is_404(self):
        # 2026-11：内置技能全部下线，导出它们应当 404
        self.assertEqual(CLIENT.get("/api/skills/advantage-money/export").status_code, 404)

    def test_export_unknown_is_404(self):
        self.assertEqual(CLIENT.get("/api/skills/no-such-skill/export").status_code, 404)


class SkillMdUnknownFieldsTests(unittest.TestCase):
    """未知顶层字段（version / author 等）整段忽略，已知字段与结构校验不变。"""

    def test_unknown_fields_are_ignored_and_kept_out_of_body(self):
        markdown = (
            "---\n"
            "version: 2.4.1\n"
            "author: someone\n"
            "name: unknown-fields-skill\n"
            "description: 带未知字段的技能\n"
            "license: MIT\n"
            "metadata:\n"
            "  category: 测试\n"
            "allowed-tools:\n"
            "  - read_table\n"
            "tags:\n"
            "  - 时装\n"
            "  - 摄影\n"
            "homepage: https://example.com/skill\n"
            "---\n"
            "正文第一段\n"
        )
        parsed = skill_md.parse_skill_md(markdown)
        self.assertEqual(parsed["name"], "unknown-fields-skill")
        self.assertEqual(parsed["description"], "带未知字段的技能")
        self.assertEqual(parsed["license"], "MIT")
        self.assertEqual(parsed["metadata"], {"category": "测试"})
        self.assertEqual(parsed["allowed_tools"], ["read_table"])
        self.assertEqual(parsed["body"], "正文第一段\n")
        for unknown in ("version", "author", "tags", "homepage"):
            self.assertNotIn(unknown, parsed)
            self.assertNotIn(unknown, parsed["body"])

    def test_unknown_fields_do_not_override_known_fields(self):
        markdown = (
            "---\n"
            "name: known-name\n"
            "version: 9.9.9\n"
            "description: 已知描述\n"
            "author:\n"
            "  name: fake\n"
            "  email: fake@example.com\n"
            "compatibility: agent-skills\n"
            "metadata:\n"
            "  author: 内部作者\n"
            "---\n正文\n"
        )
        parsed = skill_md.parse_skill_md(markdown)
        self.assertEqual(parsed["name"], "known-name")
        self.assertEqual(parsed["description"], "已知描述")
        self.assertEqual(parsed["compatibility"], "agent-skills")
        self.assertEqual(parsed["metadata"], {"author": "内部作者"})
        self.assertEqual(sorted(parsed),
                         ["allowed_tools", "body", "compatibility", "description",
                          "license", "metadata", "name"])

    def test_structural_errors_still_raise(self):
        cases = [
            # 未知字段也必须是合法的 key: value（缺冒号是结构错误，不是「忽略」）
            "---\nname: known-name\ndescription: x\nversion 1.0\n---\n正文",
            # 已知字段后面的裸缩进仍是顶层缩进错误
            "---\nname: known-name\ndescription: x\n  stray: indent\n---\n正文",
            # metadata 子项格式错误照旧报错
            "---\nname: known-name\ndescription: x\nmetadata:\n  - list\n---\n正文",
            # 已知字段类型错误照旧报错
            "---\nname:\n  - bad\ndescription: x\n---\n正文",
            "---\nname: known-name\ndescription: x\nallowed-tools: read_table\n---\n正文",
        ]
        for markdown in cases:
            with self.subTest(markdown=markdown[:60]):
                with self.assertRaises(skill_md.SkillMdError) as ctx:
                    skill_md.parse_skill_md(markdown)
                self.assertTrue(str(ctx.exception).strip())


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
            "---\nname: ok-name\ndescription: x\n  stray: indent\n---\n正文",  # 顶层缩进
            "---\nname: ok-name\n---\n正文",                                  # 缺 description
            "---\n name: indented\n---\n正文",                                # 顶层缩进
        ]
        for markdown in cases:
            with self.subTest(markdown=markdown[:40]):
                resp = self._import(markdown)
                self.assertEqual(resp.status_code, 400)
                self.assertTrue(resp.json()["detail"])

    def test_import_with_unknown_top_level_fields_succeeds(self):
        markdown = skill_md_text(
            name="md-versioned-skill",
            extra="version: 2.4.1\nauthor: someone\nlicense: MIT\n")
        resp = self._import(markdown)
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()["skill"]
        self.assertEqual(body["id"], "md-versioned-skill")
        exported = CLIENT.get("/api/skills/md-versioned-skill/export")
        self.assertEqual(exported.status_code, 200)
        self.assertNotIn("version:", exported.text)
        self.assertNotIn("author:", exported.text)
        parsed = skill_md.parse_skill_md(exported.text)
        self.assertEqual(parsed["name"], "md-versioned-skill")
        self.assertEqual(parsed["description"], "一句话说明这个技能")
        self.assertEqual(parsed["body"], "正文第一段\n\n正文第二段")

    def test_json_import_still_works(self):
        payload = {"id": "json-import-skill", "name": "JSON 导入", "description": "旧格式",
                   "skill_prompt": "正文", "category": "我的技能"}
        resp = CLIENT.post("/api/skills/import", json=payload)
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["skill"]["id"], "json-import-skill")


if __name__ == "__main__":
    unittest.main()
