# -*- coding: utf-8 -*-
"""extract_audio 画布助手工具：把本地视频原声抽成音频节点，供复刻成片沿用原声。"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_TMP = tempfile.mkdtemp(prefix="novai-extract-audio-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def run(args):
    tool = main.AGENT_TOOLS["extract_audio"]
    return asyncio.run(tool["run"](tool["validate"](args)))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "需要 ffmpeg")
class ExtractAudioToolTests(unittest.TestCase):

    def make_video(self, name, audio=True):
        path = main.output_path_for(name, "output")
        cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2"]
        if audio:
            cmd += ["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-shortest"]
        subprocess.run(cmd + [path], check=True)
        return main.output_url_for(name, "output")

    def setUp(self):
        self.canvas = {"nodes": [], "connections": []}
        saved = {}

        def mutate(cid, fn):
            fn(self.canvas)
            saved["c"] = self.canvas
            return self.canvas, None

        for target, kw in (("load_canvas", {"side_effect": lambda cid: self.canvas}),
                           ("_agent_mutate_canvas", {"side_effect": mutate})):
            p = mock.patch.object(main, target, **kw)
            p.start()
            self.addCleanup(p.stop)

    def test_registered(self):
        self.assertIn("extract_audio", main.AGENT_RUN_STEP_FREE_TOOLS)
        with self.assertRaises(main.AgentToolError):
            main.AGENT_TOOLS["extract_audio"]["validate"]({"canvas_id": "c"})
        with self.assertRaises(main.AgentToolError):
            main.AGENT_TOOLS["extract_audio"]["validate"]({"canvas_id": "c", "url": "/x.mp4", "start": 3, "end": 1})

    def test_extracts_audio_node(self):
        url = self.make_video("ea_src.mp4")
        self.canvas["nodes"].append({"id": "v1", "kind": "video", "url": url, "text": "原视频"})
        result = run({"canvas_id": "c", "node_id": "v1", "start": 0.5, "end": 1.5})
        self.assertTrue(result["audio_url"].endswith(".m4a"))
        self.assertAlmostEqual(result["duration"], 1.0, delta=0.15)
        node = [n for n in self.canvas["nodes"] if n["id"] == result["node_id"]][0]
        self.assertEqual(node["kind"], "audio")
        self.assertEqual(node["url"], result["audio_url"])
        self.assertIn({"v1", node["id"]} , [{c.get("from") or c.get("source"), c.get("to") or c.get("target")}
                                             for c in self.canvas["connections"]])

    def test_video_without_audio_reports(self):
        url = self.make_video("ea_silent.mp4", audio=False)
        with self.assertRaises(main.AgentToolError) as ctx:
            run({"canvas_id": "c", "url": url})
        self.assertIn("没有声音", ctx.exception.message)


if __name__ == "__main__":
    unittest.main()
