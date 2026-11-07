"""画布面板直发链路（/api/canvas-image-tasks、/api/canvas-video）的模型规格收敛核实。

结论（每条都有断言钉住）：
  1. apimart：比例/分辨率/张数走 APIMART_IMAGE_MODEL_CAPS，视频时长/比例/分辨率走 APIMART_VIDEO_MODEL_CAPS；
  2. agnes：图片 档位+比例走 agnes_image_config（AGNES_SIZE_TIERS / AGNES_ASPECT_RATIOS），视频走 agnes_video_*；
  3. gemini：比例/档位走 gemini_aspect_ratio_choices / gemini_image_size_choices（gemini_image_config）；
  4. volcengine：图片档位走 VOLCENGINE_SIZE_RULES，视频时长/分辨率走 volcengine_video_*；
  5. 通用 OpenAI 兼容分支新增 direct_image_size_caps 兜底，与助手链路同一套 caps（不再两套口径）；
  6. modelscope / lovart / runninghub 等没有权威 caps 表的平台不在 /api/model-caps 里，也由各自的
     modelscope_constrain_size / size policy 收敛（有意不塞进 caps，避免瞎编）——用测试注明。
"""
import sys
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

APIMART = {"id": "apimart", "protocol": "apimart", "base_url": "https://apib.ai"}
AGNES = {"id": "agnes-ai", "protocol": "openai", "base_url": "https://apihub.agnes-ai.com"}
GEMINI = {"id": "gemini", "protocol": "gemini", "base_url": "https://generativelanguage.googleapis.com"}
MODELSCOPE = {"id": "modelscope", "protocol": "openai", "base_url": "https://api-inference.modelscope.cn/v1"}
LOVART = {"id": "lovart", "protocol": "lovart", "base_url": "https://lgw.lovart.ai"}


def caps_of(provider, model, kind):
    caps = main.model_caps_for(provider, model, kind)
    if caps is None:
        raise AssertionError(f"{provider.get('id')} / {model} / {kind} 没有权威 caps")
    return caps


def ratio_of(size):
    width, height = main.parse_size_pair(size)
    if not width or not height:
        return ""
    return main._caps_ratio_label(f"{width}:{height}")


def tier_of(size):
    return main._caps_tier_from_size(size)


class ApimartImageDirectTests(unittest.TestCase):
    def test_ratio_out_of_caps_is_clamped_to_nearest_legal(self):
        caps = caps_of(APIMART, "gpt-image-1", "image")
        self.assertEqual(main.apimart_clamp_ratio("16:9", caps.get("ratios")), "3:2")
        self.assertEqual(main.apimart_clamp_ratio("9:16", caps.get("ratios")), "2:3")

    def test_resolution_above_model_ceiling_is_clamped(self):
        self.assertEqual(main.apimart_image_resolution_for_model("gpt-image-1", "4K"), "1K")
        self.assertEqual(main.apimart_image_resolution_for_model("gpt-image-2", "2K"), "2K")

    def test_illegal_size_is_rewritten_to_legal_ratio_and_tier(self):
        size, notice = main.direct_image_size_caps(APIMART, "gpt-image-1", "3840x2160")
        caps = caps_of(APIMART, "gpt-image-1", "image")
        self.assertEqual(size, "1536x1024")
        self.assertIn(ratio_of(size), caps["ratios"])
        self.assertIn(tier_of(size), caps["resolutions"])
        self.assertIn("按模型规格", notice)

    def test_legal_size_is_left_untouched(self):
        for model, size in (("gpt-image-2", "1600x1200"), ("gpt-image-2", "2048x2048"),
                            ("gpt-image-2", "5:4"), ("gpt-image-2", "auto")):
            self.assertEqual(main.direct_image_size_caps(APIMART, model, size), (size, ""), (model, size))

    def test_exact_size_models_keep_pixel_dimensions(self):
        # gpt-image-2.5 家族是 exact_size：上游要精确像素，不能被换算成档位尺寸
        self.assertEqual(main.direct_image_size_caps(APIMART, "gpt-image-2.5-flare", "1600x1200"), ("1600x1200", ""))
        self.assertTrue(main.apimart_image_model_caps("gpt-image-2.5-ext") is not None)

    def test_count_is_capped_by_model_n_max(self):
        self.assertEqual(main.direct_image_request_count(APIMART, "gpt-image-2", 9), 4)
        self.assertEqual(main.direct_image_request_count(APIMART, "gpt-image-1", 9), 4)
        self.assertEqual(main.direct_image_request_count(APIMART, "gpt-image-2", 2), 2)
        self.assertEqual(main.direct_image_request_count(APIMART, "midjourney", 9), 8)   # 无 caps：只受全局 8 张


