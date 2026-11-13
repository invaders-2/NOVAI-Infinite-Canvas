# -*- coding: utf-8 -*-
"""阶段二·2 recall：索引写入去重 / 关键词命中 / scope 过滤 / 出处字段 / 空结果 / 开关门禁。

用真实 main + 临时数据目录；模型不参与（摘要改由调用方直接给文本），不起服务、不联网。
开关在进程内用环境变量切换（_agent_v2_flag 每次读环境变量），跑完自动还原，不影响其它测试文件。
"""
import asyncio
import contextlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-agent-recall-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from server.agents import cli_spec  # noqa: E402

STORE = main._agent_memory_store
CLIENT = TestClient(main.app)
SRC_DIR = str(ROOT)


@contextlib.contextmanager
def memory_on():
    """临时打开 NOVAI_AGENT_V2_MEMORY，退出时还原（不污染其它测试）。"""
    old = os.environ.get("NOVAI_AGENT_V2_MEMORY")
    os.environ["NOVAI_AGENT_V2_MEMORY"] = "1"
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("NOVAI_AGENT_V2_MEMORY", None)
        else:
            os.environ["NOVAI_AGENT_V2_MEMORY"] = old


def new_canvas(title):
    resp = CLIENT.post("/api/canvases", json={"title": title, "kind": "smart"})
    assert resp.status_code == 200, resp.text
    return resp.json()["canvas"]["id"]


def clear_index():
    path = os.path.join(main.AGENT_MEMORY_DIR, STORE.INDEX_FILENAME)
    if os.path.exists(path):
        os.remove(path)


def index_entries():
    return STORE.MemoryIndex(main.AGENT_MEMORY_DIR).entries(fresh=True)


def seed(entries):
    return STORE.MemoryIndex(main.AGENT_MEMORY_DIR).add(entries)


def make_thread(canvas_id, title="海报对话", messages=None, summary=""):
    thread = main._agent_thread_new_thread(title)
    thread["messages"] = messages or [
        {"role": "user", "text": "做一套冷蓝色调的产品海报", "at": 1700000000},
        {"role": "assistant", "text": "好的，先出主视觉，3:4 竖版", "at": 1700000060},
    ]
    if summary:
        thread["summary"] = summary
        thread["summary_upto"] = len(thread["messages"])
    doc = main._agent_thread_doc_load(canvas_id)
    doc["threads"] = [thread]
    doc["active_id"] = thread["id"]
    main._agent_thread_doc_save(canvas_id, doc)
    return thread


