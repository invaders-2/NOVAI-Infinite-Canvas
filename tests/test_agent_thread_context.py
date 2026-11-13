# -*- coding: utf-8 -*-
"""会话历史里的步骤摘要：上一轮真正做过的步骤要能带进下一轮上下文（含被取消的那一轮）。

摘要规则不认具体工具名：主体用模型写的 description（没写退回工具名），结果按输出的通用特征取
（文字摘要 / 条数 / status）。纯函数 + 打桩跑一次被取消的 producer：临时数据目录 + import main，不起服务、不打模型。
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

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-agent-thread-context-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def step_lines(text):
    return [line for line in str(text or "").splitlines() if line.startswith("[步骤] ")]


def real_search_output(items=5, sources=None):
    return json.dumps({"engine": "multi", "query": "女性模卡",
                       "sources": sources or {"huaban": 10, "bing": 13, "360": 1},
                       "items": [{"url": None, "original_url": "https://example.com/%d.jpg" % i}
                                 for i in range(items)]}, ensure_ascii=False)


class ThreadHistoryStepTests(unittest.TestCase):

    def test_assistant_steps_become_step_lines(self):
        thread = {"messages": [
            {"role": "user", "text": "帮我搜一下女性模卡"},
            {"role": "assistant", "text": "用户取消了本次运行", "actions": ["search_images"],
             "steps": [{"index": 0, "tool": "search_images", "ok": True,
                        "description": "搜女性模卡", "output": real_search_output()}]},
            {"role": "user", "text": "韩系的"},
        ]}
        history = main._agent_thread_history(thread)
        self.assertEqual([row["role"] for row in history], ["user", "assistant", "user"])
        assistant_text = history[1]["text"]
        self.assertIn("[动作] search_images", assistant_text)
        self.assertIn("[步骤] 搜女性模卡：返回 24 条", assistant_text)
        self.assertEqual(history[0]["text"], "帮我搜一下女性模卡")

    def test_legacy_message_without_steps_unchanged(self):
        thread = {"messages": [
            {"role": "assistant", "text": "改好了", "actions": ["update_node（settings）"]},
            {"role": "user", "text": "改成 3:2"},
        ]}
        history = main._agent_thread_history(thread)
        self.assertEqual(history[0]["text"], "改好了\n[动作] update_node（settings）")
        self.assertNotIn("[步骤]", history[0]["text"])
        self.assertEqual(history[1]["text"], "改成 3:2")

    def test_unknown_tool_has_generic_summary(self):
        # 没有工具清单：任何陌生工具（MCP / 技能工具）都走同一套规则
        counted = main._agent_thread_step_summary(
            {"tool": "mcp__foo__bar", "ok": True, "output": json.dumps({"items": [{}, {}, {}]})})
        self.assertEqual(counted, "mcp__foo__bar：返回 3 条")
        plain = main._agent_thread_step_summary(
            {"tool": "mcp__foo__bar", "ok": True, "output": "网页正文第一行\n第二行"})
        self.assertEqual(plain, "mcp__foo__bar：网页正文第一行 第二行")
        described = main._agent_thread_step_summary(
            {"tool": "mcp__foo__bar", "ok": True, "description": "查了资料",
             "output": json.dumps({"items": [{}, {}]})})
        self.assertEqual(described, "查了资料：返回 2 条")

    def test_description_wins_over_tool_name(self):
        with_desc = main._agent_thread_step_summary(
            {"tool": "create_node", "ok": True, "description": "建了节点 韩系模特1",
             "output": json.dumps({"node_id": "agent_123"})})
        self.assertEqual(with_desc, "建了节点 韩系模特1")
        without_desc = main._agent_thread_step_summary(
            {"tool": "create_node", "ok": True, "output": json.dumps({"node_id": "agent_123"})})
        self.assertTrue(without_desc.startswith("create_node"))

    def test_counts_are_generic(self):
        real = main._agent_thread_step_summary(
            {"tool": "search_images", "ok": True, "output": real_search_output()})
        self.assertEqual(real, "search_images：返回 24 条")
        with_total = main._agent_thread_step_summary(
            {"tool": "anything", "ok": True,
             "output": json.dumps({"total": 12, "items": [{}] * 3})})
        self.assertEqual(with_total, "anything：返回 12 条")
        items_only = main._agent_thread_step_summary(
            {"tool": "anything", "ok": True, "output": json.dumps({"items": [{}] * 7})})
        self.assertEqual(items_only, "anything：返回 7 条")
        numeric_sum = main._agent_thread_step_summary(
            {"tool": "anything", "ok": True,
             "output": json.dumps({"sources": {"a": 10, "b": 14}})})  # 不是工具名，是「值全数字的 dict」
        self.assertEqual(numeric_sum, "anything：返回 24 条")
        mixed_dict = main._agent_thread_step_summary(
            {"tool": "anything", "ok": True,
             "output": json.dumps({"meta": {"count": 5, "label": "x"}})})
        self.assertNotIn("返回", mixed_dict)

    def test_count_wins_over_note(self):
        # 真实搜图形状：sources 合计 24 + items 5 + note 有内容 → 报「返回 24 条」，不把附带说明当结果
        output = json.dumps({"engine": "multi", "query": "女性模卡",
                             "sources": {"huaban": 10, "bing": 13, "360": 1},
                             "items": [{}] * 5,
                             "note": "部分来源失败或跳过（堆糖：没有搜到原图）"}, ensure_ascii=False)
        line = main._agent_thread_step_summary(
            {"tool": "search_images", "ok": True, "output": output})
        self.assertEqual(line, "search_images：返回 24 条")
        self.assertNotIn("堆糖", line)

    def test_zero_or_false_count_falls_back_to_note(self):
        for payload in ({"note": "没有搜到原图", "total": 0, "items": []},
                        {"note": "没有搜到原图", "items": False}):
            line = main._agent_thread_step_summary(
                {"tool": "search_images", "ok": True,
                 "output": json.dumps(payload, ensure_ascii=False)})
            self.assertEqual(line, "search_images：没有搜到原图")

    def test_summary_wins_over_count(self):
        line = main._agent_thread_step_summary(
            {"tool": "search_images", "ok": True,
             "output": json.dumps({"summary": "已搜到 24 张，部分来源跳过",
                                   "sources": {"a": 24}}, ensure_ascii=False)})
        self.assertEqual(line, "search_images：已搜到 24 张，部分来源跳过")

    def test_text_hints(self):
        for key in ("summary", "note", "message"):
            line = main._agent_thread_step_summary(
                {"tool": "anything", "ok": True, "description": "改了比例",
                 "output": json.dumps({key: "已改成 3:2"})})
            self.assertEqual(line, "改了比例：已改成 3:2")
        long_text = main._agent_thread_step_summary(
            {"tool": "anything", "ok": True, "output": json.dumps({"summary": "很长" * 100})})
        self.assertLessEqual(len(long_text), 120)

    def test_status_hint(self):
        line = main._agent_thread_step_summary(
            {"tool": "generate_image", "ok": True, "description": "生模特图",
             "output": json.dumps({"node_id": "agent_9", "status": "ready_to_generate"})})
        self.assertEqual(line, "生模特图：ready_to_generate")

    def test_empty_output_keeps_description_only(self):
        line = main._agent_thread_step_summary(
            {"tool": "anything", "ok": True, "description": "看画布",
             "output": json.dumps({"nodes": []})})
        self.assertEqual(line, "看画布")

    def test_failure_uses_description_and_error(self):
        line = main._agent_thread_step_summary(
            {"tool": "update_node", "ok": False, "description": "改节点 图3", "error": "节点不存在"})
        self.assertEqual(line, "改节点 图3（失败：节点不存在）")
        no_desc = main._agent_thread_step_summary(
            {"tool": "update_node", "ok": False, "error": "节点不存在"})
        self.assertEqual(no_desc, "update_node（失败：节点不存在）")
        long_error = main._agent_thread_step_summary(
            {"tool": "anything", "ok": False, "error": "错误" * 100})
        self.assertLessEqual(len(long_error), 120)
        self.assertEqual(long_error.count("错误"), 30)  # error 只取前 60 字

    def test_step_line_is_clipped(self):
        line = main._agent_thread_step_summary(
            {"tool": "anything", "ok": True, "description": "步骤说明" * 25,
             "output": "输出内容" * 20})
        self.assertEqual(len(line), 120)
        self.assertTrue(line.endswith("…"))
        self.assertNotIn("\n", line)

    def test_step_lines_are_limited(self):
        steps = [{"index": index, "tool": "mcp__foo__fetch", "ok": True,
                  "output": "第%d条 " % index + "超长输出" * 1000} for index in range(8)]
        history = main._agent_thread_history({"messages": [
            {"role": "assistant", "text": "跑了", "steps": steps}]})
        lines = step_lines(history[0]["text"])
        self.assertEqual(len(lines), 4)
        for line in lines:
            self.assertLessEqual(len(line), len("[步骤] ") + 120)
        self.assertNotIn("超长输出" * 100, history[0]["text"])

    def test_step_line_has_no_newlines(self):
        line = main._agent_thread_step_summary(
            {"tool": "update_node", "ok": True, "output": "第一行\n第二行\n第三行"})
        self.assertNotIn("\n", line)
        self.assertIn("第一行 第二行 第三行", line)

    def test_compact_steps_persist_description(self):
        long_desc = "查资料" * 100
        compacted, _ = main._agent_thread_compact_steps(
            [{"index": 0, "tool": "mcp__foo__bar", "ok": True,
              "description": long_desc, "output": "ok"}])
        self.assertEqual(len(compacted[0]["description"]), 200)
        from_history = main._agent_thread_steps_from_history(
            [{"index": 1, "tool": "mcp__foo__bar", "ok": True,
              "description": long_desc, "digest": "ok"}])
        self.assertEqual(len(from_history[0]["description"]), 200)
        self.assertEqual(from_history[0]["description"][:3], "查资料")


class CompletedLinesTests(unittest.TestCase):

    def covered_history(self):
        return [
            {"index": 0, "tool": "search_images", "ok": True, "digest": real_search_output()},
            {"index": 1, "tool": "update_node", "ok": False, "error": "节点不存在"},
            {"index": 2, "tool": "mcp__foo__bar", "ok": True, "digest": "网页正文"},
            {"index": 3, "tool": "create_node", "ok": True, "description": "建了节点 图3",
             "digest": json.dumps({"node_id": "agent_1"})},
            {"index": 4, "tool": "connect_nodes", "ok": True, "digest": json.dumps({})},
        ]

    def test_only_ok_steps_kept(self):
        lines = main._agent_thread_completed_lines(self.covered_history())
        self.assertTrue(lines)
        self.assertFalse([line for line in lines if "节点不存在" in line])

    def test_at_most_three_lines(self):
        lines = main._agent_thread_completed_lines(self.covered_history())
        self.assertLessEqual(len(lines), 3)

    def test_completed_lines_use_generic_rules(self):
        lines = main._agent_thread_completed_lines(self.covered_history())
        self.assertEqual(lines[0], "search_images：返回 24 条")
        self.assertEqual(lines[1], "mcp__foo__bar：网页正文")
        self.assertEqual(lines[2], "建了节点 图3")

    def test_no_successful_step_gives_empty_list(self):
        self.assertEqual(main._agent_thread_completed_lines(
            [{"index": 0, "tool": "search_images", "ok": False, "error": "失败"}]), [])


class CancelledRunReplyTests(unittest.TestCase):

    def drive_cancelled(self, canvas_id, run_id, replies):
        canvas = {"id": canvas_id, "kind": "smart", "title": "取消测试画布",
                  "nodes": [], "connections": [], "updated_at": 1700000000000}
        req = {"run_id": run_id, "canvas_id": canvas_id, "thread_id": "", "use_thread": True,
               "instruction": "帮我搜一下女性模卡",
               "focus": main._agent_run_normalize_focus(None), "history": [],
               "chat": {"provider": "p", "base": "http://x", "headers": {},
                        "model": "test-chat-model", "provider_cfg": {}},
               "max_steps": 6, "mode": "run", "approved_steps": [],
               "enforce_write_confirmation": True}
        bus = main._agent_run_bus_new(run_id)
        bus["cancel_requested"] = True
        model = AsyncMock(side_effect=replies)
        execute = AsyncMock(return_value={"ok": True, "result": {"nodes": []}, "message": "执行成功"})

        async def go():
            with contextlib.redirect_stdout(io.StringIO()), \
                    patch.object(main, "load_canvas", return_value=canvas), \
                    patch.object(main, "agent_session_save"), \
                    patch.object(main, "_agent_run_chat", new=model), \
                    patch.object(main, "agent_execute_step", new=execute):
                try:
                    await main._agent_run_producer(req, None, bus=bus)
                except asyncio.CancelledError:
                    pass

        asyncio.run(go())
        return main.agent_thread_load(canvas_id)["messages"]

    def test_cancelled_reply_keeps_completed_steps(self):
        canvas_id, run_id = "c_ctx_cancel_done", "run_ctx_cancel_done"
        step_reply = json.dumps({"thought": "先看画布", "steps": [
            {"tool": "get_canvas", "args": {"canvas_id": canvas_id}, "description": "看画布"}],
            "done": False}, ensure_ascii=False)
        messages = self.drive_cancelled(canvas_id, run_id,
                                        [step_reply, asyncio.CancelledError()])
        assistant = messages[-1]
        self.assertEqual(assistant["role"], "assistant")
        self.assertTrue(assistant["text"].startswith("用户取消了本次运行"))
        self.assertIn("停之前已完成：", assistant["text"])
        self.assertIn("看画布", assistant["text"])
        self.assertEqual(len(assistant.get("steps") or []), 1)
        self.assertEqual(assistant["steps"][0]["description"], "看画布")
        history = main._agent_thread_history(main.agent_thread_load(canvas_id))
        self.assertIn("[步骤] 看画布", history[-1]["text"])
        self.assertIn("[动作] get_canvas", history[-1]["text"])

    def test_cancelled_without_completed_steps_keeps_original_reply(self):
        canvas_id, run_id = "c_ctx_cancel_empty", "run_ctx_cancel_empty"
        messages = self.drive_cancelled(canvas_id, run_id, [asyncio.CancelledError()])
        self.assertEqual(messages[-1]["text"], "用户取消了本次运行")


if __name__ == "__main__":
    unittest.main()
