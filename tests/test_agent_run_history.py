"""画布助手对话记忆：/api/agent/run 的 history 清洗、提示词注入与反问分支（模型调用全部打桩）。

覆盖：
  1. 清洗：role 白名单、单条 2000 字截断、最近 20 条、总 6000 字从最旧丢、空/脏历史不报错；
  2. 提示词：有历史时历史段出现在画布快照之后；无历史时整段（含标题）不出现；
  3. 反问：模型返回 done=true + message 时 SSE 以 done 收尾、message 原样透出、不产生任何工具调用。
"""
import asyncio
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def canvas():
    return {"id": "c1", "kind": "smart", "title": "测试画布", "nodes": [], "connections": [],
            "updated_at": 1700000000000}


def chat_config():
    return {"provider": "openai", "base": "https://example.invalid/v1", "headers": {},
            "model": "test-chat-model", "provider_cfg": {}}


def agent_request(history):
    return {
        "canvas_id": "c1",
        "instruction": "再大一点",
        "focus": main._agent_run_normalize_focus(None),
        "history": main._agent_run_normalize_history(history),
        "chat": chat_config(),
        "max_steps": 6,
    }


def drain(req):
    """同步跑完 producer，收集它塞进队列的所有 SSE 片段（静音它自己的进度打印）。"""
    async def run():
        queue = asyncio.Queue()
        with contextlib.redirect_stdout(io.StringIO()):
            await main._agent_run_producer(req, queue)
        chunks = []
        while not queue.empty():
            item = queue.get_nowait()
            if item is None:
                break
            chunks.append(item)
        return chunks
    return asyncio.run(run())


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


class AgentRunHistoryNormalizeTests(unittest.TestCase):
    def test_dirty_roles_empty_text_and_non_dict_items_are_dropped(self):
        raw = [
            {"role": "user", "text": "  把这张图改成竖版  "},
            {"role": "system", "text": "内部提示词不该进来"},
            {"role": "", "text": "没有角色"},
            {"role": "assistant", "text": "   "},
            "不是对象",
            {"role": "assistant", "text": "好的，已记下"},
        ]
        self.assertEqual(main._agent_run_normalize_history(raw),
                         [{"role": "user", "text": "把这张图改成竖版"},
                          {"role": "assistant", "text": "好的，已记下"}])

    def test_single_item_is_truncated_to_2000_chars(self):
        out = main._agent_run_normalize_history([{"role": "user", "text": "长" * 2500}])
        self.assertEqual(len(out), 1)
        self.assertEqual(len(out[0]["text"]), 2000)

    def test_only_latest_20_items_are_kept(self):
        raw = [{"role": "user", "text": f"第{i}句"} for i in range(25)]
        out = main._agent_run_normalize_history(raw)
        self.assertEqual(len(out), 20)
        self.assertEqual(out[0]["text"], "第5句")
        self.assertEqual(out[-1]["text"], "第24句")

    def test_total_chars_over_6000_drops_from_oldest(self):
        raw = [{"role": "user", "text": "A" * 2000}, {"role": "assistant", "text": "B" * 2000},
               {"role": "user", "text": "C" * 2000}, {"role": "assistant", "text": "D" * 2000}]
        out = main._agent_run_normalize_history(raw)
        self.assertEqual([rec["text"][0] for rec in out], ["B", "C", "D"])
        self.assertEqual(sum(len(rec["text"]) for rec in out), 6000)

    def test_empty_or_garbage_history_never_raises(self):
        for value in ([], None, "不是数组", {}, [None], [{"role": 1, "text": 2}], [object()]):
            self.assertEqual(main._agent_run_normalize_history(value), [], repr(value))

    def test_request_model_tolerates_dirty_history_without_422(self):
        self.assertEqual(main.AgentRunRequest(canvas_id="c1", instruction="再大一点").history, [])
        self.assertEqual(main.AgentRunRequest(canvas_id="c1", instruction="再大一点",
                                              history="不是数组").history, [])
        payload = main.AgentRunRequest(canvas_id="c1", instruction="再大一点",
                                       history=[{"role": "user", "text": "来一张"},
                                                "脏数据", {"role": None, "text": None}])
        self.assertEqual([item.model_dump() for item in payload.history],
                         [{"role": "user", "text": "来一张"}, {"role": "", "text": ""}])
        self.assertEqual(main._agent_run_normalize_history(payload.history),
                         [{"role": "user", "text": "来一张"}])


