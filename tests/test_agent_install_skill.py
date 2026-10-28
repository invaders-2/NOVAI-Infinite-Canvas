# -*- coding: utf-8 -*-
"""Agent install_skill：确认门槛、API 安装与安装后激活。"""
import asyncio
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

_TMP = tempfile.mkdtemp(prefix="novai-install-skill-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


CLIENT = TestClient(main.app)
MARKDOWN = "---\nname: github-test-skill\ndescription: 测试技能\nmetadata:\n  display_name: GitHub 测试技能\n---\n只回答测试内容"
FETCHED = {
    "markdown": MARKDOWN,
    "repository": "acme/tools",
    "ref": "main",
    "path": "SKILL.md",
    "source_url": "https://raw.githubusercontent.com/acme/tools/main/SKILL.md",
}


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


class AgentInstallSkillTests(unittest.TestCase):

    def setUp(self):
        path = os.path.join(main._skills_registry.skills_dir(), "github-test-skill.json")
        if os.path.exists(path):
            os.remove(path)

    def test_registered_and_requires_confirmation(self):
        entry = main.AGENT_TOOLS.get("install_skill")
        self.assertIsNotNone(entry)
        self.assertIs(entry["mutates_canvas"], False)
        self.assertNotIn("install_skill", main.AGENT_FREE_TOOLS)
        self.assertTrue(__import__("inspect").iscoroutinefunction(main._agent_tool_install_skill_run))
        gate = main.agent_plan_confirmation_needed([{"tool": "install_skill", "args": {"url": "https://github.com/acme/tools"}}])
        self.assertTrue(gate["needed"])
        with self.assertRaises(main.AgentToolError):
            main._agent_tool_install_skill_validate({"url": ""})

    @mock.patch("server.routes.agents.github_install.fetch_skill_markdown", return_value=FETCHED)
    def test_api_installs_github_markdown(self, fetch):
        response = CLIENT.post("/api/skills/import-github", json={"url": "https://github.com/acme/tools"})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["created"])
        self.assertEqual(body["repository"], "acme/tools")
        self.assertEqual(body["skill"]["id"], "github-test-skill")
        fetch.assert_called_once_with("https://github.com/acme/tools", path="", ref="")

    @mock.patch("server.routes.agents.github_install.fetch_skill_markdown", return_value=FETCHED)
    def test_agent_installs_and_activates(self, fetch):
        async def go():
            return await main.agent_execute_step("install_skill", {
                "url": "https://github.com/acme/tools/tree/main/SKILL.md",
                "overwrite": True,
            })
        result = asyncio.run(go())
        self.assertTrue(result["ok"], result)
        payload = result["result"]
        self.assertEqual(payload["repository"], "acme/tools")
        self.assertEqual(payload["skill"]["id"], "github-test-skill")
        self.assertEqual(payload["activation"]["name"], "github-test-skill")
        self.assertIn("只回答测试内容", payload["activation"]["text"])
        self.assertFalse(payload["activation"]["already_loaded"])
        fetch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
