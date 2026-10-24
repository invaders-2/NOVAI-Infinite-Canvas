# -*- coding: utf-8 -*-
"""技能按需加载：系统提示只给索引；activate_skill 返回全文、截断、幂等、未知技能不崩。

用真实技能注册表（临时数据目录，会 seed 内置技能）。
"""
import asyncio
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

_TMP = tempfile.mkdtemp(prefix="novai-activate-skill-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main  # noqa: E402

SKILLS = main._skills_registry
MAX_CHARS = main.AGENT_SKILL_PROMPT_MAX_CHARS
TRUNC_NOTE = main.AGENT_SKILL_TRUNCATED_NOTE


def setUpModule():
    SKILLS.load_skills()                 # 先在临时目录 seed 内置技能


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def snapshot():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": [], "connections": []}


def build_prompt(skill_id=""):
    req = {"canvas_id": "c1", "skill_id": skill_id,
           "focus": main._agent_run_normalize_focus(None),
           "image_provider": "", "image_model": ""}
    return main._CanvasRunContext(req).build_system_prompt(snapshot(), "[]", "")


def write_custom_skill(skill_id, prompt_text, enabled=True):
    folder = SKILLS.skills_dir()
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "%s.json" % skill_id)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"id": skill_id, "name": "自定义技能", "description": "测试用技能",
                   "skill_prompt": prompt_text, "enabled": enabled, "available": True}, fh, ensure_ascii=False)
    return path


class SkillIndexPromptTests(unittest.TestCase):

    def test_index_mode_lists_enabled_skills_and_instruction(self):
        skills = [s for s in SKILLS.load_skills() if s.get("enabled")]
        prompt = build_prompt("")
        self.assertIn("【技能索引】", prompt)
        self.assertIn("activate_skill(name)", prompt)
        listed = [line for line in prompt.splitlines() if line.startswith("- ")]
        self.assertEqual(len(listed), min(len(skills), main.AGENT_SKILL_INDEX_MAX))
        self.assertGreaterEqual(len(listed), 2)

    def test_single_skill_keeps_full_injection(self):
        skill = next(s for s in SKILLS.load_skills() if s.get("enabled") and s.get("skill_prompt"))
        prompt = build_prompt(skill["id"])
        self.assertNotIn("【技能索引】", prompt)
        self.assertIn(skill["skill_prompt"][:200], prompt)

    def test_disabled_skill_not_indexed(self):
        write_custom_skill("disabled-index-skill", "不会被列出来", enabled=False)
        try:
            prompt = build_prompt("")
            self.assertNotIn("disabled-index-skill", prompt)
        finally:
            os.remove(os.path.join(SKILLS.skills_dir(), "disabled-index-skill.json"))


class ActivateSkillToolTests(unittest.TestCase):

    def test_tool_registered_and_read_only(self):
        entry = main.AGENT_TOOLS.get("activate_skill")
        self.assertIsNotNone(entry)
        self.assertIs(entry["mutates_canvas"], False)
        self.assertIn("activate_skill", main.AGENT_FREE_TOOLS)
        catalog = {item["name"]: item for item in main._agent_build_tools_catalog()}
        self.assertIn("activate_skill", catalog)
        self.assertEqual(catalog["activate_skill"]["schema"]["required"], ["name"])
        gate = main.agent_plan_confirmation_needed([{"tool": "activate_skill", "args": {"name": "x"}}])
        self.assertFalse(gate["needed"])

    def test_returns_full_prompt_with_truncation(self):
        long_prompt = "技" * (MAX_CHARS + 5000)
        path = write_custom_skill("trunc-skill", long_prompt)
        try:
            async def go():
                return await main.agent_execute_step("activate_skill", {"name": "trunc-skill"})
            result = asyncio.run(go())
            self.assertTrue(result["ok"], result)
            payload = result["result"]
            self.assertTrue(payload["truncated"])
            self.assertEqual(payload["characters"], MAX_CHARS + len(TRUNC_NOTE))
            self.assertEqual(len(payload["text"]), MAX_CHARS + len(TRUNC_NOTE))
            self.assertTrue(payload["text"].endswith(TRUNC_NOTE))
            self.assertFalse(payload["already_loaded"])
        finally:
            os.remove(path)

    def test_repeat_call_is_idempotent_in_same_run(self):
        path = write_custom_skill("idem-skill", "短正文")
        try:
            async def go():
                first = await main.agent_execute_step("activate_skill", {"name": "idem-skill"})
                second = await main.agent_execute_step("activate_skill", {"name": "idem-skill"})
                return first, second
            first, second = asyncio.run(go())
            self.assertTrue(first["ok"])
            self.assertTrue(second["ok"])
            self.assertFalse(first["result"]["already_loaded"])
            self.assertTrue(second["result"]["already_loaded"])
            self.assertEqual(second["result"]["characters"], 0)
            self.assertIn("已加载", second["result"]["text"])
        finally:
            os.remove(path)

    def test_fresh_run_context_reloads(self):
        path = write_custom_skill("fresh-skill", "短正文")
        try:
            async def once():
                return await main.agent_execute_step("activate_skill", {"name": "fresh-skill"})
            first = asyncio.run(once())
            second = asyncio.run(once())          # 新的一次 run（新 task/context）应重新加载
            self.assertFalse(first["result"]["already_loaded"])
            self.assertFalse(second["result"]["already_loaded"])
        finally:
            os.remove(path)

    def test_unknown_skill_reports_error_without_raising(self):
        async def go():
            return await main.agent_execute_step("activate_skill", {"name": "no-such-skill"})
        result = asyncio.run(go())
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "skill_not_found")
        self.assertIn("不存在或未启用", result["error"])

    def test_empty_name_is_invalid_args(self):
        async def go():
            return await main.agent_execute_step("activate_skill", {})
        result = asyncio.run(go())
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "invalid_args")


if __name__ == "__main__":
    unittest.main()
