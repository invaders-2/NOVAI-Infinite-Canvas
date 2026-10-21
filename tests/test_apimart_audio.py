"""画布音频节点（POST /api/canvas-audio）：提交体映射 / 任务 URL / 结果解析（纯函数）。"""
from types import SimpleNamespace
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def payload(**kw):
    base = dict(provider_id="apimart", model="suno", prompt="", custom=False, instrumental=False,
                title="", style="", duration=None, bpm=None, length=None, audio_format="")
    base.update(kw)
    return SimpleNamespace(**base)


class ApimartAudioSubmitBodyTests(unittest.TestCase):

    def test_suno_custom_lyrics(self):
        body = main.apimart_audio_submit_body("suno", payload(prompt="[verse] 歌词", custom=True,
                                                              title="歌名", style="pop", duration=30, audio_format="mp3"))
        self.assertEqual(body["model"], "suno")
        self.assertEqual(body["version"], main.APIMART_SUNO_VERSION)
        self.assertIs(body["custom"], True)
        self.assertEqual(body["prompt"], "[verse] 歌词")
        self.assertEqual(body["title"], "歌名")
        self.assertEqual(body["style"], "pop")
        self.assertEqual(body["duration"], 30)
        self.assertEqual(body["audio_format"], "mp3")
        self.assertNotIn("instrumental", body)

    def test_suno_minimal_body(self):
        body = main.apimart_audio_submit_body("suno-v6", payload(prompt="轻快的钢琴"))
        self.assertEqual(body, {"model": "suno", "version": main.APIMART_SUNO_VERSION, "custom": False, "prompt": "轻快的钢琴"})

    def test_flowmusic_mapping(self):
        body = main.apimart_audio_submit_body("flowmusic", payload(prompt="lofi 鼓点", title="夜色", bpm=90, length=60))
        self.assertEqual(body, {"model": "flowmusic", "sound_prompt": "lofi 鼓点", "title": "夜色", "bpm": 90, "length": 60})

    def test_unknown_audio_model_fallback(self):
        body = main.apimart_audio_submit_body("some-music-model", payload(prompt="hello", title="T"))
        self.assertEqual(body, {"model": "some-music-model", "prompt": "hello", "title": "T"})


class ProviderAudioModelsTests(unittest.TestCase):

    def test_normalize_provider_keeps_audio_models(self):
        provider = main.normalize_provider({"id": "apimart-x", "name": "APIMart X",
                                            "base_url": "https://api.apib.ai", "audio_models": [" suno ", "suno", "flowmusic"]})
        self.assertEqual(provider["audio_models"], ["suno", "flowmusic"])

    def test_public_provider_exposes_audio_models(self):
        item = main.public_provider({"id": "apimart-x", "name": "APIMart X", "audio_models": ["suno"]})
        self.assertEqual(item["audio_models"], ["suno"])
        self.assertEqual(main.public_provider({"id": "apimart-x", "name": "APIMart X"})["audio_models"], [])


class ApimartAudioUrlTests(unittest.TestCase):

    def test_music_url_dedupes_v1(self):
        self.assertEqual(main.apimart_music_url("https://api.apib.ai", "/music/generations"),
                         "https://api.apib.ai/v1/music/generations")
        self.assertEqual(main.apimart_music_url("https://api.apib.ai/v1", "/music/generations"),
                         "https://api.apib.ai/v1/music/generations")
        self.assertEqual(main.apimart_music_task_url("https://api.apib.ai/v1", "task_1"),
                         "https://api.apib.ai/v1/music/tasks/task_1?language=zh")

    def test_task_id_from_list_or_dict(self):
        self.assertEqual(main.apimart_music_task_id({"code": 200, "data": [{"task_id": "t1"}]}), "t1")
        self.assertEqual(main.apimart_music_task_id({"data": {"task_id": "t2"}}), "t2")
        self.assertEqual(main.apimart_music_task_id({"task_id": "t3"}), "t3")
        self.assertEqual(main.apimart_music_task_id({"data": []}), "")

    def test_audio_urls_compatible_keys(self):
        raw = {"data": {"result": {"music": [
            {"audio_url": "https://x/a.mp3"},
            {"wav_url": "https://x/b.wav"},
            {"url": ["https://x/c.m4a"]},
            {"audioUrl": "https://x/d.mp3"},
            {"audio_url": "not-a-url"},
        ]}}}
        self.assertEqual(main.apimart_music_audio_urls(raw),
                         ["https://x/a.mp3", "https://x/b.wav", "https://x/c.m4a", "https://x/d.mp3"])

    def test_title_priority(self):
        raw = {"data": {"result": {"music": [{"title": "上游标题", "audio_url": "https://x/a.mp3"}]}}}
        self.assertEqual(main.apimart_music_title(raw, payload(title="用户标题")), "上游标题")
        self.assertEqual(main.apimart_music_title({}, payload(title="用户标题")), "用户标题")
        self.assertEqual(main.apimart_music_title({}, payload()), "Audio")

    def test_untitled_placeholder_is_not_used(self):
        raw = {"data": {"result": {"music": [{"title": "Untitled", "audio_url": "https://x/a.mp3"}]}}}
        self.assertEqual(main.apimart_music_title(raw, payload(title="用户标题")), "用户标题")
        self.assertEqual(main.apimart_music_title(raw, payload()), "Audio")
        self.assertEqual(
            main.apimart_music_title({"data": {"result": {"music": [{"title": " untitled ", "audio_url": "https://x/a.mp3"}]}}},
                                     payload()),
            "Audio")

    def test_cost_fields_only_when_present(self):
        raw = {"data": {"status": "completed", "cost": 0.0123, "credits_cost": 0.123,
                        "result": {"music": [{"audio_url": "https://x/a.mp3"}]}}}
        self.assertEqual(main.apimart_music_cost(raw), {"cost": 0.0123, "credits_cost": 0.123})
        self.assertEqual(main.apimart_music_cost({"data": {"status": "completed"}}), {})
        self.assertEqual(main.apimart_music_cost({}), {})


class ApimartAudioSourceTests(unittest.TestCase):

    def test_route_and_contract_fields(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn('@app.post("/api/canvas-audio")', source)
        self.assertIn("async def generate_canvas_audio(payload: CanvasAudioRequest)", source)
        self.assertIn('"/music/generations"', source)
        self.assertIn('"canvas_meta": {"node_type": "audio", "title": title, "media_url": first, "auto_place": True},', source)
        self.assertIn("APIMART_MUSIC_FIRST_DELAY = 3.0", source)
        self.assertIn("APIMART_MUSIC_POLL_INTERVAL = 5.0", source)
        self.assertIn("APIMART_MUSIC_TIMEOUT = 900.0", source)
        self.assertIn("APIMART_MUSIC_PLACEHOLDER_TITLES", source)
        self.assertIn('detail=f"请求音频接口失败：{type(exc).__name__}: {exc}"', source)
        self.assertIn("response.update(cost)", source)


if __name__ == "__main__":
    unittest.main()
