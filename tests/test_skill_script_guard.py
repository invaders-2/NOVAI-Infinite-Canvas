# -*- coding: utf-8 -*-
"""技能安全加固：导入默认不启用、含脚本标记、全局禁止运行技能脚本。

都写在临时数据目录里，不碰仓库 data/；不调模型、不起服务。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-skill-guard-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from server.routes import agents as agent_routes  # noqa: E402
from server.skills import registry  # noqa: E402

CLIENT = TestClient(main.app)


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def markdown(name="guard-skill", extra="", body="守护测试正文"):
    return "---\nname: %s\ndescription: 守护测试\n%s---\n%s" % (name, extra, body)


class ImportDefaultsTests(unittest.TestCase):

    def setUp(self):
        self.folder = registry.skills_dir()
        os.makedirs(self.folder, exist_ok=True)
        self.ids = []

    def tearDown(self):
        for sid in self.ids:
            for path in (os.path.join(self.folder, sid + ".json"), os.path.join(self.folder, sid)):
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=True)
                elif os.path.isfile(path):
                    os.remove(path)

    def import_md(self, text, overwrite=True):
        made = agent_routes._import_skill_md(text, overwrite)
        self.ids.append(made["skill"]["id"])
        return made

    def definition(self, sid):
        with open(os.path.join(self.folder, sid + ".json"), encoding="utf-8") as fh:
            return json.load(fh)

    def test_new_import_is_disabled(self):
        made = self.import_md(markdown("guard-default"))
        self.assertFalse(made["skill"]["enabled"])
        self.assertFalse(self.definition("guard-default")["enabled"])

    def test_metadata_enabled_true_is_respected(self):
        made = self.import_md(markdown("guard-enabled", extra="metadata:\n  enabled: true\n"))
        self.assertTrue(made["skill"]["enabled"])
        self.assertTrue(self.definition("guard-enabled")["enabled"])

    def test_overwrite_keeps_existing_enabled_state(self):
        self.import_md(markdown("guard-keep"))
        resp = CLIENT.patch("/api/skills/guard-keep", json={"enabled": True})
        self.assertEqual(resp.status_code, 200, resp.text)
        made = self.import_md(markdown("guard-keep", body="更新后的正文"))
        self.assertTrue(made["skill"]["enabled"])
        self.assertTrue(self.definition("guard-keep")["enabled"])


class PackageScriptsTests(unittest.TestCase):

    def setUp(self):
        self.folder = registry.skills_dir()
        self.sid = "guard-with-scripts"
        self.pkg = os.path.join(self.folder, self.sid)
        os.makedirs(os.path.join(self.pkg, "scripts"), exist_ok=True)
        with open(os.path.join(self.pkg, "scripts", "build.py"), "w", encoding="utf-8") as fh:
            fh.write("print('ok')\n")
        with open(os.path.join(self.folder, self.sid + ".json"), "w", encoding="utf-8") as fh:
            json.dump({"id": self.sid, "name": "带脚本的技能", "description": "d",
                       "skill_prompt": "正文", "enabled": False, "available": True,
                       "skill_type": "mine"}, fh, ensure_ascii=False)

    def tearDown(self):
        shutil.rmtree(self.pkg, ignore_errors=True)
        path = os.path.join(self.folder, self.sid + ".json")
        if os.path.isfile(path):
            os.remove(path)

    def test_public_skill_reports_scripts(self):
        skill = registry.get_skill(self.sid)
        public = registry.public_skill(skill, kind="skill")
        self.assertTrue(public["has_scripts"])
        self.assertEqual(public["scripts"], ["scripts/build.py"])

    def test_public_skill_without_package_has_no_scripts(self):
        public = registry.public_skill({"id": "no-package-skill"}, kind="skill")
        self.assertFalse(public["has_scripts"])
        self.assertEqual(public["scripts"], [])

    def test_global_switch_blocks_script_run(self):
        with mock.patch.object(main, "load_settings", return_value={"skill_scripts_disabled": True}):
            with self.assertRaises(main.AgentToolError) as ctx:
                main._agent_tool_run_skill_script_validate({"skill": self.sid, "script": "scripts/build.py"})
        self.assertEqual(ctx.exception.code, "skill_script_disabled")
        self.assertIn("设置", str(ctx.exception))

    def test_global_switch_open_allows_validate(self):
        with mock.patch.object(main, "load_settings", return_value={"skill_scripts_disabled": False}):
            args = main._agent_tool_run_skill_script_validate({"skill": self.sid, "script": "scripts/build.py"})
        self.assertEqual(args["script"], "scripts/build.py")


class SettingsEndpointTests(unittest.TestCase):

    def test_put_and_get_switch(self):
        path = os.path.join(_TMP, "settings-guard.json")
        if os.path.isfile(path):
            os.remove(path)
        with mock.patch.object(main, "SETTINGS_FILE", path):
            resp = CLIENT.put("/api/settings/skill-scripts", json={"disabled": True})
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertTrue(resp.json()["disabled"])
            self.assertTrue(CLIENT.get("/api/settings/skill-scripts").json()["disabled"])
            resp = CLIENT.put("/api/settings/skill-scripts", json={"disabled": False})
            self.assertFalse(resp.json()["disabled"])
            self.assertFalse(CLIENT.get("/api/settings/skill-scripts").json()["disabled"])
            with open(path, encoding="utf-8") as fh:
                self.assertFalse(json.load(fh)["skill_scripts_disabled"])


if __name__ == "__main__":
    unittest.main()
