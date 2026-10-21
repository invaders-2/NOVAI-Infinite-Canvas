"""音频智能切分（POST /api/canvas-audio-split）：提示词约束 / JSON 提取 / 结果清洗 / 上游错误。

不联网：进程内起一个 http.server 假上游，记录 POST /v1/chat/completions 的提交体，
再 asyncio 调 main 的真实函数。用模型名控制假上游返回什么：
  * split-fenced → ``` 代码块包住的 JSON（验证去围栏）
  * split-empty  → choices[0].message.content 是空串（验证 502）
  * split-500    → 上游 500（验证 502 + 中文可读错误）
  * split-slow   → 延迟 0.6s 才返回（配合读超时 0.2s 验证 504）
  * split-messy  → 越界 / 短于 0.5s / 重叠 / 超段数（验证清洗）
  * 其它         → 正常 JSON
"""
import asyncio
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main
from fastapi import HTTPException

API_MARKER = chr(96) * 3

NORMAL_PAYLOAD = {"segments": [{"start": 0, "end": 2.5}, {"start": 2.5, "end": 6.0}], "note": "两句话"}
MESSY_PAYLOAD = {"segments": [
    {"start": -1, "end": 1.2},     # 起点越界 → 夹到 0
    {"start": 0.9, "end": 2.6},    # 与上一段重叠 → 合并成 0–2.6
    {"start": 3.0, "end": 3.2},    # 只有 0.2s → 丢弃
    {"start": 30, "end": 40},      # 完全越界 → 丢弃
    {"start": 5.0, "end": 8.0},
    {"start": 5.1, "end": 6.0},    # 重叠 → 合并成 5–8
    {"start": 10.0, "end": 11.5},
    {"start": 20.0, "end": 21.0},
    {"start": 30.0, "end": 31.0},
    {"start": 40.0, "end": 41.0},
    {"start": 50.0, "end": 51.0},
    {"start": 60.0, "end": 61.0},
    {"start": 70.0, "end": 71.0},
    {"start": 80.0, "end": 81.0},
    {"start": 90.0, "end": 91.0},
    {"start": 95.0, "end": 96.0},
], "note": "脏数据"}


def chat_payload(**kw):
    base = dict(provider_id="", model="", text="", duration_sec=12.0,
                max_segments=main.AUDIO_SPLIT_MAX_SEGMENTS, mode="smart")
    base.update(kw)
    return main.CanvasAudioSplitRequest(**base)


class _MockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _send(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        raw = self._read_body()
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            body = {"_raw": raw.decode("utf-8", "replace")}
        with self.server.log_lock:
            self.server.requests.append({"path": path, "body": body,
                                         "host": self.headers.get("Host") or ""})
        if path not in ("/v1/chat/completions", "/api/v3/chat/completions"):
            self._send(404, {"error": {"message": "no such mock route"}})
            return
        model = str(body.get("model") or "")
        if model == "split-500":
            self._send(500, {"error": {"message": "upstream boom"}})
            return
        if model == "split-slow":
            time.sleep(0.6)
        if model == "split-empty":
            content = ""
        elif model == "split-fenced":
            content = API_MARKER + "json\n" + json.dumps(NORMAL_PAYLOAD, ensure_ascii=False) + "\n" + API_MARKER
        elif model == "split-messy":
            content = json.dumps(MESSY_PAYLOAD, ensure_ascii=False)
        else:
            content = json.dumps(NORMAL_PAYLOAD, ensure_ascii=False)
        self._send(200, {
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "  " + content + "  "}}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 22},
        })


