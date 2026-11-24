# -*- coding: utf-8 -*-
"""canvas_action 第二批组件：调色（本机）、扩图 / 擦除 / 局部重绘（模型，区域用 0–1 框代替手画）。"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-canvas-action2-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from PIL import Image  # noqa: E402
from tests.test_agent_canvas_action import image_node, local_path, make_png, new_canvas, run  # noqa: E402


def validate(action, **params):
    return main._agent_tool_canvas_action_validate({"canvas_id": "c", "action": action, "node_id": "n",
                                                    "params": params})


class ValidateMoreTests(unittest.TestCase):
    def test_adjust_needs_nonzero(self):
        with self.assertRaises(main.AgentToolError):
            validate("adjust")
        with self.assertRaises(main.AgentToolError):
            validate("adjust", brightness=150)
        self.assertEqual(validate("adjust", warmth=30)["params"]["warmth"], 30)

    def test_outpaint_defaults_ratio_and_sides(self):
        self.assertEqual(validate("outpaint")["params"], {"top": .25, "bottom": .25, "left": .25, "right": .25})
        self.assertEqual(validate("outpaint", ratio="9:16")["params"]["ratio"], "9:16")
        p = validate("outpaint", right=.5)["params"]
        self.assertEqual((p["left"], p["right"]), (0, .5))
        for bad in ({"ratio": "wide"}, {"top": 0, "left": 0}, {"right": 2}):
            with self.subTest(bad=bad), self.assertRaises(main.AgentToolError):
                validate("outpaint", **bad)

    def test_region_actions(self):
        with self.assertRaises(main.AgentToolError):
            validate("erase")
        p = validate("erase", region={"x": .8, "y": .1, "w": .5, "h": .2})["params"]
        self.assertEqual(p["shape"], "ellipse")
        self.assertAlmostEqual(p["region"]["w"], .2, places=3, msg="区域裁到图内")
        with self.assertRaises(main.AgentToolError):
            validate("redraw", region={"x": 0, "y": 0, "w": .5, "h": .5})
        p = validate("redraw", region={"x": 0, "y": 0, "w": .5, "h": .5}, note="换成蓝色杯子", shape="rect")["params"]
        self.assertEqual((p["shape"], p["note"]), ("rect", "换成蓝色杯子"))


class AdjustTests(unittest.TestCase):
    def test_adjust_brighter_and_warmer(self):
        url = make_png(120, 80, color=(100, 100, 100))
        cid = new_canvas([image_node("src", url)])
        res = run({"canvas_id": cid, "action": "adjust", "node_id": "src",
                   "params": {"brightness": 40, "warmth": 60}})
        self.assertEqual(res["status"], "done")
        with Image.open(local_path(res["image_urls"][0])) as im:
            r, g, b = im.convert("RGB").getpixel((60, 40))
        self.assertGreater(r, 100 * 1.3)
        self.assertGreater(r, b, "偏暖：红多蓝少")
        self.assertEqual(main._agent_beat_url(main._agent_find_node(main.load_canvas(cid), "src")), url)

    def test_adjust_keeps_alpha(self):
        img = Image.new("RGBA", (40, 40), (50, 50, 50, 0))
        img.putpixel((5, 5), (50, 50, 50, 255))
        out = main._canvas_action_adjust_image(img, {"contrast": 30})
        self.assertEqual(out.mode, "RGBA")
        self.assertEqual(out.getpixel((20, 20))[3], 0)
        self.assertEqual(out.getpixel((5, 5))[3], 255)


class ModelMoreTests(unittest.TestCase):
    def setUp(self):
        self.url = make_png(300, 200)
        self.cid = new_canvas([image_node("src", self.url), image_node("ref", make_png(50, 50, (0, 0, 255)), 0, 300)])

    def _node(self, res):
        return main._agent_find_node(main.load_canvas(self.cid), res["node_id"])

    def test_outpaint_pads_source_server_side(self):
        res = run({"canvas_id": self.cid, "action": "outpaint", "node_id": "src", "params": {"ratio": "9:16"}})
        action = self._node(res)["data"]["agentAction"]
        self.assertTrue(action["params"]["prepadded"])
        self.assertNotEqual(action["source_url"], self.url)
        with Image.open(local_path(action["source_url"])) as im:
            self.assertEqual(im.mode, "RGBA")
            w, h = im.size
            self.assertAlmostEqual(w / h, 9 / 16, places=2)
            self.assertEqual(im.getpixel((w // 2, 2))[3], 0, "上方是透明扩展区")
            self.assertEqual(im.getpixel((w // 2, h // 2))[3], 255, "中间是原图")
        self.assertEqual(main._agent_beat_url(self._node(res)), self.url, "占位结果仍是原图")

    def test_outpaint_same_ratio_rejected(self):
        with self.assertRaises(main.AgentToolError):
            run({"canvas_id": self.cid, "action": "outpaint", "node_id": "src", "params": {"ratio": "3:2"}})

    def test_redraw_with_reference_product(self):
        res = run({"canvas_id": self.cid, "action": "redraw", "node_id": "src",
                   "params": {"region": {"x": .3, "y": .3, "w": .4, "h": .4}, "ref_node_id": "ref"}})
        node = self._node(res)
        params = node["data"]["agentAction"]["params"]
        self.assertTrue(params["ref_url"])
        self.assertEqual(node["data"]["agentAction"]["source_url"], self.url)
        conns = main.load_canvas(self.cid).get("connections") or []
        self.assertTrue(any(c.get("from") == "ref" and c.get("to") == node["id"] for c in conns), "新品图连到结果节点")

    def test_erase_counts_as_one_image_generation(self):
        args = {"action": "erase", "node_id": "src", "params": {"region": {"x": 0, "y": 0, "w": .2, "h": .2}}}
        self.assertEqual(main._agent_step_generation_units("canvas_action", args), 1)
        self.assertIn("erase", main.AGENT_TOOLS["canvas_action"]["schema"]["properties"]["action"]["enum"])


def video_node(nid, url="https://example.invalid/src.mp4", title="原片"):
    return {"id": nid, "kind": "video", "x": 0, "y": 0, "w": 320, "h": 180,
            "data": {"gen": {"title": title, "prompt": "", "hist": [{"url": url, "dur": 8}], "hi": 0}}}


class VideoActionTests(unittest.TestCase):
    def setUp(self):
        self.cid = new_canvas([video_node("v"), image_node("img", make_png())])

    def _run_deferred(self, args):
        token = main._AGENT_BEAT_DEFER_GEN.set(True)
        try:
            return run({"canvas_id": self.cid, **args})
        finally:
            main._AGENT_BEAT_DEFER_GEN.reset(token)

    def test_validate(self):
        with self.assertRaises(main.AgentToolError):
            validate("video_replace", target="靴子")
        with self.assertRaises(main.AgentToolError):
            validate("video_retake")
        self.assertEqual(validate("video_extend", direction="开头")["params"]["direction"], "before")

    def test_replace_builds_video_edit_node(self):
        res = self._run_deferred({"action": "video_replace", "node_id": "v",
                                  "params": {"target": "黑色靴子", "replacement": "白色运动鞋"}})
        self.assertEqual(res["status"], "ready_to_generate")
        self.assertEqual(res["action"], "video_replace")
        canvas = main.load_canvas(self.cid)
        node = main._agent_find_node(canvas, res["node_id"])
        gen = node["data"]["gen"]
        self.assertEqual(gen["params"]["mode"], "视频编辑")
        self.assertIn("「黑色靴子」替换成「白色运动鞋」", gen["prompt"])
        self.assertEqual(gen["title"], "原片 · 替换")
        self.assertTrue(any(c.get("from") == "v" and c.get("to") == node["id"] for c in canvas["connections"]))

    def test_extend_before_and_retake(self):
        res = self._run_deferred({"action": "video_extend", "node_id": "v", "params": {"direction": "before"}})
        node = main._agent_find_node(main.load_canvas(self.cid), res["node_id"])
        self.assertEqual(node["data"]["gen"]["params"]["mode"], "视频延长")
        self.assertIn("第一帧之前", node["data"]["gen"]["prompt"])
        res = self._run_deferred({"action": "video_retake", "node_id": "v", "params": {"camera": "环绕运镜"}})
        node = main._agent_find_node(main.load_canvas(self.cid), res["node_id"])
        self.assertIn("「环绕运镜」的机位", node["data"]["gen"]["prompt"])

    def test_image_node_rejected_and_budget(self):
        with self.assertRaises(main.AgentToolError):
            self._run_deferred({"action": "video_remove", "node_id": "img", "params": {"target": "路人"}})
        args = {"action": "video_remove", "node_id": "v", "params": {"target": "路人"}}
        self.assertEqual(main._agent_step_modality("canvas_action", args), "video")
        self.assertEqual(main._agent_step_generation_units("canvas_action", args), 1)


if __name__ == "__main__":
    unittest.main()
