import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-pixverse-test-")
if "main" not in sys.modules:
    os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import main
from server.integrations import pixverse


class PixverseClientTests(unittest.TestCase):
    def test_upload_voice_generate_and_poll_contract(self):
        calls = []

        def handler(request):
            calls.append(request)
            path = request.url.path
            if path == "/openapi/v2/media/upload":
                return httpx.Response(200, json={"ErrCode": 0, "Resp": {"media_id": 11, "media_type": "audio", "url": "https://media.example/a.wav"}})
            if path == "/openapi/v2/video/tts_speaker":
                return httpx.Response(200, json={"ErrCode": 0, "Resp": {"speaker_id": "speaker-test"}})
            if path == "/openapi/v2/video/lip_sync/generate":
                return httpx.Response(200, json={"ErrCode": 0, "Resp": {"video_id": 22, "credits": 4}})
            if path == "/openapi/v2/video/result/22":
                return httpx.Response(200, json={"ErrCode": 0, "Resp": {"status": 1, "url": "https://media.example/result.mp4"}})
            return httpx.Response(404, json={"ErrCode": 404, "ErrMsg": "not found"})

        async def run():
            transport = httpx.MockTransport(handler)
            async with httpx.AsyncClient(transport=transport) as client:
                uploaded = await pixverse.upload_media(client, pixverse.DEFAULT_BASE_URL, "key", file_url="https://example.com/a.wav")
                speaker = await pixverse.create_custom_voice(client, pixverse.DEFAULT_BASE_URL, "key", uploaded["media_id"])
                submitted = await pixverse.generate_lipsync(client, pixverse.DEFAULT_BASE_URL, "key", video_media_id=7,
                                                            speaker_id=speaker, script="new line")
                result = await pixverse.wait_for_video(client, pixverse.DEFAULT_BASE_URL, "key", 22, interval=0)
                return speaker, submitted, result

        speaker, submitted, result = asyncio.run(run())
        self.assertEqual(speaker, "speaker-test")
        self.assertEqual(pixverse._resp(submitted)["video_id"], 22)
        self.assertEqual(pixverse._resp(result)["url"], "https://media.example/result.mp4")
        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[0].headers["API-KEY"], "key")
        self.assertIn("file_url=", calls[0].read().decode())


