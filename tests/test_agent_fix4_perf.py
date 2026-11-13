# -*- coding: utf-8 -*-
"""性能日志 / 审查不挡回复：耗时日志格式、首包超时默认 8s、后台审查不阻塞。"""
import asyncio
import contextlib
import io
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-perf-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


class TimingLogTests(unittest.TestCase):
    def test_timing_log_line_has_run_round_stage_model(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            main._agent_timing_log("decide", "run_x", 3, 1234.5, "gemini-3.1-pro-preview")
        line = out.getvalue().strip()
        self.assertIn("[Agent][Timing]", line)
        self.assertIn("run=run_x", line)
        self.assertIn("round=3", line)
        self.assertIn("stage=decide", line)
        self.assertIn("elapsed_ms=1234", line)
        self.assertIn("model=gemini-3.1-pro-preview", line)

    def test_stream_first_byte_timeout_defaults_to_8s(self):
        self.assertLessEqual(main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS, 8.0,
                             "首包超时要在用户耐心之前（默认 8s，可 env 调）")

    def test_slow_non_stream_logs_warning_without_changing_behavior(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            main._agent_non_stream_log_slow("gemini-3.1-pro-preview", 52.3)
        log = out.getvalue()
        self.assertIn("非流式慢请求", log)
        self.assertIn("elapsed_s=52.3s", log)
        self.assertIn("gemini-3.1-pro-preview", log)
        out2 = io.StringIO()
        with contextlib.redirect_stdout(out2):
            main._agent_non_stream_log_slow("m", 1.0)
        self.assertEqual(out2.getvalue(), "")

    def test_stream_connect_timeout_is_shorter_than_first_byte(self):
        self.assertLessEqual(main._AGENT_STREAM_CONNECT_TIMEOUT_SECONDS, 4.0)
        self.assertLess(main._AGENT_STREAM_CONNECT_TIMEOUT_SECONDS,
                        main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS)


class ReviewNotBlockingTests(unittest.TestCase):
    def setUp(self):
        self._tasks = set(main._AGENT_REVIEW_TASKS)
        main._AGENT_REVIEW_TASKS.clear()

    def tearDown(self):
        for task in list(main._AGENT_REVIEW_TASKS):
            task.cancel()
        main._AGENT_REVIEW_TASKS.clear()
        main._AGENT_REVIEW_TASKS.update(self._tasks)

    def test_schedule_review_returns_before_review_finishes(self):
        transcript = types_simple_transcript()
        emit = lambda name, data: None
        review = {"summary": "合格", "items": [
            {"label": "图1", "node_id": "n1", "url": "/a.png", "kind": "image",
             "ok": True, "issues": [], "revised_prompt": ""}]}
        calls = []

        async def slow_review(*args):
            calls.append(args)
            await asyncio.sleep(0.05)
            return review

        async def scenario():
            with patch.object(main, "_agent_beat_review", new=slow_review):
                task = main._agent_schedule_review(
                    {"model": "m"}, "做图", [], [{"node_id": "n1"}], transcript, emit,
                    "run_x", 1, {}, "c1", pending_reviews=[])
                self.assertFalse(task.done(), "schedule 要立刻返回，不能等审查跑完")
                await asyncio.wait_for(task, timeout=2)
            return task

        task = asyncio.run(scenario())
        self.assertTrue(task.done())
        self.assertTrue(transcript.notes, "审查结论要写进转录（下一轮输入）")
        self.assertEqual(transcript.notes[-1][0], "review")

    def test_schedule_review_records_pending_for_next_round(self):
        transcript = types_simple_transcript()
        pending = []
        review = {"summary": "不合格", "items": [
            {"label": "图1", "node_id": "n1", "url": "/a.png", "kind": "image",
             "ok": False, "issues": ["变形"], "revised_prompt": "笔直"}]}

        async def fake_review(*args):
            return review

        async def scenario():
            with patch.object(main, "_agent_beat_review", new=fake_review):
                task = main._agent_schedule_review(
                    {"model": "m"}, "做图", [], [{"node_id": "n1"}], transcript,
                    lambda name, data: None, "run_x", 1, {}, "c1", pending_reviews=pending)
                await asyncio.wait_for(task, timeout=2)

        asyncio.run(scenario())
        self.assertEqual(pending, [review], "审查结论要留给下一轮决策用")


class _Transcript:
    def __init__(self):
        self.notes = []

    def add_note(self, kind, text):
        self.notes.append((kind, text))
        return True


def types_simple_transcript():
    return _Transcript()


if __name__ == "__main__":
    unittest.main()
