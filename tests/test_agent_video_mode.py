"""generate_video 的生成方式入参（mode）+ 数字人 / 视频延长进模型规格。

覆盖：
  1. mode 归一：接口值 / 中文名都认，脏值拒绝；
  2. 工具 schema：generate_video 暴露 mode 且枚举值就是 VMODES 接口值；
  3. 有 caps 的模型：不支持的方式报清晰错误（带支持列表），支持的方式透传进任务组装；
  4. 不传 mode：保持自动推断（norm["mode"] == ""），不破坏既有调用；
  5. 组装侧：mode 明确时先校验输入（首尾帧要 2 张图、数字人要视频），数字人只能走 PixVerse 口播通道；
  6. caps：pixverse-lipsync 只声明 digital_human；wan2-7-videoedit + 火山 seedance 声明 video_extend。
"""
import asyncio
import sys
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

APIMART = {"id": "apimart", "protocol": "apimart", "base_url": "https://apib.ai",
           "image_models": [], "video_models": ["seedance-2-0", "kling-v3"], "enabled": True}
VOLC = {"id": "volcengine", "protocol": "volcengine", "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "enabled": True, "image_models": [], "video_models": ["doubao-seedance-2-0"]}
PIXVERSE = {"id": "pixverse", "protocol": "pixverse", "base_url": "https://app-api.pixverse.ai",
            "enabled": True, "image_models": [], "video_models": ["pixverse-lipsync"]}


def canvas():
    return {"id": "c1", "kind": "classic", "nodes": [], "connections": []}


def patched(provider=APIMART):
    return [
        unittest.mock.patch.object(main, "load_canvas", return_value=canvas()),
        unittest.mock.patch.object(main, "get_api_provider", return_value=provider),
        unittest.mock.patch.object(main, "_agent_resolve_media_target",
                                   return_value=(provider["id"], provider["video_models"][0], "")),
    ]


class VideoModeNormalizeTests(unittest.TestCase):
    def test_api_values_and_chinese_labels(self):
        for value in main.VIDEO_MODE_VALUES:
            self.assertEqual(main._agent_video_mode(value), value)
            self.assertEqual(main._agent_video_mode(value.upper()), value)
        self.assertEqual(main._agent_video_mode("文生视频"), "text_to_video")
        self.assertEqual(main._agent_video_mode("首尾帧"), "start_end_to_video")
        self.assertEqual(main._agent_video_mode("数字人"), "digital_human")
        self.assertEqual(main._agent_video_mode(""), "")
        self.assertEqual(main._agent_video_mode("随便写"), "")

    def test_required_inputs_table(self):
        self.assertEqual(main.video_mode_required_inputs("start_end_to_video")[:2], (2, False))
        self.assertEqual(main.video_mode_required_inputs("reference_video_to_video")[:2], (0, True))
        self.assertEqual(main.video_mode_required_inputs("text_to_video")[:2], (0, False))
        self.assertEqual(main.video_mode_required_inputs("不认识的")[:2], (0, False))

    def test_tool_schema_exposes_mode(self):
        schema = main.AGENT_TOOLS["generate_video"]["schema"]["properties"]["mode"]
        self.assertEqual(schema["enum"], list(main.VIDEO_MODE_VALUES))
        self.assertIn("生成方式", schema["description"])


class GenerateVideoModeValidateTests(unittest.TestCase):
    def validate(self, args, provider=APIMART):
        patches = patched(provider)
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        return main._agent_tool_generate_video_validate(dict({"canvas_id": "c1", "prompt": "短片"}, **args))

    def test_supported_mode_is_passed_through(self):
        norm = self.validate({"mode": "reference_video_to_video",
                              "reference_video": ["/assets/a.mp4"], "duration": 5})
        self.assertEqual(norm["mode"], "reference_video_to_video")

    def test_chinese_label_is_normalized(self):
        norm = self.validate({"mode": "首尾帧", "reference_urls": ["/assets/a.png", "/assets/b.png"]})
        self.assertEqual(norm["mode"], "start_end_to_video")

    def test_unsupported_mode_lists_what_the_model_supports(self):
        # seedance-2-0 支持首尾帧；这里把能力表替成只支持文生/图生的模型，验证报错文案
        with self.assertRaises(main.AgentToolError) as caught2:
            patches = patched(APIMART)
            with patches[0], patches[1], patches[2]:
                with unittest.mock.patch.object(main, "model_caps_for",
                                                return_value={"modes": ["text_to_video", "image_to_video"]}):
                    main._agent_tool_generate_video_validate(
                        {"canvas_id": "c1", "prompt": "短片", "mode": "start_end_to_video"})
        self.assertIn("不支持生成方式", caught2.exception.message)
        self.assertIn("text_to_video", caught2.exception.message)

    def test_unknown_mode_is_rejected(self):
        with self.assertRaises(main.AgentToolError) as caught:
            self.validate({"mode": "随便编一个"})
        self.assertIn("不认识的生成方式", caught.exception.message)

    def test_mode_omitted_keeps_auto_inference(self):
        norm = self.validate({"reference_urls": ["/assets/a.png"], "duration": 5})
        self.assertEqual(norm["mode"], "")

    def test_digital_human_is_rejected_for_video_models_without_it(self):
        with self.assertRaises(main.AgentToolError) as caught:
            self.validate({"mode": "digital_human", "reference_video": ["/assets/a.mp4"]})
        self.assertIn("digital_human", caught.exception.message)


class VideoModeAssemblyTests(unittest.TestCase):
    def run_video(self, payload, provider=APIMART):
        patches = patched(provider)
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        return asyncio.run(main._canvas_video_run_unlimited(payload))

    def test_digital_human_requires_the_pixverse_channel(self):
        payload = main.CanvasVideoRequest(prompt="口播", provider_id="apimart", model="seedance-2-0",
                                          mode="digital_human", videos=[{"url": "/assets/a.mp4"}])
        with self.assertRaises(main.HTTPException) as caught:
            self.run_video(payload)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("PixVerse", str(caught.exception.detail))

    def test_start_end_needs_two_images(self):
        payload = main.CanvasVideoRequest(prompt="首尾帧", provider_id="apimart", model="seedance-2-0",
                                          mode="start_end_to_video", images=[{"url": "/assets/a.png"}])
        with self.assertRaises(main.HTTPException) as caught:
            self.run_video(payload)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("输入不足", str(caught.exception.detail))

    def test_video_edit_needs_a_video(self):
        payload = main.CanvasVideoRequest(prompt="改一下", provider_id="apimart", model="seedance-2-0",
                                          mode="video_edit")
        with self.assertRaises(main.HTTPException) as caught:
            self.run_video(payload)
        self.assertIn("输入不足", str(caught.exception.detail))


class DigitalHumanAndExtendCapsTests(unittest.TestCase):
    def test_pixverse_lipsync_declares_digital_human(self):
        caps = main.model_caps_for(PIXVERSE, "pixverse-lipsync", "video")
        self.assertEqual(caps["modes"], ["digital_human"])
        self.assertEqual(caps["n_max"], 1)
        # 模型名带 lipsync 时即使挂在别的平台也认（组装分支按 model 名路由）
        self.assertEqual(main.model_caps_for(APIMART, "pixverse-lipsync", "video")["modes"], ["digital_human"])

    def test_pixverse_shows_up_in_model_caps_endpoint(self):
        with unittest.mock.patch.object(main, "load_api_providers", return_value=[PIXVERSE, APIMART]):
            main.invalidate_model_caps_cache()
            payload = main._model_caps_payload(admin=True)
        main.invalidate_model_caps_cache()
        by_key = {(item["provider"], item["model"], item["kind"]): item for item in payload["items"]}
        self.assertEqual(by_key[("pixverse", "pixverse-lipsync", "video")]["modes"], ["digital_human"])

    def test_video_extend_models(self):
        edit_caps = main.model_caps_for(APIMART, "wan2-7-videoedit", "video")
        self.assertIn("video_extend", edit_caps["modes"])
        volc_caps = main.model_caps_for(VOLC, "doubao-seedance-2-0", "video")
        self.assertIn("video_extend", volc_caps["modes"])
        self.assertIn("video_edit", volc_caps["modes"])
        # 其余模型不瞎给延长
        for model in ("seedance-2-0", "kling-v3", "minimax-hailuo"):
            self.assertNotIn("video_extend", main.model_caps_for(APIMART, model, "video")["modes"], model)


if __name__ == "__main__":
    unittest.main()
