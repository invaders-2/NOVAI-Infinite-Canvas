# -*- coding: utf-8 -*-
"""技能级生成闸门：挂着「动作复刻换产品」时，缺分析节点或用户没确认方案就拒绝 generate_image / generate_video。"""
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

_TMP = tempfile.mkdtemp(prefix="novai-skill-gate-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402

SKILL = "product-motion-recast"


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def text_node(nid, text):
    return {"id": nid, "kind": "text", "text": text}


class SkillGateTests(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="gate-case-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        patcher = mock.patch.object(main, "_agent_skill_gate_path",
                                    return_value=os.path.join(self.dir, "gates.json"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.canvas = {"nodes": []}
        p2 = mock.patch.object(main, "load_canvas", side_effect=lambda cid: self.canvas)
        p2.start()
        self.addCleanup(p2.stop)
        self.tokens = [main._AGENT_RUN_CANVAS_ID.set("cv1"), main._AGENT_RUN_SKILL_GATE.set("")]
        self.addCleanup(lambda: [main._AGENT_RUN_SKILL_GATE.reset(self.tokens[1]),
                                 main._AGENT_RUN_CANVAS_ID.reset(self.tokens[0])])

    def check(self, tool="generate_video"):
        return main._agent_skill_gate_check(tool, {"canvas_id": "cv1"})

    def test_no_gate_without_skill(self):
        self.assertIsNone(self.check())

    def test_blocks_until_nodes_and_confirmation(self):
        main._agent_skill_gate_activate(SKILL)
        blocked = self.check("generate_image")
        self.assertEqual(blocked["code"], "skill_gate_blocked")
        self.assertIn("产品结构对比与节拍映射", blocked["error"])
        self.assertIn("ask_user", blocked["error"])
        self.assertIsNone(main._agent_skill_gate_check("analyze_video", {"canvas_id": "cv1"}))

        self.canvas["nodes"] = [text_node("a", "产品结构对比与节拍映射\n..."), text_node("b", "分镜表\n段1…")]
        blocked = self.check()
        self.assertNotIn("产品结构对比与节拍映射」", blocked["error"])
        self.assertIn("ask_user", blocked["error"])

        # 模型问了方案 → 下一次运行用户回答「按方案做」才放行
        main._agent_skill_gate_record_ask([{"question": "按这个方案做吗？", "options": ["按方案做", "我来改方案"]}])
        self.assertIsNotNone(self.check())
        ctx = types.SimpleNamespace(canvas_id="cv1", skill_id="")
        main._agent_skill_gate_begin(ctx, "按方案做")
        self.assertIsNone(self.check())

    def test_rejection_keeps_blocking(self):
        main._agent_skill_gate_activate(SKILL)
        self.canvas["nodes"] = [text_node("a", "产品结构对比与节拍映射"), text_node("b", "分镜表")]
        main._agent_skill_gate_record_ask([{"question": "确认方案？"}])
        main._agent_skill_gate_begin(types.SimpleNamespace(canvas_id="cv1", skill_id=""), "我来改方案，第二段别重做")
        blocked = self.check()
        self.assertIn("没有确认", blocked["error"])

    def test_model_text_cannot_confirm(self):
        main._agent_skill_gate_activate(SKILL)
        self.canvas["nodes"] = [text_node("a", "产品结构对比与节拍映射"), text_node("b", "分镜表 用户已确认")]
        self.assertIsNotNone(self.check())

    def test_named_in_text_attaches_and_injects(self):
        ctx = types.SimpleNamespace(canvas_id="cv1", skill_id="", skill_prompt="")
        with mock.patch.object(main._skills_registry, "get_skill",
                               return_value={"id": SKILL, "name": "动作复刻换产品", "enabled": True}):
            main._agent_skill_gate_begin(ctx, "用动作复刻换产品技能，把鞋换成我的")
        self.assertEqual(ctx.skill_id, SKILL)
        self.assertEqual(main._AGENT_RUN_SKILL_GATE.get(), SKILL)
        self.assertIsNotNone(self.check())
        # 下一轮没点名、没选技能：这张画布挂过，闸门照样生效
        main._AGENT_RUN_SKILL_GATE.set("")
        with mock.patch.object(main._skills_registry, "get_skill", return_value={"enabled": True}):
            main._agent_skill_gate_begin(types.SimpleNamespace(canvas_id="cv1", skill_id=""), "继续做")
        self.assertEqual(main._AGENT_RUN_SKILL_GATE.get(), SKILL)

    def test_disabled_skill_name_does_not_attach(self):
        ctx = types.SimpleNamespace(canvas_id="cv2", skill_id="", skill_prompt="")
        with mock.patch.object(main._skills_registry, "get_skill", return_value={"enabled": False}):
            main._agent_skill_gate_begin(ctx, "动作复刻换产品")
        self.assertEqual(main._AGENT_RUN_SKILL_GATE.get(), "")

    def test_later_questions_do_not_revoke_confirmation(self):
        main._agent_skill_gate_activate(SKILL)
        self.canvas["nodes"] = [text_node("a", "产品结构对比与节拍映射"), text_node("b", "分镜表")]
        main._agent_skill_gate_record_ask([{"question": "确认方案？"}])
        main._agent_skill_gate_begin(types.SimpleNamespace(canvas_id="cv1", skill_id=""), "按方案做")
        main._agent_skill_gate_record_ask([{"question": "选哪一版？"}])
        main._agent_skill_gate_begin(types.SimpleNamespace(canvas_id="cv1", skill_id=""), "第二版")
        self.assertIsNone(self.check())

    def test_repeated_block_escalates(self):
        main._AGENT_RUN_GATE_BLOCKS.set([0])
        main._agent_skill_gate_activate(SKILL)
        self.assertNotIn("不要再调用", self.check()["error"])
        self.assertIn("不要再调用任何生成工具", self.check("batch_generate")["error"])

    def test_strong_yes_without_card_confirms_when_nodes_ready(self):
        main._agent_skill_gate_update("cv1", SKILL, attached_at=1.0)
        main._agent_skill_gate_begin(types.SimpleNamespace(canvas_id="cv1", skill_id=""), "按方案继续")
        self.assertIsNotNone(self.check())          # 节点没齐：不算
        self.canvas["nodes"] = [text_node("a", "视频分析与结构对比"), text_node("b", "分镜表")]
        self.assertEqual(main._agent_skill_gate_confirm_only("cv1"), SKILL)
        main._agent_skill_gate_begin(types.SimpleNamespace(canvas_id="cv1", skill_id=""), "好的")
        self.assertIsNotNone(self.check())          # 弱同意不算
        main._agent_skill_gate_begin(types.SimpleNamespace(canvas_id="cv1", skill_id=""), "按方案继续")
        self.assertIsNone(self.check())
        self.assertEqual(main._agent_skill_gate_confirm_only("cv1"), "")

    def test_answer_parser(self):
        self.assertTrue(main._agent_skill_gate_answer_confirms("先只做第一段试试"))
        self.assertTrue(main._agent_skill_gate_answer_confirms("可以，开始吧"))
        self.assertFalse(main._agent_skill_gate_answer_confirms("我来改方案"))
        self.assertFalse(main._agent_skill_gate_answer_confirms(""))

    def test_execute_path_returns_block(self):
        import asyncio
        main._agent_skill_gate_activate(SKILL)
        fn = None
        for name in dir(main):
            if name in ("agent_execute_step", "_agent_execute_tool", "execute_agent_step"):
                fn = getattr(main, name)
        if fn is None:
            self.skipTest("execute entry not exported under known name")
        result = asyncio.run(fn("generate_video", {"canvas_id": "cv1"}))
        self.assertEqual(result.get("code"), "skill_gate_blocked")


if __name__ == "__main__":
    unittest.main()
