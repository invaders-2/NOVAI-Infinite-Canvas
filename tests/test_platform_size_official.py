"""阶段 B：其余平台尺寸/比例按官方口径（纯函数，不调用上游）。

覆盖五处：
  1. Gemini 官方 14 比例、按模型档位（3.1 Flash Image 0.5K / Lite 仅 1K / 2.5 单档）、大写 K；
  2. 火山方舟按模型给「总像素区间 + 档位」，比例 [1/16, 16]，去掉旧的最小/最大边约束；
  3. ModelScope 按模型给 size 像素区间；
  4. Agnes 官方「档位 1K/2K/3K/4K + 8 个比例」及输出像素表；
  5. RunningHub 图片工作流 resolution 枚举只有 1k/2k，不再发 4k。

官方原文与 URL 见 /tmp/novai-official-docs/RESULTS-官方尺寸口径核对.md。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

GEMINI_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"]


class GeminiOfficialSizeTests(unittest.TestCase):

    def test_ratio_table_is_official_14(self):
        self.assertEqual([item[2] for item in main.GEMINI_ASPECT_RATIOS], GEMINI_RATIOS)
        # 官方宽高比表不含 APIMart 的这 5 个，不得再出现在 Gemini 比例表里
        for banned in ("2:1", "1:2", "3:1", "1:3", "9:21"):
            self.assertNotIn(banned, GEMINI_RATIOS)

    def test_official_ratios_pass_through(self):
        for ratio in GEMINI_RATIOS:
            self.assertEqual(main.gemini_image_config(ratio, "gemini-nano-banana-2.1")["aspectRatio"], ratio, ratio)

    def test_apimart_only_ratios_snap_to_nearest_official(self):
        def ratio_of(size):
            return main.gemini_image_config(size, "gemini-nano-banana-2.1")["aspectRatio"]
        self.assertEqual(ratio_of("2:1"), "16:9")
        self.assertEqual(ratio_of("1:2"), "9:16")
        self.assertEqual(ratio_of("3:1"), "21:9")
        self.assertEqual(ratio_of("1:3"), "1:4")
        self.assertEqual(ratio_of("9:21"), "9:16")

    def test_tiers_are_per_model(self):
        self.assertEqual(main.gemini_image_size_choices("gemini-3.1-flash-image-preview"), ("0.5K", "1K", "2K", "4K"))
        self.assertEqual(main.gemini_image_size_choices("gemini-3.1-flash-lite-image"), ("1K",))
        self.assertEqual(main.gemini_image_size_choices("gemini-2.5-flash-image-preview"), ("1K",))

    def test_half_k_only_for_31_flash_image(self):
        self.assertEqual(main.gemini_image_config("0.5K", "gemini-3.1-flash-image-preview")["imageSize"], "0.5K")
        self.assertEqual(main.gemini_image_config("512", "gemini-3.1-flash-image-preview")["imageSize"], "0.5K")
        self.assertEqual(main.gemini_image_config("0.5K", "gemini-3.1-flash-lite-image")["imageSize"], "1K")
        self.assertEqual(main.gemini_image_config("0.5K", "gemini-2.5-flash-image-preview")["imageSize"], "1K")
        self.assertEqual(main.gemini_image_config("4096x4096", "gemini-3.1-flash-lite-image")["imageSize"], "1K")

    def test_image_size_always_uppercase_k(self):
        for size in ("0.5k", "1k", "2k", "4k"):
            value = main.gemini_image_config(size, "gemini-3.1-flash-image-preview")["imageSize"]
            self.assertTrue(value.endswith("K"), value)
            self.assertEqual(value, value.upper())

    def test_31_pro_has_ten_ratios(self):
        ratios = {item[2] for item in main.gemini_aspect_ratio_choices("gemini-3.1-pro-image-preview")}
        self.assertEqual(len(ratios), 10)
        for banned in ("1:4", "1:8", "4:1", "8:1"):
            self.assertNotIn(banned, ratios)

    def test_dispatch_passes_model_into_gemini_config(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn("gemini_image_config(size, model)", source)


class VolcengineOfficialSizeTests(unittest.TestCase):

    PRO_MODEL = "doubao-seedream-5-0-pro-250528"
    LITE_MODEL = "doubao-seedream-5-0-lite-250828"
    V45_MODEL = "doubao-seedream-4-5-250828"
    V40_MODEL = "doubao-seedream-4-0-250828"

    @staticmethod
    def area(size):
        width, height = main.parse_size_pair(size)
        return width * height

    @staticmethod
    def ratio(size):
        width, height = main.parse_size_pair(size)
        return width / height

    def test_50_pro_area_stays_in_official_range(self):
        for size in ("2048x2048", "4096x4096", "3840x2160", "3584x1536", "4096x1000"):
            out = main.normalize_volcengine_size(size, self.PRO_MODEL)
            self.assertGreaterEqual(self.area(out), 921600, out)
            self.assertLessEqual(self.area(out), 4624220, out)

    def test_50_pro_extreme_ratio_clamped_to_1_16(self):
        out = main.normalize_volcengine_size("16000x100", self.PRO_MODEL)
        self.assertLessEqual(self.ratio(out), 16 + 1e-9, out)

    def test_45_and_lite_one_to_one_is_official_2048(self):
        self.assertEqual(main.normalize_volcengine_size("2048x2048", self.V45_MODEL), "2048x2048")
        self.assertEqual(main.normalize_volcengine_size("2048x2048", self.LITE_MODEL), "2048x2048")

    def test_45_min_area_enforced(self):
        self.assertGreaterEqual(self.area(main.normalize_volcengine_size("1280x720", self.V45_MODEL)), 3686400)

    def test_40_allows_small_sizes(self):
        self.assertEqual(main.normalize_volcengine_size("1280x720", self.V40_MODEL), "1280x720")

    def test_old_edge_constraints_are_gone(self):
        for name in ("VOLCENGINE_MIN_EDGE", "VOLCENGINE_MAX_EDGE", "VOLCENGINE_RATIO_CHOICES", "VOLCENGINE_MIN_PIXELS"):
            self.assertFalse(hasattr(main, name), name)

    def test_tier_defaults_follow_official(self):
        self.assertEqual(main.normalize_volcengine_size("3k", self.LITE_MODEL), "3072x3072")
        self.assertEqual(main.normalize_volcengine_size("1k", self.LITE_MODEL), "2048x2048")
        self.assertEqual(main.normalize_volcengine_size("4k", self.PRO_MODEL), "2048x2048")
        self.assertEqual(main.normalize_volcengine_size("1k", self.PRO_MODEL), "1024x1024")


class ModelScopeOfficialSizeTests(unittest.TestCase):

    def test_per_model_pixel_ranges(self):
        self.assertEqual(main.modelscope_size_bounds("Tongyi-MAI/Z-Image-Turbo"), (512, 2048))
        self.assertEqual(main.modelscope_size_bounds("Qwen/Qwen-Image-2512"), (64, 1664))
        self.assertEqual(main.modelscope_size_bounds("black-forest-labs/FLUX.2-klein-9B"), (64, 1024))
        self.assertEqual(main.modelscope_size_bounds("some/SD-model"), (64, 2048))

    def test_qwen_over_1664_is_clamped(self):
        self.assertEqual(main.modelscope_size("4096x4096", model="Qwen/Qwen-Image-2512"), "1664x1664")

    def test_z_image_below_512_is_raised(self):
        self.assertEqual(main.modelscope_size("256x256", model="Tongyi-MAI/Z-Image-Turbo"), "512x512")

    def test_flux_over_1024_is_clamped(self):
        self.assertEqual(main.modelscope_size("4096x4096", model="black-forest-labs/FLUX.2-klein-9B"), "1024x1024")

    def test_default_and_format_error(self):
        self.assertEqual(main.modelscope_size("1024x1024"), "1024x1024")
        with self.assertRaises(main.HTTPException):
            main.modelscope_size("auto")


class AgnesOfficialSizeTests(unittest.TestCase):

    def test_output_pixel_table_matches_official(self):
        self.assertEqual(main.agnes_pixel_size("4K", "16:9"), (5248, 2944))
        self.assertEqual(main.agnes_pixel_size("1K", "16:9"), (1312, 736))
        self.assertEqual(main.agnes_pixel_size("4K", "21:9"), (6272, 2688))
        self.assertEqual(len(main.AGNES_ASPECT_RATIOS), 8)
        self.assertEqual(main.AGNES_SIZE_TIERS, ("1K", "2K", "3K", "4K"))

    def test_request_becomes_tier_and_ratio(self):
        self.assertEqual(main.agnes_image_config("5248x2944"), ("4K", "16:9"))
        self.assertEqual(main.agnes_image_config("4K"), ("4K", "1:1"))
        self.assertEqual(main.agnes_image_config("16:9"), ("2K", "16:9"))
        self.assertEqual(main.agnes_image_config("1024x1536"), ("1K", "2:3"))

    def test_non_official_ratio_snaps(self):
        self.assertEqual(main.agnes_image_config("2:1"), ("2K", "16:9"))

    def test_agnes_image_model_detection(self):
        self.assertTrue(main.is_agnes_image_model("agnes-image-2.5-flash"))
        self.assertFalse(main.is_agnes_image_model("agnes-2.5-flash"))

    def test_dispatch_sends_tier_and_ratio(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn('body["size"] = agnes_size', source)
        self.assertIn('body["ratio"] = agnes_ratio', source)


class RunninghubResolutionTests(unittest.TestCase):

    def test_image_workflow_never_emits_4k(self):
        self.assertEqual(main.runninghub_resolution_from_size("4096x4096"), "2k")
        self.assertEqual(main.runninghub_resolution_from_size("3840x2160"), "2k")
        self.assertEqual(main.runninghub_resolution_from_size("4k"), "2k")

    def test_schema_options_take_precedence(self):
        self.assertEqual(main.runninghub_resolution_from_size("4096x4096", "2k", ["1k", "2k", "4k"]), "4k")
        self.assertEqual(main.runninghub_resolution_from_size("4096x4096", "2k", ["1k"]), "1k")
        self.assertEqual(main.runninghub_resolution_from_size("4096x4096", "2k", ["1k", "2k"]), "2k")

    def test_video_resolutions_untouched(self):
        self.assertEqual(main.runninghub_resolution_from_size("720p"), "720p")
        self.assertEqual(main.runninghub_resolution_from_size("1080p"), "1080p")

    def test_small_sizes(self):
        self.assertEqual(main.runninghub_resolution_from_size("1280x720"), "1k")
        self.assertEqual(main.runninghub_resolution_from_size("1920x1080"), "2k")


if __name__ == "__main__":
    unittest.main()