class RecallGateTests(unittest.TestCase):
    """开关关闭：工具不注册、路由 400；开关打开：工具条目形状与参数校验。"""

    def test_tool_and_command_absent_when_off(self):
        self.assertNotIn(main.RECALL_TOOL_NAME, main.AGENT_TOOLS)
        self.assertNotIn(main.RECALL_TOOL_NAME, main.AGENT_RUN_STEP_FREE_TOOLS)
        self.assertNotIn("run.recall", cli_spec.COMMANDS)
        self.assertNotIn(main.RECALL_TOOL_NAME,
                         {item["name"] for item in main._agent_build_tools_catalog()})
        payload = main._agent_v2_recall_search("冷蓝色调", scope="canvas", canvas_id="c1")
        self.assertEqual(payload["count"], 0)
        self.assertIn("未启用", payload["message"])

    def test_route_400_when_off(self):
        resp = CLIENT.get("/api/agent/recall", params={"q": "海报", "canvas_id": "c1"})
        self.assertEqual(resp.status_code, 400)
        self.assertIn("NOVAI_AGENT_V2_MEMORY", resp.json()["detail"])

    def test_registration_happens_in_a_fresh_process_with_flag_on(self):
        """注册发生在 import 时，进程内翻不了；用干净子进程验证开关打开后确实注册。"""
        code = ("import os, sys; os.environ['NOVAI_AGENT_V2_MEMORY'] = '1';"
                " sys.path.insert(0, %r); import main;"
                " from server.agents import cli_spec;"
                " print('recall' in main.AGENT_TOOLS,"
                "       'recall' in main.AGENT_RUN_STEP_FREE_TOOLS,"
                "       'recall' in main.AGENT_FREE_TOOLS,"
                "       'run.recall' in cli_spec.COMMANDS)") % SRC_DIR
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                             timeout=180, env=dict(os.environ))
        self.assertEqual(out.returncode, 0, out.stderr[-800:])
        self.assertIn("True True True True", out.stdout, "工具 / 不占步数 / 免确认 / CLI 命令四张表都要有")

    def test_tool_entry_shape_and_validation(self):
        with memory_on():
            entry = main._agent_v2_recall_tool_entry()
            self.assertEqual(entry["schema"]["required"], ["query"])
            self.assertFalse(entry["mutates_canvas"])
            self.assertIn("没有命中就如实说没找到", entry["description"])
            for bad, code in (({"query": ""}, "invalid_args"),
                              ({"query": "海报", "scope": "wrong"}, "invalid_args"),
                              ({"query": "海报", "scope": "canvas"}, "invalid_args")):
                with self.assertRaises(main.AgentToolError) as ctx:
                    main._agent_v2_recall_validate(bad)
                self.assertEqual(ctx.exception.code, code)
            canvas_id = new_canvas("校验画布")
            args = main._agent_v2_recall_validate({"query": "海报", "scope": "canvas", "canvas_id": canvas_id})
            self.assertEqual(args["canvas_id"], canvas_id)
            self.assertLessEqual(args["limit"], STORE.RECALL_LIMIT_MAX)
            self.assertEqual(args["scope"], "canvas")
            self.assertIn("海报", main._agent_v2_recall_preview({"query": "海报"}, None))

    def test_tool_defaults_to_the_running_canvas(self):
        """运行中模型不用自己填 canvas_id：validate 从本次运行的上下文兜底。"""
        canvas_id = new_canvas("上下文画布")
        token = main._AGENT_RUN_CANVAS_ID.set(canvas_id)
        try:
            with memory_on():
                args = main._agent_v2_recall_validate({"query": "海报", "scope": "canvas"})
                self.assertEqual(args["canvas_id"], canvas_id)
        finally:
            main._AGENT_RUN_CANVAS_ID.reset(token)

    def test_route_validation_when_on(self):
        with memory_on():
            self.assertEqual(CLIENT.get("/api/agent/recall").status_code, 400)
            self.assertEqual(CLIENT.get("/api/agent/recall",
                                        params={"q": "x", "scope": "wrong", "canvas_id": "c1"}).status_code, 400)
            self.assertEqual(CLIENT.get("/api/agent/recall", params={"q": "x"}).status_code, 400)


