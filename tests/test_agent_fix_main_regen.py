# -*- coding: utf-8 -*-
"""阶段三·2：审查后重新生成死循环修复（方案 §6.5 四条规则）+ 审查结论回灌转录。

规则 1：重新生成只用节点最初的输入，节点自己的输出永不为自己的参考图（服务端强制过滤）。
规则 2：审查结论只用来改提示词 / 参数；问题图只给审查模型看，不作生成输入。
规则 3：新旧请求（提示词 / 参数 / 参考图）完全相同 → 不发起生成，返回 unchanged。
规则 4：同一节点自动重跑最多 2 次，第 3 次拦下并返回「已到自动重跑上限，交用户选择」；旧结果不覆盖。
附加：审查结论写进运行转录（下一轮模型能看到）。
"""
import asyncio
import contextlib
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-fix-main-regen-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


class FakeTasks(object):
    def __init__(self):
        self.created = []
        self.enqueued = []

    def create(self, kind, payload, runner_name, provider_id="", model_id="", extra=None):
        task = {"id": "t%d" % (len(self.created) + 1), "kind": kind, "payload": payload, **(extra or {})}
        self.created.append(task)
        return task

    async def enqueue(self, task_id):
        self.enqueued.append(task_id)


def legacy_canvas(node_images=("/old.png",), text="版本A"):
    return {"id": "c1", "kind": "classic", "title": "老画布", "updated_at": 1700000000000,
            "nodes": [{"id": "n1", "type": "image", "text": text, "kind": "image",
                       "images": [{"url": url, "kind": "image"} for url in node_images]}],
            "connections": []}


def smart_canvas(text="版本A"):
    return {"id": "c1", "kind": "smart", "title": "智能画布", "updated_at": 1700000000000,
            "settings": {},
            "nodes": [
                {"id": "u1", "type": "smart-image", "x": 0, "y": 0,
                 "images": [{"url": "/up.png", "kind": "image"}]},
                {"id": "n1", "type": "smart-image", "x": 200, "y": 0, "text": text,
                 "promptDraftText": text, "images": [{"url": "/old.png", "kind": "image"}],
                 "runSettings": {"provider_id": "prov", "model": "m1", "count": 1}},
            ],
            "connections": [{"from": "u1", "to": "n1", "kind": "input"}]}


def beat_canvas(text="版本A"):
    return {"id": "c1", "kind": "classic", "title": "BEAT 画布", "updated_at": 1700000000000,
            "nodes": [
                {"id": "u1", "kind": "image",
                 "data": {"gen": {"title": "上游", "prompt": "参考", "hist": [{"url": "/up.png"}], "hi": 0}}},
                {"id": "n1", "kind": "image",
                 "data": {"gen": {"title": "海报", "prompt": text, "hi": 0,
                                  "params": {"model": "m1", "ratio": "3:4"},
                                  "hist": [{"url": "/old.png"}]}}},
            ],
            "connections": [{"from": "u1", "to": "n1", "kind": "input"}]}


@contextlib.contextmanager
def patched_generation(canvas):
    """把生成链路换成内存实现：load/mutate 就地改同一个 canvas，任务只记录不真发。"""
    tasks = FakeTasks()

    def fake_mutate(canvas_id, mutator):
        result = mutator(canvas)
        return canvas, result

    def fake_load(canvas_id):
        return canvas

    patches = [
        patch.object(main, "load_canvas", side_effect=fake_load),
        patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate),
        patch.object(main, "task_create", side_effect=tasks.create),
        patch.object(main, "task_enqueue", new=AsyncMock(side_effect=tasks.enqueue)),
        patch.object(main, "agent_image_size", return_value="1024x1024"),
        patch.object(main, "_agent_image_size_from_settings", return_value="1024x1024"),
    ]
    started = [item.start() for item in patches]
    try:
        yield tasks, canvas
    finally:
        for item in reversed(patches):
            item.stop()


def run_tool(tool, args):
    async def go():
        with contextlib.redirect_stdout(__import__("io").StringIO()):
            return await main.agent_execute_step(tool, args)
    return asyncio.run(go())


