# -*- coding: utf-8 -*-
"""canvas_action：助手使用画布组件（分组 / 堆叠、旋转、裁剪、切分、多角度、重打光、白膜、增强…）。

覆盖：
- 参数校验与归一（别名、默认值、越界报错）；
- 分组 / 堆叠落成 BEAT 的 group 节点（堆叠带 data.stack），已在组里的节点拒绝；
- 旋转 / 裁剪 / 宫格切分真的处理像素并落新节点、从原图连线，原节点不动；
- 模型编辑：待生成模式建好占位节点（agentPending + agentAction），批准后（非延后）打 agentRun 交给画布；
- 预算口径：只有模型编辑算 1 次图片生成；
- 工具目录（含瘦身模式）里有 canvas_action，BEAT 提示词讲了什么时候用。
"""
import asyncio
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-canvas-action-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from PIL import Image  # noqa: E402


def make_png(w=300, h=200, color=(200, 30, 30)):
    name = f"ca_src_{uuid.uuid4().hex[:8]}.png"
    path = main.output_path_for(name, "output")
    img = Image.new("RGB", (w, h), color)
    # 左上角涂一块白，方便验证旋转方向
    for x in range(20):
        for y in range(20):
            img.putpixel((x, y), (255, 255, 255))
    img.save(path, "PNG")
    return main.output_url_for(name, "output")


def image_node(nid, url, x=0, y=0, title="商品图"):
    return {"id": nid, "kind": "image", "x": x, "y": y, "w": 240, "h": 160,
            "data": {"gen": {"title": title, "prompt": "", "hist": [{"url": url}], "hi": 0}}}


def new_canvas(nodes):
    cid = "c-ca-" + uuid.uuid4().hex[:8]
    main.save_canvas({"id": cid, "title": "组件", "kind": "beat", "updated_at": int(main.time.time() * 1000),
                      "nodes": nodes, "connections": []})
    return cid


def run(args):
    return asyncio.run(main._agent_tool_canvas_action_run(main._agent_tool_canvas_action_validate(args)))


def local_path(url):
    return main._agent_local_image_path(url)


class ValidateTests(unittest.TestCase):
    def test_unknown_action_rejected(self):
        with self.assertRaises(main.AgentToolError):
            main._agent_tool_canvas_action_validate({"canvas_id": "c", "action": "explode", "node_id": "n"})

    def test_aliases_and_defaults(self):
        v = main._agent_tool_canvas_action_validate(
            {"canvas_id": "c", "action": "rotate", "node_id": "n", "params": {"direction": "left"}})
        self.assertEqual(v["params"]["direction"], "ccw")
        v = main._agent_tool_canvas_action_validate(
            {"canvas_id": "c", "action": "whitemodel", "node_id": "n", "params": {"tier": "人物"}})
        self.assertEqual(v["params"]["tier"], "mannequin")
        v = main._agent_tool_canvas_action_validate(
            {"canvas_id": "c", "action": "relight", "node_id": "n", "params": {"direction": "右上方"}})
        self.assertEqual((v["params"]["lx"], v["params"]["ly"]), (.8, .2))
        v = main._agent_tool_canvas_action_validate({"canvas_id": "c", "action": "angle", "node_id": "n"})
        self.assertEqual(v["params"]["yaw"], 30)

    def test_out_of_range_and_missing(self):
        bad = [
            {"action": "split", "node_id": "n", "params": {"cols": 9, "rows": 1}},
            {"action": "split", "node_id": "n", "params": {"cols": 1, "rows": 1}},
            {"action": "angle", "node_id": "n", "params": {"yaw": 400}},
            {"action": "crop", "node_id": "n", "params": {}},
            {"action": "group", "node_ids": ["only-one"]},
            {"action": "rotate"},
        ]
        for args in bad:
            with self.subTest(args=args), self.assertRaises(main.AgentToolError):
                main._agent_tool_canvas_action_validate({"canvas_id": "c", **args})


