"""「原图比例」：ratio=auto/自适应/adaptive 时按参考图真实比例算尺寸（助手工具 + 直发生图/视频）。

覆盖：
  1. 助手 generate_image：参考图 4:3 / 9:16 → size 对应比例（不再落 1024x1024 方图）；
     模型不支持该比例时收敛到最近合法比例；没有参考图 → 方图 + caps_notes 说明；读不到尺寸 → 方图 + 说明。
  2. 助手 generate_video：ratio=adaptive + 参考图 → 取该模型支持的最近视频比例；没有参考图保持 adaptive + 说明。
  3. 直发生图（/api/canvas-image-tasks → build_online_image_result）：size=auto / ratio=自适应 时按源图比例算，
     结果里带 size_notice。
  4. 直发视频（/api/canvas-video）：aspect_ratio=adaptive + 参考图 → 按参考图比例定画幅；编辑任务（duration=-1）不变。
"""
import asyncio
import sys
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

APIMART = {"id": "apimart", "protocol": "apimart", "base_url": "https://apib.ai", "enabled": True,
           "image_models": ["gpt-image-2"], "video_models": ["seedance-2-0"]}
AGNES = {"id": "agnes-ai", "protocol": "openai", "base_url": "https://apihub.agnes-ai.com", "enabled": True,
         "image_models": ["agnes-image-2.5-flash"], "video_models": []}


def canvas():
    return {"id": "c1", "kind": "classic", "nodes": [], "connections": []}


class HelperTests(unittest.TestCase):
    def test_auto_ratio_tokens(self):
        for value in ("", "auto", "自适应", "自动", "adaptive", "keep_ratio", "source", "context"):
            self.assertTrue(main._agent_auto_ratio(value), value)
        for value in ("4:3", "9:16", "wide", "1:1"):
            self.assertFalse(main._agent_auto_ratio(value), value)

    def test_reference_ratio_to_size(self):
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value="800x600"):
            size, ratio, note = main._agent_auto_ratio_image_size(APIMART, "gpt-image-2", [{"url": "/a.png"}])
        self.assertEqual((size, ratio), ("1536x1152", "4:3"))
        self.assertIn("按参考图比例", note)
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value="720x1280"):
            size, ratio, _note = main._agent_auto_ratio_image_size(APIMART, "gpt-image-2", [{"url": "/a.png"}])
        self.assertEqual((size, ratio), ("864x1536", "9:16"))

    def test_unsupported_ratio_converges_to_model_caps(self):
        # agnes 只支持 8 个比例，5:4 不在表里 → 最近 4:3，并按该比例重算尺寸
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value="500x400"):
            size, ratio, note = main._agent_auto_ratio_image_size(AGNES, "agnes-image-2.5-flash", [{"url": "/a.png"}])
        self.assertEqual(ratio, "4:3")
        self.assertEqual(size, "1024x768")
        self.assertIn("收敛", note)

    def test_unreadable_reference_returns_empty(self):
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value=""):
            self.assertEqual(main._agent_auto_ratio_image_size(APIMART, "gpt-image-2", [{"url": "/remote.png"}]),
                             ("", "", ""))

    def test_video_ratio_from_reference(self):
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value="800x600"):
            ratio, note = main._agent_auto_ratio_video_ratio(APIMART, "seedance-2-0", [{"url": "/a.png"}])
        self.assertEqual(ratio, "4:3")
        self.assertIn("视频比例", note)


class GenerateImageAutoRatioTests(unittest.TestCase):
    def validate(self, args):
        patches = [
            unittest.mock.patch.object(main, "load_canvas", return_value=canvas()),
            unittest.mock.patch.object(main, "get_api_provider", return_value=APIMART),
            unittest.mock.patch.object(main, "_agent_resolve_media_target", return_value=("apimart", "gpt-image-2", "")),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        return main._agent_tool_generate_image_validate(dict({"canvas_id": "c1", "prompt": "海报"}, **args))

    def test_auto_ratio_uses_reference_43(self):
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value="800x600"):
            norm = self.validate({"ratio": "自适应", "reference_urls": ["/assets/input/a.png"]})
        self.assertEqual(norm["size"], "1536x1152")
        self.assertEqual(norm["ratio"], "4:3")
        self.assertTrue(any("按参考图比例" in note for note in norm["caps_notes"]))

    def test_missing_ratio_uses_reference_916(self):
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value="720x1280"):
            norm = self.validate({"reference_urls": ["/assets/input/a.png"]})
        self.assertEqual(norm["size"], "864x1536")
        self.assertEqual(norm["ratio"], "9:16")

    def test_no_reference_falls_back_to_square_with_note(self):
        norm = self.validate({"ratio": "auto"})
        self.assertEqual(norm["size"], "1024x1024")
        self.assertTrue(any("没有参考图" in note for note in norm["caps_notes"]))

    def test_unreadable_reference_falls_back_with_note(self):
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value=""):
            norm = self.validate({"ratio": "auto", "reference_urls": ["https://example.com/a.png"]})
        self.assertEqual(norm["size"], "1024x1024")
        self.assertTrue(any("读不到" in note for note in norm["caps_notes"]))

    def test_explicit_ratio_ignores_reference(self):
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value="800x600"):
            norm = self.validate({"ratio": "16:9", "size": "2048x1152", "reference_urls": ["/assets/input/a.png"]})
        self.assertEqual(norm["ratio"], "16:9")
        self.assertEqual(norm["size"], "2048x1152")