class RecallIndexWriteTests(unittest.TestCase):
    """写入侧：消息流水去重、摘要 / 档案快照只留最新、长期记忆与删除同步。"""

    def setUp(self):
        self.canvas_id = new_canvas("索引画布")
        clear_index()

    def tearDown(self):
        clear_index()

    def test_messages_append_dedupe_and_drop_data_urls(self):
        with memory_on():
            thread = make_thread(self.canvas_id, messages=[
                {"role": "user", "text": "参考这张图 data:image/png;base64,AAAABBBBCCCC 做冷蓝色调海报",
                 "at": 1700000000},
                {"role": "assistant", "text": "先出主视觉 3:4", "at": 1700000060},
            ])
            self.assertEqual(main._agent_v2_memory_index_thread(self.canvas_id, thread), 2)
            self.assertEqual(main._agent_v2_memory_index_thread(self.canvas_id, thread), 0, "重复写入要去重")
            rows = [row for row in index_entries() if row["source"] == "message"]
            self.assertEqual(len(rows), 2)
            self.assertTrue(any(row["text"].startswith("用户：") for row in rows))
            self.assertFalse(any("base64" in row["text"] for row in rows))
            self.assertTrue(all(row["canvas_title"] == "索引画布" for row in rows))

    def test_summary_is_a_snapshot(self):
        with memory_on():
            thread = make_thread(self.canvas_id, summary="【目标】做海报\n【已定决策】冷蓝色调")
            self.assertEqual(main._agent_v2_memory_index_summary(self.canvas_id, thread), 1)
            thread["summary"] = "【目标】做海报\n【已定决策】改成暖橙色"
            thread["updated_at"] = 1700000100
            self.assertEqual(main._agent_v2_memory_index_summary(self.canvas_id, thread), 1)
            rows = [row for row in index_entries() if row["source"] == "thread_summary"]
            self.assertEqual(len(rows), 1, "同一线程只留最新一版摘要")
            self.assertIn("暖橙色", rows[0]["text"])
            self.assertEqual(rows[0]["thread_title"], "海报对话")

    def test_profile_snapshot_and_800_limit(self):
        with memory_on():
            thread = make_thread(self.canvas_id, summary="【目标】做海报\n【已完成】主视觉 v1")
            main._agent_v2_memory_refresh_profile(self.canvas_id, [thread])
            main._agent_v2_memory_refresh_profile(self.canvas_id, [thread])
            rows = [row for row in index_entries() if row["source"] == "canvas_profile"]
            self.assertEqual(len(rows), 1, "画布档案只留最新一版")
            self.assertIn("项目简介", rows[0]["text"])
            self.assertLessEqual(len(rows[0]["text"]), STORE.PROFILE_BODY_MAX)

    def test_long_term_memory_add_and_forget(self):
        with memory_on():
            main.agent_memory_add(self.canvas_id, "canvas", ["所有海报保持冷蓝色调"])
            rows = [row for row in index_entries() if row["source"] == "long_term_memory"]
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["scope"], "canvas")
            self.assertEqual(rows[0]["canvas_title"], "索引画布")
            main.agent_memory_remove(self.canvas_id, "canvas", text="冷蓝色调")
            rows = [row for row in index_entries() if row["source"] == "long_term_memory"]
            self.assertEqual(rows, [], "忘掉的记忆不能再被 recall 搜到")

    def test_thread_clear_forgets_that_thread(self):
        with memory_on():
            thread = make_thread(self.canvas_id, summary="【目标】做海报")
            main._agent_v2_memory_index_thread(self.canvas_id, thread)
            main._agent_v2_memory_index_summary(self.canvas_id, thread)
            self.assertTrue([row for row in index_entries() if row["thread_id"] == thread["id"]])
            resp = CLIENT.delete("/api/agent/thread/%s" % self.canvas_id)
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual([row for row in index_entries() if row["thread_id"] == thread["id"]], [])

    def test_thread_delete_forgets_only_that_thread(self):
        with memory_on():
            keeper = make_thread(self.canvas_id, title="保留的对话")
            doomed = main._agent_thread_new_thread("要删的对话")
            doomed["messages"] = [{"role": "user", "text": "这段要被删掉", "at": 1700000001}]
            doc = main._agent_thread_doc_load(self.canvas_id)
            doc["threads"].append(doomed)
            main._agent_thread_doc_save(self.canvas_id, doc)
            main._agent_v2_memory_index_thread(self.canvas_id, keeper)
            main._agent_v2_memory_index_thread(self.canvas_id, doomed)
            resp = CLIENT.delete("/api/agent/threads/%s" % doomed["id"],
                                 params={"canvas_id": self.canvas_id})
            self.assertEqual(resp.status_code, 200, resp.text)
            thread_ids = {row["thread_id"] for row in index_entries()}
            self.assertIn(keeper["id"], thread_ids)
            self.assertNotIn(doomed["id"], thread_ids)


