"""GET /api/config 下发的 api_providers[].video_models：Agnes 官方 hub 按既有别名表归一后去重。

覆盖：
  1. hub 的 agnes-video-v2.0 / agnes-video-v2 → agnes-video-2.5，保序、去重、不丢其它模型；
  2. 自建中转自己提供旧名时原样下发（不被误归一）；
  3. 归一后为空时保留原值，不下发空列表；
  4. 只改下发视图：ai_config 不写 data/api_providers.json（文件 sha256 不变）。
"""
import asyncio
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

AGNES_HUB = "https://apihub.agnes-ai.com"


def hub_provider(video_models):
    return {
        "id": "agnes-ai",
        "name": "Agnes AI",
        "base_url": AGNES_HUB,
        "protocol": "openai",
        "enabled": True,
        "image_models": ["agnes-image-2.5-flash"],
        "chat_models": ["agnes-2.5-flash"],
        "video_models": list(video_models),
    }


def relay_provider(video_models):
    return {
        "id": "my-relay",
        "name": "自建中转",
        "base_url": "https://relay.example.invalid/v1",
        "protocol": "openai",
        "enabled": True,
        "image_models": [],
        "chat_models": [],
        "video_models": list(video_models),
    }


def config_provider(config, provider_id):
    return next(p for p in config["api_providers"] if p["id"] == provider_id)


class ConfigViewVideoModelsTests(unittest.TestCase):
    def config(self, providers):
        with patch.object(main, "load_api_providers", return_value=providers), \
             patch.object(main, "provider_env_key_value", return_value="sk-test"), \
             patch.object(main, "_is_admin_actor", return_value=True):
            return asyncio.run(main.ai_config(Request({
                "type": "http", "method": "GET", "path": "/api/config",
                "headers": [], "client": ("127.0.0.1", 12345),
            })))

    def test_hub_models_are_normalized_and_deduplicated(self):
        source = [hub_provider(["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"])]
        config = self.config(source)
        provider = config_provider(config, "agnes-ai")
        self.assertEqual(provider["video_models"], ["agnes-video-2.5", "agnes-video-2.5-flash"])
        # 只改视图：传给 load_api_providers 的原对象没有被就地改写
        self.assertEqual(source[0]["video_models"],
                         ["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"])

    def test_normalization_keeps_order_and_other_models(self):
        source = [hub_provider([
            "agnes-video-2.5-flash", "agnes-video-2.5", "agnes-video-v2", "agnes-video-v2.0",
            "custom-video-x", "agnes-video-2.5-flash",
        ])]
        provider = config_provider(self.config(source), "agnes-ai")
        self.assertEqual(provider["video_models"],
                         ["agnes-video-2.5-flash", "agnes-video-2.5", "custom-video-x"])

    def test_hub_image_and_chat_models_are_untouched(self):
        provider = config_provider(self.config([hub_provider(["agnes-video-2.5"])]), "agnes-ai")
        self.assertEqual(provider["image_models"], ["agnes-image-2.5-flash"])
        self.assertEqual(provider["chat_models"], ["agnes-2.5-flash"])

    def test_relay_provider_with_legacy_name_is_not_touched(self):
        source = [hub_provider(["agnes-video-2.5"]),
                  relay_provider(["agnes-video-v2.0", "agnes-video-v2", "relay-video-1"])]
        config = self.config(source)
        self.assertEqual(config_provider(config, "my-relay")["video_models"],
                         ["agnes-video-v2.0", "agnes-video-v2", "relay-video-1"])

    def test_empty_after_normalization_keeps_original_value(self):
        # 归一后没有合法模型名时保留原值，避免下发空列表让下拉变空
        self.assertEqual(main.provider_view_video_models({"base_url": AGNES_HUB}, []), [])
        self.assertEqual(main.provider_view_video_models({"base_url": AGNES_HUB}, ["", "  "]), ["", "  "])
        self.assertEqual(main.provider_view_video_models({"base_url": ""}, ["agnes-video-v2.0"]),
                         ["agnes-video-v2.0"])

    def test_ai_config_does_not_write_api_providers_file(self):
        payload = [hub_provider(["agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"])]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "api_providers.json"
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            with patch.object(main, "API_PROVIDERS_FILE", str(path)), \
                 patch.object(main, "provider_env_key_value", return_value="sk-test"), \
             patch.object(main, "_is_admin_actor", return_value=True):
                config = asyncio.run(main.ai_config(Request({
                "type": "http", "method": "GET", "path": "/api/config",
                "headers": [], "client": ("127.0.0.1", 12345),
            })))
            after = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(before, after, "下发归一不能写回磁盘")
            self.assertEqual(config_provider(config, "agnes-ai")["video_models"],
                             ["agnes-video-2.5", "agnes-video-2.5-flash"])
            # 磁盘内容仍保留用户保存的旧名
            self.assertIn("agnes-video-v2.0", path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