class RuleOneReferenceTests(unittest.TestCase):
    """规则 1：节点自己的产物永远不进它自己的参考图（服务端强制，不看 prompt 也不看模型传参）。"""

    def test_classic_regenerate_filters_explicit_self_output(self):
        canvas = legacy_canvas()
        with patched_generation(canvas) as (tasks, cv):
            norm = main._agent_tool_run_generation_validate(
                {"canvas_id": "c1", "node_id": "n1", "exclude_self_refs": True,
                 "reference_images": ["/old.png", "/explicit.png"]})
            result = asyncio.run(main._agent_tool_run_generation_run(norm))
        self.assertTrue(result.get("task_id"), result)
        refs = [item["url"] for item in tasks.created[0]["payload"]["reference_images"]]
        self.assertNotIn("/old.png", refs, "节点自己的问题图不能被当参考图再发一次")
        self.assertIn("/explicit.png", refs, "不是自己的显式参考图照旧保留")
        self.assertTrue(norm["exclude_self_refs"])

    def test_legacy_default_still_allows_own_image_for_manual_rerun(self):
        """手动「拿这张旧图再生成一版」是既有功能，不能被规则 1 误伤。"""
        canvas = legacy_canvas()
        with patched_generation(canvas) as (tasks, cv):
            norm = main._agent_tool_run_generation_validate({"canvas_id": "c1", "node_id": "n1"})
            asyncio.run(main._agent_tool_run_generation_run(norm))
        refs = [item["url"] for item in tasks.created[0]["payload"]["reference_images"]]
        self.assertEqual(refs, ["/old.png"])

    def test_smart_regenerate_filters_self_output_but_keeps_upstream(self):
        canvas = smart_canvas()
        with patched_generation(canvas) as (tasks, cv):
            norm = main._agent_tool_run_generation_validate(
                {"canvas_id": "c1", "node_id": "n1", "exclude_self_refs": True,
                 "reference_images": ["/old.png"]})
            result = asyncio.run(main._agent_tool_run_generation_run(norm))
        self.assertTrue(result.get("task_id"), result)
        refs = [item["url"] for item in tasks.created[0]["payload"]["reference_images"]]
        self.assertNotIn("/old.png", refs)
        self.assertIn("/up.png", refs, "上游连线的最初输入仍然要用")

    def test_beat_regenerate_marks_canvas_to_exclude_self_refs(self):
        canvas = beat_canvas()
        with patched_generation(canvas) as (tasks, cv):
            result = main._agent_beat_mark_run("c1", "n1", None, "image", exclude_self_refs=True)
        node = cv["nodes"][1]
        self.assertEqual(result["status"], "queued_on_canvas", result)
        self.assertTrue((node.get("data") or {}).get("agentRun"))
        self.assertTrue((node["data"]["agentRun"] or {}).get("excludeSelfRefs"),
                        "BEAT 画布开跑前要拿到「剔除节点自己的旧图」的标记")
        self.assertEqual(main._agent_regen_rerun_count(node), 1)


