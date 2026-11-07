"""画布助手「不要你问我答」：方案文案改成人话（目标 + 为什么这么选 + 预期结果 + 成本），
并把模型给的 assumptions（信息不全时替用户定的默认）作为独立字段交给前端；系统提示不再反问。

覆盖：
  1. 系统提示 / plan 轮的用户提示里不再有问答卡策略，明确「不要反问、自己按默认决定」；
  2. _agent_plan_details 收敛脏 JSON（非 dict、assumptions 脏值、超长、非列表）；
  3. _agent_plan_event 的 summary = 目标 + 为什么 + 预期结果 + 成本提示，assumptions 单独成字段且去重限 3 条；
  4. 没有 reason 时 summary 把假设说清楚；有 reason 时靠 assumptions 字段，不重复；
  5. producer 真链路：mode=plan 时模型返回 intent/reason/assumptions/steps → plan 事件和 done message 都带人话。
"""
import asyncio
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": [], "connections": [],
            "updated_at": 1700000000000}


def chat_config():
    return {"provider": "openai", "base": "https://example.invalid/v1", "headers": {},
            "model": "test-chat-model", "provider_cfg": {}}


def plan_steps():
    return [{"tool": "generate_image",
             "args": {"canvas_id": "c1", "prompt": "主kv海报", "model": "gpt-image-2",
                      "ratio": "9:16", "count": 1, "size": "1024x1536"},
             "description": "新建图片节点并生成海报"}]


def agent_request(instruction="做一张主kv海报，9:16横屏的"):
    return {
        "canvas_id": "c1",
        "instruction": instruction,
        "focus": main._agent_run_normalize_focus(None),
        "history": [],
        "chat": chat_config(),
        "max_steps": 6,
        "mode": "plan",
        "approved_steps": [],
    }


def drain_plan(decision):
    chat = AsyncMock(return_value=json.dumps(decision, ensure_ascii=False))
    execute = AsyncMock(return_value={"ok": True, "result": {}, "message": "执行成功"})

    async def run():
        queue = asyncio.Queue()
        with contextlib.redirect_stdout(io.StringIO()):
            with patch.object(main, "load_canvas", return_value=canvas()), \
                    patch.object(main, "_agent_run_chat", new=chat), \
                    patch.object(main, "agent_session_save"), \
                    patch.object(main, "agent_execute_step", new=execute):
                await main._agent_run_producer(agent_request(), queue)
        chunks = []
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                break
            chunks.append(item)
        return chunks, execute

    chunks, execute = asyncio.run(run())
    events = []
    for chunk in chunks:
        for block in chunk.strip().split("\n\n"):
            if not block or block.startswith(":"):
                continue
            name, data = "message", {}
            for line in block.split("\n"):
                if line.startswith("event: "):
                    name = line[len("event: "):].strip()
                elif line.startswith("data: "):
                    data = json.loads(line[len("data: "):])
            events.append((name, data))
    return events, execute


class NoQuestionPolicyTests(unittest.TestCase):
    def test_system_prompt_no_longer_asks_the_user(self):
        prompt = main._AGENT_RUN_SYSTEM_PROMPT
        self.assertNotIn("```openarc-questions", prompt)
        self.assertIn("不要反问", prompt)
        self.assertIn("自己拿主意", prompt)
        self.assertIn('"assumptions"', prompt)

    def test_plan_mode_user_prompt_requires_decisions_not_questions(self):
        text = main._agent_run_user_prompt("做一张海报", [], 1, 6, 0, "", mode="plan")
        self.assertIn("不要反问用户", text)
        self.assertIn("不要问用户", text)
        self.assertIn("assumptions", text)

    def test_plan_mode_user_prompt_still_asks_for_steps(self):
        text = main._agent_run_user_prompt("做一张海报", [], 1, 6, 0, "", mode="plan")
        self.assertIn("expected_output", text)
        self.assertIn("绝不执行任何工具", text)


class PlanDetailsTests(unittest.TestCase):
    def test_dirty_decision_is_normalized_not_raised(self):
        self.assertEqual(main._agent_plan_details(None),
                         {"intent": "", "reason": "", "expected_output": "", "assumptions": [], "roadmap": []})
        self.assertEqual(main._agent_plan_details("不是对象")["assumptions"], [])
        details = main._agent_plan_details({"intent": 7, "reason": ["不是字符串"],
                                           "assumptions": "只有一句", "expected_output": None})
        self.assertEqual(details["intent"], "7")
        self.assertEqual(details["reason"], "")
        self.assertEqual(details["assumptions"], ["只有一句"])
        self.assertEqual(details["expected_output"], "")

    def test_assumptions_are_deduped_trimmed_and_capped(self):
        details = main._agent_plan_details({"assumptions": [
            "按 9:16 出图", "按 9:16 出图", "  ", "模型用画布惯用的", "只出 1 张", "第四条会被丢掉"]})
        self.assertEqual(details["assumptions"], ["按 9:16 出图", "模型用画布惯用的", "只出 1 张"])
        long_item = "很长" * 200
        self.assertEqual(len(main._agent_plan_details({"assumptions": [long_item]})["assumptions"][0]),
                         main.AGENT_PLAN_ASSUMPTION_CHARS)

    def test_intent_falls_back_to_thought(self):
        self.assertEqual(main._agent_plan_details({"thought": "用户要做海报"})["intent"], "用户要做海报")


