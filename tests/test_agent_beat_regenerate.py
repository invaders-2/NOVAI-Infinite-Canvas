# -*- coding: utf-8 -*-
"""画布助手「审查不合格 → 重新生成」后端（2026-11-08）：

  1. 结果确认卡：审查有 ok=false 时第一题问「要重新生成吗」，问题块带 regenerate.items（节点、审查问题、修订提示词），
     刷新后仍能一键重生成；全部合格时保持原来的「这批结果符合你的要求吗」；
  2. _agent_regenerate_steps 纯函数：不合格项先改提示词再重跑，合格项只重跑，timeline 只重新导出，没有提示词不硬塞一步；
  3. _agent_regenerate_prompts：按用户描述 + 审查问题融合新提示词，模型用不了 / 解析失败返回 {}（调用方按描述拼接兜底）；
  4. POST /api/agent/regenerate：过滤无效 items、用 approved_steps 起 run 直接开跑（不真跑 producer）。

不真调模型 / 网络：对话模型与后台驱动全部打桩。
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-beat-regenerate-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main
from tests.test_agent_run_step_limits import agent_request, beat_canvas, done_of, drain


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def canvas():
    return {"id": "c1", "kind": "classic", "title": "BEAT 画布", "nodes": [
        {"id": "n1", "kind": "image", "title": "海报", "data": {"gen": {"title": "海报", "prompt": "白底保温杯"}}},
        {"id": "n2", "kind": "image", "title": "封面", "data": {"gen": {"title": "封面", "prompt": "户外保温杯"}}},
        {"id": "n3", "kind": "timeline", "title": "成片", "data": {"gen": {"title": "成片"}}},
        {"id": "n4", "kind": "text", "title": "文案", "data": {"gen": {"title": "文案"}}},
    ], "connections": [], "updated_at": 1700000000000}


def main_chat():
    return {"provider": "p", "base": "http://x", "headers": {}, "model": "test-chat-model", "provider_cfg": {}}


def qa_block(message):
    return json.loads(str(message).split("```novai-questions\n", 1)[1].split("\n```", 1)[0])


def run_regenerate(payload):
    """调接口并把后台驱动换成空实现：只验收到起 run 为止，不真跑 producer。"""
    drive = AsyncMock(return_value=None)

    async def go():
        with patch.object(main, "_agent_run_bus_drive", new=drive):
            result = await main.agent_regenerate(payload, object())
            await asyncio.sleep(0)
        return result

    return asyncio.run(go()), drive


class ReviewQuestionTests(unittest.TestCase):
    def test_failed_review_asks_regenerate_with_items(self):
        review = {"summary": "有一张不合格", "items": [
            {"label": "海报", "node_id": "n1", "kind": "image", "ok": False,
             "issues": ["杯身变形", "光线偏暗"], "revised_prompt": "杯身笔直"},
            {"label": "封面", "node_id": "n2", "kind": "image", "ok": True,
             "issues": [], "revised_prompt": ""}]}
        outcomes = [{"ok": True, "node_id": "n1"}, {"ok": True, "node_id": "n2"}]
        block = qa_block(main._agent_review_question_text(review, outcomes))
        self.assertEqual(block["kind"], "confirm")
        self.assertEqual(block["questions"][0]["question"], "审查发现 1 个结果不符合要求，要重新生成吗？")
        self.assertEqual(block["questions"][0]["options"], ["重新生成", "先不重做"])
        self.assertEqual(block["questions"][1]["question"], "要改哪里？可以直接勾选，或者自己写（可多选）")
        self.assertTrue(block["questions"][1]["multi"])
        # issues 最多 2 条 + 4 个固定项 = 6（面板上限），固定项不会被裁掉
        self.assertEqual(block["questions"][1]["options"], [
            "杯身变形", "光线偏暗", "构图 / 角度", "风格 / 色调", "产品外观 / 细节", "文字 / 字幕"])
        items = block["regenerate"]["items"]
        self.assertEqual([item["node_id"] for item in items], ["n1", "n2"])
        self.assertIs(items[0]["ok"], False)                   # 刷新后只剩问题块也能认出不合格项
        self.assertIs(items[1]["ok"], True)
        self.assertEqual(items[0]["prompt"], "杯身笔直")       # 审查给的修订提示词
        self.assertEqual(items[1]["prompt"], "")               # 合格项不带提示词

    def test_all_pass_keeps_satisfaction_question(self):
        review = {"summary": "都合格", "items": [
            {"label": "海报", "node_id": "n1", "kind": "image", "ok": True, "issues": []}]}
        block = qa_block(main._agent_review_question_text(review, [{"ok": True, "node_id": "n1"}]))
        self.assertEqual(block["questions"][0]["question"], "这批结果符合你的要求吗？")
        self.assertEqual(block["questions"][0]["options"], ["符合要求，继续下一步", "不满意，需要重做"])

    def test_extra_cannot_override_protocol_fields(self):
        text = main._agent_message_with_questions("说明", [{"question": "要不要重做？", "options": ["要"]}],
                                                  kind="confirm",
                                                  extra={"kind": "other", "questions": [], "regenerate": {"items": []}})
        block = qa_block(text)
        self.assertEqual(block["kind"], "confirm")
        self.assertEqual(len(block["questions"]), 1)
        self.assertEqual(block["regenerate"], {"items": []})


class RegenerateStepsTests(unittest.TestCase):
    def test_steps_follow_review_verdicts(self):
        items = [{"node_id": "n1", "label": "海报"}, {"node_id": "n2", "label": "封面"},
                 {"node_id": "n3", "label": "成片"}, {"node_id": "n4", "label": "文案"}]
        steps = main._agent_regenerate_steps(canvas(), items, {"n1": "杯身笔直，光线更柔和"}, "c1")
        self.assertEqual([step["tool"] for step in steps],
                         ["update_node", "run_generation", "run_generation", "run_generation"])
        self.assertEqual(steps[0]["args"], {"canvas_id": "c1", "node_id": "n1", "prompt": "杯身笔直，光线更柔和"})
        self.assertEqual(steps[0]["description"], "按审查建议改「海报」的提示词")
        self.assertEqual(steps[1]["description"], "重新生成「海报」")
        self.assertEqual([step["args"]["node_id"] for step in steps[1:]], ["n1", "n2", "n3"])  # 文本节点不重跑

    def test_item_prompt_is_used_when_model_gives_nothing(self):
        steps = main._agent_regenerate_steps(canvas(), [{"node_id": "n1", "prompt": "杯身笔直"}], {}, "c1")
        self.assertEqual([step["tool"] for step in steps], ["update_node", "run_generation"])
        self.assertEqual(steps[0]["args"]["prompt"], "杯身笔直")

    def test_same_prompt_does_not_add_update_step(self):
        steps = main._agent_regenerate_steps(canvas(), [{"node_id": "n2"}], {"n2": "户外保温杯"}, "c1")
        self.assertEqual([step["tool"] for step in steps], ["run_generation"])

    def test_timeline_only_reruns_export(self):
        steps = main._agent_regenerate_steps(canvas(), [{"node_id": "n3"}], {"n3": "不该写到时间线上"}, "c1")
        self.assertEqual([step["tool"] for step in steps], ["run_generation"])
        self.assertEqual(steps[0]["args"], {"canvas_id": "c1", "node_id": "n3"})


class RegeneratePromptsTests(unittest.TestCase):
    ITEMS = [{"node_id": "n1", "current_prompt": "白底保温杯", "issues": ["杯身变形"], "prompt": ""}]

    def test_no_description_skips_model(self):
        model = AsyncMock(return_value="{}")
        with patch.object(main, "_agent_run_chat", new=model):
            prompts = asyncio.run(main._agent_regenerate_prompts(main_chat(), self.ITEMS, ""))
        self.assertEqual(prompts, {})
        self.assertFalse(model.await_count)

    def test_model_reply_is_parsed(self):
        reply = json.dumps({"items": [{"node_id": "n1", "prompt": "白底保温杯，柔和光线，杯身笔直"}]},
                           ensure_ascii=False)
        with patch.object(main, "_agent_run_chat", new=AsyncMock(return_value=reply)):
            prompts = asyncio.run(main._agent_regenerate_prompts(main_chat(), self.ITEMS, "更亮一点"))
        self.assertEqual(prompts, {"n1": "白底保温杯，柔和光线，杯身笔直"})

    def test_model_failure_returns_empty(self):
        with patch.object(main, "_agent_run_chat", new=AsyncMock(side_effect=main.AgentRunError("模型挂了"))):
            prompts = asyncio.run(main._agent_regenerate_prompts(main_chat(), self.ITEMS, "更亮一点"))
        self.assertEqual(prompts, {})


class RegenerateEndpointTests(unittest.TestCase):
    def test_empty_items_is_400(self):
        payload = main.AgentRegenerateRequest(canvas_id="c1", items=[])
        with patch.object(main, "load_canvas", return_value=canvas()):
            with self.assertRaises(main.HTTPException) as ctx:
                asyncio.run(main.agent_regenerate(payload, object()))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.detail, "没有可以重新生成的结果")

    def test_invalid_items_are_filtered_to_400(self):
        payload = main.AgentRegenerateRequest(canvas_id="c1", items=[
            {"node_id": "n4"},          # 文本节点不能重生成
            {"node_id": "missing"},     # 画布上没有
            {},                         # 没有 node_id
        ])
        with patch.object(main, "load_canvas", return_value=canvas()):
            with self.assertRaises(main.HTTPException) as ctx:
                asyncio.run(main.agent_regenerate(payload, object()))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(ctx.exception.detail, "没有可以重新生成的结果")

    def test_valid_items_start_run_with_approved_steps(self):
        payload = main.AgentRegenerateRequest(canvas_id="c1", items=[
            {"node_id": "n1", "label": "海报", "prompt": "杯身笔直"},
            {"node_id": "n1", "label": "重复项"},     # 去重
            {"node_id": "n3"},                        # timeline 只重新导出
        ])
        with patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "_agent_run_resolve_chat", return_value=main_chat()):
            result, drive = run_regenerate(payload)
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(result["runId"], None))
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "RUNNING")
        self.assertTrue(result["taskId"] == result["runId"])
        bus = main._AGENT_RUN_BUS.get(result["runId"])
        self.assertIsNotNone(bus)
        req = bus["request"]
        self.assertEqual(req["renderer"], "beat")
        self.assertEqual(req["mode"], "run")
        self.assertEqual(req["max_steps"], 0)
        self.assertEqual(req["instruction"], "重新生成审查不合格的 2 个结果")
        self.assertEqual(req["regenerate_user_text"], "重新生成审查不合格的 2 个结果")
        tools = [step["tool"] for step in req["approved_steps"]]
        self.assertIn("run_generation", tools)
        self.assertEqual(tools, ["update_node", "run_generation", "run_generation"])  # 每个节点一步重生成
        self.assertEqual(drive.await_count, 1)

    def test_no_chat_model_falls_back_to_description(self):
        payload = main.AgentRegenerateRequest(canvas_id="c1", description="更亮一点",
                                              items=[{"node_id": "n1", "label": "海报"}])
        with patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "_agent_run_resolve_chat",
                             side_effect=main.HTTPException(status_code=400, detail="没有可用模型")):
            result, _drive = run_regenerate(payload)
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(result["runId"], None))
        req = main._AGENT_RUN_BUS[result["runId"]]["request"]
        self.assertEqual(req["instruction"], "按我的描述重新生成：更亮一点")
        self.assertEqual(req["regenerate_user_text"], "按我的描述重新生成：更亮一点")
        update = req["approved_steps"][0]
        self.assertEqual(update["tool"], "update_node")
        self.assertEqual(update["args"]["prompt"], "白底保温杯\n用户补充修改要求：更亮一点")


class ProducerThreadRecordTests(unittest.TestCase):
    def test_regenerate_user_message_is_written_to_thread(self):
        # 重生成 run 带的是 approved_steps（没有对应的用户消息）：把触发它的那句话补进线程，
        # 并且跑完照旧「等结果 → 复审 → 再问」，形成闭环
        req = agent_request(0, auto_execute=False, renderer="beat")
        req.update({"approved_steps": [{"tool": "run_generation",
                                       "args": {"canvas_id": "c1", "node_id": "n1"},
                                       "description": "重新生成「海报」"}],
                    "use_thread": True, "thread_id": "t1",
                    "regenerate_user_text": "重新生成审查不合格的 1 个结果"})
        records = []
        review = {"summary": "还有问题", "model": "vm", "items": [
            {"label": "海报", "node_id": "n1", "url": "x", "kind": "image", "ok": False,
             "issues": ["杯身太歪"], "revised_prompt": "杯身笔直"}]}

        async def execute(tool, args):
            return {"ok": True, "result": {"status": "queued_on_canvas", "node_id": "n1"}}

        events = drain(req, [{"done": True, "message": "不该走到这"}], execute=execute,
                       extra_patches=[patch.object(main, "load_canvas", return_value=beat_canvas(done=True)),
                                      patch.object(main, "_agent_beat_review",
                                                   new=AsyncMock(return_value=review)),
                                      patch.object(main, "agent_thread_append",
                                                   side_effect=lambda canvas_id, recs, touched=None,
                                                   thread_id="": records.extend(recs))])
        self.assertEqual(done_of(events)["status"], "ok")
        self.assertEqual(records[0]["role"], "user")
        self.assertEqual(records[0]["text"], "重新生成审查不合格的 1 个结果")
        self.assertIn("审查在后台", done_of(events)["message"], "回复不等视觉审查")
        reviews = [d for n, d in events if n == "review"]
        self.assertEqual(reviews[0]["items"][0]["issues"], ["杯身太歪"])


if __name__ == "__main__":
    unittest.main()
