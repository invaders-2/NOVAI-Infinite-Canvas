"""model-caps 两处语义收口：n_max 明确化（缺失=不掌握，不再 null）+ 视频 modes 填实。

覆盖：
  1. 图片 n_max：apimart 用能力表（如 gpt-image-2=4、gpt-image-1=4）；agnes/gemini/volcengine/jimeng
     的请求组装都不发 n → 单请求恒 1 张，明确写 1；**任何条目都不再出现 null**；
  2. 缺失语义：_caps_payload 在 n_max/modes 未知时直接不下发该字段（前端据「缺字段」走自己的兜底）；
  3. 视频 n_max 恒为 1（一次任务一条视频，CanvasVideoRequest 没有 n）；
  4. 视频 modes：按 APIMART_VIDEO_MODEL_CAPS 标记 + 请求体拼装分支推出来（种子系全 5 种、kling 角色版、
     wan2-7-videoedit 只有编辑/延长、agnes/volcengine 各自的集合），取值必须是前端 VMODES 的接口值；
  5. 拿不准的：没有能力表的视频模型（lovart/runninghub 等）不产生条目；图片不下发 modes。
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
VOLC = {"id": "volcengine", "protocol": "volcengine", "base_url": "https://ark.cn-beijing.volces.com/api/v3"}
JIMENG = {"id": "jimeng", "protocol": "jimeng", "base_url": ""}
MODELSCOPE = {"id": "modelscope", "protocol": "openai", "base_url": "https://api-inference.modelscope.cn/v1"}
LOVART = {"id": "lovart", "protocol": "lovart", "base_url": "https://lgw.lovart.ai"}

VMODE_VALUES = set(main.VIDEO_MODE_VALUES)


class ImageNMaxTests(unittest.TestCase):
    def test_apimart_uses_the_authoritative_table(self):
        self.assertEqual(main.model_caps_for(APIMART, "gpt-image-2", "image")["n_max"], 4)
        self.assertEqual(main.model_caps_for(APIMART, "gpt-image-1", "image")["n_max"], 4)
        self.assertEqual(main.model_caps_for(APIMART, "gemini-3-pro-image-preview", "image")["n_max"], 1)

    def test_platforms_that_never_send_n_report_one(self):
        # 请求体里没有 n（agnes 注释写明不传顶层 n；gemini/volcengine 无 n 字段；jimeng 走 CLI）
        self.assertEqual(main.model_caps_for(AGNES, "agnes-image-2.5-flash", "image")["n_max"], 1)
        self.assertEqual(main.model_caps_for(GEMINI, "gemini-3-pro-image-preview", "image")["n_max"], 1)
        self.assertEqual(main.model_caps_for(VOLC, "doubao-seedream-5-0-pro", "image")["n_max"], 1)
        self.assertEqual(main.model_caps_for(JIMENG, "4.7", "image")["n_max"], 1)

    def test_no_null_anywhere(self):
        for provider, model, kind in ((APIMART, "gpt-image-2", "image"), (AGNES, "agnes-image-2.5-flash", "image"),
                                      (GEMINI, "gemini-3-pro-image-preview", "image"),
                                      (VOLC, "doubao-seedream-5-0-pro", "image"), (JIMENG, "4.7", "image"),
                                      (APIMART, "seedance-2-0", "video"), (AGNES, "agnes-video-2.5", "video")):
            caps = main.model_caps_for(provider, model, kind)
            self.assertIn("n_max", caps, (model, kind))
            self.assertIsInstance(caps["n_max"], int, (model, kind))
            self.assertGreaterEqual(caps["n_max"], 1, (model, kind))

    def test_unknown_limits_are_omitted_not_null(self):
        payload = main._caps_payload(["1:1"], ["1K"])
        self.assertNotIn("n_max", payload)
        self.assertNotIn("modes", payload)
        # 没有权威规格的模型根本不产生条目（不是给个 null）
        self.assertIsNone(main.model_caps_for(MODELSCOPE, "Tongyi-MAI/Z-Image-Turbo", "image"))
        self.assertIsNone(main.model_caps_for(LOVART, "generate_image_gpt_image_2_5_flare", "image"))

    def test_endpoint_never_emits_null_n_max_or_modes(self):
        with unittest.mock.patch.object(main, "load_api_providers", return_value=[
                {"id": "apimart", "protocol": "apimart", "base_url": "https://apib.ai", "enabled": True,
                 "image_models": ["gpt-image-2", "midjourney"], "video_models": ["seedance-2-0"], "image_model": ""},
                {"id": "agnes-ai", "protocol": "openai", "base_url": "https://apihub.agnes-ai.com", "enabled": True,
                 "image_models": ["agnes-image-2.5-flash"], "video_models": ["agnes-video-2.5"], "image_model": ""}]):
            main.invalidate_model_caps_cache()
            payload = main._model_caps_payload(admin=True)
        main.invalidate_model_caps_cache()
        for item in payload["items"]:
            self.assertIsNotNone(item.get("n_max"), item)
            self.assertNotIn(None, [item.get("n_max")], item)
            if item["kind"] == "image":
                self.assertNotIn("modes", item, item)


class VideoNMaxAndModesTests(unittest.TestCase):
    def test_video_n_max_is_one(self):
        for model in ("seedance-2-0", "kling-v3", "wan2-7-videoedit", "minimax-hailuo"):
            self.assertEqual(main.model_caps_for(APIMART, model, "video")["n_max"], 1, model)
        self.assertEqual(main.model_caps_for(AGNES, "agnes-video-2.5", "video")["n_max"], 1)
        self.assertEqual(main.model_caps_for(VOLC, "doubao-seedance-2-0", "video")["n_max"], 1)

    def test_seedance_supports_all_input_shapes(self):
        modes = main.model_caps_for(APIMART, "seedance-2-5", "video")["modes"]
        self.assertEqual(modes, ["text_to_video", "image_to_video", "start_end_to_video",
                                 "reference_to_video", "reference_video_to_video"])

    def test_image_with_roles_models_get_frame_and_reference_modes(self):
        modes = main.model_caps_for(APIMART, "kling-v3-omni", "video")["modes"]
        self.assertIn("start_end_to_video", modes)
        self.assertIn("reference_to_video", modes)
        # image_with_roles=False 的型号只敢声明文生 + 图生（角色能力没有权威标记）
        plain = main.model_caps_for(APIMART, "kling-v3", "video")["modes"]
        self.assertEqual(plain, ["text_to_video", "image_to_video"])

    def test_edit_only_model_gets_edit_and_extend_only(self):
        modes = main.model_caps_for(APIMART, "wan2-7-videoedit", "video")["modes"]
        self.assertEqual(modes, ["video_edit", "video_extend"])
        self.assertNotIn("text_to_video", modes)

    def test_agnes_and_volcengine_modes(self):
        agnes = main.model_caps_for(AGNES, "agnes-video-2.5-flash", "video")["modes"]
        self.assertEqual(agnes, ["text_to_video", "image_to_video", "start_end_to_video", "reference_to_video"])
        volc = main.model_caps_for(VOLC, "doubao-seedance-2-0", "video")["modes"]
        self.assertIn("start_end_to_video", volc)
        self.assertIn("reference_video_to_video", volc)
        self.assertIn("video_edit", volc)

    def test_every_mode_is_a_frontend_vmode_value(self):
        items = [main.model_caps_for(p, m, "video") for p, m in (
            (APIMART, "seedance-2-0"), (APIMART, "kling-v3"), (APIMART, "wan2-7-videoedit"),
            (APIMART, "gemini-omni-1-1-flash"), (AGNES, "agnes-video-2.5"), (AGNES, "agnes-video-v2.0"),
            (VOLC, "doubao-seedance-2-0"))]
        for caps in items:
            self.assertTrue(caps["modes"], caps)
            self.assertTrue(set(caps["modes"]) <= VMODE_VALUES, caps["modes"])

    def test_unknown_video_caps_omit_modes(self):
        # 没有能力表 → 不产生条目；_caps_payload 不传 modes → 字段直接缺失
        self.assertIsNone(main.model_caps_for(LOVART, "generate_video_kling_v3", "video"))
        self.assertIsNone(main.model_caps_for(MODELSCOPE, "some-video-model", "video"))
        self.assertIsNone(main.apimart_video_modes("whatever", None))
        payload = main._caps_payload(["16:9"], ["720p"], n_max=1, durations=[5], modes=None)
        self.assertNotIn("modes", payload)
        self.assertEqual(payload["n_max"], 1)


if __name__ == "__main__":
    unittest.main()
