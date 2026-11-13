# -*- coding: utf-8 -*-
"""画布助手 BEAT：写生成节点提示词时自动补 @ 引用记号。

背景：画布提示词里的引用记号是 @{节点id}（文本节点某段 @{id#段落}），编辑器渲染成胶囊，
发给模型前 resolveMentions 换成「图N / 视频N / 原文」，@{分组id} 会展开成整组成员。
助手以前只写纯文本，模型拿不到「图1 = 风格参考、图2~4 = 产品角度」这种明确对应。

覆盖：
  1. 文本 / 图片 / 视频 / 分组 / 堆叠输入都按 @{id} 补，分组用分组 id；
  2. 去重、每类上限 8、无输入不补、已有记号不重复；
  3. 不存在 / 记号语法非法的 id 丢弃；
  4. 原文一字不动（只在末尾追加）；
  5. generate_image 端到端：5 个生成节点各自连分组、提示词里都有 @{分组id}，且不设 gen.refMode；
  6. create_node（BEAT）图片节点补记号，文本节点正文不塞记号。
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

_TMP_DATA = tempfile.mkdtemp(prefix="novai-beat-mentions-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def _media(nid, kind="image", url=None, text=None):
    node = {"id": nid, "kind": kind, "x": 0, "y": 0, "w": 200, "h": 200}
    if kind == "text":
        node["text"] = text or ("正文 " + nid)
        node["data"] = {"gen": {"title": nid, "params": {}, "hist": []}}
    else:
        node["url"] = url or f"/assets/{nid}.png"
        node["data"] = {"gen": {"title": nid, "params": {}, "hist": [{"url": node["url"]}], "hi": 0}}
    return node


def canvas(image_count=3):
    nodes = [
        {"id": "grp", "kind": "group", "x": 0, "y": 0, "w": 240, "h": 240,
         "children": ["p1", "p2", "p3"][:image_count], "data": {"gen": {"title": "普通分组"}}},
        {"id": "stk", "kind": "group", "x": 600, "y": 0, "w": 240, "h": 240,
         "children": ["s1", "s2"], "data": {"stack": True, "gen": {"title": "堆叠"}}},
        _media("s1"), _media("s2"),
        _media("vid1", "video"),
        _media("txt1", "text"),
    ]
    for i in range(1, image_count + 1):
        nodes.append(_media(f"p{i}"))
    return {"id": "c1", "kind": "classic", "title": "引用测试", "nodes": nodes, "connections": []}


class MentionIdsTests(unittest.TestCase):
    def test_all_kinds_are_kept_in_input_order(self):
        cv = canvas()
        ids = main._agent_beat_mention_ids(cv, ["p1", "vid1", "txt1", "grp", "stk"])
        self.assertEqual(ids, ["p1", "vid1", "txt1", "grp", "stk"])

    def test_duplicates_are_dropped(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_mention_ids(cv, ["p1", "p1", "grp", "grp"]), ["p1", "grp"])

    def test_unknown_and_illegal_ids_are_dropped(self):
        cv = canvas()
        cv["nodes"].append(_media("bad id!", "image"))
        cv["nodes"].append(_media("bad.id", "image"))
        self.assertEqual(main._agent_beat_mention_ids(cv, ["nope", "bad id!", "bad.id", "p2"]), ["p2"])

    def test_each_kind_is_capped_at_eight(self):
        cv = canvas(image_count=10)
        ids = main._agent_beat_mention_ids(cv, [f"p{i}" for i in range(1, 11)])
        self.assertEqual(len(ids), 8)
        self.assertEqual(ids, [f"p{i}" for i in range(1, 9)])


class PromptWithMentionsTests(unittest.TestCase):
    def test_appends_tokens_and_keeps_original(self):
        cv = canvas()
        out = main._agent_beat_prompt_with_mentions("冷光棚拍，产品居中", cv, ["p1", "grp", "txt1"])
        self.assertTrue(out.startswith("冷光棚拍，产品居中"))
        self.assertTrue(out.endswith("参考：@{p1} @{grp} @{txt1}"))

    def test_no_inputs_leaves_prompt_untouched(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_prompt_with_mentions("冷光棚拍", cv, []), "冷光棚拍")
        self.assertEqual(main._agent_beat_prompt_with_mentions("冷光棚拍", cv, None), "冷光棚拍")

    def test_existing_token_is_not_duplicated(self):
        cv = canvas()
        prompt = "用 @{grp} 出的产品做一张海报"
        self.assertEqual(main._agent_beat_prompt_with_mentions(prompt, cv, ["grp"]), prompt)

    def test_unknown_ids_never_enter_prompt(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_prompt_with_mentions("海报", cv, ["nope"]), "海报")

    def test_empty_prompt_still_gets_tokens(self):
        cv = canvas()
        self.assertEqual(main._agent_beat_prompt_with_mentions("", cv, ["grp"]), "参考：@{grp}")

    def test_section_token_on_text_input_counts_as_mentioned(self):
        cv = canvas()
        prompt = "按 @{txt1#海报1} 写"
        self.assertEqual(main._agent_beat_prompt_with_mentions(prompt, cv, ["txt1"]),
                         prompt + "\n\n参考：@{txt1}")


class GenerateMentionsTests(unittest.TestCase):
    def _run(self, work_canvas, inputs, reference_urls=None):
        state = {"canvas": copy.deepcopy(work_canvas)}

        def fake_mutate(canvas_id, mutate):
            work = copy.deepcopy(state["canvas"])
            mutate(work)
            state["canvas"] = work
            return work, None

        args = {"canvas_id": "c1", "prompt": "白底产品大片", "inputs": inputs,
                "reference_urls": reference_urls or [], "count": 1, "provider": "", "model": ""}
        with patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate):
            result = main._agent_beat_generate(args, "image")
        return result, state["canvas"]

    def test_five_nodes_all_reference_same_group(self):
        work = canvas()
        node_ids = []
        for i in range(5):
            result, work = self._run(work, ["p1"])
            node_ids.append(result["node_id"])
            edges = [e["from"] for e in work["connections"] if e["to"] == result["node_id"]]
            self.assertEqual(edges, ["grp"], "第 %d 个生成节点应连分组本身" % (i + 1))
            gen = next(n for n in work["nodes"] if n["id"] == result["node_id"])["data"]["gen"]
            self.assertIn("@{grp}", gen["prompt"])
            self.assertNotIn("refMode", gen)      # 不能设引用模式：漏 @ 会让输入被丢弃
        self.assertEqual(len(set(node_ids)), 5)

    def test_group_token_used_for_stack_too(self):
        result, work = self._run(canvas(), ["s2"])
        edges = [e["from"] for e in work["connections"] if e["to"] == result["node_id"]]
        self.assertEqual(edges, ["stk"])
        gen = next(n for n in work["nodes"] if n["id"] == result["node_id"])["data"]["gen"]
        self.assertIn("@{stk}", gen["prompt"])

    def test_reference_urls_also_produce_mentions(self):
        result, work = self._run(canvas(), [], [{"url": "/assets/p2.png"}])
        gen = next(n for n in work["nodes"] if n["id"] == result["node_id"])["data"]["gen"]
        self.assertIn("@{p1}", gen["prompt"])
        self.assertIn("@{p2}", gen["prompt"])


class CreateNodeMentionsTests(unittest.TestCase):
    def test_image_node_gets_token(self):
        cv = canvas()
        made = {}

        def fake_mutate(canvas_id, mutate):
            work = copy.deepcopy(cv)
            mutate(work)
            made["canvas"] = work
            return work, None

        args = {"canvas_id": "c1", "type": "image", "x": None, "y": None,
                "title": "舞台图", "prompt": "影棚光", "params": {}, "inputs": ["p1"]}
        with patch.object(main, "load_canvas", return_value=cv), \
                patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate):
            result = main._agent_tool_create_node_run_classic(args)
        gen = next(n for n in made["canvas"]["nodes"] if n["id"] == result["node_id"])["data"]["gen"]
        self.assertIn("@{grp}", gen["prompt"])
        self.assertNotIn("refMode", gen)

    def test_text_node_body_is_not_polluted(self):
        cv = canvas()
        made = {}

        def fake_mutate(canvas_id, mutate):
            work = copy.deepcopy(cv)
            mutate(work)
            made["canvas"] = work
            return work, None

        args = {"canvas_id": "c1", "type": "text", "x": None, "y": None,
                "title": "策划", "prompt": "分镜：第一镜……", "params": {}, "inputs": ["p1"]}
        with patch.object(main, "load_canvas", return_value=cv), \
                patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate):
            result = main._agent_tool_create_node_run_classic(args)
        node = next(n for n in made["canvas"]["nodes"] if n["id"] == result["node_id"])
        self.assertEqual(node["text"], "分镜：第一镜……")
        self.assertEqual(node["data"]["gen"]["prompt"], "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