class GroupTests(unittest.TestCase):
    def test_stack_and_group_nodes(self):
        url = make_png()
        cid = new_canvas([image_node("a", url, 0, 0), image_node("b", url, 300, 0), image_node("c", url, 0, 300)])
        res = run({"canvas_id": cid, "action": "stack", "node_ids": ["b", "a"], "title": "多角度"})
        self.assertEqual(res["status"], "done")
        canvas = main.load_canvas(cid)
        stack = main._agent_find_node(canvas, res["node_id"])
        self.assertEqual(stack["kind"], "group")
        self.assertTrue(stack["data"]["stack"])
        self.assertEqual(stack["children"], ["a", "b"], "堆叠按画布阅读顺序")
        self.assertEqual(stack["text"], "多角度")
        self.assertTrue(main._agent_beat_is_stack(stack))
        with self.assertRaises(main.AgentToolError):
            run({"canvas_id": cid, "action": "group", "node_ids": ["a", "c"]})
        with self.assertRaises(main.AgentToolError):
            run({"canvas_id": cid, "action": "group", "node_ids": ["c", res["node_id"]]})

    def test_group_frame_wraps_members(self):
        url = make_png()
        cid = new_canvas([image_node("a", url, 0, 0), image_node("b", url, 400, 100)])
        res = run({"canvas_id": cid, "action": "group", "node_ids": ["a", "b"]})
        g = main._agent_find_node(main.load_canvas(cid), res["node_id"])
        self.assertNotIn("stack", g.get("data") or {})
        self.assertLessEqual(g["x"], 0)
        self.assertGreaterEqual(g["x"] + g["w"], 640)


class LocalImageTests(unittest.TestCase):
    def setUp(self):
        self.url = make_png(300, 200)
        self.cid = new_canvas([image_node("src", self.url)])

    def _new_nodes(self, res):
        canvas = main.load_canvas(self.cid)
        conns = canvas.get("connections") or []
        for nid in res["node_ids"]:
            self.assertTrue(any(c.get("from") == "src" and c.get("to") == nid for c in conns), "要从原图连线")
        self.assertEqual(main._agent_beat_url(main._agent_find_node(canvas, "src")), self.url, "原节点不动")
        return [main._agent_find_node(canvas, nid) for nid in res["node_ids"]]

    def test_rotate_cw(self):
        res = run({"canvas_id": self.cid, "action": "rotate", "node_id": "src", "params": {"direction": "cw"}})
        node = self._new_nodes(res)[0]
        with Image.open(local_path(main._agent_beat_url(node))) as im:
            self.assertEqual(im.size, (200, 300))
            self.assertEqual(im.convert("RGB").getpixel((195, 5)), (255, 255, 255), "顺时针后白块到右上角")

    def test_crop_ratio_centered(self):
        res = run({"canvas_id": self.cid, "action": "crop", "node_id": "src", "params": {"ratio": "1:1"}})
        node = self._new_nodes(res)[0]
        with Image.open(local_path(main._agent_beat_url(node))) as im:
            self.assertEqual(im.size, (200, 200))

    def test_split_grid(self):
        res = run({"canvas_id": self.cid, "action": "split", "node_id": "src", "params": {"cols": 3, "rows": 2}})
        nodes = self._new_nodes(res)
        self.assertEqual(len(nodes), 6)
        with Image.open(local_path(main._agent_beat_url(nodes[0]))) as im:
            self.assertEqual(im.size, (100, 100))
        self.assertTrue(nodes[0]["data"]["gen"]["title"].endswith("1-1"))
        self.assertTrue(nodes[0]["data"]["gen"].get("manual"), "切出来的图本身就是结果，链式重跑不能跑它")

    def test_upscale_without_runtime_explains(self):
        with patch.object(main, "_upscale_runtime_installed", return_value=False):
            with self.assertRaises(main.AgentToolError) as ctx:
                run({"canvas_id": self.cid, "action": "upscale", "node_id": "src", "params": {"target": "2k"}})
        self.assertIn("enhance", ctx.exception.message)

    def test_cutout_without_model_explains(self):
        with patch.object(main, "_matting_model_downloaded", return_value=False):
            with self.assertRaises(main.AgentToolError) as ctx:
                run({"canvas_id": self.cid, "action": "cutout", "node_id": "src"})
        self.assertIn("抠图", ctx.exception.message)

    def test_non_image_rejected(self):
        cid = new_canvas([{"id": "t", "kind": "text", "x": 0, "y": 0, "data": {"gen": {"title": "文案", "hist": [{"text": "hi"}]}}}])
        with self.assertRaises(main.AgentToolError):
            run({"canvas_id": cid, "action": "rotate", "node_id": "t"})


