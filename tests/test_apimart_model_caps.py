"""APIMart 图像模型能力表：逐模型收敛 size 比例与 resolution 档位（纯函数 + 源码断言）。

官方出处：/tmp/apimart-docs/cn/api-reference/images/*（docs.apib.ai 镜像，内容与 docs.apimart.ai 一致）
  * gpt-image-2/generation.md：size 15 个比例 + auto，resolution 1k/2k/4k，n 1~4，
    image_urls 支持 URL 与 base64 混填，mask_url 可用；official.md 同档位但参考图只收公网 URL。
  * seedream-4.5：明确「不支持 1K」，只有 2K/4K。
  * seedream-5-0-lite：2K/3K/4K，且不支持 9:21。
  * seedream-5.5：1K/1.5K/2K，auto + 10 个比例，n 只能 1，参考图 0–10 张，输出 png/jpeg。
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
            "seedream-5-5",
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

    def test_seedream_5_5_caps_match_docs(self):
        # 文档：size 支持 auto + 10 个比例（无 9:21），resolution 只有 1K/1.5K/2K，n 只能 1，
        # 参考图 0–10 张且 URL/data:image base64 都收，output_format 为 png（默认）/jpeg。
        caps = main.APIMART_IMAGE_MODEL_CAPS["seedream-5-5"]
        self.assertEqual(caps["ratios"],
                         ("auto", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "2:1", "1:2", "21:9"))
        self.assertEqual(len(caps["ratios"]), 11)
        self.assertEqual(caps["resolutions"], ("1K", "1.5K", "2K"))
        self.assertEqual(caps["n_max"], 1)
        self.assertEqual(caps["ref_max"], 10)
        self.assertIs(caps["base64_refs"], True)
        self.assertIs(caps["mask_url"], False)
        self.assertEqual(caps["output_formats"], ("png", "jpeg"))

    def test_minimax_h3_image_caps_match_docs(self):
        # 文档：1K/2K/4K（不传默认 4K）、n 1–10、参考图 ≤16 张、输出 jpeg/png/webp、
        # quality/style/seed/mask_url 上游忽略；精确像素与 resolution 互斥所以不开 exact_size。
        caps = main.APIMART_IMAGE_MODEL_CAPS["minimax-h3-image"]
        self.assertEqual(caps["resolutions"], ("1K", "2K", "4K"))
        self.assertEqual(caps["n_max"], 10)
        self.assertEqual(caps["ref_max"], 16)
        self.assertFalse(caps["mask_url"])
        self.assertTrue(caps["base64_refs"])
        self.assertEqual(caps["output_formats"], ("png", "jpeg", "webp"))
        self.assertNotIn("exact_size", caps)
        self.assertIn("21:9", caps["ratios"])
        # highspeed 版参数与标准版一致，靠「最长 key 命中」复用同一条
        self.assertIs(main.apimart_image_model_caps("minimax-h3-image-highspeed"), caps)

    def test_gpt_image_2_6_output_formats(self):
        caps = main.model_caps_for({"id": "apimart", "protocol": "apimart"}, "gpt-image-2.6-sunburst", "image")
        self.assertEqual(caps["output_formats"], ["png", "jpeg", "webp", "svg", "gif"])

    def test_alias_lookup(self):
        self.assertEqual(main.apimart_image_model_caps("gemini-3-pro-image-preview-official"),
                         main.APIMART_IMAGE_MODEL_CAPS["gemini-3-pro-image-preview"])
        self.assertEqual(main.apimart_image_model_caps("gpt-image-2-ext"),
                         main.APIMART_IMAGE_MODEL_CAPS["gpt-image-2"])
        self.assertEqual(main.apimart_image_model_caps("nano-banana-pro"),
                         main.APIMART_IMAGE_MODEL_CAPS["nano-banana-pro"])
        self.assertEqual(main.apimart_image_model_caps("cogview-4"), None)

    def test_nano_banana_2_aliases_hit_31_family(self):
        """nano-banana-2 / -2-ext / -2-lite / -2-lite-ext 是 3.1 家族的兼容别名（文档 L3337 / L4029），
        不能落到 nano-banana（Gemini 2.5）旧规格：2K/4K、4 个 1:4/4:1/1:8/8:1 比例、mask_url 都要在。"""
        full = main.apimart_image_model_caps("nano-banana-2")
        self.assertIs(full, main.APIMART_IMAGE_MODEL_CAPS["gemini-3-1-flash-image-preview"])
        for model in ("nano-banana-2", "nano-banana-2-ext", "gemini-3.1-flash-image-preview"):
            caps = main.apimart_image_model_caps(model)
            self.assertEqual(caps["resolutions"], ("0.5K", "1K", "2K", "4K"), model)
            self.assertEqual(len(caps["ratios"]), 15, model)
            self.assertIs(caps["mask_url"], True, model)
        lite = main.apimart_image_model_caps("nano-banana-2-lite")
        self.assertIs(lite, main.APIMART_IMAGE_MODEL_CAPS["gemini-3-1-flash-lite-image"])
        for model in ("nano-banana-2-lite", "nano-banana-2-lite-ext"):
            caps = main.apimart_image_model_caps(model)
            self.assertEqual(caps["resolutions"], ("1K",), model)
            self.assertEqual(len(caps["ratios"]), 15, model)
            self.assertIs(caps["mask_url"], True, model)
        # 旧规格（nano-banana）不能串味
        legacy = main.apimart_image_model_caps("nano-banana")
        self.assertEqual(legacy["resolutions"], ("1K",))
        self.assertEqual(len(legacy["ratios"]), 11)
        self.assertIs(legacy["mask_url"], False)

    def test_builtin_gpt_image_2_5_has_no_bare_id(self):
        # 上游 image 组只有 -ext / -flare / -sunburst，没有裸 gpt-image-2.5（2026-11-26 实测 /v1/models）
        values = main.APIMART_BUILTIN_MODEL_IDS["image"]["gpt-image-2-5"]
        self.assertEqual(values, ("gpt-image-2.5-flare", "gpt-image-2.5-sunburst"))
        self.assertNotIn("gpt-image-2.5", values)


class ApimartNewImageModels20261125Tests(unittest.TestCase):
    """2026-11-25 新增的 4 个图像模型（kling-v4-image / -long-image / mai-image-2.7 / -flash）。"""

    PROVIDER = {"id": "apimart", "protocol": "apimart"}

    def test_kling_v4_image_caps(self):
        caps = main.APIMART_IMAGE_MODEL_CAPS["kling-v4-image"]
        self.assertEqual(caps["ratios"],
                         ("auto", "16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"))
        self.assertEqual(caps["resolutions"], ("2K", "4K", "8K"))
        self.assertEqual(caps["n_max"], 9)
        self.assertEqual(caps["series"], {"min": 2, "max": 4})
        self.assertEqual(caps["ref_max"], 10)
        self.assertIs(caps["mask_url"], False)
        # 文档只收公网 URL（本地图先走上传接口），所以不能发 base64
        self.assertIs(caps["base64_refs"], False)

    def test_kling_v4_long_image_caps(self):
        caps = main.APIMART_IMAGE_MODEL_CAPS["kling-v4-long-image"]
        self.assertEqual(caps["ratios"], ())
        self.assertEqual(caps["resolutions"], ("1K", "2K"))
        self.assertEqual(caps["n_max"], 1)
        self.assertEqual(caps["ref_max"], 3)
        self.assertEqual(caps["skill"], ("ecommerce", "webpage"))
        self.assertEqual(caps["length"], ("short", "medium", "long"))
        # size/aspect_ratio/width/height 传了就 400 → 请求体不下发 size
        self.assertIs(caps["send_size"], False)

    def test_mai_image_2_7_caps(self):
        caps = main.APIMART_IMAGE_MODEL_CAPS["mai-image-2-7"]
        self.assertEqual(caps["ratios"], ())          # 任意整数比例 1:4–4:1，不收敛
        self.assertEqual(caps["resolutions"], ("1K", "2K"))
        self.assertEqual(caps["n_max"], 1)
        self.assertEqual(caps["ref_max"], 5)
        self.assertIs(caps["base64_refs"], True)
        self.assertEqual(caps["background"], ("auto", "opaque"))
        self.assertTrue(caps["exact_size"])
        self.assertTrue(caps["exact_size_pair"])
        self.assertEqual(caps["min_side"], 768)
        self.assertEqual(caps["max_pixels"], 4194304)
        self.assertEqual(caps["size_step"], 32)
        # 文档声明两版能力与参数完全一致 → -flash 复用同一条（最长 key 命中）
        self.assertIs(main.apimart_image_model_caps("mai-image-2.7-flash"), caps)

    def test_caps_payload_carries_new_fields(self):
        kling = main.model_caps_for(self.PROVIDER, "kling-v4-image", "image")
        self.assertEqual(kling["series"], {"min": 2, "max": 4})
        self.assertEqual(kling["n_max"], 9)
        long_image = main.model_caps_for(self.PROVIDER, "kling-v4-long-image", "image")
        self.assertIs(long_image["send_size"], False)
        self.assertEqual(long_image["skill"], ["ecommerce", "webpage"])
        self.assertEqual(long_image["length"], ["short", "medium", "long"])
        mai = main.model_caps_for(self.PROVIDER, "mai-image-2.7", "image")
        self.assertEqual(mai["min_side"], 768)
        self.assertEqual(mai["size_step"], 32)
        self.assertTrue(mai["exact_size_pair"])
        self.assertEqual(mai["background"], ["auto", "opaque"])

    def test_mai_exact_size_rules_differ_from_gpt_image(self):
        # 文档：两边 ≥768、总像素 ≤4194304、各自向下取 32 的倍数（1000x1000 → 992x992）
        self.assertEqual(main.normalize_mai_image_size("1000x1000"), "992x992")
        self.assertEqual(main.normalize_mai_image_size("2048x1152"), "2048x1152")
        self.assertEqual(main.normalize_mai_image_size("512x512"), "768x768")
        width, height = (int(part) for part in main.normalize_mai_image_size("2080x2048").split("x"))
        self.assertLessEqual(width * height, 4194304)
        self.assertEqual((width % 32, height % 32), (0, 0))
        # 4:1 的 4096x1024 正好卡在上限内：MAI 不动，GPT-Image 的 3840 长边规则会缩
        self.assertEqual(main.apimart_exact_size_value("4096x1024", main.APIMART_IMAGE_MODEL_CAPS["mai-image-2-7"]),
                         "4096x1024")
        self.assertNotEqual(main.normalize_gpt_image_2_size("4096x1024"), "4096x1024")

    def test_new_resolution_tiers(self):
        self.assertEqual(main.apimart_image_resolution_for_model("kling-v4-image", "8K"), "8K")
        self.assertEqual(main.apimart_image_resolution_for_model("kling-v4-image", "4K"), "4K")
        # 长图模型没有 4K：就近降到 2K
        self.assertEqual(main.apimart_image_resolution_for_model("kling-v4-long-image", "4K"), "2K")
        self.assertEqual(main.apimart_image_resolution_for_model("mai-image-2.7", "4K"), "2K")

    def test_direct_image_batches_do_not_clamp_nine(self):
        # kling-v4-image 单次能出 9 张：旧的写死 8 会吞掉一张
        self.assertEqual(main.direct_image_request_batches(self.PROVIDER, "kling-v4-image", 9), [9])
        self.assertEqual(main.direct_image_request_batches(self.PROVIDER, "mai-image-2.7", 3), [1, 1, 1])
        # 没有能力表的模型仍保持旧行为（单次最多 8 张）
        self.assertEqual(main.direct_image_request_batches(self.PROVIDER, "unknown-image-model", 9), [1] * 8)


class ApimartNativeBackgroundTests(unittest.TestCase):
    """原生透明背景：只有文档确证支持 background 参数的模型才声明，前端据此显隐入口。"""

    PROVIDER = {"id": "apimart", "protocol": "apimart", "base_url": "https://api.apimart.ai"}

    def test_native_background_flags_match_docs(self):
        # 文档确证 background 可选 auto/transparent/opaque（2.6 非 SVG 输出只允许 png/webp）
        for key in ("seedream-5-5", "gpt-image-2-6-flare", "gpt-image-2-6-sunburst",
                    "gpt-image-2-5", "gpt-image-1"):
            self.assertIs(main.APIMART_IMAGE_MODEL_CAPS[key].get("native_background"), True, key)
        # 文档没有 background 参数（ext 系列传入不报错但不生效，基础版 2 没有该参数）；
        # seedream-5-0 只在「图生图 + 恰好 1 张自带 alpha 的输入图 + png」时可用，不是通用选项
        for key in ("gpt-image-2-6-ext", "gpt-image-2-5-ext", "gpt-image-2",
                    "seedream-5-0-pro", "seedream-5-0-flash", "seedream-5-0-lite"):
            self.assertFalse(main.APIMART_IMAGE_MODEL_CAPS[key].get("native_background"), key)

    def test_support_check_reads_caps_not_model_name(self):
        self.assertIs(main.image_supports_native_transparent_background(self.PROVIDER, "seedream-5-5"), True)
        self.assertIs(main.image_supports_native_transparent_background(self.PROVIDER, "seedream-5.5"), True)
        self.assertIs(main.image_supports_native_transparent_background(self.PROVIDER, "seedream-5-0-pro"), False)
        self.assertIs(main.image_supports_native_transparent_background(self.PROVIDER, "gpt-image-2.6-flare"), True)
        self.assertIs(main.image_supports_native_transparent_background(self.PROVIDER, "gpt-image-2.6-ext"), False)

    def test_caps_payload_declares_native_background_only_when_supported(self):
        caps_55 = main.model_caps_for(self.PROVIDER, "seedream-5-5", "image")
        self.assertIs(caps_55.get("native_background"), True)
        for model in ("gpt-image-2.6-flare", "gpt-image-2.6-sunburst"):
            self.assertIs(main.model_caps_for(self.PROVIDER, model, "image").get("native_background"), True, model)
        # 不支持的模型连字段都不下发（与 n_max / thinking_mode 一样「有才下发」）
        for model in ("seedream-5-0-pro", "gpt-image-2.6-ext", "gpt-image-2.5-ext"):
            self.assertIsNone(main.model_caps_for(self.PROVIDER, model, "image").get("native_background"), model)


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

    def test_seedream_5_5_clamps_4k_to_2k(self):
        self.assertEqual(main.apimart_image_resolution_for_model("seedream-5-5", "4K"), "2K")
        # 点号写法由 apimart_image_caps_key 归一成同一个 key，1.5K 档位原样保留
        self.assertEqual(main.apimart_image_resolution_for_model("seedream-5.5", "1.5K"), "1.5K")

    def test_special_resolution_levels_survive_pixel_mapping(self):
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("768x768", "flux-3-image-klein"), "768SQ")
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("1536x1536", "flux-3-image-klein"), "1.5K")
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("2048x1152", "seedream-5-0-pro"), "1.5K")
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("2048x2048", "seedream-5-0-pro"), "2K")
        self.assertEqual(main.apimart_image_resolution_from_size_for_model("2880x2880", "gpt-image-2"), "4k")

    def test_lite_stays_1k(self):
        # 真别名是 nano-banana-2-lite（文档 L4029）；旧的 nano-banana-lite key 从来命不中，已删
        self.assertEqual(main.apimart_image_resolution_for_model("nano-banana-2-lite", "4K"), "1K")
        self.assertEqual(main.apimart_image_resolution_for_model("nano-banana-2-lite-ext", "2K"), "1K")
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
        self.assertIn("apimart_caps = apimart_image_caps_for(provider, model) or {}", source)
        self.assertIn('apimart_size = apimart_clamp_ratio(apimart_size, apimart_caps.get("ratios"))', source)
        self.assertIn("apimart_image_resolution_from_size_for_model(size, model, caps=apimart_caps)", source)
        self.assertIn("apimart_image_resolution_for_model(model, resolution, caps=apimart_caps)", source)


class ApimartVideoAudioCapsTests(unittest.TestCase):
    """视频原生音频：caps 只在「能出声音且请求里能明确开关」时才下发 audio。

    判据与请求体分支共用 apimart_video_audio_field，全部来自 APIMart 文档（docs.apimart.ai/cn）：
      * 有 audio / generate_audio 布尔参数的才算开关（seedance 2.x / 2.5-flash / 1.5-pro、apimart-zoe、
        kling-v3 / v3-omni）；
      * Kling v4 / v4-flash 文档写「始终带立体声音轨」（只有 audio_setting 选沿用原声还是重生成）、
        Muse Video Ext 传 false 直接 400、Gemini Omni / MiniMax-H3 / VEO3.1 没有音频参数、恒定带音轨 →
        一律不下发，免得面板给一个关不掉（或开了也没用）的开关。"""

    provider = {"id": "apimart", "protocol": "apimart"}

    def caps(self, model):
        return main.model_caps_for(self.provider, model, "video") or {}

    def test_switchable_models_declare_audio(self):
        for model in ("seedance-2.5", "seedance-2.0", "seedance-2-5-flash", "seedance-1-5-pro",
                      "apimart-zoe", "kling-v3", "kling-v3-omni"):
            self.assertIs(self.caps(model).get("audio"), True, model)

    def test_auto_audio_models_do_not_declare_switch(self):
        # 恒定带音轨 / 没有音频参数 / 只有 audio_setting → 不给开关
        for model in ("kling-v4", "kling-v4-flash", "gemini-omni-1.2-flash", "gemini-omni-1.2-flash-ext",
                      "muse-video-ext", "MiniMax-H3", "MiniMax-H3-Max", "veo3.1-fast", "veo3.1-quality"):
            self.assertNotIn("audio", self.caps(model), model)

    def test_audio_field_per_family(self):
        # 字段名与「默认是否带声音」按文档区分：Seedance 2.x / Zoe 默认有声（要显式 false 才关），
        # Seedance 1.5 Pro 的字段叫 audio、默认 true；Kling v3 默认 false（只开时发 true）
        self.assertEqual(main.apimart_video_audio_field(main.APIMART_VIDEO_MODEL_CAPS["seedance-2-5"]), "generate_audio")
        self.assertEqual(main.apimart_video_audio_field(main.APIMART_VIDEO_MODEL_CAPS["apimart-zoe"]), "generate_audio")
        self.assertEqual(main.apimart_video_audio_field(main.APIMART_VIDEO_MODEL_CAPS["seedance-1-5-pro"]), "audio")
        self.assertEqual(main.apimart_video_audio_field(main.APIMART_VIDEO_MODEL_CAPS["kling-v3"]), "audio")
        self.assertTrue(main.APIMART_VIDEO_MODEL_CAPS["kling-v3"]["audio_default_on"] is False)
        self.assertTrue(main.APIMART_VIDEO_MODEL_CAPS["apimart-zoe"]["audio_default_on"] is True)
        self.assertEqual(main.apimart_video_audio_field(main.APIMART_VIDEO_MODEL_CAPS["kling-v4"]), "")
        self.assertEqual(main.apimart_video_audio_field(None), "")

    def test_wan_vidu_pixverse_flux_audio(self):
        # 文档都写明 audio 布尔、false 出静音片
        for model in ("wan2.6", "wan2.6-i2v-flash", "wan3.0-video-prime", "viduq3-turbo",
                      "viduq4-preview", "pixverse-v6-max", "flux-3-video"):
            self.assertIs(self.caps(model).get("audio"), True, model)
        # wan2.5 文档写明「只支持 audio=true」；happyhorse 只有 audio_setting；skyreels 只收参考音频
        for model in ("wan2.5-preview", "happyhorse-1.0", "skyreels-v4-fast"):
            self.assertNotIn("audio", self.caps(model), model)
        # 默认静音的（pixverse，开了更贵）只在开时发 true；默认带声音的两种值都发
        self.assertIs(main.APIMART_VIDEO_MODEL_CAPS["pixverse-v6"]["audio_default_on"], False)
        self.assertIs(main.APIMART_VIDEO_MODEL_CAPS["wan2-6"]["audio_default_on"], True)
        self.assertIs(main.APIMART_VIDEO_MODEL_CAPS["flux-3-video"]["audio_default_on"], True)

    def test_volcengine_seedance_2x_declares_audio(self):
        # 火山分支请求体本来就发 generate_audio（开 true / 关显式 false）→ 能力表要给入口
        volc = {"id": "volcengine", "protocol": "volcengine"}
        for model in ("doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128", "doubao-seedance-2-5-260628"):
            caps = main.model_caps_for(volc, model, "video") or {}
            self.assertIs(caps.get("audio"), True, model)
        # Seedance 1.x 请求侧没有 generate_audio → 不声明
        for model in ("doubao-seedance-1-0-pro-250528", "doubao-seedance-1-5-pro-250528"):
            caps = main.model_caps_for(volc, model, "video") or {}
            self.assertNotIn("audio", caps, model)

    def test_request_branch_uses_shared_field(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn("apimart_audio_field = apimart_video_audio_field(apimart_video_caps)", source)
        self.assertIn('elif payload.generate_audio and (apimart_video_caps is None or apimart_video_caps.get("generate_audio")):', source)
        # 默认带声音的模型（seedance / zoe / 1.5-pro）关声音必须显式发 false
        self.assertIn('if (apimart_video_caps or {}).get("audio_default_on"):', source)
        # 上游字段名按模型来：Seedance / Zoe 用 generate_audio，Wan / Vidu / PixVerse / FLUX / Kling 用 audio
        self.assertIn("body[apimart_audio_field] = bool(payload.generate_audio)", source)
        self.assertIn("body[apimart_audio_field] = True", source)


class ApimartMagi2CapsTests(unittest.TestCase):
    """magi-2（文档 2026-11-26 L40642–L40910）：固定 1080p / 4–30 整秒 / 默认带声 / 参考 10-5-5 / 无编辑延长。"""

    provider = {"id": "apimart", "protocol": "apimart", "base_url": "https://apib.ai"}

    def caps(self):
        return main.model_caps_for(self.provider, "magi-2", "video") or {}

    def test_caps_table_entry(self):
        table = main.APIMART_VIDEO_MODEL_CAPS["magi-2"]
        self.assertEqual(tuple(range(4, 31)), tuple(table["durations"]))
        self.assertEqual(("1080p",), tuple(table["resolutions"]))
        self.assertEqual(("16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"), tuple(table["ratios"]))
        self.assertEqual("aspect_ratio", table["ratio_key"])
        self.assertTrue(table["ratio_follows_first_frame"])   # 图生视频不含 21:9，auto/省略跟随首帧
        self.assertTrue(table["omni_task_type"])
        self.assertTrue(table["reject_edit_modes"])           # edit/extend 上游 400 → 本地先拦
        self.assertEqual("generate_audio", table["audio_field"])
        self.assertTrue(table["audio_default_on"])
        self.assertTrue(table["seed"])
        self.assertFalse(table["watermark"])
        self.assertTrue(table["nsfw_check"])
        # 2026-11-27：通用提交分支改为按本表声明下发 → 按文档写 10 / 5 / 5
        self.assertEqual((10, 5, 5), (table["ref_max"], table["video_ref_max"], table["audio_ref_max"]))

    def test_caps_payload(self):
        caps = self.caps()
        self.assertEqual(list(range(4, 31)), caps["durations"])
        self.assertEqual(["1080p"], caps["resolutions"])
        self.assertEqual(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"], caps["ratios"])
        self.assertEqual(["text_to_video", "image_to_video", "start_end_to_video", "reference_to_video"],
                         caps["modes"])
        self.assertNotIn("video_edit", caps["modes"])
        self.assertNotIn("video_extend", caps["modes"])
        self.assertTrue(caps["audio"])
        self.assertTrue(caps["audio_default_on"])           # 前端据此把音频开关默认打开
        self.assertTrue(caps["ratio_follows_first_frame"])  # 首帧方式整段不发比例
        self.assertTrue(caps["nsfw_check"])
        self.assertEqual((10, 5, 5), (caps["ref_max"], caps["video_ref_max"], caps["audio_ref_max"]))

    def test_nsfw_flag_only_on_magi2(self):
        for model in ("seedance-2.5", "apimart-zoe", "kling-v4", "gemini-omni-1.2-flash"):
            self.assertNotIn("nsfw_check", main.model_caps_for(self.provider, model, "video") or {}, model)

    def test_builtin_video_ids_include_magi2(self):
        self.assertEqual(("magi-2",), main.APIMART_BUILTIN_MODEL_IDS["video"]["magi-2"])

    def test_bool_flags_only_when_table_declares(self):
        # 字段缺失 = 后端不掌握：没声明的模型不会凭空多出这两个位
        for model in ("MiniMax-H3", "gemini-omni-1.2-flash", "veo3.1-fast"):
            caps = main.model_caps_for(self.provider, model, "video") or {}
            self.assertNotIn("audio_default_on", caps, model)
            self.assertNotIn("ratio_follows_first_frame", caps, model)
        # 声明了 audio_default_on（默认有声、关声要显式发 false）的模型才带；它不跟随首帧
        seedance = main.model_caps_for(self.provider, "seedance-2.0", "video") or {}
        self.assertIs(seedance.get("audio_default_on"), True)
        self.assertNotIn("ratio_follows_first_frame", seedance)
        # 只声明跟随首帧、声音默认关（audio_default_on 显式 False）的模型只带后者
        kling = main.model_caps_for(self.provider, "kling-v4", "video") or {}
        self.assertIs(kling.get("ratio_follows_first_frame"), True)
        self.assertNotIn("audio_default_on", kling)

    def test_update_package_whitelist_keeps_new_bool_flags(self):
        normalized = main._protocol_updates.normalize_caps({
            "audio_default_on": True, "ratio_follows_first_frame": True, "nsfw_check": True})
        self.assertEqual(normalized, {"audio_default_on": True, "ratio_follows_first_frame": True,
                                      "nsfw_check": True})


if __name__ == "__main__":
    unittest.main()
