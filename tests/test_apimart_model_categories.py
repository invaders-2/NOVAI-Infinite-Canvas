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
        # 2026-11-26 修正：裸 seedance 现在按种子系视频归类（旧断言把它当 chat）
        self.assertEqual(grouped["chat"], ["gpt-4o"])
        self.assertEqual(grouped["image"], ["gpt-image-2"])
        self.assertEqual(grouped["video"], ["seedance-2.0"])
        self.assertEqual(grouped["audio"], [])
        self.assertEqual(meta["guessed_unknown"], 0)
        self.assertEqual(ids, ["gpt-4o", "gpt-image-2", "seedance-2.0"])

    def test_missing_category_seedance_variants_are_video(self):
        raw = {"data": [{"id": "seedance-2.0"}, {"id": "doubao-seedance-2-0-260128"},
                         {"id": "seedance-2-5-flash"}]}
        grouped, _ids, _meta = main.parse_upstream_models(raw, "apimart")
        # parse_upstream_models 对分组结果排序去重（既有行为），断言按排序后的顺序写
        self.assertEqual(grouped["video"], ["doubao-seedance-2-0-260128", "seedance-2-5-flash",
                                            "seedance-2.0"])
        self.assertEqual(grouped["chat"], [])

    def test_missing_category_image_families(self):
        # 2026-11-26 补：grok-imagine（不含 image 子串，靠 imagine 命中）与 z-image；
        # 同族的 grok 视频模型含 "video"，仍归 video
        raw = {"data": [{"id": "grok-imagine-2.0-ext"}, {"id": "grok-imagine-image-2.0"},
                         {"id": "z-image-turbo"}, {"id": "grok-imagine-video-1.5"},
                         {"id": "grok-imagine-1.5-video-apimart"}]}
        grouped, _ids, _meta = main.parse_upstream_models(raw, "openai")
        self.assertEqual(grouped["image"], ["grok-imagine-2.0-ext", "grok-imagine-image-2.0",
                                            "z-image-turbo"])
        self.assertEqual(grouped["video"], ["grok-imagine-1.5-video-apimart", "grok-imagine-video-1.5"])
        self.assertEqual(grouped["chat"], [])

    def test_missing_category_video_families(self):
        # 2026-11-26 补：pixverse / viduq3 / viduq4 / skyreels / happyhorse / MiniMax-H3 /
        # gemini-omni / Omni-Flash-Ext / apimart-zoe 缺 category 时都要归 video
        ids = ["pixverse-v6", "viduq3-turbo", "viduq4-preview", "skyreels-v4-fast", "happyhorse-1.0",
               "MiniMax-H3", "gemini-omni-1.2-flash", "Omni-Flash-Ext", "apimart-zoe"]
        grouped, _ids, _meta = main.parse_upstream_models({"data": [{"id": i} for i in ids]}, "openai")
        self.assertEqual(len(grouped["video"]), len(ids), grouped)
        self.assertEqual(grouped["chat"], [])
        self.assertEqual(grouped["image"], [])
        self.assertEqual(grouped["audio"], [])

    def test_same_family_image_beats_video_keywords(self):
        # 同族里 image/video 都有的：带 -image 的先归 image（minimax-h3-image / pixverse-image），
        # 但 "image-to-video" 这类仍归 video（名字里有 video）
        raw = {"data": [{"id": "minimax-h3-image"}, {"id": "minimax-h3-image-highspeed"},
                         {"id": "pixverse-image-template"}, {"id": "MiniMax-H3"},
                         {"id": "pixverse-v6"}, {"id": "kling-v3-image-to-video"}]}
        grouped, _ids, _meta = main.parse_upstream_models(raw, "openai")
        self.assertEqual(grouped["image"], ["minimax-h3-image", "minimax-h3-image-highspeed",
                                            "pixverse-image-template"])
        self.assertEqual(grouped["video"], ["MiniMax-H3", "kling-v3-image-to-video", "pixverse-v6"])
        self.assertEqual(grouped["chat"], [])

    def test_missing_category_audio_models_fall_back_to_audio(self):
        # 2026-11-26：上游 /v1/models?expand=category 把 audio 归成 5 个
        # （flowmusic / gpt-4o-mini-tts / gpt-audio-mini / suno / whisper-1）；
        # 没有 category 的旧格式也必须进 audio，否则会被塞进对话模型列表
        raw = {"data": [{"id": "flowmusic"}, {"id": "suno"}, {"id": "gpt-4o-mini-tts"},
                         {"id": "gpt-audio-mini"}, {"id": "gpt-4o-audio-preview"},
                         {"id": "whisper-1"}]}
        grouped, ids, _meta = main.parse_upstream_models(raw, "openai")
        expected = ["flowmusic", "gpt-4o-audio-preview", "gpt-4o-mini-tts", "gpt-audio-mini",
                    "suno", "whisper-1"]
        self.assertEqual(grouped["audio"], expected)
        self.assertEqual(grouped["chat"], [])
        self.assertEqual(grouped["video"], [])
        self.assertEqual(grouped["image"], [])
        self.assertEqual(ids, expected)

    def test_unknown_category_value_falls_back_to_heuristic(self):
        raw = {"data": [{"id": "wan2.6", "category": "weird"}]}
        grouped, _ids, _meta = main.parse_upstream_models(raw, "apimart")
        self.assertEqual(grouped["video"], ["wan2.6"])

    def test_semantic_override_forces_transcribe_and_hides_moderation(self):
        # 上游 /v1/models?expand=category 真机返回：这两类都被标成 category=chat，
        # 但它们分别走 /v1/audio/transcriptions 与 /v1/moderations，照抄分类就会做出「选中必失败」的对话项
        raw = {"object": "list", "data": [
            {"id": "gpt-4o-transcribe", "category": "chat"},
            {"id": "gpt-4o-mini-transcribe", "category": "chat"},
            {"id": "omni-moderation-latest", "category": "chat"},
            {"id": "gpt-4o", "category": "chat"},
        ]}
        grouped, ids, meta = main.parse_upstream_models(raw, "apimart")
        # 转写模型强制归 audio：对话列表里不能再出现
        self.assertEqual(grouped["audio"], ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"])
        self.assertNotIn("gpt-4o-transcribe", grouped["chat"])
        self.assertNotIn("gpt-4o-mini-transcribe", grouped["chat"])
        # 审核模型整条隐藏：不落任何分桶，也不进全量 ids
        self.assertEqual(meta["hidden"], ["omni-moderation-latest"])
        for bucket in grouped.values():
            self.assertNotIn("omni-moderation-latest", bucket)
        self.assertNotIn("omni-moderation-latest", ids)
        # 普通 chat 模型不受影响
        self.assertEqual(grouped["chat"], ["gpt-4o"])
        self.assertEqual(grouped["image"], [])
        self.assertEqual(grouped["video"], [])
        self.assertIn("gpt-4o-transcribe", ids)

    def test_semantic_override_survives_missing_category(self):
        # 上游不给 category 时同样生效（换别的 OpenAI 兼容站也不能漏）
        raw = {"data": [{"id": "GPT-4o-transcribe"}, {"id": "omni-moderation-latest"}]}
        grouped, _ids, meta = main.parse_upstream_models(raw, "openai")
        self.assertEqual(grouped["audio"], ["GPT-4o-transcribe"])
        self.assertEqual(grouped["chat"], [])
        self.assertEqual(meta["hidden"], ["omni-moderation-latest"])

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
