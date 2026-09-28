"""画布助手生图尺寸：agent_image_size 走 server/protocols 的尺寸策略（不真实调用上游）。

覆盖：
  1. 比例推导复用 CHAT_RATIO_SIZE_OPTIONS，且 generate_image 的 ratio schema 与它同集合；
  2. 显式 size / 比例推导值都要过 registry.constrain_size（enum 吸附，free 原样）；
  3. 工具返回值与预览里的 size 都是最终要下发的值；
  4. 真实生成执行整体打桩，只断言进入 Task Engine 的 payload。
"""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def lingjing_provider():
    return {
        "id": "lingjing", "name": "灵境", "protocol": "openai", "enabled": True,
        "base_url": "https://example.invalid/v1", "chat_models": ["test-chat"],
        "image_models": ["gpt-image-1", "gpt-image-1.5", "gpt-image-2", "gpt-image-2-c", "grok-imagine-image"],
    }


def lovart_provider():
    return {
        "id": "lovart", "name": "Lovart", "protocol": "lovart", "enabled": True,
        "base_url": "https://example.invalid/lovart", "chat_models": ["test-chat"],
        "image_models": ["generate_image_gpt_image_2_5_flare", "generate_image_gpt_image_2"],
    }


def unknown_provider():
    return {
        "id": "my-provider", "name": "我的平台", "protocol": "openai", "enabled": True,
        "base_url": "https://example.invalid/v1", "chat_models": ["test-chat"],
        "image_models": ["my-custom-image"],
    }


class AgentImageSizeTests(unittest.TestCase):
    """provider 配置整体打桩，测试与用户 data/api_providers.json 无关。"""

    def setUp(self):
        patcher = patch.object(main, "load_api_providers",
                               return_value=[lingjing_provider(), lovart_provider(), unknown_provider()])
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_lovart_ratio_is_not_snapped(self):
        policy = main.nova_protocols.size_policy_for(lovart_provider(), "generate_image_gpt_image_2_5_flare")
        self.assertEqual(policy["mode"], "free")
        self.assertEqual(main.agent_image_size("lovart", "generate_image_gpt_image_2_5_flare", "", "3:4"), "1008x1344")

    def test_lingjing_gpt_image_2_ratio_snaps_into_enum(self):
        policy = main.nova_protocols.size_policy_for(lingjing_provider(), "gpt-image-2")
        self.assertEqual(policy["mode"], "enum")
        size = main.agent_image_size("lingjing", "gpt-image-2", "", "3:4")
        self.assertEqual(size, "1024x1536")
        self.assertIn(size, policy["options"])

    def test_lingjing_gpt_image_1_ratio_snaps_into_three_options(self):
        policy = main.nova_protocols.size_policy_for(lingjing_provider(), "gpt-image-1")
        self.assertEqual(policy["options"], ["1024x1024", "1536x1024", "1024x1536"])
        size = main.agent_image_size("lingjing", "gpt-image-1", "", "16:9")
        self.assertEqual(size, "1536x1024")
        self.assertIn(size, policy["options"])

    def test_explicit_size_snaps_only_where_policy_is_enum(self):
        self.assertEqual(main.agent_image_size("lingjing", "gpt-image-2", "4096x4096"), "2048x2048")
        self.assertEqual(main.agent_image_size("lovart", "generate_image_gpt_image_2_5_flare", "4096x4096"), "4096x4096")

    def test_unknown_model_stays_free(self):
        policy = main.nova_protocols.size_policy_for(unknown_provider(), "my-custom-image")
        self.assertEqual(policy["mode"], "free")
        self.assertEqual(main.agent_image_size("my-provider", "my-custom-image", "", "3:4"), "1008x1344")
        self.assertEqual(main.agent_image_size("my-provider", "my-custom-image", "1920x1080"), "1920x1080")

    def test_empty_size_and_unknown_ratio_fall_back_to_1024(self):
        self.assertEqual(main.agent_image_size("my-provider", "my-custom-image", "", ""), "1024x1024")
        self.assertEqual(main.agent_image_size("my-provider", "my-custom-image", "", "21:9"), "1024x1024")

    def test_empty_model_uses_provider_default_model_policy(self):
        # 执行链里 model 为空会落到平台首个生图模型，策略必须用同一对 provider/model
        provider = lingjing_provider()
        provider["image_models"] = ["gpt-image-1", "gpt-image-2"]
        with patch.object(main, "load_api_providers", return_value=[provider]):
            self.assertEqual(main.agent_image_size("lingjing", "", "", "16:9"), "1536x1024")

    def test_generate_image_ratio_schema_matches_ratio_table(self):
        ratio = main.AGENT_TOOLS["generate_image"]["schema"]["properties"]["ratio"]
        self.assertEqual(set(ratio["enum"]), set(main.CHAT_RATIO_SIZE_OPTIONS))
        for value in ratio["enum"]:
            self.assertEqual(main.agent_image_size("my-provider", "my-custom-image", "", value),
                             main.CHAT_RATIO_SIZE_OPTIONS[value][0], value)


