# -*- coding: utf-8 -*-
"""画布助手挂技能（skill_id）：system prompt 末尾追加技能说明，坏技能一律 400。

契约：
  - 请求顶层可选 skill_id（str，缺省 ""，最长 64）
  - 只有 registry 里查得到且 enabled=true 才应用；否则 HTTP 400「技能不存在或未启用：<id>」
  - 应用方式：把技能段落追加到 system prompt 末尾，不动既有提示词结构
  - skill_prompt 超过 20000 字符截断并标注

技能都写在临时数据目录里，不碰仓库 data/；不调模型、不起服务。
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-skill-prompt-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


# 技能数据目录单独隔离：写在共享的 data/skills 里会污染同进程的其他用例（例如目录恰好 16 个技能的断言）
_SKILL_DATA = tempfile.mkdtemp(prefix="novai-skill-store-")
main._skills_registry.set_data_dir(_SKILL_DATA)


def tearDownModule():
    main._skills_registry.set_data_dir(main.DATA_DIR)   # 还回去，别影响后续用例
    shutil.rmtree(_SKILL_DATA, ignore_errors=True)
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


_UNSET = object()
SKILL_DIR = os.path.join(_SKILL_DATA, "skills")


def snapshot():
    return {"id": "c1", "kind": "smart", "title": "测试画布",
            "nodes": [{"id": "p1", "type": "smart-prompt", "alias": "提示词1", "title": "提示词",
                       "text": "黄昏海边"}],
            "connections": []}


def build_prompt(skill_id=_UNSET, canvas=None):
    req = {"canvas_id": "c1", "focus": main._agent_run_normalize_focus(None),
           "image_provider": "", "image_model": ""}
    if skill_id is not _UNSET:
        req["skill_id"] = skill_id
    ctx = main._CanvasRunContext(req)
    return ctx.build_system_prompt(canvas or snapshot(), tools_json_text="[]", history_text="")


def write_skill(skill_id, prompt="技能正文", enabled=True, name="测试技能", usage=""):
    os.makedirs(SKILL_DIR, exist_ok=True)
    payload = {"id": skill_id, "name": name, "skill_prompt": prompt,
               "usage_instruction": usage, "enabled": enabled}
    with open(os.path.join(SKILL_DIR, skill_id + ".json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    return skill_id


class NoSkillTests(unittest.TestCase):
    """不挂技能时，输出必须与改动前逐字一致（不能有任何附带影响）。"""

    def test_skill_id_absent_blank_and_empty_are_identical(self):
        absent = build_prompt(_UNSET)
        self.assertEqual(absent, build_prompt(""))
        self.assertEqual(absent, build_prompt("   "))
        self.assertNotIn("【本次运行的技能】", absent)
        self.assertNotIn("以下技能说明必须遵守", absent)

    def test_existing_sections_still_there(self):
        text = build_prompt(_UNSET)
        for marker in ("工具选择", "canvas_cli", "输出要求", "用户当前没有选中任何节点"):
            self.assertIn(marker, text)

    def test_context_stores_skill_id(self):
        self.assertEqual(main._CanvasRunContext({"canvas_id": "c1", "skill_id": "  abc  "}).skill_id, "abc")
        self.assertEqual(main._CanvasRunContext({"canvas_id": "c1"}).skill_id, "")


class SkillPromptTests(unittest.TestCase):

    def test_block_appended_at_the_end(self):
        sid = write_skill("novai-test-skill-a", name="电商详情页",
                          prompt="先用 read_table 读表，再写三段结论。",
                          usage="动手前先向用户确认口径。")
        text = build_prompt(sid)
        tail = main._agent_skill_prompt_block(sid)
        self.assertTrue(text.endswith(tail))
        self.assertTrue(tail.startswith("\n\n【本次运行的技能】电商详情页（技能 ID：novai-test-skill-a）"))
        self.assertIn("动手前先向用户确认口径。", tail)
        self.assertIn("—— 以下技能说明必须遵守 ——", tail)
        self.assertIn("先用 read_table 读表，再写三段结论。", tail)
        self.assertTrue(text.endswith("\n"))

    def test_usage_instruction_is_optional(self):
        sid = write_skill("novai-test-skill-b", prompt="只有正文，没有 usage_instruction。")
        tail = main._agent_skill_prompt_block(sid)
        self.assertTrue(build_prompt(sid).endswith(tail))
        lines = tail.strip("\n").split("\n")
        self.assertEqual(lines[0], "【本次运行的技能】测试技能（技能 ID：novai-test-skill-b）")
        self.assertEqual(lines[1], "—— 以下技能说明必须遵守 ——")
        self.assertEqual(lines[2], "只有正文，没有 usage_instruction。")

    def test_missing_skill_raises_400(self):
        with self.assertRaises(main.HTTPException) as caught:
            build_prompt("no-such-skill")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("技能不存在或未启用", str(caught.exception.detail))
        self.assertIn("no-such-skill", str(caught.exception.detail))

    def test_blank_skill_id_helper_raises_400(self):
        with self.assertRaises(main.HTTPException) as caught:
            main._agent_skill_prompt_block("")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("<空>", str(caught.exception.detail))

    def test_disabled_skill_raises_400(self):
        sid = write_skill("novai-test-skill-off", enabled=False)
        with self.assertRaises(main.HTTPException) as caught:
            build_prompt(sid)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn(sid, str(caught.exception.detail))

    def test_long_prompt_is_truncated(self):
        sid = write_skill("novai-test-skill-long", prompt="字" * 30000)
        text = build_prompt(sid)
        self.assertIn(main.AGENT_SKILL_TRUNCATED_NOTE, text)
        self.assertNotIn("字" * 30000, text)
        body = text.split("—— 以下技能说明必须遵守 ——\n", 1)[1]
        body = body[:body.index(main.AGENT_SKILL_TRUNCATED_NOTE)]
        self.assertEqual(len(body), main.AGENT_SKILL_PROMPT_MAX_CHARS)
        # 长度受控：基线 + 标题/说明 + 20000 字上限 + 截断标记
        self.assertLess(len(text), len(build_prompt("")) + 21000)

    def test_endpoint_rejects_unknown_skill_before_streaming(self):
        """坏技能必须在开流之前就 400，而不是让前端先收到 200 再吃一个 error 事件。"""
        payload = main.AgentRunRequest(canvas_id="c1", instruction="做个电商详情页",
                                       skill_id="no-such-skill")
        with self.assertRaises(main.HTTPException) as caught:
            asyncio.run(main.agent_run(payload, object()))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("no-such-skill", str(caught.exception.detail))

    def test_skill_id_length_capped_by_request_model(self):
        with self.assertRaises(ValidationError):
            main.AgentRunRequest(canvas_id="c1", instruction="x", skill_id="a" * 65)
        ok = main.AgentRunRequest(canvas_id="c1", instruction="x", skill_id="a" * 64)
        self.assertEqual(len(ok.skill_id), 64)
        self.assertEqual(main.AgentRunRequest(canvas_id="c1", instruction="x").skill_id, "")


if __name__ == "__main__":
    unittest.main()
