# -*- coding: utf-8 -*-
"""C1 / C2 / C7：自检的分阶段、数量约束、验收标准待核对。

C1：分阶段流程只核对「本次运行应该完成的阶段」，后续阶段不算未完成；打回文字不要求继续后续阶段。
C2：数量只在紧跟「做/出/生成/要/来」时才算要求；排除「第 N 张 / 参考这 N 张 / N 个方案」；批量节点按表格行数。
C7：acceptance 没真正核对时标「待核对」（status=pending），不计入 passed、不冒充已通过。
"""
import json
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-agent-fix3-selfcheck-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from tests.test_agent_reflect import executed_ok, new_canvas, run_producer  # noqa: E402


def temp_data_dir():
    root = os.path.realpath(os.path.dirname(str(main.DATA_DIR)))
    candidates = {"/tmp", "/private/tmp", os.path.realpath(tempfile.gettempdir())}
    return any(root == item or root.startswith(item + os.sep) for item in candidates)


FOUR_STAGES = [
    {"stage": "策划", "detail": "写分镜", "generations": 0, "acceptance": "分镜写完整"},
    {"stage": "镜头视频", "detail": "5 个镜头", "generations": 5, "acceptance": "5 个镜头都生成成功"},
    {"stage": "配音", "detail": "5 段口播", "generations": 5, "acceptance": "5 段配音都对上"},
    {"stage": "成片", "detail": "导出", "generations": 1, "acceptance": "成片总时长约 30 秒"},
]


class RoadmapScopeTests(unittest.TestCase):
    """C1：只检查本次运行应该完成的阶段。"""

    def test_first_stage_only_does_not_fail_outstanding_later_stages(self):
        history = [{"tool": "create_node", "ok": True, "args": {"node_id": "t1"}}]
        items = main._agent_self_check_roadmap_items(FOUR_STAGES, history, [])
        stage_items = [item for item in items if item["text"].startswith("阶段")]
        self.assertTrue(stage_items)
        text = "\n".join(item["text"] for item in items)
        self.assertIn("策划", text)
        self.assertNotIn("镜头视频", text, "后续阶段还没轮到，不能算未完成")
        self.assertNotIn("配音", text)
        self.assertNotIn("成片", text)
        self.assertTrue(all(item["ok"] for item in items if item.get("status") != "pending"), items)
        check = main._agent_run_self_check("做一条 30 秒卖货片", history, [], {"nodes": []},
                                           FOUR_STAGES, "第一阶段的策划做好了", [])
        self.assertTrue(check["passed"], check)

    def test_second_stage_nodes_waiting_for_user_execution_does_not_bounce(self):
        history = [{"tool": "create_node", "ok": True, "args": {"node_id": "t1"}},
                   {"tool": "create_node", "ok": True, "args": {"node_id": "v1"}},
                   {"tool": "create_node", "ok": True, "args": {"node_id": "v2"}},
                   {"tool": "create_node", "ok": True, "args": {"node_id": "v3"}},
                   {"tool": "create_node", "ok": True, "args": {"node_id": "v4"}},
                   {"tool": "create_node", "ok": True, "args": {"node_id": "v5"}}]
        check = main._agent_run_self_check("做一条 30 秒卖货片", history, [], {"nodes": []},
                                           FOUR_STAGES, "5 个镜头节点建好了，等用户点执行生成", [])
        self.assertTrue(check["passed"], check)
        text = "\n".join(item["text"] for item in check["items"])
        self.assertNotIn("配音", text, "第二阶段等用户执行时，后续阶段不能出现在核对项里")
        self.assertNotIn("成片", text)

    def test_bounce_text_never_asks_for_later_stages(self):
        # 第一阶段自己的生成预算没完成 → 会打回；打回文字只能提第一阶段，不能要求继续后续阶段
        roadmap = [{"stage": "镜头视频", "generations": 5, "acceptance": "5 个镜头成功"},
                   {"stage": "配音", "generations": 5},
                   {"stage": "成片", "generations": 1}]
        history = [{"tool": "generate_image", "ok": True, "args": {}}]
        check = main._agent_run_self_check("做视频", history, [], {"nodes": []}, roadmap, "做完了", [])
        self.assertFalse(check["passed"], check)
        bounce = main._agent_self_check_bounce_text(check)
        self.assertIn("镜头视频", bounce)
        self.assertNotIn("配音", bounce)
        self.assertNotIn("成片", bounce)

    def test_producer_self_check_passes_after_first_stage(self):
        if not temp_data_dir():
            self.skipTest("DATA_DIR 不是临时目录，跳过写盘用例")
        canvas_id = new_canvas("c1-scope")
        decisions = [
            {"thought": "先策划", "roadmap": FOUR_STAGES,
             "steps": [{"tool": "get_canvas", "args": {"canvas_id": canvas_id}}]},
            {"done": True, "message": "第一阶段的策划已经写好了"},
        ]
        out = run_producer(canvas_id, decisions, executed_ok,
                           extra_env={"NOVAI_AGENT_V2_SELF_CHECK": "1"})
        checks = [item["data"] for item in out["events"] if item["event"] == "self_check"]
        self.assertEqual(len(checks), 1, checks)
        self.assertTrue(checks[0]["passed"], checks[0])
        self.assertEqual(len(out["messages"]), 2, "通过自检就不该打回")


