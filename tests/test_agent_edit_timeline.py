# -*- coding: utf-8 -*-
"""画布助手剪辑时间线工具 edit_timeline + 自动字幕的时间解析。

覆盖：
  1. list：按轨道:序号列出片段，吸附轨按转场重叠排位（和前端 timelineModel 一致）；
  2. split / remove / trim / move / transition / volume / subtitle / overlay / color / duck；
  3. clip 用「轨道:序号」或 id 引用，找不到时报错带提示；
  4. parse_subtitle_lines：[秒-秒] / [分:秒-分:秒] 两种写法、时间倒退修正、「无」跳过。
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

_TMP_DATA = tempfile.mkdtemp(prefix="novai-edit-timeline-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main
from server.integrations.asr import parse_subtitle_lines


def tearDownModule():
    shutil.rmtree(_TMP_DATA, ignore_errors=True)


def _clip(cid, order, a=0, b=4, **extra):
    return dict({"id": cid, "sourceNodeId": "", "url": "/assets/%s.mp4" % cid, "mediaKind": "video",
                 "inPoint": a, "outPoint": b, "order": order, "srcDur": 10, "title": cid}, **extra)


def _canvas():
    return {"nodes": [
        {"id": "pip", "kind": "video", "x": 0, "y": 0, "w": 200, "h": 120, "url": "/assets/pip.mp4",
         "data": {"gen": {"title": "画中画素材", "hist": [{"url": "/assets/pip.mp4", "dur": 6}], "hi": 0}}},
        {"id": "tl", "kind": "timeline", "x": 0, "y": 0, "w": 760, "h": 540, "clips": [
            _clip("a", 0), _clip("b", 1), _clip("c", 2),
            dict(_clip("m", 0, 0, 12), mediaKind="audio", title="配乐"),
        ]},
    ], "connections": []}


class EditTimelineTest(unittest.TestCase):
    def run_ops(self, ops, cv=None):
        cv = cv or _canvas()
        made = {}

        def fake_mutate(canvas_id, mutate):
            work = copy.deepcopy(cv)
            mutate(work)
            made["canvas"] = work
            return work, None

        args = main._agent_tool_edit_timeline_validate({"canvas_id": "c1", "ops": ops})
        with patch.object(main, "_agent_mutate_canvas", side_effect=fake_mutate):
            result = main._agent_tool_edit_timeline_run(args)
        tl = next(n for n in made["canvas"]["nodes"] if n["id"] == "tl")
        return result, tl["clips"], made["canvas"]

    def test_list_places_snap_track_with_overlap(self):
        cv = _canvas()
        cv["nodes"][1]["clips"][1]["trans"] = "dissolve"
        cv["nodes"][1]["clips"][1]["transMs"] = 1000
        result, _, _ = self.run_ops([{"op": "list"}], cv)
        rows = {r["ref"]: r for r in result["clips"]}
        self.assertEqual(rows["video:2"]["start"], 3.0)  # 溶解提前 1 秒进场
        self.assertEqual(rows["video:3"]["start"], 7.0)
        self.assertEqual(result["duration"], 12.0)
        self.assertFalse(result["changed"])

    def test_split_remove_trim_move(self):
        result, clips, _ = self.run_ops([
            {"op": "split", "at": 2, "clip": "video:1"},
            {"op": "remove", "clip": "video:3"},
            {"op": "trim", "clip": "c", "in": 1, "out": 3},
            {"op": "move", "clip": "c", "to": 1},
        ])
        video = sorted([c for c in clips if c.get("mediaKind") == "video"], key=lambda c: c["order"])
        self.assertEqual([c["id"] for c in video][0], "c")
        self.assertEqual((video[0]["inPoint"], video[0]["outPoint"]), (1, 3))
        self.assertNotIn("b", [c["id"] for c in video])     # 切开后 b 变成第 3 段，被删掉
        self.assertEqual(len(video), 3)
        self.assertTrue(result["changed"])

    def test_transition_volume_subtitle_overlay_color_duck(self):
        _, clips, cv = self.run_ops([
            {"op": "transition", "clip": "video:2", "kind": "wipe", "ms": 800},
            {"op": "volume", "clip": "a", "value": 0},
            {"op": "subtitle", "text": "第一句", "start": 0.5, "end": 2},
            {"op": "overlay", "node": "pip", "start": 1, "x": 0.8, "y": 0.2, "s": 0.3},
            {"op": "color", "clip": "a", "saturation": 0},
            {"op": "duck", "clip": "audio:1", "level": 0.25},
        ])
        by = {c["id"]: c for c in clips}
        self.assertEqual((by["b"]["trans"], by["b"]["transMs"]), ("wipe", 800))
        self.assertEqual(by["a"]["volume"], 0)
        self.assertEqual(by["a"]["color"]["s"], 0)
        self.assertEqual(by["m"]["duck"], 0.25)
        sub = next(c for c in clips if c.get("type") == "subtitle")
        self.assertEqual((sub["text"], sub["start"], sub["end"]), ("第一句", 0.5, 2))
        pip = next(c for c in clips if c.get("layer") == "overlay")
        self.assertEqual((pip["start"], pip["srcDur"], pip["tf"]["s"]), (1, 6, 0.3))
        self.assertIn({"from": "pip", "to": "tl"}, [{"from": e.get("from"), "to": e.get("to")} for e in cv["connections"]])

    def test_format_preset_and_manual(self):
        result, _, cv = self.run_ops([{"op": "format", "preset": "xiaohongshu"}])
        tl = next(n for n in cv["nodes"] if n["id"] == "tl")
        self.assertEqual((tl["ratio"], tl["data"]["tlRes"]), ("3:4", "1080p"))
        self.assertEqual((result["ratio"], result["res"]), ("3:4", "1080p"))
        _, _, cv = self.run_ops([{"op": "format", "ratio": "9:16", "res": "4K"}])
        tl = next(n for n in cv["nodes"] if n["id"] == "tl")
        self.assertEqual((tl["ratio"], tl["data"]["tlRes"]), ("9:16", "4K"))
        with self.assertRaises(main.AgentToolError):
            self.run_ops([{"op": "format", "preset": "tiktokx"}])
        with self.assertRaises(main.AgentToolError):
            self.run_ops([{"op": "format", "ratio": "7:5"}])

    def test_bad_ref_and_bad_split(self):
        with self.assertRaises(main.AgentToolError):
            self.run_ops([{"op": "remove", "clip": "video:9"}])
        with self.assertRaises(main.AgentToolError):
            self.run_ops([{"op": "split", "at": 4.0, "clip": "a"}])   # 正好在段尾，不能切
        with self.assertRaises(main.AgentToolError):
            main._agent_tool_edit_timeline_validate({"canvas_id": "c1", "ops": []})


class SubtitleParseTest(unittest.TestCase):
    def test_formats_and_fixups(self):
        text = "[0.0-2.4] 大家好\n[00:02.6-00:05.1] 鞋面是透气网布\n[4.8-4.0] 时间倒退\n无\n乱七八糟的行"
        segs = parse_subtitle_lines(text, total=10)
        self.assertEqual(segs[0], {"start": 0.0, "end": 2.4, "text": "大家好"})
        self.assertEqual((segs[1]["start"], segs[1]["end"]), (2.6, 5.1))
        self.assertEqual(segs[2]["start"], 5.1)          # 和上一句重叠的往后推
        self.assertGreater(segs[2]["end"], segs[2]["start"])
        self.assertEqual(len(segs), 3)
        self.assertEqual(parse_subtitle_lines("[0.0-1.0] 无"), [])


if __name__ == "__main__":
    unittest.main()
