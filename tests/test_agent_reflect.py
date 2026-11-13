# -*- coding: utf-8 -*-
"""阶段三·3：反思轮（§6.4）+ 完成前自检（§6.6）+ roadmap 验收标准（§6.3）。

覆盖：
- 反思消息固定格式（三问）；
- 三种触发（步骤失败 / 审查不合格 / 连续一轮无进展）都会注入反思并写进转录（note kind=reflect）；
- 反思真的进了下一轮的消息（不是只在提示末尾加一句「请换一种做法」）；
- 自检三类检查：roadmap 阶段有成功记录、指令硬约束（数量/比例/时长）与节点参数一致、失败要如实提到；
- 自检不通过打回一轮、最多打回一次；通过 / 打回都发 self_check 事件；
- roadmap 阶段 acceptance 字段（清理 / 文本 / plan 事件）保留。
"""
import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-agent-reflect-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def beat_canvas(canvas_id, text_node=True):
    return {"id": canvas_id, "title": "反思验收画布", "kind": "classic",
            "updated_at": int(main.time.time() * 1000),
            "nodes": [{"id": "n1", "kind": "text", "x": 0, "y": 0, "text": "冷蓝色调", "data": {}}],
            "connections": []}


def chat_config():
    return {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
            "model": "reflect-model", "provider_cfg": {"protocol": "custom"}, "think_level": ""}


def new_canvas(prefix):
    canvas_id = "c-%s-%s" % (prefix, uuid.uuid4().hex[:8])
    main.save_canvas(beat_canvas(canvas_id))
    return canvas_id


def parse_events(chunks):
    events = []
    for chunk in chunks:
        if not isinstance(chunk, str):
            continue
        event = data = None
        for line in chunk.split("\n"):
            if line.startswith("event: "):
                event = line[len("event: "):].strip()
            elif line.startswith("data: "):
                data = json.loads(line[len("data: "):])
        if event:
            events.append({"event": event, "data": data})
    return events


@contextlib.asynccontextmanager
async def _stream_unused(*args, **kwargs):
    raise main.AgentRunError("这条用例不打模型", code="provider_error")
    yield  # pragma: no cover


def run_producer(canvas_id, decisions, execute, extra_env=None, wait_outcomes=None, review=None,
                 autonomy="collab"):
    """真跑一次 producer（CONTEXT=1，BEAT 画布），把模型 / 工具 / 等待 / 审查全部打桩。"""
    messages_seen = []
    pending = list(decisions)

    async def fake_decide(chat, messages, cid, tools_json_text="", tools=None, rebuild_json=None):
        messages_seen.append([dict(message) for message in messages])
        return pending.pop(0) if pending else {"done": True, "message": "完成"}

    async def fake_wait(self, node_ids, emit, cancelled, deadline=None):
        return [dict(item) for item in (wait_outcomes or [])]

    async def fake_review(chat, instruction, roadmap, items):
        return review

    req = {"canvas_id": canvas_id, "run_id": "run_reflect_" + uuid.uuid4().hex[:8],
           "instruction": "做一张冷蓝色调海报", "focus": main._agent_run_normalize_focus(None),
           "history": [], "thread_id": "", "chat": chat_config(), "max_steps": 0,
           "mode": "run", "approved_steps": [], "renderer": "beat", "autonomy": autonomy,
           "use_thread": False, "enforce_write_confirmation": True}
    bus = main._agent_run_bus_new(req["run_id"], canvas_id)

    async def go():
        await main._agent_run_producer(req, None, bus=bus)

    env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2")}
    env.update({"NOVAI_AGENT_V2_CONTEXT": "1"})
    env.update(extra_env or {})
    if autonomy != "collab":
        env.setdefault("NOVAI_AGENT_V2_AUTONOMY", "1")
    patches = [
        patch.dict(os.environ, env, clear=True),
        patch.object(main, "_agent_run_decide_v2", new=fake_decide),
        patch.object(main, "agent_execute_step", new=execute),
        patch.object(main._CanvasRunContext, "wait_canvas_results", new=fake_wait),
        patch.object(main._CanvasRunContext, "confirmation_needed",
                     new=lambda self, steps, confirmed=False: {"needed": False, "tools": []}),
        patch.object(main, "_agent_beat_review", new=fake_review),
        patch.object(main, "_agent_v2_memory_schedule", new=lambda *a, **k: None),
    ]
    for item in patches:
        item.start()
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(go())
    finally:
        for item in reversed(patches):
            item.stop()
    events = []
    for item in bus.get("events") or []:
        events.append({"event": item.get("name"), "data": item.get("data")})
    return {"bus": bus, "events": events, "messages": messages_seen,
            "transcript": bus.get("transcript")}


