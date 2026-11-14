# -*- coding: utf-8 -*-
"""depth_capture 画布助手工具：本机深度模块缺失时只报「不可用」不报错；可用时转出 depth_url。"""
import asyncio
import os
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

_TMP = tempfile.mkdtemp(prefix="novai-depth-tool-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


def run(args):
    tool = main.AGENT_TOOLS["depth_capture"]
    return asyncio.run(tool["run"](tool["validate"](args)))


class AgentDepthCaptureToolTests(unittest.TestCase):

    def test_registered_read_only(self):
        tool = main.AGENT_TOOLS["depth_capture"]
        self.assertFalse(tool["mutates_canvas"])
        self.assertIn("depth_capture", main.AGENT_RUN_STEP_FREE_TOOLS)

    def test_requires_target_unless_check_only(self):
        with self.assertRaises(main.AgentToolError):
            main.AGENT_TOOLS["depth_capture"]["validate"]({})
        self.assertTrue(main.AGENT_TOOLS["depth_capture"]["validate"]({"check_only": True})["check_only"])

    def test_missing_module_reports_not_ready(self):
        with mock.patch.object(main, "_agent_depth_capture_module", return_value=(None, "没有安装")):
            result = run({"check_only": True})
            self.assertFalse(result["ready"])
            self.assertIn("没有安装", result["message"])
            # 不可用时即使给了视频也不报错，只返回原因，技能走备选来源
            self.assertFalse(run({"url": "/output/x.mp4"})["ready"])

    def test_converts_local_video(self):
        src = main.output_path_for("depth_src_test.mp4", "output")
        Path(src).write_bytes(b"x")
        calls = {}

        def capture_video(ffmpeg, s, dst, *, max_seconds=30.0, keep_audio=True):
            calls.update(src=s, max_seconds=max_seconds, keep_audio=keep_audio)
            Path(dst).write_bytes(b"d")
            return {"path": dst, "frames": 48, "duration": 2.0, "width": 720, "height": 1280}, ""

        fake = types.SimpleNamespace(available=lambda ffmpeg: (True, ""), capture_video=capture_video)
        with mock.patch.object(main, "_agent_depth_capture_module", return_value=(fake, "")):
            self.assertTrue(run({"check_only": True})["ready"])
            result = run({"url": main.output_url_for("depth_src_test.mp4", "output")})
        self.assertTrue(result["ready"])
        self.assertTrue(result["depth_url"].startswith(("/output/", "/assets/")))
        self.assertEqual(result["frames"], 48)
        self.assertEqual(calls["max_seconds"], 30.0)
        self.assertFalse(calls["keep_audio"])

    def test_rejects_remote_url(self):
        fake = types.SimpleNamespace(available=lambda ffmpeg: (True, ""), capture_video=None)
        with mock.patch.object(main, "_agent_depth_capture_module", return_value=(fake, "")):
            with self.assertRaises(main.AgentToolError):
                run({"url": "https://example.com/a.mp4"})


if __name__ == "__main__":
    unittest.main()


class BeatVideoNodeBoxTests(unittest.TestCase):

    def test_video_node_box_follows_source_ratio(self):
        import subprocess
        ffmpeg = main.ffmpeg_binary()
        if not ffmpeg:
            self.skipTest("no ffmpeg")
        path = main.output_path_for("box_test_square.mp4", "output")
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=480x480:d=1",
                        "-pix_fmt", "yuv420p", path], check=True)
        node = main._agent_beat_new_node("video", 0, 0, url=main.output_url_for("box_test_square.mp4", "output"))
        self.assertEqual(node["w"], node["h"])
        self.assertEqual(node["data"]["gen"]["hist"][0]["w"], 480)
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=1280x720:d=1",
                        "-pix_fmt", "yuv420p", path], check=True)
        node = main._agent_beat_new_node("video", 0, 0, url=main.output_url_for("box_test_square.mp4", "output"))
        self.assertAlmostEqual(node["w"] / node["h"], 16 / 9, places=1)