class RecallSearchTests(unittest.TestCase):
    """检索侧：二元组命中、scope 过滤、出处字段、空结果、limit。"""

    def setUp(self):
        self._memory = memory_on()
        self._memory.__enter__()
        clear_index()
        self.canvas_a = new_canvas("卖货画布 A")
        self.canvas_b = new_canvas("卖货画布 B")
        seed([
            STORE.make_entry("message", "用户：做一套冷蓝色调的产品海报", canvas_id=self.canvas_a,
                             canvas_title="卖货画布 A", thread_id="ta1", thread_title="海报对话", ts=1700000000),
            STORE.make_entry("thread_summary", "【目标】做海报\n【已定决策】冷蓝色调", canvas_id=self.canvas_a,
                             canvas_title="卖货画布 A", thread_id="ta1", thread_title="海报对话", ts=1700000100),
            STORE.make_entry("long_term_memory", "所有海报都用冷蓝色调", canvas_id="", scope="global",
                             ts=1700000200),
            STORE.make_entry("message", "用户：做一条竖版短视频", canvas_id=self.canvas_b,
                             canvas_title="卖货画布 B", thread_id="tb1", thread_title="视频对话", ts=1700000300),
        ])

    def tearDown(self):
        clear_index()
        self._memory.__exit__(None, None, None)

    def test_thread_scope_hits_only_that_thread(self):
        payload = main._agent_v2_recall_search("冷蓝色调", scope="thread",
                                               canvas_id=self.canvas_a, thread_id="ta1")
        self.assertEqual(payload["count"], 2)
        self.assertEqual({item["thread_id"] for item in payload["items"]}, {"ta1"})

    def test_thread_scope_falls_back_to_active_thread(self):
        thread = make_thread(self.canvas_a, title="海报对话", summary="【目标】冷蓝色调海报")
        main._agent_v2_memory_index_summary(self.canvas_a, thread)
        payload = main._agent_v2_recall_search("冷蓝色调", scope="thread", canvas_id=self.canvas_a)
        self.assertEqual(payload["thread_id"], thread["id"], "没给线程时用这张画布的当前对话")
        self.assertGreaterEqual(payload["count"], 1)

    def test_canvas_scope_keeps_canvas_isolated(self):
        payload = main._agent_v2_recall_search("冷蓝色调", scope="canvas", canvas_id=self.canvas_a)
        self.assertEqual(payload["count"], 2)
        self.assertEqual({item["canvas_id"] for item in payload["items"]}, {self.canvas_a})

    def test_all_scope_includes_global_memory_and_other_canvas(self):
        payload = main._agent_v2_recall_search("冷蓝色调", scope="all", canvas_id=self.canvas_a)
        self.assertEqual({item["source"] for item in payload["items"]},
                         {"message", "thread_summary", "long_term_memory"})
        self.assertEqual(main._agent_v2_recall_search("竖版短视频", scope="all",
                                                      canvas_id=self.canvas_a)["count"], 1)

    def test_items_have_snippet_origin_and_source_label(self):
        item = main._agent_v2_recall_search("冷蓝色调", scope="canvas",
                                            canvas_id=self.canvas_a, limit=1)["items"][0]
        self.assertLessEqual(len(item["snippet"]), STORE.SNIPPET_MAX)
        self.assertIn("卖货画布 A", item["origin"])
        self.assertIn("海报对话", item["origin"])
        self.assertRegex(item["date"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertIn(item["source_label"], ("对话记录", "对话摘要", "画布档案", "长期记忆"))

    def test_empty_result_is_honest(self):
        payload = main._agent_v2_recall_search("完全无关的配音口播", scope="canvas", canvas_id=self.canvas_a)
        self.assertEqual(payload["count"], 0)
        self.assertEqual(payload["items"], [])
        self.assertIn("没有找到", payload["message"])
        self.assertIn("不要编造", payload["message"])

    def test_limit_is_clamped(self):
        self.assertEqual(len(main._agent_v2_recall_search("冷蓝色调", scope="all",
                                                          canvas_id=self.canvas_a, limit=1)["items"]), 1)
        self.assertLessEqual(len(main._agent_v2_recall_search("冷蓝色调", scope="all", canvas_id=self.canvas_a,
                                                              limit=999)["items"]), STORE.RECALL_LIMIT_MAX)

    def test_route_returns_the_same_result_shape(self):
        with memory_on():
            resp = CLIENT.get("/api/agent/recall", params={"q": "冷蓝色调", "scope": "canvas",
                                                           "canvas_id": self.canvas_a, "limit": 2})
            self.assertEqual(resp.status_code, 200, resp.text)
            body = resp.json()
            # scope_downgraded 是阶段二收口新增的：跨画布检索被这张画布的开关关掉时，
            # scope=all 会降级成 canvas，并在返回里如实标出来（不再允许悄悄跨画布）
            self.assertEqual(sorted(body), ["canvas_id", "count", "items", "limit", "message",
                                            "query", "scope", "scope_downgraded", "thread_id"])
            self.assertEqual(body["limit"], 2)
            self.assertGreater(body["count"], 0)
            self.assertIn("卖货画布 A", body["items"][0]["origin"])
            self.assertLessEqual(len(body["items"][0]["snippet"]), STORE.SNIPPET_MAX)

    def test_tool_validate_and_run_roundtrip(self):
        with memory_on():
            args = main._agent_v2_recall_validate({"query": "冷蓝色调", "scope": "canvas",
                                                   "canvas_id": self.canvas_a, "limit": 3})
            payload = main._agent_v2_recall_run(args)
            self.assertGreater(payload["count"], 0)
            self.assertLessEqual(payload["count"], 3)


class RecallIndexScopeSafetyTests(unittest.TestCase):
    def setUp(self):
        clear_index()
        self.canvas_id = new_canvas("权限画布")
        self.other = new_canvas("别人的画布")
        seed([STORE.make_entry("message", "冷蓝色调海报", canvas_id=self.other,
                               canvas_title="别人的画布", thread_id="tx", thread_title="x", ts=1700000000)])

    def tearDown(self):
        clear_index()

    def test_scope_all_only_returns_viewable_canvases(self):
        """scope=all 只返回调用者有 view 权限的画布（这里没有 ACL，等价于都可见，但过滤逻辑要生效）。"""
        with memory_on():
            resp = CLIENT.get("/api/agent/recall", params={"q": "冷蓝色调", "scope": "all",
                                                           "canvas_id": self.canvas_id})
            self.assertEqual(resp.status_code, 200, resp.text)
            canvas_ids = {item["canvas_id"] for item in resp.json()["items"]}
            self.assertIn(self.other, canvas_ids, "无 ACL 时应能跨画布检索")
            payload = main._agent_v2_recall_search("冷蓝色调", scope="all", canvas_id=self.canvas_id,
                                                   allowed_canvases=[self.canvas_id])
            self.assertEqual([item for item in payload["items"] if item["canvas_id"] == self.other], [],
                             "allowed_canvases 之外的一律不返回")




class RecallBackgroundThreadResolutionTests(unittest.TestCase):
    """run 请求没带 thread_id 时，后台索引 / 摘要 / 档案要自己解析到 active 线程，不能整条静默不跑。"""

    SUMMARY = ("【目标】做冷蓝色调海报\n【已定决策】3:4 竖版\n【已完成】无\n【涉及节点】无\n"
               "【未决事项】无\n【用户纠正】无")

    def setUp(self):
        clear_index()
        self.canvas_id = new_canvas("无 thread_id 画布")

    def tearDown(self):
        clear_index()

    def _seed_messages(self, canvas_id, count=6, prefix="冷蓝色调海报"):
        for index in range(count):
            main.agent_thread_append(canvas_id, [{
                "role": "user" if index % 2 == 0 else "assistant",
                "text": "第 %d 条：%s" % (index + 1, prefix),
            }])

    def _run_update(self, canvas_id, thread_id):
        async def fake_chat(chat, messages):
            return self.SUMMARY

        original = main._agent_run_chat
        main._agent_run_chat = fake_chat
        try:
            asyncio.run(main._agent_v2_memory_update(canvas_id, thread_id, {"model": "fake"}))
        finally:
            main._agent_run_chat = original

    def test_update_without_thread_id_writes_index_and_summary(self):
        with memory_on():
            self._seed_messages(self.canvas_id, 6)
            active = main._agent_v2_active_thread_id(self.canvas_id)
            self.assertTrue(active, "对话记录写进去后会有一条 active 线程")
            self._run_update(self.canvas_id, "")
            entries = index_entries()
            messages = [row for row in entries if row["source"] == "message" and row["thread_id"] == active]
            summaries = [row for row in entries
                         if row["source"] == "thread_summary" and row["thread_id"] == active]
            self.assertEqual(len(messages), 6, "不带 thread_id 也要把消息索引写出来")
            self.assertEqual(len(summaries), 1, "摘要条件满足时也要写摘要")
            self.assertTrue([row for row in entries if row["source"] == "canvas_profile"], "档案也要写")
            thread = main._agent_thread_find(main._agent_thread_doc_load(self.canvas_id), active)
            self.assertEqual(main._agent_memory_store.summary_state(thread)[1], 6)

    def test_schedule_resolves_active_thread_before_spawning(self):
        with memory_on():
            self._seed_messages(self.canvas_id, 2)
            active = main._agent_v2_active_thread_id(self.canvas_id)
            seen = {}
            original = main._agent_v2_memory_update

            async def fake_update(canvas_id, thread_id, chat):
                seen["canvas_id"], seen["thread_id"] = canvas_id, thread_id

            main._agent_v2_memory_update = fake_update
            try:
                async def go():
                    main._agent_v2_memory_schedule(self.canvas_id, "", {"model": "fake"})
                    await asyncio.sleep(0.05)
                asyncio.run(go())
            finally:
                main._agent_v2_memory_update = original
            self.assertEqual(seen.get("canvas_id"), self.canvas_id)
            self.assertEqual(seen.get("thread_id"), active,
                             "thread_id 为空时排后台任务前先解析成 active 线程")

    def test_schedule_gives_up_only_when_no_thread_exists(self):
        with memory_on():
            path = main._agent_thread_path(self.canvas_id)
            if os.path.exists(path):
                os.remove(path)
            self.assertEqual(main._agent_v2_active_thread_id(self.canvas_id), "")
            before = len(main._AGENT_V2_MEMORY_TASKS)
            main._agent_v2_memory_schedule(self.canvas_id, "", {"model": "fake"})
            self.assertEqual(len(main._AGENT_V2_MEMORY_TASKS), before, "解析不到线程就不排任务")
            self.assertEqual(index_entries(), [])

    def test_explicit_thread_id_wins_over_active(self):
        with memory_on():
            self._seed_messages(self.canvas_id, 2, prefix="第一条对话")
            first = main._agent_v2_active_thread_id(self.canvas_id)
            second = main._agent_thread_new_thread("第二条对话")
            doc = main._agent_thread_doc_load(self.canvas_id)
            doc["threads"].append(second)
            doc["active_id"] = second["id"]
            main._agent_thread_doc_save(self.canvas_id, doc)
            self._run_update(self.canvas_id, first)
            entries = index_entries()
            self.assertTrue([row for row in entries if row["thread_id"] == first])
            self.assertEqual([row for row in entries if row["thread_id"] == second["id"]], [],
                             "显式指定的线程优先，不能写到 active 上去")
            self.assertEqual(main._agent_v2_memory_target_thread(self.canvas_id, first), first)
            self.assertEqual(main._agent_v2_memory_target_thread(self.canvas_id, ""), second["id"])


if __name__ == "__main__":
    unittest.main()
