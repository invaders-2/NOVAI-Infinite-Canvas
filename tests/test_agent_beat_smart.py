"""画布助手「更聪明」一轮改动（2026-11-07）：

  1. 整体路线图 roadmap：清洗、进方案事件（total_generations）、进每轮用户提示、批准时带进执行 run；
  2. 思考事件：每轮把模型的判断 / 目标 / 理由（含原生推理摘要）作为 thought 事件发给前端；
  3. 原生工具：plan_roadmap 虚拟工具不进 steps，而是变成 decision.roadmap；
  4. BEAT 专用系统提示词：不再混入旧画布的编号 / 表格 / 模板规则；技能正文、点名应用进系统提示；
  5. 批准后的花钱上限按路线图预估放行（长流程不会在第二阶段被预算卡停）。
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

ROADMAP = [{"stage": "写策划与分镜", "detail": "5 个镜头", "generations": 0},
           {"stage": "分镜头出视频", "detail": "每镜 5s", "generations": 5},
           {"stage": "配音", "generations": "5"},
           {"stage": "剪成片", "generations": 1}]


class RoadmapPureTests(unittest.TestCase):
    def test_clean_and_total(self):
        clean = main._agent_roadmap_clean(ROADMAP + ["只有名字", {"detail": "没名字丢掉"}, 3])
        self.assertEqual([x["stage"] for x in clean], ["写策划与分镜", "分镜头出视频", "配音", "剪成片", "只有名字"])
        self.assertEqual(main._agent_roadmap_total(clean), 11)
        self.assertEqual(main._agent_roadmap_clean(None), [])
        self.assertEqual(len(main._agent_roadmap_clean([{"stage": str(i)} for i in range(30)])), 12)

    def test_plan_event_carries_roadmap(self):
        steps = [{"tool": "create_node", "args": {"canvas_id": "c1", "type": "text"}, "description": "写策划"}]
        event = main._agent_plan_event("做卖货视频", steps, roadmap=ROADMAP)
        self.assertEqual(len(event["roadmap"]), 4)
        self.assertEqual(event["total_generations"], 11)
        self.assertNotIn("roadmap", main._agent_plan_event("x", steps))
        self.assertEqual(main._agent_plan_details({"roadmap": ROADMAP})["roadmap"][1]["generations"], 5)

    def test_user_prompt_includes_roadmap(self):
        text = main._agent_run_user_prompt("做视频", [], 3, 0, 4, "", mode="run",
                                           roadmap=main._agent_roadmap_clean(ROADMAP))
        self.assertIn("整体方案", text)
        self.assertIn("2. 分镜头出视频：每镜 5s（约 5 次生成）", text)
        self.assertNotIn("整体方案（", main._agent_run_user_prompt("x", [], 1, 0, 0, ""))

    def test_thought_text(self):
        text = main._agent_decision_thought({"reasoning": "先看产品", "thought": "用户要卖货视频",
                                             "intent": "用户要卖货视频", "reason": "竖屏更适合"})
        self.assertEqual(text.split("\n"), ["用户要卖货视频", "竖屏更适合"])
        self.assertEqual(main._agent_step_fallback_label("create_node", {"type": "text"}), "新建文本节点")
        self.assertEqual(main._agent_decision_thought(None), "")


class RepeatGuardTests(unittest.TestCase):
    def test_target_key(self):
        self.assertEqual(main._agent_step_target_key("update_node", {"node_id": "n1"}), "update_node:n1")
        self.assertEqual(main._agent_step_target_key("canvas_cli", {"command": "node.update", "args": {"node_id": "n1"}}),
                         "update_node:n1")
        self.assertEqual(main._agent_step_target_key("create_node", {"type": "text"}), "")
        self.assertEqual(main._agent_step_fallback_label("canvas_cli", {"command": "node.create", "args": {"type": "image"}}),
                         "新建图片节点")


class ProducerRepeatGuardTests(unittest.TestCase):
    """模型反复改同一个节点：第一次重复只提醒，第二次重复直接按完成收尾，节点只改了一次。"""

    def test_same_node_edit_is_not_repeated_forever(self):
        reply = json.dumps({"thought": "把第二篇改口语", "steps": [{"tool": "update_node", "args": {
            "canvas_id": "c1", "node_id": "n2", "prompt": "更口语"}, "description": "改第二篇"}], "done": False},
            ensure_ascii=False)
        execute = AsyncMock(return_value={"ok": True, "result": {"node_id": "n2", "changed": ["prompt"]}})
        run_id = "run_beat_repeat1"
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(run_id, None))
        with patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "_agent_run_chat", new=AsyncMock(return_value=reply)), \
                patch.object(main, "agent_session_save"), \
                patch.object(main, "agent_execute_step", new=execute):
            bus = main._agent_run_bus_new(run_id, "c1")
            req = {"canvas_id": "c1", "instruction": "第二篇再口语一点", "focus": main._agent_run_normalize_focus(None),
                   "history": [], "chat": {"provider": "openai", "base": "https://example.invalid/v1", "headers": {},
                                           "model": "m", "provider_cfg": {}},
                   "max_steps": 0, "mode": "run", "auto_execute": True, "approved_steps": [], "run_id": run_id}
            bus["request"] = dict(req)

            async def run():
                with contextlib.redirect_stdout(io.StringIO()):
                    await main._agent_run_producer(req, None, bus=bus)
            asyncio.run(run())
        self.assertEqual(execute.await_count, 1)
        main._agent_run_bus_close(bus)
        snap = main._agent_run_task_snapshot(bus)
        self.assertEqual(snap["task"]["status"], "SUCCEEDED")


class NativeRoadmapToolTests(unittest.TestCase):
    def raw(self, calls, content="", reasoning=""):
        return {"choices": [{"message": {"content": content, "reasoning_content": reasoning, "tool_calls": [
            {"function": {"name": n, "arguments": json.dumps(a, ensure_ascii=False)}} for n, a in calls]}}]}

    def test_roadmap_call_is_not_a_step(self):
        decision = main._agent_decision_from_native(self.raw([
            ("plan_roadmap", {"intent": "做卖货视频", "reason": "竖屏", "stages": ROADMAP}),
            ("create_node", {"type": "text", "description": "写策划"})], content="我先写策划", reasoning="想了想"), "c1")
        self.assertEqual([s["tool"] for s in decision["steps"]], ["create_node"])
        self.assertEqual(decision["intent"], "做卖货视频")
        self.assertEqual(len(decision["roadmap"]), 4)
        self.assertEqual(decision["reasoning"], "想了想")

    def test_roadmap_tool_is_offered(self):
        self.assertEqual(main._AGENT_ROADMAP_TOOL_DEF["function"]["name"], "plan_roadmap")


class BeatPromptTests(unittest.TestCase):
    def test_beat_prompt_formats_and_drops_legacy_rules(self):
        text = main._AGENT_BEAT_SYSTEM_PROMPT.format(tools_json="T", media_platforms_text="M",
                                                     canvas_summary="C", history_text="", focus_text="F")
        self.assertIn("roadmap", text)
        self.assertIn("指代", text)
        self.assertNotIn("alias", text)
        # BEAT 支持多维表格批量了：提示词要教模型用 batch_generate / review_table / run_batch
        self.assertIn("batch_generate", text)

    def test_skill_and_apps_go_into_system_prompt(self):
        req = {"canvas_id": "c1", "instruction": "按技能做", "skill_prompt": "第一步：写卖点。", "skill_name": "卖点海报",
               "apps": [{"name": "mcp__x__poster", "title": "海报", "description": "生成海报"}]}
        ctx = main._CanvasRunContext(req)
        ctx._beat_cached = True
        snap = {"id": "c1", "nodes": [], "connections": []}
        with patch.object(main, "_agent_memory_prompt", return_value=""):
            prompt = ctx.build_system_prompt(snap, "[]", "")
        self.assertIn("「卖点海报」", prompt)
        self.assertIn("第一步：写卖点。", prompt)
        self.assertIn("mcp__x__poster", prompt)
        self.assertIn("创作搭档", prompt)

    def test_request_accepts_new_fields(self):
        body = main.AgentRunRequest(canvas_id="c1", instruction="x", skill_prompt="s" * 5000,
                                    apps=[{"name": "a"}])
        self.assertEqual(len(body.skill_prompt), 5000)


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "owner_id": 1,
            "nodes": [], "connections": [], "updated_at": 1700000000000}


class ProducerThoughtTests(unittest.TestCase):
    def setUp(self):
        self.execute = AsyncMock(return_value={"ok": True, "result": {"node_id": "n1"}, "message": "执行成功"})
        self.chat = AsyncMock(return_value=json.dumps(
            {"thought": "用户要一条卖货视频，先写策划", "intent": "做卖货视频", "roadmap": ROADMAP,
             "steps": [{"tool": "create_node", "args": {"canvas_id": "c1", "type": "prompt"},
                        "description": "写策划"}], "done": False}, ensure_ascii=False))
        for item in [patch.object(main, "load_canvas", return_value=canvas()),
                     patch.object(main, "_agent_run_chat", new=self.chat),
                     patch.object(main, "agent_session_save"),
                     patch.object(main, "agent_execute_step", new=self.execute)]:
            item.start()
            self.addCleanup(item.stop)
        self.run_id = "run_beat_smart1"
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(self.run_id, None))

    def test_plan_has_roadmap_and_thoughts_are_emitted(self):
        bus = main._agent_run_bus_new(self.run_id, "c1")
        req = {"canvas_id": "c1", "instruction": "做一条卖货视频", "focus": main._agent_run_normalize_focus(None),
               "history": [], "chat": {"provider": "openai", "base": "https://example.invalid/v1", "headers": {},
                                       "model": "m", "provider_cfg": {}},
               "max_steps": 0, "mode": "plan", "approved_steps": [], "run_id": self.run_id}
        bus["request"] = dict(req)

        async def run():
            with contextlib.redirect_stdout(io.StringIO()):
                await main._agent_run_producer(req, None, bus=bus)
        asyncio.run(run())
        main._agent_run_bus_close(bus)
        snap = main._agent_run_task_snapshot(bus)
        thoughts = [e["safePayload"]["text"] for e in snap["events"] if e["eventType"] == "thought"]
        self.assertTrue(any(t.startswith("整体方案") for t in thoughts))
        self.assertTrue(any("先写策划" in t for t in thoughts))
        self.assertEqual(snap["plan"]["total_generations"], 11)
        self.assertEqual(len(snap["plan"]["roadmap"]), 4)

        drive = AsyncMock(return_value=None)
        with patch.object(main, "_agent_run_bus_drive", new=drive):
            async def approve():
                result = await main.agent_run_approve(self.run_id, main.AgentRunApproveRequest(), object())
                await asyncio.sleep(0)
                return result
            result = asyncio.run(approve())
        self.addCleanup(lambda: main._AGENT_RUN_BUS.pop(result["taskId"], None))
        self.assertEqual(len(drive.await_args.args[0]["roadmap"]), 4)


class BeatReviewTests(unittest.TestCase):
    OUTCOMES = [
        {"ok": True, "node_id": "n1", "kind": "image", "name": "海报1", "url": "/output/a.png", "prompt": "白底保温杯"},
        {"ok": True, "node_id": "n2", "kind": "image", "name": "海报2", "url": "/output/b.png", "prompt": "户外保温杯"},
        {"ok": False, "node_id": "n3", "kind": "image", "name": "海报3", "text": "失败"},
        {"ok": True, "node_id": "n4", "kind": "audio", "name": "配音", "url": "/output/c.mp3"},
    ]

    def test_review_verdicts(self):
        reply = json.dumps({"summary": "一张合格一张有问题", "items": [
            {"label": "海报1", "ok": True, "issues": []},
            {"label": "海报2", "ok": False, "issues": ["杯身变形"], "revised_prompt": "户外保温杯，杯身笔直"}]},
            ensure_ascii=False)
        chat = AsyncMock(return_value=reply)
        with patch.object(main, "_agent_review_pick_chat", return_value={"model": "vision-m", "provider": "p"}), \
                patch.object(main, "_agent_image_payload_url", return_value="data:image/png;base64,AAAA"), \
                patch.object(main, "_agent_run_chat", new=chat):
            review = asyncio.run(main._agent_beat_review({"provider": "p", "model": "m"}, "做两张海报", ROADMAP, self.OUTCOMES))
        self.assertEqual([v["node_id"] for v in review["items"]], ["n1", "n2"])      # 失败的 / 配音不审
        self.assertEqual([v["ok"] for v in review["items"]], [True, False])
        self.assertEqual(review["items"][1]["revised_prompt"], "户外保温杯，杯身笔直")
        content = chat.await_args.args[1][0]["content"]
        self.assertEqual(sum(1 for part in content if part["type"] == "image_url"), 2)
        self.assertIn("做两张海报", content[0]["text"])

    def test_no_vision_model_is_reported_not_raised(self):
        with patch.object(main, "_agent_review_pick_chat", return_value=None):
            review = asyncio.run(main._agent_beat_review({}, "x", [], self.OUTCOMES))
        self.assertTrue(review["skipped"])
        self.assertIsNone(asyncio.run(main._agent_beat_review({}, "x", [], [self.OUTCOMES[2]])))

    def test_failed_review_is_reported(self):
        with patch.object(main, "_agent_review_pick_chat", return_value={"model": "vm", "provider": "p"}), \
                patch.object(main, "_agent_pick_caption_model", return_value=None), \
                patch.object(main, "_agent_image_payload_url", return_value="data:image/png;base64,AAAA"), \
                patch.object(main, "_agent_run_chat", new=AsyncMock(side_effect=main.AgentRunError("token expired"))):
            review = asyncio.run(main._agent_beat_review({}, "x", [], self.OUTCOMES))
        self.assertTrue(review["skipped"])
        self.assertIn("没审查成", review["summary"])
        self.assertIn("vm", review["summary"])


class DefaultModelTests(unittest.TestCase):
    def test_default_model_roundtrip(self):
        store = {}
        with patch.object(main, "load_settings", side_effect=lambda: dict(store)), \
                patch.object(main, "write_json_atomic", side_effect=lambda path, cfg, **kw: (store.clear(), store.update(cfg))), \
                patch.object(main.os, "makedirs"):
            self.assertEqual(main.get_agent_default_model(), {"model": ""})
            main.set_agent_default_model(main.AgentDefaultModelPayload(model="volcengine::deepseek-v4"))
            self.assertEqual(main.get_agent_default_model(), {"model": "volcengine::deepseek-v4"})
            main.set_agent_default_model(main.AgentDefaultModelPayload(model=""))
            self.assertEqual(main.get_agent_default_model(), {"model": ""})
            with self.assertRaises(main.HTTPException):
                main.set_agent_default_model(main.AgentDefaultModelPayload(model="没有平台"))


if __name__ == "__main__":
    unittest.main()