class GenerateVideoAutoRatioTests(unittest.TestCase):
    def validate(self, args):
        patches = [
            unittest.mock.patch.object(main, "load_canvas", return_value=canvas()),
            unittest.mock.patch.object(main, "get_api_provider", return_value=APIMART),
            unittest.mock.patch.object(main, "_agent_resolve_media_target", return_value=("apimart", "seedance-2-0", "")),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        return main._agent_tool_generate_video_validate(dict({"canvas_id": "c1", "prompt": "短片"}, **args))

    def test_adaptive_with_reference_uses_reference_ratio(self):
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value="800x600"):
            norm = self.validate({"ratio": "adaptive", "reference_urls": ["/assets/input/a.png"]})
        self.assertEqual(norm["ratio"], "4:3")
        self.assertTrue(any("按参考图比例" in note for note in norm["caps_notes"]))

    def test_adaptive_without_reference_keeps_adaptive(self):
        norm = self.validate({"ratio": "adaptive"})
        self.assertEqual(norm["ratio"], "adaptive")
        self.assertTrue(any("没有参考图" in note for note in norm["caps_notes"]))

    def test_explicit_ratio_is_kept(self):
        with unittest.mock.patch.object(main, "image_size_from_reference", return_value="800x600"):
            norm = self.validate({"ratio": "9:16", "reference_urls": ["/assets/input/a.png"]})
        self.assertEqual(norm["ratio"], "9:16")


class DirectImageChainTests(unittest.TestCase):
    def build(self, payload, reference_size="800x600"):
        captured = {}

        async def fake_generate(prompt, size, quality, model, refs, provider_id, background, notice, n,
                                midjourney_version="", midjourney_hd=False):
            captured["size"] = size
            notice["size_notice"] = ""
            return ({"type": "url", "value": "/assets/output/x.png"}, {"data": [{"url": "/assets/output/x.png"}]})

        with unittest.mock.patch.object(main, "get_api_provider", return_value=APIMART), \
                unittest.mock.patch.object(main, "preferred_image_model", return_value="gpt-image-2"), \
                unittest.mock.patch.object(main, "generate_ai_image", new=fake_generate), \
                unittest.mock.patch.object(main, "image_size_from_reference", return_value=reference_size), \
                unittest.mock.patch.object(main, "save_ai_image_to_output", new=_fake_save), \
                unittest.mock.patch.object(main, "save_to_history", lambda *a, **k: None), \
                unittest.mock.patch.object(main, "GLOBAL_LOOP", None):
            result = asyncio.run(main.build_online_image_result(payload))
        return captured, result

    def test_size_auto_uses_source_ratio(self):
        payload = main.OnlineImageRequest(prompt="改图", provider_id="apimart", model="gpt-image-2",
                                          size="auto",
                                          reference_images=[main.AIReference(url="/assets/input/a.png", name="原图", kind="image")])
        captured, result = self.build(payload)
        self.assertEqual(captured["size"], "1536x1152")
        self.assertIn("按参考图比例", result.get("size_notice") or "")
        self.assertEqual(result["params"]["size"], "1536x1152")

    def test_ratio_adaptive_uses_source_ratio(self):
        payload = main.OnlineImageRequest(prompt="重绘", provider_id="apimart", model="gpt-image-2",
                                          size="", ratio="自适应",
                                          reference_images=[main.AIReference(url="/assets/input/a.png", name="原图", kind="image")])
        captured, result = self.build(payload, reference_size="720x1280")
        self.assertEqual(captured["size"], "864x1536")
        self.assertIn("按参考图比例", result.get("size_notice") or "")

    def test_no_reference_falls_back_to_square_with_notice(self):
        payload = main.OnlineImageRequest(prompt="文生图", provider_id="apimart", model="gpt-image-2", size="auto")
        captured, result = self.build(payload)
        self.assertEqual(captured["size"], "1024x1024")
        self.assertIn("没有参考图", result.get("size_notice") or "")

    def test_explicit_size_is_kept(self):
        payload = main.OnlineImageRequest(prompt="海报", provider_id="apimart", model="gpt-image-2", size="2048x1152",
                                          reference_images=[main.AIReference(url="/assets/input/a.png", name="原图", kind="image")])
        captured, _result = self.build(payload)
        self.assertEqual(captured["size"], "2048x1152")


class DirectVideoChainTests(unittest.TestCase):
    def test_adaptive_with_reference_sets_ratio(self):
        payload = main.CanvasVideoRequest(prompt="短片", provider_id="apimart", model="seedance-2-0",
                                          aspect_ratio="adaptive",
                                          images=[main.AIReference(url="/assets/input/a.png", name="首帧", kind="image")])
        with unittest.mock.patch.object(main, "get_api_provider", return_value=APIMART), \
                unittest.mock.patch.object(main, "image_size_from_reference", return_value="800x600"), \
                unittest.mock.patch.object(main, "video_api_root", return_value=""):
            with self.assertRaises(main.HTTPException):
                asyncio.run(main._canvas_video_run_unlimited(payload))
        self.assertEqual(payload.aspect_ratio, "4:3")

    def test_edit_task_keeps_adaptive(self):
        payload = main.CanvasVideoRequest(prompt="编辑", provider_id="apimart", model="seedance-2-0",
                                          aspect_ratio="adaptive", duration=-1,
                                          images=[main.AIReference(url="/assets/input/a.png", name="首帧", kind="image")])
        with unittest.mock.patch.object(main, "get_api_provider", return_value=APIMART), \
                unittest.mock.patch.object(main, "image_size_from_reference", return_value="800x600"), \
                unittest.mock.patch.object(main, "video_api_root", return_value=""):
            with self.assertRaises(main.HTTPException):
                asyncio.run(main._canvas_video_run_unlimited(payload))
        self.assertEqual(payload.aspect_ratio, "adaptive")


async def _fake_save(item, prefix=""):
    return "/assets/output/x.png"


if __name__ == "__main__":
    unittest.main()
