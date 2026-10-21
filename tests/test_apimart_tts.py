"""APIMart TTS（POST /api/canvas-tts）：提交体映射 / 参数校验 / 二进制落盘 / 上游错误。

不联网：进程内起一个 http.server 假上游，记录 POST /v1/audio/speech 的提交体，
再 asyncio 调 main 的真实函数。接口口径来自 APIMart 官方文档：
  * 请求体 {"model","input","voice","response_format","speed"}，input 最长 4096 字；
  * voice 白名单 alloy/echo/fable/onyx/nova/shimmer；
  * response_format wav/opus/aac/flac/pcm；
  * speed 0.25–4.0，越界由服务端夹取；
  * 成功返回二进制音频流（不是 JSON），失败返回 JSON 错误。
"""
import asyncio
import io
import json
import os
import shutil
import struct
import tempfile
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from fastapi import HTTPException

WAV_BYTES = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 40
FLAC_BYTES = b"fLaC" + b"\x00" * 40
PCM_BYTES = b"\x00\x01\x02\x03" * 16


def streaming_wav_bytes(sample_count=4000, sample_rate=16000):
    """构造 APIMart 那种 RIFF/data size 都是 0xFFFFFFFF 的流式 WAV。"""
    pcm = b"\x00\x00" * sample_count
    fmt = struct.pack("<HHIIHH", 1, 1, sample_rate, sample_rate * 2, 2, 16)
    header = (b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVE"
              + b"fmt " + struct.pack("<I", len(fmt)) + fmt
              + b"data" + struct.pack("<I", 0xFFFFFFFF))
    return header + pcm


def payload(**kw):
    base = dict(provider_id="apimart", model="gpt-4o-mini-tts", input="你好，世界",
                voice="alloy", response_format="wav", speed=1.0)
    base.update(kw)
    return SimpleNamespace(**base)


class ApimartTtsSubmitBodyTests(unittest.TestCase):

    def test_default_body_matches_document(self):
        body = main.apimart_tts_submit_body(payload())
        self.assertEqual(body, {"model": "gpt-4o-mini-tts", "input": "你好，世界",
                                "voice": "alloy", "response_format": "wav", "speed": 1.0})

    def test_all_fields_mapping(self):
        body = main.apimart_tts_submit_body(payload(input="  hello  ", voice="NOVA",
                                                     response_format="OPUS", speed=1.5,
                                                     model="gpt-4o-mini-tts"))
        self.assertEqual(body["input"], "hello")
        self.assertEqual(body["voice"], "nova")
        self.assertEqual(body["response_format"], "opus")
        self.assertEqual(body["speed"], 1.5)

    def test_blank_model_falls_back_to_default(self):
        body = main.apimart_tts_submit_body(payload(model=""))
        self.assertEqual(body["model"], main.APIMART_TTS_DEFAULT_MODEL)

    def test_empty_input_rejected(self):
        for value in ("", "   ", "\n\t"):
            with self.assertRaises(HTTPException) as ctx:
                main.apimart_tts_submit_body(payload(input=value))
            self.assertEqual(ctx.exception.status_code, 400)

    def test_input_at_limit_accepted_and_over_limit_rejected(self):
        body = main.apimart_tts_submit_body(payload(input="字" * 4096))
        self.assertEqual(len(body["input"]), 4096)
        with self.assertRaises(HTTPException) as ctx:
            main.apimart_tts_submit_body(payload(input="字" * 4097))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("4096", ctx.exception.detail)

    def test_voice_whitelist(self):
        with self.assertRaises(HTTPException) as ctx:
            main.apimart_tts_submit_body(payload(voice="robot"))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("robot", ctx.exception.detail)
        for voice in main.APIMART_TTS_VOICES:
            self.assertEqual(main.apimart_tts_submit_body(payload(voice=voice))["voice"], voice)

    def test_format_whitelist(self):
        with self.assertRaises(HTTPException) as ctx:
            main.apimart_tts_submit_body(payload(response_format="mp3"))
        self.assertEqual(ctx.exception.status_code, 400)
        for fmt in main.APIMART_TTS_FORMATS:
            self.assertEqual(main.apimart_tts_submit_body(payload(response_format=fmt))["response_format"], fmt)

    def test_speed_clamped_to_official_range(self):
        self.assertEqual(main.apimart_tts_speed(0.1), 0.25)
        self.assertEqual(main.apimart_tts_speed(9), 4.0)
        self.assertEqual(main.apimart_tts_speed(1.234), 1.23)
        self.assertEqual(main.apimart_tts_speed("abc"), 1.0)
        self.assertEqual(main.apimart_tts_speed(None), 1.0)
        self.assertEqual(main.apimart_tts_speed(float("nan")), 1.0)
        self.assertEqual(main.apimart_tts_submit_body(payload(speed=99))["speed"], 4.0)
        self.assertEqual(main.apimart_tts_submit_body(payload(speed=0))["speed"], 0.25)

    def test_extension_prefers_content_type(self):
        self.assertEqual(main.apimart_tts_extension("wav", "audio/wav"), ".wav")
        self.assertEqual(main.apimart_tts_extension("wav", "audio/x-wav"), ".wav")
        self.assertEqual(main.apimart_tts_extension("wav", "audio/mpeg"), ".mp3")
        self.assertEqual(main.apimart_tts_extension("wav", "audio/ogg; codecs=opus"), ".opus")
        self.assertEqual(main.apimart_tts_extension("wav", "audio/ogg"), ".ogg")
        self.assertEqual(main.apimart_tts_extension("opus", "application/octet-stream"), ".opus")
        self.assertEqual(main.apimart_tts_extension("flac", "audio/flac"), ".flac")
        self.assertEqual(main.apimart_tts_extension("pcm", ""), ".pcm")
        self.assertEqual(main.apimart_tts_extension("aac", "audio/aac"), ".aac")

    def test_title_is_trimmed_text_snippet(self):
        self.assertEqual(main.apimart_tts_title("  你好\n世界  "), "你好 世界")
        self.assertEqual(main.apimart_tts_title(""), "语音")
        long_title = main.apimart_tts_title("字" * 30)
        self.assertEqual(len(long_title), 21)
        self.assertTrue(long_title.endswith("…"))