class AgentImageExecutionTests(unittest.TestCase):
    """真实生成执行整体打桩：只断言真正会下发的那一对 provider/model 与最终 size。"""

    def setUp(self):
        self.payloads = []
        self.generated_sizes = []
        canvas = {"id": "c1", "kind": "classic", "title": "画布", "nodes": [{"id": "n1", "type": "image", "text": "一只猫"}]}

        def fake_task_create(**kwargs):
            self.payloads.append(kwargs.get("payload"))
            return {"id": "task-1"}

        async def fake_generate(prompt, size, quality, model, refs=None, provider_id=""):
            self.generated_sizes.append((size, model, provider_id))
            return b"", {}

        self.patches = [
            patch.object(main, "load_api_providers", return_value=[lingjing_provider(), lovart_provider(), unknown_provider()]),
            # 平台解析要密钥；这里只验证尺寸策略，给假密钥即可
            patch.object(main, "provider_env_key_value", return_value="test-key"),
            patch.object(main, "lovart_access_key_value", return_value="ak-test"),
            patch.object(main, "lovart_secret_key_value", return_value="sk-test"),
            patch.object(main, "load_canvas", return_value=canvas),
            patch.object(main, "_agent_mutate_canvas", return_value=(canvas, None)),
            patch.object(main, "_agent_tool_create_node_validate", side_effect=lambda a: a),
            patch.object(main, "_agent_tool_create_node_run", side_effect=lambda a: {"node_id": "n-" + a["type"]}),
            patch.object(main, "_agent_tool_connect_nodes_validate", side_effect=lambda a: a),
            patch.object(main, "_agent_tool_connect_nodes_run", return_value={}),
            patch.object(main, "task_create", side_effect=fake_task_create),
            patch.object(main, "task_enqueue", new=AsyncMock(return_value=None)),
            patch.object(main, "generate_ai_image", side_effect=fake_generate),
            patch.object(main, "save_ai_image_to_output", new=AsyncMock(return_value="/output/chat.png")),
        ]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def test_generate_image_payload_and_result_use_snapped_size(self):
        norm = main._agent_tool_generate_image_validate({
            "canvas_id": "c1", "prompt": "一只猫", "provider": "lingjing", "model": "gpt-image-2", "ratio": "3:4",
        })
        self.assertEqual(norm["size"], "1024x1536")
        result = asyncio.run(main._agent_tool_generate_image_run(norm))
        self.assertEqual(self.payloads[0]["size"], "1024x1536")
        self.assertEqual(result["size"], "1024x1536")
        self.assertIn("1024x1536", result["message"])
        self.assertIn("1024x1536", main._agent_tool_generate_image_preview(norm, {"id": "c1", "nodes": []}))

    def test_lovart_generate_image_payload_keeps_ratio_size(self):
        norm = main._agent_tool_generate_image_validate({
            "canvas_id": "c1", "prompt": "一张海报", "provider": "lovart",
            "model": "generate_image_gpt_image_2_5_flare", "ratio": "3:4",
        })
        asyncio.run(main._agent_tool_generate_image_run(norm))
        self.assertEqual(self.payloads[0]["size"], "1008x1344")
        self.assertEqual(self.payloads[0]["provider_id"], "lovart")

    def test_run_generation_payload_and_preview_use_snapped_size(self):
        norm = main._agent_tool_run_generation_validate({
            "canvas_id": "c1", "node_id": "n1", "provider": "lingjing", "model": "gpt-image-2", "size": "4096x4096",
        })
        self.assertEqual(norm["size"], "2048x2048")
        result = asyncio.run(main._agent_tool_run_generation_run(norm))
        self.assertEqual(self.payloads[0]["size"], "2048x2048")
        self.assertEqual(result["size"], "2048x2048")
        preview = main._agent_tool_run_generation_preview(norm, {"id": "c1", "nodes": []})
        self.assertIn("2048x2048", preview)

    def test_edit_image_action_uses_snapped_size(self):
        decision = AsyncMock(return_value={"action": "edit_image", "prompt": "改成 16:9 高清", "reply": ""})
        with patch.object(main, "decide_chat_agent_action", new=decision), \
                patch.object(main, "safe_user_id", return_value="u1"), \
                patch.object(main, "load_conversation", return_value={"messages": []}), \
                patch.object(main, "new_conversation", return_value={"messages": []}), \
                patch.object(main, "save_conversation", return_value=None), \
                patch.object(main, "latest_chat_image_refs", return_value=[{"url": "/assets/input/a.png"}]), \
                patch.object(main, "pick_chat_image_provider", return_value=lingjing_provider()):
            payload = main.ChatRequest(message="把这张图改成 16:9 高清", provider="lingjing", image_model="gpt-image-1")
            response = asyncio.run(main.chat_agent(payload, None))
        self.assertEqual(self.generated_sizes[0][0], "1536x1024")
        self.assertEqual(response["message"]["size"], "1536x1024")


if __name__ == "__main__":
    unittest.main()
