import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-web-disabled-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main


CANVAS = {"id": "c1", "title": "测试画布", "kind": "classic", "nodes": [], "connections": [],
          "created_at": 0, "updated_at": 0}


def _chat():
    return {"provider": "x", "base": "https://x.invalid/v1", "headers": {}, "model": "gpt-4o",
            "provider_cfg": {}}


class UnknownStepsMessageTests(unittest.TestCase):
    def test_web_tool_when_web_disabled_is_actionable(self):
        with patch.object(main, "load_settings", return_value={}):
            text = main._agent_unknown_steps_error(["web_search"])
        self.assertIn("联网未开启", text)
        self.assertIn("设置 › 通用", text)
        self.assertIn("web_search", text)
        self.assertNotIn("不可用步骤", text)

    def test_web_tools_all_covered(self):
        with patch.object(main, "load_settings", return_value={}):
            for tool in ("web_search", "fetch_url", "search_images", "find_similar_images",
                         "add_image_to_canvas"):
                with self.subTest(tool=tool):
                    text = main._agent_unknown_steps_error([tool])
                    self.assertIn("联网未开启", text)
                    self.assertIn(tool, text)
                    self.assertNotIn("不可用步骤", text)

    def test_web_tool_enters_steps_when_web_enabled(self):
        ctx = main._CanvasRunContext({"canvas_id": "c1"})
        with patch.object(main, "load_settings", return_value={"agent_web_enabled": True}):
            steps, unknown = main._agent_run_normalize_steps(
                [{"tool": "web_search", "args": {"query": "NOVAI"}}], ctx.tools())
        self.assertEqual([step["tool"] for step in steps], ["web_search"])
        self.assertEqual(unknown, [])

    def test_web_tool_when_web_enabled_keeps_old_wording(self):
        with patch.object(main, "load_settings", return_value={"agent_web_enabled": True}):
            text = main._agent_unknown_steps_error(["web_search"])
        self.assertIn("模型给出了不可用步骤", text)
        self.assertIn("web_search", text)
        self.assertNotIn("联网未开启", text)

    def test_non_web_unknown_tool_keeps_old_wording(self):
        with patch.object(main, "load_settings", return_value={}):
            text = main._agent_unknown_steps_error(["totally_unknown_tool"])
        self.assertEqual(text, "模型给出了不可用步骤：totally_unknown_tool")

    def test_mixed_unknown_mentions_both_reasons(self):
        with patch.object(main, "load_settings", return_value={}):
            text = main._agent_unknown_steps_error(["web_search", "totally_unknown_tool"])
        self.assertIn("联网未开启", text)
        self.assertIn("模型给出了不可用步骤：totally_unknown_tool", text)

    def test_user_prompt_tells_model_not_to_retry_web_tools(self):
        text = main._agent_run_user_prompt(
            "帮我搜张图", [], 2, 6, 0,
            "画布助手联网未开启：请到「设置 › 通用」打开「画布助手联网」后重试（这一步需要联网：web_search）")
        self.assertIn("不要重试联网工具", text)
        self.assertIn("设置 › 通用", text)
        normal = main._agent_run_user_prompt("帮我搜张图", [], 2, 6, 0, "模型给出了不可用步骤：foo")
        self.assertNotIn("不要重试联网工具", normal)


class RunWebDisabledMessageTests(unittest.TestCase):
    """stub 模型真跑 _agent_run_producer：联网关闭时用户看到的必须是可操作文案。"""

    def setUp(self):
        main._AGENT_NATIVE_DENY.clear()
        main._AGENT_VISION_DENY.clear()

    def _drain(self, replies, mode="run"):
        calls = []

        async def fake_chat(chat, messages):
            calls.append(messages)
            return replies[min(len(calls) - 1, len(replies) - 1)]

        patches = [
            patch.object(main, "load_canvas", side_effect=lambda cid: dict(CANVAS)),
            patch.object(main, "_agent_run_load_canvas_soft", side_effect=lambda cid: dict(CANVAS)),
            patch.object(main, "agent_session_save"),
            patch.object(main, "snapshot_canvas_version", return_value=1),
            patch.object(main, "_agent_mutate_canvas", side_effect=lambda cid, fn: (dict(CANVAS), None)),
            patch.object(main, "_agent_run_chat", new=fake_chat),
            patch.object(main, "load_settings", return_value={}),      # 联网开关关闭
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        req = {"canvas_id": "c1", "instruction": "帮我搜张参考图", "focus": {}, "history": [],
               "chat": _chat(), "max_steps": 4, "mode": mode, "approved_steps": []}

        async def go():
            queue = asyncio.Queue()
            with contextlib.redirect_stdout(io.StringIO()):
                await main._agent_run_producer(req, queue)
            events = []
            while not queue.empty():
                chunk = queue.get_nowait()
                if chunk is None:
                    break
                if chunk.startswith("event: "):
                    name = chunk.split("\n")[0][len("event: "):]
                    data = json.loads(chunk.split("data: ", 1)[1])
                    events.append((name, data))
            return events, calls

        return asyncio.run(go())

    def _replies(self):
        return [
            json.dumps({"thought": "先搜索参考图",
                        "steps": [{"tool": "web_search", "args": {"query": "北欧风客厅 参考图"}}],
                        "done": False}, ensure_ascii=False),
            json.dumps({"done": True,
                        "message": "联网还没开：请到「设置 › 通用」打开「画布助手联网」，我再帮你搜。"},
                       ensure_ascii=False),
        ]

    def test_run_message_is_actionable_and_hint_fed_back(self):
        events, calls = self._drain(self._replies(), mode="run")
        done = next(data for name, data in events if name == "done")
        message = done["message"]
        self.assertIn("联网未开启", message)
        self.assertIn("设置 › 通用", message)
        self.assertNotIn("不可用步骤", message)
        # 第二轮回灌给模型的用户消息里明确「不要重试联网工具」
        second_user = calls[1][-1]["content"]
        self.assertIn("不要重试联网工具", second_user)
        self.assertIn("设置 › 通用", second_user)

    def test_plan_mode_message_is_actionable(self):
        events, _calls = self._drain(self._replies(), mode="plan")
        done = next(data for name, data in events if name == "done")
        message = done["message"]
        self.assertIn("联网未开启", message)
        self.assertNotIn("不可用步骤", message)

    def test_non_web_unknown_tool_keeps_old_wording(self):
        replies = [
            json.dumps({"thought": "试试内部工具",
                        "steps": [{"tool": "totally_unknown_tool", "args": {}}],
                        "done": False}, ensure_ascii=False),
            json.dumps({"done": True, "message": "这个工具用不了，换个做法。"}, ensure_ascii=False),
        ]
        events, _calls = self._drain(replies, mode="run")
        done = next(data for name, data in events if name == "done")
        self.assertIn("模型给出了不可用步骤", done["message"])
        self.assertNotIn("联网未开启", done["message"])


if __name__ == "__main__":
    unittest.main()
