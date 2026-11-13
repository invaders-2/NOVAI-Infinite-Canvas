# -*- coding: utf-8 -*-
"""画布助手 BEAT：分组 / 堆叠都要当成一个整体参考，不能被拆成单个成员。

背景（用户实测两轮）：
  1. 用户给「拍摄策划 + 风格参考图 + 一堆同产品多角度白底图（堆叠）」，让助手出 5 张大片；
     实际助手把堆叠拆开，每个生成节点只连了一张白底图。
  2. 普通分组也一样：画布支持「连分组 → 展开全部成员」，助手必须连分组节点本身。

覆盖：
  1. 快照摘要：堆叠 / 普通分组都标 group + group_kind + group_size + hint；
  2. inputs 归一：组员 → 所属分组（去重、丢无效 id），节点本身是分组时保持它自己；
  3. 嵌套：取最近的一层分组（连它才能展开成图）；
  4. generate_image 端到端：模型传组员 id / 单个成员 URL，落盘连整组；
  5. 配音节点（create_node type=audio）的 inputs 同样归一；
  6. 系统提示里含「分组 / 堆叠当整体 + 每个生成节点连同一个分组」规则。

模型与磁盘全打桩，画布数据全在内存，不写真实 data/。
"""
import copy
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-beat-stack-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def _img(nid, url):
    return {"id": nid, "kind": "image", "x": 0, "y": 0, "w": 200, "h": 200, "url": url,
            "data": {"gen": {"title": nid, "params": {}, "hist": [{"url": url}], "hi": 0}}}


def canvas():
    """stack1 = 3 张白底图堆叠；plain = 普通分组；
    nested(堆叠) ⊃ s_inner(堆叠) ⊃ p5；g_outer(分组) ⊃ g_inner(分组) ⊃ p6。"""
    return {
        "id": "c1", "kind": "classic", "title": "分组测试", "updated_at": 1700000000000,
        "nodes": [
            {"id": "stack1", "kind": "group", "x": 0, "y": 0, "w": 240, "h": 240,
             "children": ["p1", "p2", "p3"], "data": {"stack": True, "gen": {"title": "白底图堆叠"}}},
            _img("p1", "/assets/p1.png"), _img("p2", "/assets/p2.png"), _img("p3", "/assets/p3.png"),
            {"id": "plain", "kind": "group", "x": 600, "y": 0, "w": 240, "h": 240,
             "children": ["p4"], "data": {"gen": {"title": "普通分组"}}},
            _img("p4", "/assets/p4.png"),
            {"id": "nested", "kind": "group", "x": 900, "y": 0, "children": ["s_inner"],
             "data": {"stack": True, "gen": {"title": "外层堆叠"}}},
            {"id": "s_inner", "kind": "group", "x": 900, "y": 0, "children": ["p5"],
             "data": {"stack": True, "gen": {"title": "内层堆叠"}}},
            _img("p5", "/assets/p5.png"),
            {"id": "g_outer", "kind": "group", "x": 1200, "y": 0, "children": ["g_inner"],
             "data": {"gen": {"title": "外层分组"}}},
            {"id": "g_inner", "kind": "group", "x": 1200, "y": 0, "children": ["p6"],
             "data": {"gen": {"title": "内层分组"}}},
            _img("p6", "/assets/p6.png"),
        ],
        "connections": [],
    }


def by_id(cv, nid):
    return next(n for n in cv["nodes"] if n["id"] == nid)


class GroupSummaryTests(unittest.TestCase):
    def test_stack_group_is_marked(self):
        cv = canvas()
        summary = main._agent_beat_node_summary(by_id(cv, "stack1"), cv)
        self.assertEqual(summary["children"], ["p1", "p2", "p3"])
        self.assertIs(summary["group"], True)
        self.assertEqual(summary["group_kind"], "stack")
        self.assertEqual(summary["group_size"], 3)
        self.assertIs(summary["stack"], True)
        self.assertEqual(summary["stack_size"], 3)
        self.assertIn("堆叠", summary["hint"])
        self.assertIn("整体参考", summary["hint"])
        self.assertIn("不要连里面的单个成员", summary["hint"])

    def test_plain_group_is_marked_too(self):
        cv = canvas()
        summary = main._agent_beat_node_summary(by_id(cv, "plain"), cv)
        self.assertIs(summary["group"], True)
        self.assertEqual(summary["group_kind"], "group")
        self.assertEqual(summary["group_size"], 1)
        self.assertNotIn("stack", summary)
        self.assertIn("分组", summary["hint"])
        self.assertIn("不要拆成组员", summary["hint"])

    def test_plain_group_size_counts_all_members(self):
        cv = canvas()
        cv["nodes"].append(_img("p7", "/assets/p7.png"))
        by_id(cv, "plain")["children"] = ["p4", "p7"]
        summary = main._agent_beat_node_summary(by_id(cv, "plain"), cv)
        self.assertEqual(summary["group_size"], 2)


