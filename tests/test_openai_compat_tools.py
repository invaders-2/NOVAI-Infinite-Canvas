#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOVAI OpenAI 兼容端点（/v1/chat/completions）必须把上游 tool_calls 透传。

背景：OpenClaw 等客户端把 NOVAI 当 OpenAI 供应商用；上游模型返回 tool_calls 时，
本端点如果只回 content，客户端会判定 Agent 无响应（实测 agnes 直接调用时
finish_reason=tool_calls，经本端点转发后 tools 被丢掉）。这个测试锁住透传行为。

不打真实上游：整体替换 openai_compat._upstream_client。
"""
import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("NOVAI_MODEL_API_KEY", "test-key")
import main  # noqa: E402
from server.routes import openai_compat  # noqa: E402

TOOL_CALLS = [{"id": "call_1", "type": "function",
               "function": {"name": "write", "arguments": '{"path": "/tmp/x", "content": "hi"}'}}]


class _FakeResponse(object):
    def __init__(self, payload):
        self.status_code = 200
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        return None


class _FakeClient(object):
    def __init__(self, payload):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, *args, **kwargs):
        return _FakeResponse(self._payload)


class _FakeRequest(object):
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


def _completion(tool_calls):
    message = {"role": "assistant", "content": "\n\n"}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {"choices": [{"index": 0, "message": message,
                         "finish_reason": "tool_calls" if tool_calls else "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}


class CompatToolCallTests(unittest.TestCase):

    def _call(self, payload, tool_calls):
        # 不依赖用户 data/ 与真实密钥：平台解析直接打桩，只验证 tool_calls 转发
        with patch.object(openai_compat, "_resolve_target",
                          lambda model: ("agnes-ai", "agnes-2.5-flash")), \
                patch.object(openai_compat, "_resolve_upstream",
                             lambda provider_id, model_id: ("https://example.invalid/v1", {}, "agnes-2.5-flash")), \
                patch.object(openai_compat, "_upstream_client",
                             lambda: _FakeClient(_completion(tool_calls))):
            return asyncio.run(openai_compat.chat_completions(_FakeRequest(payload), "Bearer test-key"))

    def test_tool_calls_are_forwarded(self):
        payload = {"model": "agnes-ai/agnes-2.5-flash",
                   "messages": [{"role": "user", "content": "写个文件"}],
                   "tools": [{"type": "function", "function": {"name": "write"}}],
                   "tool_choice": "auto", "stream": False}
        result = self._call(payload, TOOL_CALLS)
        choice = result["choices"][0]
        self.assertEqual(choice["finish_reason"], "tool_calls")
        self.assertEqual(choice["message"]["tool_calls"][0]["function"]["name"], "write")

    def test_plain_text_keeps_stop(self):
        payload = {"model": "agnes-ai/agnes-2.5-flash",
                   "messages": [{"role": "user", "content": "你好"}], "stream": False}
        result = self._call(payload, [])
        choice = result["choices"][0]
        self.assertEqual(choice["finish_reason"], "stop")
        self.assertNotIn("tool_calls", choice["message"])

    def test_completion_tool_calls_extracts_list(self):
        self.assertEqual(openai_compat._completion_tool_calls(_completion(TOOL_CALLS)), TOOL_CALLS)
        self.assertEqual(openai_compat._completion_tool_calls(_completion([])), [])

    def test_tool_call_messages_are_normalized(self):
        payload = {"model": "x", "stream": False, "messages": [
            {"role": "assistant", "content": "", "tool_calls": TOOL_CALLS},
            {"role": "tool", "content": "ok", "tool_call_id": "call_1"},
        ]}
        messages = openai_compat._normalize_messages(payload)
        self.assertEqual(messages[0]["tool_calls"], TOOL_CALLS)
        self.assertEqual(messages[1]["tool_call_id"], "call_1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
