# -*- coding: utf-8 -*-
"""Hypit 视频复刻（画布版）技能包 + analyze_video 的读视频模块（/tmp 隔离，不碰正式数据）。"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-hypit-pack-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

from server.skills import registry  # noqa: E402
from server.agent_core import video_reader  # noqa: E402

HYPIT_PACK = ROOT / "server" / "skills" / "builtin_packs" / "hypit"
# 画布助手没有这些东西：技能正文里一旦让它去调，就会卡住 / 瞎编
FORBIDDEN_INSTRUCTIONS = ("hypit auth", "hypit build", "npx skills", "references/", "--follow", "python3 ")


def tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


class HypitPackTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-hypit-case-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self._previous = registry._DATA_DIR
        registry.set_data_dir(os.path.join(self.root, "data"))
        self.addCleanup(registry.set_data_dir, self._previous)

    def skill(self):
        for item in registry.load_skills():
            if item["id"] == "hypit":
                return item
        self.fail("hypit 内置技能没有装上")

    def test_canvas_runtime_prompt_has_no_script_header(self):
        prompt = self.skill()["skill_prompt"]
        self.assertFalse(prompt.startswith("技能根目录"), prompt[:60])
        self.assertTrue(prompt.startswith("# Hypit 视频复刻"), prompt[:60])

    def test_prompt_fits_and_uses_canvas_tools(self):
        prompt = self.skill()["skill_prompt"]
        self.assertLess(len(prompt), 20000)                 # 不会被 activate_skill / 技能注入截断
        for tool in ("analyze_video", "generate_image", "generate_video", "type=audio", "type=timeline"):
            self.assertIn(tool, prompt)
        for bad in FORBIDDEN_INSTRUCTIONS:
            self.assertNotIn(bad, prompt)

    def test_license_and_attribution_kept(self):
        self.assertTrue((HYPIT_PACK / "LICENSE").is_file())
        self.assertIn("Hypit.AI", self.skill()["skill_prompt"])

    def test_builtin_pack_defaults_disabled_until_added(self):
        self.assertFalse(self.skill()["enabled"])


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "需要 ffmpeg / ffprobe")
class VideoReaderTests(unittest.TestCase):

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-video-reader-")
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.video = os.path.join(self.root, "ref.mp4")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                        "-f", "lavfi", "-i", "testsrc=size=360x640:rate=25:duration=8",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
                        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", self.video],
                       check=True)
        self.calls = []

    async def _fake_asr(self, audio_path, prompt):
        self.calls.append(audio_path)
        self.assertTrue(os.path.isfile(audio_path))
        self.assertIn("[mm:ss]", prompt)
        return {"ok": True, "text": "[00:00] 第一句\n[00:03] 第二句"}

    def read(self, **kwargs):
        return asyncio.run(video_reader.read_video(
            self.video, os.path.join(self.root, "out"), "/output/r", shutil.which("ffmpeg"),
            shutil.which("ffprobe"), self._fake_asr, **kwargs))

    def test_full_read_frames_grid_transcript(self):
        result = self.read(frames=8)
        self.assertAlmostEqual(result["duration"], 8.0, delta=0.2)
        self.assertEqual(result["aspect"], "360:640")
        self.assertEqual(len(result["frames"]), 8)
        self.assertTrue(result["grid_url"].startswith("/output/r/"))
        self.assertTrue(result["transcript"]["ok"])
        self.assertIn("[00:03] 第二句", result["transcript"]["text"])

    def test_cache_and_range_shift(self):
        self.read(frames=8)
        self.read(frames=8)
        self.assertEqual(len(self.calls), 1)                 # 同一区间只转写一次
        part = self.read(frames=4, start=4, end=8)
        self.assertEqual(part["range"], [4.0, 8.0])
        self.assertTrue(all(4 <= f["seconds"] <= 8 for f in part["frames"]))
        self.assertIn("[00:07] 第二句", part["transcript"]["text"])   # 区间时间换成全片时间

    def test_frame_count_clamped_and_skip_transcript(self):
        result = self.read(frames=99, want_transcript=False)
        self.assertEqual(len(result["frames"]), video_reader.FRAMES_MAX)
        self.assertTrue(result["transcript"].get("skipped"))
        self.assertEqual(self.calls, [])

    def test_cuts_and_clip(self):
        result = self.read(frames=4, want_transcript=False)
        self.assertIn("cuts", result)
        self.assertTrue(result["cuts_note"])
        clip = self.read(frames=4, start=2, end=6, want_transcript=False, want_clip=True)
        self.assertTrue(clip["clip_url"].endswith("/clip.mp4"))
        with self.assertRaises(video_reader.VideoReadError):
            self.read(frames=4, start=1, end=2, want_transcript=False, want_clip=True)   # 不足 2 秒

    def test_missing_ffmpeg_is_explicit(self):
        with self.assertRaises(video_reader.VideoReadError):
            asyncio.run(video_reader.read_video(self.video, self.root, "/o", "", "", self._fake_asr))


if __name__ == "__main__":
    unittest.main()