class StreamingWavNormalizeTests(unittest.TestCase):
    """真实 APIMart TTS 返回的流式 WAV：RIFF/data size 都是 0xFFFFFFFF，落盘前要归一。"""

    def test_unknown_sizes_rewritten_to_real_lengths(self):
        raw = streaming_wav_bytes(sample_count=4000)
        fixed = main.normalize_streaming_wav_bytes(raw)
        self.assertEqual(struct.unpack("<I", fixed[4:8])[0], len(raw) - 8)
        self.assertEqual(struct.unpack("<I", fixed[40:44])[0], len(raw) - 44)
        with wave.open(io.BytesIO(fixed), "rb") as reader:
            self.assertEqual(reader.getnframes(), 4000)
            self.assertEqual(reader.getframerate(), 16000)
            self.assertAlmostEqual(reader.getnframes() / reader.getframerate(), 0.25, places=3)

    def test_zero_sizes_rewritten(self):
        raw = bytearray(streaming_wav_bytes(sample_count=800))
        raw[4:8] = struct.pack("<I", 0)
        raw[40:44] = struct.pack("<I", 0)
        fixed = main.normalize_streaming_wav_bytes(bytes(raw))
        self.assertEqual(struct.unpack("<I", fixed[4:8])[0], len(raw) - 8)
        self.assertEqual(struct.unpack("<I", fixed[40:44])[0], len(raw) - 44)

    def test_valid_wav_is_untouched_and_idempotent(self):
        raw = streaming_wav_bytes(sample_count=4000)
        fixed = main.normalize_streaming_wav_bytes(raw)
        valid = bytearray(raw)
        valid[4:8] = struct.pack("<I", len(raw) - 8)
        valid[40:44] = struct.pack("<I", len(raw) - 44)
        valid = bytes(valid)
        self.assertEqual(main.normalize_streaming_wav_bytes(valid), valid)
        self.assertEqual(main.normalize_streaming_wav_bytes(fixed), fixed)

    def test_non_wav_is_untouched(self):
        for raw in (FLAC_BYTES, PCM_BYTES, b"", b"RIFF", WAV_BYTES):
            self.assertEqual(main.normalize_streaming_wav_bytes(raw), raw)

    def test_save_tts_audio_normalizes_streaming_wav(self):
        tmp = tempfile.mkdtemp(prefix="novai-tts-wavnorm-")
        saved_dir = main.OUTPUT_OUTPUT_DIR
        try:
            main.OUTPUT_OUTPUT_DIR = os.path.join(tmp, "output")
            os.makedirs(main.OUTPUT_OUTPUT_DIR, exist_ok=True)
            url = main.save_tts_audio_to_output(streaming_wav_bytes(sample_count=4000), ext=".wav")
            path = os.path.join(main.OUTPUT_OUTPUT_DIR, url.split("/assets/output/", 1)[1])
            with wave.open(path, "rb") as reader:
                self.assertEqual(reader.getnframes(), 4000)
                self.assertLess(reader.getnframes() / reader.getframerate(), 5)
        finally:
            main.OUTPUT_OUTPUT_DIR = saved_dir
            shutil.rmtree(tmp, ignore_errors=True)


