"""APIMart 视频模型参数表：按官方文档把 duration / 比例字段 / 分辨率字段收敛到该模型口径。

官方出处：/tmp/apimart-docs/cn/api-reference/videos/*（docs.apib.ai 镜像，内容与 docs.apimart.ai 一致）
  * 24 个模型用 aspect_ratio、13 个用 size（报告 REPORT.md 第 5 节）；
  * seedance-2.0：duration 4-15、size 7 值含 adaptive、resolution 480p/720p/1080p/4k；
  * veo3：固定 8s、aspect_ratio 16:9/9:16（走独立的 apimart_veo31_* 分支，本表不重复）；
  * kling-v3 / v3-omni：duration 3-15、mode std/pro/4k；kling-3.0-turbo 仍用 resolution 720p/1080p；
  * kling-video-o1 / v2-6：duration 只能 5 或 10；
  * minimax-hailuo：5/10s；hailuo-2.3：6/10s；minimax-h3：4-15s；
  * wan2.5：5/10s、720p/1080p；wan2.6：5/10/15s；wan2.7：2-15s；wan3.0：2-30s；
  * vidu q3：3-16s（mix 1-16s）、540p/720p/1080p；pixverse v6：1-15s、360p~1080p；
  * flux-3-video：5-20s、hd/fhd；happyhorse：3-15s、720P/1080P；gemini-omni：无 duration 参数，3-10s 由模型决定。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class ApimartVideoCapsTableTests(unittest.TestCase):

    def test_table_covers_documented_families(self):
        for key in (
            "seedance-2-0", "seedance-1-5-pro", "seedance-1-0-pro", "seedance-2-5",
            "kling-v3", "kling-v3-omni", "kling-video-o1", "kling-3-0-turbo", "kling-v2-6",
            "minimax-hailuo", "minimax-hailuo-2-3", "minimax-h3", "minimax-h3-max",
            "wan2-5", "wan2-6", "wan2-7", "wan2-7-r2v", "wan2-7-videoedit", "wan3-0-video",
            "viduq3", "viduq3-mix", "viduq3-pro", "viduq4-preview", "pixverse-v6",
            "flux-3-video", "happyhorse-1-0", "happyhorse-1-1", "skyreels-v4",
            "grok-imagine-video", "gemini-omni-1-1-flash", "gemini-omni-1-1-flash-ext",
            "gemini-omni-flash-preview",
            # 2026-11-13 文档新增（统一入口 + omni_reference_task_type）
            "apimart-zoe", "kling-v4", "kling-v4-flash", "gemini-omni-1-2-flash",
            "gemini-omni-1-2-flash-ext", "veo3-1", "veo3-1-lite",
        ):
            self.assertIn(key, main.APIMART_VIDEO_MODEL_CAPS, key)
        self.assertGreaterEqual(len(main.APIMART_VIDEO_MODEL_CAPS), 30)

    def test_field_names_follow_docs(self):
        self.assertEqual(main.APIMART_VIDEO_MODEL_CAPS["seedance-2-0"]["ratio_key"], "size")
        self.assertEqual(main.APIMART_VIDEO_MODEL_CAPS["seedance-2-0"]["resolution_key"], "resolution")
        self.assertEqual(main.APIMART_VIDEO_MODEL_CAPS["kling-v3"]["ratio_key"], "aspect_ratio")
        self.assertEqual(main.APIMART_VIDEO_MODEL_CAPS["kling-v3"]["resolution_key"], "mode")
        self.assertEqual(main.APIMART_VIDEO_MODEL_CAPS["kling-3-0-turbo"]["resolution_key"], "resolution")
        self.assertEqual(main.APIMART_VIDEO_MODEL_CAPS["gemini-omni-1-1-flash"]["durations"], None)
        self.assertTrue(main.APIMART_VIDEO_MODEL_CAPS["gemini-omni-1-1-flash"]["generate_audio"])
        self.assertFalse(main.APIMART_VIDEO_MODEL_CAPS["kling-v3"]["generate_audio"])

    def test_caps_lookup_alias_and_unknown(self):
        self.assertEqual(main.apimart_video_model_caps("doubao-seedance-2.0"),
                         main.APIMART_VIDEO_MODEL_CAPS["seedance-2-0"])
        self.assertEqual(main.apimart_video_model_caps("MiniMax-Hailuo-2.3"),
                         main.APIMART_VIDEO_MODEL_CAPS["minimax-hailuo-2-3"])
        self.assertIsNone(main.apimart_video_model_caps("some-unknown-video"))


class ApimartVideoBodyParamsTests(unittest.TestCase):

    def params(self, model, duration, ratio, resolution):
        return main.apimart_video_body_params(model, duration, ratio, resolution)

    def test_seedance_2_0_uses_size_and_clamps_duration(self):
        params = self.params("seedance-2.0", 20, "21:9", "4k")
        self.assertEqual(params["duration"], 15)
        self.assertEqual(params["ratio_key"], "size")
        self.assertEqual(params["ratio_value"], "21:9")
        self.assertEqual(params["resolution_key"], "resolution")
        self.assertEqual(params["resolution_value"], "4k")

    def test_seedance_keep_ratio_maps_adaptive_and_default_720p(self):
        params = self.params("seedance-2.0", 20, "keep_ratio", "")
        self.assertEqual(params["ratio_value"], "adaptive")
        self.assertEqual(params["resolution_value"], "720p")

    def test_kling_v3_uses_aspect_ratio_and_mode(self):
        params = self.params("kling-v3", 1, "21:9", "1080p")
        self.assertEqual(params["duration"], 3)
        self.assertEqual(params["ratio_key"], "aspect_ratio")
        self.assertEqual(params["ratio_value"], "16:9")
        self.assertEqual(params["resolution_key"], "mode")
        self.assertEqual(params["resolution_value"], "pro")
        self.assertEqual(self.params("kling-v3", 20, "9:16", "4k")["resolution_value"], "4k")

    def test_kling_o1_only_5_or_10_seconds(self):
        params = self.params("kling-video-o1", 20, "16:9", "4k")
        self.assertEqual(params["duration"], 10)
        self.assertEqual(params["resolution_value"], "pro")
        self.assertEqual(self.params("kling-video-o1", 1, "16:9", "720p")["duration"], 5)

    def test_kling_turbo_keeps_resolution_field(self):
        params = self.params("kling-3.0-turbo", 20, "16:9", "4k")
        self.assertEqual(params["duration"], 15)
        self.assertEqual(params["resolution_key"], "resolution")
        self.assertEqual(params["resolution_value"], "1080p")

    def test_minimax_hailuo_only_5_or_10_and_no_ratio_field(self):
        params = self.params("minimax-hailuo", 7, "16:9", "720p")
        self.assertEqual(params["duration"], 5)
        self.assertIsNone(params["ratio_key"])
        self.assertEqual(params["resolution_value"], "768p")
        self.assertEqual(self.params("minimax-hailuo-2.3", 5, "16:9", "720p")["duration"], 6)

    def test_wan25_and_wan30_duration_ranges(self):
        self.assertEqual(self.params("wan2.5-preview", 7, "16:9", "1080p")["duration"], 5)
        self.assertEqual(self.params("wan3.0-video", 40, "16:9", "4k")["duration"], 30)

    def test_vidu_q3_base_vs_mix(self):
        self.assertEqual(self.params("viduq3", 1, "16:9", "480p")["duration"], 3)
        self.assertEqual(self.params("viduq3-mix", 1, "16:9", "480p")["duration"], 1)
        self.assertEqual(self.params("viduq3", 8, "16:9", "480p")["resolution_value"], "540p")

    def test_pixverse_clamps(self):
        params = self.params("pixverse-v6", 30, "16:9", "4k")
        self.assertEqual(params["duration"], 15)
        self.assertEqual(params["resolution_value"], "1080p")
        self.assertEqual(params["ratio_key"], "size")

    def test_flux3_video_hd_fhd(self):
        self.assertEqual(self.params("flux-3-video", 30, "21:9", "1080p")["resolution_value"], "fhd")
        self.assertEqual(self.params("flux-3-video", 30, "21:9", "720p")["resolution_value"], "hd")

    def test_happyhorse_uppercase_resolution(self):
        self.assertEqual(self.params("happyhorse-1.0", 1, "16:9", "1080p")["resolution_value"], "1080P")
        self.assertEqual(self.params("happyhorse-1.0", 1, "16:9", "1080p")["duration"], 3)

    def test_gemini_omni_has_no_duration(self):
        params = self.params("gemini-omni-1.1-flash", 20, "9:16", "1080p")
        self.assertIsNone(params["duration"])
        self.assertEqual(params["ratio_value"], "9:16")
        self.assertEqual(params["resolution_value"], "1080p")

    def test_kling_v4_uses_resolution_not_mode(self):
        # 文档：V4 用 resolution 选档（720p/1080p），明确「不支持 mode」
        params = self.params("kling-v4", 40, "21:9", "1080p")
        self.assertEqual(params["duration"], 30)
        self.assertEqual(params["ratio_key"], "aspect_ratio")
        self.assertEqual(params["resolution_key"], "resolution")
        self.assertEqual(params["resolution_value"], "1080p")
        self.assertEqual(self.params("kling-v4", 1, "16:9", "720p")["duration"], 3)

    def test_kling_v4_flash_only_720p(self):
        params = self.params("kling-v4-flash", 40, "16:9", "1080p")
        self.assertEqual(params["duration"], 20)
        self.assertEqual(params["resolution_value"], "720p")

    def test_apimart_zoe_durations_and_resolutions(self):
        params = self.params("apimart-zoe", 20, "adaptive", "4k")
        self.assertEqual(params["duration"], 20)
        self.assertEqual(params["ratio_value"], "adaptive")
        self.assertEqual(params["resolution_value"], "4k")

    def test_gemini_omni_1_2_duration_range(self):
        self.assertEqual(self.params("gemini-omni-1.2-flash", 20, "16:9", "1080p")["duration"], 15)
        self.assertEqual(self.params("gemini-omni-1.2-flash-ext", 1, "9:16", "2160p")["duration"], 3)
        self.assertEqual(self.params("gemini-omni-1.2-flash-ext", 1, "9:16", "2160p")["resolution_value"], "4k")

    def test_veo31_family_hits_longest_key(self):
        # ext 档固定 8 秒、比例只有 16:9/9:16、分辨率到 4k；lite 只出文生视频
        self.assertIs(main.apimart_video_model_caps("veo3.1-fast"), main.APIMART_VIDEO_MODEL_CAPS["veo3-1"])
        self.assertIs(main.apimart_video_model_caps("veo3.1-fast-ext"), main.APIMART_VIDEO_MODEL_CAPS["veo3-1"])
        self.assertIs(main.apimart_video_model_caps("veo3.1-lite"), main.APIMART_VIDEO_MODEL_CAPS["veo3-1-lite"])
        self.assertEqual(main.APIMART_VIDEO_MODEL_CAPS["veo3-1"]["durations"], (8,))
        self.assertEqual(main.APIMART_VIDEO_MODEL_CAPS["veo3-1"]["resolutions"], ("720p", "1080p", "4k"))
        self.assertEqual(main.apimart_video_modes("veo3.1-lite", main.APIMART_VIDEO_MODEL_CAPS["veo3-1-lite"]),
                         ["text_to_video"])

    def test_new_models_pin_modes_and_flags(self):
        zoe = main.APIMART_VIDEO_MODEL_CAPS["apimart-zoe"]
        self.assertTrue(zoe["omni_task_type"])
        self.assertNotIn("video_extend", zoe["modes"])  # zoe 不支持 extend（文档 400）
        v4 = main.APIMART_VIDEO_MODEL_CAPS["kling-v4"]
        self.assertTrue(v4["ratio_follows_first_frame"])
        self.assertTrue(v4["audio_urls"])
        flash = main.APIMART_VIDEO_MODEL_CAPS["kling-v4-flash"]
        self.assertFalse(flash["audio_urls"])
        self.assertNotIn("start_end_to_video", flash["modes"])  # flash 首帧只收 1 张
        self.assertEqual(main.apimart_video_modes("kling-v4-flash", flash),
                         list(flash["modes"]))

    def test_unknown_model_keeps_legacy_field_names(self):
        params = self.params("some-unknown-video", 20, "9:21", "1080p")
        self.assertEqual(params["duration"], 15)
        self.assertEqual(params["ratio_key"], "size")
        self.assertEqual(params["ratio_value"], "16:9")
        self.assertEqual(params["resolution_key"], "resolution")
        self.assertEqual(params["resolution_value"], "1080p")


class ApimartVideoBranchSourceTests(unittest.TestCase):

    def test_branch_uses_body_params_and_gates_flags(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn("video_params = apimart_video_body_params(", source)
        self.assertIn('body[video_params["ratio_key"]] = video_params["ratio_value"]', source)

    def test_branch_wires_new_unified_entry_protocol(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        # 统一入口三件事必须都在请求体组装里出现，且都由能力表开关控制（不能按模型名猜）
        self.assertIn('body["omni_reference_task_type"] = apimart_omni_task', source)
        self.assertIn('.get("omni_task_type")', source)
        self.assertIn('apimart_omit_ratio', source)
        self.assertIn('.get("ratio_follows_first_frame")', source)
        # 首帧方式禁发画幅：赋值处必须被 apimart_omit_ratio 挡住（含 adaptive 的两处覆盖）
        self.assertEqual(source.count("and not apimart_omit_ratio"), 3)
        # 「角色化图片 + 参考视频」的 400 只对老模型生效
        self.assertIn('and not (apimart_video_caps or {}).get("omni_task_type"):', source)
        self.assertIn('body[video_params["resolution_key"]] = video_params["resolution_value"]', source)
        self.assertIn('apimart_video_caps is None or apimart_video_caps.get("seed")', source)
        self.assertIn('apimart_video_caps is None or apimart_video_caps.get("generate_audio")', source)


if __name__ == "__main__":
    unittest.main()
