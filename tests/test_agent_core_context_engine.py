# -*- coding: utf-8 -*-
"""上下文引擎 + 运行转录（server/agent_core）：纯函数，不 import main、不起服务、不打模型。

覆盖：转录落盘 / 恢复 / 折叠 / 摘要；对话历史按预算取 + 摘要接续；转录渲染成严格交替的消息；
占用到 70% 折叠旧结果、85% 要求摘要；环境状态永远在最后一条 user；画布地图超预算时收分组、写明省略数。
"""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.agent_core import context_engine as ce  # noqa: E402
from server.agent_core.read_tools import CanvasAccess  # noqa: E402
from server.agent_core.transcript import Transcript  # noqa: E402


def filled(rounds, size=1200, base_dir=None, run_id="run_t"):
    tr = Transcript(run_id, base_dir)
    for r in range(1, rounds + 1):
        tr.add_decision(r, {"thought": "第 %d 轮：先读再改" % r,
                            "steps": [{"tool": "read_node", "args": {"node_ids": ["n%d" % r]}, "description": "读节点"}]})
        tr.add_result(r, "read_node", {"node_ids": ["n%d" % r]}, True, {"text": ("内容%d " % r) * (size // 4)})
    return tr


class TranscriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-agent-core-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_roundtrip_keeps_folds_summary_and_step_numbers(self):
        tr = filled(5, base_dir=self.tmp)
        tr.add_note("steer", "比例改成 3:4", 5)
        first_result = tr.results()[0]
        self.assertTrue(tr.fold(first_result["seq"]))
        self.assertFalse(tr.fold(first_result["seq"]), "同一条不重复折叠")
        tr.add_summary(4, "【目标】出 5 张图")
        again = Transcript.load("run_t", self.tmp)
        self.assertEqual(len(again.entries), len(tr.entries))
        self.assertTrue(again.results()[0].get("folded"))
        self.assertEqual(again.steps_executed, 5)
        self.assertEqual(again.last_summary()["upto"], 4)
        # 恢复后接着写：编号不重复
        entry = again.add_result(6, "update_node", {}, False, error="节点不存在", code="node_not_found")
        self.assertEqual(entry["index"], 6)
        self.assertGreater(entry["seq"], tr.entries[-1]["seq"])

    def test_recall_returns_full_text_after_fold_and_summary(self):
        tr = filled(6)
        original = tr.step(1)["text"]
        tr.fold(tr.step(1)["seq"])
        tr.add_summary(tr.step(2)["seq"], "摘要")
        self.assertEqual(tr.step(1)["text"], original, "折叠 / 摘要都不删原文")
        self.assertNotIn(1, [e.get("index") for e in tr.visible() if e.get("type") == "result"])
        self.assertIsNone(tr.step(99))

    def test_broken_line_is_skipped_on_load(self):
        tr = filled(2, base_dir=self.tmp)
        with open(tr.path, "a", encoding="utf-8") as f:
            f.write('{"type": "result", "seq": 99, "inde\n')
        self.assertEqual(len(Transcript.load("run_t", self.tmp).entries), 4)

    def test_memory_only_when_no_base_dir(self):
        tr = filled(1)
        self.assertIsNone(tr.path)


class HistoryTest(unittest.TestCase):
    def msgs(self, n, size=300):
        return [{"role": "user" if i % 2 == 0 else "assistant", "text": "第%d条 " % i + "话" * size} for i in range(n)]

    def test_takes_newest_first_within_budget(self):
        picked = ce.select_history(self.msgs(40), cap_tokens=2000)
        self.assertTrue(picked["recent"])
        self.assertTrue(picked["recent"][-1]["text"].startswith("第39条"))
        self.assertLessEqual(picked["tokens"], 2000)
        self.assertGreater(picked["dropped"], 0, "没被摘要覆盖又没取进来的要报出来，调用方据此更新对话摘要")

    def test_summary_covers_old_messages_so_nothing_is_dropped(self):
        picked = ce.select_history(self.msgs(40), cap_tokens=4000, summary="用户定了 3:4，做了 5 张图", summary_upto=30)
        self.assertEqual(picked["summary"], "用户定了 3:4，做了 5 张图")
        self.assertEqual(picked["dropped"], 0)
        self.assertTrue(picked["recent"][0]["text"].startswith("第30条"))

    def test_not_capped_at_twenty_messages(self):
        picked = ce.select_history(self.msgs(60, size=20), cap_tokens=8000)
        self.assertEqual(len(picked["recent"]), 60, "预算够就全带上，不再固定 20 条")

    def test_single_oversized_message_is_truncated_not_lost(self):
        picked = ce.select_history([{"role": "user", "text": "长" * 3900}], cap_tokens=300)
        self.assertEqual(len(picked["recent"]), 1)
        self.assertTrue(picked["recent"][0]["text"].endswith("…"))

    def test_dirty_items_do_not_shift_summary_index(self):
        msgs = [{"role": "user", "text": "a"}, {"role": "tool", "text": "x"}, None, {"role": "assistant", "text": "b"}]
        picked = ce.select_history(msgs, 1000, summary="s", summary_upto=3)
        self.assertEqual([m["text"] for m in picked["recent"]], ["b"])


class RenderTest(unittest.TestCase):
    def test_strict_alternation_and_env_is_last(self):
        tr = filled(3, size=80)
        tr.add_note("steer", "换成竖版")
        build = ce.assemble("系统规则", "出 3 张海报", tr, history=[{"role": "assistant", "text": "上次做完了"}],
                            canvas_text="画布地图…", state_text="进度：第 4 轮", context_max=200000)
        roles = [m["role"] for m in build.messages]
        self.assertEqual(roles[0], "system")
        self.assertEqual(roles[1], "user", "system 之后第一条必须是 user")
        for a, b in zip(roles[1:], roles[2:]):
            self.assertNotEqual(a, b, "user / assistant 必须严格交替：%s" % roles)
        self.assertEqual(roles[-1], "user")
        last = build.messages[-1]["content"]
        self.assertIn("当前环境状态", last)
        self.assertIn("换成竖版", last, "插话并进最后一条 user")
        self.assertTrue(last.rstrip().endswith("进度：第 4 轮"))

    def test_prefix_is_stable_across_rounds(self):
        tr = filled(2, size=80)
        first = ce.assemble("系统规则", "出图", tr, canvas_text="地图A", context_max=200000).messages
        tr.add_decision(3, {"thought": "继续", "steps": [{"tool": "update_node", "args": {}}]})
        tr.add_result(3, "update_node", {}, True, {"ok": 1})
        second = ce.assemble("系统规则", "出图", tr, canvas_text="地图B", context_max=200000).messages
        # 除了最后一条（带环境状态）之外，前面的消息逐条相同：前缀缓存才命中得了
        self.assertEqual(first[:-1], second[:len(first) - 1])

    def test_failed_step_and_done_decision_render(self):
        tr = Transcript()
        tr.add_decision(1, {"thought": "改比例", "steps": [{"tool": "update_node", "args": {"node_id": "x"}}]})
        tr.add_result(1, "update_node", {"node_id": "x"}, False, error="节点 x 不存在", code="node_not_found")
        text = "\n".join(m["content"] for m in ce.render_transcript(tr))
        self.assertIn("#1 update_node 失败（code=node_not_found）：节点 x 不存在", text)

    def test_memory_goes_before_instruction_and_is_capped(self):
        memory = "\n".join("- 记忆 %d：%s" % (i, "偏好" * 40) for i in range(200))
        build = ce.assemble("系统", "做图", None, memory_text=memory, context_max=32000)
        self.assertLessEqual(build.layers["memory"], ce.Budget(32000).cap("memory"))
        content = build.messages[1]["content"]
        self.assertLess(content.index("- 记忆 0"), content.index("用户指令：做图"))


class CompactionTest(unittest.TestCase):
    def test_no_compaction_when_small(self):
        build = ce.assemble("系统", "做图", filled(3, size=200), context_max=200000)
        self.assertEqual(build.actions, [])
        self.assertEqual(build.needs_summary, 0)

    def test_fold_kicks_in_before_summary_and_keeps_recent_results(self):
        tr = filled(12, size=1600)
        build = ce.assemble("系统", "做图", tr, context_max=16000)
        self.assertTrue(build.actions and build.actions[0]["level"] == "fold")
        self.assertLess(build.actions[0]["after_tokens"], build.actions[0]["before_tokens"])
        results = tr.results()
        self.assertTrue(results[0].get("folded"))
        for entry in results[-ce.KEEP_RECENT_RESULTS:]:
            self.assertFalse(entry.get("folded"), "最近几条结果不能折叠")
        text = "\n".join(m["content"] for m in build.messages if isinstance(m["content"], str))
        self.assertIn("已折叠，原文用 recall_step 取回，index=1", text)

    def test_summary_requested_when_fold_is_not_enough(self):
        tr = Transcript()
        for r in range(1, 31):       # 结果都很短（折叠不了），决策很长：只能靠摘要
            tr.add_decision(r, {"thought": "想" * 600, "steps": [{"tool": "update_node", "args": {"i": r}}]})
            tr.add_result(r, "update_node", {"i": r}, True, {"ok": True})
        build = ce.assemble("系统", "做图", tr, context_max=16000)
        self.assertGreater(build.needs_summary, 0)
        cut = build.needs_summary
        protected = tr.results()[-ce.KEEP_RECENT_RESULTS]["seq"]
        self.assertLess(cut, protected, "最近的结果不进摘要")
        cut_entry = next(e for e in tr.entries if e["seq"] == cut)
        self.assertEqual(cut_entry["type"], "result", "切点不能把决策和它的结果拆开")
        request = ce.summary_request(tr, cut, "做图")
        self.assertIn("【已定决策】", request[0]["content"])
        self.assertNotIn("#%d update_node" % tr.results()[-1]["index"], request[1]["content"])
        tr.add_summary(cut, "【目标】做图\n【已定决策】3:4")
        after = ce.assemble("系统", "做图", tr, context_max=16000)
        self.assertEqual(after.needs_summary, 0)
        self.assertLess(after.used, build.used)
        self.assertIn("【已定决策】3:4", "\n".join(m["content"] for m in after.messages))

    def test_unknown_window_uses_conservative_budget_but_reports_no_percentage(self):
        build = ce.assemble("系统", "做图", filled(30, size=1600), context_max=0)
        self.assertFalse(build.max_known)
        self.assertIsNone(build.percentage)
        event = build.usage_event()
        self.assertEqual(event["max_tokens"], 0, "不知道窗口大小就不给上限，前端只显示绝对值")
        self.assertIn("transcript", event["layers"])
        self.assertTrue(build.actions, "预算仍按保守默认值生效")

    def test_estimate_matches_main_rule(self):
        self.assertEqual(ce.estimate_tokens("你好 world!"), 2 + 2)
        self.assertEqual(ce.estimate_tokens(""), 0)
        self.assertEqual(ce.estimate_tokens(None), 0)


class CanvasMapTest(unittest.TestCase):
    def canvas(self, n=30, group=True):
        nodes = [{"id": "n%d" % i, "kind": "image", "x": (i % 6) * 300, "y": (i // 6) * 300,
                  "data": {"gen": {"title": "图%d" % i, "prompt": "一只在海边的猫 %d" % i,
                                   "hist": [{"url": "/a/%d.png" % i}] if i % 2 else []}}} for i in range(n)]
        nodes.append({"id": "t1", "kind": "text", "x": 0, "y": -300, "text": "分镜：镜头一 开场……",
                      "data": {"gen": {"title": "分镜"}}})
        if group:
            nodes.append({"id": "g1", "kind": "group", "x": -400, "y": 0, "text": "白底图",
                          "children": ["n0", "n1", "n2", "n3"], "data": {"stack": True}})
        return {"id": "c1", "title": "口红项目", "nodes": nodes,
                "connections": [{"id": "e1", "from": "t1", "to": "n5"}, {"id": "e2", "from": "g1", "to": "n5"}]}

    def test_one_line_per_node_and_focus_gets_detail(self):
        text = ce.canvas_map(self.canvas(), CanvasAccess(), cap_tokens=6000, focus_ids=["n5"], recent_ids=["t1", "nope"])
        self.assertIn("画布「口红项目」：32 个节点，2 条连线", text)
        self.assertIn("- n7 | image | 图7 | 有结果 | 0 | 一只在海边的猫 7", text)
        self.assertIn("- n5 | image | 图5 | 有结果 | 2 |", text, "上游数来自连线")
        self.assertIn('"upstream"', text, "重点节点给完整信息")
        self.assertIn("分镜：镜头一 开场", text)
        self.assertNotIn("没列出", text)

    def test_over_budget_collapses_group_members_then_reports_omitted(self):
        text = ce.canvas_map(self.canvas(n=200), CanvasAccess(), cap_tokens=900)
        self.assertNotIn("- n1 | image", text, "分组成员先收进分组行")
        self.assertIn("- g1 | group | 白底图 | - | 0 | 堆叠，成员 4 个", text)
        self.assertIn("4 个分组成员没有单独列出", text)
        self.assertRegex(text, r"另有 \d+ 个节点没列出，用 search_canvas")
        self.assertLessEqual(ce.estimate_tokens(text), 900 + 120)

    def test_max_nodes_cap(self):
        text = ce.canvas_map(self.canvas(n=50, group=False), CanvasAccess(), cap_tokens=100000, max_nodes=10)
        self.assertEqual(text.count("\n- "), 10)
        self.assertIn("另有 41 个节点没列出", text)


class AttachImagesTest(unittest.TestCase):
    def test_images_go_on_last_user_message_only(self):
        msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "a"},
                {"role": "assistant", "content": "b"}, {"role": "user", "content": "c"}]
        out = ce.attach_images(msgs, [{"url": "data:image/png;base64,xx", "label": "图3"}, {"label": "没地址"}])
        self.assertEqual(out[1]["content"], "a")
        parts = out[3]["content"]
        self.assertEqual(parts[0], {"type": "text", "text": "c"})
        self.assertEqual(parts[-1]["image_url"]["url"], "data:image/png;base64,xx")
        self.assertEqual(len([p for p in parts if p["type"] == "image_url"]), 1)
        self.assertEqual(msgs[3]["content"], "c", "不改传进来的列表")
        self.assertIs(ce.attach_images(msgs, []), msgs)


class ResultRenderCapTest(unittest.TestCase):
    """A1：单条结果进提示词要有渲染上限，超出部分让模型用 recall_step 按编号取回。"""

    def test_huge_result_is_cut_with_recall_hint(self):
        tr = Transcript()
        tr.add_decision(1, {"thought": "读大节点", "steps": [{"tool": "read_node", "args": {"node_ids": ["n1"]}}]})
        tr.add_result(1, "read_node", {"node_ids": ["n1"]}, True, "字" * 20000)
        line = ce._result_line(tr.results()[0])
        self.assertLessEqual(len(line), ce.RESULT_RENDER_MAX_CHARS + 200)
        self.assertIn("完整内容用 recall_step index=1 取回", line)
        self.assertEqual(tr.step(1)["text"], "字" * 20000, "原文一条不少，recall_step 取得到")

    def test_short_result_is_not_cut(self):
        tr = Transcript()
        tr.add_decision(1, {"thought": "读", "steps": [{"tool": "read_node", "args": {}}]})
        tr.add_result(1, "read_node", {}, True, "短内容")
        line = ce._result_line(tr.results()[0])
        self.assertIn("短内容", line)
        self.assertNotIn("recall_step index=", line)


class BudgetCeilingTest(unittest.TestCase):
    """A1 验收：窗口未知（32000 保守预算）时连续读大节点，每轮 used ≤ usable，且压缩过就会被看见。"""

    def test_three_huge_reads_stay_under_usable_budget(self):
        budget = ce.Budget(0)
        self.assertEqual(budget.usable, 28160, "未知窗口的保守额度")
        tr = Transcript()
        system = "规则" * 6000          # 约 1.2 万 token：真实 system 前缀（角色 + 工具定义）的量级
        actions = []
        for r in range(1, 4):
            tr.add_decision(r, {"thought": "读第 %d 个两万字节点" % r,
                                "steps": [{"tool": "read_node", "args": {"node_ids": ["n%d" % r]}}]})
            tr.add_result(r, "read_node", {"node_ids": ["n%d" % r]}, True, "节点正文" * 5000)
            build = ce.assemble(system, "继续", tr, context_max=0)
            self.assertLessEqual(build.used, budget.usable, "第 %d 轮 used 超额度：%d" % (r, build.used))
            actions.extend(build.actions)
        self.assertTrue(actions, "预算压下来了就必须报上下文压缩（context_compacted）")
        self.assertEqual(actions[0]["level"], "fold")
        self.assertLess(actions[0]["after_tokens"], actions[0]["before_tokens"])

    def test_keep_recent_results_is_not_a_hard_protection(self):
        tr = filled(3, size=8000)
        build = ce.assemble("系统", "做图", tr, context_max=8000)
        results = tr.results()
        self.assertTrue(any(entry.get("folded") for entry in results), "最近几条在预算不够时也要能折")
        self.assertFalse(results[-1].get("folded"), "最近的一条仍然留原文")
        self.assertLessEqual(build.used, ce.Budget(8000).usable)
        self.assertEqual(build.actions[0]["level"], "fold")


class NativeRenderTest(unittest.TestCase):
    """A6：tool_calls 与 tool 消息一一对应；没执行的步骤不产生悬空 tool_call。"""

    def assert_paired(self, messages):
        call_ids = {}
        for msg in messages:
            for call in msg.get("tool_calls") or []:
                self.assertNotIn(call["id"], call_ids, "call id 必须唯一")
                call_ids[call["id"]] = 0
        for msg in messages:
            if msg.get("role") == "tool":
                self.assertIn(msg.get("tool_call_id"), call_ids, "tool 消息必须有对应的 tool_call")
                call_ids[msg["tool_call_id"]] += 1
        for call_id, count in call_ids.items():
            self.assertEqual(count, 1, "每个 tool_call 必须恰好一条 tool 消息：%s" % call_id)

    def test_tool_calls_and_tool_messages_pair_up_exactly(self):
        tr = Transcript()
        tr.add_decision(1, {"thought": "读两个节点", "steps": [
            {"tool": "read_node", "args": {"node_ids": ["n1"]}},
            {"tool": "read_node", "args": {"node_ids": ["n2"]}}]})
        tr.add_result(1, "read_node", {"node_ids": ["n1"]}, True, "节点 1 正文")
        tr.add_result(1, "read_node", {"node_ids": ["n2"]}, True, "节点 2 正文")
        messages = ce.render_transcript(tr, native=True)
        assistant = [m for m in messages if m.get("tool_calls")][0]
        self.assertEqual(len(assistant["tool_calls"]), 2)
        self.assertEqual([m["tool_call_id"] for m in messages if m["role"] == "tool"],
                         [call["id"] for call in assistant["tool_calls"]])
        self.assert_paired(messages)

    def test_unexecuted_step_does_not_leave_dangling_tool_call(self):
        tr = Transcript()
        tr.add_decision(1, {"thought": "先读再改", "steps": [
            {"tool": "read_node", "args": {}}, {"tool": "update_node", "args": {"node_id": "n1"}}]})
        tr.add_result(1, "read_node", {}, True, "正文")
        messages = ce.render_transcript(tr, native=True)
        assistant = [m for m in messages if m.get("tool_calls")][0]
        self.assertEqual([call["function"]["name"] for call in assistant["tool_calls"]], ["read_node"])
        self.assertIn("update_node", assistant["content"], "没执行的步骤要写清楚，别当成已完成")
        self.assert_paired(messages)

    def test_same_tool_twice_with_one_result_keeps_one_call(self):
        tr = Transcript()
        tr.add_decision(1, {"thought": "读两个", "steps": [
            {"tool": "read_node", "args": {"node_ids": ["n1"]}},
            {"tool": "read_node", "args": {"node_ids": ["n2"]}}]})
        tr.add_result(1, "read_node", {"node_ids": ["n1"]}, True, "只拿到一个")
        messages = ce.render_transcript(tr, native=True)
        self.assertEqual(len([m for m in messages if m["role"] == "tool"]), 1)
        self.assertIn("read_node", [m for m in messages if m.get("tool_calls")][0]["content"])
        self.assert_paired(messages)

    def test_result_without_planned_step_is_kept_as_text(self):
        tr = Transcript()
        tr.add_decision(1, {"thought": "读", "steps": [{"tool": "read_node", "args": {}}]})
        tr.add_result(1, "read_node", {}, True, "按计划读到的")
        tr.add_result(1, "search_canvas", {}, True, "意外多出来的一步")
        messages = ce.render_transcript(tr, native=True)
        self.assert_paired(messages)
        text = "\n".join(str(m.get("content") or "") for m in messages)
        self.assertIn("意外多出来的一步", text, "没配对的工具结果不能悄悄丢掉")

    def test_assemble_native_keeps_pairing(self):
        tr = Transcript()
        tr.add_decision(1, {"thought": "读", "steps": [{"tool": "read_node", "args": {"node_ids": ["n1"]}}]})
        tr.add_result(1, "read_node", {}, True, "正文" * 100)
        build = ce.assemble("系统", "做图", tr, history=[{"role": "assistant", "text": "上次做完了"}],
                            context_max=200000, native_tools=True)
        self.assert_paired(build.messages)
        self.assertEqual(build.messages[0]["role"], "system")
        self.assertTrue(any(m.get("tool_calls") for m in build.messages))


class ThreadHistoryTest(unittest.TestCase):
    """A5：assemble 接线程摘要入参，并如实返回没进上下文的条数。"""

    def history(self, count=60, size=400):
        return [{"role": "user" if index % 2 == 0 else "assistant",
                 "text": "第%d条 " % index + "话" * size} for index in range(count)]

    def test_summary_covers_old_messages_and_dropped_is_reported(self):
        build = ce.assemble("系统", "继续", None, history=self.history(),
                            thread_summary="之前定了 3:4 竖版", summary_upto=40, context_max=32000)
        text = "\n".join(str(m.get("content") or "") for m in build.messages)
        self.assertIn("之前定了 3:4 竖版", text)
        self.assertIn("第59条", text, "最新一条原文要带上")
        self.assertNotIn("第39条", text, "被摘要覆盖的消息不再重复进原文")
        self.assertGreater(build.history_dropped, 0, "预算放不下的条数要如实报出来")
        self.assertLess(build.history_dropped, 60 - 40 + 1, "只报摘要之后没进来的那些，不把已覆盖的算进去")
        self.assertLessEqual(build.used, ce.Budget(32000).usable)

    def test_all_messages_fit_is_not_reported_as_dropped(self):
        build = ce.assemble("系统", "继续", None, history=self.history(10, 20),
                            thread_summary="摘要", summary_upto=2, context_max=32000)
        self.assertEqual(build.history_dropped, 0)

    def test_long_history_is_dropped_within_budget(self):
        build = ce.assemble("系统", "继续", None, history=self.history(300), context_max=32000)
        self.assertLessEqual(build.used, ce.Budget(32000).usable)
        self.assertGreater(build.history_dropped, 200)

    def test_summary_upto_beyond_history_does_not_crash(self):
        build = ce.assemble("系统", "继续", None, history=self.history(5, 10),
                            thread_summary="摘要", summary_upto=99, context_max=32000)
        self.assertEqual(build.history_dropped, 0)
        self.assertTrue(any(m["role"] == "user" for m in build.messages))


if __name__ == "__main__":
    unittest.main()
