# -*- coding: utf-8 -*-
"""L2（原 K3 返工）：流式超时只影响本次运行，下一次运行重新先试流式。

契约：
  * 同一次运行里某模型流式超时一次 → 本次运行剩余轮次直接走非流式（日志里只有第 1 轮 stream_* 超时）；
  * 下一次运行（新的运行上下文）重新先试流式，不写 10 分钟跨运行 TTL；
  * 非超时类失败（平台不支持流式 / 空回复等）仍按 TTL 记名单，避免每轮白发请求。
"""
import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-stream-ttl-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


def chat_config(model="gpt-4o"):
    return {"provider": "p", "base": "https://x.invalid/v1", "headers": {},
            "model": model, "provider_cfg": {"protocol": "openai"}}


def raw_ok():
    return {"choices": [{"message": {"content": json.dumps({"done": True, "message": "ok"}, ensure_ascii=False)}}]}


class Hang:
    """连接开着但不发任何数据（模拟流式空等）。"""

    status_code = 200
    headers = {"content-type": "text/event-stream"}

    async def aiter_lines(self):
        await asyncio.sleep(10)
        if False:
            yield ""


class StreamCM:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self.response, {}

    async def __aexit__(self, *args):
        return False


class RunScopedStreamTests(unittest.TestCase):
    def setUp(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        main._AGENT_STREAM_OFF_RUNS.clear()
        self._saved = (main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS,
                       main._AGENT_STREAM_IDLE_TIMEOUT_SECONDS,
                       main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS)
        # 首包 0.05s：模拟「流式空等」几秒内就判定超时
        main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS = 0.05
        main._AGENT_STREAM_IDLE_TIMEOUT_SECONDS = 0.05
        main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS = 1.0

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        main._AGENT_STREAM_OFF_RUNS.clear()
        (main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS,
         main._AGENT_STREAM_IDLE_TIMEOUT_SECONDS,
         main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS) = self._saved

    def test_timeout_only_skips_this_run(self):
        """同一运行：第一次超时后第二次不再试流式；换一次运行（重置运行上下文）又先试流式。"""
        calls = []

        async def one_run():
            with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                    patch.object(main, "chat_stream_with_think", new=lambda *a, **k: StreamCM(Hang())), \
                    patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw_ok())):
                first = await main._agent_raw_with_stream(chat_config(), [{"role": "user", "content": "hi"}], None)
                skipped = not main._agent_stream_available(chat_config())
                second = await main._agent_raw_with_stream(chat_config(), [{"role": "user", "content": "hi2"}], None)
                return first, skipped, second, main._agent_stream_run_disabled()

        first, skipped, second, off = asyncio.run(one_run())
        self.assertEqual(first, raw_ok(), "第一次超时回退非流式")
        self.assertTrue(skipped, "本次运行剩余轮次直接走非流式")
        self.assertTrue(off, "运行内标记打开")
        self.assertEqual(second, raw_ok())
        self.assertNotIn("p:gpt-4o", main._AGENT_STREAM_DENY, "超时不能写跨运行 TTL")

        # 下一次运行：新的运行上下文先把标记清掉 → 又先试流式
        async def next_run():
            main._AGENT_STREAM_OFF_RUNS.clear()
            with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}):
                return main._agent_stream_available(chat_config())

        self.assertTrue(asyncio.run(next_run()), "下一次运行要重新先试流式")

    def test_first_byte_timeout_logs_once_and_skips_rest_of_run(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), \
                patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                patch.object(main, "chat_stream_with_think", new=lambda *a, **k: StreamCM(Hang())), \
                patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw_ok())):
            async def go():
                for _ in range(3):        # 一次运行 3 轮决策
                    await main._agent_raw_with_stream(chat_config(), [{"role": "user", "content": "hi"}], None)
            asyncio.run(go())
        log = out.getvalue()
        self.assertEqual(log.count("kind=stream_first"), 1, "3 轮里只有第 1 轮出现首包超时日志")

    def test_non_timeout_failure_still_uses_ttl(self):
        """平台明确不支持流式（不是超时）→ 仍记 TTL，别每轮都白发一次。"""
        async def boom(chat, messages, tools=None):
            raise main.AgentRunError("平台不支持 stream", code="stream_unsupported")

        async def go():
            with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                    patch.object(main, "_agent_run_stream_chat", new=boom), \
                    patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw_ok())):
                await main._agent_raw_with_stream(chat_config(), [{"role": "user", "content": "hi"}], None)
                return main._agent_stream_deny_active("p:gpt-4o")

        self.assertTrue(asyncio.run(go()), "非超时失败仍然记 TTL")

    def test_ttl_survives_process_restart(self):
        path = main._AGENT_STREAM_FAILURES_FILE
        os.makedirs(os.path.dirname(path), exist_ok=True)
        now = time.time()
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"p:gpt-4o": {
                "count": 1, "last_at": now - 60, "until": now + 600, "hard": False,
                "reason": "流式建连超时", "written_at": main._AGENT_PROCESS_STARTED_AT - 10}}, fh)
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        main._AGENT_STREAM_FAILURES_LOADED["done"] = False
        try:
            self.assertTrue(main._agent_stream_deny_active("p:gpt-4o"),
                            "重启后 TTL 内也要直接走非流式")
        finally:
            main._AGENT_STREAM_DENY.clear()
            main._AGENT_STREAM_FAILURES.clear()
            main._AGENT_STREAM_FAILURES_LOADED["done"] = False
            try:
                os.remove(path)
            except OSError:
                pass

    def test_header_connect_vs_read_kind_labels(self):
        class CM:
            def __init__(self, exc):
                self.exc = exc

            async def __aenter__(self):
                raise self.exc

            async def __aexit__(self, *a):
                return False

        for exc, kind in ((httpx.ConnectTimeout("x"), "stream_connect"),
                          (httpx.ReadTimeout("x"), "stream_read")):
            out = io.StringIO()
            with patch.object(main, "chat_stream_with_think",
                              new=lambda *a, _exc=exc, **k: CM(_exc)), \
                    patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                    contextlib.redirect_stdout(out):
                with self.assertRaises(main.AgentRunError):
                    asyncio.run(main._agent_run_stream_chat(chat_config(),
                                                            [{"role": "user", "content": "hi"}]))
            self.assertIn("kind=" + kind, out.getvalue())

    def test_connect_timeout_blocks_rest_of_run_streaming(self):
        first_stream = []

        async def fail_stream(chat, messages, tools=None):
            first_stream.append(True)
            raise main.AgentRunError("模型 4 秒未响应（流式建连/响应头超时）", code="stream_timeout")

        async def go():
            with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                    patch.object(main, "_agent_run_stream_chat", new=fail_stream), \
                    patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw_ok())):
                await main._agent_run_decide(chat_config(), "SYS", "hi", "c1", "[]", {})
                started = time.monotonic()
                await main._agent_run_decide(chat_config(), "SYS", "hi2", "c1", "[]", {})
                return time.monotonic() - started

        elapsed = asyncio.run(go())
        self.assertEqual(len(first_stream), 1, "第二次决策不该再尝试流式")
        self.assertLess(elapsed, 0.5, "第二次决策应直接非流式返回，不能等超时")


