import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


HAS_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


class PlanVideoSegmentsTests(unittest.TestCase):
    """纯函数：段规划 / 参数 clamp（不碰文件系统）。"""

    def test_exact_multiple_has_no_empty_tail(self):
        segments, truncated = main.plan_video_segments(9.0, 3.0, 30)
        self.assertFalse(truncated)
        self.assertEqual(
            [(s["index"], s["start"], s["end"], s["duration"]) for s in segments],
            [(1, 0.0, 3.0, 3.0), (2, 3.0, 6.0, 3.0), (3, 6.0, 9.0, 3.0)],
        )

    def test_tail_shorter_than_one_second_merges_into_previous(self):
        segments, truncated = main.plan_video_segments(6.5, 3.0, 30)
        self.assertFalse(truncated)
        self.assertEqual([(s["start"], s["end"]) for s in segments], [(0.0, 3.0), (3.0, 6.5)])
        self.assertEqual(segments[-1]["duration"], 3.5)

    def test_tail_not_shorter_than_one_second_stays(self):
        segments, truncated = main.plan_video_segments(8.4, 3.0, 30)
        self.assertFalse(truncated)
        self.assertEqual([s["duration"] for s in segments], [3.0, 3.0, 2.4])
        self.assertEqual(segments[-1]["end"], 8.4)

    def test_video_shorter_than_step_is_single_segment(self):
        segments, truncated = main.plan_video_segments(2.0, 3.0, 30)
        self.assertFalse(truncated)
        self.assertEqual([(s["start"], s["end"], s["duration"]) for s in segments], [(0.0, 2.0, 2.0)])

    def test_one_second_step_merges_short_tail(self):
        # 8.4s 按 1s 切：尾段 0.4s < 1s 并进上一段 → 8 段（末段 1.4s），不是 9 段
        segments, truncated = main.plan_video_segments(8.4, 1.0, 30)
        self.assertFalse(truncated)
        self.assertEqual(len(segments), 8)
        self.assertEqual([s["duration"] for s in segments], [1.0] * 7 + [1.4])
        self.assertEqual((segments[-1]["start"], segments[-1]["end"]), (7.0, 8.4))

    def test_max_segments_truncates_to_prefix(self):
        segments, truncated = main.plan_video_segments(33.0, 3.0, 5)
        self.assertTrue(truncated)
        self.assertEqual(len(segments), 5)
        self.assertEqual([s["start"] for s in segments], [0.0, 3.0, 6.0, 9.0, 12.0])

    def test_seconds_clamp(self):
        self.assertEqual(main.clamp_video_segment_seconds(0.2), 1.0)
        self.assertEqual(main.clamp_video_segment_seconds(99), 5.0)
        self.assertEqual(main.clamp_video_segment_seconds(3.4), 3.4)
        self.assertEqual(main.clamp_video_segment_seconds(None), 3.0)
        self.assertEqual(main.clamp_video_segment_seconds("abc"), 3.0)
        self.assertEqual(main.clamp_video_segment_seconds(float("nan")), 3.0)
        segments, _ = main.plan_video_segments(8.4, 99, 30)
        self.assertEqual([s["duration"] for s in segments], [5.0, 3.4])

    def test_max_segments_clamp(self):
        self.assertEqual(main.clamp_video_segment_max_segments(0), 1)
        self.assertEqual(main.clamp_video_segment_max_segments(999), 60)
        self.assertEqual(main.clamp_video_segment_max_segments(None), 30)
        self.assertEqual(main.clamp_video_segment_max_segments("abc"), 30)

    def test_invalid_duration_returns_empty_plan(self):
        self.assertEqual(main.plan_video_segments(0, 3, 30), ([], False))
        self.assertEqual(main.plan_video_segments(float("nan"), 3, 30), ([], False))

    def test_output_key_is_stable_and_seconds_sensitive(self):
        key = main.video_segments_output_key("/tmp/some/video.mp4", 3)
        self.assertEqual(key, main.video_segments_output_key("/tmp/some/./video.mp4", 3.0))
        self.assertEqual(len(key), 12)
        self.assertNotEqual(key, main.video_segments_output_key("/tmp/some/video.mp4", 4))


@unittest.skipUnless(HAS_FFMPEG, "需要 ffmpeg/ffprobe 才能验证真实切分")
class SegmentVideoFileTests(unittest.TestCase):
    """用真实生成的短视频验证：规划出来的段长 = ffmpeg 切出来的段长。"""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.src = cls.root / "src.mp4"
        subprocess.run(
            [
                shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc=size=320x180:rate=12", "-t", "3.6",
                "-pix_fmt", "yuv420p", str(cls.src),
            ],
            check=True, capture_output=True, timeout=120,
        )
        cls.duration = main.probe_video_file_duration_seconds(str(cls.src))

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def cut_and_check(self, out_dir, segments):
        for item in segments:
            paths = main.segment_video_file(str(self.src), str(out_dir), item["index"],
                                            item["start"], item["duration"])
            self.assertTrue(os.path.getsize(paths["clip_path"]) > 0)
            self.assertTrue(os.path.getsize(paths["frame_path"]) > 0)
            self.assertTrue(paths["clip_path"].endswith(f"seg_{item['index']:02d}.mp4"))
            self.assertTrue(paths["frame_path"].endswith(f"seg_{item['index']:02d}.jpg"))
            actual = main.probe_video_file_duration_seconds(paths["clip_path"])
            self.assertIsNotNone(actual, f"切片 {item['index']} 读不到时长")
            self.assertLess(
                abs(actual - item["duration"]), 0.25,
                f"第 {item['index']} 段计划 {item['duration']}s，实际 {actual}s",
            )

    def test_plan_durations_match_real_clips(self):
        self.assertIsNotNone(self.duration)
        segments, truncated = main.plan_video_segments(self.duration, 2.0, 30)
        self.assertFalse(truncated)
        self.assertEqual(len(segments), 2)
        self.cut_and_check(self.root / "plan", segments)

    def test_merged_tail_matches_real_clip(self):
        segments, truncated = main.plan_video_segments(self.duration, 3.0, 30)
        self.assertFalse(truncated)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["duration"], round(self.duration, 3))
        self.cut_and_check(self.root / "merged", segments)

    def test_existing_outputs_are_reused(self):
        out_dir = self.root / "reuse"
        first = main.segment_video_file(str(self.src), str(out_dir), 1, 0.0, 1.5)
        with open(first["clip_path"], "ab") as fp:
            fp.write(b"novai-reuse-marker")
        stamp = (os.stat(first["clip_path"]).st_mtime_ns, os.stat(first["frame_path"]).st_mtime_ns)
        second = main.segment_video_file(str(self.src), str(out_dir), 1, 0.0, 1.5)
        self.assertEqual(first, second)
        self.assertEqual(
            stamp, (os.stat(second["clip_path"]).st_mtime_ns, os.stat(second["frame_path"]).st_mtime_ns)
        )
        with open(second["clip_path"], "rb") as fp:
            self.assertTrue(fp.read().endswith(b"novai-reuse-marker"))


if __name__ == "__main__":
    unittest.main()