class AudioSplitPureTests(unittest.TestCase):
    """不碰网络的纯函数：时长校验 / 段数夹取 / JSON 提取 / 结果清洗 / 提示词。"""

    def test_duration_must_be_positive_finite(self):
        for value in (0, -1, "abc", None, float("inf"), float("nan")):
            with self.assertRaises(HTTPException) as ctx:
                main.audio_split_duration(value)
            self.assertEqual(ctx.exception.status_code, 400, value)
            self.assertIn("时长", ctx.exception.detail)
        self.assertEqual(main.audio_split_duration("45.2"), 45.2)
        self.assertEqual(main.audio_split_duration(3), 3.0)

    def test_max_segments_clamped(self):
        self.assertEqual(main.audio_split_max_segments(3), 3)
        self.assertEqual(main.audio_split_max_segments(0), 1)
        self.assertEqual(main.audio_split_max_segments(99), 12)
        self.assertEqual(main.audio_split_max_segments("abc"), 12)
        self.assertEqual(main.AUDIO_SPLIT_MAX_SEGMENTS, 12)
        self.assertEqual(main.AUDIO_SPLIT_MIN_SEC, 0.5)

    def test_mode_normalized(self):
        self.assertEqual(main.audio_split_mode("CUSTOM"), "custom")
        self.assertEqual(main.audio_split_mode("smart"), "smart")
        self.assertEqual(main.audio_split_mode("whatever"), "smart")

    def test_extract_json_handles_code_fence_and_noise(self):
        payload = {"segments": [{"start": 0, "end": 1}], "note": "a"}
        # 1) 纯 JSON
        self.assertEqual(main.audio_split_extract_json(json.dumps(payload)), payload)
        # 2) ```json 围栏 + 前后说明文字
        fenced = "说明文字\n" + API_MARKER + "json\n" + json.dumps(payload) + "\n" + API_MARKER + "\n结束"
        self.assertEqual(main.audio_split_extract_json(fenced), payload)
        # 3) 没有语言标识的围栏
        bare = API_MARKER + "\n" + json.dumps(payload) + "\n" + API_MARKER
        self.assertEqual(main.audio_split_extract_json(bare), payload)
        # 4) 取第一个 { 到最后一个 }（前后夹带普通文字不影响）
        noisy = "前缀说明 " + json.dumps(payload) + " 尾巴"
        self.assertEqual(main.audio_split_extract_json(noisy), payload)
        # 已知限制：正文里先出现别的一对花括号时会从那里开始截，解析失败即返回 None（由调用方报错）
        self.assertIsNone(main.audio_split_extract_json("前缀 {不是 JSON} " + json.dumps(payload)))
        # 5) 非 JSON / 空 / 没有花括号 → None
        for value in ("", "   ", "抱歉我不能", "[1, 2, 3]", "{bad json}"):
            self.assertIsNone(main.audio_split_extract_json(value), value)

    def test_clean_clamps_out_of_range(self):
        self.assertEqual(
            main.audio_split_clean_segments([{"start": -5, "end": 2}, {"start": 3, "end": 99}], 10.0, 12),
            [{"start": 0.0, "end": 2.0}, {"start": 3.0, "end": 10.0}],
        )

    def test_clean_drops_short_segments(self):
        self.assertEqual(
            main.audio_split_clean_segments([{"start": 0, "end": 0.49}, {"start": 2, "end": 2.5}], 10.0, 12),
            [{"start": 2.0, "end": 2.5}],
        )

    def test_clean_sorts_and_merges_overlaps(self):
        self.assertEqual(
            main.audio_split_clean_segments([
                {"start": 6, "end": 8}, {"start": 0, "end": 3}, {"start": 2, "end": 4.5},
            ], 10.0, 12),
            [{"start": 0.0, "end": 4.5}, {"start": 6.0, "end": 8.0}],
        )
        # 首尾相接（不重叠）不合并
        self.assertEqual(
            main.audio_split_clean_segments([{"start": 0, "end": 2}, {"start": 2, "end": 4}], 10.0, 12),
            [{"start": 0.0, "end": 2.0}, {"start": 2.0, "end": 4.0}],
        )

    def test_clean_caps_segment_count(self):
        entries = [{"start": float(i * 3), "end": float(i * 3 + 2)} for i in range(9)]
        segments = main.audio_split_clean_segments(entries, 40.0, 12)
        self.assertEqual(len(segments), 9, "9 段没超上限，原样保留")
        segments = main.audio_split_clean_segments(entries, 40.0, 4)
        self.assertEqual(len(segments), 4)
        self.assertEqual(segments[0], {"start": 0.0, "end": 2.0})
        many = [{"start": float(i * 2), "end": float(i * 2 + 1.5)} for i in range(20)]
        self.assertEqual(len(main.audio_split_clean_segments(many, 60.0, 99)), 12, "最多 12 段")

    def test_clean_ignores_garbage_entries(self):
        self.assertEqual(main.audio_split_clean_segments([None, "x", {}, {"start": "a", "end": 1},
                                                          {"start": 1, "end": 2}], 10.0, 12),
                         [{"start": 1.0, "end": 2.0}])

    def test_parse_rejects_bad_structure(self):
        for content in ("", "抱歉", "{\"foo\": 1}", "{\"segments\": \"x\"}",
                        "{\"segments\": [{\"start\": 5, \"end\": 5.1}]}"):
            with self.assertRaises(HTTPException) as ctx:
                main.audio_split_parse_segments(content, 10.0, 12)
            self.assertEqual(ctx.exception.status_code, 502, content)
            self.assertTrue(ctx.exception.detail)
            self.assertTrue(any("\u4e00" <= ch <= "\u9fff" for ch in ctx.exception.detail),
                            "错误信息必须是可读中文：%r" % ctx.exception.detail)

    def test_parse_returns_segments_and_note(self):
        segments, note = main.audio_split_parse_segments(
            json.dumps({"segments": [{"start": 1, "end": 3}], "note": "两句"}), 10.0, 12)
        self.assertEqual(segments, [{"start": 1.0, "end": 3.0}])
        self.assertEqual(note, "两句")
        segments, note = main.audio_split_parse_segments(json.dumps({"segments": [{"start": 1, "end": 3}]}), 10.0, 12)
        self.assertEqual(note, "")

    def test_system_prompt_hard_constraints(self):
        prompt = main.audio_split_system_prompt("smart", 45.2, 12)
        self.assertIn("45.20", prompt)
        self.assertIn("0.5", prompt)
        self.assertIn("12", prompt)
        self.assertIn("segments", prompt)
        self.assertIn("JSON", prompt)
        self.assertIn("不能重叠", prompt)
        self.assertIn("从小到大", prompt)
        self.assertIn("按语义", prompt)
        self.assertNotIn("用户指令", prompt)

    def test_custom_prompt_carries_instruction_verbatim(self):
        prompt = main.audio_split_system_prompt("custom", 30.0, 6, "删除10-15秒，再在第20秒切开")
        self.assertIn("删除10-15秒，再在第20秒切开", prompt)
        self.assertIn("用户指令", prompt)
        user = main.audio_split_user_text("custom", 30.0, 6, "删除10-15秒")
        self.assertIn("删除10-15秒", user)
        self.assertIn("30.00", user)
        # 自定义模式没给指令时也要有可执行的自然语义默认要求
        self.assertIn("按自然语义", main.audio_split_system_prompt("custom", 30.0, 6, ""))

    def test_chat_body_always_disables_streaming(self):
        body = main.audio_split_chat_body("gemini-3.1-flash-lite-preview", "sys", "user")
        self.assertIs(body["stream"], False, "APIMart 默认流式，必须显式 stream:false")
        self.assertEqual(body["model"], "gemini-3.1-flash-lite-preview")
        self.assertEqual([item["role"] for item in body["messages"]], ["system", "user"])
        self.assertEqual(body["messages"][0]["content"], "sys")
        self.assertEqual(body["messages"][1]["content"], "user")

    def test_chat_url_keeps_platform_version_segment(self):
        # APIMart 没有版本段 → 补 /v1
        self.assertEqual(main.audio_split_chat_url("https://api.apimart.ai"), "https://api.apimart.ai/v1/chat/completions")
        # 结尾斜杠先去掉，再判断版本段
        self.assertEqual(main.audio_split_chat_url("https://api.apimart.ai/"), "https://api.apimart.ai/v1/chat/completions")
        # 已经带 /v1 的不再重复补
        self.assertEqual(main.audio_split_chat_url("https://api.apimart.ai/v1"), "https://api.apimart.ai/v1/chat/completions")
        # 火山引擎 /api/v3：以前会被拼成 /api/v3/v1/... 导致上游 404（真机回归发现）
        self.assertEqual(main.audio_split_chat_url("https://ark.cn-beijing.volces.com/api/v3"),
                         "https://ark.cn-beijing.volces.com/api/v3/chat/completions")
        # Agnes / ModelScope 这类 /v1
        self.assertEqual(main.audio_split_chat_url("https://apihub.agnes-ai.com/v1"),
                         "https://apihub.agnes-ai.com/v1/chat/completions")
        # 其它版本段写法
        self.assertEqual(main.audio_split_chat_url("https://x.example.com/v1beta"), "https://x.example.com/v1beta/chat/completions")
        self.assertEqual(main.audio_split_chat_url("https://x.example.com/openai/v1"), "https://x.example.com/openai/v1/chat/completions")
        self.assertEqual(main.audio_split_chat_url("https://x.example.com/api/v1"), "https://x.example.com/api/v1/chat/completions")
        self.assertEqual(main.audio_split_chat_url("https://x.example.com/v4"), "https://x.example.com/v4/chat/completions")
        # 已经是完整地址：原样返回（不重复拼）
        self.assertEqual(main.audio_split_chat_url("https://x.example.com/v1/chat/completions"),
                         "https://x.example.com/v1/chat/completions")
        self.assertEqual(main.audio_split_chat_url(""), "")

    def test_provider_resolution_prefers_apimart_with_chat_models(self):
        providers = [
            {"id": "openai", "name": "OpenAI", "enabled": True, "chat_models": ["gpt-4o-mini"]},
            {"id": "apimart", "name": "APIMart", "enabled": True, "protocol": "apimart",
             "chat_models": ["gemini-3.1-flash-lite-preview", "gpt-4o-mini"]},
            {"id": "empty", "name": "No Chat", "enabled": True, "chat_models": []},
        ]
        provider, model = main.audio_split_resolve_provider(providers)
        self.assertEqual(provider["id"], "apimart")
        self.assertEqual(model, "gemini-3.1-flash-lite-preview")
        # 没有 apimart 时用第一个有 chat_models 的平台
        provider, model = main.audio_split_resolve_provider([providers[0], providers[2]])
        self.assertEqual((provider["id"], model), ("openai", "gpt-4o-mini"))
        # 显式平台 + 显式模型原样使用
        provider, model = main.audio_split_resolve_provider(providers, "openai", "gpt-4.1-mini")
        self.assertEqual((provider["id"], model), ("openai", "gpt-4.1-mini"))
        # 显式平台没给模型 → 该平台第一个对话模型
        provider, model = main.audio_split_resolve_provider(providers, "apimart", "")
        self.assertEqual(model, "gemini-3.1-flash-lite-preview")

    def test_default_model_prefers_cheap_fast_models(self):
        """真机回归：apimart 的 chat_models 第一个是 claude-fable-5（贵、慢），
        切分这种小任务要先按偏好顺序挑便宜快的模型，都没有才退回第一个。"""
        self.assertEqual(main.AUDIO_SPLIT_PREFERRED_MODELS[0], "gemini-3.1-flash-lite-preview")

        def providers_with(models):
            return [{"id": "apimart", "name": "APIMart", "protocol": "apimart",
                     "enabled": True, "chat_models": list(models)}]

        # 同时有 claude 和 gemini → 选 gemini（不受列表顺序影响）
        self.assertEqual(
            main.audio_split_resolve_provider(providers_with(["claude-fable-5", "gemini-3.1-flash-lite-preview"]))[1],
            "gemini-3.1-flash-lite-preview",
        )
        # 只有 claude → 退回它（不能因为没有偏好模型就报错）
        self.assertEqual(main.audio_split_resolve_provider(providers_with(["claude-fable-5"]))[1], "claude-fable-5")
        # 只有 gpt-4o-mini → 选它
        self.assertEqual(main.audio_split_resolve_provider(providers_with(["gpt-4o-mini"]))[1], "gpt-4o-mini")
        # 偏好顺序：gpt-4o-mini 排在 gemini-3.5-flash-lite 前面
        self.assertEqual(
            main.audio_split_resolve_provider(providers_with(["claude-fable-5", "gemini-3.5-flash-lite", "gpt-4o-mini"]))[1],
            "gpt-4o-mini",
        )
        # 显式 model 永远优先，不受偏好顺序影响
        self.assertEqual(
            main.audio_split_resolve_provider(providers_with(["claude-fable-5", "gemini-3.1-flash-lite-preview"]),
                                              "", "claude-fable-5")[1],
            "claude-fable-5",
        )
        # 空 chat_models → 保持既有行为：400 + 可读中文（不静默换模型、不静默成功）
        with self.assertRaises(HTTPException) as ctx:
            main.audio_split_resolve_provider(providers_with([]))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertTrue(any("\u4e00" <= ch <= "\u9fff" for ch in ctx.exception.detail),
                        "错误信息必须是可读中文：%r" % ctx.exception.detail)

    def test_provider_resolution_rejects_missing_disabled_and_chatless(self):
        providers = [
            {"id": "apimart", "name": "APIMart", "enabled": True, "protocol": "apimart", "chat_models": ["m1"]},
            {"id": "off", "name": "Disabled", "enabled": False, "chat_models": ["m2"]},
            {"id": "nochat", "name": "No Chat", "enabled": True, "chat_models": []},
        ]
        for args in (("missing", ""), ("off", ""), ("nochat", "")):
            with self.assertRaises(HTTPException) as ctx:
                main.audio_split_resolve_provider(providers, *args)
            self.assertEqual(ctx.exception.status_code, 400, args)
        with self.assertRaises(HTTPException) as ctx:
            main.audio_split_resolve_provider([], "", "")
        self.assertEqual(ctx.exception.status_code, 400)