class RuleThreeUnchangedTests(unittest.TestCase):
    """规则 3：新旧请求完全一样 → 不发起生成，返回 unchanged。"""

    def test_same_request_is_not_rerun(self):
        canvas = legacy_canvas()
        with patched_generation(canvas) as (tasks, cv):
            first = run_tool("run_generation", {"canvas_id": "c1", "node_id": "n1",
                                                "exclude_self_refs": True})
            self.assertTrue(first["ok"], first)
            self.assertEqual(len(tasks.created), 1)
            second = run_tool("run_generation", {"canvas_id": "c1", "node_id": "n1",
                                                 "exclude_self_refs": True})
        self.assertTrue(second["ok"], second)
        self.assertEqual(second["result"]["status"], "unchanged", second["result"])
        self.assertEqual(len(tasks.created), 1, "请求没变就不能再发一次生成")
        self.assertIn("没有变化", second["result"]["message"])

    def test_plan_marks_unchanged_and_adds_no_generation_step(self):
        canvas = beat_canvas()
        node = canvas["nodes"][1]
        prospective = main._agent_regenerate_prospective(node, canvas, "n1", "版本A")
        record = main._agent_generation_request_record(prospective["kind"], prospective["prompt"],
                                                       prospective["refs"], prospective["params"])
        main._agent_regen_record(node, record, review_rerun=True)
        node["agentRegen"]["reruns"] = 0
        plan = main._agent_regenerate_plan(canvas, [{"node_id": "n1", "label": "海报"}], {}, "c1")
        self.assertEqual(plan["unchanged"], ["n1"])
        self.assertEqual(plan["steps"], [], "没变化不该给出任何生成步骤")
        self.assertEqual([step["tool"] for step in plan["steps"]], [])

    def test_route_returns_unchanged_without_starting_a_run(self):
        canvas = beat_canvas()
        node = canvas["nodes"][1]
        prospective = main._agent_regenerate_prospective(node, canvas, "n1", "")
        record = main._agent_generation_request_record(prospective["kind"], prospective["prompt"],
                                                       prospective["refs"], prospective["params"])
        main._agent_regen_record(node, record, review_rerun=True)
        node["agentRegen"]["reruns"] = 0
        payload = main.AgentRegenerateRequest(canvas_id="c1", items=[{"node_id": "n1", "label": "海报"}])
        with patch.object(main, "load_canvas", return_value=canvas), \
                patch.object(main, "_agent_run_resolve_chat", return_value={"provider": "p", "model": "m"}):
            result = asyncio.run(main.agent_regenerate(payload, object()))
        self.assertEqual(result["status"], "unchanged", result)
        self.assertEqual(result["regen"]["unchanged"], ["n1"])
        self.assertEqual(result["runId"], "")
        self.assertIn("没有变化", result["message"])