async def executed_ok(tool, args):
    return {"ok": True, "tool": tool, "message": "执行成功",
            "result": {"status": "queued_on_canvas", "node_id": "n1", "kind": "image"}}


async def executed_fail(tool, args):
    return {"ok": False, "tool": tool, "error": "节点 n1 不存在", "code": "node_not_found"}


class ReflectionFormatTests(unittest.TestCase):
    """§6.4：固定格式的三问反思。"""

    def test_reflect_message_has_three_required_questions(self):
        text = main._agent_reflect_message("step_failure", "节点 n1 不存在", 2)
        self.assertIn("【反思】", text)
        self.assertIn("步骤执行失败", text)
        self.assertIn("第 2 次", text)
        self.assertIn("1. 期望的结果是什么？实际得到的是什么？", text)
        self.assertIn("2. 最可能的原因是什么？依据是哪一条执行记录", text)
        self.assertIn("3. 这次换哪种做法？和上次有什么不同？", text)
        self.assertIn("节点 n1 不存在", text)
        self.assertNotIn("请换一种做法", text)

    def test_trigger_labels_cover_all_three_conditions(self):
        for trigger in ("step_failure", "review_failed", "no_progress"):
            self.assertIn(main._AGENT_REFLECT_TRIGGERS[trigger],
                          main._agent_reflect_message(trigger))


