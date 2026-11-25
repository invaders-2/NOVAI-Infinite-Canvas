# -*- coding: utf-8 -*-
"""画布助手剪辑时间线工具 edit_timeline + 自动字幕的时间解析。

工具现在只给建议、不直接改片子：node.clips 一个字都不动，算好的「应用后片段」连同「应用前片段」
写进 node.data.tlSugs（kind=agent / state=pending），用户在建议轨点 ✓ 才由前端整份替换。

覆盖：
  1. list：按轨道:序号列出片段，吸附轨按转场重叠排位（和前端 timelineModel 一致）；
  2. split / remove / trim / move / transition / volume / subtitle / overlay / color / duck / format
     都只产出建议：画布 clips 不变、tlSugs 多一条 pending、payload 里 before / after 都在；
  3. 同一轮多次调用并进同一条 pending 建议（不新增卡片），payload.clips 体现累积操作；clip 用「轨道:序号」或 id 引用，找不到时报错带提示；
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


def _sugs(tl):
    return (tl.get("data") or {}).get("tlSugs") or []


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
        return result, tl, made["canvas"]

    def test_list_places_snap_track_with_overlap(self):
        cv = _canvas()
        cv["nodes"][1]["clips"][1]["trans"] = "dissolve"
        cv["nodes"][1]["clips"][1]["transMs"] = 1000
        result, tl, _ = self.run_ops([{"op": "list"}], cv)
        rows = {r["ref"]: r for r in result["clips"]}
        self.assertEqual(rows["video:2"]["start"], 3.0)  # 溶解提前 1 秒进场
        self.assertEqual(rows["video:3"]["start"], 7.0)
        self.assertEqual(result["duration"], 12.0)
        self.assertFalse(result["changed"])
        self.assertFalse(result["suggested"])
        self.assertEqual(_sugs(tl), [])
        self.assertEqual([c["id"] for c in tl["clips"]], ["a", "b", "c", "m"])

    def test_split_remove_trim_move_only_suggests(self):
        result, tl, _ = self.run_ops([
            {"op": "split", "at": 2, "clip": "video:1"},
            {"op": "remove", "clip": "video:2"},
            {"op": "trim", "clip": "c", "in": 1, "out": 3},
            {"op": "move", "clip": "c", "to": 1},
        ])
        # 文档里的 clips 一个字都没动，返回给模型的也是当前（未应用）的片段
        self.assertEqual([c["id"] for c in tl["clips"]], ["a", "b", "c", "m"])
        self.assertEqual([r["ref"] for r in result["clips"]], ["video:1", "video:2", "video:3", "audio:1"])
        self.assertEqual(result["duration"], 12.0)
        self.assertFalse(result["changed"])
        self.assertTrue(result["suggested"])
        self.assertIn("已生成建议（未应用）", result["message"])
        self.assertIn("时间线还没有变", result["message"])
        [sug] = _sugs(tl)
        self.assertEqual((sug["kind"], sug["state"]), ("agent", "pending"))
        self.assertEqual(sug["label"], "助手 · 切开 1 处、删掉 1 段、修剪 1 段 等 4 项")
        # 序号按调用开始时的画布解析：remove video:2 = base 的 b（不是切开后位移的第 2 段）
        self.assertEqual((sug["from"], sug["to"]), (2.0, 8.0))
        self.assertEqual(result["suggestion"]["id"], sug["id"])
        self.assertEqual([o["op"] for o in sug["payload"]["ops"]], ["split", "remove", "trim", "move"])
        self.assertEqual([o["clip"] for o in sug["payload"]["ops"]], ["a", "b", "c", "c"])
        self.assertTrue(all(o.get("_resolved") for o in sug["payload"]["ops"]))
        # before / after 两份快照都在建议里
        self.assertEqual(sug["payload"]["prev"], tl["clips"])
        video = sorted([c for c in sug["payload"]["clips"] if c.get("mediaKind") == "video"], key=lambda c: c["order"])
        self.assertEqual([c["id"] for c in video][0], "c")
        self.assertEqual((video[0]["inPoint"], video[0]["outPoint"]), (1, 3))
        self.assertNotIn("b", [c["id"] for c in video])     # b 就是 base 的 video:2，被删掉
        self.assertEqual(len(video), 3)                     # 切开产生的第二段还在（没有被序号带偏）

    def test_transition_volume_subtitle_overlay_color_duck_only_suggests(self):
        result, tl, cv = self.run_ops([
            {"op": "transition", "clip": "video:2", "kind": "wipe", "ms": 800},
            {"op": "volume", "clip": "a", "value": 0},
            {"op": "subtitle", "text": "第一句", "start": 0.5, "end": 2},
            {"op": "overlay", "node": "pip", "start": 1, "x": 0.8, "y": 0.2, "s": 0.3},
            {"op": "color", "clip": "a", "saturation": 0},
            {"op": "duck", "clip": "audio:1", "level": 0.25},
        ])
        # 画布 / 连线都没被提前改：来源连线等用户采纳后由前端 syncTimelineEdges 补
        self.assertEqual([c["id"] for c in tl["clips"]], ["a", "b", "c", "m"])
        self.assertEqual(cv["connections"], [])
        [sug] = _sugs(tl)
        self.assertEqual((sug["from"], sug["to"]), (0.0, 12.0))
        clips = sug["payload"]["clips"]
        by = {c["id"]: c for c in clips}
        self.assertEqual((by["b"]["trans"], by["b"]["transMs"]), ("wipe", 800))
        self.assertEqual(by["a"]["volume"], 0)
        self.assertEqual(by["a"]["color"]["s"], 0)
        self.assertEqual(by["m"]["duck"], 0.25)
        self.assertNotIn("volume", next(c for c in tl["clips"] if c["id"] == "a"))
        sub = next(c for c in clips if c.get("type") == "subtitle")
        self.assertEqual((sub["text"], sub["start"], sub["end"]), ("第一句", 0.5, 2))
        pip = next(c for c in clips if c.get("layer") == "overlay")
        self.assertEqual((pip["start"], pip["srcDur"], pip["tf"]["s"]), (1, 6, 0.3))
        self.assertEqual(result["suggested"], True)
        self.assertEqual(len(_sugs(tl)), 1)

    def test_format_preset_and_manual(self):
        result, tl, _ = self.run_ops([{"op": "format", "preset": "xiaohongshu"}])
        # 画幅 / 清晰度也不再直接写进去，跟着建议一起等确认
        self.assertIsNone(tl.get("ratio"))
        self.assertNotIn("tlRes", tl.get("data") or {})
        [sug] = _sugs(tl)
        self.assertEqual((sug["payload"]["ratio"], sug["payload"]["res"]), ("3:4", "1080p"))
        self.assertEqual(sug["label"], "助手 · 成片 3:4 · 1080p")
        self.assertEqual((sug["from"], sug["to"]), (0.0, 12.0))
        self.assertEqual((result["ratio"], result["res"]), ("16:9", "1080p"))

        result, tl, _ = self.run_ops([{"op": "format", "ratio": "9:16", "res": "4K"}])
        self.assertIsNone(tl.get("ratio"))
        [sug] = _sugs(tl)
        self.assertEqual((sug["payload"]["ratio"], sug["payload"]["res"]), ("9:16", "4K"))
        self.assertEqual((result["ratio"], result["res"]), ("16:9", "1080p"))

        with self.assertRaises(main.AgentToolError):
            self.run_ops([{"op": "format", "preset": "tiktokx"}])
        with self.assertRaises(main.AgentToolError):
            self.run_ops([{"op": "format", "ratio": "7:5"}])

    def test_repeated_calls_merge_into_single_pending(self):
        cv = _canvas()
        _, tl1, cv = self.run_ops([{"op": "split", "at": 2, "clip": "a"}], cv)
        _, tl2, cv = self.run_ops([{"op": "remove", "clip": "b"}], cv)
        self.assertEqual(len(_sugs(tl1)), 1)
        sugs = _sugs(tl2)
        self.assertEqual(len(sugs), 1)                       # 仍然只有一张卡
        sug = sugs[0]
        self.assertEqual(sug["id"], _sugs(tl1)[0]["id"])     # 还是同一张，不新增
        self.assertEqual(sug["label"], "助手 · 切开 1 处、删掉 1 段")
        self.assertEqual([o["op"] for o in sug["payload"]["ops"]], ["split", "remove"])
        ids = [c["id"] for c in sug["payload"]["clips"]]
        self.assertNotIn("b", ids)                            # 第二次的删除也体现在 after 里
        self.assertIn("a", ids)
        self.assertEqual([c["id"] for c in sug["payload"]["prev"]], ["a", "b", "c", "m"])  # prev 不变
        self.assertEqual([c["id"] for c in tl2["clips"]], ["a", "b", "c", "m"])            # 文档没变
        self.assertEqual((sug["from"], sug["to"]), (2.0, 8.0))  # 区间取并集

    def test_merge_resolves_track_ref_against_prev(self):
        cv = _canvas()
        _, _, cv = self.run_ops([{"op": "split", "at": 2, "clip": "a"}], cv)          # call1 用 id
        _, tl, cv = self.run_ops([{"op": "remove", "clip": "video:2"}], cv)           # call2 用序号
        [sug] = _sugs(tl)
        ops = sug["payload"]["ops"]
        # 序号在落库前解析成 id：video:2 是 base 的第 2 段 b，不是重放中间态里的第 2 段
        self.assertEqual(ops[1], {"op": "remove", "clip": "b", "_resolved": True})
        clips = sug["payload"]["clips"]
        ids = [c["id"] for c in clips]
        self.assertNotIn("b", ids)                       # 删掉的是 b
        self.assertEqual(len([c for c in clips if c.get("mediaKind") == "video"]), 3)
        self.assertEqual(len(ids), 4)                    # a + 切开产生的第二段 + c + m
        self.assertEqual([c["id"] for c in sug["payload"]["prev"]], ["a", "b", "c", "m"])

    def test_legacy_raw_ops_replay_with_index_refs(self):
        cv = _canvas()
        base = copy.deepcopy(cv["nodes"][1]["clips"])
        # 老数据：payload.ops 还是原始序号（没有 _resolved），prev 是当时画布上的片段
        cv["nodes"][1]["data"] = {"tlSugs": [{
            "id": "sug_legacy", "kind": "agent", "label": "助手 · 切开 1 处", "from": 2.0, "to": 8.0,
            "state": "pending",
            "payload": {"clips": [], "prev": base, "ops": [{"op": "split", "at": 2, "clip": "video:1"}]},
        }]}
        _, tl, cv = self.run_ops([{"op": "volume", "clip": "c", "value": 0.5}], cv)
        [sug] = _sugs(tl)
        ops = sug["payload"]["ops"]
        self.assertEqual(len(ops), 2)
        self.assertNotIn("_resolved", ops[0])            # 老 op 原样保留，走 _tl_find 的兼容路径
        self.assertEqual(ops[0]["clip"], "video:1")
        self.assertTrue(ops[1].get("_resolved"))
        self.assertEqual(ops[1]["clip"], "c")
        clips = sug["payload"]["clips"]
        self.assertEqual(len(clips), 5)                  # base 4 段 + 老 op 切开的一段
        self.assertEqual(next(c for c in clips if c["id"] == "c")["volume"], 0.5)
        self.assertEqual(sug["label"], "助手 · 切开 1 处、音量 50%")

    def test_merge_keeps_previous_format(self):
        cv = _canvas()
        _, _, cv = self.run_ops([{"op": "format", "preset": "xiaohongshu"}], cv)
        _, tl, cv = self.run_ops([{"op": "split", "at": 2, "clip": "a"}], cv)
        [sug] = _sugs(tl)
        self.assertEqual((sug["payload"]["ratio"], sug["payload"]["res"]), ("3:4", "1080p"))
        self.assertEqual(sug["label"], "助手 · 成片 3:4 · 1080p、切开 1 处")

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
