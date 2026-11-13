"""智能画布BEAT：参考 / 上传素材节点按源图真实像素定尺寸（不再固定 240×240 把原比例裁掉）。

背景：助手把参考图落成节点时固定给 240×240，节点正文又是 object-fit:cover ——
4.79:1 的分镜长图在画布上只剩中间一条。这里断言后端与前端 mediaFit.fitSourceBox 同一套规则，
并且建节点时就把真实像素写进当前版本（之后切版本 / 替换不再重复解码量尺寸）。

覆盖：
  1. _agent_beat_media_box 的等比规则（横图放大宽度、竖图收宽度、非法输入不猜）；
  2. _agent_beat_new_node 量本地图片真实像素 → 节点宽高按比例、hist 带 w/h；
  3. 外链 / 读不到尺寸时保持默认 240×240（不猜比例）。
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class AgentBeatRefRatioTests(unittest.TestCase):
    def test_media_box_matches_frontend_rules(self):
        self.assertEqual(main._agent_beat_media_box(1676, 350), (479, 100))
        self.assertEqual(main._agent_beat_media_box(4, 3), (240, 180))
        self.assertEqual(main._agent_beat_media_box(9, 16), (240, 427))
        self.assertEqual(main._agent_beat_media_box(1, 5), (128, 640))
        self.assertEqual(main._agent_beat_media_box(10000, 100), (480, 5))
        self.assertIsNone(main._agent_beat_media_box(0, 350))
        self.assertIsNone(main._agent_beat_media_box(None, 350))
        self.assertIsNone(main._agent_beat_media_box("x", 350))

    def test_ref_node_uses_real_pixels(self):
        with patch.object(main, "_agent_local_image_path", return_value="/tmp/x.jpg"), \
                patch.object(main, "_agent_read_image_size", return_value=(1676, 350)):
            node = main._agent_beat_new_node("image", 10, 20, title="参考图 1",
                                             url="/assets/output/x.jpg", uploaded=True)
        self.assertEqual((node["w"], node["h"]), (479, 100))
        self.assertAlmostEqual(node["w"] / node["h"], 1676 / 350, delta=0.02)
        out = node["data"]["gen"]["hist"][0]
        self.assertEqual((out["w"], out["h"]), (1676, 350))
        self.assertTrue(node["data"]["gen"]["agent"])
        self.assertTrue(node["data"]["gen"]["uploaded"])

    def test_unknown_size_keeps_default(self):
        with patch.object(main, "_agent_local_image_path", return_value=""):
            node = main._agent_beat_new_node("image", 0, 0, title="参考图",
                                             url="https://example.invalid/a.jpg", uploaded=True)
        self.assertEqual((node["w"], node["h"]), (240, 240))
        self.assertNotIn("w", node["data"]["gen"]["hist"][0])

    def test_video_ref_node_keeps_default(self):
        with patch.object(main, "_agent_local_image_path", return_value="/tmp/v.mp4"), \
                patch.object(main, "_agent_read_image_size", return_value=(1920, 1080)):
            node = main._agent_beat_new_node("video", 0, 0, title="参考视频 1",
                                             url="/assets/input/v.mp4", uploaded=True)
        self.assertEqual((node["w"], node["h"]), (320, 180))


if __name__ == "__main__":
    unittest.main()
