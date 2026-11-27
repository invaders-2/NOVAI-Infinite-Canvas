# -*- coding: utf-8 -*-
"""canvas_action 的 parse_storyboard：助手一句话把视频拆成分镜表（和视频工具条「解析」同一个接口）。"""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-parse-storyboard-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from tests.test_agent_canvas_action import image_node, make_png, new_canvas, run  # noqa: E402

COLUMNS = ["镜号", "首帧", "起止", "时长", "画面描述", "景别", "机位", "运镜"]
ROWS = [["1", "/output/storyboard_frames/a_01.jpg", "0.0–2.0s", "2.0s", "产品居中", "全景", "正面", "固定"],
        ["2", "/output/storyboard_frames/a_02.jpg", "2.0–4.0s", "2.0s", "特写按键", "特写", "俯拍", "推"]]


def video_node(nid="v", title="竞品视频"):
    return {"id": nid, "kind": "video", "x": 0, "y": 0, "w": 360, "h": 203,
            "data": {"gen": {"title": title, "prompt": "", "hist": [{"url": "/output/clip.mp4"}], "hi": 0}}}


def validate(**params):
    return main._agent_tool_canvas_action_validate({"canvas_id": "c", "action": "parse_storyboard", "node_id": "v",
                                                    "params": params})


class ValidateTests(unittest.TestCase):
    def test_template_default_and_aliases(self):
        self.assertEqual(validate()["params"], {"template": "storyboard"})
        self.assertEqual(validate(template="电商")["params"]["template"], "ecom")
        self.assertEqual(validate(template="LITE")["params"]["template"], "lite")
        with self.assertRaises(main.AgentToolError):
            validate(template="宫格")

    def test_free_and_listed(self):
        args = {"action": "parse_storyboard", "node_id": "v"}
        self.assertEqual(main._agent_step_modality("canvas_action", args), "")
        self.assertEqual(main._agent_step_generation_units("canvas_action", args), 0)
        self.assertIn("parse_storyboard", main.AGENT_TOOLS["canvas_action"]["schema"]["properties"]["action"]["enum"])
        self.assertIn("parse_storyboard", main.AGENT_TOOLS["canvas_action"]["description"])


class RunTests(unittest.TestCase):
    def setUp(self):
        self.cid = new_canvas([video_node(), image_node("img", make_png(), 0, 400)])

    def _fake(self, table):
        async def fake(payload):
            self.payload = payload
            return {"ok": True, "text": "", "table": table, "template": payload.template, "model": "m", "prompt": ""}
        return mock.patch.object(main, "canvas_analyze_media", fake)

    def test_builds_table_right_of_video(self):
        with self._fake({"columns": COLUMNS, "rows": ROWS}):
            res = run({"canvas_id": self.cid, "action": "parse_storyboard", "node_id": "v", "params": {"template": "ecom"}})
        self.assertEqual((self.payload.kind, self.payload.video_url, self.payload.template, self.payload.table_only),
                         ("video", "/output/clip.mp4", "ecom", True))
        self.assertEqual((res["status"], res["shots"], res["generation_units"]), ("done", 2, 0))
        canvas = main.load_canvas(self.cid)
        node = main._agent_find_node(canvas, res["node_id"])
        t = node["data"]["table"]
        self.assertEqual((node["kind"], t["title"], t["columns"], t["rows"]), ("table", "解析 · 分镜表", COLUMNS, ROWS))
        self.assertEqual(t["roles"][COLUMNS.index("起止")], "skip")
        self.assertEqual(t["view"], "card")
        self.assertGreaterEqual(node["x"], 360, "放在视频右边")
        self.assertEqual((node["w"], node["h"]), (1240, 360))
        self.assertTrue(any(c.get("from") == "v" and c.get("to") == node["id"] for c in canvas["connections"]))

    def test_old_table_without_frames_stays_grid(self):
        with self._fake({"columns": ["镜号", "画面描述"], "rows": [["1", "a"]]}):
            res = run({"canvas_id": self.cid, "action": "parse_storyboard", "node_id": "v"})
        t = main._agent_find_node(main.load_canvas(self.cid), res["node_id"])["data"]["table"]
        self.assertNotIn("view", t)
        self.assertNotIn("roles", t)

    def test_errors(self):
        with self._fake(None), self.assertRaises(main.AgentToolError):
            run({"canvas_id": self.cid, "action": "parse_storyboard", "node_id": "v"})
        with self._fake({"columns": COLUMNS, "rows": ROWS}), self.assertRaises(main.AgentToolError):
            run({"canvas_id": self.cid, "action": "parse_storyboard", "node_id": "img"})

        async def boom(payload):
            raise main.HTTPException(status_code=502, detail="调用视觉模型出错")
        with mock.patch.object(main, "canvas_analyze_media", boom), self.assertRaises(main.AgentToolError) as ctx:
            run({"canvas_id": self.cid, "action": "parse_storyboard", "node_id": "v"})
        self.assertIn("调用视觉模型出错", str(ctx.exception))
        nodes = main.load_canvas(self.cid)["nodes"]
        self.assertEqual(len(nodes), 2, "失败时不落空表")


if __name__ == "__main__":
    unittest.main()
