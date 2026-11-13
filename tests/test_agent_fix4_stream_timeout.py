# -*- coding: utf-8 -*-
"""流式读取超时保护：连接开着但不发数据 → 首包/无增量/整体超时，回退非流式。"""
import asyncio
import json
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
    _TMP = tempfile.mkdtemp(prefix="novai-stream-timeout-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


class HangingResponse:
    def __init__(self, headers=None, status_code=200):
        self.status_code = status_code
        self.headers = headers or {"content-type": "text/event-stream"}

    async def aiter_lines(self):
        await asyncio.sleep(10)
        if False:      # pragma: no cover - 永远到不了：模拟「连接开着不发数据」
            yield ""

    async def aread(self):
        return b""


class HeartbeatResponse:
    def __init__(self):
        self.status_code = 200
        self.headers = {"content-type": "text/event-stream"}

    async def aiter_lines(self):
        while True:
            await asyncio.sleep(0.02)
            yield ": keepalive"

    async def aread(self):
        return b""


class FakeStream:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response, {}

    async def __aexit__(self, *args):
        return False


def chat_config():
    # 非思考型模型：这一组测的是普通模型的超时 / TTL 保护；
    # 思考型模型的首包放宽与「不拉黑」单独测（见 test_agent_fix4_stream_ttl.py）。
    return {"provider": "p", "base": "https://x.invalid/v1", "headers": {},
            "model": "gpt-4o", "provider_cfg": {"protocol": "custom"}}


class StreamTimeoutTests(unittest.TestCase):
    def setUp(self):
        main._AGENT_STREAM_DENY.clear()
        self._saved = (main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS,
                       main._AGENT_STREAM_IDLE_TIMEOUT_SECONDS,
                       main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS)

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()
        (main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS,
         main._AGENT_STREAM_IDLE_TIMEOUT_SECONDS,
         main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS) = self._saved

    def _tiny_timeouts(self, first=0.05, idle=0.05, total=1.0):
        main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS = first
        main._AGENT_STREAM_IDLE_TIMEOUT_SECONDS = idle
        main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS = total

    def test_no_first_byte_times_out(self):
        self._tiny_timeouts(first=0.05, idle=10, total=10)
        response = HangingResponse()
        with patch.object(main, "chat_stream_with_think",
                          new=lambda *a, **k: FakeStream(response)):
            started = time.monotonic()
            with self.assertRaises(main.AgentRunError) as ctx:
                asyncio.run(main._agent_run_stream_chat(chat_config(),
                                                        [{"role": "user", "content": "hi"}]))
            elapsed = time.monotonic() - started
        self.assertEqual(ctx.exception.code, "stream_timeout")
        self.assertIn("未响应", ctx.exception.message)
        self.assertIn("首包超时", ctx.exception.message)
        self.assertLess(elapsed, 1.0, "首包超时不能一直等（AI_REQUEST_TIMEOUT 默认 1800s）")

    def test_keepalive_without_payload_hits_total_timeout(self):
        self._tiny_timeouts(first=10, idle=10, total=0.12)
        with patch.object(main, "chat_stream_with_think",
                          new=lambda *a, **k: FakeStream(HeartbeatResponse())):
            started = time.monotonic()
            with self.assertRaises(main.AgentRunError) as ctx:
                asyncio.run(main._agent_run_stream_chat(chat_config(),
                                                        [{"role": "user", "content": "hi"}]))
            elapsed = time.monotonic() - started
        self.assertEqual(ctx.exception.code, "stream_timeout")
        self.assertLess(elapsed, 1.0, "整体超时要能兜住一直发心跳但不给数据的平台")

    def test_json_chat_falls_back_to_non_stream_after_timeout(self):
        self._tiny_timeouts(first=0.05, idle=0.05, total=1.0)
        raw = {"choices": [{"message": {"content": json.dumps(
            {"done": True, "message": "hi"}, ensure_ascii=False)}}]}
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                patch.object(main, "chat_stream_with_think",
                             new=lambda *a, **k: FakeStream(HangingResponse())), \
                patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw)):
            async def go():
                value = await main._agent_run_json_chat(chat_config(),
                                                        [{"role": "user", "content": "hi"}])
                return value, main._agent_stream_run_disabled()

            text, run_off = asyncio.run(go())
        self.assertIn('"message": "hi"', text)
        self.assertTrue(run_off, "超时只关掉本次运行的流式（下一次运行会重新先试流式）")
        self.assertNotIn("p:gpt-4o", main._AGENT_STREAM_DENY,
                         "超时不再写跨运行 TTL，别整 10 分钟都走非流式")

    def test_stream_connect_timeout_logs_and_returns_stream_timeout(self):
        import contextlib
        import io
        import httpx

        class ConnectTimeoutStream:
            async def __aenter__(self):
                raise httpx.ConnectTimeout("timed out connecting")

            async def __aexit__(self, *args):
                return False

        out = io.StringIO()
        with patch.object(main, "chat_stream_with_think", new=lambda *a, **k: ConnectTimeoutStream()), \
                contextlib.redirect_stdout(out):
            with self.assertRaises(main.AgentRunError) as ctx:
                asyncio.run(main._agent_run_stream_chat(chat_config(),
                                                        [{"role": "user", "content": "hi"}]))
        self.assertEqual(ctx.exception.code, "stream_timeout")
        self.assertIn("未建立连接", ctx.exception.message)
        log = out.getvalue()
        self.assertIn("决策超时", log, "超时必须有明确日志（run/round/类型/耗时）")
        self.assertIn("kind=stream_connect", log)

    def test_non_stream_chat_times_out_with_clear_error(self):
        import contextlib
        import io

        import httpx

        async def slow_post(*args, **kwargs):
            raise httpx.ReadTimeout("timed out")

        out = io.StringIO()
        with patch.object(main, "post_chat_with_think", new=slow_post), \
                contextlib.redirect_stdout(out):
            with self.assertRaises(main.AgentRunError) as ctx:
                asyncio.run(main._agent_run_chat(chat_config(), [{"role": "user", "content": "hi"}]))
        self.assertEqual(ctx.exception.code, "provider_timeout")
        self.assertIn("90 秒未响应", ctx.exception.message)
        self.assertNotIn("1800", ctx.exception.message)
        self.assertIn("决策超时", out.getvalue(), "非流式超时也要有明确日志")
        self.assertIn("kind=non_stream", out.getvalue())

    def test_non_stream_raw_times_out_too(self):
        import httpx

        async def slow_post(*args, **kwargs):
            raise httpx.ReadTimeout("timed out")

        with patch.object(main, "post_chat_with_think", new=slow_post):
            with self.assertRaises(main.AgentRunError) as ctx:
                asyncio.run(main._agent_run_chat_raw(chat_config(), [{"role": "user", "content": "hi"}]))
        self.assertEqual(ctx.exception.code, "provider_timeout")

    def test_stream_deny_has_ttl_and_retries_after_expiry(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        key = "p:gemini-3.1-pro-preview"
        main._agent_stream_record_denied(key, "首包超时")
        self.assertTrue(main._agent_stream_deny_active(key), "TTL 内走非流式")
        entry = main._AGENT_STREAM_FAILURES[key]
        self.assertFalse(entry["hard"])
        expired = time.time() + main._AGENT_STREAM_SKIP_SECONDS + 1
        self.assertFalse(main._agent_stream_deny_active(key, now=expired), "TTL 到期要重试流式")
        self.assertNotIn(key, main._AGENT_STREAM_DENY)

    def test_stream_deny_two_consecutive_failures_hard_ttl(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        key = "p:gemini-3.1-pro-preview"
        main._agent_stream_record_denied(key, "第一次")
        main._agent_stream_record_denied(key, "第二次")
        entry = main._AGENT_STREAM_FAILURES[key]
        self.assertTrue(entry["hard"])
        self.assertGreater(entry["until"] - time.time(), main._AGENT_STREAM_SKIP_SECONDS)
        main._agent_stream_clear(key)
        self.assertNotIn(key, main._AGENT_STREAM_DENY)
        self.assertNotIn(key, main._AGENT_STREAM_FAILURES)

    def test_denied_stream_uses_non_stream_then_retries_after_expiry(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        key = "p:gpt-4o"
        main._agent_stream_record_denied(key, "首包超时")
        raw = {"choices": [{"message": {"content": json.dumps(
            {"done": True, "message": "hi"}, ensure_ascii=False)}}]}

        def must_not_stream(*args, **kwargs):
            raise AssertionError("TTL 内应该直接走非流式")

        with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                patch.object(main, "chat_stream_with_think", new=must_not_stream), \
                patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw)):
            text = asyncio.run(main._agent_run_json_chat(chat_config(), [{"role": "user", "content": "hi"}]))
        self.assertIn('"message": "hi"', text)
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            self.assertFalse(main._agent_stream_available(chat_config()), "TTL 内不试流式")
        # 到了 TTL 之后：惰性过期会把名单清掉，下一次重新尝试流式
        main._agent_stream_deny_active(key, now=time.time() + main._AGENT_STREAM_SKIP_SECONDS + 1)
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
            self.assertTrue(main._agent_stream_available(chat_config()),
                            "TTL 到期后要重新尝试流式")

    def test_normal_stream_still_works(self):
        self._tiny_timeouts(first=1.0, idle=1.0, total=2.0)

        class NormalResponse:
            status_code = 200
            headers = {"content-type": "text/event-stream"}

            async def aiter_lines(self):
                yield 'data: {"choices": [{"delta": {"content": "hello"}}]}'
                yield "data: [DONE]"

            async def aread(self):
                return b""

        with patch.object(main, "chat_stream_with_think",
                          new=lambda *a, **k: FakeStream(NormalResponse())):
            raw = asyncio.run(main._agent_run_stream_chat(chat_config(),
                                                          [{"role": "user", "content": "hi"}]))
        self.assertEqual(raw["choices"][0]["message"]["content"], "hello")


if __name__ == "__main__":
    unittest.main()