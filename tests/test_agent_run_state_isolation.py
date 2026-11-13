# -*- coding: utf-8 -*-
"""E1：运行状态与技能运行记录隔离（data/agent_run_states/ vs data/agent_runs/）+ 旧状态迁移。

覆盖：
  (a) RUNSTATE=1 跑 FilesRunContext 技能运行，技能记录 data/agent_runs/{run_id}.json 与 RUNSTATE=0 逐字段一致，
      status 仍是技能记录自己的取值；
  (b) list_states 不含任何带 agent_id / capability_id 的记录；
  (c) 画布运行前后 server.agents.store.usage_counts() 不变；
  (d) 迁移只搬状态文件、不碰技能记录与 .jsonl，重复执行幂等。
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
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_OWN_TMP = ""
_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-runstate-isolation-")
    _OWN_TMP = _TMP
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from server.agent_core import run_state  # noqa: E402
from server.agents import store as agent_store  # noqa: E402
from server.agents.context import FilesRunContext  # noqa: E402
from tests.test_agent_reflect import new_canvas  # noqa: E402
from tests.test_agent_run_state import (  # noqa: E402
    make_req, run_with_patches, stop_patches)


def tearDownModule():
    if _OWN_TMP:
        shutil.rmtree(_OWN_TMP, ignore_errors=True)


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


def fake_chat():
    return {"provider": "p", "base": "http://example.invalid/v1", "headers": {},
            "model": "isolation-model", "provider_cfg": {"protocol": "custom"}, "think_level": ""}


def files_req(run):
    ctx = FilesRunContext(run, {"id": "artifact-agent", "name": "测试产物技能",
                                "skill_prompt": "生成一份 HTML 报告。"}, [], {})
    return {
        "context": ctx,
        "canvas_id": "",
        "run_id": run["run_id"],
        "instruction": "出一份报告",
        "focus": main._agent_run_normalize_focus(None),
        "history": [],
        "chat": fake_chat(),
        "max_steps": 4,
        "mode": "run",
        "approved_steps": [],
    }


def run_files_agent(runstate_on):
    """真实 FilesRunContext + 真写文件，只打桩模型决策。返回 (run 记录, 磁盘上的技能记录)。"""
    run = agent_store.create_run("artifact-agent", agent_store.new_session_id(), files=[], params={},
                                 provider="p", model="m")
    req = files_req(run)
    decisions = [
        {"thought": "先写报告",
         "steps": [{"tool": "write_html_report",
                    "args": {"title": "产物测试报告",
                             "sections": [{"title": "结论", "body": "这是测试结论"}]}}]},
        {"done": True, "message": "报告已生成"},
    ]

    async def fake_decide(*args, **kwargs):
        return decisions.pop(0) if decisions else {"done": True, "message": "完成"}

    env = {key: value for key, value in os.environ.items() if not key.startswith("NOVAI_AGENT_V2")}
    env["NOVAI_AGENT_V2_RUNSTATE"] = "1" if runstate_on else "0"
    with patch.dict(os.environ, env, clear=True), \
            patch.object(main, "_agent_run_decide", new=AsyncMock(side_effect=fake_decide)):
        with contextlib.redirect_stdout(io.StringIO()):
            asyncio.run(main._agent_run_producer(req, None))
    return run, agent_store.load_run(run["run_id"])


def normalize_record(record, run_id, session_id):
    text = json.dumps(record or {}, ensure_ascii=False, sort_keys=True, default=str)
    text = text.replace(str(run_id), "<run_id>").replace(str(session_id), "<session_id>")
    data = json.loads(text)
    for key in ("created_at", "updated_at"):
        data.pop(key, None)
    return data


class FilesRunIsolationTests(unittest.TestCase):
    def test_files_run_record_identical_with_and_without_runstate(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        run_off, record_off = run_files_agent(False)
        run_on, record_on = run_files_agent(True)
        self.assertTrue(record_on, "技能运行记录不能丢")
        self.assertEqual(record_on.get("agent_id"), "artifact-agent")
        self.assertEqual(record_on.get("status"), "ok", "status 必须是技能记录自己的取值")
        self.assertEqual(record_on.get("capability_id"), "artifact-agent")
        self.assertEqual(
            normalize_record(record_on, run_on["run_id"], run_on["session_id"]),
            normalize_record(record_off, run_off["run_id"], run_off["session_id"]),
            "RUNSTATE=1 不能改写技能运行记录的任何字段")
        # 运行状态绝不能落到技能记录目录
        self.assertFalse(os.path.exists(main._agent_run_state_path(run_on["run_id"])))
        self.assertFalse(os.path.exists(os.path.join(main.DATA_DIR, "agent_run_states",
                                                     run_on["run_id"] + ".json")),
                         "文件上下文（技能运行）不该写运行状态文件")


class ListStatesIsolationTests(unittest.TestCase):
    def test_list_states_skips_skill_records(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        run = agent_store.create_run("artifact-agent", agent_store.new_session_id(), files=[], params={})
        state_run_id = "run_iso_" + uuid.uuid4().hex[:8]
        main._agent_run_state_write(state_run_id, {"run_id": state_run_id, "canvas_id": "c_iso",
                                                   "autonomy": "collab", "status": "running"})
        try:
            states = run_state.list_states(main.DATA_DIR)
            ids = [str(item.get("run_id") or "") for item in states]
            self.assertIn(state_run_id, ids, "画布运行状态要出现在 list_states 里")
            self.assertNotIn(run["run_id"], ids, "技能运行记录不能被当成运行状态")
            for item in states:
                self.assertFalse(item.get("agent_id"), item)
                self.assertFalse(item.get("capability_id"), item)
        finally:
            os.remove(main._agent_run_state_path(state_run_id))


class CanvasRunDoesNotTouchSkillUsageTests(unittest.TestCase):
    def test_usage_counts_unchanged_across_canvas_run(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        canvas_id = new_canvas("runstate-usage")
        before = agent_store.usage_counts()
        req, bus, pending = make_req(canvas_id, [
            {"steps": [{"tool": "generate_image",
                        "args": {"canvas_id": canvas_id, "prompt": "海报"}}]},
            {"done": True, "message": "完成"}])
        messages, pending, patches = run_with_patches(
            req, bus, pending,
            wait_outcomes=[{"ok": True, "node_id": "n1", "url": "/a.png", "kind": "image",
                            "text": "图片生成成功 /a.png"}])
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(main._agent_run_producer(req, None, bus=bus))
        finally:
            stop_patches(patches)
        self.assertEqual(agent_store.usage_counts(), before,
                         "画布运行不能往 agent_runs/ 写技能使用记录")
        self.assertFalse(os.path.exists(os.path.join(main.DATA_DIR, "agent_runs",
                                                     req["run_id"] + ".json")))
        self.assertEqual(main._agent_run_state_read(req["run_id"]).get("canvas_id"), canvas_id)


class LegacyMigrationTests(unittest.TestCase):
    def setUp(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录")
        self.runs_dir = os.path.join(main.DATA_DIR, "agent_runs")
        os.makedirs(self.runs_dir, exist_ok=True)
        self.tag = uuid.uuid4().hex[:8]
        self.legacy_id = "run_legacy_" + self.tag
        self.skill_id = "run_skill_" + self.tag
        self.no_autonomy_id = "run_noauto_" + self.tag
        self.broken = os.path.join(self.runs_dir, "broken_%s.json" % self.tag)
        self.transcript = os.path.join(self.runs_dir, self.legacy_id + ".jsonl")

    def _write(self, path, payload):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(payload if isinstance(payload, str)
                         else json.dumps(payload, ensure_ascii=False))
        return path

    def _prepare(self):
        legacy = self._write(os.path.join(self.runs_dir, self.legacy_id + ".json"),
                             {"run_id": self.legacy_id, "canvas_id": "c_legacy",
                              "autonomy": "collab", "status": "waiting_generation",
                              "waiting_on": ["n1"], "updated_at": 1700000000})
        skill = self._write(os.path.join(self.runs_dir, self.skill_id + ".json"),
                            {"run_id": self.skill_id, "agent_id": "artifact-agent",
                             "capability_id": "artifact-agent", "autonomy": "collab",
                             "status": "running"})
        no_autonomy = self._write(os.path.join(self.runs_dir, self.no_autonomy_id + ".json"),
                                  {"run_id": self.no_autonomy_id, "canvas_id": "c_x",
                                   "status": "running"})
        self._write(self.broken, "{not json")
        self._write(self.transcript, '{"type": "decision"}\n')
        return legacy, skill, no_autonomy

    def tearDown(self):
        for rid in (self.legacy_id,):
            path = run_state.state_path(main.DATA_DIR, rid)
            if os.path.exists(path):
                os.remove(path)

    def test_migration_moves_only_state_files_and_is_idempotent(self):
        legacy, skill, no_autonomy = self._prepare()
        moved = run_state.migrate_legacy_states(main.DATA_DIR)
        self.assertIn(self.legacy_id, moved)
        target = run_state.state_path(main.DATA_DIR, self.legacy_id)
        self.assertTrue(os.path.exists(target), "旧状态文件要搬到 agent_run_states/")
        copied = run_state.read_state(main.DATA_DIR, self.legacy_id)
        self.assertEqual(copied.get("status"), "waiting_generation")
        self.assertEqual(copied.get("waiting_on"), ["n1"])
        # 「搬走」语义：源状态文件要删掉，agent_runs/ 只留技能记录与 .jsonl
        self.assertFalse(os.path.exists(legacy), "旧状态文件搬到新目录后要删除源文件")
        self.assertTrue(os.path.exists(skill), "技能运行记录不能被删 / 改")
        self.assertTrue(os.path.exists(no_autonomy))
        self.assertTrue(os.path.exists(self.transcript), ".jsonl 转录不能被动")
        self.assertFalse(os.path.exists(run_state.state_path(main.DATA_DIR, self.skill_id)),
                         "带 agent_id / capability_id 的技能记录不能被迁移")
        self.assertFalse(os.path.exists(run_state.state_path(main.DATA_DIR, self.no_autonomy_id)),
                         "不含 autonomy 的文件不是运行状态")
        self.assertFalse(os.path.exists(run_state.state_path(main.DATA_DIR, "broken_" + self.tag)))
        self.assertEqual(run_state.migrate_legacy_states(main.DATA_DIR), [],
                         "重复执行必须幂等")

    def test_migration_skips_existing_target(self):
        legacy = self._write(os.path.join(self.runs_dir, self.legacy_id + ".json"),
                             {"run_id": self.legacy_id, "canvas_id": "c_legacy",
                              "autonomy": "collab", "status": "waiting_generation",
                              "updated_at": 1700000000})
        target = run_state.state_path(main.DATA_DIR, self.legacy_id)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as handle:
            json.dump({"run_id": self.legacy_id, "canvas_id": "c_legacy",
                       "autonomy": "collab", "status": "finished"}, handle)
        self.assertNotIn(self.legacy_id, run_state.migrate_legacy_states(main.DATA_DIR))
        self.assertEqual(run_state.read_state(main.DATA_DIR, self.legacy_id).get("status"),
                         "finished", "目标已存在时不能被旧文件覆盖")
        self.assertFalse(os.path.exists(legacy), "目标已存在时旧文件是历史残留，也要删掉")
        self.assertEqual(run_state.migrate_legacy_states(main.DATA_DIR), [], "重复执行幂等")


if __name__ == "__main__":
    unittest.main()