class TtsSourceContractTests(unittest.TestCase):

    def test_route_and_contract_fields(self):
        source = Path(main.__file__).read_text(encoding="utf-8")
        self.assertIn('@app.post("/api/canvas-tts")', source)
        self.assertIn("async def generate_canvas_tts(payload: CanvasTTSRequest)", source)
        self.assertIn('apimart_music_url(base_url, "/audio/speech")', source)
        self.assertIn("APIMART_TTS_MAX_INPUT = 4096", source)
        self.assertIn("APIMART_TTS_VOICES = (", source)
        self.assertIn('"canvas_meta": {"node_type": "audio", "title": apimart_tts_title(body["input"]), "media_url": local_url, "auto_place": True},', source)
        self.assertIn("response_format", source)


class _MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _send(self, status, payload=None, raw=None, content_type="application/json"):
        data = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._read_body()
        parsed = {}
        if body:
            try:
                parsed = json.loads(body.decode("utf-8"))
            except Exception:
                parsed = {}
        with self.server.log_lock:
            self.server.requests.append({
                "method": self.command,
                "path": path,
                "host": self.headers.get("Host") or "",
                "body": parsed,
            })
        if path != "/v1/audio/speech":
            self._send(404, {"error": {"message": "no such mock route: " + path}})
            return
        if str(parsed.get("input") or "") == "BOOM":
            self._send(500, {"error": {"message": "upstream exploded: rate limited (retry later)"}})
            return
        if str(parsed.get("input") or "") == "STREAM":
            self._send(200, raw=streaming_wav_bytes(sample_count=4000), content_type="audio/wav")
            return
        fmt = str(parsed.get("response_format") or "wav")
        if fmt == "flac":
            self._send(200, raw=FLAC_BYTES, content_type="audio/flac")
        elif fmt == "pcm":
            self._send(200, raw=PCM_BYTES, content_type="application/octet-stream")
        else:
            self._send(200, raw=WAV_BYTES, content_type="audio/wav")


