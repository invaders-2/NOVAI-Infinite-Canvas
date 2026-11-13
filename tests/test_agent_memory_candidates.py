# -*- coding: utf-8 -*-
"""阶段二·3 记忆候选：摘要顺带提炼 → 线程文档 pending → 用户勾选才写长期记忆。

真实 main + 临时数据目录；模型用假 chat（返回固定摘要，含【记忆候选】段），不起服务、不联网。
开关在进程内切换（_agent_v2_flag 每次读环境变量），退出还原，不影响其它测试文件。
"""
import asyncio
import contextlib
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

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-agent-candidates-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

STORE = main._agent_memory_store
CLIENT = TestClient(main.app)

CANDIDATES = ("视频一律 9:16 竖版｜global｜用户说以后都这样\n"
              "口播每秒 4 个字｜canvas｜用户在分镜里定的")


def full_summary(candidates=CANDIDATES):
    return ("【目标】做 30 秒卖货短视频\n【已定决策】9:16 竖版；冷蓝色调\n【已完成】分镜拆解\n"
            "【涉及节点】分镜稿\n【未决事项】还没配音\n【用户纠正】无\n【记忆候选】" + candidates)


@contextlib.contextmanager
def memory_on():
    old = os.environ.get("NOVAI_AGENT_V2_MEMORY")
    os.environ["NOVAI_AGENT_V2_MEMORY"] = "1"
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("NOVAI_AGENT_V2_MEMORY", None)
        else:
            os.environ["NOVAI_AGENT_V2_MEMORY"] = old


def new_canvas(title="候选画布"):
    resp = CLIENT.post("/api/canvases", json={"title": title, "kind": "smart"})
    assert resp.status_code == 200, resp.text
    return resp.json()["canvas"]["id"]


def seed_thread(canvas_id, count=6):
    for index in range(count):
        main.agent_thread_append(canvas_id, [{
            "role": "user" if index % 2 == 0 else "assistant",
            "text": "第 %d 条：做卖货短视频" % (index + 1),
        }])
    return main._agent_v2_active_thread_id(canvas_id)


def clear_memory(canvas_id):
    """只清掉本文件写进去的东西（每个测试用独立画布，画布记忆文件直接删；全局只删候选写入的）。"""
    try:
        os.remove(main._agent_memory_path(canvas_id, "canvas"))
    except FileNotFoundError:
        pass
    for item in main.agent_memory_load(canvas_id, "global"):
        if str(item.get("source") or "") == "memory_candidate":
            main.agent_memory_remove(canvas_id, "global", item_id=item.get("id"))


def run_update(canvas_id, thread_id, candidates=CANDIDATES, counter=None):
    async def fake_chat(chat, messages):
        if counter is not None:
            counter.append(1)
        return full_summary(candidates)

    original = main._agent_run_chat
    main._agent_run_chat = fake_chat
    try:
        asyncio.run(main._agent_v2_memory_update(canvas_id, thread_id, {"model": "fake"}))
    finally:
        main._agent_run_chat = original


class CandidateGateTests(unittest.TestCase):
    def test_routes_400_when_switch_off(self):
        canvas_id = new_canvas("开关关闭画布")
        for method, path, payload in (
                ("get", "/api/agent/memory/candidates", None),
                ("post", "/api/agent/memory/confirm", {"canvas_id": canvas_id, "ids": ["cand_x"]}),
                ("post", "/api/agent/memory/candidates/dismiss", {"canvas_id": canvas_id, "ids": ["cand_x"]})):
            fn = getattr(CLIENT, method)
            resp = fn(path, params={"canvas_id": canvas_id}) if payload is None else fn(path, json=payload)
            self.assertEqual(resp.status_code, 400, "%s %s 要 400" % (method, path))
            self.assertIn("NOVAI_AGENT_V2_MEMORY", resp.json()["detail"])

    def test_canvas_id_and_ids_are_required_when_on(self):
        canvas_id = new_canvas("参数画布")
        with memory_on():
            self.assertEqual(CLIENT.get("/api/agent/memory/candidates").status_code, 400)
            self.assertEqual(CLIENT.post("/api/agent/memory/confirm",
                                         json={"canvas_id": canvas_id, "ids": []}).status_code, 400)
            self.assertEqual(CLIENT.post("/api/agent/memory/candidates/dismiss",
                                         json={"canvas_id": canvas_id, "ids": []}).status_code, 400)
            self.assertEqual(CLIENT.post("/api/agent/memory/confirm",
                                         json={"canvas_id": "", "ids": ["cand_x"]}).status_code, 400)


