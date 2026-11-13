# -*- coding: utf-8 -*-
"""阶段二收口：按画布的三把记忆开关 + 删画布清理（真实 main + 临时数据目录）。

覆盖：开关缺省值 / 局部更新 / 自动摘要关不花模型调用 / 候选卡片关只隐藏卡片 /
跨画布检索关时 scope=all 降级并如实说明 / 软删与 purge 清理档案、开关、候选、索引条目。
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
    _TMP = tempfile.mkdtemp(prefix="novai-agent-settings-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

STORE = main._agent_memory_store
CLIENT = TestClient(main.app)

SUMMARY = ("【目标】做卖货短视频\n【已定决策】9:16 竖版\n【已完成】分镜\n【涉及节点】分镜稿\n"
           "【未决事项】无\n【用户纠正】无\n【记忆候选】视频一律 9:16 竖版｜global｜用户说以后都这样")


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


def new_canvas(title="记忆开关画布"):
    resp = CLIENT.post("/api/canvases", json={"title": title, "kind": "smart"})
    assert resp.status_code == 200, resp.text
    return resp.json()["canvas"]["id"]


def seed_thread(canvas_id, count=2):
    for index in range(count):
        main.agent_thread_append(canvas_id, [{
            "role": "user" if index % 2 == 0 else "assistant",
            "text": "第 %d 条：做卖货短视频" % (index + 1),
        }])
    return main._agent_v2_active_thread_id(canvas_id)


def run_update(canvas_id, thread_id, counter=None):
    async def fake_chat(chat, messages):
        if counter is not None:
            counter.append(1)
        return SUMMARY

    original = main._agent_run_chat
    main._agent_run_chat = fake_chat
    try:
        asyncio.run(main._agent_v2_memory_update(canvas_id, thread_id, {"model": "fake"}))
    finally:
        main._agent_run_chat = original


def clear_canvas_memory(canvas_id):
    for path in (STORE.profile_path(main.AGENT_MEMORY_DIR, canvas_id),
                 STORE.settings_path(main.AGENT_MEMORY_DIR, canvas_id)):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
    STORE.MemoryIndex(main.AGENT_MEMORY_DIR).remove_canvas(canvas_id)


def index_rows(canvas_id):
    return [row for row in STORE.MemoryIndex(main.AGENT_MEMORY_DIR).entries(fresh=True)
            if str(row.get("canvas_id") or "") == canvas_id]


class SettingsGateTests(unittest.TestCase):
    def test_routes_400_when_switch_off(self):
        canvas_id = new_canvas("开关关闭")
        self.assertEqual(CLIENT.get("/api/agent/memory/settings",
                                    params={"canvas_id": canvas_id}).status_code, 400)
        self.assertEqual(CLIENT.put("/api/agent/memory/settings", params={"canvas_id": canvas_id},
                                    json={"auto_summary": False}).status_code, 400)
        detail = CLIENT.get("/api/agent/memory/settings",
                            params={"canvas_id": canvas_id}).json()["detail"]
        self.assertIn("NOVAI_AGENT_V2_MEMORY", detail)

    def test_canvas_id_is_required(self):
        with memory_on():
            self.assertEqual(CLIENT.get("/api/agent/memory/settings").status_code, 400)
            self.assertEqual(CLIENT.put("/api/agent/memory/settings",
                                        json={"auto_summary": False}).status_code, 400)

    def test_defaults_and_partial_update(self):
        canvas_id = new_canvas("开关缺省")
        with memory_on():
            body = CLIENT.get("/api/agent/memory/settings", params={"canvas_id": canvas_id}).json()
            self.assertEqual(body["settings"], {"auto_summary": True, "candidate_cards": True,
                                                "cross_canvas_recall": True})
            self.assertEqual(body["defaults"], body["settings"])
            saved = CLIENT.put("/api/agent/memory/settings", params={"canvas_id": canvas_id},
                               json={"auto_summary": False}).json()
            self.assertFalse(saved["settings"]["auto_summary"])
            self.assertTrue(saved["settings"]["candidate_cards"], "没传的字段保持不变")
            again = CLIENT.get("/api/agent/memory/settings", params={"canvas_id": canvas_id}).json()
            self.assertEqual(again["settings"], saved["settings"])
            self.assertEqual(again["defaults"], body["defaults"], "缺省值不受单画布设置影响")

    def test_settings_are_per_canvas(self):
        first = new_canvas("画布一")
        second = new_canvas("画布二")
        with memory_on():
            CLIENT.put("/api/agent/memory/settings", params={"canvas_id": first},
                       json={"auto_summary": False})
            self.assertFalse(main._agent_v2_memory_settings(first)["auto_summary"])
            self.assertTrue(main._agent_v2_memory_settings(second)["auto_summary"],
                            "开关按画布存，不串到别的画布")


class SettingsBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.canvas_id = new_canvas("开关行为画布")
        self.thread_id = seed_thread(self.canvas_id, 2)
        clear_canvas_memory(self.canvas_id)

    def tearDown(self):
        clear_canvas_memory(self.canvas_id)

    def _set(self, **values):
        with memory_on():
            return CLIENT.put("/api/agent/memory/settings", params={"canvas_id": self.canvas_id},
                              json=values).json()

    def test_auto_summary_off_spends_no_model_call_but_still_indexes(self):
        self._set(auto_summary=False)
        counter = []
        with memory_on():
            run_update(self.canvas_id, self.thread_id, counter=counter)
            thread = main.agent_thread_load(self.canvas_id, self.thread_id)
            self.assertEqual(counter, [], "自动摘要关掉：不花模型调用")
            self.assertFalse(thread.get("summary"))
            self.assertEqual([row["source"] for row in index_rows(self.canvas_id)], ["message", "message"],
                             "消息索引照写（不花模型调用，recall 仍可用）")

    def test_candidate_cards_off_still_summarizes_but_hides_candidates(self):
        self._set(candidate_cards=False)
        counter = []
        with memory_on():
            run_update(self.canvas_id, self.thread_id, counter=counter)
            thread = main._agent_thread_find(main._agent_thread_doc_load(self.canvas_id), self.thread_id)
            self.assertEqual(len(counter), 1, "摘要照跑（对「之前做到哪」仍然有用）")
            self.assertTrue(thread.get("summary"))
            self.assertFalse(thread.get("memory_candidates"), "候选卡片关掉就不再产出候选")
            body = CLIENT.get("/api/agent/memory/candidates",
                              params={"canvas_id": self.canvas_id, "thread_id": self.thread_id}).json()
            self.assertEqual((body["items"], body["pending"]), ([], 0))

    def test_candidate_cards_back_on_after_new_turn(self):
        self._set(candidate_cards=False)
        with memory_on():
            run_update(self.canvas_id, self.thread_id)
            self._set(candidate_cards=True)
            seed_thread(self.canvas_id, 2)
            with patch.dict(os.environ, {STORE.SUMMARY_COOLDOWN_ENV: "0"}):
                run_update(self.canvas_id, self.thread_id)
            body = CLIENT.get("/api/agent/memory/candidates",
                              params={"canvas_id": self.canvas_id, "thread_id": self.thread_id}).json()
            self.assertEqual(body["pending"], 1, "重新打开候选卡片后，新一轮摘要能再出候选")

    def test_cross_canvas_off_downgrades_scope_all(self):
        token = "收口开关验证"
        other = new_canvas("另一张画布")
        STORE.MemoryIndex(main.AGENT_MEMORY_DIR).add([
            STORE.make_entry("message", token + " 海报 A", canvas_id=self.canvas_id,
                             canvas_title="开关行为画布", thread_id="ta", ts=1),
            STORE.make_entry("message", token + " 视频 B", canvas_id=other,
                             canvas_title="另一张画布", thread_id="tb", ts=2)])
        self.addCleanup(clear_canvas_memory, other)
        self._set(cross_canvas_recall=False)
        with memory_on():
            payload = main._agent_v2_recall_search(token, scope="all", canvas_id=self.canvas_id)
            self.assertEqual(payload["scope"], "canvas", "关掉跨画布后 scope=all 降级为 canvas")
            self.assertTrue(payload["scope_downgraded"])
            self.assertEqual({item["canvas_id"] for item in payload["items"]}, {self.canvas_id})
            self.assertIn("跨画布检索", payload["message"])
            route = CLIENT.get("/api/agent/recall", params={"q": token, "scope": "all",
                                                            "canvas_id": self.canvas_id}).json()
            self.assertEqual((route["scope"], route["scope_downgraded"]), ("canvas", True))
            self.assertEqual({item["canvas_id"] for item in route["items"]}, {self.canvas_id})
            tool_args = main._agent_v2_recall_validate({"query": token, "scope": "all",
                                                        "canvas_id": self.canvas_id})
            tool_payload = main._agent_v2_recall_run(tool_args)
            self.assertTrue(tool_payload["scope_downgraded"], "工具和路由同一实现，同样降级")
            self._set(cross_canvas_recall=True)
            restored = main._agent_v2_recall_search(token, scope="all", canvas_id=self.canvas_id)
            self.assertFalse(restored["scope_downgraded"])
            restored_ids = {item["canvas_id"] for item in restored["items"]}
            self.assertIn(self.canvas_id, restored_ids)
            self.assertIn(other, restored_ids, "重新打开后跨画布可见（索引里可能还有其它测试画布的条目）")


class CanvasCleanupTests(unittest.TestCase):
    def setUp(self):
        self.canvas_id = new_canvas("待删画布")
        self.thread_id = seed_thread(self.canvas_id, 2)

    def tearDown(self):
        clear_canvas_memory(self.canvas_id)

    def _seed_memory(self, canvas_id, token="独有关键词紫罗兰"):
        STORE.save_profile(main.AGENT_MEMORY_DIR, canvas_id, {"canvas_id": canvas_id, "intro": "要删的档案"})
        with memory_on():
            CLIENT.put("/api/agent/memory/settings", params={"canvas_id": canvas_id},
                       json={"auto_summary": False})
        doc = main._agent_thread_doc_load(canvas_id)
        for thread in doc.get("threads") or []:
            thread["memory_candidates"] = [{"id": "cand_x", "text": "要删的候选", "scope": "canvas",
                                            "reason": "", "status": "pending", "at": 1}]
        main._agent_thread_doc_save(canvas_id, doc)
        STORE.MemoryIndex(main.AGENT_MEMORY_DIR).add([
            STORE.make_entry("message", token, canvas_id=canvas_id, canvas_title="待删画布",
                             thread_id="t1", ts=1)])

    def _assert_cleaned(self, canvas_id, token="独有关键词紫罗兰"):
        self.assertFalse(os.path.exists(STORE.profile_path(main.AGENT_MEMORY_DIR, canvas_id)))
        self.assertFalse(os.path.exists(STORE.settings_path(main.AGENT_MEMORY_DIR, canvas_id)))
        self.assertEqual(index_rows(canvas_id), [], "索引里不能再有这张画布的条目")
        with memory_on():
            payload = main._agent_v2_recall_search(token, scope="all", canvas_id=self.canvas_id)
        self.assertEqual([item for item in payload["items"] if item["canvas_id"] == canvas_id], [],
                         "recall 搜不到已删画布的内容")

    def test_soft_delete_cleans_memory(self):
        self._seed_memory(self.canvas_id)
        self.assertTrue(os.path.exists(STORE.profile_path(main.AGENT_MEMORY_DIR, self.canvas_id)))
        resp = CLIENT.delete("/api/canvases/%s" % self.canvas_id)
        self.assertEqual(resp.status_code, 200, resp.text)
        self._assert_cleaned(self.canvas_id)
        thread = main._agent_thread_find(main._agent_thread_doc_load(self.canvas_id), self.thread_id)
        self.assertFalse(thread.get("memory_candidates"), "软删也把候选清掉")
        self.assertTrue(thread.get("messages"), "对话原文保留（回收站恢复后还能接着聊）")

    def test_purge_cleans_memory_and_index(self):
        self._seed_memory(self.canvas_id, token="另一枚独有关键词祖母绿")
        resp = CLIENT.delete("/api/canvases/%s/purge" % self.canvas_id)
        self.assertEqual(resp.status_code, 200, resp.text)
        self._assert_cleaned(self.canvas_id, token="另一枚独有关键词祖母绿")
        self.assertFalse(os.path.exists(main._agent_thread_path(self.canvas_id)), "线程文件也删掉")

    def test_delete_without_memory_files_still_works(self):
        resp = CLIENT.delete("/api/canvases/%s" % self.canvas_id)
        self.assertEqual(resp.status_code, 200, resp.text)


if __name__ == "__main__":
    unittest.main()
