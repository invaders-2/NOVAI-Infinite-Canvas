"""gpt-image-2 官方尺寸口径：OpenAI 归一化函数与后端尺寸策略（纯函数，不调用上游）。

官方原文：gpt-image-2 支持任意 WIDTHxHEIGHT，宽高都要能被 16 整除、比例 1:3~3:1、最大 3840x2160；
官方 API 参考页没有公布 minPixels（只写 must also satisfy the model current pixel and edge limits）。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

PROVIDER = {"id": "openai-compat", "protocol": "openai", "enabled": True, "image_models": ["gpt-image-2"]}


class GptImage2BoundsTests(unittest.TestCase):

    def test_normalize_keeps_official_sizes(self):
        for size in ("1024x1024", "1536x1024", "1024x1536", "1536x864", "864x1536", "3840x2160", "2160x3840"):
            self.assertEqual(main.normalize_gpt_image_2_size(size), size)

    def test_normalize_clamps_to_official_bounds(self):
        self.assertEqual(main.normalize_gpt_image_2_size("4096x4096"), "2880x2880")
        self.assertEqual(main.normalize_gpt_image_2_size("3840x1000"), "2976x992")
        self.assertEqual(main.normalize_gpt_image_2_size("1000x3840"), "992x2976")
        self.assertEqual(main.normalize_gpt_image_2_size("16384x16384"), "2880x2880")
        self.assertEqual(main.normalize_gpt_image_2_size("auto"), "auto")

    def test_backend_policy_matches_frontend_expectations(self):
        cases = {
            "1024x1024": "1024x1024",
            "4096x4096": "2880x2880",
            "3840x2160": "3840x2160",
            "2160x3840": "2160x3840",
            "1280x544": "1280x544",
            "1008x1344": "1008x1344",
            "3840x1000": "2976x992",
            "16384x16384": "2880x2880",
        }
        for size, expected in cases.items():
            self.assertEqual(main.nova_protocols.constrain_size(PROVIDER, "gpt-image-2", size), expected, size)

    def test_unpublished_min_pixels_is_retained(self):
        policy = main.nova_protocols.size_policy_for(PROVIDER, "gpt-image-2")
        self.assertEqual(policy["mode"], "bounds")
        self.assertEqual(policy["minPixels"], 655360)
        self.assertAlmostEqual(policy["minRatio"], 1 / 3)
        self.assertEqual(policy["maxRatio"], 3)

    def test_bounds_engine_and_normalizer_agree(self):
        # 两边实现必须同值：后端正则走 constrain_size，另一条 OpenAI 路径走 normalize_gpt_image_2_size
        for size in ("4096x4096", "3840x1000", "1000x3840", "16384x16384", "1536x864", "1280x544", "2048x880"):
            self.assertEqual(main.nova_protocols.constrain_size(PROVIDER, "gpt-image-2", size),
                             main.normalize_gpt_image_2_size(size), size)


if __name__ == "__main__":
    unittest.main()