class AgnesImageDirectTests(unittest.TestCase):
    def test_size_is_converted_to_official_tier_and_ratio(self):
        caps = caps_of(AGNES, "agnes-image-2.5-flash", "image")
        for size in ("777x999", "5:4", "20000x100", "1024x1024"):
            tier, ratio = main.agnes_image_config(size)
            self.assertIn(ratio, caps["ratios"], size)
            self.assertIn(tier, caps["resolutions"], size)
        self.assertEqual(main.agnes_image_config("5:4"), ("2K", "4:3"))

    def test_any_size_is_converted_by_agnes_own_caps(self):
        # Agnes 的 caps 覆盖 1K/2K/3K/4K 全部档位 + 8 个比例：任意像素尺寸都由 agnes_image_config 换成
        # 合法「档位+比例」，所以 caps 兜底不会改写它（改了反而多一次无谓换算）。
        caps = caps_of(AGNES, "agnes-image-2.5-flash", "image")
        self.assertEqual(main.direct_image_size_caps(AGNES, "agnes-image-2.5-flash", "3000x3000"), ("3000x3000", ""))
        for size in ("3000x3000", "1234x567", "777x999"):
            tier, ratio = main.agnes_image_config(size)
            self.assertIn(tier, caps["resolutions"], size)
            self.assertIn(ratio, caps["ratios"], size)

    def test_legal_agnes_size_is_left_untouched(self):
        self.assertEqual(main.direct_image_size_caps(AGNES, "agnes-image-2.5-flash", "864x1152"), ("864x1152", ""))

    def test_count_uses_single_request_n_max_one(self):
        # Agnes 请求体不发 n → 单请求恒为 1 张；面板多张=逐张请求，所以张数只受全局 8 张约束
        self.assertEqual(caps_of(AGNES, "agnes-image-2.5-flash", "image")["n_max"], 1)
        self.assertEqual(main.direct_image_request_count(AGNES, "agnes-image-2.5-flash", 9), 8)
        self.assertEqual(main.direct_image_request_count(AGNES, "agnes-image-2.5-flash", 3), 3)


class GeminiImageDirectTests(unittest.TestCase):
    def test_aspect_ratio_and_tier_follow_official_choices(self):
        caps = caps_of(GEMINI, "gemini-3-pro-image-preview", "image")
        for size in ("12345x67", "5:4", "1024x1024", "777x999"):
            config = main.gemini_image_config(size, "gemini-3-pro-image-preview")
            self.assertIn(config["aspectRatio"], caps["ratios"], size)
            self.assertIn(config["imageSize"], caps["resolutions"], size)
        self.assertEqual(main.gemini_image_config("5:4", "gemini-3-pro-image-preview")["aspectRatio"], "5:4")

    def test_caps_and_helper_share_the_same_tables(self):
        caps = caps_of(GEMINI, "gemini-3-pro-image-preview", "image")
        self.assertEqual(caps["ratios"], [item[2] for item in main.gemini_aspect_ratio_choices("gemini-3-pro-image-preview")])
        self.assertEqual(caps["resolutions"], list(main.gemini_image_size_choices("gemini-3-pro-image-preview")))

    def test_illegal_size_is_rewritten_by_the_same_caps(self):
        # gemini-2.5-flash-image 官方只有 1K 一档：4K 请求要被收敛下来
        model = "gemini-2.5-flash-image-preview"
        caps = caps_of(GEMINI, model, "image")
        self.assertEqual(caps["resolutions"], ["1K"])
        size, notice = main.direct_image_size_caps(GEMINI, model, "4096x4096")
        self.assertEqual(size, "1024x1024")
        self.assertIn(ratio_of(size), caps["ratios"])
        self.assertIn(tier_of(size), caps["resolutions"])
        self.assertIn("按模型规格", notice)


class VideoDirectTests(unittest.TestCase):
    def test_apimart_duration_ratio_resolution_are_clamped(self):
        body = main.apimart_video_body_params("seedance-2-0", 99, "5:4", "4k")
        caps = caps_of(APIMART, "seedance-2.0", "video")
        self.assertEqual(body["duration"], max(caps["durations"]))
        self.assertIn(body["ratio_value"], caps["ratios"])
        self.assertIn(body["resolution_value"], caps["resolutions"])
        self.assertEqual(body["duration"], 15)
        self.assertEqual(body["ratio_value"], "4:3")

        kling = main.apimart_video_body_params("kling-v3", 1, "5:4", "1080p")
        kling_caps = caps_of(APIMART, "kling-v3", "video")
        self.assertEqual(kling["duration"], min(kling_caps["durations"]))
        self.assertIn(kling["ratio_value"], kling_caps["ratios"])

    def test_agnes_video_helpers_stay_within_caps(self):
        caps = caps_of(AGNES, "agnes-video-2.5-flash", "video")
        self.assertEqual(int(main.agnes_video_seconds(99)), max(caps["durations"]))
        self.assertIn(main.agnes_video_aspect_ratio("9:21"), caps["ratios"])
        self.assertEqual(main.agnes_video_size_tier("4k", "agnes-video-2.5-flash"), "720P")
        self.assertIn(main.agnes_video_size_tier("4k", "agnes-video-2.5-flash"), caps["resolutions"])

    def test_volcengine_video_helpers_stay_within_caps(self):
        caps = caps_of({"id": "volcengine", "protocol": "volcengine"}, "doubao-seedance-2-0", "video")
        self.assertEqual(main.volcengine_video_duration(99, "doubao-seedance-2-0"), max(caps["durations"]))
        self.assertIn(main.volcengine_video_resolution("4k", "doubao-seedance-2-0"), caps["resolutions"])
        self.assertEqual(main.volcengine_video_resolution("4k", "doubao-seedance-2-0-fast"), "720p")
        self.assertEqual(caps["durations"], main.volcengine_video_durations("doubao-seedance-2-0"))
        self.assertEqual(caps["resolutions"], main.volcengine_video_resolutions("doubao-seedance-2-0"))


