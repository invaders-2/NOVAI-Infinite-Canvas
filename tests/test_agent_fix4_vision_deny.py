# -*- coding: utf-8 -*-
"""看图模型失败记忆：带 TTL、连续失败才拉黑、审查不被历史 deny 当硬门槛、提示文案区分原因。"""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-vision-deny-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402

VISION_MODEL = "gemini-3.1-pro-preview"
VISION_KEY = "p:" + VISION_MODEL


class VisionDenyTests(unittest.TestCase):
    def setUp(self):
        self._saved_deny = set(main._AGENT_VISION_DENY)
        self._saved_failures = dict(main._AGENT_VISION_FAILURES)
        main._AGENT_VISION_DENY.clear()
        main._AGENT_VISION_FAILURES.clear()

    def tearDown(self):
        main._AGENT_VISION_DENY.clear()
        main._AGENT_VISION_DENY.update(self._saved_deny)
        main._AGENT_VISION_FAILURES.clear()
        main._AGENT_VISION_FAILURES.update(self._saved_failures)

    def test_gemini_preview_is_recognized_as_vision(self):
        self.assertTrue(main._agent_model_maybe_vision(VISION_MODEL))
        self.assertTrue(main._agent_model_maybe_vision("gemini-3-flash-preview"))

    def test_first_failure_is_temporary_and_expires(self):
        main._agent_vision_record_failure(VISION_KEY, "上游 500")
        self.assertIn(VISION_KEY, main._AGENT_VISION_DENY, "第一次失败：暂时跳过")
        entry = main._AGENT_VISION_FAILURES[VISION_KEY]
        self.assertFalse(entry["hard"], "第一次失败不算拉黑")
        self.assertEqual(main._AGENT_VISION_SKIP_SECONDS, 600)
        self.assertTrue(main._agent_vision_deny_active(VISION_KEY))
        # 到期后自动放行（不需要重启进程）
        later = time.time() + main._AGENT_VISION_SKIP_SECONDS + 1
        self.assertFalse(main._agent_vision_deny_active(VISION_KEY, now=later))
        self.assertNotIn(VISION_KEY, main._AGENT_VISION_DENY)
        self.assertFalse(main._agent_vision_deny_active(VISION_KEY, now=later))

    def test_consecutive_failures_are_blacklisted_with_ttl(self):
        main._agent_vision_record_failure(VISION_KEY, "第一次超时")
        self.assertFalse(main._AGENT_VISION_FAILURES[VISION_KEY]["hard"])
        main._agent_vision_record_failure(VISION_KEY, "第二次超时")
        entry = main._AGENT_VISION_FAILURES[VISION_KEY]
        self.assertTrue(entry["hard"], "连续两次才拉黑")
        self.assertEqual(entry["count"], 2)
        hard_until = entry["until"]
        self.assertGreater(hard_until - time.time(), main._AGENT_VISION_SKIP_SECONDS,
                           "拉黑时间比单次跳过更长")
        self.assertTrue(main._agent_vision_deny_active(VISION_KEY))
        main._agent_vision_clear(VISION_KEY)
        self.assertNotIn(VISION_KEY, main._AGENT_VISION_DENY)
        self.assertNotIn(VISION_KEY, main._AGENT_VISION_FAILURES, "成功一次要清空连续失败计数")

    def test_review_still_tries_current_model_even_when_denied(self):
        main._agent_vision_record_failure(VISION_KEY, "上次超时")
        main._agent_vision_record_failure(VISION_KEY, "上次超时")
        self.assertTrue(main._agent_vision_deny_active(VISION_KEY))
        chat = {"provider": "p", "base": "https://x.invalid", "headers": {},
                "model": VISION_MODEL, "provider_cfg": {}}
        with patch.object(main, "resolve_chat_provider",
                          new=lambda provider, model, ms_model="": ("https://x.invalid", {}, VISION_MODEL)), \
                patch.object(main, "_agent_available_providers", new=lambda: []):
            picked = main._agent_review_pick_chat("p", VISION_MODEL)
            fallback = main._agent_pick_caption_model(VISION_KEY, fallback_chat=chat)
        self.assertIsNotNone(picked, "审查要把当前模型当可重试，而不是历史 deny 硬门槛")
        self.assertEqual(picked.get("model"), VISION_MODEL)
        self.assertIsNone(fallback, "还在 TTL 内的模型不应该被 caption 兜底立刻重试")
        main._agent_vision_clear(VISION_KEY)
        with patch.object(main, "_agent_available_providers", new=lambda: []):
            self.assertEqual(main._agent_pick_caption_model(VISION_KEY, fallback_chat=chat), chat,
                             "没有其它看图模型时退回当前模型再试一次")

    def test_unavailable_text_distinguishes_reasons(self):
        main._agent_vision_record_failure(VISION_KEY, "模型不支持 image_url")
        text = main._agent_review_unavailable_text("p", VISION_MODEL)
        self.assertIn("上次看图失败", text)
        self.assertIn("分钟后自动重试", text)
        self.assertIn("模型不支持 image_url", text)
        self.assertIn("换一个能看图的对话模型", text)
        plain = main._agent_review_unavailable_text("p", "deepseek-chat")
        self.assertIn("未声明支持看图", plain)
        self.assertNotIn("分钟后自动重试", plain)

    def test_beat_review_uses_reason_aware_summary(self):
        main._agent_vision_record_failure(VISION_KEY, "上次 500")
        outcomes = [{"ok": True, "url": "/output/a.png", "kind": "image", "node_id": "n1",
                     "prompt": "白底图", "name": "图1"}]
        with patch.object(main, "_agent_review_pick_chat", return_value=None):
            review = asyncio.run(main._agent_beat_review(
                {"provider": "p", "model": VISION_MODEL}, "做一张白底图", [], outcomes))
        self.assertTrue(review.get("skipped"))
        self.assertIn("上次看图失败", review["summary"])
        self.assertNotEqual(review["summary"],
                            "没有能看图的模型，这批结果没法自动审查（在 API 设置里加一个能看图的对话模型就行）")


if __name__ == "__main__":
    unittest.main()