class ModelActionTests(unittest.TestCase):
    def setUp(self):
        self.url = make_png()
        self.cid = new_canvas([image_node("src", self.url, title="靴子")])

    def test_deferred_builds_placeholder_for_generation_card(self):
        token = main._AGENT_BEAT_DEFER_GEN.set(True)
        try:
            res = run({"canvas_id": self.cid, "action": "angle", "node_id": "src", "params": {"yaw": 45}})
        finally:
            main._AGENT_BEAT_DEFER_GEN.reset(token)
        self.assertEqual(res["status"], "ready_to_generate")
        self.assertEqual(res["kind"], "image")
        node = main._agent_find_node(main.load_canvas(self.cid), res["node_id"])
        data = node["data"]
        self.assertTrue(data.get("agentPending"))
        self.assertNotIn("agentRun", data)
        self.assertEqual(data["agentAction"]["op"], "angle")
        self.assertEqual(data["agentAction"]["params"]["yaw"], 45)
        self.assertEqual(data["agentAction"]["source_url"], self.url)
        self.assertEqual(main._agent_beat_url(node), self.url, "占位结果 = 原图")
        self.assertIn("45°", data["gen"]["title"])
        self.assertTrue(data["gen"].get("manual"))
        # 待生成卡片里的步骤就是对它 run_generation（批准时真正打标记）
        plan = main._agent_generation_plan(self.cid, [{"node_id": res["node_id"], "kind": "image"}])
        self.assertEqual(plan["steps"][0]["tool"], "run_generation")

    def test_approved_run_marks_canvas(self):
        res = run({"canvas_id": self.cid, "action": "whitemodel", "node_id": "src", "params": {"tier": "clear"}})
        self.assertEqual(res["status"], "queued_on_canvas")
        node = main._agent_find_node(main.load_canvas(self.cid), res["node_id"])
        self.assertIn("agentRun", node["data"])
        self.assertEqual(node["data"]["agentAction"]["params"]["tier"], "clear")
        self.assertIn("清空商品", node["data"]["gen"]["title"])

    def test_run_generation_on_placeholder_is_allowed(self):
        token = main._AGENT_BEAT_DEFER_GEN.set(True)
        try:
            res = run({"canvas_id": self.cid, "action": "relight", "node_id": "src"})
        finally:
            main._AGENT_BEAT_DEFER_GEN.reset(token)
        out = asyncio.run(main.agent_execute_step("run_generation", {"canvas_id": self.cid, "node_id": res["node_id"]}))
        self.assertTrue(out.get("ok"), out)
        node = main._agent_find_node(main.load_canvas(self.cid), res["node_id"])
        self.assertIn("agentRun", node["data"])
        self.assertEqual(node["data"]["agentAction"]["op"], "relight", "批准后画布要按组件逻辑跑，标记得还在")


class WiringTests(unittest.TestCase):
    def test_generation_units_and_modality(self):
        self.assertEqual(main._agent_step_generation_units("canvas_action", {"action": "angle"}), 1)
        self.assertEqual(main._agent_step_generation_units("canvas_action", {"action": "split"}), 0)
        self.assertEqual(main._agent_step_modality("canvas_action", {"action": "whitemodel"}), "image")
        self.assertEqual(main._agent_step_modality("canvas_action", {"action": "group"}), "")

    def test_in_catalog_even_when_slim(self):
        with patch.dict(os.environ, {"NOVAI_AGENT_V2_SLIM_TOOLS": "1"}):
            names = {item["name"] for item in main._agent_slim_tool_catalog(main._agent_build_tools_catalog())}
        self.assertIn("canvas_action", names)

    def test_beat_prompt_teaches_components(self):
        self.assertIn("canvas_action", main._AGENT_BEAT_SYSTEM_PROMPT)
        self.assertIn("whitemodel", main._AGENT_BEAT_SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
