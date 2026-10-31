"""生图收敛提示 size_notice：分辨率/比例被模型能力收敛时给用户一句可读说明。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class ApimartSizeNoticeTests(unittest.TestCase):

    def test_resolution_clamped_down(self):
        self.assertEqual(main.apimart_size_notice("1:1", "1:1", "4k", "2K"),
                         "该模型最高支持 2K，已按 2K 生成（原请求 4K）")

    def test_resolution_lifted_up(self):
        self.assertEqual(main.apimart_size_notice("1:1", "1:1", "1k", "2K"),
                         "该模型最低支持 2K，已按 2K 生成（原请求 1K）")

    def test_ratio_clamped(self):
        self.assertEqual(main.apimart_size_notice("21:9", "16:9", "1k", "1K"),
                         "该模型不支持 21:9，已用 16:9 生成")

    def test_both_clamped(self):
        self.assertEqual(main.apimart_size_notice("9:21", "1:2", "4k", "2K"),
                         "该模型最高支持 2K，已按 2K 生成（原请求 4K）；该模型不支持 9:21，已用 1:2 生成")

    def test_no_change_returns_empty(self):
        self.assertEqual(main.apimart_size_notice("1:1", "1:1", "2k", "2K"), "")
        self.assertEqual(main.apimart_size_notice("", "", "", ""), "")

    def test_unknown_model_has_no_notice(self):
        caps = main.apimart_image_model_caps("no-such-image-model")
        self.assertIsNone(caps)
        requested_ratio = "21:9"
        final_ratio = main.apimart_clamp_ratio(requested_ratio, ())
        requested_resolution = "4k"
        final_resolution = main.apimart_image_resolution_for_model("no-such-image-model", "4K")
        self.assertEqual(main.apimart_size_notice(requested_ratio, final_ratio, requested_resolution, final_resolution), "")

    def test_table_clamp_produces_notice(self):
        caps = main.apimart_image_model_caps("seedream-5-0-flash")
        final_ratio = main.apimart_clamp_ratio("9:21", caps["ratios"])
        final_resolution = main.apimart_image_resolution_for_model("seedream-5-0-flash", "4K")
        self.assertEqual(final_ratio, "1:2")
        self.assertEqual(main.apimart_size_notice("9:21", final_ratio, "4k", final_resolution),
                         "该模型最高支持 2K，已按 2K 生成（原请求 4K）；该模型不支持 9:21，已用 1:2 生成")


class ApimartSizeNoticeSourceTests(unittest.TestCase):

    def test_branch_and_online_result_carry_notice(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn("size_notice_out=None", source)
        self.assertIn("apimart_requested_resolution = _base_resolution", source)
        self.assertIn("apimart_size_notice(", source)
        self.assertIn('size_notice_out["size_notice"] = apimart_notice', source)
        self.assertIn("size_notice = next(", source)
        self.assertIn('result["size_notice"] = size_notice', source)


if __name__ == "__main__":
    unittest.main()