class ThinkingModelStreamTests(unittest.TestCase):
    """K3 / L2：思考型模型首包放宽；单次超时只关本次运行的流式，下一次运行继续先试流式。"""

    THINK_MODEL = "gemini-3.1-pro-preview"

    def setUp(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        main._AGENT_STREAM_OFF_RUNS.clear()
        self._saved = (main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS,
                       main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_THINK_SECONDS,
                       main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS,
                       main._AGENT_STREAM_TOTAL_TIMEOUT_THINK_SECONDS)

    def tearDown(self):
        main._AGENT_STREAM_DENY.clear()
        main._AGENT_STREAM_FAILURES.clear()
        main._AGENT_STREAM_OFF_RUNS.clear()
        (main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS,
         main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_THINK_SECONDS,
         main._AGENT_STREAM_TOTAL_TIMEOUT_SECONDS,
         main._AGENT_STREAM_TOTAL_TIMEOUT_THINK_SECONDS) = self._saved

    def test_thinking_model_gets_longer_first_byte_timeout(self):
        main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_SECONDS = 8.0
        main._AGENT_STREAM_FIRST_BYTE_TIMEOUT_THINK_SECONDS = 60.0
        self.assertEqual(main._agent_stream_first_timeout(chat_config(self.THINK_MODEL)), 60.0)
        self.assertEqual(main._agent_stream_first_timeout(chat_config("gpt-4o")), 8.0,
                         "普通模型仍是 8 秒，不跟着放宽")

    def test_three_messages_each_run_retries_streaming(self):
        calls = []

        async def flaky_stream(chat, messages, tools=None):
            calls.append(len(calls))
            if len(calls) == 1:
                raise main.AgentRunError("模型 60 秒未响应（流式首包超时）", code="stream_timeout")
            return {"choices": [{"message": {"content": "逐字输出"}}]}

        think_chat = chat_config(self.THINK_MODEL)

        async def go():
            out = []
            for _ in range(3):                     # 3 条消息 = 3 次运行（每次运行上下文重置）
                main._AGENT_STREAM_OFF_RUNS.clear()
                with patch.dict(os.environ, {"NOVAI_AGENT_V2_STREAM": "1"}), \
                        patch.object(main, "_agent_run_stream_chat", new=flaky_stream), \
                        patch.object(main, "_agent_run_chat_raw", new=AsyncMock(return_value=raw_ok())):
                    out.append(await main._agent_raw_with_stream(think_chat, [{"role": "user", "content": "hi"}], None))
            return out

        results = asyncio.run(go())
        self.assertEqual(results[0], raw_ok(), "第一次超时按原逻辑回退非流式")
        for item in results[1:]:
            self.assertEqual(item.get("choices", [{}])[0].get("message", {}).get("content"), "逐字输出")
        self.assertEqual(len(calls), 3, "连续 3 条消息都要先试流式")
        self.assertNotIn("p:gemini-3.1-pro-preview", main._AGENT_STREAM_DENY,
                         "思考型模型一次超时不能写跨运行 TTL")


if __name__ == "__main__":
    unittest.main()