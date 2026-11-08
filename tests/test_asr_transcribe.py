#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""画布助手语音转写：/api/asr/status 与 /api/asr/transcribe 的契约、错误映射与临时文件清理。

为什么这样测：
- 真上游会花钱且受网络影响，这里在进程内起一个 http.server 假上游，把 deps 里的
  resolve_chat_provider 换成假的；断言的是「后端实际发出的请求体」与「返回给前端的 JSON」。
- 数据目录与 settings.json 都落在 tempfile 下，跑完即删，不碰用户日常数据。

跑法：
    venv/bin/python -m pytest tests/test_asr_transcribe.py -v
    venv/bin/python -m unittest tests.test_asr_transcribe -v
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# 与仓库其它 python 测试一致：主模块只会被导入一次，先给它一个临时数据目录，
# 避免首次 import 就把文件落到项目的日常数据目录里。
_TMP_DATA = tempfile.mkdtemp(prefix="novai-asr-main-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)

import main  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from server.agents import store  # noqa: E402
from server.integrations import asr, video_sources  # noqa: E402
from server.routes.deps import deps  # noqa: E402

WAV_BYTES = b"RIFF" + b"\x00" * 120
_ENV_KEYS = ("NOVAI_ASR_PROVIDER", "NOVAI_ASR_MODEL", "NOVAI_ASR_COMMAND",
             "NOVAI_ASR_TIMEOUT", "NOVAI_AUTH_ENABLED")


def _completion(text):
    return {"choices": [{"message": {"role": "assistant", "content": text}}]}


@contextlib.contextmanager
def _mock_upstream(status=200, payload=None):
    """进程内假上游：记录请求体，按给定状态/JSON 回应，不碰外网。"""
    calls = []
    response_payload = _completion("你好，夏日风格") if payload is None else payload

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                parsed = json.loads(raw.decode("utf-8")) if raw else None
            except Exception:
                parsed = {"raw": raw.decode("utf-8", "replace")[:200]}
            calls.append({
                "path": self.path.split("?", 1)[0],
                "body": parsed,
                "authorization": self.headers.get("Authorization") or "",
                "content_type": self.headers.get("Content-Type") or "",
            })
            data = json.dumps(response_payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    holder = SimpleNamespace(calls=calls,
                             base_url="http://127.0.0.1:%d/v1" % server.server_address[1])
    try:
        yield holder
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _fake_resolver(base_url, resolved_model="resolved-model", error=None):
    calls = []

    def resolve(provider, model, ms_model, require_model=True):
        calls.append({"provider": provider, "model": model, "ms_model": ms_model,
                      "require_model": require_model})
        if error is not None:
            raise error
        return base_url, {"Authorization": "Bearer fake"}, resolved_model

    resolve.calls = calls
    return resolve


class _AsrTestCase(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="novai-asr-test-")
        self.data_dir = os.path.join(self.root, "data")
        os.makedirs(self.data_dir, exist_ok=True)
        self._prev_data_dir = store.data_dir()
        store.set_data_dir(self.data_dir)
        self._saved_env = {key: os.environ.pop(key, None) for key in _ENV_KEYS}
        self._config_patch = None

    def tearDown(self):
        store.set_data_dir(self._prev_data_dir)
        for key, value in self._saved_env.items():
            os.environ.pop(key, None)
            if value is not None:
                os.environ[key] = value
        if self._config_patch is not None:
            self._config_patch.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def write_settings(self, payload):
        with open(os.path.join(self.data_dir, "settings.json"), "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)

    def use_config_asr(self, provider, model):
        path = os.path.join(self.root, "capability_inputs.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"video": {"asr": {"provider": provider, "model": model}}}, handle)
        self._config_patch = mock.patch.object(video_sources, "_ASR_CONFIG_FILE", path)
        self._config_patch.start()

    @contextlib.contextmanager
    def resolver(self, fn):
        previous = deps.__dict__.get("get")
        original_get = deps.get

        def fake_get(name, default=None):
            if name == "resolve_chat_provider":
                return fn
            return original_get(name, default)

        deps.get = fake_get
        try:
            yield
        finally:
            if previous is None:
                deps.__dict__.pop("get", None)
            else:
                deps.__dict__["get"] = previous


def _run(coro):
    return asyncio.run(coro)


class StatusTests(_AsrTestCase):
    def test_not_configured(self):
        status = asr.asr_status()
        self.assertEqual(status["ready"], False)
        self.assertEqual(status["provider"], "")
        self.assertEqual(status["model"], "")
        self.assertEqual(status["source"], "none")
        self.assertIn("语音转写", status["hint"])

    def test_user_settings(self):
        self.write_settings({"asr": {"provider": "custom-api", "model": "chat-1"}})
        status = asr.asr_status()
        self.assertEqual(status["ready"], True)
        self.assertEqual(status["source"], "user")
        self.assertEqual(status["provider"], "custom-api")
        self.assertEqual(status["model"], "chat-1")

    def test_env_overrides_user(self):
        self.write_settings({"asr": {"provider": "custom-api", "model": "chat-1"}})
        with mock.patch.dict(os.environ, {"NOVAI_ASR_PROVIDER": "env-p",
                                          "NOVAI_ASR_MODEL": "env-m"}):
            status = asr.asr_status()
        self.assertEqual(status["source"], "env")
        self.assertEqual(status["provider"], "env-p")
        self.assertEqual(status["model"], "env-m")

    def test_config_layer(self):
        self.use_config_asr("config-p", "config-m")
        status = asr.asr_status()
        self.assertEqual(status["ready"], True)
        self.assertEqual(status["source"], "config")
        self.assertEqual(status["provider"], "config-p")
        self.assertEqual(status["model"], "config-m")

    def test_user_overrides_config(self):
        self.use_config_asr("config-p", "config-m")
        self.write_settings({"asr": {"provider": "user-p", "model": "user-m"}})
        status = asr.asr_status()
        self.assertEqual(status["source"], "user")
        self.assertEqual(status["provider"], "user-p")
        self.assertEqual(status["model"], "user-m")

    def test_config_overrides_agent(self):
        self.use_config_asr("config-p", "config-m")
        self.write_settings({"agent_chat_model": "apimart::gemini-3.1-pro-preview"})
        status = asr.asr_status()
        self.assertEqual(status["source"], "config")
        self.assertEqual(status["provider"], "config-p")

    def test_agent_chat_model_fallback(self):
        self.write_settings({"agent_chat_model": "apimart::gemini-3.1-pro-preview"})
        status = asr.asr_status()
        self.assertEqual(status["ready"], True)
        self.assertEqual(status["source"], "agent")
        self.assertEqual(status["provider"], "apimart")
        self.assertEqual(status["model"], "gemini-3.1-pro-preview")
        self.assertIn("画布助手", status["hint"])

    def test_broken_agent_chat_model_is_ignored(self):
        self.write_settings({"agent_chat_model": "no-separator"})
        status = asr.asr_status()
        self.assertEqual(status["ready"], False)
        self.assertEqual(status["source"], "none")

    def test_local_command_status(self):
        with mock.patch.dict(os.environ, {"NOVAI_ASR_COMMAND": "cat {audio}"}):
            status = asr.asr_status()
        self.assertEqual(status["ready"], True)
        self.assertEqual(status["provider"], "local-command")
        self.assertEqual(status["source"], "env")


class PromptTests(_AsrTestCase):
    def test_zh_prompt_requires_no_translation_and_proper_nouns(self):
        prompt = asr._prompt_for_lang("zh")
        for word in ("不要翻译", "保留英文", "专有名词", "人名", "数字", "时间戳", "无语音"):
            self.assertIn(word, prompt)

    def test_mixed_language_uses_zh_constraints(self):
        self.assertEqual(asr._prompt_for_lang("auto"), asr._prompt_for_lang("zh"))

    def test_en_prompt_requires_no_translation_and_names(self):
        prompt = asr._prompt_for_lang("en-US")
        for word in ("Do not translate", "English words", "proper nouns", "names",
                     "Chinese names", "timestamps"):
            self.assertIn(word, prompt)

    def test_video_and_canvas_share_the_same_zh_prompt(self):
        self.assertEqual(video_sources._ASR_PROMPT, asr._prompt_for_lang("zh"))


class TranscribeSuccessTests(_AsrTestCase):
    def setUp(self):
        super().setUp()
        self.write_settings({"asr": {"provider": "test-provider", "model": "test-model"}})

    def test_request_payload_and_success_mapping(self):
        with _mock_upstream(payload=_completion("你好，夏日风格")) as upstream:
            resolver = _fake_resolver(upstream.base_url)
            with self.resolver(resolver):
                result = _run(asr.transcribe_audio(WAV_BYTES, "voice-1720000000.wav", "zh"))

        self.assertEqual(result["ok"], True, result)
        self.assertEqual(result["text"], "你好，夏日风格")
        self.assertEqual(result["provider"], "test-provider")
        self.assertEqual(result["model"], "resolved-model")
        self.assertEqual(result["source"], "user")
        self.assertEqual(len(upstream.calls), 1)
        self.assertEqual(upstream.calls[0]["path"], "/v1/chat/completions")
        self.assertEqual(upstream.calls[0]["authorization"], "Bearer fake")
        body = upstream.calls[0]["body"]
        self.assertEqual(body["model"], "resolved-model")
        self.assertIs(body["stream"], False)
        blocks = body["messages"][0]["content"]
        self.assertEqual(blocks[0]["type"], "text")
        self.assertIn("转写", blocks[0]["text"])
        self.assertIn("不要翻译", blocks[0]["text"])
        audio_block = next(item for item in blocks if item["type"] == "input_audio")
        self.assertEqual(audio_block["input_audio"]["format"], "wav")
        self.assertEqual(audio_block["input_audio"]["data"],
                         base64.b64encode(WAV_BYTES).decode())
        self.assertTrue(resolver.calls)
        self.assertEqual(resolver.calls[0]["provider"], "test-provider")
        self.assertEqual(resolver.calls[0]["model"], "test-model")

    def test_agent_fallback_reports_source_agent(self):
        self.write_settings({"agent_chat_model": "apimart::gemini-3.1-pro-preview"})
        with _mock_upstream(payload=_completion("把背景换成浅绿色")) as upstream:
            resolver = _fake_resolver(upstream.base_url)
            with self.resolver(resolver):
                result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["ok"], True, result)
        self.assertEqual(result["source"], "agent")
        self.assertEqual(result["provider"], "apimart")
        self.assertEqual(upstream.calls[0]["body"]["model"], "resolved-model")

    def test_local_command_channel(self):
        with mock.patch.dict(os.environ, {
                "NOVAI_ASR_COMMAND": "test -s {audio} && printf '本地转写结果'"}):
            result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["ok"], True, result)
        self.assertEqual(result["text"], "本地转写结果")
        self.assertEqual(result["provider"], "local-command")
        self.assertEqual(result["source"], "env")

    def test_temporary_file_is_cleaned_up(self):
        created = []

        class _SpyTemporaryDirectory(tempfile.TemporaryDirectory):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                created.append(self.name)

        with _mock_upstream(payload=_completion("好的")) as upstream:
            with self.resolver(_fake_resolver(upstream.base_url)):
                with mock.patch.object(asr.tempfile, "TemporaryDirectory", _SpyTemporaryDirectory):
                    result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["ok"], True, result)
        self.assertTrue(created)
        for path in created:
            self.assertFalse(os.path.exists(path), path)


class TranscribeErrorTests(_AsrTestCase):
    def test_not_configured(self):
        result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["ok"], False)
        self.assertEqual(result["code"], "ASR_NOT_CONFIGURED")
        self.assertIn("语音转写", result["error"])
        self.assertEqual(result["source"], "none")

    def test_empty_audio_rejected(self):
        result = _run(asr.transcribe_audio(b"", "voice.wav", "zh"))
        self.assertEqual(result["code"], "ASR_AUDIO_INVALID")

    def test_oversize_audio_rejected(self):
        result = _run(asr.transcribe_audio(b"\x00" * (asr.MAX_AUDIO_BYTES + 1), "voice.wav", "zh"))
        self.assertEqual(result["code"], "ASR_AUDIO_INVALID")
        self.assertIn("20MB", result["error"])

    def test_unsupported_extension_rejected(self):
        result = _run(asr.transcribe_audio(WAV_BYTES, "voice.txt", "zh"))
        self.assertEqual(result["code"], "ASR_AUDIO_INVALID")

    def test_http_exception_detail_is_passed_through(self):
        self.write_settings({"asr": {"provider": "test-provider", "model": "test-model"}})
        detail = "未配置 TEST 的 API Key，请在 API 平台管理中填写。"
        resolver = _fake_resolver("http://127.0.0.1:1/v1",
                                  error=HTTPException(status_code=400, detail=detail))
        with self.resolver(resolver):
            result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["ok"], False)
        self.assertEqual(result["code"], "ASR_PROVIDER_ERROR")
        self.assertEqual(result["error"], detail)

    def test_upstream_400_audio_rejection_maps_to_unsupported(self):
        self.write_settings({"asr": {"provider": "test-provider", "model": "test-model"}})
        with _mock_upstream(status=400, payload={"error": {"message": "unsupported audio format"}}) as upstream:
            with self.resolver(_fake_resolver(upstream.base_url)):
                result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["code"], "ASR_UNSUPPORTED")
        self.assertIn("不支持音频", result["error"])

    def test_upstream_400_without_audio_keyword_is_provider_error(self):
        self.write_settings({"asr": {"provider": "test-provider", "model": "test-model"}})
        with _mock_upstream(status=400, payload={"error": {"message": "bad request: missing field"}}) as upstream:
            with self.resolver(_fake_resolver(upstream.base_url)):
                result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["code"], "ASR_PROVIDER_ERROR")

    def test_upstream_500_is_provider_error(self):
        self.write_settings({"asr": {"provider": "test-provider", "model": "test-model"}})
        with _mock_upstream(status=500, payload={"error": {"message": "upstream boom"}}) as upstream:
            with self.resolver(_fake_resolver(upstream.base_url)):
                result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["code"], "ASR_PROVIDER_ERROR")
        self.assertIn("语音转写失败", result["error"])

    def test_no_speech_text_maps_to_empty(self):
        self.write_settings({"asr": {"provider": "test-provider", "model": "test-model"}})
        with _mock_upstream(payload=_completion("无语音。")) as upstream:
            with self.resolver(_fake_resolver(upstream.base_url)):
                result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["code"], "ASR_EMPTY")

    def test_local_command_failure(self):
        with mock.patch.dict(os.environ, {"NOVAI_ASR_COMMAND": "exit 3"}):
            result = _run(asr.transcribe_audio(WAV_BYTES, "voice.wav", "zh"))
        self.assertEqual(result["code"], "ASR_PROVIDER_ERROR")
        self.assertIn("退出码", result["error"])


