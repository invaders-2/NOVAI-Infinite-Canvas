"""APIMart 图像模型能力表：逐模型收敛 size 比例与 resolution 档位（纯函数 + 源码断言）。

官方出处：/tmp/apimart-docs/cn/api-reference/images/*（docs.apib.ai 镜像，内容与 docs.apimart.ai 一致）
  * gpt-image-2/generation.md：size 15 个比例 + auto，resolution 1k/2k/4k，n 1~4，
    image_urls 支持 URL 与 base64 混填，mask_url 可用；official.md 同档位但参考图只收公网 URL。
  * seedream-4.5：明确「不支持 1K」，只有 2K/4K。
  * seedream-5-0-lite：2K/3K/4K，且不支持 9:21。
  * imagen-4.0-apimart：只有 1:1/4:3/3:4/16:9/9:16，列表外比例回退 16:9。
  * gemini-3.1-flash：完整版 0.5K/1K/2K/4K；Lite 只支持 1K（传更高档会静默降成 1K）。
  * gemini-2.5-flash（Nano Banana / -ext）：只支持 1K。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class ApimartImageCapsTableTests(unittest.TestCase):

    def test_table_covers_documented_families(self):
        for key in (
            "gpt-image-2", "gpt-image-2-5", "gpt-image-2-5-ext", "gpt-image-1",
            "gemini-2-5-flash-image-preview", "gemini-3-pro-image-preview", "gemini-3-1-flash-image-preview",
            "gemini-3-1-flash-lite-image", "gemini-nano-banana-2-1", "gemini-nano-banana-2-1-ext",
            "imagen-4-0-apimart", "mai-image-2-6", "qwen-image-2-0", "qwen-image-3-0",
            "seedream-4-0", "seedream-4-5", "seedream-5-0-flash", "seedream-5-0-pro", "seedream-5-0-lite",
            "flux-2", "flux-3-image", "flux-3-image-klein", "flux-kontext", "hy-image-v3-5-preview",
            "grok-imagine-2-0", "grok-imagine-image", "grok-imagine-image-quality", "grok-imagine-image-2-0",
            "wan2-7-image", "z-image-turbo",
        ):
            self.assertIn(key, main.APIMART_IMAGE_MODEL_CAPS, key)
        self.assertGreaterEqual(len(main.APIMART_IMAGE_MODEL_CAPS), 20)

    def test_table_flags_match_docs(self):
        gpt2 = main.APIMART_IMAGE_MODEL_CAPS["gpt-image-2"]
        self.assertEqual(gpt2["n_max"], 4)
        self.assertTrue(gpt2["mask_url"])
        self.assertTrue(gpt2["base64_refs"])
        self.assertTrue(gpt2["official_fallback"])
        self.assertFalse(main.APIMART_IMAGE_MODEL_CAPS["gpt-image-2-5"]["base64_refs"])
        self.assertEqual(main.APIMART_IMAGE_MODEL_CAPS["gpt-image-2-5"]["ref_max"], 16)
        self.assertFalse(main.APIMART_IMAGE_MODEL_CAPS["seedream-4-5"]["resolutions"].count("1K"))
        self.assertEqual(main.APIMART_IMAGE_MODEL_CAPS["gemini-3-1-flash-lite-image"]["resolutions"], ("1K",))
        self.assertEqual(main.APIMART_IMAGE_MODEL_CAPS["gemini-nano-banana-2-1-ext"]["n_max"], 1)
        self.assertEqual(main.APIMART_IMAGE_MODEL_CAPS["flux-3-image-klein"]["resolutions"],
                         ("768SQ", "1K", "1.5K", "2K", "4K"))
        self.assertFalse(main.APIMART_IMAGE_MODEL_CAPS["flux-3-image-klein"]["mask_url"])
        self.assertEqual(main.APIMART_IMAGE_MODEL_CAPS["grok-imagine-2-0"]["fixed_resolution"], "quality")
        self.assertTrue(main.APIMART_IMAGE_MODEL_CAPS["grok-imagine-2-0"]["refs_none"])
        self.assertEqual(main.APIMART_IMAGE_MODEL_CAPS["grok-imagine-image-2-0"]["size_field"], "aspect_ratio")
        self.assertEqual(main.APIMART_IMAGE_MODEL_CAPS["imagen-4-0-apimart"]["ratios"],
                         ("1:1", "4:3", "3:4", "16:9", "9:16"))

    def test_alias_lookup(self):
        self.assertEqual(main.apimart_image_model_caps("gemini-3-pro-image-preview-official"),
                         main.APIMART_IMAGE_MODEL_CAPS["gemini-3-pro-image-preview"])
        self.assertEqual(main.apimart_image_model_caps("gpt-image-2-ext"),
                         main.APIMART_IMAGE_MODEL_CAPS["gpt-image-2"])
        self.assertEqual(main.apimart_image_model_caps("nano-banana-pro"),
                         main.APIMART_IMAGE_MODEL_CAPS["nano-banana-pro"])
        self.assertEqual(main.apimart_image_model_caps("cogview-4"), None)


class ApimartImageResolutionClampTests(unittest.TestCase):

    def test_gpt_image_2_keeps_4k(self):
        self.assertEqual(main.apimart_image_resolution_for_model("gpt-image-2", "4K"), "4K")
        self.assertEqual(main.apimart_image_resolution_for_model("gpt-image-2-official", "4K"), "4K")

    def test_lower_max_model_clamps_4k_to_2k(self):
        self.assertEqual(main.apimart_image_resolution_for_model("seedream-5-0-flash", "4K"), "2K")
        self.assertEqual(main.apimart_image_resolution_for_model("wan2-7-image", "4K"), "2K")

    def test_min_2k_model_lifts_1k(self):
        self.assertEqual(main.apimart_image_resolution_for_model("seedream-4.5", "1K"), "2K")
        self.assertEqual(main.apimart_image_resolution_for_model("seedream-5-0-lite", "1K"), "2K")

    def test_new_resolution_levels_and_fixed_quality(self):
        self.assertEqual(main.apimart_image_resolution_for_model("seedream-5-0-pro", "1.5K"), "1.5K")
        self.assertEqual(main.apimart_image_resolution_for_model("flux-3-image-klein", "768sq"), "768SQ")
        self.assertEqual(main.apimart_image_resolution_for_model("flux-3-image-klein", "1.5K"), "1.5K")
        self.assertEqual(main.apimart_image_resolution_for_model("grok-imagine-2.0-ext", "4K"), "quality")

    def test_special_resolution_levels_survive_pixel_mapping(self):
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("768x768", "flux-3-image-klein"), "768SQ")
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("1536x1536", "flux-3-image-klein"), "1.5K")
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("2048x1152", "seedream-5-0-pro"), "1.5K")
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("2048x2048", "seedream-5-0-pro"), "2K")
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("2880x2880", "gpt-image-2"), "4k")

    def test_lite_stays_1k(self):
        self.assertEqual(main.apimart_image_resolution_for_model("nano-banana-lite", "4K"), "1K")
        self.assertEqual(main.apimart_image_resolution_for_model("gemini-3-1-flash-lite-image", "2K"), "1K")

    def test_nano_banana_stays_1k(self):
        self.assertEqual(main.apimart_image_resolution_for_model("nano-banana", "4K"), "1K")
        self.assertEqual(main.apimart_image_resolution_for_model("gemini-2-5-flash-image-preview-official", "2K"), "1K")

    def test_unknown_model_keeps_old_whitelist(self):
        self.assertEqual(main.apimart_image_resolution_for_model("cogview-4", "4K"), "4K")
        self.assertEqual(main.apimart_image_resolution_for_model("", "2K"), "2K")
        self.assertEqual(main.apimart_image_resolution_for_model("cogview-4", "8K"), "1K")


class ApimartImageRatioClampTests(unittest.TestCase):

    def caps_ratios(self, model):
        return main.apimart_image_model_caps(model)["ratios"]

    def test_imagen_21_9_falls_back_to_16_9(self):
        self.assertEqual(main.apimart_clamp_ratio("21:9", self.caps_ratios("imagen-4-0-apimart")), "16:9")

    def test_gpt_image_2_keeps_21_9(self):
        self.assertEqual(main.apimart_clamp_ratio("21:9", self.caps_ratios("gpt-image-2")), "21:9")

    def test_qwen_21_9_to_16_9(self):
        self.assertEqual(main.apimart_clamp_ratio("21:9", self.caps_ratios("qwen-image-2-0")), "16:9")

    def test_lite_9_21_to_1_2(self):
        self.assertEqual(main.apimart_clamp_ratio("9:21", self.caps_ratios("seedream-5-0-lite")), "1:2")

    def test_auto_when_model_has_no_auto(self):
        self.assertEqual(main.apimart_clamp_ratio("auto", self.caps_ratios("imagen-4-0-apimart")), "1:1")
        self.assertEqual(main.apimart_clamp_ratio("auto", self.caps_ratios("gpt-image-2")), "auto")

    def test_no_table_keeps_ratio(self):
        self.assertEqual(main.apimart_clamp_ratio("21:9", ()), "21:9")
        self.assertEqual(main.apimart_clamp_ratio("16:9x", ("16:9", "1:1")), "1:1")


class ApimartImageBranchSourceTests(unittest.TestCase):

    def test_branch_clamps_through_caps(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn("apimart_caps = apimart_image_model_caps(model)", source)
        self.assertIn('apimart_size = apimart_clamp_ratio(apimart_size, apimart_caps.get("ratios"))', source)
        self.assertIn("resolution = apimart_image_resolution_for_model(model, resolution)", source)


if __name__ == "__main__":
    unittest.main()
