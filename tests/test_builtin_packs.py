# -*- coding: utf-8 -*-
"""内置技能包：首次安装、prompt 路径替换、幂等、用户状态保留、坏包容错（/tmp 隔离）。"""
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-builtin-pack-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

from server.skills import registry  # noqa: E402

REAL_PACK = ROOT / "server" / "skills" / "builtin_packs" / "fashion-editorial"
SKILL_ID = "fashion-editorial"
PACK_FILES = (
    "SKILL.md", "README.md", "LICENSE", "config.example.json", "novai-pack.json",
    "profiles/README.md", "profiles/film-darkroom-cn.json",
    "references/api-guide.md", "references/shot-library.md", "references/styles.md",
    "scripts/shoot_plan.py", "scripts/generate_image.py",
)


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def write_pack(root, name, body="正文 <skill-root>/scripts/run.py", manifest=None, files=None):
    """造一个最小内置包（name 同时是 frontmatter name 与目录名）。"""
    pack = Path(root, name)
    pack.mkdir(parents=True, exist_ok=True)
    (pack / "SKILL.md").write_text(
        "---\nname: %s\ndescription: %s 的说明\n---\n%s\n" % (name, name, body),
        encoding="utf-8")
    if manifest is not None:
        (pack / "novai-pack.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
    for rel, content in (files or {}).items():
        target = pack / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    return pack


class PackCase(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-pack-case-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.data = os.path.join(self.root, "data")
        self._previous_data_dir = registry._DATA_DIR       # 用完还回去，别影响同进程其它测试模块
        registry.set_data_dir(self.data)
        self.addCleanup(registry.set_data_dir, self._previous_data_dir)
        self.packs_dir = os.path.join(self.root, "packs")

    # --- 便捷方法 ---
    def skills_dir(self):
        return registry.skills_dir()

    def definition_path(self, skill_id=SKILL_ID):
        return os.path.join(self.skills_dir(), "%s.json" % skill_id)

    def installed_dir(self, skill_id=SKILL_ID):
        return os.path.join(self.skills_dir(), skill_id)

    def definition(self, skill_id=SKILL_ID):
        with open(self.definition_path(skill_id), "r", encoding="utf-8") as fh:
            return json.load(fh)

    def save_definition(self, data, skill_id=SKILL_ID):
        with open(self.definition_path(skill_id), "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)

    def find(self, skill_id=SKILL_ID):
        for item in registry.load_skills():
            if item["id"] == skill_id:
                return item
        return None

    def use_packs(self, packs_dir):
        return mock.patch.object(registry, "_BUILTIN_PACKS_DIR", str(packs_dir))


class RealPackTests(PackCase):

    def test_first_load_installs_directory_and_definition(self):
        self.assertFalse(os.path.exists(self.installed_dir()))
        skill = self.find()
        self.assertIsNotNone(skill)
        self.assertEqual(skill["name"], "服装大片 · 胶片暗房")
        self.assertEqual(skill["category"], "服装大片")
        self.assertEqual(skill["icon"], "film")
        self.assertEqual(skill["tags"], ["服装", "大片", "胶片", "lookbook", "一致性"])
        self.assertEqual(skill["skill_type"], "system")
        self.assertTrue(skill["enabled"])
        self.assertTrue(skill["available"])
        self.assertEqual(skill["builtin_pack"], SKILL_ID)

        for rel in PACK_FILES:
            self.assertTrue(os.path.isfile(os.path.join(self.installed_dir(), rel)), rel)
        self.assertEqual(
            Path(self.installed_dir(), "SKILL.md").read_text(encoding="utf-8"),
            (REAL_PACK / "SKILL.md").read_text(encoding="utf-8"))     # 上游文件原样

        definition = self.definition()
        self.assertEqual(definition["id"], SKILL_ID)
        self.assertEqual(definition["skill_type"], "system")
        self.assertEqual(definition["builtin_pack"], SKILL_ID)
        self.assertEqual(definition["pack_version"], registry._pack_version(str(REAL_PACK)))
        self.assertTrue(definition["enabled"])
        self.assertTrue(definition["available"])

    def test_prompt_uses_installed_absolute_path(self):
        skill = self.find()
        prompt = skill["skill_prompt"]
        root = os.path.abspath(self.installed_dir())
        self.assertNotIn("<skill-root>", prompt)
        self.assertTrue(prompt.startswith("技能根目录：%s" % root), prompt[:80])
        self.assertIn("（脚本用 python3 直接运行；需要风格/镜头库细节时先读 references/ 下对应文件）", prompt)
        self.assertIn(root + "/scripts/shoot_plan.py", prompt)
        self.assertTrue(os.path.isdir(root))                          # 路径真实存在
        self.assertTrue(os.path.isfile(os.path.join(root, "scripts", "shoot_plan.py")))

    def test_second_load_is_idempotent(self):
        registry.load_skills()
        watched = [self.definition_path(), os.path.join(self.installed_dir(), "SKILL.md")]
        before = {path: os.stat(path).st_mtime_ns for path in watched}
        before_json = Path(self.definition_path()).read_text(encoding="utf-8")
        registry.load_skills()
        after = {path: os.stat(path).st_mtime_ns for path in watched}
        self.assertEqual(before, after)                               # 没重写文件
        self.assertEqual(before_json, Path(self.definition_path()).read_text(encoding="utf-8"))

    def test_user_disabled_state_survives_reload(self):
        registry.load_skills()
        data = self.definition()
        data["enabled"] = False
        self.save_definition(data)
        skill = self.find()
        self.assertFalse(skill["enabled"])
        self.assertFalse(self.definition()["enabled"])                # 没被覆盖回 true

    def test_version_change_refreshes_definition_and_keeps_user_config(self):
        registry.load_skills()
        data = self.definition()
        data["enabled"] = False
        data["name"] = "用户改过的名字"
        self.save_definition(data)
        user_config = os.path.join(self.installed_dir(), "config.json")
        Path(user_config).write_text('{"api_key": "user-filled-key"}', encoding="utf-8")

        with mock.patch.object(registry, "_pack_version", return_value="version-2"):
            skill = self.find()

        definition = self.definition()
        self.assertEqual(definition["pack_version"], "version-2")
        self.assertFalse(definition["enabled"])                       # 用户状态保留
        self.assertEqual(definition["name"], "服装大片 · 胶片暗房")    # 定义被刷新
        self.assertIn(os.path.abspath(self.installed_dir()), definition["skill_prompt"])
        self.assertEqual(Path(user_config).read_text(encoding="utf-8"),
                         '{"api_key": "user-filled-key"}')            # 用户 config.json 不动
        self.assertFalse(skill["enabled"])

    def test_missing_installed_dir_is_repaired(self):
        registry.load_skills()
        shutil.rmtree(self.installed_dir())
        skill = self.find()
        self.assertIsNotNone(skill)
        self.assertTrue(os.path.isfile(os.path.join(self.installed_dir(), "SKILL.md")))


class SyntheticPackTests(PackCase):

    def test_synthetic_pack_uses_manifest_fields(self):
        manifest = {"display_name": "演示技能", "category": "测试类", "icon": "film", "tags": ["a", "b"]}
        write_pack(self.packs_dir, "demo-skill", manifest=manifest)
        with self.use_packs(self.packs_dir):
            skill = self.find("demo-skill")
        self.assertIsNotNone(skill)
        self.assertEqual(skill["name"], "演示技能")
        self.assertEqual(skill["category"], "测试类")
        self.assertEqual(skill["icon"], "film")
        self.assertEqual(skill["tags"], ["a", "b"])
        self.assertEqual(skill["skill_type"], "system")
        self.assertEqual(skill["builtin_pack"], "demo-skill")

    def test_pack_without_manifest_uses_defaults(self):
        write_pack(self.packs_dir, "plain-skill")
        with self.use_packs(self.packs_dir):
            skill = self.find("plain-skill")
        self.assertEqual(skill["name"], "plain-skill")
        self.assertEqual(skill["category"], "内置技能")
        self.assertEqual(skill["tags"], [])

    def test_executable_bit_is_preserved(self):
        pack = write_pack(self.packs_dir, "exec-skill",
                          files={"scripts/run.py": "print('hi')\n"})
        script = pack / "scripts" / "run.py"
        script.chmod(0o755)
        with self.use_packs(self.packs_dir):
            self.find("exec-skill")
        installed = os.path.join(self.skills_dir(), "exec-skill", "scripts", "run.py")
        self.assertTrue(os.path.isfile(installed))
        self.assertTrue(os.stat(installed).st_mode & stat.S_IXUSR)

    def test_nested_directories_are_copied(self):
        write_pack(self.packs_dir, "nested-skill",
                   files={"references/deep/styles.md": "风格\n", "profiles/a.json": "{}\n"})
        with self.use_packs(self.packs_dir):
            self.find("nested-skill")
        for rel in ("references/deep/styles.md", "profiles/a.json", "SKILL.md"):
            self.assertTrue(os.path.isfile(os.path.join(self.skills_dir(), "nested-skill", rel)), rel)


class BrokenPackTests(PackCase):

    def test_broken_skill_md_is_skipped(self):
        broken = Path(self.packs_dir, "broken-pack")
        broken.mkdir(parents=True)
        (broken / "SKILL.md").write_text("---\nname: Bad Name!\n---\n正文", encoding="utf-8")
        with self.use_packs(self.packs_dir):
            skills = registry.load_skills()                            # 不能抛
        self.assertEqual(skills, [])
        self.assertFalse(os.path.exists(os.path.join(self.skills_dir(), "broken-pack")))

    def test_pack_without_skill_md_is_ignored(self):
        os.makedirs(os.path.join(self.packs_dir, "empty-pack"), exist_ok=True)
        Path(self.packs_dir, "empty-pack", "README.md").write_text("hi", encoding="utf-8")
        with self.use_packs(self.packs_dir):
            self.assertEqual(registry.load_skills(), [])

    def test_missing_packs_dir_is_fine(self):
        with mock.patch.object(registry, "_BUILTIN_PACKS_DIR", os.path.join(self.root, "nope")):
            self.assertEqual(registry.load_skills(), [])

    def test_broken_pack_does_not_hide_good_one(self):
        write_pack(self.packs_dir, "good-skill")
        broken = Path(self.packs_dir, "zz-broken")
        broken.mkdir(parents=True)
        (broken / "SKILL.md").write_text("---\nname: nope\n---\n", encoding="utf-8")
        with self.use_packs(self.packs_dir):
            ids = [item["id"] for item in registry.load_skills()]
        self.assertEqual(ids, ["good-skill"])


class PublicSkillTests(PackCase):

    def test_public_skill_exposes_builtin_pack_marker(self):
        skill = self.find()
        public = registry.public_skill(skill, kind="skill")
        self.assertEqual(public["builtin_pack"], SKILL_ID)
        self.assertEqual(public["skill_type"], "system")
        self.assertNotIn("pack_version", public)                      # 内部字段不外泄


if __name__ == "__main__":
    unittest.main()