class ReflectionInjectionTests(unittest.TestCase):
    """反思真的注入下一轮（不是只在提示末尾追一句）并写进转录。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self.canvas_id = new_canvas("reflect")

    def test_step_failure_injects_reflection_next_round(self):
        decisions = [
            {"thought": "先读画布", "steps": [{"tool": "get_canvas", "args": {"canvas_id": self.canvas_id}}]},
            {"done": True, "message": "好了"},
        ]
        out = run_producer(self.canvas_id, decisions, executed_fail,
                           extra_env={"NOVAI_AGENT_V2_REFLECT": "1"})
        thoughts = [item["data"] for item in out["events"] if item["event"] == "thought"]
        reflect_thoughts = [item for item in thoughts if item.get("kind") == "reflect"]
        self.assertTrue(reflect_thoughts, "反思要以 thought(kind=reflect) 事件给面板折叠区")
        self.assertIn("【反思】", reflect_thoughts[0]["text"])
        notes = [entry for entry in out["transcript"].entries
                 if entry.get("type") == "note" and entry.get("kind") == "reflect"]
        self.assertTrue(notes, "反思要写进转录并标成 reflect")
        second_round = "\n".join(str(message.get("content") or "") for message in out["messages"][1])
        self.assertIn("【反思】", second_round, "下一轮的消息里要带反思")
        self.assertIn("1. 期望的结果是什么？", second_round)
        self.assertNotIn("最近一次失败原因（请换一种做法", second_round)

    def test_review_failure_injects_reflection_and_marks_transcript(self):
        outcomes = [{"ok": True, "node_id": "n1", "url": "/old.png", "kind": "image",
                     "text": "图片生成成功 /old.png"}]
        review = {"summary": "不合格", "items": [
            {"label": "海报", "node_id": "n1", "url": "/old.png", "kind": "image", "ok": False,
             "issues": ["杯身变形"], "revised_prompt": "杯身笔直"}]}
        decisions = [{"thought": "出图", "steps": [{"tool": "generate_image",
                                                    "args": {"canvas_id": self.canvas_id, "prompt": "海报"}}]},
                     {"done": True, "message": "出图了"}]
        out = run_producer(self.canvas_id, decisions, executed_ok,
                           extra_env={"NOVAI_AGENT_V2_REFLECT": "1"},
                           wait_outcomes=outcomes, review=review, autonomy="auto")
        reflect_thoughts = [item["data"] for item in out["events"]
                            if item["event"] == "thought" and item["data"].get("kind") == "reflect"]
        self.assertTrue(reflect_thoughts)
        self.assertIn("审查不合格", reflect_thoughts[0]["text"])
        self.assertIn("杯身变形", reflect_thoughts[0]["text"])
        notes = [entry for entry in out["transcript"].entries
                 if entry.get("type") == "note" and entry.get("kind") == "reflect"]
        self.assertTrue(notes)

    def test_no_progress_injects_reflection(self):
        decisions = [{"done": False, "steps": []}, {"done": True, "message": "好了"}]
        out = run_producer(self.canvas_id, decisions, executed_ok,
                           extra_env={"NOVAI_AGENT_V2_REFLECT": "1"})
        reflect_thoughts = [item["data"] for item in out["events"]
                            if item["event"] == "thought" and item["data"].get("kind") == "reflect"]
        self.assertTrue(reflect_thoughts)
        self.assertIn("没有任何进展", reflect_thoughts[0]["text"])

    def test_switch_off_does_not_add_reflection(self):
        decisions = [
            {"thought": "先读画布", "steps": [{"tool": "get_canvas", "args": {"canvas_id": self.canvas_id}}]},
            {"done": True, "message": "好了"},
        ]
        out = run_producer(self.canvas_id, decisions, executed_fail, extra_env={})
        self.assertFalse([item for item in out["events"]
                          if item["event"] == "thought" and item["data"].get("kind") == "reflect"])
        self.assertFalse([entry for entry in out["transcript"].entries
                          if entry.get("type") == "note" and entry.get("kind") == "reflect"])


class SelfCheckHelperTests(unittest.TestCase):
    """§6.6 三类检查各一例（纯函数）。"""

    def test_roadmap_stages_need_success_records(self):
        roadmap = [{"stage": "出图", "detail": "出 2 张", "generations": 2, "acceptance": "2 张都成功"}]
        failed = main._agent_self_check_roadmap_items(roadmap, [], [])
        self.assertTrue(failed)
        self.assertFalse(all(item["ok"] for item in failed))
        acceptance_items = [item for item in failed if "验收标准" in item["text"]]
        self.assertTrue(acceptance_items)
        self.assertEqual(acceptance_items[0]["status"], "pending", "验收标准没真正核对时只能标待核对")
        history = [{"tool": "generate_image", "ok": True, "args": {"node_id": "n1"}},
                   {"tool": "generate_image", "ok": True, "args": {"node_id": "n2"}},
                   {"tool": "run_generation", "ok": True, "args": {}}]
        passed = main._agent_self_check_roadmap_items(roadmap, history, [])
        self.assertTrue(all(item["ok"] for item in passed
                            if item.get("status") != "pending"), passed)

    def test_acceptance_roundtrips_through_clean_text_and_plan_event(self):
        raw = [{"stage": "出图", "generations": 1, "acceptance": "5 个镜头总时长约 30 秒"}]
        clean = main._agent_roadmap_clean(raw)
        self.assertEqual(clean[0]["acceptance"], "5 个镜头总时长约 30 秒")
        self.assertIn("验收：5 个镜头总时长约 30 秒", main._agent_roadmap_text(clean))
        event = main._agent_plan_event("目标", [], roadmap=clean)
        self.assertEqual(event["roadmap"][0]["acceptance"], "5 个镜头总时长约 30 秒")

    def test_constraint_count_ratio_duration_checks_read_nodes(self):
        instruction = "按这个来：做 2 张图，比例 3:4，每条 5 秒"
        parsed = main._agent_instruction_constraints(instruction)
        self.assertEqual(parsed["ratios"], ["3:4"])
        self.assertIn({"count": 2, "unit": "张"}, parsed["counts"])
        self.assertIn(5, parsed["durations"])
        snapshot = {"nodes": [
            {"id": "n1", "kind": "image", "data": {"gen": {"params": {"ratio": "3:4", "dur": 5}}}},
            {"id": "n2", "kind": "image", "data": {"gen": {"params": {"ratio": "3:4", "dur": 5}}}},
        ]}
        items = main._agent_self_check_constraint_items(instruction, snapshot, ["n1", "n2"])
        self.assertTrue([item for item in items if item["text"].startswith("数量")])
        by_prefix = {item["text"].split("：")[0]: item for item in items}
        self.assertTrue(by_prefix["数量"]["ok"], by_prefix["数量"])
        self.assertTrue(by_prefix["比例"]["ok"], by_prefix["比例"])
        # 时长只看 video 节点；这两张是 image，没有可核对项
        self.assertNotIn("时长", by_prefix)

    def test_constraint_mismatch_fails(self):
        snapshot = {"nodes": [
            {"id": "n1", "kind": "image", "data": {"gen": {"params": {"ratio": "16:9"}}}},
        ]}
        items = main._agent_self_check_constraint_items("做 2 张图，比例 1:1", snapshot, ["n1"])
        count_item = next(item for item in items if item["text"].startswith("数量"))
        ratio_item = next(item for item in items if item["text"].startswith("比例"))
        self.assertFalse(count_item["ok"])
        self.assertFalse(ratio_item["ok"])
        self.assertIn("16:9", ratio_item["text"])

    def test_video_duration_mismatch_fails(self):
        snapshot = {"nodes": [
            {"id": "v1", "type": "smart-video", "kind": "video",
             "data": {"gen": {"params": {"dur": 8}}}},
        ]}
        items = main._agent_self_check_constraint_items("来一条 5 秒的视频", snapshot, ["v1"])
        duration_item = next(item for item in items if item["text"].startswith("时长"))
        self.assertFalse(duration_item["ok"])
        self.assertIn("8s", duration_item["text"])

    def test_failure_reporting_check(self):
        base = dict(instruction="做海报", history=[], results=[], snapshot={"nodes": []},
                    roadmap=[], fail_notes=["#1 get_canvas 失败"])
        silent = main._agent_run_self_check(reply="已经做好了，共生成 1 张图。", **base)
        self.assertFalse(silent["passed"])
        self.assertFalse(next(item for item in silent["items"] if "失败" in item["text"])["ok"])
        honest = main._agent_run_self_check(reply="做完了，但有一步失败了：画布读取失败。", **base)
        self.assertTrue(honest["passed"], honest)

    def test_all_ok_reply_passes(self):
        check = main._agent_run_self_check(
            instruction="做一张海报", history=[{"tool": "create_node", "ok": True, "args": {"node_id": "n1"}}],
            results=[], snapshot={"nodes": [{"id": "n1", "kind": "text", "data": {}}]},
            roadmap=[], reply="海报已经建好了。", fail_notes=[])
        self.assertTrue(check["passed"], check)


class DeferredCountConstraintTests(unittest.TestCase):
    """用户明确要求「分批 / 先做一部分 / 等确认」时，数量检查不判失败（比例 / 时长仍严格）。"""

    def _images(self, count=2, ratio="3:4"):
        return {"nodes": [{"id": "n%d" % index, "kind": "image",
                           "data": {"gen": {"params": {"ratio": ratio}}}}
                          for index in range(1, count + 1)]}

    def _count_items(self, instruction, snapshot, node_ids):
        return [item for item in main._agent_self_check_constraint_items(instruction, snapshot, node_ids)
                if item["text"].startswith("数量")]

    def test_staged_three_with_hold_third_does_not_fail_count(self):
        instruction = "做 3 张海报，先建 2 张，第三张先不要建、等确认"
        snapshot = self._images(2)
        items = self._count_items(instruction, snapshot, ["n1", "n2"])
        self.assertTrue(items, "数量约束仍要出现在核对项里")
        self.assertTrue(all(item["ok"] for item in items), items)
        self.assertTrue(any("分批或等确认" in item["text"] for item in items), items)
        check = main._agent_run_self_check(instruction, [], [], snapshot, [], "先建了 2 张，等确认",
                                           [])
        self.assertTrue(check["passed"], check)

    def test_plain_three_still_fails_when_only_two_built(self):
        instruction = "做 3 张海报"
        snapshot = self._images(2)
        items = self._count_items(instruction, snapshot, ["n1", "n2"])
        self.assertTrue(items)
        self.assertFalse(items[0]["ok"], items)
        check = main._agent_run_self_check(instruction, [], [], snapshot, [],
                                           "海报做好了", [])
        self.assertFalse(check["passed"], check)

    def test_first_batch_of_two_with_rest_pending_does_not_fail_count_and_ratio_stays_strict(self):
        instruction = "先做 2 张，其余等确认，比例 16:9"
        snapshot = self._images(2, ratio="3:4")
        items = main._agent_self_check_constraint_items(instruction, snapshot, ["n1", "n2"])
        count_items = [item for item in items if item["text"].startswith("数量")]
        ratio_items = [item for item in items if item["text"].startswith("比例")]
        self.assertTrue(count_items and all(item["ok"] for item in count_items), items)
        self.assertTrue(ratio_items)
        self.assertFalse(ratio_items[0]["ok"], "分批语气不能让比例检查失效")
        self.assertIn("16:9", ratio_items[0]["text"])


class SelfCheckProducerTests(unittest.TestCase):
    """自检接到 producer：不通过打回一轮、最多一次；通过直接结束；都发 self_check 事件。"""

    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        self.canvas_id = new_canvas("selfcheck")

    def _roadmap_decision(self, generations=2):
        return {"thought": "先定方案", "roadmap": [{"stage": "出图", "detail": "出图",
                                                    "generations": generations,
                                                    "acceptance": "图都生成成功"}],
                "steps": [{"tool": "get_canvas", "args": {"canvas_id": self.canvas_id}}]}

    def test_failed_self_check_bounces_at_most_once(self):
        decisions = [self._roadmap_decision(2),
                     {"done": True, "message": "做完了"},
                     {"done": True, "message": "做完了"}]
        out = run_producer(self.canvas_id, decisions, executed_ok,
                           extra_env={"NOVAI_AGENT_V2_SELF_CHECK": "1"})
        checks = [item["data"] for item in out["events"] if item["event"] == "self_check"]
        self.assertEqual(len(checks), 2, "打回前后各一条 self_check")
        self.assertFalse(checks[0]["passed"])
        self.assertTrue(checks[0]["items"])
        self.assertTrue(any(not item["ok"] for item in checks[0]["items"]))
        self.assertFalse(checks[1]["passed"], "打回一次后仍不满足也不再打回")
        self.assertEqual(len(out["messages"]), 3, "只多打回一轮（共 3 次模型调用）")
        done = next(item["data"] for item in out["events"] if item["event"] == "done")
        self.assertEqual(done["status"], "ok")
        notes = [entry for entry in out["transcript"].entries
                 if entry.get("type") == "note" and "自检未通过" in str(entry.get("text") or "")]
        self.assertTrue(notes, "打回提示要写进转录")
        bounce_prompt = "\n".join(str(message.get("content") or "") for message in out["messages"][2])
        self.assertIn("完成前自检未通过", bounce_prompt, "打回后下一轮要带上未满足项")

    def test_passing_self_check_finishes_immediately(self):
        decisions = [self._roadmap_decision(0), {"done": True, "message": "做完了"}]
        out = run_producer(self.canvas_id, decisions, executed_ok,
                           extra_env={"NOVAI_AGENT_V2_SELF_CHECK": "1"})
        checks = [item["data"] for item in out["events"] if item["event"] == "self_check"]
        self.assertEqual(len(checks), 1)
        self.assertTrue(checks[0]["passed"], checks[0])
        self.assertEqual(len(out["messages"]), 2, "通过就不该多打回")
        messages = [item["data"] for item in out["events"] if item["event"] == "message"]
        self.assertTrue(messages, "通过后正常发最终回复")

    def test_switch_off_has_no_self_check_event(self):
        decisions = [self._roadmap_decision(2), {"done": True, "message": "做完了"}]
        out = run_producer(self.canvas_id, decisions, executed_ok, extra_env={})
        self.assertFalse([item for item in out["events"] if item["event"] == "self_check"])
        self.assertEqual(len(out["messages"]), 2)


if __name__ == "__main__":
    unittest.main()
