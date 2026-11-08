"""智能画布BEAT 交互流程（2026-11-07 第二轮）：
  1. 助手只建节点 / 写提示词 / 连线，生成延后：本轮结束出「待生成卡片」（kind=generation 的待确认方案），
     步骤是对这些节点 run_generation，模型留空让用户自己选；
  2. 模型可以先提问：done + questions → 回复后面接 novai-questions 问答块；
  3. 用户执行生成后：等结果 → 审查 → 停下来问「是否符合要求」，不自己接着做 / 不自己重做；
  4. 延后开关：_AGENT_BEAT_DEFER_GEN 在 BEAT 生成步骤执行时为 True，用户批准的那一批为 False。
"""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from tests.test_agent_run_step_limits import agent_request, beat_canvas, done_of, drain


def ready_canvas():
    return {"id": "c1", "kind": "classic", "title": "BEAT 画布", "nodes": [
        {"id": "n1", "kind": "image", "title": "海报", "data": {"gen": {"title": "海报", "prompt": "白底保温杯",
                                                                         "params": {"ratio": "3:4", "size": "2K"}}}}],
        "connections": [], "updated_at": 1700000000000}


class GenerationCardTests(unittest.TestCase):
    def test_generation_is_deferred_to_card(self):
        seen = []

        async def execute(tool, args):
            seen.append(main._AGENT_BEAT_DEFER_GEN.get())
            return {"ok": True, "result": {"status": "ready_to_generate", "node_id": "n1", "kind": "image", "title": "海报"}}

        events = drain(agent_request(0, auto_execute=False, renderer="beat"),
                       [{"thought": "先把海报节点搭好", "steps": [{"tool": "generate_image",
                                                         "args": {"canvas_id": "c1", "prompt": "白底保温杯"},
                                                         "description": "建海报节点"}], "done": False}],
                       execute=execute, extra_patches=[patch.object(main, "load_canvas", return_value=ready_canvas())])
        self.assertEqual(seen, [True])                         # 执行时处于「只建不跑」
        plans = [d for n, d in events if n == "plan" and d.get("kind") == "generation"]
        self.assertEqual(len(plans), 1)
        step = plans[0]["steps"][0]
        self.assertEqual(step["tool"], "run_generation")
        self.assertEqual(step["args"]["node_id"], "n1")
        self.assertEqual(step["args"]["settings"], {"ratio": "3:4", "resolution": "2k"})   # 模型不预选
        self.assertNotIn("model", step["args"]["settings"])
        self.assertEqual(plans[0]["nodes"][0]["prompt"], "白底保温杯")
        self.assertIn("待生成卡片", done_of(events)["message"])

    def test_questions_become_qa_block(self):
        events = drain(agent_request(0, renderer="beat"),
                       [{"thought": "策划要先问清楚", "done": True, "message": "先确认几件事：",
                         "questions": [{"question": "目标人群？", "options": ["白领", "宝妈"], "multi": True},
                                       {"question": "篇幅？", "options": ["一页", "三页"]}]}],
                       extra_patches=[patch.object(main, "load_canvas", return_value=ready_canvas())])
        message = done_of(events)["message"]
        self.assertIn("```novai-questions", message)
        block = json.loads(message.split("```novai-questions\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(block[0], {"question": "目标人群？", "options": ["白领", "宝妈"], "multi": True})

    def test_after_results_asks_satisfaction_and_stops(self):
        calls = []

        async def execute(tool, args):
            calls.append((tool, main._AGENT_BEAT_DEFER_GEN.get()))
            return {"ok": True, "result": {"status": "queued_on_canvas", "node_id": "n1"}}

        req = agent_request(0, renderer="beat")
        req["approved_steps"] = [{"tool": "run_generation", "args": {"canvas_id": "c1", "node_id": "n1"},
                                  "description": "生成海报"}]
        review = {"summary": "杯身有点变形", "model": "vm",
                  "items": [{"label": "海报", "node_id": "n1", "url": "x", "kind": "image", "ok": False,
                             "issues": ["杯身变形"], "revised_prompt": "杯身笔直"}]}
        model_calls = []
        events = drain(req, [{"done": True, "message": "不该走到这"}], execute=execute, model_calls=model_calls,
                       extra_patches=[patch.object(main, "load_canvas", return_value=beat_canvas(done=True)),
                                      patch.object(main, "_agent_beat_review", return_value=review)])
        self.assertEqual(calls, [("run_generation", False)])    # 用户批准的那批真跑
        self.assertEqual(model_calls, [])                        # 出结果后不再让模型接着做
        message = done_of(events)["message"]
        self.assertIn("杯身变形", message)
        self.assertIn("要重新生成吗", message)                     # 审查不合格：直接问要不要重做
        block = json.loads(message.split("```novai-questions\n", 1)[1].split("\n```", 1)[0])
        self.assertEqual(block["kind"], "confirm")                 # 结果确认卡
        self.assertEqual(block["questions"][0]["options"], ["重新生成", "先不重做"])
        regen = block["regenerate"]["items"]                       # 刷新后仍能一键重生成
        self.assertEqual(regen[0]["node_id"], "n1")
        self.assertEqual(regen[0]["prompt"], "杯身笔直")
        self.assertEqual([d["summary"] for n, d in events if n == "review"], ["杯身有点变形"])


class HelperTests(unittest.TestCase):
    def test_questions_clean(self):
        qs = main._agent_questions_clean([{"question": "a", "options": ["x", "x", "y"]}, "b", {"q": ""}] + [{"question": str(i)} for i in range(9)])
        self.assertEqual(len(qs), 4)
        self.assertEqual(qs[0]["options"], ["x", "y"])
        self.assertEqual(main._agent_message_with_questions("hi", []), "hi")


if __name__ == "__main__":
    unittest.main()
