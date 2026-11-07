#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""技能面板分类 / 导入的数据契约（本轮修复）：

- skill_type 真算：内置技能 = system，用户导入的 = mine（没有订阅数据源，不造 subscribe）；
  2026-11 起内置技能全部下线（RETIRED_SKILL_IDS），老数据目录里的种子副本读的时候跳过；
- usage_count 来自真实运行记录 data/agent_runs/*.json，不是写死的 0；
- 导入技能要真落盘到 data/skills/{id}.json，并拒绝非法 id / 覆盖内置技能 / 缺字段。

全程用独立临时数据目录，不碰项目 data/skills、data/agent_runs。
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.agents import catalog, store  # noqa: E402
from server.skills import registry  # noqa: E402


class SkillPanelFieldsTest(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-skill-panel-")
        registry.set_data_dir(self.root)
        store.set_data_dir(self.root)

    def tearDown(self):
        registry.set_data_dir("")
        store.set_data_dir("")
        shutil.rmtree(self.root, ignore_errors=True)

    def skills(self):
        return [c for c in catalog.list_capabilities() if c["kind"] == "skill"]

    def system_pack_skills(self):
        """随安装包分发的系统技能包（skill_type=system + builtin_pack）是合法内置技能，不算种子副本。"""
        return [s for s in self.skills() if s.get("skill_type") == "system" and s.get("builtin_pack")]

    def test_builtin_skills_retired(self):
        # 2026-11：旧的内置技能（builtin_skills.json）全部下线；随包分发的系统技能包照常存在。
        # 空数据目录里只会有技能包自己写进去的定义，没有旧内置技能的种子副本。
        packs = self.system_pack_skills()
        self.assertEqual([s for s in self.skills() if s not in packs], [])
        files = {name[:-5] for name in os.listdir(os.path.join(self.root, "skills")) if name.endswith(".json")}
        self.assertEqual(files, {s["id"] for s in packs})

    def test_retired_seed_copies_are_ignored(self):
        # 老安装的数据目录里还留着当年的种子副本：读的时候要跳过，不能以「我的技能」回来
        folder = os.path.join(self.root, "skills")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "voice-lipsync.json"), "w", encoding="utf-8") as handle:
            json.dump({"id": "voice-lipsync", "name": "原声改台词与对口型"}, handle, ensure_ascii=False)
        self.assertNotIn("voice-lipsync", [s["id"] for s in self.skills()])
        self.assertIsNone(registry.get_skill("voice-lipsync"))

    def test_imported_skill_is_mine_and_persisted(self):
        _skill, created = registry.import_skill({"id": "my-skill", "name": "我的技能"})
        self.assertTrue(created)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "skills", "my-skill.json")))
        self.assertEqual([s["id"] for s in self.skills() if s["skill_type"] == "mine"], ["my-skill"])
        # 再导同一个 id 是更新，不是新增
        _again, created2 = registry.import_skill({"id": "my-skill", "name": "改过的技能"})
        self.assertFalse(created2)
        self.assertEqual(registry.get_skill("my-skill")["name"], "改过的技能")

    def test_import_rejects_unsafe_input(self):
        for raw in ("not-a-dict",
                    {"name": "缺 id"},
                    {"id": "ok-id"},
                    {"id": "../evil", "name": "x"},
                    {"id": "advantage-money", "name": "x"}):
            with self.assertRaises(ValueError):
                registry.import_skill(raw)

    def test_usage_count_comes_from_run_records(self):
        os.makedirs(store.runs_dir(), exist_ok=True)
        registry.import_skill({"id": "my-skill", "name": "我的技能"})
        registry.import_skill({"id": "other-skill", "name": "另一个技能"})
        records = [
            {"run_id": "r1", "capability_id": "my-skill"},
            {"run_id": "r2", "capability_id": "my-skill"},
            {"run_id": "r3", "agent_id": "my-skill"},
            {"run_id": "r4"},  # 没有能力 id 的记录不计
        ]
        for index, record in enumerate(records):
            with open(os.path.join(store.runs_dir(), "run%d.json" % index), "w", encoding="utf-8") as handle:
                json.dump(record, handle)
        self.assertEqual(store.usage_counts().get("my-skill"), 3)
        usage = {s["id"]: s["usage_count"] for s in self.skills()}
        self.assertEqual(usage["my-skill"], 3)
        self.assertEqual(usage["other-skill"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