class AgentRunPromptTests(unittest.TestCase):
    def _system_prompt(self, history):
        captured = {}

        async def fake_chat(chat, messages):
            captured["system"] = messages[0]["content"]
            captured["user"] = messages[1]["content"]
            return json.dumps({"done": True, "message": "好的"})

        with patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "_agent_run_chat", side_effect=fake_chat), \
                patch.object(main, "agent_session_save"), \
                patch.object(main, "agent_execute_step", new=AsyncMock()):
            drain(agent_request(history))
        return captured["system"]

    def test_history_section_follows_canvas_summary(self):
        system = self._system_prompt([
            {"role": "user", "text": "帮我出张图"},
            {"role": "assistant", "text": "好的，出图用的是 gpt-image"},
        ])
        self.assertIn("最近对话", system)
        self.assertLess(system.index("当前画布快照摘要"), system.index("最近对话"))
        self.assertIn("用户：帮我出张图", system)
        self.assertIn("助手：好的，出图用的是 gpt-image", system)
        self.assertIn("可能已经过期", system)
        self.assertIn("一切以画布快照为准", system)

    def test_no_history_section_when_history_empty(self):
        system = self._system_prompt([])
        self.assertNotIn("最近对话", system)
        self.assertNotIn("用户：", system)
        self.assertEqual(main._agent_run_history_prompt([]), "")

    def test_prompt_has_clarify_rule(self):
        self.assertIn("7) 信息不足", main._AGENT_RUN_SYSTEM_PROMPT)
        self.assertIn("message", main._AGENT_RUN_SYSTEM_PROMPT)
        self.assertIn("done=true", main._AGENT_RUN_SYSTEM_PROMPT)


class AgentRunClarifyTests(unittest.TestCase):
    """模型直接反问：done=true + message 就是最终回复，不能落任何工具调用。"""

    QUESTION = "你希望用哪个平台出图？"

    def setUp(self):
        self.execute = AsyncMock(return_value={"ok": True, "result": {}})
        self.chat = AsyncMock(return_value=json.dumps({"done": True, "message": self.QUESTION},
                                                      ensure_ascii=False))
        patches = [
            patch.object(main, "load_canvas", return_value=canvas()),
            patch.object(main, "agent_session_save"),
            patch.object(main, "agent_execute_step", new=self.execute),
            patch.object(main, "_agent_run_chat", new=self.chat),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def test_clarifying_question_ends_stream_without_tool_calls(self):
        events = parse_events(drain(agent_request([{"role": "user", "text": "帮我出张图"}])))
        names = [name for name, _ in events]
        self.assertEqual(names.count("done"), 1)
        self.assertEqual(names[-1], "done")
        self.assertNotIn("plan", names)
        self.assertNotIn("step_start", names)
        self.assertNotIn("step_result", names)
        self.assertEqual(self.execute.await_count, 0)
        self.assertEqual(self.chat.await_count, 1)
        self.assertEqual(events[-1][1]["status"], "ok")
        self.assertEqual(events[-1][1]["message"], self.QUESTION)
        self.assertIn(("message", {"text": self.QUESTION}), events)


class AgentRunEndpointTests(unittest.TestCase):
    """/api/agent/run 整条链路（模型调用打桩）：history 字段真的会进 system 提示词。"""

    def test_endpoint_accepts_history_and_injects_it(self):
        captured = {}

        async def fake_chat(chat, messages):
            captured["system"] = messages[0]["content"]
            return json.dumps({"done": True, "message": "好的"}, ensure_ascii=False)

        execute = AsyncMock(return_value={"ok": True, "result": {}})
        payload = main.AgentRunRequest(
            canvas_id="c1", instruction="再大一点",
            history=[{"role": "user", "text": "来一张竖版海报"},
                     {"role": "system", "text": "内部提示词不该进来"},
                     {"role": "assistant", "text": "好的，马上"}])

        async def drive():
            response = await main.agent_run(payload)
            chunks = [chunk async for chunk in response.body_iterator]
            return response, chunks

        with patch.object(main, "load_canvas", return_value=canvas()), \
                patch.object(main, "_agent_run_resolve_chat", return_value=chat_config()), \
                patch.object(main, "_agent_run_chat", side_effect=fake_chat), \
                patch.object(main, "agent_session_save"), \
                patch.object(main, "agent_execute_step", new=execute):
            response, chunks = asyncio.run(drive())

        self.assertEqual(response.media_type, "text/event-stream")
        self.assertIn("用户：来一张竖版海报", captured["system"])
        self.assertIn("助手：好的，马上", captured["system"])
        self.assertNotIn("内部提示词不该进来", captured["system"])
        self.assertEqual(execute.await_count, 0)
        self.assertEqual([name for name, _ in parse_events(chunks)][-1], "done")


if __name__ == "__main__":
    unittest.main()