class AudioSplitUpstreamTests(unittest.TestCase):
    """真跑 generate_canvas_audio_split：提交体 / provider 解析 / 上游错误 / 超时 / 清洗。"""

    provider_id = "apimart-split-mock"
    openai_provider_id = "openai-split-mock"
    volcengine_provider_id = "volcengine-split-mock"

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _MockHandler)
        cls.server.requests = []
        cls.server.log_lock = threading.Lock()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address[:2]
        cls.base = "http://%s:%s" % (host, port)

        cls.tmp = tempfile.mkdtemp(prefix="novai-audio-split-")
        provider_file = os.path.join(cls.tmp, "api_providers.json")
        with open(provider_file, "w", encoding="utf-8") as f:
            json.dump([
                {
                    "id": cls.openai_provider_id,
                    "name": "OpenAI Compatible",
                    "base_url": cls.base,
                    "protocol": "openai",
                    "enabled": True,
                    "use_proxy": "off",
                    "chat_models": ["gpt-4o-mini"],
                },
                {
                    "id": cls.provider_id,
                    "name": "Mock APIMart",
                    "base_url": cls.base,
                    "protocol": "apimart",
                    "enabled": True,
                    "use_proxy": "off",
                    # 故意的顺序：claude 排第一，验证缺省模型按偏好顺序而不是列表首位
                    "chat_models": ["claude-fable-5", "gemini-3.1-flash-lite-preview", "gpt-4o-mini"],
                },
                {
                    # 火山引擎那种 base 自带 /api/v3 的平台（真机回归里被拼成 /api/v3/v1/... 而 404）
                    "id": cls.volcengine_provider_id,
                    "name": "Mock Volcengine",
                    "base_url": cls.base + "/api/v3",
                    "protocol": "volcengine",
                    "enabled": True,
                    "use_proxy": "off",
                    "chat_models": ["deepseek-v4-1-flash-260910"],
                },
            ], f)

        cls.saved = {"API_PROVIDERS_FILE": main.API_PROVIDERS_FILE}
        main.API_PROVIDERS_FILE = provider_file
        os.environ[main.provider_key_env(cls.provider_id)] = "sk-mock-split"
        os.environ[main.provider_key_env(cls.openai_provider_id)] = "sk-mock-split-openai"
        os.environ[main.provider_key_env(cls.volcengine_provider_id)] = "sk-mock-split-volcengine"

    @classmethod
    def tearDownClass(cls):
        for key, value in cls.saved.items():
            setattr(main, key, value)
        os.environ.pop(main.provider_key_env(cls.provider_id), None)
        os.environ.pop(main.provider_key_env(cls.openai_provider_id), None)
        os.environ.pop(main.provider_key_env(cls.volcengine_provider_id), None)
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        with self.server.log_lock:
            self.server.requests.clear()
        self._read_timeout = main.AUDIO_SPLIT_READ_TIMEOUT

    def tearDown(self):
        main.AUDIO_SPLIT_READ_TIMEOUT = self._read_timeout

    def requests(self):
        with self.server.log_lock:
            return list(self.server.requests)

    def generate(self, **kw):
        return asyncio.run(main.generate_canvas_audio_split(chat_payload(**kw)))

    def test_request_path_body_and_stream_false(self):
        result = self.generate()
        posts = [item for item in self.requests() if item["path"] == "/v1/chat/completions"]
        self.assertEqual(len(posts), 1, self.requests())
        body = posts[0]["body"]
        self.assertIs(body["stream"], False, "必须显式 stream:false（APIMart 默认流式）")
        self.assertEqual(body["model"], "gemini-3.1-flash-lite-preview", "apimart 的模型优先且取第一个")
        self.assertEqual(posts[0]["host"], self.base.split("://", 1)[1])
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user"])
        self.assertIn("12.00", body["messages"][0]["content"])
        self.assertEqual(result["source"], "llm")
        self.assertEqual(result["provider"], self.provider_id)
        self.assertEqual(result["model"], "gemini-3.1-flash-lite-preview")
        self.assertEqual(result["segments"], NORMAL_PAYLOAD["segments"])
        self.assertEqual(result["note"], NORMAL_PAYLOAD["note"])
        self.assertEqual(result["usage"], {"prompt_tokens": 11, "completion_tokens": 22})

    def test_explicit_provider_and_model_is_honored(self):
        result = self.generate(provider_id=self.openai_provider_id, model="gpt-4.1-mini")
        posts = [item for item in self.requests() if item["path"] == "/v1/chat/completions"]
        self.assertEqual(posts[0]["body"]["model"], "gpt-4.1-mini")
        self.assertEqual(result["provider"], self.openai_provider_id)
        self.assertEqual(result["model"], "gpt-4.1-mini")

    def test_platform_base_with_version_segment_keeps_its_own_path(self):
        """真机回归：火山引擎 base 带 /api/v3，不能被拼成 /api/v3/v1/chat/completions。"""
        result = self.generate(provider_id=self.volcengine_provider_id,
                               model="deepseek-v4-1-flash-260910")
        posts = self.requests()
        self.assertEqual(len(posts), 1, posts)
        self.assertEqual(posts[0]["path"], "/api/v3/chat/completions")
        self.assertEqual(posts[0]["body"]["model"], "deepseek-v4-1-flash-260910")
        self.assertEqual(result["source"], "llm")
        self.assertEqual(result["provider"], self.volcengine_provider_id)
        self.assertEqual(result["segments"], NORMAL_PAYLOAD["segments"])

    def test_missing_provider_returns_400_without_calling_upstream(self):
        with self.assertRaises(HTTPException) as ctx:
            self.generate(provider_id="nope")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("未找到 API 平台", ctx.exception.detail)
        self.assertEqual(self.requests(), [])

    def test_invalid_duration_returns_400(self):
        # 非数字（如 "abc"）会被 pydantic 先挡成 422；这里覆盖能进到处理函数里的非法数值
        for value in (0, -3, 0.0):
            with self.assertRaises(HTTPException) as ctx:
                self.generate(duration_sec=value)
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("时长", ctx.exception.detail)
        self.assertEqual(self.requests(), [])

    def test_custom_mode_instruction_reaches_upstream(self):
        self.generate(mode="custom", text="删除10-15秒，保留开头两句", max_segments=5)
        body = self.requests()[0]["body"]
        self.assertIn("删除10-15秒，保留开头两句", body["messages"][0]["content"])
        self.assertIn("删除10-15秒，保留开头两句", body["messages"][1]["content"])
        self.assertIn("最多 5 段", body["messages"][1]["content"])

    def test_code_fenced_json_is_extracted(self):
        result = self.generate(model="split-fenced")
        self.assertEqual(result["segments"], NORMAL_PAYLOAD["segments"])

    def test_messy_model_output_is_cleaned(self):
        result = self.generate(model="split-messy", duration_sec=100.0, max_segments=12)
        segments = result["segments"]
        self.assertLessEqual(len(segments), 12, "最多 12 段")
        self.assertEqual(segments[0], {"start": 0.0, "end": 2.6}, "越界夹取 + 重叠合并")
        self.assertEqual(segments[1], {"start": 5.0, "end": 8.0}, "重叠合并")
        for segment in segments:
            self.assertGreaterEqual(segment["start"], 0)
            self.assertLessEqual(segment["end"], 100.0)
            self.assertGreaterEqual(segment["end"] - segment["start"], 0.5)
        starts = [segment["start"] for segment in segments]
        self.assertEqual(starts, sorted(starts), "按开始时间升序")
        for previous, current in zip(segments, segments[1:]):
            self.assertLessEqual(previous["end"], current["start"] + 1e-9, "不重叠")

    def test_empty_content_returns_502(self):
        with self.assertRaises(HTTPException) as ctx:
            self.generate(model="split-empty")
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("空内容", ctx.exception.detail)

    def test_upstream_500_returns_502_with_readable_chinese(self):
        with self.assertRaises(HTTPException) as ctx:
            self.generate(model="split-500")
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("智能切分失败", ctx.exception.detail)
        self.assertIn("500", ctx.exception.detail)
        self.assertIn("upstream boom", ctx.exception.detail)
        self.assertTrue(any("\u4e00" <= ch <= "\u9fff" for ch in ctx.exception.detail))

    def test_read_timeout_returns_504(self):
        main.AUDIO_SPLIT_READ_TIMEOUT = 0.2
        with self.assertRaises(HTTPException) as ctx:
            self.generate(model="split-slow")
        self.assertEqual(ctx.exception.status_code, 504)
        self.assertIn("超时", ctx.exception.detail)


if __name__ == "__main__":
    unittest.main(verbosity=2)
