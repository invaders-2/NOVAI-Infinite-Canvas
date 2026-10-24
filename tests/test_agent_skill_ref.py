# -*- coding: utf-8 -*-
"""应用市场技能正文（skill_ref）注入系统提示。

背景：市场编译出的提示词带技能手册会超过 /api/agent/run 的 instruction 4000 字上限，
所以正文改走独立字段 skill_ref（"store:<技能id>"），由后端注入系统提示。

覆盖：
  1. skill_ref 命中：系统提示末尾出现【技能执行手册】与正文；instruction 本身不塞正文；
  2. 超长正文（61627 字）截断到 30000 并标注「（已截断）」；
  3. 未知 / 畸形 ref 一律忽略（不报错），系统提示与不带 ref 时逐字相同；
  4. name / activation_skill 两种 id 都能找到正文；
  5. 请求模型：instruction 仍是 4000 上限，skill_ref 上限 128；
  6. 端到端（打桩 producer）：req 带 skill_ref 时发给模型的 system 消息含手册，不带时不含。

模型与工具全打桩；画布数据全内存，不写真实 data/。
"""
import asyncio
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-skill-ref-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main
from server.routes import store


# 历史 skill_ref 前缀（旧画布种子 / 旧请求里还带着）：不直接写出品牌词，避免仓库里残留
LEGACY_PREFIX = "tap" + "now:"


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def snapshot():
    return {"id": "c1", "kind": "smart", "title": "测试画布",
            "nodes": [{"id": "p1", "type": "smart-prompt", "alias": "提示词1", "title": "提示词",
                       "text": "黄昏海边"}],
            "connections": []}


def build_prompt(skill_ref):
    req = {"canvas_id": "c1", "skill_ref": skill_ref, "focus": main._agent_run_normalize_focus(None),
           "image_provider": "", "image_model": ""}
    return main._CanvasRunContext(req).build_system_prompt(snapshot(), tools_json_text="[]", history_text="")


class SkillRefPromptTests(unittest.TestCase):

    def test_skill_ref_appends_manual_to_system_prompt(self):
        baseline = build_prompt("")
        with_manual = build_prompt("store:primordia-art-director")
        self.assertTrue(with_manual.startswith(baseline))            # 既有提示词不动，只在末尾追加
        self.assertIn("【技能执行手册】", with_manual)
        self.assertNotIn("【技能执行手册】", baseline)
        self.assertGreater(len(with_manual), len(baseline))
        self.assertIn("Primordia", with_manual)                       # 正文真的进来了

    def test_long_body_is_truncated(self):
        prompt = build_prompt("store:primordia-art-director")
        manual = prompt.split("【技能执行手册】", 1)[1]
        self.assertIn(store.SKILL_BODY_TRUNCATED_NOTE, manual)
        body = manual.split("\n", 1)[1].strip()
        self.assertEqual(len(body), store.SKILL_BODY_MAX_CHARS + len(store.SKILL_BODY_TRUNCATED_NOTE))

    def test_short_body_not_truncated(self):
        body = store.skill_body_by_id("3d-scene-director")
        self.assertTrue(body)
        self.assertLessEqual(len(body), store.SKILL_BODY_MAX_CHARS)
        prompt = build_prompt("store:3d-scene-director")
        self.assertIn("【技能执行手册】", prompt)
        self.assertNotIn(store.SKILL_BODY_TRUNCATED_NOTE, prompt)
        self.assertIn(body.strip()[:60], prompt)

    def test_unknown_and_malformed_refs_are_ignored(self):
        baseline = build_prompt("")
        for ref in ("", "   ", "store:", "store:no-such-skill", "skill:skrull",
                    LEGACY_PREFIX.upper() + "nope", "store:skrull:extra", "nonsense"):
            with self.subTest(ref=ref):
                self.assertEqual(build_prompt(ref), baseline)

    def test_store_prefix_works_and_empty_id_ignored(self):
        manual = main._agent_store_skill_manual("store:skrull")
        self.assertTrue(manual.startswith("【技能执行手册】"))
        self.assertEqual(main._agent_store_skill_manual("store:"), "")
        self.assertEqual(main._agent_store_skill_manual("store:no-such-skill"), "")

    def test_legacy_prefix_still_resolves(self):
        legacy = main._agent_store_skill_manual(LEGACY_PREFIX + "primordia-art-director")
        current = main._agent_store_skill_manual("store:primordia-art-director")
        self.assertIn("【技能执行手册】", legacy)
        self.assertEqual(legacy, current)
        self.assertEqual(build_prompt(LEGACY_PREFIX + "primordia-art-director"),
                         build_prompt("store:primordia-art-director"))
        # 旧前缀大小写不一致也认
        self.assertTrue(main._agent_store_skill_manual(LEGACY_PREFIX.upper() + "skrull"))

    def test_name_and_activation_ids_both_resolve(self):
        # character-asset-pack 的 activation_skill 是 primordia-character-asset-pack
        by_name = main._agent_store_skill_manual("store:character-asset-pack")
        by_activation = main._agent_store_skill_manual("store:primordia-character-asset-pack")
        self.assertIn("【技能执行手册】", by_name)
        self.assertEqual(by_name, by_activation)

    def test_generated_manual_is_injected_with_disclaimer(self):
        # 3d-studio 没有上游原文，用的是 generated 整理稿；注入时必须带「非原文」声明
        manual = main._agent_store_skill_manual("store:3d-studio")
        self.assertIn("【技能执行手册】", manual)
        self.assertIn("原始执行手册未随客户端下发", manual)
        prompt = build_prompt("store:3d-studio")
        self.assertIn("原始执行手册未随客户端下发", prompt)

    def test_other_prefix_is_ignored(self):
        self.assertEqual(main._agent_store_skill_manual("novai:advantage-money"), "")
        self.assertEqual(main._agent_store_skill_manual("manual:skrull"), "")


