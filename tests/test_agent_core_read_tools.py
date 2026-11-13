# -*- coding: utf-8 -*-
"""按需读取工具（server/agent_core/read_tools）：纯函数，不 import main、不起服务。

覆盖：read_node 全文 / @ 引用带 id / 上下游 / 分组成员 / 找不到；search_canvas 多词与过滤、排序、片段；
read_table 分页与通道；canvas_diff 只认内容改动；view_image 的图片 / 视频封面 / 错误；recall_step；
tool_entries 产出的条目形状与错误类型转换。
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.agent_core import read_tools as rt  # noqa: E402
from server.agent_core.transcript import Transcript  # noqa: E402

LONG = "镜头一：清晨的梳妆台，口播「这支口红真的不沾杯」。" * 300


def canvas():
    return {
        "id": "c1", "title": "口红项目",
        "nodes": [
            {"id": "t1", "kind": "text", "x": 0, "y": 0, "text": "旧正文", "data": {"gen": {
                "title": "分镜脚本", "hist": [{"text": "第一版"}, {"text": LONG}], "hi": 1, "manual": True}}},
            {"id": "p1", "kind": "image", "x": 300, "y": 0, "data": {"gen": {
                "title": "产品白底图", "uploaded": True, "hist": [{"url": "/assets/p1.png", "w": 1024, "h": 1024}]}}},
            {"id": "n1", "kind": "image", "x": 600, "y": 0, "data": {"gen": {
                "title": "海报 1", "prompt": "参考 @{p1} 的口红，放在大理石台面上，3:4",
                "params": {"model": "prov::m1", "ratio": "3:4", "count": 1, "style": "", "extra": {"a": 1}},
                "hist": [{"url": "/out/a.png"}, {"url": "/out/b.png"}], "hi": 1}}},
            {"id": "n2", "kind": "image", "x": 900, "y": 0, "data": {"gen": {
                "title": "海报 2", "prompt": "口红特写，丝绒背景", "err": "余额不足", "hist": []}}},
            {"id": "n3", "kind": "image", "x": 1200, "y": 0, "data": {"agentPending": True, "gen": {
                "title": "海报 3", "prompt": "口红与花", "hist": []}}},
            {"id": "v1", "kind": "video", "x": 0, "y": 400, "data": {"gen": {
                "title": "镜头 1", "prompt": "推近口红", "hist": [{"url": "/out/v1.mp4", "frame": "/out/v1.jpg", "dur": 5}]}}},
            {"id": "v2", "kind": "video", "x": 300, "y": 400, "data": {"gen": {"title": "镜头 2", "hist": [{"url": "/out/v2.mp4"}]}}},
            {"id": "g1", "kind": "group", "x": -400, "y": 0, "text": "白底组", "children": ["p1", "gone"], "data": {"stack": True}},
            {"id": "tb", "kind": "table", "x": 0, "y": 800, "text": "多维表格", "data": {"table": {
                "title": "场景表", "columns": ["编号", "场景"], "inputModes": {"input-1": "all"},
                "rows": [[str(i + 1), "场景 %d 参考 @{p1}" % (i + 1)] for i in range(30)]}}},
        ],
        "connections": [{"id": "e1", "from": "p1", "to": "n1"}, {"id": "e2", "from": "t1", "to": "n1"},
                        {"id": "e3", "from": "n1", "to": "v1"}, {"id": "e4", "from": "g1", "to": "tb"}, {"from": "x"}],
    }


class ReadNodeTest(unittest.TestCase):
    def test_full_text_is_returned_not_a_160_char_summary(self):
        out = rt.read_node(canvas(), ["t1"])
        self.assertEqual(out["nodes"][0]["text"], LONG[:rt.READ_TEXT_MAX] + "…（已截断，共 %d 字）" % len(LONG)
                         if len(LONG) > rt.READ_TEXT_MAX else LONG)
        self.assertEqual(out["nodes"][0]["versions"], 2)
        self.assertEqual(out["nodes"][0]["current_version"], 2)

    def test_generation_node_detail(self):
        node = rt.read_node(canvas(), ["n1"])["nodes"][0]
        self.assertEqual(node["prompt"], "参考 @产品白底图（p1） 的口红，放在大理石台面上，3:4")
        self.assertEqual(node["image_urls"], ["/out/b.png"], "当前版本的结果")
        self.assertEqual(node["settings"], {"model": "prov::m1", "ratio": "3:4", "count": 1})
        self.assertEqual([u["id"] for u in node["upstream"]], ["p1", "t1"])
        self.assertEqual([d["id"] for d in node["downstream"]], ["v1"])
        self.assertEqual(node["status"], "done")

    def test_status_codes(self):
        got = {n["id"]: n.get("status") for n in rt.read_node(canvas(), ["p1", "n2", "n3", "g1"])["nodes"]}
        self.assertEqual(got, {"p1": "uploaded", "n2": "failed", "n3": "pending", "g1": None})
        self.assertEqual(rt.read_node(canvas(), ["n2"])["nodes"][0]["error"], "余额不足")

    def test_group_members_skip_deleted_children(self):
        node = rt.read_node(canvas(), ["g1"])["nodes"][0]
        self.assertEqual(node["group_kind"], "stack")
        self.assertEqual([m["id"] for m in node["members"]], ["p1"])
        self.assertEqual(node["members"][0]["url"], "/assets/p1.png")

    def test_title_reference_fields_and_missing(self):
        out = rt.read_node(canvas(), ["海报 1", "nope"], fields=["prompt"])
        self.assertEqual(set(out["nodes"][0]), {"id", "kind", "title", "prompt"})
        self.assertEqual(out["missing"], ["nope"])
        self.assertIn("search_canvas", out["hint"])

    def test_cap_on_number_of_nodes(self):
        ids = ["n1"] * (rt.READ_NODE_MAX + 5)
        self.assertEqual(len(rt.read_node(canvas(), ids)["nodes"]), rt.READ_NODE_MAX)


class SearchTest(unittest.TestCase):
    def test_all_terms_must_match_and_title_ranks_first(self):
        out = rt.search_canvas(canvas(), "口红")
        ids = [n["id"] for n in out["nodes"]]
        self.assertIn("t1", ids)
        self.assertIn("n2", ids)
        self.assertNotIn("p1", ids)
        out = rt.search_canvas(canvas(), "口红 丝绒")
        self.assertEqual([n["id"] for n in out["nodes"]], ["n2"])
        self.assertIn("丝绒背景", out["nodes"][0]["match"])
        self.assertEqual([n["id"] for n in rt.search_canvas(canvas(), "海报")["nodes"]], ["n1", "n2", "n3"], "同分按画布阅读顺序")

    def test_filters_without_query(self):
        self.assertEqual([n["id"] for n in rt.search_canvas(canvas(), status="failed")["nodes"]], ["n2"])
        self.assertEqual([n["id"] for n in rt.search_canvas(canvas(), kind="video")["nodes"]], ["v1", "v2"])
        self.assertEqual([n["id"] for n in rt.search_canvas(canvas(), "口红", kind="video")["nodes"]], ["v1"])

    def test_table_content_and_text_body_are_searchable(self):
        self.assertEqual([n["id"] for n in rt.search_canvas(canvas(), "场景 17")["nodes"]], ["tb"])
        hit = rt.search_canvas(canvas(), "不沾杯")["nodes"][0]
        self.assertEqual(hit["id"], "t1")
        self.assertIn("不沾杯", hit["match"])

    def test_limit_and_empty(self):
        out = rt.search_canvas(canvas(), "", limit=2)
        self.assertEqual(len(out["nodes"]), 2)
        self.assertEqual(out["total"], 9)
        self.assertIn("还有 7 个命中", out["hint"])
        self.assertEqual(rt.search_canvas(canvas(), "不存在的词")["nodes"], [])
        self.assertEqual(len(rt.search_canvas(canvas(), "", limit=999)["nodes"]), 9)


class TableTest(unittest.TestCase):
    def test_paging_inputs_modes_and_mentions(self):
        out = rt.read_table(canvas(), "tb", start=20, limit=5)
        self.assertEqual(out["columns"], ["编号", "场景"])
        self.assertEqual(out["row_count"], 30)
        self.assertEqual([r["row"] for r in out["rows"]], [21, 22, 23, 24, 25])
        self.assertEqual(out["rows"][0]["cells"][1], "场景 21 参考 @产品白底图（p1）")
        self.assertEqual(out["inputs"], [{"id": "g1", "kind": "group", "title": "白底组"}])
        self.assertEqual(out["input_modes"], {"input-1": "all"})
        self.assertIn("start=25", out["hint"])
        self.assertNotIn("hint", rt.read_table(canvas(), "tb", start=25, limit=20))

    def test_errors(self):
        with self.assertRaises(rt.ReadToolError) as ctx:
            rt.read_table(canvas(), "n1")
        self.assertIn("不是多维表格", ctx.exception.message)
        with self.assertRaises(rt.ReadToolError) as ctx:
            rt.read_table(canvas(), "zzz")
        self.assertEqual(ctx.exception.code, "node_not_found")


class DiffTest(unittest.TestCase):
    def test_content_changes_only(self):
        old, new = canvas(), canvas()
        new["nodes"][2]["x"] = 9999                                        # 只挪位置：不算改动
        new["nodes"][3]["data"]["gen"]["prompt"] = "口红特写，绿色丝绒背景"       # 改提示词
        new["nodes"][0]["data"]["gen"]["hi"] = 0                            # 切回第一版正文
        new["nodes"] = [n for n in new["nodes"] if n["id"] != "v2"]          # 删
        new["nodes"].append({"id": "n9", "kind": "image", "data": {"gen": {"title": "新图"}}})
        new["connections"].append({"from": "p1", "to": "n9"})
        new["nodes"][-2]["data"]["table"]["rows"][0][1] = "改过的场景"       # 表格内容
        out = rt.canvas_diff(old, new)
        self.assertTrue(out["available"])
        self.assertFalse(out["unchanged"])
        self.assertEqual([n["id"] for n in out["created"]], ["n9"])
        self.assertEqual([n["id"] for n in out["deleted"]], ["v2"])
        self.assertEqual({m["id"]: m["changed"] for m in out["modified"]},
                         {"n2": ["prompt"], "t1": ["text"], "tb": ["table"]})
        self.assertEqual(out["connections_added"], [{"from": "p1", "to": "n9"}])

    def test_unchanged_and_no_baseline(self):
        self.assertTrue(rt.canvas_diff(canvas(), canvas())["unchanged"])
        self.assertFalse(rt.canvas_diff(None, canvas())["available"])


class ViewImageTest(unittest.TestCase):
    def test_image_video_and_errors(self):
        self.assertEqual(rt.view_image(canvas(), "n1")["view_images"], [{"url": "/out/b.png", "label": "海报 1"}])
        self.assertEqual(rt.view_image(canvas(), "v1")["view_images"][0]["url"], "/out/v1.jpg")
        self.assertEqual(rt.view_image(canvas(), url="/x.png")["view_images"][0]["label"], "图片")
        for ref, word in (("v2", "没有封面帧"), ("n2", "还没有结果"), ("t1", "不是图片或视频")):
            with self.assertRaises(rt.ReadToolError) as ctx:
                rt.view_image(canvas(), ref)
            self.assertIn(word, ctx.exception.message)
        with self.assertRaises(rt.ReadToolError):
            rt.view_image(canvas())


class EntriesTest(unittest.TestCase):
    class ToolError(Exception):
        def __init__(self, message, code="tool_error"):
            super().__init__(message)
            self.message, self.code = message, code

    def setUp(self):
        self.tr = Transcript()
        self.tr.add_result(1, "read_node", {}, True, {"text": "原文" * 500})
        self.loads = []

        def load(canvas_id):
            self.loads.append(canvas_id)
            if canvas_id != "c1":
                raise self.ToolError("画布不存在", code="canvas_not_found")
            return canvas()
        old = canvas()
        old["nodes"][2]["data"]["gen"]["prompt"] = "旧提示词"
        self.entries = rt.tool_entries(load, get_transcript=lambda: self.tr, load_baseline=lambda cid: old,
                                       error_cls=self.ToolError)

    def run_tool(self, name, args):
        entry = self.entries[name]
        return entry["run"](entry["validate"](args))

    def test_shape_matches_agent_tools(self):
        self.assertEqual(tuple(self.entries), rt.READ_TOOL_NAMES)
        for name, entry in self.entries.items():
            self.assertEqual(set(entry), {"description", "schema", "validate", "run", "preview", "mutates_canvas"})
            self.assertFalse(entry["mutates_canvas"])
            self.assertEqual(entry["schema"]["type"], "object")
            self.assertTrue(entry["description"])

    def test_each_tool_runs_end_to_end(self):
        self.assertEqual(self.run_tool("read_node", {"canvas_id": "c1", "node_id": "n1"})["nodes"][0]["id"], "n1")
        self.assertEqual(self.run_tool("search_canvas", {"canvas_id": "c1", "status": "failed"})["nodes"][0]["id"], "n2")
        self.assertEqual(self.run_tool("read_table", {"canvas_id": "c1", "node_id": "tb"})["row_count"], 30)
        self.assertEqual(self.run_tool("canvas_diff", {"canvas_id": "c1"})["modified"][0]["changed"], ["prompt"])
        self.assertEqual(self.run_tool("view_image", {"canvas_id": "c1", "node_id": "n1"})["view_images"][0]["url"], "/out/b.png")
        self.assertEqual(self.run_tool("recall_step", {"index": "1"})["result"], '{"text": "%s"}' % ("原文" * 500))
        self.assertIsInstance(self.entries["read_node"]["preview"]({"node_ids": ["a", "b"]}, canvas()), str)

    def test_errors_are_converted_to_loop_error_class(self):
        cases = [("read_node", {"canvas_id": "c1"}, "invalid_args"), ("read_node", {}, "invalid_args"),
                 ("search_canvas", {"canvas_id": "c1", "status": "weird"}, "invalid_args"),
                 ("read_table", {"canvas_id": "c1", "node_id": "zzz"}, "node_not_found"),
                 ("recall_step", {"index": "abc"}, "invalid_args"), ("recall_step", {"index": 42}, "invalid_args"),
                 ("read_node", {"canvas_id": "other", "node_ids": ["n1"]}, "canvas_not_found")]
        for name, args, code in cases:
            with self.assertRaises(self.ToolError) as ctx:
                self.run_tool(name, args)
            self.assertEqual(ctx.exception.code, code, "%s %s" % (name, args))


if __name__ == "__main__":
    unittest.main()
