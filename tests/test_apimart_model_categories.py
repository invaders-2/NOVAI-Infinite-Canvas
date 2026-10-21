"""APIMart 模型列表分类：expand=category 优先用上游 category，旧格式回退启发式。

官方出处：/tmp/apimart-docs/cn/api-reference/texts/models/list.md
  * GET /v1/models?expand=category 给每个模型附带 category（chat/image/video/audio/unknown），
    不带 expand 时响应与旧格式完全一致（向后兼容）；
  * category=unknown 表示平台暂未收录该模型分类元数据，模型本身可用 → 按名称猜测归类；
  * audio 现在也收（画布音频节点用），不再排除。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


class ApimartModelsUrlTests(unittest.TestCase):

    def test_apimart_hosts_carry_expand_category(self):
        self.assertTrue(main.upstream_models_url("https://api.apib.ai", "openai").endswith("/v1/models?expand=category"))
        self.assertTrue(main.upstream_models_url("https://api.apimart.ai/v1", "apimart").endswith("/models?expand=category"))
        self.assertTrue(main.upstream_models_url("http://127.0.0.1:3399", "apimart").endswith("?expand=category"))

    def test_other_hosts_do_not_carry_expand(self):
        url = main.upstream_models_url("https://api.openai.com", "openai")
        self.assertEqual(url, "https://api.openai.com/v1/models")
        self.assertNotIn("expand", main.upstream_models_url("https://ai.comfly.chat", "openai"))


class ApimartModelsParseTests(unittest.TestCase):

    def test_category_takes_priority(self):
        raw = {"object": "list", "data": [
            {"id": "gpt-4o", "category": "chat"},
            {"id": "gpt-image-2", "category": "image"},
            {"id": "seedance-2.0", "category": "video"},
            {"id": "suno-v5", "category": "audio"},
            {"id": "mystery-model", "category": "unknown"},
        ]}
        grouped, ids, meta = main.parse_upstream_models(raw, "apimart")
        self.assertEqual(grouped["chat"], ["gpt-4o", "mystery-model"])
        self.assertEqual(grouped["image"], ["gpt-image-2"])
        self.assertEqual(grouped["video"], ["seedance-2.0"])
        self.assertEqual(grouped["audio"], ["suno-v5"])
        self.assertEqual(ids, ["gpt-4o", "gpt-image-2", "mystery-model", "seedance-2.0", "suno-v5"])
        self.assertEqual(meta["guessed_unknown"], 1)

    def test_unknown_text_models_are_kept_as_chat(self):
        # 真机返回的 6 个 category=unknown（deepseek-v3.1 / qwen3.6-max / text-ada-001 ...）
        # 文档对 unknown 的定义只是「平台暂未收录分类元数据」，不是不可用，必须按名称归类保留
        raw = {"object": "list", "data": [
            {"id": "deepseek-v3.1", "category": "unknown"},
            {"id": "qwen3.6-max", "category": "unknown"},
            {"id": "text-ada-001", "category": "unknown"},
            {"id": "flowmusic", "category": "audio"},
        ]}
        grouped, ids, meta = main.parse_upstream_models(raw, "apimart")
        self.assertEqual(grouped["chat"], ["deepseek-v3.1", "qwen3.6-max", "text-ada-001"])
        self.assertEqual(grouped["audio"], ["flowmusic"])
        self.assertIn("flowmusic", ids)
        self.assertEqual(meta["guessed_unknown"], 3)

    def test_missing_category_falls_back_to_heuristic(self):
        raw = {"data": [{"id": "seedance-2.0"}, {"id": "gpt-4o"}, {"id": "gpt-image-2"}]}
        grouped, ids, meta = main.parse_upstream_models(raw, "openai")
        self.assertEqual(grouped["chat"], ["gpt-4o", "seedance-2.0"])
        self.assertEqual(grouped["image"], ["gpt-image-2"])
        self.assertEqual(grouped["video"], [])
        self.assertEqual(grouped["audio"], [])
        self.assertEqual(meta["guessed_unknown"], 0)
        self.assertEqual(ids, ["gpt-4o", "gpt-image-2", "seedance-2.0"])

    def test_unknown_category_value_falls_back_to_heuristic(self):
        raw = {"data": [{"id": "wan2.6", "category": "weird"}]}
        grouped, _ids, _meta = main.parse_upstream_models(raw, "apimart")
        self.assertEqual(grouped["video"], ["wan2.6"])

    def test_skipped_note_only_talks_about_unknown(self):
        self.assertEqual(main.upstream_models_skipped_note({"guessed_unknown": 6}),
                         "未知分类 6 个已按名称归类")
        self.assertEqual(main.upstream_models_skipped_note({"guessed_unknown": 0}), "")
        self.assertEqual(main.upstream_models_skipped_note(None), "")


class ApimartModelsResponseSourceTests(unittest.TestCase):

    def test_responses_report_audio_and_unknown(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn('"skipped": meta,', source)
        self.assertIn('"audio_models": grouped["audio"],', source)
        self.assertIn("upstream_models_skipped_note(meta)", source)
        self.assertIn('if protocol == "apimart" or is_apimart_models_host(base_url):', source)


if __name__ == "__main__":
    unittest.main()
