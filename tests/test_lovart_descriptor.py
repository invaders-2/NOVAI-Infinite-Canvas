import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def lovart_provider(**extra):
    provider = {
        "id": "lovart",
        "name": "Lovart",
        "protocol": "lovart",
        "enabled": True,
        "image_models": list(main.LOVART_DEFAULT_IMAGE_MODELS),
        "chat_models": [],
        "video_models": list(main.LOVART_DEFAULT_VIDEO_MODELS),
    }
    provider.update(extra)
    return provider


class LovartDescriptorKeyTests(unittest.TestCase):
    """Lovart 走 AK/SK，descriptor 的 has_key 必须复用同一判定（不看 API_PROVIDER_LOVART_KEY）。"""

    def descriptor(self, model, intent, ak="ak-1", sk="sk-1", env_key=""):
        with patch.object(main, "lovart_access_key_value", return_value=ak), \
             patch.object(main, "lovart_secret_key_value", return_value=sk), \
             patch.object(main, "provider_env_key_value", return_value=env_key):
            return main.build_model_descriptor(lovart_provider(), model, intent)

    def test_image_intent_available_with_access_and_secret_key(self):
        descriptor = self.descriptor("generate_image_nano_banana_pro", "image.generate")
        self.assertTrue(descriptor["execution"]["available"])
        self.assertEqual(descriptor["execution"]["mode"], "native")
        self.assertIn("image.generate", descriptor["capabilities"])
        self.assertNotIn("未配置 API Key", descriptor["execution"]["reasons"])

    def test_video_intent_available_with_access_and_secret_key(self):
        descriptor = self.descriptor("generate_video_seedance_v2_0_fast", "video.generate")
        self.assertTrue(descriptor["execution"]["available"])
        self.assertIn("video.generate", descriptor["capabilities"])
        self.assertEqual(descriptor["model"]["protocol_id"], "lovart-video")

    def test_missing_lovart_keys_stay_unavailable(self):
        descriptor = self.descriptor("generate_image_nano_banana_pro", "image.generate", ak="", sk="")
        self.assertFalse(descriptor["execution"]["available"])
        self.assertIn("未配置 API Key", descriptor["execution"]["reasons"])

    def test_only_access_key_stays_unavailable(self):
        descriptor = self.descriptor("generate_image_nano_banana_pro", "image.generate", sk="")
        self.assertFalse(descriptor["execution"]["available"])

    def test_generic_env_key_does_not_activate_lovart(self):
        descriptor = self.descriptor("generate_image_nano_banana_pro", "image.generate",
                                     ak="", sk="", env_key="legacy-key")
        self.assertFalse(descriptor["execution"]["available"])

    def test_non_lovart_provider_still_reads_env_key(self):
        provider = {"id": "my-provider", "name": "自定义", "protocol": "openai", "enabled": True,
                    "image_models": ["my-image"], "chat_models": [], "video_models": []}
        with patch.object(main, "provider_env_key_value", return_value="env-key"), \
             patch.object(main, "lovart_access_key_value", return_value="ak"), \
             patch.object(main, "lovart_secret_key_value", return_value="sk"):
            descriptor = main.build_model_descriptor(provider, "my-image", "image.generate")
        self.assertTrue(descriptor["execution"]["available"])


class LovartProtocolResolutionTests(unittest.TestCase):
    def test_lovart_video_models_resolve_to_lovart_video(self):
        provider = lovart_provider()
        for model in ("generate_video_seedance_v2_0_fast", "generate_video_kling_v3", "generate_video_veo3_1"):
            entry, reasons = main.nova_protocols.resolve_model_protocol(provider, "video.generate", model)
            self.assertIsNotNone(entry, "{}: {}".format(model, reasons))
            self.assertEqual(entry["id"], "lovart-video")
            self.assertIn("video.generate", entry["capabilities"])

    def test_lovart_image_model_keeps_image_protocol(self):
        provider = lovart_provider()
        entry, reasons = main.nova_protocols.resolve_model_protocol(provider, "image.generate", "generate_image_nano_banana_pro")
        self.assertIsNotNone(entry, reasons)
        self.assertIn(entry["id"], ("lovart-image", "lovart-gpt-image"))
        self.assertIn("image.edit", entry["capabilities"])

    def test_image_model_gets_no_video_capability(self):
        with patch.object(main, "lovart_access_key_value", return_value="ak-1"), \
             patch.object(main, "lovart_secret_key_value", return_value="sk-1"):
            descriptor = main.build_model_descriptor(lovart_provider(), "generate_image_nano_banana_pro", "video.generate")
        self.assertEqual(descriptor["capabilities"], [])
        self.assertFalse(descriptor["execution"]["available"])


class LovartImageRequirementWordingTests(unittest.TestCase):
    def test_requirement_keeps_ratio_when_size_is_hint_only(self):
        items = main.lovart_image_requirements("832x360")
        self.assertEqual(items, ["请按 832x360 输出（1K 档位）；若平台只能按自身档位出图，请保持该比例"])

    def test_default_size_adds_no_requirement(self):
        self.assertEqual(main.lovart_image_requirements("1024x1024"), [])


if __name__ == "__main__":
    unittest.main()