class PixverseCanvasTests(unittest.TestCase):
    def provider(self):
        return {"id": "pixverse", "name": "PixVerse", "base_url": pixverse.DEFAULT_BASE_URL, "protocol": "pixverse"}

    def test_consent_required_before_any_request(self):
        payload = main.CanvasVideoRequest(prompt="new line", provider_id="pixverse", model="pixverse-lipsync",
                                         videos=["https://example.com/source.mp4"], voice_consent=False)
        with self.assertRaises(main.HTTPException) as caught:
            asyncio.run(main.generate_pixverse_lipsync(payload, self.provider()))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("授权", caught.exception.detail)

    def test_clone_voice_and_lipsync_end_to_end(self):
        payload = main.CanvasVideoRequest(prompt="new line", provider_id="pixverse", model="pixverse-lipsync",
                                         videos=["https://example.com/source.mp4"],
                                         voice_sample="https://example.com/sample.wav", voice_consent=True)
        uploads = []

        async def upload(client, base, key, auth_mode, **kwargs):
            uploads.append(kwargs)
            return {"media_id": len(uploads), "media_type": "video" if len(uploads) == 1 else "audio"}

        async def wait(client, base, key, auth_mode, video_id):
            return {"ErrCode": 0, "Resp": {"status": 1, "url": "https://example.com/result.mp4"}}

        with patch.object(main, "provider_env_key_value", return_value="key"), \
             patch.object(main, "probe_local_video_duration_seconds", return_value=None), \
             patch("server.integrations.pixverse.upload_media", new=AsyncMock(side_effect=upload)), \
             patch("server.integrations.pixverse.create_custom_voice", new=AsyncMock(return_value="speaker-test")), \
             patch("server.integrations.pixverse.generate_lipsync", new=AsyncMock(return_value={"ErrCode": 0, "Resp": {"video_id": 9}})) as generate, \
             patch("server.integrations.pixverse.wait_for_video", new=AsyncMock(side_effect=wait)), \
             patch.object(main, "save_remote_video_to_output", new=AsyncMock(return_value="/output/lipsync.mp4")):
            result = asyncio.run(main.generate_pixverse_lipsync(payload, self.provider()))

        self.assertEqual(result["videos"], ["/output/lipsync.mp4"])
        self.assertEqual(result["speaker_id"], "speaker-test")
        self.assertEqual(result["task_id"], 9)
        self.assertEqual(len(uploads), 2)
        self.assertEqual(generate.await_args.kwargs["script"], "new line")
        self.assertEqual(generate.await_args.kwargs["speaker_id"], "speaker-test")

    def test_direct_audio_skips_voice_creation(self):
        payload = main.CanvasVideoRequest(prompt="ignored", provider_id="pixverse", model="pixverse-lipsync",
                                         videos=["https://example.com/source.mp4"], audios=["https://example.com/voice.wav"])
        with patch.object(main, "provider_env_key_value", return_value="key"), \
             patch.object(main, "probe_local_video_duration_seconds", return_value=None), \
             patch("server.integrations.pixverse.upload_media", new=AsyncMock(side_effect=[{"media_id": 1}, {"media_id": 2}])), \
             patch("server.integrations.pixverse.create_custom_voice", new=AsyncMock()) as create, \
             patch("server.integrations.pixverse.generate_lipsync", new=AsyncMock(return_value={"ErrCode": 0, "Resp": {"video_id": 9}})) as generate, \
             patch("server.integrations.pixverse.wait_for_video", new=AsyncMock(return_value={"ErrCode": 0, "Resp": {"status": 1, "url": "https://example.com/result.mp4"}})), \
             patch.object(main, "save_remote_video_to_output", new=AsyncMock(return_value="/output/lipsync.mp4")):
            asyncio.run(main.generate_pixverse_lipsync(payload, self.provider()))
        create.assert_not_awaited()
        self.assertEqual(generate.await_args.kwargs["audio_media_id"], 2)

    def test_long_video_rejected_before_upload(self):
        payload = main.CanvasVideoRequest(prompt="new line", provider_id="pixverse", model="pixverse-lipsync",
                                         videos=["https://example.com/long.mp4"], voice_consent=True)
        with patch.object(main, "probe_local_video_duration_seconds", return_value=61.0):
            with self.assertRaises(main.HTTPException) as caught:
                asyncio.run(main.generate_pixverse_lipsync(payload, self.provider()))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("60 秒", caught.exception.detail)


class PixverseAgentAndPricingTests(unittest.TestCase):
    def test_agent_requires_consent_for_cloning(self):
        with patch.object(main, "_agent_tool_generate_video_validate", return_value={"reference_video": [{"url": "/assets/v.mp4"}]}):
            with self.assertRaises(main.AgentToolError):
                main._agent_tool_lipsync_video_validate({"canvas_id": "c1", "prompt": "line", "reference_video": "/assets/v.mp4"})

    def test_agent_accepts_direct_audio_without_cloning(self):
        base = {"reference_video": [{"url": "/assets/v.mp4"}], "provider": "pixverse", "model": "pixverse-lipsync"}
        with patch.object(main, "_agent_tool_generate_video_validate", return_value=base):
            result = main._agent_tool_lipsync_video_validate({
                "canvas_id": "c1", "prompt": "line", "reference_video": "/assets/v.mp4",
                "audio": "/assets/voice.wav",
            })
        self.assertEqual(result["audios"], ["/assets/voice.wav"])
        self.assertFalse(result["voice_consent"])
        self.assertIn("lipsync_video", main.AGENT_PLAN_GENERATION_TOOLS)

    def test_official_per_second_pricing_is_not_fallback(self):
        from server.credits import pricing
        quote = pricing.estimate("video", "pixverse-lipsync", {"duration": 5}, provider="pixverse")
        self.assertFalse(quote["pricing_fallback"])
        self.assertEqual(quote["cost"], 20)
        self.assertEqual(quote["unit"], "per_second")


if __name__ == "__main__":
    unittest.main()
