# -*- coding: utf-8 -*-
"""K2·思考正文持久化：原生推理与思考时长落线程，线程接口按 thinking 回退给前端。

覆盖：_agent_think_track 累计（多轮换行 / 超长截断）、_agent_think_record_fields 的时长口径、
_agent_thread_message_row 的 thinking 派生，以及 GET /api/agent/thread/{canvas_id} 直接读历史。
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-think-history-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import warnings  # noqa: E402
with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import main  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

CLIENT = TestClient(main.app)


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def new_recorded():
    return {"thoughts": [], "self_check": None, "plan": None,
            "reasoning_parts": [], "reasoning_chars": 0, "reasoning_truncated": False,
            "think_first_at": None, "think_last_at": None}


class MessageRowThinkingTests(unittest.TestCase):
    """线程消息对外形状：thinking 优先原生推理，回退 think.lines，都没有就不出现。"""

    def test_reasoning_wins_and_duration_kept(self):
        think = {"lines": ["判断：画布偏空"], "kinds": ["decision"], "secs": "6.0"}
        msg = {"role": "assistant", "text": "先看画布", "at": 1,
               "reasoning": "The canvas has three image nodes and one text node.",
               "thinking_duration_ms": 4200, "think": think, "took": 6.0}
        row = main._agent_thread_message_row(msg)
        self.assertEqual(row["thinking"], msg["reasoning"])
        self.assertEqual(row["thinking_duration_ms"], 4200)
        self.assertEqual(row["reasoning"], msg["reasoning"])
        self.assertEqual(row["think"], think)
        self.assertEqual(row["took"], 6.0)

    def test_falls_back_to_think_lines(self):
        msg = {"role": "assistant", "text": "旧线程回复", "at": 1,
               "think": {"lines": ["短句一", "短句二"], "kinds": ["decision", "route"], "secs": "1.0"}}
        row = main._agent_thread_message_row(msg)
        self.assertEqual(row["thinking"], "短句一\n短句二")
        self.assertNotIn("reasoning", row)
        # 老线程只有 think.secs：派生时长，标题才能显示「已思考 1s」
        self.assertEqual(row["thinking_duration_ms"], 1000)

    def test_legacy_think_secs_derives_duration(self):
        """老线程没有 thinking_duration_ms：用 think.secs 派生（最小 1ms），不覆盖已有值。"""
        cases = (({"lines": ["短句"], "secs": "1.5"}, 1500),
                 ({"lines": ["短句"], "secs": "0.0004"}, 1),
                 ({"lines": ["短句"], "secs": "abc"}, None),
                 ({"lines": ["短句"], "secs": "0"}, None),
                 ({"lines": ["短句"]}, None))
        for think, expected in cases:
            with self.subTest(think=think):
                row = main._agent_thread_message_row(
                    {"role": "assistant", "text": "旧回复", "at": 1, "think": think})
                if expected is None:
                    self.assertNotIn("thinking_duration_ms", row)
                else:
                    self.assertEqual(row["thinking_duration_ms"], expected)

    def test_explicit_duration_wins_over_think_secs(self):
        msg = {"role": "assistant", "text": "回复", "at": 1,
               "thinking_duration_ms": 4200,
               "think": {"lines": ["短句"], "secs": "6.0"}}
        row = main._agent_thread_message_row(msg)
        self.assertEqual(row["thinking_duration_ms"], 4200)

    def test_no_thinking_key_without_thoughts(self):
        for msg in ({"role": "user", "text": "你好", "at": 1},
                    {"role": "assistant", "text": "没有思考的回复", "at": 1},
                    {"role": "assistant", "text": "空短句", "at": 1, "think": {"lines": ["", "  "]}}):
            with self.subTest(msg=msg):
                row = main._agent_thread_message_row(msg)
                self.assertNotIn("thinking", row)

    def test_user_message_never_gets_thinking(self):
        msg = {"role": "user", "text": "帮我看看", "at": 1,
               "reasoning": "绝不该出现在用户消息上", "think": {"lines": ["短句"]}}
        row = main._agent_thread_message_row(msg)
        self.assertNotIn("thinking", row)


class ThinkTrackTests(unittest.TestCase):
    """emit 里累计的本轮思考：多轮换行、超长截断、时长口径。"""

    def test_reasoning_rounds_separated_by_newline(self):
        recorded = new_recorded()
        main._agent_think_track(recorded, "reasoning_delta", {"round": 1, "text": "first round"})
        main._agent_think_track(recorded, "reasoning_delta", {"round": 1, "text": " continues"})
        main._agent_think_track(recorded, "reasoning_delta", {"round": 2, "text": "second round"})
        # thought 短句不混进 reasoning，只记时间
        main._agent_think_track(recorded, "thought", {"round": 2, "text": "判断：先看画布"})
        fields = main._agent_think_record_fields(recorded, time.monotonic())
        self.assertEqual(fields["reasoning"], "first round continues\nsecond round")
        self.assertNotIn("reasoning_truncated", fields)
        self.assertGreaterEqual(fields["thinking_duration_ms"], 1)

    def test_over_limit_is_truncated(self):
        recorded = new_recorded()
        main._agent_think_track(recorded, "reasoning_delta",
                                {"round": 1, "text": "A" * (main.AGENT_THREAD_REASONING_MAX_CHARS + 500)})
        main._agent_think_track(recorded, "reasoning_delta", {"round": 1, "text": "B" * 100})
        fields = main._agent_think_record_fields(recorded, time.monotonic())
        self.assertEqual(len(fields["reasoning"]), main.AGENT_THREAD_REASONING_MAX_CHARS)
        self.assertTrue(fields["reasoning_truncated"])
        self.assertNotIn("B", fields["reasoning"])

    def test_no_thinking_writes_nothing(self):
        fields = main._agent_think_record_fields(new_recorded(), time.monotonic())
        self.assertEqual(fields, {})

    def test_thought_only_still_has_duration(self):
        recorded = new_recorded()
        recorded["think_first_at"] = 100.0
        recorded["think_last_at"] = 100.0
        fields = main._agent_think_record_fields(recorded, 100.25)
        self.assertNotIn("reasoning", fields)
        self.assertEqual(fields["thinking_duration_ms"], 250)

    def test_duration_between_first_and_last_event(self):
        recorded = new_recorded()
        recorded["think_first_at"] = 10.0
        recorded["think_last_at"] = 12.5
        fields = main._agent_think_record_fields(recorded, 99.0)
        self.assertEqual(fields["thinking_duration_ms"], 2500)


class ThreadApiThinkingTests(unittest.TestCase):
    """落盘 → GET /api/agent/thread：历史里能重新长出思考块（含老线程短句版）。"""

    def _canvas(self, title):
        resp = CLIENT.post("/api/canvases", json={"title": title, "kind": "smart"})
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()["canvas"]["id"]

    def test_thread_api_returns_reasoning_and_duration(self):
        canvas_id = self._canvas("思考历史画布")
        main.agent_thread_append(canvas_id, [
            {"role": "user", "text": "帮我想想这张画布"},
            {"role": "assistant", "text": "先看画布再给方案", "run_id": "run_k2_1",
             "reasoning": "The canvas has three image nodes; a three-step plan fits.",
             "thinking_duration_ms": 4200,
             "think": {"lines": ["判断：节点偏少"], "kinds": ["decision"], "secs": "6.0"},
             "took": 6.0},
            {"role": "assistant", "text": "旧线程回复",
             "think": {"lines": ["短句一", "短句二"], "kinds": ["decision"], "secs": "1.0"}},
            {"role": "assistant", "text": "没有思考的回复"},
        ])
        body = CLIENT.get("/api/agent/thread/%s" % canvas_id).json()
        self.assertEqual([m["role"] for m in body["messages"]],
                         ["user", "assistant", "assistant", "assistant"])
        first = body["messages"][1]
        self.assertEqual(first["thinking"], first["reasoning"])
        self.assertEqual(first["thinking_duration_ms"], 4200)
        self.assertEqual(first["reasoning"],
                         "The canvas has three image nodes; a three-step plan fits.")
        self.assertNotIn("reasoning_truncated", first)
        self.assertEqual(first["think"]["lines"], ["判断：节点偏少"])
        self.assertEqual(first["took"], 6.0)
        legacy = body["messages"][2]
        self.assertEqual(legacy["thinking"], "短句一\n短句二")
        self.assertNotIn("reasoning", legacy)
        self.assertEqual(legacy["thinking_duration_ms"], 1000)
        plain = body["messages"][3]
        self.assertNotIn("thinking", plain)
        self.assertNotIn("thinking", body["messages"][0])

    def test_thread_api_keeps_truncated_flag(self):
        canvas_id = self._canvas("截断历史画布")
        main.agent_thread_append(canvas_id, [
            {"role": "assistant", "text": "超长推理", "reasoning": "R" * 120,
             "reasoning_truncated": True, "thinking_duration_ms": 900},
        ])
        body = CLIENT.get("/api/agent/thread/%s" % canvas_id).json()
        row = body["messages"][0]
        self.assertTrue(row["reasoning_truncated"])
        self.assertEqual(row["thinking"], "R" * 120)
        self.assertEqual(row["thinking_duration_ms"], 900)

    def test_legacy_thread_file_unchanged(self):
        """老线程文件没有这些 key：接口不多吐字段，历史短句仍能显示。"""
        canvas_id = self._canvas("老线程画布")
        os.makedirs(main.AGENT_THREADS_DIR, exist_ok=True)
        path = os.path.join(main.AGENT_THREADS_DIR, "%s.json" % canvas_id)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"canvas_id": canvas_id, "messages": [
                {"role": "assistant", "text": "旧回复", "at": 2,
                 "think": {"lines": ["老短句"], "kinds": ["decision"], "secs": "0.4"}},
            ]}, fh, ensure_ascii=False)
        row = CLIENT.get("/api/agent/thread/%s" % canvas_id).json()["messages"][0]
        self.assertEqual(row["thinking"], "老短句")
        self.assertEqual(row["thinking_duration_ms"], 400)   # think.secs "0.4" → 400ms
        for key in ("reasoning", "reasoning_truncated"):
            self.assertNotIn(key, row)


class ThreadReasoningTrimTests(unittest.TestCase):
    """线程思考总量预算：从最新往回累计，超出后只删更老消息的 reasoning。"""

    def _thread(self, messages):
        thread = main._agent_thread_new_thread("预算线程")
        thread["messages"] = messages
        return thread

    def test_result_is_trimmed_count(self):
        budget = main.AGENT_THREAD_REASONING_BUDGET_CHARS
        thread = self._thread([
            {"role": "assistant", "text": "老回复", "reasoning": "a" * 8000,
             "thinking_duration_ms": 1000, "think": {"lines": ["老短句"]}},
            {"role": "assistant", "text": "新回复", "reasoning": "b" * budget,
             "thinking_duration_ms": 2000, "think": {"lines": ["新短句"]}},
        ])
        self.assertEqual(main._agent_thread_trim_reasoning(thread), 1)
        old, new = thread["messages"]
        self.assertNotIn("reasoning", old)
        self.assertEqual(old["thinking_duration_ms"], 1000)
        self.assertEqual(old["think"]["lines"], ["老短句"])
        self.assertEqual(new["reasoning"], "b" * budget)

    def test_under_budget_untouched(self):
        thread = self._thread([
            {"role": "assistant", "text": "回复", "reasoning": "r" * 8000} for _ in range(10)
        ])
        self.assertEqual(main._agent_thread_trim_reasoning(thread), 0)
        self.assertTrue(all(len(msg["reasoning"]) == 8000 for msg in thread["messages"]))

    def test_user_and_plain_messages_untouched(self):
        thread = self._thread([
            {"role": "user", "text": "用户的思考不该被算进预算",
             "reasoning": "u" * (main.AGENT_THREAD_REASONING_BUDGET_CHARS + 1)},
            {"role": "assistant", "text": "没有推理的回复"},
            {"role": "assistant", "text": "新回复", "reasoning": "r" * 8000},
        ])
        self.assertEqual(main._agent_thread_trim_reasoning(thread), 0)
        self.assertEqual(len(thread["messages"][0]["reasoning"]), main.AGENT_THREAD_REASONING_BUDGET_CHARS + 1)
        self.assertNotIn("reasoning", thread["messages"][1])

    def test_newest_reasoning_never_dropped(self):
        """新消息永远完整：即便它一条就超预算（老文件 / 手改数据），也不删它的 reasoning。"""
        thread = self._thread([
            {"role": "assistant", "text": "老回复", "reasoning": "a" * 8000},
            {"role": "assistant", "text": "新回复", "reasoning": "b" * (main.AGENT_THREAD_REASONING_BUDGET_CHARS + 5000)},
        ])
        self.assertEqual(main._agent_thread_trim_reasoning(thread), 1)
        self.assertIn("reasoning", thread["messages"][1])
        self.assertNotIn("reasoning", thread["messages"][0])


class ThreadReasoningBudgetApiTests(unittest.TestCase):
    """append 落盘路径：30 条 × 8000 字（240K > 128K）修剪后接口仍带 thinking / 时长。"""

    def _canvas(self, title):
        resp = CLIENT.post("/api/canvases", json={"title": title, "kind": "smart"})
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()["canvas"]["id"]

    def _raw_messages(self, canvas_id):
        with open(main._agent_thread_path(canvas_id), "r", encoding="utf-8") as fh:
            return json.load(fh)["threads"][0]["messages"]

    def test_append_trims_oldest_and_keeps_api_shape(self):
        canvas_id = self._canvas("思考预算画布")
        per_message = 8000
        count = 30
        keep = main.AGENT_THREAD_REASONING_BUDGET_CHARS // per_message  # 16 条（128000 ≤ 131072）
        records = [{"role": "assistant", "text": "第 %d 条" % index,
                    "reasoning": ("%02d" % index) * (per_message // 2),
                    "reasoning_truncated": index == 0,
                    "thinking_duration_ms": 1000 + index,
                    "think": {"lines": ["判断 %d" % index], "kinds": ["decision"], "secs": "1.0"}}
                   for index in range(count)]
        records.append({"role": "user", "text": "最后一句用户消息"})
        records.append({"role": "assistant", "text": "没有推理的最新回复"})
        main.agent_thread_append(canvas_id, records)

        raw = self._raw_messages(canvas_id)
        self.assertEqual(len(raw), count + 2)
        kept, dropped = raw[-(keep + 2):-2], raw[:-keep - 2]
        self.assertEqual(len(kept), keep)
        self.assertEqual(len(dropped), count - keep)
        for msg in kept:
            self.assertEqual(len(msg["reasoning"]), per_message)
        for msg in dropped:
            self.assertNotIn("reasoning", msg)
            self.assertIn("thinking_duration_ms", msg)
            self.assertIn("think", msg)
            self.assertIn("text", msg)
        self.assertTrue(dropped[0]["reasoning_truncated"])
        total = sum(len(str(msg.get("reasoning") or "")) for msg in raw)
        self.assertLessEqual(total, main.AGENT_THREAD_REASONING_BUDGET_CHARS)

        body = CLIENT.get("/api/agent/thread/%s" % canvas_id).json()
        rows = body["messages"]
        trimmed = rows[count - keep - 1]  # 最靠前的被修剪消息
        self.assertNotIn("reasoning", trimmed)
        self.assertEqual(trimmed["thinking"], "判断 %d" % (count - keep - 1))
        self.assertEqual(trimmed["thinking_duration_ms"], 1000 + count - keep - 1)
        self.assertEqual(trimmed["think"]["lines"], ["判断 %d" % (count - keep - 1)])
        self.assertEqual(trimmed["text"], "第 %d 条" % (count - keep - 1))
        self.assertEqual(rows[0]["thinking"], "判断 0")
        self.assertEqual(rows[0]["thinking_duration_ms"], 1000)
        newest = rows[count - 1]
        self.assertEqual(len(newest["reasoning"]), per_message)
        self.assertEqual(newest["thinking"], newest["reasoning"])
        self.assertNotIn("thinking", rows[count])
        self.assertNotIn("thinking", rows[count + 1])


if __name__ == "__main__":
    unittest.main()
