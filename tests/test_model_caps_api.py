"""模型规格接口 /api/model-caps 与生成收敛（比例 / 分辨率 / 张数 / 时长）。

覆盖：
  1. 只下发「代码里有权威规格表」的模型（apimart / agnes / volcengine / gemini / jimeng），
     没有规格的模型、未启用的平台都不出现；非管理员只看到 apimart（与 /api/models 口径一致）；
  2. 条目形状固定：provider / model / kind / ratios / resolutions / n_max / durations / modes / qualities；
  3. 缓存：同配置重复调用只读一次 providers，invalidate 后重建（配置指纹变了也会重建）；
  4. 收敛：比例就近、图片档位就近、视频时长/分辨率夹取、张数压到 n_max；没规格的模型原样返回；
  5. 真链路：generate_image / generate_video 的校验函数会把超规格参数收敛掉，并把说明带进 caps_notes。
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

# n_max / modes 现在是「缺失 = 后端不掌握」（不再下发 null / 空占位），所以是可选字段
REQUIRED_KEYS = {"provider", "model", "kind", "ratios", "resolutions", "durations", "qualities"}
# max_long_edge / max_pixels / min_pixels：精确像素生成模型（GPT-Image 家族）的像素上限，前端据此钳尺寸
OPTIONAL_KEYS = {"n_max", "modes", "max_long_edge", "max_pixels", "min_pixels", "native_background"}


def provider(pid, protocol, base_url="", image_models=(), video_models=(), enabled=True, image_model=""):
    return {"id": pid, "protocol": protocol, "base_url": base_url, "enabled": enabled,
            "image_models": list(image_models), "video_models": list(video_models),
            "image_model": image_model}


def providers():
    return [
        provider("apimart", "apimart", "https://apib.ai",
                 image_models=["gpt-image-2.5-ext", "gemini-3-pro-image-preview", "midjourney"],
                 video_models=["seedance-2.5", "MiniMax-H3", "unknown-video-model"]),
        provider("agnes-ai", "openai", "https://apihub.agnes-ai.com",
                 image_models=["agnes-image-2.5-flash"],
                 video_models=["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"]),
        provider("volcengine", "volcengine", "https://ark.cn-beijing.volces.com/api/v3",
                 image_models=["doubao-seedream-5-0-pro"], video_models=["doubao-seedance-2-0"]),
        provider("gemini", "gemini", "https://generativelanguage.googleapis.com",
                 image_models=["gemini-3-pro-image-preview"]),
        provider("jimeng", "jimeng", "", image_models=["4.7"]),
        provider("modelscope", "openai", "https://api-inference.modelscope.cn/v1",
                 image_models=["Tongyi-MAI/Z-Image-Turbo"]),
        provider("off", "apimart", "https://apib.ai", image_models=["gpt-image-2"], enabled=False),
    ]


def items_by(admin=True):
    with patch.object(main, "load_api_providers", return_value=providers()):
        main.invalidate_model_caps_cache()
        payload = main._model_caps_payload(admin=admin)
    main.invalidate_model_caps_cache()
    return {(item["provider"], item["model"], item["kind"]): item for item in payload["items"]}


class ModelCapsPayloadTests(unittest.TestCase):
    def test_item_shape_is_fixed(self):
        items = items_by()
        self.assertTrue(items)
        for item in items.values():
            keys = set(item.keys())
            self.assertLessEqual(REQUIRED_KEYS, keys, item)
            self.assertLessEqual(keys, REQUIRED_KEYS | OPTIONAL_KEYS, item)
            self.assertTrue(item["durations"] == [] or all(isinstance(v, int) for v in item["durations"]))

    def test_apimart_image_caps_reuse_the_table(self):
        items = items_by()
        item = items[("apimart", "gpt-image-2.5-ext", "image")]
        self.assertIn("auto", item["ratios"])
        self.assertEqual(item["resolutions"], ["1K", "2K", "4K"])
        self.assertEqual(item["n_max"], 4)
        self.assertEqual(item["durations"], [])

    def test_apimart_video_caps_expand_duration_range(self):
        items = items_by()
        item = items[("apimart", "seedance-2.5", "video")]
        self.assertIn("16:9", item["ratios"])
        self.assertEqual(item["durations"][0], 4)
        self.assertEqual(item["durations"][-1], 30)
        self.assertIn("1080p", item["resolutions"])

    def test_agnes_caps(self):
        items = items_by()
        image = items[("agnes-ai", "agnes-image-2.5-flash", "image")]
        self.assertIn("3:4", image["ratios"])
        self.assertEqual(image["resolutions"], ["1K", "2K", "3K", "4K"])
        flash = items[("agnes-ai", "agnes-video-2.5-flash", "video")]
        self.assertEqual(flash["resolutions"], ["720P"])
        self.assertEqual(flash["durations"], list(range(4, 13)))
        legacy = items[("agnes-ai", "agnes-video-v2.0", "video")]
        self.assertIn("9:21", legacy["ratios"])
        self.assertEqual(legacy["durations"][-1], 18)

    def test_volcengine_caps(self):
        items = items_by()
        image = items[("volcengine", "doubao-seedream-5-0-pro", "image")]
        self.assertEqual(image["resolutions"], ["1K", "1.5K", "2K"])
        video = items[("volcengine", "doubao-seedance-2-0", "video")]
        self.assertIn("4k", video["resolutions"])
        self.assertEqual(video["durations"], list(range(4, 16)))

    def test_gemini_and_jimeng_caps(self):
        items = items_by()
        gemini = items[("gemini", "gemini-3-pro-image-preview", "image")]
        self.assertIn("9:16", gemini["ratios"])
        self.assertNotIn("1:4", gemini["ratios"])          # 3-pro-image 只有 10 个官方比例
        jimeng = items[("jimeng", "4.7", "image")]
        self.assertIn("21:9", jimeng["ratios"])
        self.assertEqual(jimeng["resolutions"], [])

    def test_models_without_authoritative_caps_are_absent(self):
        items = items_by()
        self.assertNotIn(("apimart", "midjourney", "image"), items)
        self.assertNotIn(("modelscope", "Tongyi-MAI/Z-Image-Turbo", "image"), items)
        self.assertNotIn(("apimart", "unknown-video-model", "video"), items)   # 未声明规格的型号不瞎编
        self.assertFalse([key for key in items if key[0] == "off"])

    def test_non_admin_only_sees_member_provider(self):
        items = items_by(admin=False)
        self.assertEqual({key[0] for key in items}, {"apimart"})

    def test_cache_reads_providers_once_until_invalidated(self):
        main.invalidate_model_caps_cache()
        with patch.object(main, "load_api_providers", side_effect=providers) as loader:
            main._model_caps_payload(admin=True)
            main._model_caps_payload(admin=True)
            self.assertEqual(loader.call_count, 1)
            main.invalidate_model_caps_cache()
            main._model_caps_payload(admin=True)
            self.assertEqual(loader.call_count, 2)
        main.invalidate_model_caps_cache()

    def test_cache_rebuilds_when_config_signature_changes(self):
        main.invalidate_model_caps_cache()
        with patch.object(main, "load_api_providers", side_effect=providers) as loader:
            with patch.object(main, "_model_caps_config_signature", return_value=(1, 1)):
                main._model_caps_payload()
            with patch.object(main, "_model_caps_config_signature", return_value=(2, 2)):
                main._model_caps_payload()
            self.assertEqual(loader.call_count, 2)
        main.invalidate_model_caps_cache()


class ModelCapsConvergeTests(unittest.TestCase):
    APIMART = {"id": "apimart", "protocol": "apimart", "base_url": "https://apib.ai"}

    def converge(self, model, kind, **kwargs):
        return main.model_caps_converge(self.APIMART, model, kind, **kwargs)

    def test_ratio_and_size_and_count_are_clamped(self):
        out = self.converge("gpt-image-1", "image", ratio="16:9", size="3840x2160", count=6)
        self.assertEqual(out["ratio"], "3:2")
        self.assertEqual(out["size"], "1536x1024")
        self.assertEqual(out["count"], 4)
        self.assertTrue(out["notes"])

    def test_legal_values_stay_untouched(self):
        out = self.converge("gpt-image-2.5-ext", "image", ratio="9:16", size="1024x1536", count=2)
        self.assertEqual((out["ratio"], out["size"], out["count"]), ("9:16", "1024x1536", 2))
        self.assertEqual(out["notes"], [])

    def test_video_duration_and_resolution_clamp(self):
        out = self.converge("seedance-2-5", "video", ratio="2:1", duration=99, resolution="720p")
        self.assertEqual(out["duration"], 30)
        self.assertEqual(out["ratio"], "16:9")
        self.assertEqual(out["resolution"], "720p")
        out2 = self.converge("seedance-2-0", "video", duration=1, ratio="9:16", resolution="1080p")
        self.assertEqual(out2["duration"], 4)
        self.assertEqual(out2["resolution"], "1080p")

    def test_agnes_flash_video_resolution_converges_to_720p(self):
        agnes = {"id": "agnes-ai", "protocol": "openai", "base_url": "https://apihub.agnes-ai.com"}
        out = main.model_caps_converge(agnes, "agnes-video-2.5-flash", "video", duration=1,
                                       ratio="9:21", resolution="4k")
        self.assertEqual(out["resolution"], "720P")
        self.assertEqual(out["duration"], 4)
        self.assertEqual(out["ratio"], "9:16")

    def test_model_without_caps_is_untouched(self):
        out = self.converge("midjourney", "image", ratio="7:5", size="1234x888", count=8)
        self.assertEqual((out["ratio"], out["size"], out["count"]), ("7:5", "1234x888", 8))
        self.assertEqual(out["notes"], [])
        self.assertIsNone(out["caps"])


class AgentToolConvergeTests(unittest.TestCase):
    """generate_image / generate_video 的校验函数真的把超规格参数收敛了。"""

    def setUp(self):
        patches = [
            patch.object(main, "load_canvas", return_value={"id": "c1", "kind": "classic", "nodes": []}),
            patch.object(main, "get_api_provider",
                         side_effect=lambda pid: {"id": pid, "protocol": "apimart",
                                                  "image_models": ["gpt-image-1"],
                                                  "video_models": ["seedance-2-5"]}),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def test_generate_image_validator_converges(self):
        with patch.object(main, "_agent_resolve_media_target", return_value=("apimart", "gpt-image-1", "")):
            norm = main._agent_tool_generate_image_validate({
                "canvas_id": "c1", "prompt": "海报", "ratio": "16:9", "size": "3840x2160", "count": 6})
        self.assertEqual(norm["ratio"], "3:2")
        self.assertEqual(norm["size"], "1536x1024")
        self.assertEqual(norm["count"], 4)
        self.assertTrue(norm["caps_notes"])

    def test_generate_video_validator_converges(self):
        with patch.object(main, "_agent_resolve_media_target", return_value=("apimart", "seedance-2-5", "")):
            norm = main._agent_tool_generate_video_validate({
                "canvas_id": "c1", "prompt": "短片", "ratio": "2:1", "duration": 99})
        self.assertEqual(norm["ratio"], "16:9")
        self.assertEqual(norm["duration"], 15)      # 先被工具自身压到 15s，再按模型规格收敛（4–30 合法）
        self.assertTrue(norm["caps_notes"])


if __name__ == "__main__":
    unittest.main()