class NormalizeInputsTests(unittest.TestCase):
    def test_stack_children_collapse_and_dedupe(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_normalize_inputs(cv, ["p1", "p2", "stack1", "p1", "no-such"]),
                         ["stack1"])

    def test_plain_group_children_collapse_to_group(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_normalize_inputs(cv, ["p4", "plain"], ), ["plain"])
        self.assertEqual(main._agent_beat_normalize_inputs(cv, ["p4"]), ["plain"])

    def test_group_id_itself_is_kept(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_normalize_inputs(cv, ["plain", "g_inner"]), ["plain", "g_inner"])

    def test_nested_groups_use_nearest_level(self):
        cv = canvas()
        # 连最近的一层才能展开成真实图片：最外层展开时内层 group 会被过滤掉，等于没有参考
        self.assertEqual(main._agent_beat_normalize_inputs(cv, ["p5"]), ["s_inner"])
        self.assertEqual(main._agent_beat_normalize_inputs(cv, ["s_inner"]), ["s_inner"])
        self.assertEqual(main._agent_beat_normalize_inputs(cv, ["p6"]), ["g_inner"])

    def test_parent_map_knows_groups(self):
        cv = canvas()
        parents = main._agent_beat_group_parent_map(cv)
        self.assertEqual(parents["p1"], ["stack1"])
        self.assertEqual(parents["p4"], ["plain"])
        self.assertEqual(parents["s_inner"], ["nested"])
        self.assertNotIn("p6", parents.get("g_outer", []))


class GenerateConnectsWholeGroupTests(unittest.TestCase):
    def _run(self, inputs):
        made = {}

        def fake_mutate(canvas_id, mutate):
            work = copy.deepcopy(canvas())
            mutate(work)
            made["canvas"] = work
            return work, None

        args = {"canvas_id": "c1", "prompt": "白底产品大片，五种场景", "inputs": inputs,
                "count": 1, "provider": "", "model": ""}
        with patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate):
            result = main._agent_beat_generate(args, "image")
        return result, made["canvas"]

    def test_stack_children_become_one_stack_edge(self):
        result, work = self._run(["p1", "p2"])
        edges = [c for c in work["connections"] if c["to"] == result["node_id"]]
        self.assertEqual([e["from"] for e in edges], ["stack1"])

    def test_plain_group_children_become_one_group_edge(self):
        result, work = self._run(["p4"])
        edges = [c for c in work["connections"] if c["to"] == result["node_id"]]
        self.assertEqual([e["from"] for e in edges], ["plain"])

    def test_group_plus_child_dedupes_to_one_edge(self):
        result, work = self._run(["stack1", "p3"])
        edges = [c for c in work["connections"] if c["to"] == result["node_id"]]
        self.assertEqual([e["from"] for e in edges], ["stack1"])


class ExpandGroupUrlsTests(unittest.TestCase):
    def test_stack_child_url_expands_to_whole_stack(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_expand_group_urls(cv, ["/assets/p2.png"]),
                         ["/assets/p1.png", "/assets/p2.png", "/assets/p3.png"])

    def test_plain_group_child_url_expands_to_group(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_expand_group_urls(cv, ["/assets/p4.png"]), ["/assets/p4.png"])

    def test_plain_group_with_two_members_expands(self):
        cv = canvas()
        cv["nodes"].append(_img("p7", "/assets/p7.png"))
        by_id(cv, "plain")["children"] = ["p4", "p7"]
        self.assertEqual(main._agent_beat_expand_group_urls(cv, ["/assets/p7.png"]),
                         ["/assets/p4.png", "/assets/p7.png"])

    def test_unknown_urls_are_kept(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_expand_group_urls(cv, ["https://x/y.png"]), ["https://x/y.png"])

    def test_repeated_urls_do_not_duplicate_members(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_expand_group_urls(cv, ["/assets/p1.png", "/assets/p3.png"]),
                         ["/assets/p1.png", "/assets/p2.png", "/assets/p3.png"])