class RouteTests(_AsrTestCase):
    def _client(self):
        return TestClient(main.app, client=("127.0.0.1", 50000))

    def test_status_endpoint_shape(self):
        response = self._client().get("/api/asr/status")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(set(payload.keys()), {"ready", "provider", "model", "source", "hint"})
        self.assertIs(payload["ready"], False)
        self.assertEqual(payload["source"], "none")

    def test_transcribe_not_configured_endpoint(self):
        response = self._client().post(
            "/api/asr/transcribe",
            files={"audio": ("voice.wav", WAV_BYTES, "audio/wav")},
            data={"lang": "zh"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertIs(payload["ok"], False)
        self.assertEqual(payload["code"], "ASR_NOT_CONFIGURED")

    def test_oversize_endpoint_returns_200_ok_false(self):
        # 契约允许 400 或 ok=false；这里固定选 200 + ok=false，前端统一按 ok 解析。
        big = b"\x00" * (asr.MAX_AUDIO_BYTES + 1)
        response = self._client().post(
            "/api/asr/transcribe",
            files={"audio": ("voice.wav", big, "audio/wav")},
            data={"lang": "zh"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertIs(payload["ok"], False)
        self.assertEqual(payload["code"], "ASR_AUDIO_INVALID")

    def test_transcribe_success_endpoint(self):
        self.write_settings({"asr": {"provider": "test-provider", "model": "test-model"}})
        with _mock_upstream(payload=_completion("现在开始吧")) as upstream:
            with self.resolver(_fake_resolver(upstream.base_url)):
                response = self._client().post(
                    "/api/asr/transcribe",
                    files={"audio": ("voice.wav", WAV_BYTES, "audio/wav")},
                    data={"lang": "zh"},
                )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertIs(payload["ok"], True)
        self.assertEqual(payload["text"], "现在开始吧")
        self.assertEqual(payload["source"], "user")
        self.assertEqual(upstream.calls[0]["body"]["messages"][0]["content"][1]["input_audio"]["format"],
                         "wav")


if __name__ == "__main__":
    unittest.main(verbosity=2)