class RuleFourRerunLimitTests(unittest.TestCase):
    """规则 4：同一节点自动重跑最多 2 次，第 3 次拦下；旧结果保留不覆盖。"""

    def test_third_auto_rerun_is_blocked_and_old_result_kept(self):
        canvas = legacy_canvas()
        with patched_generation(canvas) as (tasks, cv):
            node = cv["nodes"][0]
            statuses = []
            for index, text in enumerate(("版本A", "版本B", "版本C"), start=1):
                node["text"] = text
                result = run_tool("run_generation", {"canvas_id": "c1", "node_id": "n1",
                                                     "exclude_self_refs": True})
                self.assertTrue(result["ok"], result)
                statuses.append(result["result"].get("status"))
                self.assertEqual(main._agent_regen_rerun_count(node), min(index, 2))
            self.assertEqual(statuses[:2], ["queued", "queued"])
            self.assertEqual(statuses[2], "review_rerun_limit", statuses)
            self.assertEqual(len(tasks.created), 2, "第 3 次不该再发任务")
            self.assertIn("已到自动重跑上限", result["result"]["message"])
            self.assertIn("交给用户", result["result"]["message"])
            self.assertEqual([img["url"] for img in node["images"]], ["/old.png"],
                             "旧结果保留、不覆盖")

    def test_route_blocks_when_limit_reached(self):
        canvas = beat_canvas()
        node = canvas["nodes"][1]
        node["agentRegen"] = {"reruns": main._AGENT_REVIEW_RERUN_LIMIT, "last": {}}
        payload = main.AgentRegenerateRequest(canvas_id="c1", items=[{"node_id": "n1", "label": "海报"}])
        with patch.object(main, "load_canvas", return_value=canvas), \
                patch.object(main, "_agent_run_resolve_chat", return_value={"provider": "p", "model": "m"}):
            result = asyncio.run(main.agent_regenerate(payload, object()))
        self.assertEqual(result["status"], "review_rerun_limit", result)
        self.assertEqual(result["regen"]["capped"], ["n1"])
        self.assertEqual(result["runId"], "")
        self.assertIn("已到自动重跑上限", result["message"])
        self.assertIn("交给用户", result["message"])

    def test_branch_result_node_shares_the_limit_with_its_source(self):
        """智能画布重跑会在右侧新开结果节点：护栏按 sourceNodeId 回溯到最初那个节点计数。"""
        canvas = legacy_canvas()
        canvas["nodes"] = [
            {"id": "n1", "type": "image", "text": "版本A", "images": [{"url": "/old.png", "kind": "image"}],
             "agentRegen": {"reruns": main._AGENT_REVIEW_RERUN_LIMIT, "last": {}}},
            {"id": "b1", "type": "image", "text": "版本B", "sourceNodeId": "n1",
             "images": [{"url": "/b-old.png", "kind": "image"}]},
        ]
        with patched_generation(canvas) as (tasks, cv):
            norm = main._agent_tool_run_generation_validate(
                {"canvas_id": "c1", "node_id": "b1", "exclude_self_refs": True})
            result = asyncio.run(main._agent_tool_run_generation_run(norm))
        self.assertEqual(result["status"], "review_rerun_limit", result)
        self.assertEqual(len(tasks.created), 0)
        self.assertEqual(main._agent_regen_rerun_count(cv["nodes"][0]),
                         main._AGENT_REVIEW_RERUN_LIMIT)

    def test_passing_review_resets_the_counter(self):
        canvas_id = "c-regen-reset-" + uuid.uuid4().hex[:8]
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        main.save_canvas({"id": canvas_id, "title": "重置计数", "kind": "classic",
                          "updated_at": int(main.time.time() * 1000),
                          "nodes": [{"id": "n1", "kind": "image",
                                     "data": {"gen": {"title": "海报", "prompt": "版本A", "hi": 0,
                                                      "hist": [{"url": "/old.png"}]}}}],
                          "connections": []})
        canvas = main.load_canvas(canvas_id)
        node = canvas["nodes"][0]
        node["agentRegen"] = {"reruns": 2, "last": {}}
        main._agent_mutate_canvas(canvas_id, lambda cv: cv["nodes"][0].setdefault("agentRegen", {}).update({"reruns": 2}))
        changed = main._agent_regen_reset_review_reruns(canvas_id, ["n1"])
        self.assertEqual(changed, 1)
        self.assertEqual(main._agent_regen_rerun_count(main.load_canvas(canvas_id)["nodes"][0]), 0)


    def test_review_route_returns_limit_status_without_steps(self):
        canvas = smart_canvas()
        node = canvas["nodes"][1]
        node["agentRegen"] = {"reruns": main._AGENT_REVIEW_RERUN_LIMIT, "last": {}}
        req = main.AgentReviewRequest(canvas_id="c1", items=[{"node_id": "n1", "url": "/old.png"}])
        reply = json.dumps({"summary": "不合格", "items": [
            {"label": "图1", "ok": False, "issues": ["杯身变形"], "revised_prompt": "杯身笔直"}]},
            ensure_ascii=False)
        chat = {"provider": "v", "base": "http://x", "headers": {}, "model": "fake-vision",
                "provider_cfg": {}}
        with patch.object(main, "load_canvas", return_value=canvas), \
                patch.object(main, "_agent_review_pick_chat", return_value=chat), \
                patch.object(main, "_agent_run_chat", new=AsyncMock(return_value=reply)), \
                patch.object(main, "_agent_image_payload_url",
                             side_effect=lambda url: "data:image/png;base64,AA"), \
                patch.object(main, "_agent_validate_settings", side_effect=lambda raw, kind: {}):
            with contextlib.redirect_stdout(__import__("io").StringIO()):
                out = asyncio.run(main.agent_review(req))
        self.assertEqual(out["mode"], "ok")
        self.assertEqual(out["status"], "review_rerun_limit", out)
        self.assertEqual(out["steps"], [], "到上限后不能再给生成步骤")
        self.assertEqual(out["regen"]["capped"], ["n1"])


