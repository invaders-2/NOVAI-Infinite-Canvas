# -*- coding: utf-8 -*-
"""上下文占用指示器（后端）：token 估算纯函数 + 每轮的 context_usage SSE 事件。

契约（前端状态机已支持）：
    event: context_usage
    data: {id, used_tokens, max_tokens, percentage, source: "estimate", round}
max_tokens=0 表示拿不到模型窗口，此时 percentage 为 null，前端只显示绝对值。

模型调用全程打桩：不调真实模型、不落盘真实画布（数据目录指到临时目录）。
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

_TMP_DATA = tempfile.mkdtemp(prefix="novai-ctx-usage-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": [], "connections": [],
            "updated_at": 1700000000000}


def agent_request(mode="run", context_max=None, model=None, provider_cfg=None):
    chat = {"provider": "p", "base": "http://x", "headers": {},
            "model": model or "test-chat-model",
            # provider_cfg 为空 = 不启用原生工具调用，走被测的 JSON 那条路
            "provider_cfg": provider_cfg or {}}
    if context_max is not None:
        chat["context_max"] = context_max
    return {"canvas_id": "c1", "instruction": "看看画布", "focus": main._agent_run_normalize_focus(None),
            "history": [], "chat": chat, "max_steps": 6, "mode": mode, "approved_steps": [],
            "enforce_write_confirmation": True}


def parse_events(chunks):
    events = []
    for chunk in chunks:
        for block in chunk.strip().split("\n\n"):
            if not block or block.startswith(":"):
                continue
            name, data = "message", {}
            for line in block.split("\n"):
                if line.startswith("event: "):
                    name = line[len("event: "):].strip()
                elif line.startswith("data: "):
                    data = json.loads(line[len("data: "):])
            events.append((name, data))
    return events


def drain(req, replies, execute=None):
    """跑完 producer，返回 [(event, data)]；模型回复按顺序从 replies 取。"""
    execute = execute or AsyncMock(return_value={"ok": True, "result": {"nodes": []}, "message": "执行成功"})
    chat = AsyncMock(side_effect=[json.dumps(r, ensure_ascii=False) for r in replies])

    async def run():
        queue = asyncio.Queue()
        with contextlib.redirect_stdout(io.StringIO()):
            await main._agent_run_producer(req, queue)
        out = []
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                break
            out.append(item)
        return out

    with patch.object(main, "load_canvas", return_value=canvas()), \
            patch.object(main, "agent_session_save"), \
            patch.object(main, "_agent_run_chat", new=chat), \
            patch.object(main, "agent_execute_step", new=execute):
        return parse_events(asyncio.run(run()))


def events_of(events, name):
    return [data for event, data in events if event == name]


READ_ONLY_REPLIES = [
    {"thought": "看画布", "steps": [{"tool": "get_canvas", "args": {"canvas_id": "c1"},
                                    "description": "看画布"}], "done": False},
    {"done": True, "message": "看完了"},
]
WRITE_REPLIES = [
    {"thought": "建节点", "steps": [{"tool": "create_node",
                                    "args": {"canvas_id": "c1", "type": "prompt", "title": "海报"},
                                    "description": "建提示词节点"}], "done": False},
]


class EstimateTests(unittest.TestCase):
    """_agent_estimate_tokens 是纯函数：只做可解释的字符级估算。"""

    def test_empty_and_none(self):
        for value in (None, "", "   \n\t  "):
            with self.subTest(value=value):
                self.assertEqual(main._agent_estimate_tokens(value), 0)

    def test_pure_english_four_chars_per_token(self):
        self.assertEqual(main._agent_estimate_tokens("a"), 1)
        self.assertEqual(main._agent_estimate_tokens("abcd"), 1)
        self.assertEqual(main._agent_estimate_tokens("abcde"), 2)      # 向上取整
        self.assertEqual(main._agent_estimate_tokens("abcdefgh"), 2)
        # 空格不算可见字符，不虚增 token
        self.assertEqual(main._agent_estimate_tokens("hello world"), main._agent_estimate_tokens("helloworld"))

    def test_pure_chinese_one_char_per_token(self):
        self.assertEqual(main._agent_estimate_tokens("你好"), 2)
        self.assertEqual(main._agent_estimate_tokens("画布助手测试"), 6)
        self.assertEqual(main._agent_estimate_tokens("，"), 1)          # 全角标点按一个 token 算

    def test_mixed_text(self):
        # 4 个 CJK + 6 个英文字母 → 4 + ceil(6/4) = 6
        self.assertEqual(main._agent_estimate_tokens("画布助手 canvas"), 6)
        self.assertEqual(main._agent_estimate_tokens("图3"), 2)          # 1 CJK + 1 字符 → 1 + 1
        self.assertIsInstance(main._agent_estimate_tokens("图3"), int)

    def test_non_string_is_coerced(self):
        self.assertEqual(main._agent_estimate_tokens(12345), 2)          # "12345" → ceil(5/4)
        self.assertEqual(main._agent_estimate_tokens([1, 2]), 2)         # "[1, 2]" 去掉空格 5 字符

    def test_monotonic_longer_text_never_smaller(self):
        base = "画布助手把这张图的风格换成 reference 里的水彩感，比例 16:9。"
        prev = 0
        for n in range(1, len(base) + 1):
            cur = main._agent_estimate_tokens(base[:n])
            self.assertGreaterEqual(cur, prev)
            prev = cur
        self.assertGreater(main._agent_estimate_tokens(base), 0)

    def test_context_max_helper_defaults_to_zero(self):
        self.assertEqual(main._agent_run_context_max(None), 0)
        self.assertEqual(main._agent_run_context_max({}), 0)
        self.assertEqual(main._agent_run_context_max({"context_max": "脏"}), 0)
        self.assertEqual(main._agent_run_context_max({"context_max": 0}), 0)
        self.assertEqual(main._agent_run_context_max({"context_max": 128000}), 128000)


class ContextWindowResolutionTests(unittest.TestCase):
    """_agent_run_context_max 的解析顺序：显式 > provider > windows > env > 默认表 > 0。"""

    def _resolve(self, chat, env=None):
        # 默认清空环境变量，避免开发机自己的设置影响断言
        with patch.dict(os.environ, {"NOVAI_CONTEXT_MAX": env or ""}):
            return main._agent_run_context_max(chat)

    def test_explicit_chat_value_wins(self):
        chat = {"context_max": 111, "model": "claude-sonnet-5",
                "provider_cfg": {"context_max": 222, "context_windows": {"claude-sonnet-5": 333}}}
        self.assertEqual(self._resolve(chat, env="444"), 111)

    def test_provider_context_max_wins_over_windows_env_default(self):
        chat = {"model": "claude-sonnet-5",
                "provider_cfg": {"context_max": 222, "context_windows": {"claude-sonnet-5": 333}}}
        self.assertEqual(self._resolve(chat, env="444"), 222)

    def test_windows_exact_hit_wins_over_env_and_default(self):
        chat = {"model": "gpt-4o", "provider_cfg": {"context_windows": {"gpt-4o": 128000}}}
        self.assertEqual(self._resolve(chat, env="444"), 128000)
        # 只认精确命中：模型名对不上就不算（宁愿 0 也不猜）
        self.assertEqual(self._resolve({"model": "gpt-4o-mini",
                                        "provider_cfg": {"context_windows": {"gpt-4o": 128000}}}, env="444"), 444)

    def test_env_wins_over_default_table(self):
        self.assertEqual(self._resolve({"model": "claude-sonnet-5", "provider_cfg": {}}, env="444"), 444)

    def test_default_table_only_has_verified_claude(self):
        for model in ("claude-sonnet-5", "claude-3-7", "Claude-Opus-4"):
            with self.subTest(model=model):
                self.assertEqual(self._resolve({"model": model, "provider_cfg": {}}), 200000)
        for model in ("gemini-2.0-flash", "gpt-4o", "deepseek-v3", "anthropic/claude-3", "", None):
            with self.subTest(model=model):
                self.assertEqual(self._resolve({"model": model, "provider_cfg": {}}), 0)

    def test_dirty_values_fall_through(self):
        for dirty in ("abc", 0, -1, None, "", [], {}, True):
            with self.subTest(value=dirty):
                self.assertEqual(self._resolve({"context_max": dirty, "model": "gpt-4o",
                                                "provider_cfg": {}}), 0)
        # 脏值不该挡住下一优先级
        self.assertEqual(self._resolve({"context_max": "abc", "model": "gpt-4o",
                                        "provider_cfg": {"context_max": 500}}), 500)
        self.assertEqual(self._resolve({"context_max": -1, "model": "gpt-4o",
                                        "provider_cfg": {"context_max": "脏",
                                                         "context_windows": {"gpt-4o": 64000}}}), 64000)

    def test_env_dirty_values_ignored(self):
        for bad in ("abc", "0", "-5", ""):
            with self.subTest(env=bad):
                self.assertEqual(self._resolve({"model": "gpt-4o", "provider_cfg": {}}, env=bad), 0)


class ContextUsageEventTests(unittest.TestCase):

    def test_event_carries_all_fields(self):
        events = drain(agent_request(), READ_ONLY_REPLIES)
        usages = events_of(events, "context_usage")
        self.assertEqual(len(usages), 2)                    # 两轮各发一次
        first = usages[0]
        self.assertEqual(set(first), {"id", "used_tokens", "max_tokens", "percentage", "source", "round"})
        self.assertEqual(first["source"], "estimate")
        self.assertEqual(first["round"], 1)
        self.assertEqual(usages[1]["round"], 2)
        self.assertIsInstance(first["used_tokens"], int)
        self.assertGreater(first["used_tokens"], 0)
        self.assertEqual(first["max_tokens"], 0)            # 拿不到窗口 → 0
        self.assertIsNone(first["percentage"])              # 没有上限就不给百分比

    def test_id_is_bound_to_run_and_round(self):
        events = drain(agent_request(), READ_ONLY_REPLIES)
        run_id = events_of(events, "run_start")[0]["run_id"]
        usages = events_of(events, "context_usage")
        self.assertEqual(usages[0]["id"], "%s:1:cu" % run_id)
        self.assertEqual(usages[1]["id"], "%s:2:cu" % run_id)

    def test_percentage_matches_used_over_max(self):
        events = drain(agent_request(context_max=1000), READ_ONLY_REPLIES)
        first = events_of(events, "context_usage")[0]
        self.assertEqual(first["max_tokens"], 1000)
        self.assertIsInstance(first["percentage"], float)
        self.assertEqual(first["percentage"], round(first["used_tokens"] * 100.0 / 1000, 1))

    def test_claude_model_gets_default_window_and_percentage(self):
        with patch.dict(os.environ, {"NOVAI_CONTEXT_MAX": ""}):
            events = drain(agent_request(model="claude-sonnet-5"), READ_ONLY_REPLIES)
        first = events_of(events, "context_usage")[0]
        self.assertEqual(first["max_tokens"], 200000)      # 内置默认表里唯一可核实的那条
        self.assertIsInstance(first["percentage"], float)
        self.assertEqual(first["percentage"], round(first["used_tokens"] * 100.0 / 200000, 1))

    def test_unknown_model_stays_absolute_only(self):
        with patch.dict(os.environ, {"NOVAI_CONTEXT_MAX": ""}):
            events = drain(agent_request(model="gpt-4o"), READ_ONLY_REPLIES)
        first = events_of(events, "context_usage")[0]
        self.assertEqual(first["max_tokens"], 0)           # 没核实过的模型不猜
        self.assertIsNone(first["percentage"])

    def test_usage_emitted_before_the_model_step_and_after_run_start(self):
        events = drain(agent_request(), READ_ONLY_REPLIES)
        names = [name for name, _data in events]
        self.assertLess(names.index("run_start"), names.index("context_usage"))
        self.assertLess(names.index("context_usage"), names.index("step_start"))

    def test_existing_events_still_emitted(self):
        # 只读步骤：run_start / context_usage / step_start / step_result / done
        read_events = [name for name, _data in drain(agent_request(), READ_ONLY_REPLIES)]
        for name in ("run_start", "context_usage", "step_start", "step_result", "done"):
            self.assertIn(name, read_events)
        # 未确认的写步骤：仍然先出 plan，再 done
        write_events = [name for name, _data in drain(agent_request(), WRITE_REPLIES)]
        for name in ("run_start", "context_usage", "plan", "done"):
            self.assertIn(name, write_events)
        plan = events_of(drain(agent_request(), WRITE_REPLIES), "plan")[0]
        self.assertTrue(plan["requires_confirmation"])      # 闸门没被我的事件影响


if __name__ == "__main__":
    unittest.main()