class CountConstraintTests(unittest.TestCase):
    """C2：只有紧跟动词的数量才算要求；排除「第 N / 参考这 N / N 个方案」；批量按表格行数。"""

    def _counts(self, instruction):
        parsed = main._agent_instruction_constraints(instruction)
        return parsed["counts"]

    def test_reference_images_are_not_a_quantity_requirement(self):
        self.assertEqual(self._counts("参考这2张图做1张海报"), [{"count": 1, "unit": "张"}])

    def test_ordinal_is_not_a_quantity_requirement(self):
        self.assertEqual(self._counts("第3张重新生成"), [])

    def test_number_of_options_is_not_a_quantity_requirement(self):
        self.assertEqual(self._counts("给我3个方案我挑一个再出图"), [])

    def test_each_of_three_reference_images_is_not_three(self):
        instruction = "用这3张白底图各出1张场景图"
        self.assertEqual(self._counts(instruction), [{"count": 1, "unit": "张"}])
        snapshot = {"nodes": [
            {"id": "n1", "kind": "image", "data": {"gen": {"params": {"ratio": "1:1"}}}},
            {"id": "n2", "kind": "image", "data": {"gen": {"params": {"ratio": "1:1"}}}},
            {"id": "n3", "kind": "image", "data": {"gen": {"params": {"ratio": "1:1"}}}},
        ]}
        items = main._agent_self_check_constraint_items(instruction, snapshot, ["n1", "n2", "n3"])
        count_items = [item for item in items if item["text"].startswith("数量")]
        self.assertTrue(count_items)
        self.assertTrue(all(item["ok"] for item in count_items), count_items)

    def test_plain_verb_count_still_strict(self):
        self.assertEqual(self._counts("做3张图"), [{"count": 3, "unit": "张"}])
        snapshot = {"nodes": [{"id": "n1", "kind": "image", "data": {"gen": {"params": {}}}}]}
        items = main._agent_self_check_constraint_items("做3张图", snapshot, ["n1"])
        count_item = next(item for item in items if item["text"].startswith("数量"))
        self.assertFalse(count_item["ok"])

    def test_batch_node_counts_table_rows(self):
        instruction = "用表格批量出6张图"
        self.assertEqual(self._counts(instruction), [{"count": 6, "unit": "张"}])
        table_rows = [["场景 %d" % index, "产品"] for index in range(6)]
        snapshot = {"id": "c1", "nodes": [
            {"id": "t1", "type": "smart-table", "table": {"columns": ["提示词", "产品"], "rows": table_rows}},
            {"id": "b1", "type": "smart-batch", "kind": "batch", "media": "image",
             "inputNodeIds": ["t1"]},
        ], "connections": [{"id": "e1", "from": "t1", "to": "b1", "kind": "input"}]}
        items = main._agent_self_check_constraint_items(instruction, snapshot, ["b1"])
        count_item = next(item for item in items if item["text"].startswith("数量"))
        self.assertTrue(count_item["ok"], count_item)
        self.assertIn("表格 6 行", count_item["text"])

    def test_beat_batch_node_counts_upstream_table_rows_without_kind(self):
        # F1：BEAT 连线只有 id/from/to（没有 kind），6 行表格连到 1 个图片节点也要算 6 个
        instruction = "用表格批量出6张图"
        self.assertEqual(self._counts(instruction), [{"count": 6, "unit": "张"}])
        table_rows = [["场景 %d" % index, "产品"] for index in range(6)]
        snapshot = {"id": "c-beat", "nodes": [
            {"id": "t1", "kind": "table", "data": {"table": {"columns": ["提示词", "产品"],
                                                             "rows": table_rows}}},
            {"id": "i1", "kind": "image", "data": {"gen": {"params": {}}}},
        ], "connections": [{"id": "e1", "from": "t1", "to": "i1"}]}
        self.assertTrue(main._agent_is_beat_canvas(snapshot), "用例本身要按 BEAT 画布识别")
        items = main._agent_self_check_constraint_items(instruction, snapshot, ["i1"])
        count_item = next(item for item in items if item["text"].startswith("数量"))
        self.assertTrue(count_item["ok"], count_item)
        self.assertTrue("实际 6 个" in count_item["text"] or "表格 6 行" in count_item["text"],
                        count_item["text"])

    def test_classic_canvas_still_requires_input_edges(self):
        # 经典画布行为不变：只有 kind=input 的上游边才算（flow 边不算表格来源）
        instruction = "用表格批量出6张图"
        table_rows = [["场景 %d" % index] for index in range(6)]
        snapshot = {"id": "c-classic", "nodes": [
            {"id": "t1", "type": "smart-table", "table": {"columns": ["提示词"], "rows": table_rows}},
            {"id": "b1", "type": "smart-batch", "kind": "batch", "media": "image",
             "inputNodeIds": ["t1"]},
        ], "connections": [{"id": "e1", "from": "t1", "to": "b1", "kind": "flow"}]}
        self.assertFalse(main._agent_is_beat_canvas(snapshot))
        items = main._agent_self_check_constraint_items(instruction, snapshot, ["b1"])
        count_item = next(item for item in items if item["text"].startswith("数量"))
        self.assertFalse(count_item["ok"], count_item)