class FlareSunburstFamilyTests(unittest.TestCase):
    """gpt-image-2.5 的 flare / sunburst 是同家族版本，不是漏表（注释见 APIMART_IMAGE_MODEL_CAPS 上方）。"""

    def test_ext_variants_are_sent_as_model_plus_version(self):
        self.assertEqual(main.apimart_image_request_identity("gpt-image-2.5-ext"), ("gpt-image-2.5-ext", "flare"))
        self.assertEqual(main.apimart_image_request_identity("gpt-image-2.5-ext-flare"), ("gpt-image-2.5-ext", "flare"))
        self.assertEqual(main.apimart_image_request_identity("gpt-image-2.5-ext-sunburst"), ("gpt-image-2.5-ext", "sunburst"))
        # 不带 -ext- 的是上游独立模型名：原样下发，不带 version
        self.assertEqual(main.apimart_image_request_identity("gpt-image-2.5-flare"), ("gpt-image-2.5-flare", ""))
        self.assertEqual(main.apimart_image_request_identity("gpt-image-2.5-sunburst"), ("gpt-image-2.5-sunburst", ""))
        self.assertEqual(main.apimart_image_request_identity("gpt-image-2"), ("gpt-image-2", ""))

    def test_flare_and_sunburst_share_the_gpt_image_2_5_caps(self):
        base = main.apimart_image_model_caps("gpt-image-2.5")
        self.assertIs(main.apimart_image_model_caps("gpt-image-2.5-flare"), base)
        self.assertIs(main.apimart_image_model_caps("gpt-image-2.5-sunburst"), base)
        self.assertIn("max", base["qualities"])
        self.assertTrue(base.get("exact_size"))

    def test_ext_variants_share_the_ext_caps_and_drop_quality(self):
        ext = main.apimart_image_model_caps("gpt-image-2.5-ext")
        self.assertIs(main.apimart_image_model_caps("gpt-image-2.5-ext"), ext)
        self.assertIs(main.apimart_image_model_caps("gpt-image-2.5-ext-flare"), ext)
        self.assertIs(main.apimart_image_model_caps("gpt-image-2.5-ext-sunburst"), ext)
        self.assertIsNone(ext.get("qualities"))      # ext 条目没声明 quality → 不下发（保守）
        self.assertLess(len(ext["ratios"]), len(main.apimart_image_model_caps("gpt-image-2.5")["ratios"]))

    def test_family_caps_reach_the_model_caps_endpoint(self):
        with unittest.mock.patch.object(main, "load_api_providers", return_value=[
                {"id": "apimart", "protocol": "apimart", "base_url": "https://apib.ai", "enabled": True,
                 "image_models": ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst", "gpt-image-2.5-ext-flare"],
                 "video_models": [], "image_model": ""}]):
            main.invalidate_model_caps_cache()
            payload = main._model_caps_payload(admin=True)
        main.invalidate_model_caps_cache()
        by_model = {item["model"]: item for item in payload["items"]}
        self.assertEqual(by_model["gpt-image-2.5-flare"]["ratios"], by_model["gpt-image-2.5-sunburst"]["ratios"])
        self.assertGreaterEqual(len(by_model["gpt-image-2.5-flare"]["qualities"]), 5)
        self.assertEqual(by_model["gpt-image-2.5-ext-flare"]["qualities"], [])


class DocumentedNonConvergenceTests(unittest.TestCase):
    """这些平台没有权威 caps 表：不进 /api/model-caps，但各有自己的收敛函数（有意，不瞎编）。"""

    def test_modelscope_converges_with_its_own_policy(self):
        self.assertIsNone(main.model_caps_for(MODELSCOPE, "Tongyi-MAI/Z-Image-Turbo", "image"))
        self.assertEqual(main.direct_image_size_caps(MODELSCOPE, "Tongyi-MAI/Z-Image-Turbo", "1234x567"), ("1234x567", ""))
        self.assertEqual(main.modelscope_constrain_size("4000x4000", "Tongyi-MAI/Z-Image-Turbo"), "2048x2048")

    def test_lovart_has_no_caps_table_and_is_untouched_by_the_caps_gate(self):
        for model in ("generate_image_gpt_image_2_5_flare", "generate_image_gpt_image_2"):
            self.assertIsNone(main.model_caps_for(LOVART, model, "image"))
            self.assertEqual(main.direct_image_size_caps(LOVART, model, "1600x1200"), ("1600x1200", ""))
        # Lovart 的多张是逐张任务，没有单请求 n 上限 → 只受全局 8 张约束
        self.assertEqual(main.direct_image_request_count(LOVART, "generate_image_gpt_image_2_5_flare", 9), 8)


if __name__ == "__main__":
    unittest.main()