class PlanSummaryTests(unittest.TestCase):
    def setUp(self):
        self.steps = plan_steps()
        self.impact = main.agent_plan_impact(self.steps)

    def test_summary_reads_like_a_plan_not_a_counter(self):
        summary = main._agent_plan_summary(self.steps, self.impact, intent="做一张 9:16 的主kv海报",
                                          reason="按你写的 9:16 出竖版，模型用画布的惯用模型",
                                          expected_output="画布上多一个海报图片节点并开始生成")
        self.assertTrue(summary.startswith("做一张 9:16 的主kv海报。"))
        self.assertIn("按你写的 9:16 出竖版", summary)
        self.assertIn("预期结果：画布上多一个海报图片节点并开始生成。", summary)
        self.assertIn("1 次真实生成", summary)        # 成本提示保留
        self.assertIn("1024x1536", summary)

    def test_summary_states_assumptions_when_reason_is_missing(self):
        summary = main._agent_plan_summary(self.steps, self.impact, intent="做一张海报",
                                          assumptions=["按 9:16 出图", "只出 1 张"])
        self.assertIn("我的假设：按 9:16 出图；只出 1 张。", summary)
        self.assertIn("1 次真实生成", summary)

    def test_summary_keeps_old_cost_only_shape_for_plain_calls(self):
        # 老调用方式（不传人话字段）仍然只给成本提示，历史测试与老客户端不受影响
        summary = main._agent_plan_summary(self.steps, self.impact)
        self.assertEqual(summary, main._agent_plan_cost_text(len(self.steps), self.impact))

    def test_plan_event_exposes_reason_and_assumptions(self):
        event = main._agent_plan_event("做一张海报", self.steps, "画布上多一个图片节点",
                                       reason="按 9:16 出竖版",
                                       assumptions=["按 9:16 出图", "只出 1 张"])
        self.assertEqual(event["reason"], "按 9:16 出竖版")
        self.assertEqual(event["assumptions"], ["按 9:16 出图", "只出 1 张"])
        self.assertIn("按 9:16 出竖版", event["summary"])
        self.assertIn("预期结果", event["summary"])


class PlanMessageFromModelTests(unittest.TestCase):
    def test_plan_event_and_done_message_carry_human_text(self):
        events, execute = drain_plan({
            "intent": "做一张 9:16 的主kv海报",
            "reason": "比例按你写的 9:16 来；模型用画布惯用的 gpt-image-2；只出 1 张",
            "assumptions": ["你写「9:16 横屏」有矛盾，我按 9:16 竖版做", "先出一张看效果，满意再扩"],
            "steps": plan_steps(),
            "expected_output": "画布上多一个海报节点并开始生成",
        })
        plan = [data for name, data in events if name == "plan"][0]
        done = [data for name, data in events if name == "done"][0]
        self.assertEqual(plan["intent"], "做一张 9:16 的主kv海报")
        self.assertIn("9:16", plan["reason"])
        self.assertEqual(plan["assumptions"][0], "你写「9:16 横屏」有矛盾，我按 9:16 竖版做")
        self.assertIn("预期结果：", plan["summary"])
        self.assertIn("1 次真实生成", plan["summary"])
        self.assertEqual(done["message"], plan["summary"])   # 聊天里看到的就是这段人话
        self.assertEqual(execute.await_count, 0)             # 闸门还在：plan 模式一步都不执行


class QuestionBlockGuardTests(unittest.TestCase):
    """提示改了不再反问；万一模型自己吐问答块，后端剥掉，界面不会再弹问题卡。"""

    BLOCK = "先确认一下：\n```openarc-questions\n[{\"question\":\"比例用哪个？\",\"options\":[\"16:9\",\"9:16\"]}]\n```"

    def test_strip_keeps_the_text_and_drops_the_block(self):
        self.assertEqual(main._agent_strip_question_blocks(self.BLOCK), "先确认一下：")
        self.assertEqual(main._agent_strip_question_blocks("正常回答，没有块"), "正常回答，没有块")
        self.assertEqual(main._agent_strip_question_blocks(None), "")

    def test_direct_answer_with_question_block_never_reaches_the_ui(self):
        events, _execute = drain_plan({"done": True, "message": self.BLOCK})
        messages = [data["text"] for name, data in events if name == "message"]
        done = [data for name, data in events if name == "done"][0]
        self.assertEqual(messages, ["先确认一下："])
        self.assertNotIn("openarc-questions", done["message"])


if __name__ == "__main__":
    unittest.main()