class ApimartTtsUpstreamTests(unittest.TestCase):
    provider_id = "apimart-tts-mock"
    openai_provider_id = "openai-tts-mock"

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
        cls.server.requests = []
        cls.server.log_lock = threading.Lock()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address[:2]
        cls.base = "http://%s:%s" % (host, port)

        cls.tmp = tempfile.mkdtemp(prefix="novai-apimart-tts-")
        cls.output_dir = os.path.join(cls.tmp, "assets", "output")
        os.makedirs(cls.output_dir, exist_ok=True)
        provider_file = os.path.join(cls.tmp, "api_providers.json")
        with open(provider_file, "w", encoding="utf-8") as f:
            json.dump([
                {
                    "id": cls.provider_id,
                    "name": "Mock TTS Gateway",
                    "base_url": cls.base,
                    "protocol": "apimart",
                    "enabled": True,
                    "primary": True,
                    "use_proxy": "off",
                    "audio_models": ["gpt-4o-mini-tts"],
                },
                {
                    "id": cls.openai_provider_id,
                    "name": "OpenAI Compatible",
                    "base_url": cls.base,
                    "protocol": "openai",
                    "enabled": True,
                    "use_proxy": "off",
                    "audio_models": ["tts-1"],
                },
            ], f)

        cls.saved = {
            "API_PROVIDERS_FILE": main.API_PROVIDERS_FILE,
            "ASSETS_DIR": main.ASSETS_DIR,
            "OUTPUT_INPUT_DIR": main.OUTPUT_INPUT_DIR,
            "OUTPUT_OUTPUT_DIR": main.OUTPUT_OUTPUT_DIR,
        }
        main.API_PROVIDERS_FILE = provider_file
        main.ASSETS_DIR = os.path.join(cls.tmp, "assets")
        main.OUTPUT_INPUT_DIR = os.path.join(cls.tmp, "assets", "input")
        main.OUTPUT_OUTPUT_DIR = cls.output_dir
        os.makedirs(main.OUTPUT_INPUT_DIR, exist_ok=True)
        os.environ[main.provider_key_env(cls.provider_id)] = "sk-mock-tts"
        os.environ[main.provider_key_env(cls.openai_provider_id)] = "sk-mock-openai"

    @classmethod
    def tearDownClass(cls):
        for key, value in cls.saved.items():
            setattr(main, key, value)
        os.environ.pop(main.provider_key_env(cls.provider_id), None)
        os.environ.pop(main.provider_key_env(cls.openai_provider_id), None)
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        with self.server.log_lock:
            self.server.requests.clear()

    def requests(self):
        with self.server.log_lock:
            return list(self.server.requests)

    def generate(self, **kw):
        base = dict(provider_id=self.provider_id, model="gpt-4o-mini-tts", input="你好，世界",
                    voice="nova", response_format="wav", speed=1.25)
        base.update(kw)
        return asyncio.run(main.generate_canvas_tts(main.CanvasTTSRequest(**base)))

    def assert_local_output(self, url, ext):
        self.assertIsInstance(url, str)
        self.assertTrue(url.startswith("/assets/output/"), url)
        self.assertTrue(url.endswith(ext), url)
        self.assertTrue(os.path.isfile(os.path.join(self.output_dir, url.split("/assets/output/", 1)[1])), url)

    def test_request_body_and_binary_saved_to_output(self):
        result = self.generate()
        posts = [item for item in self.requests() if item["method"] == "POST" and item["path"] == "/v1/audio/speech"]
        self.assertEqual(len(posts), 1, self.requests())
        self.assertEqual(posts[0]["host"], self.base.split("://", 1)[1])
        self.assertEqual(posts[0]["body"], {
            "model": "gpt-4o-mini-tts",
            "input": "你好，世界",
            "voice": "nova",
            "response_format": "wav",
            "speed": 1.25,
        })
        self.assertEqual(result["model"], "gpt-4o-mini-tts")
        self.assertEqual(result["voice"], "nova")
        self.assertEqual(result["response_format"], "wav")
        self.assertEqual(result["speed"], 1.25)
        self.assertEqual(result["characters"], len("你好，世界"))
        self.assertEqual(result["canvas_meta"]["node_type"], "audio")
        self.assertIs(result["canvas_meta"]["auto_place"], True)
        self.assertEqual(result["canvas_meta"]["title"], "你好，世界")
        self.assertEqual(len(result["audios"]), 1)
        self.assert_local_output(result["audios"][0], ".wav")
        self.assertNotIn("notice", result)

    def test_flac_response_format_uses_flac_extension(self):
        result = self.generate(response_format="flac")
        posts = [item for item in self.requests() if item["path"] == "/v1/audio/speech"]
        self.assertEqual(posts[0]["body"]["response_format"], "flac")
        self.assert_local_output(result["audios"][0], ".flac")

    def test_streaming_wav_saved_with_true_duration(self):
        result = self.generate(input="STREAM")
        url = result["audios"][0]
        self.assert_local_output(url, ".wav")
        path = os.path.join(self.output_dir, url.split("/assets/output/", 1)[1])
        with open(path, "rb") as f:
            raw = f.read()
        self.assertEqual(struct.unpack("<I", raw[4:8])[0], len(raw) - 8)
        self.assertEqual(struct.unpack("<I", raw[40:44])[0], len(raw) - 44)
        with wave.open(path, "rb") as reader:
            self.assertEqual(reader.getnframes(), 4000)
            self.assertAlmostEqual(reader.getnframes() / reader.getframerate(), 0.25, places=3)

    def test_pcm_response_adds_playback_notice(self):
        result = self.generate(response_format="pcm")
        self.assert_local_output(result["audios"][0], ".pcm")
        self.assertIn("浏览器不能直接播放", result["notice"])

    def test_upstream_error_is_readable(self):
        with self.assertRaises(HTTPException) as ctx:
            self.generate(input="BOOM")
        self.assertEqual(ctx.exception.status_code, 500)
        self.assertIn("语音合成失败", ctx.exception.detail)
        self.assertIn("upstream exploded", ctx.exception.detail)

    def test_invalid_input_never_reaches_upstream(self):
        with self.assertRaises(HTTPException) as ctx:
            self.generate(input="字" * 4097)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertFalse([item for item in self.requests() if item["path"] == "/v1/audio/speech"], self.requests())

    def test_non_apimart_provider_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            self.generate(provider_id=self.openai_provider_id)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("APIMart", ctx.exception.detail)
        self.assertFalse([item for item in self.requests() if item["path"] == "/v1/audio/speech"], self.requests())


if __name__ == "__main__":
    unittest.main()
