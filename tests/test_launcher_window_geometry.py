"""launcher.py 窗口尺寸收敛回归（纯函数，不启动 pywebview / GUI）。

覆盖：1366x768、1080p@125%（物理 1920x1010 / dpi 120）、1280x800、4K@200%、拿不到工作区。
跑法：python -m pytest tests/test_launcher_window_geometry.py -q
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import launcher


class ComputeWindowGeometryTests(unittest.TestCase):
    def test_1366x768_fits_inside_work_area(self):
        geometry = launcher.compute_window_geometry((0, 0, 1366, 728), 96)
        self.assertEqual(geometry["width"], 1326)
        self.assertEqual(geometry["height"], 688)
        self.assertEqual((geometry["x"], geometry["y"]), (20, 20))
        self.assertEqual((geometry["min_width"], geometry["min_height"]), (1200, 728))
        self.assertLessEqual(geometry["x"] + geometry["width"], 1366)
        self.assertLessEqual(geometry["y"] + geometry["height"], 728)

    def test_1080p_at_125_percent_uses_logical_pixels(self):
        # 1920x1010 物理像素 / dpi 120 → 1536x808 逻辑像素
        geometry = launcher.compute_window_geometry((0, 0, 1920, 1010), 120)
        self.assertEqual(geometry["width"], 1400)
        self.assertEqual(geometry["height"], 768)
        self.assertEqual((geometry["x"], geometry["y"]), (68, 20))
        self.assertEqual((geometry["min_width"], geometry["min_height"]), (1200, 800))
        self.assertLessEqual(geometry["x"] + geometry["width"], 1536)
        self.assertLessEqual(geometry["y"] + geometry["height"], 808)

    def test_1280x800_defaults_to_fit(self):
        geometry = launcher.compute_window_geometry((0, 0, 1280, 800), 96)
        self.assertEqual((geometry["width"], geometry["height"]), (1240, 760))
        self.assertEqual((geometry["x"], geometry["y"]), (20, 20))

    def test_4k_at_200_percent(self):
        geometry = launcher.compute_window_geometry((0, 0, 3840, 2120), 192)
        self.assertEqual((geometry["width"], geometry["height"]), (1400, 900))
        self.assertEqual((geometry["x"], geometry["y"]), (260, 80))

    def test_missing_work_area_falls_back(self):
        geometry = launcher.compute_window_geometry(None, 96)
        self.assertEqual((geometry["width"], geometry["height"]), (1400, 900))
        self.assertEqual((geometry["min_width"], geometry["min_height"]), (1200, 800))
        self.assertEqual((geometry["x"], geometry["y"]), (20, 20))

    def test_secondary_display_offset_kept(self):
        geometry = launcher.compute_window_geometry((1920, 100, 1366, 728), 96)
        self.assertEqual((geometry["x"], geometry["y"]), (1940, 120))
        self.assertLessEqual(geometry["x"] + geometry["width"], 1920 + 1366)
        self.assertLessEqual(geometry["y"] + geometry["height"], 100 + 728)

    def test_create_window_uses_geometry(self):
        source = open(launcher.__file__, encoding="utf-8").read()
        self.assertIn("work_area, work_dpi = get_screen_work_area()", source)
        self.assertIn("geometry = compute_window_geometry(work_area, work_dpi)", source)
        self.assertIn('width=geometry["width"]', source)
        self.assertIn('min_size=(geometry["min_width"], geometry["min_height"])', source)
        self.assertNotIn("width=1400,\n            height=900,\n            min_size=(1200, 800)", source)

    def test_work_area_probe_does_not_raise(self):
        work_area, dpi = launcher.get_screen_work_area()
        self.assertTrue(work_area is None or (isinstance(work_area, tuple) and len(work_area) == 4))
        self.assertGreater(float(dpi), 0)

    def test_mac_traffic_lights_match_tapnow(self):
        # TapNow 2x 截图：关闭灯左缘约 19.5、中心约 26 → 统一取 20/26，三灯右缘约 72
        self.assertEqual(launcher._MAC_TL_LEFT_X, 20.0)
        self.assertEqual(launcher._MAC_TL_CENTER_Y, 26.0)
        source = open(launcher.__file__, encoding="utf-8").read()
        self.assertIn("_MAC_TL_LEFT_X = 20.0", source)
        self.assertIn("_MAC_TL_CENTER_Y = 26.0", source)

    def test_dpi_awareness_noop_outside_windows(self):
        if os.name == "nt":
            self.skipTest("Windows 上会尝试设置 DPI 感知")
        self.assertFalse(launcher.ensure_windows_dpi_awareness())


if __name__ == "__main__":
    unittest.main()
