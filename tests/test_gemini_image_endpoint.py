"""gemini-*image 自动切 Gemini 协议时，端点必须与请求体一致（真实中转站 404 回归）。

真实故障（/tmp/novai-relay-e2e-evidence/REPORT.md 缺陷 1）：provider protocol=openai 且配了
image_generation_endpoint=/v1/images/generations 时，gemini-3.1-flash-image 被自动判成 gemini 协议，
Gemini 原生请求体却发到 /v1/images/generations -> 404 Images API is not supported for this platform。
修复后：判定走 Gemini 协议就用 Gemini 端点；供应商在 model_protocols 里显式声明 openai 则全程 OpenAI。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

MODEL = "gemini-3.1-flash-image"
GEMINI_PATH = "/v1beta/models/gemini-3.1-flash-image:generateContent"


def relay_provider(**extra):
    provider = {
        "id": "relay", "name": "Relay", "protocol": "openai", "enabled": True,
        "base_url": "https://relay.invalid", "image_models": [MODEL],
        "image_generation_endpoint": "/v1/images/generations", "image_edit_endpoint": "",
    }
    provider.update(extra)
    return provider


class GeminiImageEndpointTests(unittest.TestCase):

    def test_auto_switched_gemini_uses_gemini_native_endpoint(self):
        provider = relay_provider()
        self.assertEqual(main.effective_protocol(provider, MODEL), "gemini")
        self.assertEqual(main.gemini_endpoint_url(provider, MODEL), "https://relay.invalid" + GEMINI_PATH)
        # 端点与协议必须一致：不能落到 OpenAI 生图端口
        self.assertNotIn("/v1/images/generations", main.gemini_endpoint_url(provider, MODEL))

    def test_declared_openai_keeps_openai_endpoint_and_body(self):
        provider = relay_provider(model_protocols={MODEL: "openai"})
        self.assertEqual(main.effective_protocol(provider, MODEL), "openai")
        self.assertEqual(
            main.provider_endpoint_url(provider, "image_generation_endpoint", "/v1/images/generations"),
            "https://relay.invalid/v1/images/generations",
        )

    def test_base_url_ending_with_v1beta_is_not_doubled(self):
        provider = relay_provider(base_url="https://relay.invalid/v1beta")
        self.assertEqual(main.gemini_endpoint_url(provider, MODEL), "https://relay.invalid" + GEMINI_PATH)

    def test_declared_gemini_provider_keeps_custom_override(self):
        provider = relay_provider(protocol="gemini",
                                  image_generation_endpoint="/v1beta/models/custom:generateContent")
        self.assertEqual(main.effective_protocol(provider, MODEL), "gemini")
        self.assertEqual(main.gemini_endpoint_url(provider, MODEL),
                         "https://relay.invalid/v1beta/models/custom:generateContent")

    def test_endpoint_follows_effective_protocol(self):
        gemini = relay_provider()
        openai = relay_provider(model_protocols={MODEL: "openai"})
        self.assertIn("generateContent", main.gemini_endpoint_url(gemini, MODEL))
        self.assertEqual(main.effective_protocol(openai, MODEL), "openai")
        self.assertIn("/v1/images/generations",
                      main.provider_endpoint_url(openai, "image_generation_endpoint", "/v1/images/generations"))


if __name__ == "__main__":
    unittest.main()