class RuleTwoAndFiveTests(unittest.TestCase):
    """规则 2：审查结论只改提示词 / 参数，问题图不进生成输入。附加：审查结论进转录。"""

    def test_regenerate_plan_only_touches_prompt_and_params(self):
        canvas = beat_canvas()
        plan = main._agent_regenerate_plan(canvas, [{"node_id": "n1", "label": "海报"}],
                                           {"n1": "杯身笔直，光线更柔和"}, "c1")
        tools = [step["tool"] for step in plan["steps"]]
        self.assertEqual(tools, ["update_node", "run_generation"], tools)
        update, generation = plan["steps"]
        self.assertEqual(update["args"]["prompt"], "杯身笔直，光线更柔和")
        # 审查结论只用来改提示词：生成步骤不带审查里的问题图 / 任何参考图
        self.assertEqual([k for k in generation["args"] if k in ("reference_images", "reference_urls")], [])
        self.assertTrue(generation["args"]["exclude_self_refs"])

    def test_review_conclusion_lands_in_transcript(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        canvas_id = "c-regen-review-" + uuid.uuid4().hex[:8]
        main.save_canvas({"id": canvas_id, "title": "审查转录", "kind": "beat",
                          "updated_at": int(main.time.time() * 1000),
                          "nodes": [{"id": "n1", "kind": "image", "x": 0, "y": 0,
                                     "data": {"gen": {"title": "海报", "prompt": "版本A",
                                                      "hist": [{"url": "/old.png"}], "hi": 0}}}],
                          "connections": []})
        outcomes = [{"ok": True, "node_id": "n1", "url": "/old.png", "kind": "image",
                     "text": "图片生成成功 /old.png"}]
        review = {"summary": "1 个不合格", "items": [
            {"label": "海报", "node_id": "n1", "url": "/old.png", "kind": "image", "ok": False,
             "issues": ["杯身变形"], "revised_prompt": "杯身笔直"}]}
        decisions = [
            {"thought": "先出图", "steps": [{"tool": "generate_image",
                                            "args": {"canvas_id": canvas_id, "prompt": "冷蓝海报"}}]},
            {"done": True, "message": "出图了"},
        ]

        async def fake_decide(chat, messages, cid, tools_json_text="", tools=None, rebuild_json=None):
            return decisions.pop(0) if decisions else {"done": True, "message": "完成"}

        async def fake_execute(tool, args):
            return {"ok": True, "tool": tool, "message": "执行成功",
                    "result": {"status": "queued_on_canvas", "node_id": "n1", "kind": "image"}}

        async def fake_wait(self, node_ids, emit, cancelled, deadline=None):
            return [dict(item) for item in outcomes]

        async def fake_review(chat, instruction, roadmap, items):
            return dict(review)

        req = {"canvas_id": canvas_id, "run_id": "run_regen_review_" + uuid.uuid4().hex[:8],
               "instruction": "做一张海报", "focus": main._agent_run_normalize_focus(None),
               "history": [], "thread_id": "", "chat": {"provider": "p", "base": "http://x",
                                                        "headers": {}, "model": "m",
                                                        "provider_cfg": {"protocol": "custom"}},
               "max_steps": 0, "mode": "run", "approved_steps": [], "renderer": "beat",
               "use_thread": False, "enforce_write_confirmation": True}
        bus = main._agent_run_bus_new(req["run_id"], canvas_id)

        async def go():
            await main._agent_run_producer(req, None, bus=bus)

        env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2")}
        env["NOVAI_AGENT_V2_CONTEXT"] = "1"
        with patch.dict(os.environ, env, clear=True), \
                patch.object(main, "_agent_run_decide_v2", new=fake_decide), \
                patch.object(main, "agent_execute_step", new=fake_execute), \
                patch.object(main._CanvasRunContext, "wait_canvas_results", new=fake_wait), \
                patch.object(main, "_agent_beat_review", new=fake_review), \
                patch.object(main._CanvasRunContext, "confirmation_needed",
                             new=lambda self, steps, confirmed=False: {"needed": False, "tools": []}), \
                patch.object(main, "_agent_v2_memory_schedule", new=lambda *a, **k: None):
            asyncio.run(go())
        transcript = bus.get("transcript")
        self.assertIsNotNone(transcript, "CONTEXT=1 应该有运行转录")
        notes = [entry for entry in transcript.entries
                 if entry.get("type") == "note" and entry.get("kind") == "review"]
        self.assertTrue(notes, "审查结论要写进转录，成为下一轮输入")
        text = "\n".join(str(entry.get("text") or "") for entry in notes)
        self.assertIn("杯身变形", text)
        self.assertIn("杯身笔直", text)
        self.assertIn("不要再拿它当参考图重跑", text)


if __name__ == "__main__":
    unittest.main()