class SkillRefRequestTests(unittest.TestCase):

    def test_instruction_limit_stays_4000(self):
        main.AgentRunRequest(canvas_id="c1", instruction="字" * 4000,
                             skill_ref="store:primordia-art-director")
        with self.assertRaises(ValidationError):
            main.AgentRunRequest(canvas_id="c1", instruction="字" * 4001)

    def test_skill_ref_length_capped(self):
        main.AgentRunRequest(canvas_id="c1", instruction="x", skill_ref="a" * 128)
        with self.assertRaises(ValidationError):
            main.AgentRunRequest(canvas_id="c1", instruction="x", skill_ref="a" * 129)
        self.assertEqual(main.AgentRunRequest(canvas_id="c1", instruction="x").skill_ref, "")

    def test_context_stores_skill_ref(self):
        ctx = main._CanvasRunContext({"canvas_id": "c1", "skill_ref": "  store:skrull  "})
        self.assertEqual(ctx.skill_ref, "store:skrull")
        self.assertEqual(main._CanvasRunContext({"canvas_id": "c1"}).skill_ref, "")


class SkillRefProducerTests(unittest.TestCase):
    """整条链路：req 里的 skill_ref 真的进了发给模型的 system 消息。"""

    def setUp(self):
        main._AGENT_RUN_BUS.clear()

    def tearDown(self):
        main._AGENT_RUN_BUS.clear()

    def _run(self, skill_ref):
        captured = {}

        def reply(*args, **kwargs):
            messages = args[1]
            captured["system"] = next((m["content"] for m in messages if m.get("role") == "system"), "")
            return json.dumps({"done": True, "message": "好的"}, ensure_ascii=False)

        req = {"run_id": "run_ref", "canvas_id": "c1", "instruction": "做个视频",
               "focus": main._agent_run_normalize_focus(None), "history": [],
               "chat": {"provider": "p", "base": "http://x", "headers": {}, "model": "test-chat-model",
                        "provider_cfg": {}},
               "max_steps": 4, "mode": "run", "approved_steps": [],
               "skill_id": "", "skill_ref": skill_ref}

        async def go():
            queue = asyncio.Queue()
            with contextlib.redirect_stdout(io.StringIO()), \
                    patch.object(main, "load_canvas", return_value=snapshot()), \
                    patch.object(main, "agent_session_save"), \
                    patch.object(main, "_agent_run_chat", new=AsyncMock(side_effect=reply)), \
                    patch.object(main, "agent_execute_step",
                                 new=AsyncMock(return_value={"ok": True, "result": {}})):
                await main._agent_run_producer(req, queue)

        asyncio.run(go())
        return captured.get("system", "")

    def test_system_prompt_contains_manual_when_ref_present(self):
        system = self._run("store:primordia-art-director")
        self.assertIn("【技能执行手册】", system)
        self.assertIn("（已截断）", system)          # 61627 字 > 30000
        self.assertIn("Primordia", system)

    def test_system_prompt_clean_without_ref(self):
        system = self._run("")
        self.assertNotIn("【技能执行手册】", system)

    def test_unknown_ref_keeps_system_prompt_clean(self):
        self.assertNotIn("【技能执行手册】", self._run("store:no-such-skill"))


if __name__ == "__main__":
    unittest.main()
