# -*- coding: utf-8 -*-
"""选中 / @ 视频节点时，运行开始前自动读视频（关键帧网格 + 口播），交给模型。

覆盖：
- 只挑选中 / 引用里的视频节点，图片节点跳过，最多 AGENT_AUTO_VIDEO_MAX 个；
- 读到的时长 / 切点 / 口播 / 关键帧地址进模型消息，网格图挂进看图；
- 读失败只降级成一句说明，运行照常结束；
- NOVAI_AGENT_AUTO_VIDEO=0 时不读。
"""
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
    _TMP = tempfile.mkdtemp(prefix="novai-auto-video-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402
from tests.test_agent_fix_main_wiring import chat_config, flags, make_req, run_producer  # noqa: E402

VIDEO_URL = "https://example.invalid/auto-video-src.mp4"
IMAGE_URL = "https://example.invalid/auto-video-poster.png"
GRID_URL = "/output/agent_video_reader/abc/grid.jpg"


def canvas_with_videos(canvas_id):
    def video(nid, title, url=VIDEO_URL):
        return {"id": nid, "kind": "video", "x": 0, "y": 0,
                "data": {"gen": {"title": title, "prompt": "", "hist": [{"url": url}], "hi": 0}}}
    return {"id": canvas_id, "title": "自动读视频", "kind": "beat",
            "updated_at": int(main.time.time() * 1000),
            "nodes": [
                {"id": "img1", "kind": "image", "x": 0, "y": 300,
                 "data": {"gen": {"title": "海报", "prompt": "海报", "hist": [{"url": IMAGE_URL}], "hi": 0}}},
                video("v1", "爆款原片"), video("v2", "第二条"), video("v3", "第三条"),
            ],
            "connections": []}


def fake_result():
    return {"duration": 12.5, "aspect": "1080:1920", "width": 1080, "height": 1920,
            "cuts": [{"seconds": 3.2, "time": "00:03.2"}, {"seconds": 7.9, "time": "00:07.9"}],
            "frames": [{"index": 1, "time": "00:00.0", "url": "/output/agent_video_reader/abc/f01.jpg"}],
            "grid_url": GRID_URL, "first_frame_url": "/output/x/first.jpg", "last_frame_url": "/output/x/last.jpg",
            "transcript": {"ok": True, "text": "[00:01] 这双靴子防水又保暖", "error": ""}}


def flat_text(messages):
    out = []
    for msg in messages or []:
        content = msg.get("content")
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            for part in content:
                if part.get("type") == "text":
                    out.append(part.get("text") or "")
                elif part.get("type") == "image_url":
                    out.append("[IMAGE]")
    return "\n".join(out)


class FocusVideoPickTests(unittest.TestCase):
    def test_picks_selected_and_referenced_videos_only(self):
        canvas = canvas_with_videos("c-pick")
        focus = main._agent_run_normalize_focus({
            "selected_node_ids": ["img1", "v2"],
            "references": [{"id": "v1", "source": "node"}, {"id": "v3", "source": "node"}]})
        ids = main._agent_focus_video_node_ids(focus, canvas)
        self.assertEqual(ids, ["v2", "v1"], "图片跳过、按出现顺序、最多 2 个")

    def test_no_focus_no_videos(self):
        canvas = canvas_with_videos("c-none")
        self.assertEqual(main._agent_focus_video_node_ids(main._agent_run_normalize_focus(None), canvas), [])

    def test_note_has_duration_cuts_transcript_and_frames(self):
        note = main._agent_auto_video_note("爆款原片", fake_result())
        for piece in ("爆款原片", "12.5 秒", "1080:1920", "2 个硬切点", "00:03.2", "防水又保暖",
                      "f01.jpg", "first.jpg", "analyze_video"):
            self.assertIn(piece, note)


class ProducerAutoVideoTests(unittest.TestCase):
    def setUp(self):
        self.canvas_id = "c-autovideo-" + uuid.uuid4().hex[:8]
        main.save_canvas(canvas_with_videos(self.canvas_id))
        self.calls = []
        self.seen = {}

    def _req(self):
        req = make_req(self.canvas_id, chat=chat_config(), renderer="beat")
        req["focus"] = main._agent_run_normalize_focus({"selected_node_ids": ["v1"]})
        req["instruction"] = "照这个视频的节奏给我的靴子也做一条"
        return req

    async def _fake_decide_v2(self, chat, messages, canvas_id, tools_json_text="", tools=None, rebuild_json=None):
        self.seen.setdefault("messages", messages)
        return {"done": True, "message": "完成"}

    def _run(self, analyze, extra_flags=None):
        async def fake_analyze(args):
            self.calls.append(args)
            return await analyze(args)
        with flags(CONTEXT="1", **(extra_flags or {})), \
                patch.object(main, "_agent_tool_analyze_video_run", new=fake_analyze), \
                patch.object(main, "_agent_run_decide_v2", new=self._fake_decide_v2), \
                patch.object(main, "reference_to_data_url", new=lambda ref, max_size=None: "data:image/png;base64,AAAA"):
            return run_producer(self._req())

    def test_selected_video_is_read_and_given_to_model(self):
        async def ok(args):
            return fake_result()
        events = self._run(ok)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["node_id"], "v1")
        flat = flat_text(self.seen.get("messages"))
        self.assertIn("已自动读取视频「爆款原片」", flat)
        self.assertIn("防水又保暖", flat)
        self.assertIn("[IMAGE]", flat, "关键帧网格图要挂进看图")
        done = [e for e in events if e["event"] == "done"][-1]["data"]
        self.assertEqual(done.get("status"), "ok")

    def test_read_failure_degrades_to_note(self):
        async def boom(args):
            raise main.AgentToolError("本机没有 ffmpeg", code="video_failed")
        events = self._run(boom)
        flat = flat_text(self.seen.get("messages"))
        self.assertIn("自动读取失败", flat)
        self.assertIn("本机没有 ffmpeg", flat)
        done = [e for e in events if e["event"] == "done"][-1]["data"]
        self.assertEqual(done.get("status"), "ok", "读视频失败不能让整个运行失败")

    def test_switch_off_skips_reading(self):
        async def ok(args):
            return fake_result()
        self._run(ok, extra_flags={"NOVAI_AGENT_AUTO_VIDEO": "0"})
        self.assertEqual(self.calls, [])
        self.assertNotIn("已自动读取视频", flat_text(self.seen.get("messages")))


if __name__ == "__main__":
    unittest.main()
