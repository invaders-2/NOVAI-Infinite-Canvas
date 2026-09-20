import copy
import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def lovart_default():
    return next(item for item in main.default_api_providers() if item["id"] == "lovart")


def modelscope_provider(**extra):
    provider = {"id": "modelscope", "name": "ModelScope", "protocol": "openai", "enabled": True}
    provider.update(extra)
    return provider


def custom_openai_provider():
    return {
        "id": "my-openai",
        "name": "我的平台",
        "protocol": "openai",
        "base_url": "https://api.example.com/v1",
        "enabled": True,
        "primary": False,
        "image_models": ["my-image"],
        "chat_models": ["my-chat"],
        "video_models": ["my-video"],
    }


class LovartProviderInjectionTests(unittest.TestCase):
    def test_missing_lovart_is_injected_even_without_inject_missing(self):
        providers = [modelscope_provider(), custom_openai_provider()]
        merged = main.merge_default_api_providers(providers, inject_missing=False)

        self.assertEqual([item["id"] for item in merged], ["modelscope", "my-openai", "lovart"])
        default = lovart_default()
        injected = next(item for item in merged if item["id"] == "lovart")
        for field in ("name", "protocol", "base_url", "image_models", "chat_models", "video_models"):
            self.assertEqual(injected[field], default[field], field)

    def test_inject_missing_still_controls_the_other_builtin_providers(self):
        providers = [modelscope_provider(), custom_openai_provider()]
        merged = main.merge_default_api_providers(providers, inject_missing=False)
        ids = [item["id"] for item in merged]
        self.assertNotIn("runninghub", ids)
        self.assertNotIn("volcengine", ids)

    def test_existing_lovart_is_kept_as_single_entry(self):
        user_lovart = {
            "id": "lovart",
            "name": "我的 Lovart",
            "protocol": "lovart",
            "base_url": "https://custom.lovart.example",
            "enabled": False,
            "primary": True,
            "image_models": ["my-lovart-image"],
            "chat_models": ["my-lovart-chat"],
            "video_models": ["my-lovart-video"],
            "lovart_auto_confirm": True,
            "lovart_project_id": "proj-42",
            "lovart_unlimited": True,
        }
        merged = main.merge_default_api_providers([modelscope_provider(), user_lovart], inject_missing=False)

        lovarts = [item for item in merged if item["id"] == "lovart"]
        self.assertEqual(len(lovarts), 1)
        kept = lovarts[0]
        self.assertEqual(kept["name"], "我的 Lovart")
        self.assertEqual(kept["base_url"], "https://custom.lovart.example")
        self.assertEqual(kept["image_models"], ["my-lovart-image"])
        self.assertEqual(kept["video_models"], ["my-lovart-video"])
        self.assertEqual(kept["lovart_project_id"], "proj-42")
        self.assertTrue(kept["lovart_auto_confirm"])
        self.assertTrue(kept["lovart_unlimited"])
        self.assertFalse(kept["enabled"])
        self.assertTrue(kept["primary"])
        self.assertIn("my-lovart-chat", kept["chat_models"])

    def test_user_providers_keep_order_and_content(self):
        providers = [modelscope_provider(), custom_openai_provider()]
        snapshot = copy.deepcopy(providers)
        merged = main.merge_default_api_providers(providers, inject_missing=False)

        self.assertEqual(providers, snapshot, "传入的平台列表不应被就地修改")
        self.assertEqual(merged[0]["id"], "modelscope")
        self.assertEqual(merged[1], snapshot[1])
        self.assertEqual(merged[2]["id"], "lovart")


class LovartPrimaryProviderTests(unittest.TestCase):
    """密钥查询整体打桩，测试不读也不写用户 API/.env。"""

    def get_primary(self, providers, ms_key="ms-key", lovart_ak="", lovart_sk=""):
        patches = [
            patch.object(main, "provider_env_key_value",
                         side_effect=lambda pid: ms_key if pid == "modelscope" else ""),
            patch.object(main, "lovart_access_key_value", return_value=lovart_ak),
            patch.object(main, "lovart_secret_key_value", return_value=lovart_sk),
        ]
        with ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            return main.get_primary_provider_id(providers)

    def providers_with_lovart(self, **lovart_extra):
        lovart = {"id": "lovart", "name": "Lovart", "protocol": "lovart", "enabled": True}
        lovart.update(lovart_extra)
        return [modelscope_provider(), lovart]

    def test_keyless_lovart_does_not_beat_keyed_modelscope(self):
        merged = main.merge_default_api_providers([modelscope_provider()], inject_missing=False)
        self.assertEqual([item["id"] for item in merged], ["modelscope", "lovart"])
        self.assertEqual(self.get_primary(merged), "modelscope")

    def test_lovart_with_access_key_and_secret_key_becomes_primary(self):
        providers = self.providers_with_lovart()
        self.assertEqual(self.get_primary(providers, lovart_ak="ak-1", lovart_sk="sk-1"), "lovart")

    def test_lovart_with_only_access_key_is_not_primary(self):
        providers = self.providers_with_lovart()
        self.assertEqual(self.get_primary(providers, lovart_ak="ak-1"), "modelscope")

    def test_explicit_primary_still_wins(self):
        providers = self.providers_with_lovart(primary=True)
        self.assertEqual(self.get_primary(providers), "lovart")

    def test_no_keys_anywhere_falls_back_to_legacy_order(self):
        providers = [modelscope_provider(), {"id": "runninghub", "name": "RunningHub", "enabled": True},
                     {"id": "lovart", "name": "Lovart", "protocol": "lovart", "enabled": True}]
        self.assertEqual(self.get_primary(providers, ms_key=""), "runninghub")


if __name__ == "__main__":
    unittest.main()
