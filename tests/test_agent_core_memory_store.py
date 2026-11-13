# -*- coding: utf-8 -*-
"""跨会话记忆第一层（server/agent_core/memory_store）：纯函数，不 import main、不起服务、不打模型。

覆盖：摘要触发条件（自上次摘要后新增 ≥6 条）、固定结构摘要的请求与解析、摘要写回不删原文、
旧线程文件（没有 summary 字段）兼容、档案合并与 800 字上限、相关性检索（中文二元组 + 最近几条 + 预算）、
整体方案进度推算、开场注入文本、档案落盘的读 / 写 / 删；
以及阶段二·2 的增量索引（可读文本、稳定 key、追加去重、scope 过滤、出处、片段、空结果、删条目）。
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.agent_core import memory_store as ms  # noqa: E402


def messages(count, base="内容", role=None):
    """造 count 条对话消息（user / assistant 交替）。"""
    out = []
    for index in range(count):
        out.append({"role": role or ("user" if index % 2 == 0 else "assistant"),
                    "text": "%s%d" % (base, index), "at": 1700000000 + index})
    return out


def summary_text(goal="出 5 张卖货海报", decisions="3:4 竖版；2k；暖色调", done="已出 3 张（海报图 i1、i2）",
                 nodes="i1、i2、海报图", pending="等用户确认是否继续出剩下 2 张", corrections="原来 1:1，改成 3:4 竖版"):
    return ("【目标】%s\n【已定决策】%s\n【已完成】%s\n【涉及节点】%s\n【未决事项】%s\n【用户纠正】%s"
            % (goal, decisions, done, nodes, pending, corrections))


def thread(count=8, summary="", upto=0, roadmap=None, thread_id="th_1", title="对话 1", steps=None):
    item = {"id": thread_id, "title": title, "messages": messages(count), "recent": [],
            "updated_at": 1700000100}
    if summary:
        item["summary"] = summary
        item["summary_upto"] = upto
    if roadmap:
        item["roadmap"] = roadmap
    if steps:
        item["messages"] = item["messages"] + [{"role": "assistant", "text": "做完了", "steps": steps}]
    return item


class SummaryTriggerTest(unittest.TestCase):
    def test_default_threshold_is_one_normal_turn(self):
        """默认阈值 2：一次正常问答只写 2 条线程消息（用户 + 助手）就该摘要 / 出候选。
        原来是 6，普通用户永远等不到候选卡（真机验收踩过，只能手工补历史才触发）。"""
        self.assertFalse(ms.should_summarize(messages(1)))
        self.assertTrue(ms.should_summarize(messages(2)))
        self.assertTrue(ms.should_summarize(messages(30)))

    def test_threshold_env_override(self):
        with patch.dict(os.environ, {ms.SUMMARY_MIN_ENV: "6"}):
            self.assertEqual(ms.summary_min_messages(), 6)
            self.assertFalse(ms.should_summarize(messages(5), min_new=ms.summary_min_messages()))
            self.assertTrue(ms.should_summarize(messages(6), min_new=ms.summary_min_messages()))
        with patch.dict(os.environ, {ms.SUMMARY_MIN_ENV: "abc"}):
            self.assertEqual(ms.summary_min_messages(), ms.SUMMARY_MIN_NEW_MESSAGES, "脏值回默认")
        with patch.dict(os.environ, {ms.SUMMARY_MIN_ENV: "0"}):
            self.assertEqual(ms.summary_min_messages(), ms.SUMMARY_MIN_NEW_MESSAGES, "<1 回默认")

    def test_counts_only_messages_after_summary_upto(self):
        rows = messages(20)
        self.assertTrue(ms.should_summarize(rows, summary_upto=18), "摘要后新增 2 条，该更新")
        self.assertFalse(ms.should_summarize(rows, summary_upto=19), "摘要后只新增 1 条，先不动")
        self.assertFalse(ms.should_summarize(rows, summary_upto=20), "摘要已覆盖全部")

    def test_dirty_rows_do_not_count_as_new(self):
        rows = messages(4) + [{"role": "tool", "text": "x"}, None, {"role": "user", "text": "  "}]
        self.assertFalse(ms.should_summarize(rows, summary_upto=4), "没有正文的行不算新增消息")

    def test_thread_level_trigger_respects_threshold(self):
        self.assertTrue(ms.thread_should_summarize(thread(8)))
        self.assertFalse(ms.thread_should_summarize(thread(8, summary="旧摘要", upto=7)), "只新增 1 条")
        self.assertTrue(ms.thread_should_summarize(thread(8, summary="旧摘要", upto=6)))

    def test_cooldown_blocks_back_to_back_summaries(self):
        item = thread(8, summary="旧摘要", upto=6)
        item["summary_at"] = 1000.0
        self.assertFalse(ms.thread_should_summarize(item, cooldown=60, now=1030.0), "冷却内不再调模型")
        self.assertTrue(ms.thread_should_summarize(item, cooldown=60, now=1060.0), "过了冷却才跑")
        self.assertTrue(ms.thread_should_summarize(item, cooldown=0, now=1000.0), "0 = 关掉冷却")
        item.pop("summary_at")
        self.assertTrue(ms.thread_should_summarize(item, cooldown=60, now=1060.0), "旧文档没时间戳不拦")

    def test_cooldown_env_override(self):
        with patch.dict(os.environ, {ms.SUMMARY_COOLDOWN_ENV: "5"}):
            self.assertEqual(ms.summary_cooldown_seconds(), 5.0)
        with patch.dict(os.environ, {ms.SUMMARY_COOLDOWN_ENV: "0"}):
            self.assertEqual(ms.summary_cooldown_seconds(), 0.0)
        with patch.dict(os.environ, {ms.SUMMARY_COOLDOWN_ENV: "-3"}):
            self.assertEqual(ms.summary_cooldown_seconds(), ms.SUMMARY_COOLDOWN_SECONDS, "<0 回默认")


class SummaryParseTest(unittest.TestCase):
    def test_parses_six_fixed_sections(self):
        parsed = ms.parse_summary(summary_text())
        self.assertEqual(parsed["goal"], "出 5 张卖货海报")
        self.assertIn("3:4", parsed["decisions"])
        self.assertIn("i1", parsed["done"])
        self.assertIn("海报图", parsed["nodes"])
        self.assertIn("确认", parsed["pending"])
        self.assertIn("竖版", parsed["corrections"])
        self.assertEqual(set(parsed), set(ms._SUMMARY_KEYS))

    def test_unknown_headings_fall_back_and_content_is_never_lost(self):
        parsed = ms.parse_summary("先说一句：这次做竖版海报\n【目标】出封面\n【没见过的标题】随便写")
        self.assertIn("竖版海报", parsed["goal"], "标题之前的内容算目标")
        self.assertIn("出封面", parsed["goal"])

    def test_plain_text_without_headings_goes_to_goal(self):
        parsed = ms.parse_summary("用户要三张白底产品图，已经做了两张。")
        self.assertEqual(parsed["goal"], "用户要三张白底产品图，已经做了两张。")
        self.assertEqual(parsed["pending"], "")

    def test_bullets_and_blank_input(self):
        parsed = ms.parse_summary("- 【目标】出图\n- 【已完成】i1")
        self.assertEqual(parsed["goal"], "出图")
        self.assertEqual(parsed["done"], "i1")
        self.assertEqual(ms.parse_summary(""), {key: "" for key in ms._SUMMARY_KEYS})

    def test_structure_detection_gates_write_back(self):
        self.assertTrue(ms.has_structure(summary_text()))
        self.assertTrue(ms.has_structure("- 【目标】出图"))
        self.assertFalse(ms.has_structure("我觉得这段对话挺好的"))
        self.assertFalse(ms.has_structure("【没见过的标题】随便写"))

    def test_summary_request_carries_only_new_messages_and_previous_summary(self):
        request = ms.summary_request(messages(8), summary_upto=6, previous="旧摘要", instruction="继续出图")
        self.assertEqual(request["messages"][0]["role"], "system")
        self.assertIn("【目标】", request["messages"][0]["content"], "固定结构要写在系统提示里")
        body = request["messages"][1]["content"]
        self.assertIn("旧摘要", body)
        self.assertIn("继续出图", body)
        self.assertIn("内容6", body)
        self.assertNotIn("内容5", body, "已经被上次摘要覆盖的消息不再送一遍")
        self.assertEqual(request["upto"], 8, "全部装得下时覆盖到线程末尾")
        self.assertEqual(request["remaining"], 0)




class SummaryCoverageTest(unittest.TestCase):
    """B1：summary_request 返回「实际送进模型的最后一条下标 +1」，一次装不下留给下一次。"""

    def long_messages(self, count=37, size=1500):
        return [{"role": "user" if index % 2 == 0 else "assistant",
                 "text": ("第%d条 " % index) + "字" * size} for index in range(count)]

    def test_upto_is_the_last_message_actually_sent_not_len_messages(self):
        rows = self.long_messages()
        request = ms.summary_request(rows, 0)
        body = request["messages"][1]["content"]
        self.assertLess(request["upto"], 37, "37 条 × 1500 字一次装不下，不能标成全覆盖")
        self.assertGreater(request["upto"], 0)
        self.assertIn("第%d条" % (request["upto"] - 1), body, "upto-1 就是最后送进去的那条")
        self.assertNotIn("第%d条" % request["upto"], body, "下一条没送进去，不能算已覆盖")
        self.assertEqual(request["remaining"], 37 - request["upto"], "剩下的留给下一次")

    def test_next_request_continues_after_the_covered_index(self):
        rows = self.long_messages()
        first = ms.summary_request(rows, 0)
        second = ms.summary_request(rows, first["upto"])
        body = second["messages"][1]["content"]
        self.assertNotIn("第%d条" % (first["upto"] - 1), body, "已覆盖的不重复送")
        self.assertIn("第%d条" % first["upto"], body)
        self.assertGreater(second["upto"], first["upto"])
        self.assertLess(second["remaining"], first["remaining"])

    def test_apply_summary_with_returned_upto_still_owes_the_rest(self):
        rows = self.long_messages()
        request = ms.summary_request(rows, 0)
        item = {"messages": rows}
        ms.apply_summary(item, summary_text(), request["upto"])
        self.assertEqual(item["summary_upto"], request["upto"])
        self.assertLess(item["summary_upto"], 37, "没送进模型的消息不能被标成已覆盖")
        self.assertTrue(ms.should_summarize(rows, item["summary_upto"]), "还欠着的消息下次要接着摘要")

    def test_no_new_messages_keeps_the_old_upto(self):
        request = ms.summary_request(messages(4), summary_upto=4)
        self.assertEqual(request["upto"], 4)
        self.assertEqual(request["remaining"], 0)
        self.assertIn("没有新内容", request["messages"][1]["content"])

    def test_dirty_rows_between_messages_do_not_stall_coverage(self):
        rows = [{"role": "user", "text": "一"}, {"role": "tool", "text": "脏"}, None,
                {"role": "assistant", "text": "二"}]
        request = ms.summary_request(rows, 0)
        self.assertEqual(request["upto"], 4, "脏行跳过但覆盖进度要往前走，不能卡住")
        self.assertEqual(request["remaining"], 0)
        self.assertIn("二", request["messages"][1]["content"])


def candidate_summary(candidates="视频一律 9:16 竖版｜global｜用户说以后都这样\n口播每秒 4 个字｜canvas"):
    return ("【目标】做卖货短视频\n【已定决策】9:16 竖版\n【已完成】分镜\n【涉及节点】分镜稿\n"
            "【未决事项】无\n【用户纠正】无\n【记忆候选】" + candidates)


class CandidateParseTest(unittest.TestCase):
    def test_summary_prompt_has_the_seventh_section(self):
        self.assertIn("【记忆候选】", ms.SUMMARY_SYSTEM)
        self.assertIn("【记忆候选】", ms.summary_request(messages(2))["messages"][0]["content"])
        self.assertIn("candidates", ms._SUMMARY_KEYS)

    def test_parse_keeps_candidate_lines_apart(self):
        """【记忆候选】是一行一条：parse_summary 不能把它压成一行，否则多条候选会粘成一条。"""
        parsed = ms.parse_summary(candidate_summary())
        self.assertIn("\n", parsed["candidates"])
        rows = ms.parse_candidates(parsed["candidates"])
        self.assertEqual([row["text"] for row in rows], ["视频一律 9:16 竖版", "口播每秒 4 个字"])
        self.assertEqual([row["scope"] for row in rows], ["global", "canvas"])
        self.assertEqual(rows[0]["reason"], "用户说以后都这样")

    def test_parse_tolerates_missing_scope_reason_and_junk(self):
        rows = ms.parse_candidates("裸的一行没有分隔符\n"
                                   "只写文本｜\n"
                                   "范围写错了｜随便｜依据在这里\n"
                                   "- 无\n"
                                   "暂无\n")
        self.assertEqual([row["text"] for row in rows], ["裸的一行没有分隔符", "只写文本", "范围写错了"])
        self.assertEqual([row["scope"] for row in rows], ["canvas", "canvas", "canvas"], "认不出的范围按本画布")
        self.assertEqual(rows[-1]["reason"], "依据在这里")
        self.assertEqual(ms.parse_candidates("无"), [])
        self.assertEqual(ms.parse_candidates(""), [])
        self.assertEqual(ms.parse_candidates(None), [])

    def test_candidate_text_is_truncated_and_deduped(self):
        rows = ms.parse_candidates("长文本" * 200 + "｜global｜依据\n同一条候选｜global｜依据\n同一条候选｜global｜依据")
        self.assertLessEqual(len(rows[0]["text"]), ms.CANDIDATE_TEXT_MAX)
        self.assertEqual(len(rows), 2, "同一条候选在一次解析里只留一条")

    def test_global_aliases(self):
        for word in ("global", "全局", "所有画布", "通用"):
            self.assertEqual(ms.parse_candidates("某偏好｜%s｜依据" % word)[0]["scope"], "global")
        self.assertEqual(ms.parse_candidates("某偏好｜canvas｜依据")[0]["scope"], "canvas")

    def test_candidate_id_is_stable_and_content_sensitive(self):
        first = ms.candidate_id("th_1", "视频一律 9:16 竖版", "global")
        self.assertEqual(first, ms.candidate_id("th_1", "视频一律 9:16 竖版", "global"))
        self.assertNotEqual(first, ms.candidate_id("th_2", "视频一律 9:16 竖版", "global"))
        self.assertNotEqual(first, ms.candidate_id("th_1", "视频一律 9:16 竖版", "canvas"))
        self.assertTrue(first.startswith("cand_"))


class AlreadyRememberedTest(unittest.TestCase):
    """候选要和长期记忆比对：已 remember 过的不再当待确认候选（否则卡片问「要记住吗」其实早记住了）。"""

    def test_exact_and_containment_match(self):
        existing = ["口播每秒 4 个字", {"text": "9：16 竖版"}, "暖色调"]
        self.assertTrue(ms.already_remembered("口播每秒 4 个字", existing))
        self.assertTrue(ms.already_remembered("口播每秒 4 个字，别超过镜头时长", existing), "包含也算记住")
        self.assertTrue(ms.already_remembered("9:16 竖版", existing), "标点 / 空格归一后相同")
        self.assertTrue(ms.already_remembered("暖色调", [{"text": "整体用暖色调"}]), "被包含也算")
        self.assertFalse(ms.already_remembered("冷蓝色调", existing))
        self.assertFalse(ms.already_remembered("", existing))
        self.assertFalse(ms.already_remembered("任意偏好", []))


class CandidateMergeTest(unittest.TestCase):
    def test_merge_dedupes_and_keeps_status(self):
        first = ms.parse_candidates("视频一律 9:16 竖版｜global｜依据")
        rows = ms.merge_candidates([], first, thread_id="th_1", ts=1700000000)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "pending")
        rows[0]["status"] = "confirmed"
        again = ms.merge_candidates(rows, first, thread_id="th_1", ts=1700000100)
        self.assertEqual(len(again), 1, "同一条候选重复提出不堆第二条")
        self.assertEqual(again[0]["status"], "confirmed", "已确认的候选不会被重置成待处理")

    def test_merge_fills_reason_but_keeps_dismissed(self):
        rows = ms.merge_candidates([], ms.parse_candidates("某偏好｜canvas"), thread_id="th_1")
        rows[0]["status"] = "dismissed"
        rows = ms.merge_candidates(rows, [{"text": "某偏好", "scope": "canvas", "reason": "用户原话"}],
                                   thread_id="th_1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "dismissed")
        self.assertEqual(rows[0]["reason"], "用户原话")

    def test_merge_drops_dirty_items_and_caps(self):
        rows = ms.merge_candidates([{"text": ""}, "  ", {"text": "有效", "scope": "bad", "status": "weird"},
                                    {"text": "有效2"}], [], thread_id="th_1")
        self.assertEqual([row["text"] for row in rows], ["有效", "有效2"])
        self.assertEqual(rows[0]["scope"], "canvas")
        self.assertEqual(rows[0]["status"], "pending")
        many = [{"text": "候选 %d" % index} for index in range(ms.CANDIDATE_MAX + 10)]
        self.assertEqual(len(ms.merge_candidates([], many, thread_id="th_1")), ms.CANDIDATE_MAX)

    def test_thread_candidates_legacy_thread_is_empty(self):
        self.assertEqual(ms.thread_candidates({"id": "th_1", "messages": []}), [])
        self.assertEqual(ms.thread_candidates(None), [])
        thread = {"id": "th_1", "memory_candidates": [{"text": "某偏好", "scope": "canvas",
                                                       "status": "confirmed"}]}
        rows = ms.thread_candidates(thread)
        self.assertEqual(rows[0]["status"], "confirmed")
        self.assertEqual(rows[0]["id"], ms.candidate_id("th_1", "某偏好", "canvas"))


class ThreadSummaryWriteTest(unittest.TestCase):
    def test_legacy_thread_without_summary_fields_is_readable(self):
        legacy = {"id": "th_l", "title": "老对话", "messages": messages(9), "recent": ["图1"]}
        self.assertEqual(ms.summary_state(legacy), ("", 0))
        self.assertTrue(ms.thread_should_summarize(legacy))

    def test_apply_summary_appends_and_keeps_every_message(self):
        item = thread(9)
        before = json.loads(json.dumps(item["messages"]))
        ms.apply_summary(item, summary_text(), 9)
        self.assertEqual(item["summary_upto"], 9)
        self.assertIn("出 5 张", item["summary"])
        self.assertEqual(item["messages"], before, "摘要只是追加，原文一条不删")

    def test_apply_summary_records_time_for_cooldown(self):
        item = thread(4)
        ms.apply_summary(item, summary_text(), 4, at=1234.0)
        self.assertEqual(item["summary_at"], 1234.0)
        self.assertEqual(ms.summary_at(item), 1234.0)
        self.assertEqual(ms.summary_at({"id": "th_x"}), 0.0, "旧文档没有时间戳 → 0")

    def test_apply_summary_never_moves_backwards(self):
        item = thread(20, summary="新摘要", upto=20)
        ms.apply_summary(item, "更旧的摘要", 8)
        self.assertEqual(ms.summary_state(item), ("新摘要", 20))
        ms.apply_summary(item, "", 25)
        self.assertEqual(ms.summary_state(item), ("新摘要", 20), "空摘要不覆盖已有的")

    def test_legacy_document_round_trip(self):
        """旧线程文件（单线程老格式）读出来、升级写回、再读还在：不许报错。"""
        tmp = tempfile.mkdtemp(prefix="novai-memory-")
        try:
            path = os.path.join(tmp, "canvas-x.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"canvas_id": "canvas-x", "messages": messages(7), "recent": []}, f)
            with open(path, "r", encoding="utf-8") as f:
                doc = json.load(f)
            item = {"id": "th_old", "title": "对话 1", "messages": doc.get("messages") or [],
                    "recent": doc.get("recent") or []}
            ms.apply_summary(item, summary_text(goal="老对话的目标"), len(item["messages"]))
            doc["threads"] = [item]
            doc["active_id"] = "th_old"
            with open(path, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False)
            with open(path, "r", encoding="utf-8") as f:
                again = json.load(f)["threads"][0]
            self.assertIn("老对话的目标", ms.summary_state(again)[0])
            self.assertEqual(len(again["messages"]), 7)
            self.assertFalse(ms.thread_should_summarize(again), "刚摘要过，不用马上再摘要")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ProfileMergeTest(unittest.TestCase):
    def test_merges_summary_into_profile_fields(self):
        item = thread(8, summary=summary_text(), upto=8, thread_id="th_a", title="海报对话")
        profile = ms.merge_profile(ms.empty_profile("canvas-1"), item, progress_text="上次停在第 2 阶段，共 3 阶段")
        self.assertEqual(profile["canvas_id"], "canvas-1")
        self.assertEqual(profile["intro"], "出 5 张卖货海报")
        self.assertIn("3:4", profile["style"])
        self.assertIn("i1", profile["key_nodes"])
        self.assertIn("i2", profile["key_nodes"])
        self.assertIn("第 2 阶段", profile["progress"])
        self.assertEqual(len(profile["threads"]), 1)
        self.assertEqual(profile["threads"][0]["id"], "th_a")
        self.assertEqual(profile["threads"][0]["title"], "海报对话")
        self.assertTrue(profile["threads"][0]["one_line"].startswith("出 5 张"))

    def test_same_thread_merges_once_and_newest_wins(self):
        first = thread(8, summary=summary_text(goal="第一批目标"), upto=8, thread_id="th_a", title="对话 1")
        second = thread(8, summary=summary_text(goal="第二批目标"), upto=8, thread_id="th_b", title="对话 2")
        profile = ms.merge_profile(ms.empty_profile("c"), first)
        profile = ms.merge_profile(profile, first)
        self.assertEqual(len(profile["threads"]), 1, "同一条线程重复合并不能堆出两条")
        profile = ms.merge_profile(profile, second)
        self.assertEqual(profile["intro"], "第二批目标", "项目简介跟最近一次对话")
        self.assertEqual([row["id"] for row in profile["threads"]], ["th_b", "th_a"])

    def test_placeholder_nodes_are_not_real_nodes(self):
        """摘要【涉及节点】写「无」时不能存成节点名（真实验收里档案显示成了「关键素材节点：无」）。"""
        item = thread(8, summary=summary_text(nodes="无"), upto=8, thread_id="th_a", title="对话 1")
        profile = ms.merge_profile(ms.empty_profile("c"), item)
        self.assertEqual(profile["key_nodes"], [])
        self.assertNotIn("关键素材节点", ms.render_profile(profile))
        for placeholder in ("暂无", "无节点", "N/A", "-", "—", "None", " "):
            other = thread(8, summary=summary_text(nodes=placeholder), upto=8, thread_id="th_b")
            self.assertEqual(ms.merge_profile(ms.empty_profile("c"), other)["key_nodes"], [],
                             "占位值 %r 要过滤掉" % placeholder)
        mixed = thread(8, summary=summary_text(nodes="无、i1、暂无、海报图"), upto=8, thread_id="th_c")
        self.assertEqual(ms.merge_profile(ms.empty_profile("c"), mixed)["key_nodes"], ["i1", "海报图"])

    def test_existing_placeholder_nodes_are_cleaned_on_merge(self):
        legacy = {"canvas_id": "c", "key_nodes": ["无", "i1"], "threads": [], "updated_at": 1}
        cleaned = ms.merge_profile(legacy, thread(8, summary=summary_text(nodes="i2"), upto=8))
        self.assertEqual(cleaned["key_nodes"], ["i1", "i2"])

    def test_thread_without_summary_does_not_create_a_row(self):
        legacy = {"id": "th_l", "title": "老对话", "messages": messages(9)}
        profile = ms.merge_profile(ms.empty_profile("c"), legacy)
        self.assertEqual(profile["threads"], [])
        self.assertEqual(profile["intro"], "")

    def test_dirty_profile_is_normalized(self):
        profile = ms._normalize_profile({"intro": None, "threads": ["x", {"one_line": ""}],
                                         "key_nodes": "i1", "updated_at": "bad"}, "c")
        self.assertEqual(profile["intro"], "")
        self.assertEqual(profile["threads"], [])
        self.assertEqual(profile["key_nodes"], [])
        self.assertEqual(profile["updated_at"], 0)


class ProfileLimitTest(unittest.TestCase):
    def test_body_is_capped_at_800_chars(self):
        profile = ms.empty_profile("c")
        for index in range(ms.PROFILE_THREADS_MAX + 6):
            item = thread(8, summary=summary_text(goal="第 %d 个对话的目标" % index + "很长" * 20,
                                                  done="做完了一堆东西" * 20,
                                                  nodes="、".join("节点%d" % n for n in range(20))),
                          upto=8, thread_id="th_%d" % index, title="对话 %d" % index)
            profile = ms.merge_profile(profile, item)
        profile["style"] = "很长的风格定调" * 40
        fitted = ms.fit_profile(profile)
        text = ms.render_profile(fitted)
        self.assertLessEqual(len(text), ms.PROFILE_BODY_MAX, "档案正文必须压在 800 字以内")
        self.assertGreater(len(text), 0)
        self.assertLessEqual(len(fitted["threads"]), ms.PROFILE_THREADS_MAX)

    def test_small_profile_is_untouched(self):
        profile = ms.merge_profile(ms.empty_profile("c"), thread(8, summary=summary_text(), upto=8))
        fitted = ms.fit_profile(profile)
        self.assertEqual(fitted, ms._normalize_profile(fitted, "c"), "没超限时原样返回")
        self.assertEqual(fitted["intro"], profile["intro"])
        self.assertEqual(len(fitted["threads"]), 1)


class RelatedTest(unittest.TestCase):
    ENTRIES = ["用户要出五张卖货海报", "把口播的那段配音重新生成", "给产品图换白底",
               "设定整体风格为暖色调", "上次用的模型是 Seedream"]

    def test_query_hits_rank_first(self):
        picked = ms.select_related("这段口播重新配音可以吗", self.ENTRIES, budget_tokens=4000)
        self.assertTrue(picked)
        self.assertIn("配音", picked[0]["text"], "和指令最相关的那条排第一")
        self.assertTrue(picked[0]["hit"])
        self.assertEqual(len({row["index"] for row in picked}), len(picked), "不能重复")

    def test_recent_entries_are_added_after_hits(self):
        picked = ms.select_related("完全无关的一句话", self.ENTRIES, budget_tokens=4000, recent=2)
        self.assertEqual([row["index"] for row in picked], [4, 3], "没命中就补最近的两条")

    def test_budget_caps_how_many_come_back(self):
        rows = ["很长的记忆条目" * 40 for _ in range(6)]
        picked = ms.select_related("记忆", rows, budget_tokens=60)
        self.assertEqual(len(picked), 1, "预算只够一条时至少留最新的一条")
        self.assertEqual(picked[0]["index"], 5)
        self.assertEqual(ms.select_related("记忆", rows, budget_tokens=0), [])

    def test_chinese_bigram_matching(self):
        self.assertIn("配音", ms.keywords("配音重新生成"))
        self.assertIn("配音", ms.keywords("配音"))
        self.assertIn("配音", ms.keywords("配 音"), "标点 / 空格不打断二元组")
        self.assertGreater(ms.relevance("重新配音", "把口播的配音重新生成"), 0)

    def test_memory_budget_is_eight_percent(self):
        self.assertEqual(ms.memory_budget(100000), 8000)
        self.assertEqual(ms.memory_budget(0), int(ms.Budget(0).total * 0.08))


class RoadmapProgressTest(unittest.TestCase):
    ROADMAP = [{"stage": "策划与分镜", "detail": "写文本节点", "generations": 0},
               {"stage": "出镜头视频", "detail": "5 个镜头", "generations": 5},
               {"stage": "配音", "generations": 5},
               {"stage": "剪辑成片", "generations": 1}]

    def test_first_stage_when_nothing_generated(self):
        progress = ms.roadmap_progress(self.ROADMAP, 0)
        self.assertEqual((progress["index"], progress["total"]), (1, 4))
        self.assertIn("上次停在第 1 阶段", progress["text"])
        self.assertIn("共 4 阶段", progress["text"])
        self.assertIn("策划与分镜", progress["text"])

    def test_counts_generations_in_order(self):
        self.assertEqual(ms.roadmap_progress(self.ROADMAP, 3)["index"], 2, "第 1 段做完、第 2 段没做满")
        self.assertEqual(ms.roadmap_progress(self.ROADMAP, 6)["index"], 3)
        self.assertEqual(ms.roadmap_progress(self.ROADMAP, 11)["index"], 4)

    def test_all_done_and_empty(self):
        done = ms.roadmap_progress(self.ROADMAP, 99)
        self.assertTrue(done["all_done"])
        self.assertEqual(ms.roadmap_progress([], 3), {"index": 0, "total": 0, "stage": "",
                                                     "all_done": False, "text": ""})
        self.assertEqual(ms.roadmap_progress([{"stage": ""}, "策划"], 0)["total"], 1)

    def test_count_generations_from_thread_messages(self):
        item = thread(6, steps=[
            {"tool": "generate_image", "ok": True},
            {"tool": "generate_image", "ok": False},
            {"tool": "read_node", "ok": True},
            {"tool": "batch_generate", "ok": True},
        ])
        self.assertEqual(ms.count_generations(item["messages"]), 2, "只数成功的真实生成")


class OpeningTest(unittest.TestCase):
    def profile(self):
        return ms.merge_profile(ms.empty_profile("c"),
                                thread(8, summary=summary_text(), upto=8, thread_id="th_a", title="海报对话"),
                                progress_text="上次停在第 2 阶段，共 3 阶段：配音")

    def test_opening_starts_with_the_progress_rule(self):
        """开场注入的第一段必须是硬约束：不许拿画布上已有的图反推阶段已完成。"""
        text = ms.opening_text(self.profile(), progress_text="上次停在第 2 阶段，共 3 阶段：配音")
        self.assertTrue(text.startswith("【进度判定（必须遵守）】"), text[:40])
        self.assertIn("档案没写完成的阶段，一律当作还没完成", text)
        self.assertIn("不要因为「画布上有 N 张图」就反推某个阶段已完成", text)

    def test_no_rule_when_there_is_nothing_to_inject(self):
        self.assertEqual(ms.opening_text(ms.empty_profile("c")), "", "空档案不注入、也不加规则")

    def test_opening_carries_profile_progress_and_thread_summary(self):
        text = ms.opening_text(self.profile(), progress_text="上次停在第 2 阶段，共 3 阶段：配音",
                               thread_summary="【目标】接着配音")
        self.assertIn("项目档案", text)
        self.assertIn("项目简介：出 5 张卖货海报", text)
        self.assertIn("海报对话：", text)
        self.assertIn("上次停在第 2 阶段", text)
        self.assertIn("【本对话早先的内容摘要】", text)
        self.assertLessEqual(len(text), ms.OPENING_MAX_CHARS)

    def test_progress_is_not_repeated_when_profile_already_has_it(self):
        profile = self.profile()
        text = ms.opening_text(profile, progress_text="上次停在第 2 阶段，共 3 阶段：配音")
        self.assertEqual(text.count("上次停在第 2 阶段"), 1, "同一句进度不重复出现")

    def test_empty_profile_and_no_summary_gives_empty_text(self):
        self.assertEqual(ms.opening_text(ms.empty_profile("c")), "")

    def test_related_lines_replace_the_thread_list(self):
        lines = ms.thread_lines(self.profile())
        text = ms.opening_text(self.profile(), lines=lines)
        self.assertIn("海报对话：", text)
        self.assertEqual(ms.render_profile(self.profile(), lines=[]).count("各对话做过什么"), 0)




def index_entry(source="message", text="用户：做一套冷蓝色调的海报", canvas_id="c1",
                canvas_title="卖货画布", thread_id="t1", thread_title="海报对话", scope="",
                ts=1700000000):
    return ms.make_entry(source, text, canvas_id=canvas_id, canvas_title=canvas_title,
                         thread_id=thread_id, thread_title=thread_title, scope=scope, ts=ts)


def local_date(ts=1700000000):
    return time.strftime("%Y-%m-%d", time.localtime(ts))


class ReadableTextTest(unittest.TestCase):
    def test_image_data_url_is_replaced(self):
        text = ms.readable_text("看这张 data:image/png;base64,AAAABBBBCCCC 然后改竖版")
        self.assertIn("［图片］", text)
        self.assertNotIn("base64", text)
        self.assertNotIn("AAAABBBB", text)

    def test_whitespace_is_collapsed_and_length_capped(self):
        self.assertEqual(ms.readable_text("第一行\n\n第二行  第三行"), "第一行 第二行 第三行")
        self.assertEqual(len(ms.readable_text("字" * (ms.INDEX_TEXT_MAX + 500))), ms.INDEX_TEXT_MAX)
        self.assertEqual(ms.readable_text("   "), "")


class IndexEntryTest(unittest.TestCase):
    def test_entry_carries_source_title_time_and_text(self):
        entry = index_entry()
        for key in ("key", "source", "canvas_id", "canvas_title", "thread_id", "thread_title", "ts", "text"):
            self.assertIn(key, entry)
        self.assertEqual(entry["source"], "message")
        self.assertEqual(entry["canvas_title"], "卖货画布")
        self.assertEqual(entry["thread_title"], "海报对话")
        self.assertEqual(ms.format_date(entry["ts"]), local_date())

    def test_key_is_stable_and_content_sensitive(self):
        self.assertEqual(ms.entry_key("message", "c1", "t1", "", "同一段话"),
                         ms.entry_key("message", "c1", "t1", "", "同一段话"))
        self.assertNotEqual(ms.entry_key("message", "c1", "t1", "", "同一段话"),
                            ms.entry_key("message", "c1", "t2", "", "同一段话"))
        self.assertNotEqual(ms.entry_key("message", "c1", "t1", "", "同一段话"),
                            ms.entry_key("thread_summary", "c1", "t1", "", "同一段话"))
        self.assertEqual(ms.make_entry("message", "  "), {}, "空正文不产条目")

    def test_snippet_keeps_hit_inside_and_stays_within_limit(self):
        body = "开头" + "铺垫" * 200 + "这里提到冷蓝色调的关键句" + "结尾" * 200
        piece = ms.snippet(body, "冷蓝色调", 200)
        self.assertLessEqual(len(piece), 200)
        self.assertIn("冷蓝色调", piece)
        self.assertTrue(piece.startswith("…") or piece.endswith("…"))

    def test_origin_has_canvas_thread_and_date(self):
        self.assertEqual(ms.format_origin("卖货画布", "c1", "海报对话", 1700000000),
                         "卖货画布 · 海报对话 · " + local_date())
        self.assertEqual(ms.format_origin("", "c1", "", 1700000000), "c1 · " + local_date())


class MemoryIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-memory-index-")
        self.index = ms.MemoryIndex(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_add_dedupes_same_content(self):
        entry = index_entry()
        self.assertEqual(self.index.add([entry]), 1)
        self.assertEqual(self.index.add([entry]), 0, "同一个 key 再写一次不落盘")
        self.assertEqual(self.index.add([index_entry(text="另一段话")]), 1)
        self.assertEqual(self.index.add([index_entry(text="另一段话"), index_entry(text="另一段话")]), 0,
                         "同一批里重复也只写一条")
        self.assertEqual(len(self.index.entries()), 2)
        with open(self.index.path, "r", encoding="utf-8") as handle:
            self.assertEqual(len([line for line in handle if line.strip()]), 2)

    def test_reload_reads_from_disk_and_skips_broken_lines(self):
        self.index.add([index_entry(), index_entry(text="第二段")])
        with open(self.index.path, "a", encoding="utf-8") as handle:
            handle.write("{不是 json\n")
        again = ms.MemoryIndex(self.tmp)
        self.assertEqual(len(again.entries()), 2)

    def test_search_hits_chinese_bigrams_and_returns_nothing_honestly(self):
        self.index.add([index_entry(text="用户：做一套冷蓝色调的产品海报"),
                        index_entry(text="助手：把主标题换成深夜霓虹", thread_id="t1")])
        hits = self.index.search("冷蓝色调 海报")
        self.assertTrue(hits)
        self.assertIn("冷蓝色调", hits[0]["snippet"])
        self.assertEqual(self.index.search("完全无关的配音口播"), [])

    def test_scope_filtering(self):
        self.index.add([
            index_entry(text="画布一对话一：冷蓝色调海报", canvas_id="c1", thread_id="t1"),
            index_entry(text="画布一对话二：冷蓝色调 banner", canvas_id="c1", thread_id="t2"),
            index_entry(text="画布二：冷蓝色调视频", canvas_id="c2", thread_id="t3"),
            index_entry(text="全局偏好：海报都用冷蓝色调", canvas_id="", thread_id="", scope="global"),
        ])
        self.assertEqual({row["thread_id"] for row in self.index.search("冷蓝色调", scope="thread",
                                                                       canvas_id="c1", thread_id="t1")},
                         {"t1"})
        canvas_rows = self.index.search("冷蓝色调", scope="canvas", canvas_id="c1")
        self.assertEqual({row["thread_id"] for row in canvas_rows}, {"t1", "t2"})
        self.assertEqual(len(self.index.search("冷蓝色调", scope="all")), 4)
        allowed = self.index.search("冷蓝色调", scope="all", allowed_canvases=["c1"])
        self.assertEqual({row["canvas_id"] for row in allowed}, {"c1", ""},
                         "全局长期记忆没有画布 id，任何权限下都可见")

    def test_limit_and_ordering(self):
        self.index.add([index_entry(text="冷蓝色调 " * (index + 1), thread_id="t%d" % index,
                                    ts=1700000000 + index) for index in range(5)])
        self.assertEqual(len(self.index.search("冷蓝色调", scope="all", limit=2)), 2)
        self.assertLessEqual(len(self.index.search("冷蓝色调", scope="all", limit=999)), ms.RECALL_LIMIT_MAX)

    def test_remove_keys_drops_entries_from_disk(self):
        first, second = index_entry(), index_entry(text="第二段")
        self.index.add([first, second])
        self.assertEqual(self.index.remove_keys([first["key"]]), 1)
        self.assertEqual([row["key"] for row in ms.MemoryIndex(self.tmp).entries()], [second["key"]])
        self.assertEqual(self.index.remove_keys([]), 0)




class SettingsStoreTest(unittest.TestCase):
    """按画布的记忆开关：缺省全开、只认三把开关、坏文件不拖垮记忆功能。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-memory-settings-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_defaults_are_all_on(self):
        settings = ms.load_settings(self.tmp, "canvas-1")
        self.assertEqual(settings, {"auto_summary": True, "candidate_cards": True,
                                    "cross_canvas_recall": True})
        self.assertEqual(set(settings), set(ms.SETTINGS_KEYS))

    def test_save_load_round_trip_keeps_only_known_keys(self):
        ms.save_settings(self.tmp, "canvas-1", {"auto_summary": False, "unknown_key": True,
                                                "candidate_cards": "off", "cross_canvas_recall": 1})
        loaded = ms.load_settings(self.tmp, "canvas-1")
        self.assertEqual(loaded, {"auto_summary": False, "candidate_cards": False,
                                  "cross_canvas_recall": True})
        self.assertTrue(ms.settings_path(self.tmp, "canvas-1").endswith("canvas-1.settings.json"))
        with open(ms.settings_path(self.tmp, "canvas-1"), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        self.assertNotIn("unknown_key", raw)

    def test_missing_or_broken_file_falls_back_to_defaults(self):
        ms.save_settings(self.tmp, "canvas-2", {"auto_summary": False})
        self.assertEqual(ms.load_settings(self.tmp, "canvas-2")["auto_summary"], False)
        with open(ms.settings_path(self.tmp, "canvas-2"), "w", encoding="utf-8") as handle:
            handle.write("{坏掉的 json")
        self.assertTrue(ms.load_settings(self.tmp, "canvas-2")["auto_summary"], "坏文件回缺省")

    def test_dirty_values_fall_back_per_key(self):
        self.assertEqual(ms.normalize_settings({"auto_summary": "乱写", "candidate_cards": 0,
                                                "cross_canvas_recall": None}),
                         {"auto_summary": True, "candidate_cards": False, "cross_canvas_recall": True})
        self.assertEqual(ms.normalize_settings(None), dict(ms.DEFAULT_SETTINGS))
        self.assertEqual(ms.normalize_settings({"auto_summary": "关"})["auto_summary"], False)

    def test_delete_settings_is_idempotent(self):
        ms.save_settings(self.tmp, "canvas-3", {"auto_summary": False})
        self.assertTrue(ms.delete_settings(self.tmp, "canvas-3"))
        self.assertFalse(ms.delete_settings(self.tmp, "canvas-3"))
        self.assertTrue(ms.load_settings(self.tmp, "canvas-3")["auto_summary"], "删掉后回缺省")

    def test_remove_canvas_drops_only_that_canvas(self):
        self.index = ms.MemoryIndex(self.tmp)
        self.index.add([index_entry(canvas_id="c1", text="c1 的内容"),
                        index_entry(canvas_id="c1", text="c1 第二段"),
                        index_entry(canvas_id="c2", text="c2 的内容"),
                        index_entry(canvas_id="", text="全局记忆", scope="global")])
        self.assertEqual(self.index.remove_canvas("c1"), 2)
        remaining = {row["canvas_id"] for row in ms.MemoryIndex(self.tmp).entries()}
        self.assertEqual(remaining, {"c2", ""}, "别的画布和全局记忆不受影响")
        self.assertEqual(self.index.remove_canvas(""), 0, "空画布 id 不删任何东西")


class ProfileStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="novai-memory-store-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_save_load_delete_round_trip(self):
        profile = ms.merge_profile(ms.empty_profile("canvas-1"),
                                   thread(8, summary=summary_text(), upto=8, thread_id="th_a", title="海报对话"))
        ms.save_profile(self.tmp, "canvas-1", profile)
        loaded = ms.load_profile(self.tmp, "canvas-1")
        self.assertEqual(loaded["canvas_id"], "canvas-1")
        self.assertEqual(loaded["intro"], profile["intro"])
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "canvas-1.profile.json")))
        self.assertTrue(ms.delete_profile(self.tmp, "canvas-1"))
        self.assertFalse(ms.delete_profile(self.tmp, "canvas-1"), "已经删掉的不报错")
        self.assertEqual(ms.load_profile(self.tmp, "canvas-1")["threads"], [])

    def test_missing_or_broken_file_is_empty_profile(self):
        self.assertEqual(ms.load_profile(self.tmp, "nope")["intro"], "")
        with open(os.path.join(self.tmp, "bad.profile.json"), "w", encoding="utf-8") as f:
            f.write("{不是 json")
        self.assertEqual(ms.load_profile(self.tmp, "bad")["threads"], [])

    def test_canvas_id_is_sanitized_like_threads(self):
        self.assertEqual(ms.canvas_key("../画布/a b"), "ab")
        with self.assertRaises(ValueError):
            ms.canvas_key("  ../  ")
        self.assertTrue(ms.profile_path(self.tmp, "c1").endswith("c1.profile.json"))


if __name__ == "__main__":
    unittest.main()