class GenerateWithReferenceUrlTests(unittest.TestCase):
    def test_one_stack_member_url_connects_all_members(self):
        made = {}

        def fake_mutate(canvas_id, mutate):
            work = copy.deepcopy(canvas())
            mutate(work)
            made["canvas"] = work
            return work, None

        args = {"canvas_id": "c1", "prompt": "大片", "inputs": [],
                "reference_urls": [{"url": "/assets/p2.png"}], "count": 1, "provider": "", "model": ""}
        with patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate):
            result = main._agent_beat_generate(args, "image")
        edges = sorted(e["from"] for e in made["canvas"]["connections"] if e["to"] == result["node_id"])
        self.assertEqual(edges, ["p1", "p2", "p3"])


class GenerateValidatePassesInputsTests(unittest.TestCase):
    def test_beat_canvas_keeps_inputs(self):
        cv = canvas()
        with patch.object(main, "load_canvas", return_value=cv):
            norm = main._agent_tool_generate_image_validate(
                {"canvas_id": "c1", "prompt": "大片", "inputs": ["p1", "p2"]})
        self.assertEqual(norm["inputs"], ["p1", "p2"])

    def test_non_beat_canvas_has_no_inputs_field(self):
        legacy = {"id": "c2", "kind": "classic", "nodes": [{"id": "x", "type": "image", "url": "/output/a.png"}],
                  "connections": []}
        with patch.object(main, "load_canvas", return_value=legacy):
            norm = main._agent_tool_generate_image_validate(
                {"canvas_id": "c2", "prompt": "猫", "inputs": ["x"]})
        self.assertNotIn("inputs", norm)


class CreateNodeConnectsGroupTests(unittest.TestCase):
    def test_beat_create_node_normalizes_and_connects(self):
        cv = canvas()
        made = {}

        def fake_mutate(canvas_id, mutate):
            work = copy.deepcopy(cv)
            mutate(work)
            made["canvas"] = work
            return work, None

        args = {"canvas_id": "c1", "type": "image", "x": None, "y": None,
                "title": "舞台图", "prompt": "影棚光", "params": {}, "inputs": ["p4"]}
        with patch.object(main, "load_canvas", return_value=cv), \
                patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate):
            result = main._agent_tool_create_node_run_classic(args)
        edges = [e["from"] for e in made["canvas"]["connections"] if e["to"] == result["node_id"]]
        self.assertEqual(edges, ["plain"])


class AudioCreateNormalizesInputsTests(unittest.TestCase):
    def test_audio_inputs_collapse_to_group(self):
        cv = canvas()
        with patch.object(main, "load_canvas", return_value=cv), \
                patch.object(main, "_agent_beat_tts_model", return_value="fake::tts"):
            norm = main._agent_beat_create_validate(
                {"inputs": ["p4"], "prompt": "这句口播"}, "c1", "audio")
        self.assertEqual(norm["inputs"], ["plain"])


class PromptRuleTests(unittest.TestCase):
    def test_prompt_has_group_and_stack_rule(self):
        prompt = main._AGENT_BEAT_SYSTEM_PROMPT
        self.assertIn("分组 / 堆叠节点 = 一组素材", prompt)
        self.assertIn("同一个分组节点本身", prompt)
        self.assertIn("不要一个生成节点配一张组员图", prompt)

    def test_prompt_has_mention_rule(self):
        # 提示词是 .format() 渲染的：断言渲染后的文本（模板里 {{{ 转义成 {）
        prompt = main._AGENT_BEAT_SYSTEM_PROMPT.format(
            tools_json="T", media_platforms_text="M", canvas_summary="C", history_text="", focus_text="F")
        self.assertIn("@{节点id}", prompt)
        self.assertIn("工具会自动把已连接输入的 @ 记号补到提示词末尾", prompt)


if __name__ == "__main__":
    unittest.main(verbosity=2)