class AcceptancePendingTests(unittest.TestCase):
    """C7：验收标准没有真正核对 → 待核对，不算通过。"""

    def test_acceptance_is_pending_even_after_five_tool_calls(self):
        roadmap = [{"stage": "出图", "generations": 5,
                    "acceptance": "5 张图都生成成功且产品外观一致"}]
        history = [{"tool": "generate_image", "ok": True, "args": {"node_id": "n%d" % index}}
                   for index in range(5)]
        items = main._agent_self_check_roadmap_items(roadmap, history, [])
        acceptance = [item for item in items if "验收标准" in item["text"]]
        self.assertTrue(acceptance)
        self.assertEqual(acceptance[0]["status"], "pending")
        self.assertFalse(acceptance[0]["ok"], "工具调用次数不能冒充验收结果")
        self.assertIn("待核对", acceptance[0]["text"])
        stage_item = next(item for item in items if item["text"].startswith("阶段"))
        self.assertTrue(stage_item["ok"], "阶段执行记录本身可以是通过的")
        snapshot = {"nodes": [{"id": "n%d" % index, "kind": "image",
                               "data": {"gen": {"params": {"ratio": "1:1"}}}}
                              for index in range(5)]}
        check = main._agent_run_self_check("做 5 张图", history, [], snapshot, roadmap,
                                           "5 张图都生成好了", [])
        self.assertTrue(check["passed"], "待核对项不计入 passed")


if __name__ == "__main__":
    unittest.main()