class CandidateFlowTests(unittest.TestCase):
    def setUp(self):
        self.canvas_id = new_canvas("候选流程画布")
        self.thread_id = seed_thread(self.canvas_id)
        clear_memory(self.canvas_id)

    def tearDown(self):
        clear_memory(self.canvas_id)

    def _candidates(self):
        with memory_on():
            return CLIENT.get("/api/agent/memory/candidates",
                              params={"canvas_id": self.canvas_id, "thread_id": self.thread_id}).json()

    def _thread_doc_candidates(self):
        thread = main._agent_thread_find(main._agent_thread_doc_load(self.canvas_id), self.thread_id)
        return thread.get("memory_candidates") or []

    def test_summary_candidates_land_in_thread_doc_only(self):
        with memory_on():
            run_update(self.canvas_id, self.thread_id)
            rows = self._thread_doc_candidates()
            self.assertEqual([row["text"] for row in rows], ["视频一律 9:16 竖版", "口播每秒 4 个字"])
            self.assertEqual([row["scope"] for row in rows], ["global", "canvas"])
            self.assertEqual([row["status"] for row in rows], ["pending", "pending"])
            self.assertEqual(rows[0]["reason"], "用户说以后都这样")
            self.assertEqual(main.agent_memory_load(self.canvas_id, "canvas"), [], "候选不许直接写长期记忆")
            self.assertEqual(main.agent_memory_load(self.canvas_id, "global"), [])

    def test_repeated_summary_does_not_duplicate_candidates(self):
        with memory_on():
            run_update(self.canvas_id, self.thread_id)
            run_update(self.canvas_id, self.thread_id)
            self.assertEqual(len(self._thread_doc_candidates()), 2, "同一条候选重复提出不堆第二条")

    def test_get_route_returns_pending_items(self):
        with memory_on():
            run_update(self.canvas_id, self.thread_id)
            body = self._candidates()
            self.assertEqual(sorted(body), ["canvas_id", "confirmed_ids", "items", "pending", "thread_id"])
            self.assertEqual(body["pending"], 2)
            self.assertEqual(body["confirmed_ids"], [])
            self.assertEqual([item["text"] for item in body["items"]],
                             ["视频一律 9:16 竖版", "口播每秒 4 个字"])
            self.assertEqual(sorted(body["items"][0]), ["id", "reason", "scope", "text"])

    def test_confirm_writes_memory_once(self):
        with memory_on():
            run_update(self.canvas_id, self.thread_id)
            items = self._candidates()["items"]
            target = items[1]                      # canvas 范围那条
            resp = CLIENT.post("/api/agent/memory/confirm",
                               json={"canvas_id": self.canvas_id, "thread_id": self.thread_id,
                                     "ids": [target["id"]]})
            self.assertEqual(resp.status_code, 200, resp.text)
            body = resp.json()
            self.assertEqual(body["confirmed"], [target["id"]])
            self.assertEqual(len(body["memory"]), 1)
            memory = main.agent_memory_load(self.canvas_id, "canvas")
            self.assertEqual([item["text"] for item in memory], [target["text"]])
            item = memory[0]
            self.assertEqual(item["source"], "memory_candidate")
            self.assertEqual(item["type"], "preference")
            self.assertIn("hits", item)
            self.assertIn("last_used", item)

            again = CLIENT.post("/api/agent/memory/confirm",
                                json={"canvas_id": self.canvas_id, "thread_id": self.thread_id,
                                      "ids": [target["id"]]})
            self.assertEqual(again.status_code, 200)
            self.assertEqual(again.json()["memory"], [], "幂等：已经记过就不再写一条")
            self.assertIn(target["id"], again.json()["skipped"])
            self.assertEqual(len(main.agent_memory_load(self.canvas_id, "canvas")), 1)
            after = self._candidates()
            self.assertIn(target["id"], after["confirmed_ids"])
            self.assertEqual(after["pending"], 1)

    def test_global_candidate_confirm_goes_to_global_memory(self):
        with memory_on():
            run_update(self.canvas_id, self.thread_id)
            target = self._candidates()["items"][0]      # global 范围
            self.assertEqual(target["scope"], "global")
            CLIENT.post("/api/agent/memory/confirm",
                        json={"canvas_id": self.canvas_id, "thread_id": self.thread_id,
                              "ids": [target["id"]]})
            self.assertEqual([item["text"] for item in main.agent_memory_load(self.canvas_id, "global")],
                             [target["text"]])
            self.assertEqual(main.agent_memory_load(self.canvas_id, "canvas"), [])

    def test_dismiss_only_changes_status(self):
        with memory_on():
            run_update(self.canvas_id, self.thread_id)
            target = self._candidates()["items"][0]
            resp = CLIENT.post("/api/agent/memory/candidates/dismiss",
                               json={"canvas_id": self.canvas_id, "thread_id": self.thread_id,
                                     "ids": [target["id"]]})
            self.assertEqual(resp.status_code, 200, resp.text)
            self.assertEqual(resp.json()["dismissed"], [target["id"]])
            self.assertEqual(main.agent_memory_load(self.canvas_id, "canvas"), [])
            self.assertEqual(main.agent_memory_load(self.canvas_id, "global"), [])
            after = self._candidates()
            self.assertEqual([item["id"] for item in after["items"]], [self._candidates()["items"][0]["id"]])
            self.assertEqual(after["pending"], 1)
            again = CLIENT.post("/api/agent/memory/candidates/dismiss",
                                json={"canvas_id": self.canvas_id, "thread_id": self.thread_id,
                                      "ids": [target["id"]]})
            self.assertEqual(again.json()["dismissed"], [target["id"]], "重复忽略幂等，不报错")

    def test_dismissed_candidate_stays_dismissed_after_new_summary(self):
        with memory_on():
            run_update(self.canvas_id, self.thread_id)
            target = self._candidates()["items"][0]
            CLIENT.post("/api/agent/memory/candidates/dismiss",
                        json={"canvas_id": self.canvas_id, "thread_id": self.thread_id,
                              "ids": [target["id"]]})
            seed_thread(self.canvas_id, 2)
            with patch.dict(os.environ, {STORE.SUMMARY_COOLDOWN_ENV: "0"}):
                run_update(self.canvas_id, self.thread_id)
            rows = self._thread_doc_candidates()
            by_id = {row["id"]: row for row in rows}
            self.assertEqual(by_id[target["id"]]["status"], "dismissed", "忽略过的候选不会再冒出来")
            self.assertEqual(self._candidates()["pending"], 1)

    def test_single_turn_produces_candidates(self):
        """一次正常问答（用户 + 助手两条消息）结束就该产出摘要与候选，不用手工补历史。"""
        canvas_id = new_canvas("单轮对话画布")
        thread_id = seed_thread(canvas_id, 2)
        self.assertEqual(len(main.agent_thread_load(canvas_id, thread_id)["messages"]), 2)
        with memory_on():
            run_update(canvas_id, thread_id)
            thread = main._agent_thread_find(main._agent_thread_doc_load(canvas_id), thread_id)
            self.assertTrue(thread.get("summary"), "两条消息就该写摘要")
            self.assertEqual(thread.get("summary_upto"), 2)
            body = CLIENT.get("/api/agent/memory/candidates",
                              params={"canvas_id": canvas_id, "thread_id": thread_id}).json()
            self.assertEqual(body["pending"], 2, "单轮对话也要能出候选")

    def test_threshold_env_can_raise_the_bar(self):
        canvas_id = new_canvas("阈值画布")
        thread_id = seed_thread(canvas_id, 2)
        counter = []
        with memory_on(), patch.dict(os.environ, {STORE.SUMMARY_MIN_ENV: "6"}):
            run_update(canvas_id, thread_id, counter=counter)
            self.assertEqual(counter, [], "阈值调到 6：两条消息不触发摘要")
            body = CLIENT.get("/api/agent/memory/candidates",
                              params={"canvas_id": canvas_id, "thread_id": thread_id}).json()
            self.assertEqual(body["pending"], 0)
        counter.clear()
        with memory_on(), patch.dict(os.environ, {STORE.SUMMARY_MIN_ENV: "2"}):
            run_update(canvas_id, thread_id, counter=counter)
            self.assertEqual(len(counter), 1, "阈值调回 2：触发一次摘要")

    def test_cooldown_skips_back_to_back_summaries(self):
        """连发两次运行不该把摘要模型调用刷爆：同一线程 60s 内只调一次。"""
        canvas_id = new_canvas("冷却画布")
        thread_id = seed_thread(canvas_id, 6)
        counter = []
        with memory_on():
            run_update(canvas_id, thread_id, counter=counter)
            run_update(canvas_id, thread_id, counter=counter)
            self.assertEqual(len(counter), 1, "冷却内第二次运行不再调模型")
            thread = main._agent_thread_find(main._agent_thread_doc_load(canvas_id), thread_id)
            self.assertGreater(thread.get("summary_at") or 0, 0, "摘要时间写进线程，下次据此算冷却")
            seed_thread(canvas_id, 2)        # 再来一轮问答（2 条新消息），才有得摘要
            with patch.dict(os.environ, {STORE.SUMMARY_COOLDOWN_ENV: "0"}):
                run_update(canvas_id, thread_id, counter=counter)
            self.assertEqual(len(counter), 2, "把冷却设为 0 才能立刻再摘要")

    def test_remembered_preference_does_not_become_pending(self):
        """先 remember 再摘要：同样的内容不再出现在「要记住这些吗」里。"""
        with memory_on():
            main.agent_memory_add(self.canvas_id, "canvas", ["口播每秒 4 个字"], source="user")
            run_update(self.canvas_id, self.thread_id)
            rows = {row["text"]: row for row in self._thread_doc_candidates()}
            self.assertEqual(rows["口播每秒 4 个字"]["status"], "confirmed", "已经记住的不再待确认")
            self.assertEqual(rows["口播每秒 4 个字"].get("note"), STORE.ALREADY_REMEMBERED_NOTE)
            self.assertEqual(rows["视频一律 9:16 竖版"]["status"], "pending")
            pending = [item["text"] for item in self._candidates()["items"]]
            self.assertEqual(pending, ["视频一律 9:16 竖版"], "GET 只返回真正待确认的")
            self.assertEqual(len(main.agent_memory_load(self.canvas_id, "canvas")), 1, "不重复写记忆")

    def test_pending_candidate_becomes_confirmed_after_remember(self):
        """先出候选、用户又用 remember 记了同一条：下一次摘要要把这条 pending 收起来，卡片里不再问。"""
        with memory_on():
            run_update(self.canvas_id, self.thread_id)
            self.assertEqual(self._candidates()["pending"], 2)
            main.agent_memory_add(self.canvas_id, "canvas", ["视频一律 9:16 竖版"], source="user")
            seed_thread(self.canvas_id, 2)
            with patch.dict(os.environ, {STORE.SUMMARY_COOLDOWN_ENV: "0"}):
                run_update(self.canvas_id, self.thread_id)
            rows = {row["text"]: row for row in self._thread_doc_candidates()}
            self.assertEqual(rows["视频一律 9:16 竖版"]["status"], "confirmed")
            self.assertEqual([item["text"] for item in self._candidates()["items"]], ["口播每秒 4 个字"])

    def test_legacy_thread_without_candidates_field(self):
        canvas_id = new_canvas("旧候选画布")
        main._agent_thread_doc_save(canvas_id, {"canvas_id": canvas_id, "threads": [{
            "id": "th_legacy", "title": "老对话", "created_at": 1, "updated_at": 1,
            "messages": [{"role": "user", "text": "老消息", "at": 1}], "recent": []}],
            "active_id": "th_legacy", "updated_at": 1})
        with memory_on():
            body = CLIENT.get("/api/agent/memory/candidates", params={"canvas_id": canvas_id}).json()
            self.assertEqual((body["items"], body["confirmed_ids"], body["pending"]), ([], [], 0))
            resp = CLIENT.post("/api/agent/memory/confirm",
                               json={"canvas_id": canvas_id, "thread_id": "th_legacy", "ids": ["cand_x"]})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["skipped"], ["cand_x"])
            self.assertEqual(resp.json()["memory"], [])

    def test_thread_deleted_before_confirm_reports_404(self):
        with memory_on():
            resp = CLIENT.post("/api/agent/memory/confirm",
                               json={"canvas_id": self.canvas_id, "thread_id": "th_gone", "ids": ["cand_x"]})
            self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main()
