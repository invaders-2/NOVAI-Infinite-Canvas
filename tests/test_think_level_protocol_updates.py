#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""思考强度透传（think_level）映射 + 供应商协议更新接口。

跑法：
    venv/bin/python -m unittest tests.test_think_level_protocol_updates -v

覆盖：
  1. 映射函数：OpenAI 兼容 / APIMart 的 reasoning_effort，Anthropic 请求体的 thinking 预算，
     Gemini native 与 CLI 协议不发字段，空值/非法值不发字段，非推理模型不发字段；
  2. 真值源：显式表 documented、族规则 inferred、显式否定与未知模型；
  3. 上游 400 疑似拒绝推理参数时的降级判断 + 去字段重试体；
  4. GET /api/providers/protocol-updates 的返回结构（有更新 / 无更新都 200）；
  5. POST /api/providers/protocol-update/apply：增量合并、保留用户顺序与自定义名、幂等、
     版本落盘、PUT 保存不丢版本、成员模式可见性与 403、未知平台 400。
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-think-protocol-test-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.protocols import protocol_updates as protocol_updates  # noqa: E402
from server.protocols import thinking  # noqa: E402

UPDATES_FILE = _ROOT / "server" / "protocols" / "protocol_updates.json"


def fresh_client() -> TestClient:
    # 不传 client/follow_redirects：这两个参数在新旧 starlette 上名字不同，本文件的用例都不依赖它们。
    return TestClient(main.app)


def apimart_provider(**overrides) -> dict:
    provider = {
        "id": "apimart",
        "name": "我的 APIMart（自定义名）",
        "base_url": "https://api.apimart.ai",
        "protocol": "apimart",
        "image_request_mode": "openai",
        "enabled": True,
        "primary": True,
        "image_model": "",
        "image_models": ["用户已有图片模型"],
        "chat_models": ["gpt-5.5", "gpt-4o-mini", "gemini-3-pro-preview-thinking"],
        "video_models": ["用户已有视频模型"],
        "audio_models": [],
        "model_names": {"用户已有图片模型": "我的自定义名"},
        "model_protocols": {},
        "ms_loras": [],
        "ms_defaults_version": 0,
        "rh_apps": [],
        "rh_workflows": [],
        "volcengine_project_name": "",
        "volcengine_region": "",
        "lovart_auto_confirm": False,
        "lovart_project_id": "",
        "lovart_unlimited": False,
        "max_concurrency": 0,
        "use_proxy": "auto",
        "protocol_version": 0,
    }
    provider.update(overrides)
    return provider


class ThinkMappingTests(unittest.TestCase):
    """集中映射函数：按厂商文档 + APIMart 实测裁剪档位与 wire 映射。"""

    def _fields(self, model, level, protocol="apimart", body="openai"):
        return thinking.think_request_fields(protocol, model, level, body_style=body)

    def test_openai_levels_are_trimmed_per_model(self):
        five = list(thinking.THINK_LEVELS)
        four = ["low", "mid", "high", "xhigh"]
        pro = ["mid", "high", "xhigh"]
        self.assertEqual(thinking.think_levels_for_model("gpt-6.1-terra"), five)
        self.assertEqual(thinking.think_levels_for_model("gpt-5.6-luna"), five)
        self.assertEqual(thinking.think_levels_for_model("gpt-6-astra"), five)
        # gpt-5.5 上游只到 xhigh，不能再给 max（点 Max 会 400 再降级）
        self.assertEqual(thinking.think_levels_for_model("gpt-5.5"), four)
        self.assertEqual(thinking.think_levels_for_model("gpt-5.2"), four)
        self.assertEqual(thinking.think_levels_for_model("gpt-5.4-mini"), four)
        self.assertEqual(thinking.think_levels_for_model("gpt-5.4-pro"), pro)
        self.assertEqual(thinking.think_levels_for_model("gpt-5.5-pro"), pro)
        self.assertEqual(thinking.think_levels_for_model("gpt-5.2-codex"), pro)
        # 老 ID：保守 4 档
        self.assertEqual(thinking.think_levels_for_model("gpt-5"), four)
        self.assertEqual(thinking.think_levels_for_model("gpt-5.1"), four)
        self.assertEqual(thinking.think_levels_for_model("gpt-5-chat-latest"), four)
        self.assertIsNone(thinking.think_levels_for_model("gpt-4o-mini"))
        self.assertIsNone(thinking.think_levels_for_model("gpt-5.2-pro"))   # Responses API only

    def test_openai_wire_mapping(self):
        self.assertEqual(self._fields("gpt-6.1-terra", "max"), {"reasoning_effort": "max"})
        self.assertEqual(self._fields("gpt-6.1-terra", "mid"), {"reasoning_effort": "medium"})
        self.assertEqual(self._fields("gpt-5.5", "xhigh"), {"reasoning_effort": "xhigh"})
        # gpt-5.5 不支持 max：先收敛到 xhigh，再发 xhigh（不会发 max 撞 400）
        self.assertEqual(self._fields("gpt-5.5", "max"), {"reasoning_effort": "xhigh"})
        self.assertEqual(self._fields("gpt-5.4-pro", "mid"), {"reasoning_effort": "medium"})
        self.assertEqual(self._fields("gpt-5.4-pro", "low"), {"reasoning_effort": "medium"})  # 收敛到 mid
        # 老 ID 沿用保守 wire：low→minimal / mid→low / high→medium / xhigh→high
        self.assertEqual(self._fields("gpt-5", "low"), {"reasoning_effort": "minimal"})
        self.assertEqual(self._fields("gpt-5", "mid"), {"reasoning_effort": "low"})
        self.assertEqual(self._fields("gpt-5", "high"), {"reasoning_effort": "medium"})
        self.assertEqual(self._fields("gpt-5", "xhigh"), {"reasoning_effort": "high"})

    def test_gemini_family_levels_and_wire(self):
        three = ["low", "mid", "high"]
        self.assertEqual(thinking.think_levels_for_model("gemini-3-pro-preview"), ["low", "high"])
        self.assertEqual(thinking.think_levels_for_model("gemini-3-pro-preview-thinking"), ["low", "high"])
        self.assertEqual(thinking.think_levels_for_model("gemini-3.1-pro-preview"), three)
        self.assertEqual(thinking.think_levels_for_model("gemini-4-argon"), three)
        self.assertEqual(thinking.think_levels_for_model("gemini-3-flash-preview"), three)
        self.assertEqual(thinking.think_levels_for_model("gemini-3.6-flash"), three)
        self.assertEqual(thinking.think_levels_for_model("gemini-2.5-flash-lite"), three)
        self.assertIsNone(thinking.think_levels_for_model("gemini-3-flash-preview-nothinking"))
        self.assertEqual(self._fields("gemini-3.1-pro-preview", "mid"), {"reasoning_effort": "medium"})
        self.assertEqual(self._fields("gemini-3-pro-preview", "high"), {"reasoning_effort": "high"})
        # xhigh/max 收敛到 high（上游没有这两档）
        self.assertEqual(self._fields("gemini-3-pro-preview", "xhigh"), {"reasoning_effort": "high"})
        self.assertEqual(self._fields("gemini-3.1-pro-preview", "max"), {"reasoning_effort": "high"})

    def test_deepseek_v4_family(self):
        self.assertEqual(thinking.think_levels_for_model("deepseek-v4-pro"), ["low", "high", "max"])
        self.assertEqual(thinking.think_levels_for_model("deepseek-v4-flash"), ["low", "high", "max"])
        self.assertEqual(self._fields("deepseek-v4-pro", "max"), {"reasoning_effort": "max"})
        self.assertEqual(self._fields("deepseek-v4-pro", "high"), {"reasoning_effort": "high"})
        self.assertIsNone(thinking.think_levels_for_model("deepseek-r1-250528"))
        self.assertEqual(self._fields("deepseek-r1-250528", "low"), {})

    def test_qwen38_family(self):
        self.assertEqual(thinking.think_levels_for_model("qwen3.8-max"), ["low", "mid", "high"])
        self.assertEqual(self._fields("qwen3.8-max", "low"), {"reasoning_effort": "low"})
        self.assertEqual(self._fields("qwen3.8-max", "mid"), {"reasoning_effort": "medium"})
        # canonical high -> wire xhigh（qwen 只有 low/medium/xhigh）
        self.assertEqual(self._fields("qwen3.8-max", "high"), {"reasoning_effort": "xhigh"})
        self.assertIsNone(thinking.think_levels_for_model("qwen3.7-max"))
        self.assertEqual(self._fields("qwen3.7-max", "high"), {})

    def test_kimi_k3_family(self):
        self.assertEqual(thinking.think_levels_for_model("kimi-k3"), ["low", "high", "max"])
        self.assertEqual(thinking.think_levels_for_model("kimi-k3.1-pro"), ["low", "high", "max"])
        self.assertEqual(self._fields("kimi-k3", "max"), {"reasoning_effort": "max"})
        self.assertIsNone(thinking.think_levels_for_model("kimi-k2-thinking"))
        self.assertEqual(self._fields("kimi-k2-thinking", "high"), {})

    def test_glm_family(self):
        self.assertEqual(thinking.think_levels_for_model("glm-5.2"), list(thinking.THINK_LEVELS))
        self.assertEqual(thinking.think_levels_for_model("glm-5.3"), ["low", "high", "max"])
        self.assertEqual(thinking.think_levels_for_model("glm-5.3-flash"), ["low", "high", "max"])
        self.assertEqual(self._fields("glm-5.2", "mid"), {"reasoning_effort": "medium"})
        self.assertEqual(self._fields("glm-5.2", "max"), {"reasoning_effort": "max"})
        self.assertEqual(self._fields("glm-5.3", "high"), {"reasoning_effort": "high"})
        self.assertIsNone(thinking.think_levels_for_model("glm-4.6"))
        self.assertEqual(self._fields("glm-4.6", "high"), {})

    def test_claude_still_has_no_entry(self):
        # 兼容层 reasoning_effort=Ignored、APIMart 实测 400；thinking 对象在 chat 兼容层无生效证据
        self.assertIsNone(thinking.think_levels_for_model("claude-sonnet-4-6"))
        self.assertEqual(self._fields("claude-sonnet-4-6", "high"), {})
        # 只有将来走 Anthropic 原生 /v1/messages 时才用 thinking budget
        fields = thinking.think_request_fields("apimart", "claude-sonnet-4-6", "high", body_style="anthropic")
        self.assertEqual(fields, {"thinking": {"type": "enabled", "budget_tokens": 8192}})

    def test_anthropic_budget_monotonic(self):
        budgets = {level: thinking.think_request_fields("apimart", "claude-fable-5", level,
                                                        body_style="anthropic")["thinking"]["budget_tokens"]
                   for level in thinking.THINK_LEVELS}
        self.assertEqual(list(budgets.values()), sorted(budgets.values()))
        self.assertGreaterEqual(budgets["low"], 1024)
        self.assertEqual(budgets["max"], 32768)

    def test_gemini_native_sends_nothing(self):
        # Gemini 原生 generateContent 没有 thinkingConfig -> 不发。
        self.assertEqual(self._fields("gemini-3-pro-preview-thinking", "high", body="gemini"), {})

    def test_cli_protocols_send_nothing(self):
        for protocol in ("codex", "gemini-cli", "lovart", "runninghub", "jimeng"):
            self.assertEqual(self._fields("gpt-6.1-terra", "max", protocol=protocol), {}, protocol)

    def test_empty_and_illegal_level_send_nothing(self):
        for level in ("", None, "  ", "ultra", "HIGHEST", 5, True):
            self.assertEqual(self._fields("gpt-6.1-terra", level), {}, repr(level))
        self.assertEqual(thinking.normalize_think_level(" HIGH "), "high")
        self.assertEqual(thinking.normalize_think_level("medium"), "")

    def test_unknown_model_sends_nothing(self):
        self.assertEqual(self._fields("some-random-model", "high"), {})
        self.assertIsNone(thinking.think_levels_for_model("some-random-model"))

    def test_truth_source_evidence(self):
        self.assertEqual(thinking.think_model_evidence("gpt-6.1-terra"),
                         {"capability": "documented", "levels": "documented"})
        self.assertEqual(thinking.think_model_evidence("gpt-5"),
                         {"capability": "inferred", "levels": "inferred"})
        self.assertEqual(thinking.think_model_evidence("gemini-3-pro-preview"),
                         {"capability": "documented", "levels": "documented"})
        self.assertEqual(thinking.think_model_evidence("qwen3.8-max"),
                         {"capability": "documented", "levels": "documented"})
        self.assertEqual(thinking.think_model_evidence("claude-sonnet-4-6"),
                         {"capability": "documented", "levels": ""})
        self.assertEqual(thinking.think_model_evidence("gpt-4o-mini"), {"capability": "", "levels": ""})
        self.assertEqual(main.think_levels_for_model("gpt-5.5"),
                         ["low", "mid", "high", "xhigh"])

    def test_reject_detection_and_strip(self) -> None:
        self.assertTrue(thinking.think_fields_rejected(400, '{"error":"unknown parameter: reasoning_effort"}'))
        self.assertTrue(thinking.think_fields_rejected(400, "Unsupported parameter: thinking"))
        self.assertFalse(thinking.think_fields_rejected(400, "invalid model name"))
        self.assertFalse(thinking.think_fields_rejected(500, "reasoning_effort boom"))
        body = {"model": "gpt-5.5", "reasoning_effort": "high", "messages": []}
        self.assertEqual(thinking.strip_think_fields(body, {"reasoning_effort": "high"}),
                         {"model": "gpt-5.5", "messages": []})


class ProtocolUpdatesTests(unittest.TestCase):
    """协议更新接口：结构、增量合并、幂等、落盘、成员模式。"""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="novai-protocol-apply-")
        self.providers_file = os.path.join(self.tmpdir, "api_providers.json")
        self._orig_providers_file = main.API_PROVIDERS_FILE
        main.API_PROVIDERS_FILE = self.providers_file
        self.addCleanup(self._restore)
        main.save_api_providers([apimart_provider()])
        protocol_updates.load_protocol_updates(force=True)

    def _restore(self) -> None:
        main.API_PROVIDERS_FILE = self._orig_providers_file
        protocol_updates.load_protocol_updates(force=True)
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _stored(self) -> dict:
        with open(self.providers_file, "r", encoding="utf-8") as handle:
            return json.load(handle)[0]

    def _updates_payload(self) -> dict:
        with open(UPDATES_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def test_get_structure(self) -> None:
        client = fresh_client()
        response = client.get("/api/providers/protocol-updates")
        self.assertEqual(response.status_code, 200)
        items = response.json()["items"]
        self.assertEqual(len(items), 1)
        item = items[0]
        self.assertEqual(item["provider_id"], "apimart")
        for key in ("provider_id", "name", "current_version", "latest_version", "available",
                    "new_models", "protocol_changes", "summary", "docs_url", "released_at"):
            self.assertIn(key, item)
        self.assertEqual(item["current_version"], 0)
        self.assertTrue(item["available"])
        self.assertEqual(set(item["new_models"]), {"chat", "image", "video", "audio"})
        self.assertTrue(item["protocol_changes"])
        changes = self._updates_payload()["updates"][0]
        self.assertEqual(item["new_models"]["image"], changes["new_models"]["image"])

    def test_config_model_caps_think(self) -> None:
        data = fresh_client().get("/api/config").json()
        provider = next(item for item in data["api_providers"] if item["id"] == "apimart")
        caps = provider.get("model_caps") or {}
        # 按厂商文档按模型裁剪：gpt-5.5 只到 xhigh（没有 max）
        self.assertEqual(caps["gpt-5.5"]["think"], ["low", "mid", "high", "xhigh"])
        self.assertEqual(caps["gemini-3-pro-preview-thinking"]["think"], ["low", "high"])
        self.assertNotIn("gpt-4o-mini", caps)   # 文档没写支持思考 -> 不下发该字段

    def test_get_returns_empty_items_when_no_updates(self) -> None:
        broken = os.path.join(self.tmpdir, "broken.json")
        with open(broken, "w", encoding="utf-8") as handle:
            handle.write("{ not json")
        original = protocol_updates.PROTOCOL_UPDATES_FILE
        protocol_updates.PROTOCOL_UPDATES_FILE = broken
        self.addCleanup(setattr, protocol_updates, "PROTOCOL_UPDATES_FILE", original)
        protocol_updates.load_protocol_updates(force=True)
        response = fresh_client().get("/api/providers/protocol-updates")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"items": []})
        protocol_updates.load_protocol_updates(force=True)

    def test_apply_merges_incrementally_and_persists_version(self) -> None:
        updates = self._updates_payload()["updates"]
        expected = updates[0]
        latest = updates[-1]
        client = fresh_client()
        response = client.post("/api/providers/protocol-update/apply", json={"provider_id": "apimart"})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["provider_id"], "apimart")
        for kind in ("chat", "image", "video", "audio"):
            self.assertEqual(body["applied"]["added_models"][kind], expected["new_models"][kind], kind)
        self.assertEqual(body["applied"]["protocol_changes"], expected["protocol_changes"])
        # v2 只有参数覆盖（无新模型），apply 后版本应推进到 v2
        self.assertEqual(body["applied"]["model_caps"], expected.get("model_caps") or body["applied"]["model_caps"])
        self.assertTrue(body["applied"]["model_caps"])
        self.assertTrue(body["applied"]["parameter_changes"])
        provider = body["provider"]
        self.assertEqual(provider["protocol_version"], latest["version"])
        self.assertTrue(provider.get("model_caps_overrides"))
        self.assertEqual(provider["name"], "我的 APIMart（自定义名）")
        self.assertEqual(provider["model_names"], {"用户已有图片模型": "我的自定义名"})
        self.assertEqual(provider["image_models"][0], "用户已有图片模型")
        self.assertEqual(provider["image_models"][-len(expected["new_models"]["image"]):],
                         expected["new_models"]["image"])
        self.assertEqual(provider["video_models"][0], "用户已有视频模型")
        self.assertEqual(provider["protocol_version"], body["current_version"])
        # 协议变更只留档、不为了凑条目去改接入方式：base_url / protocol 保持用户原值
        self.assertEqual(provider["base_url"], "https://api.apimart.ai")
        self.assertEqual(provider["protocol"], "apimart")
        self.assertIn("chat_completions_stream_default", provider.get("protocol_fields") or {})
        # 文本类新增为 0；音频本次也必须是 0（TTS/转写/Lyria 走不了画布音乐接口）
        self.assertEqual(body["applied"]["added_models"]["chat"], [])
        self.assertEqual(body["applied"]["added_models"]["audio"], [])
        self.assertEqual(sum(len(v) for v in body["applied"]["added_models"].values()), 5)
        # 落盘 + 缓存失效后的 /api/config 能读到新模型
        stored = self._stored()
        self.assertEqual(stored["protocol_version"], latest["version"])
        self.assertIn(expected["new_models"]["image"][0], stored["image_models"])

    def test_apply_is_idempotent(self) -> None:
        client = fresh_client()
        first = client.post("/api/providers/protocol-update/apply", json={"provider_id": "apimart"})
        self.assertEqual(first.status_code, 200)
        second = client.post("/api/providers/protocol-update/apply", json={"provider_id": "apimart"})
        self.assertEqual(second.status_code, 200, second.text)
        applied = second.json()["applied"]
        self.assertEqual(applied["added_models"], {"chat": [], "image": [], "video": [], "audio": []})
        self.assertEqual(applied["protocol_changes"], [])
        # 模型没有重复追加
        image_models = self._stored()["image_models"]
        self.assertEqual(len(image_models), len(set(image_models)))
        # 再查一次：已是最新
        item = fresh_client().get("/api/providers/protocol-updates").json()["items"][0]
        self.assertEqual(item["available"], False)
        self.assertEqual(item["current_version"], item["latest_version"])

    def test_put_providers_keeps_protocol_version(self) -> None:
        client = fresh_client()
        self.assertEqual(client.post("/api/providers/protocol-update/apply",
                                     json={"provider_id": "apimart"}).status_code, 200)
        applied = self._stored()
        payload = [{key: applied.get(key) for key in (
            "id", "name", "base_url", "protocol", "image_request_mode", "enabled", "primary",
            "image_models", "chat_models", "video_models", "model_names",
        )}]
        response = client.put("/api/providers", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self._stored()["protocol_version"], applied["protocol_version"])

    def test_apply_unknown_provider_is_400(self) -> None:
        response = fresh_client().post("/api/providers/protocol-update/apply",
                                       json={"provider_id": "nope"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("detail", response.json())
        self.assertEqual(fresh_client().post("/api/providers/protocol-update/apply",
                                             json={"provider_id": ""}).status_code, 400)

    def test_member_mode_sees_only_apimart_and_cannot_apply_others(self) -> None:
        main.save_api_providers([
            apimart_provider(),
            {"id": "openai", "name": "OpenAI 兼容", "base_url": "https://api.example.com",
             "protocol": "openai", "enabled": True, "chat_models": ["gpt-5.5"], "image_models": [],
             "video_models": [], "audio_models": [], "protocol_version": 0},
        ])
        with patch.object(main, "_is_admin_actor", return_value=False):
            client = fresh_client()
            items = client.get("/api/providers/protocol-updates").json()["items"]
            self.assertEqual([item["provider_id"] for item in items], ["apimart"])
            self.assertEqual(client.post("/api/providers/protocol-update/apply",
                                         json={"provider_id": "apimart"}).status_code, 200)
            # 成员不能改别的平台（ProviderNotAllowed -> 403），但平台存在 -> 不是 400
            main.save_api_providers([apimart_provider(protocol_version=0),
                                     {"id": "openai", "name": "OpenAI 兼容",
                                      "base_url": "https://api.example.com", "protocol": "openai",
                                      "enabled": True, "chat_models": ["gpt-5.5"], "image_models": [],
                                      "video_models": [], "audio_models": [], "protocol_version": 0}])
            denied = client.post("/api/providers/protocol-update/apply", json={"provider_id": "openai"})
            self.assertEqual(denied.status_code, 403)





class _ChatMockHandler(BaseHTTPRequestHandler):
    """离线假上游：记录 /v1/chat/completions 的请求体，可选拒绝推理参数。"""

    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}
        with self.server.log_lock:
            self.server.requests.append(body)
        if self.server.reject_think and isinstance(body, dict) and body.get("reasoning_effort"):
            self._send(400, {"error": {"message": "unknown field reasoning_effort"}})
            return
        if self.server.sse:
            data = (b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
                    b'data: [DONE]\n\n')
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._send(200, {"choices": [{"message": {"content": "ok"}}]})


class ThinkPassthroughTests(unittest.TestCase):
    """真透传：请求体里必须出现推理字段（而不是只在模型里算了一次）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _ChatMockHandler)
        cls.server.requests = []
        cls.server.reject_think = False
        cls.server.sse = False
        cls.server.log_lock = threading.Lock()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address[:2]
        cls.base_url = f"http://{host}:{port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="novai-think-passthrough-")
        self._orig_providers_file = main.API_PROVIDERS_FILE
        main.API_PROVIDERS_FILE = os.path.join(self.tmpdir, "api_providers.json")
        self.addCleanup(self._restore)
        self.server.reject_think = False
        self.server.sse = False
        with self.server.log_lock:
            self.server.requests.clear()
        main.save_api_providers([apimart_provider(base_url=self.base_url)])

    def _restore(self) -> None:
        main.API_PROVIDERS_FILE = self._orig_providers_file
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _last_body(self) -> dict:
        with self.server.log_lock:
            return self.server.requests[-1]

    def test_canvas_llm_sends_reasoning_effort(self) -> None:
        request = main.CanvasLLMRequest(message="hi", provider="apimart", model="gpt-5.5",
                                        think_level="high")
        result = asyncio.run(main._canvas_llm_impl(request))
        self.assertEqual(result["text"], "ok")
        body = self._last_body()
        self.assertEqual(body.get("reasoning_effort"), "high")   # gpt-5.5 文档确证：high -> high
        self.assertEqual(body.get("model"), "gpt-5.5")

    def test_non_reasoning_model_sends_no_field(self) -> None:
        request = main.CanvasLLMRequest(message="hi", provider="apimart", model="gpt-4o-mini",
                                        think_level="high")
        asyncio.run(main._canvas_llm_impl(request))
        self.assertNotIn("reasoning_effort", self._last_body())

    def test_agent_chat_sends_reasoning_effort(self) -> None:
        chat = {"provider": "apimart", "base": self.base_url + "/v1", "headers": {},
                "model": "gpt-5.5", "provider_cfg": main.get_api_provider("apimart"),
                "think_level": "low"}
        text = asyncio.run(main._agent_run_chat(chat, [{"role": "user", "content": "hi"}]))
        self.assertEqual(text, "ok")
        self.assertEqual(self._last_body().get("reasoning_effort"), "low")   # gpt-5.5 low -> low

    def test_chat_endpoint_sends_reasoning_effort(self) -> None:
        response = fresh_client().post("/api/chat", json={
            "message": "hi", "provider": "apimart", "model": "gpt-5.5", "think_level": "mid"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self._last_body().get("reasoning_effort"), "medium")   # mid -> medium

    def test_chat_stream_endpoint_sends_reasoning_effort(self) -> None:
        self.server.sse = True
        response = fresh_client().post("/api/chat/stream", json={
            "message": "hi", "provider": "apimart", "model": "gpt-5.5", "think_level": "xhigh"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('"type": "delta"', response.text)
        self.assertEqual(self._last_body().get("reasoning_effort"), "xhigh")   # xhigh -> xhigh

    def test_canvas_llm_stream_endpoint_sends_reasoning_effort(self) -> None:
        async def run() -> str:
            response = await main._canvas_llm_stream_impl(
                main.CanvasLLMRequest(message="hi", provider="apimart", model="gpt-5.5",
                                      think_level="max"), charge=None)
            chunks = []
            async for chunk in response.body_iterator:
                chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk))
            return "".join(chunks)

        text = asyncio.run(run())
        self.assertIn('"type": "done"', text)
        # gpt-5.5 不支持 max：先收敛到 xhigh，再发 xhigh
        self.assertEqual(self._last_body().get("reasoning_effort"), "xhigh")

    def test_agent_run_endpoint_carries_think_level(self) -> None:
        captured = []

        async def fake_drive(req, bus):
            captured.append(req)
            main._agent_run_bus_close(bus)

        chat = {"provider": "apimart", "base": self.base_url + "/v1", "headers": {},
                "model": "gpt-5.5", "provider_cfg": main.get_api_provider("apimart")}
        canvas = {"id": "c1", "kind": "smart", "title": "t", "nodes": [], "connections": [],
                  "updated_at": 0}
        with patch.object(main, "_agent_run_resolve_chat", return_value=dict(chat)), \
                patch.object(main, "_agent_run_bus_drive", new=fake_drive), \
                patch.object(main, "load_canvas", return_value=canvas), \
                patch.object(main, "require_canvas_access", return_value=None):
            response = fresh_client().post("/api/agent/run", json={
                "canvas_id": "c1", "instruction": "来张海报", "provider": "apimart",
                "model": "gpt-5.5", "think_level": "xhigh", "mode": "plan"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0]["chat"]["think_level"], "xhigh")

    def test_upstream_rejects_think_param_then_degrades(self) -> None:
        self.server.reject_think = True
        request = main.CanvasLLMRequest(message="hi", provider="apimart", model="gpt-5.5",
                                        think_level="max")
        result = asyncio.run(main._canvas_llm_impl(request))
        self.assertEqual(result["text"], "ok")   # 用户请求不能因为上游不认参数而失败
        with self.server.log_lock:
            bodies = list(self.server.requests)
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[0].get("reasoning_effort"), "xhigh")   # max 收敛到 xhigh
        self.assertNotIn("reasoning_effort", bodies[1])
        self.assertGreaterEqual(main._THINK_FALLBACK_COUNT, 1)   # 降级必须可观测


class ModelCapsAndAudioTests(unittest.TestCase):
    """更新进来的模型必须真能生成：新图像/视频模型有权威 caps，音频清单只留音乐接口能走的模型。"""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="novai-new-model-caps-")
        self._orig_providers_file = main.API_PROVIDERS_FILE
        main.API_PROVIDERS_FILE = os.path.join(self.tmpdir, "api_providers.json")
        self.addCleanup(self._restore)
        main.save_api_providers([apimart_provider(
            image_models=["用户已有图片模型", "gpt-image-2.6-ext", "gpt-image-2.6-flare",
                          "gpt-image-2.6-sunburst", "muse-image-ext", "midjourney",
                          "gpt-image-2.5-flare", "wan2.7-image", "wan2.7-image-pro"],
            video_models=["用户已有视频模型", "muse-video-ext", "seedance-2.5",
                          "minimax-h3-max", "minimax-h3-context-ir"],
        )])
        self.provider = main.get_api_provider("apimart")

    def _restore(self) -> None:
        main.API_PROVIDERS_FILE = self._orig_providers_file
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_gpt_image_26_ext_caps_only_allow_1k_and_n1(self) -> None:
        caps = main.apimart_image_model_caps("gpt-image-2.6-ext")
        self.assertIsNotNone(caps)
        self.assertEqual(caps["resolutions"], ("1K",))
        self.assertEqual(caps["n_max"], 1)
        self.assertEqual(len(caps["ratios"]), 11)   # auto + 10 个比例
        self.assertEqual(caps["ratios"][0], "auto")
        self.assertIn("21:9", caps["ratios"])
        # 4K/2K 请求必须被收敛到 1K（上游 2k/4k 会 403 model_price_not_configured）
        self.assertEqual(main.apimart_image_resolution_for_model("gpt-image-2.6-ext", "4K"), "1K")
        self.assertEqual(main.apimart_image_resolution_for_model("gpt-image-2.6-ext", "2K"), "1K")
        # n_max=1：单次请求的 n 被收到 1（上游 n 只支持 1）；用户要 4 张时由画布拆成 4 次单张请求，不合并成 n=4。
        self.assertEqual(main.model_caps_for(self.provider, "gpt-image-2.6-ext", "image")["n_max"], 1)
        self.assertEqual(min(4, caps["n_max"]), 1)
        self.assertEqual(main.direct_image_request_count(self.provider, "gpt-image-2.6-ext", 4), 4)
        # 不能误命中老的 gpt-image-2 家族（1K/2K/4K、n_max 4）
        self.assertIs(main.apimart_image_model_caps("gpt-image-2.6-ext"),
                      main.APIMART_IMAGE_MODEL_CAPS["gpt-image-2-6-ext"])

    def test_gpt_image_26_flare_caps(self) -> None:
        caps = main.apimart_image_model_caps("gpt-image-2.6-flare")
        self.assertEqual(caps["resolutions"], ("1K", "2K", "4K"))
        self.assertEqual(caps["n_max"], 4)
        # 文档确证：auto + 15 个比例、6 档质量、精确像素与像素上限
        self.assertEqual(len(caps["ratios"]), 16)
        self.assertEqual(caps["ratios"][0], "auto")
        for ratio in ("2:1", "1:2", "21:9", "9:21", "3:1", "1:3"):
            self.assertIn(ratio, caps["ratios"])
        self.assertEqual(caps["qualities"], ("auto", "low", "medium", "high", "xhigh", "max"))
        self.assertIs(caps.get("exact_size"), True)
        self.assertEqual((caps["max_long_edge"], caps["max_pixels"], caps["min_pixels"]),
                         (3840, 8294400, 655360))
        self.assertEqual(main.apimart_image_resolution_for_model("gpt-image-2.6-flare", "4K"), "4K")
        self.assertEqual(main.direct_image_request_count(self.provider, "gpt-image-2.6-flare", 4), 4)
        self.assertIs(main.apimart_image_model_caps("gpt-image-2.6-sunburst"),
                      main.APIMART_IMAGE_MODEL_CAPS["gpt-image-2-6-sunburst"])

    def test_ext_size_assembly_clamps_pixel_request_to_1k(self) -> None:
        size, notice = main.direct_image_size_caps(self.provider, "gpt-image-2.6-ext", "2048x2048")
        self.assertEqual(size, "1024x1024")     # 2K 被收敛到该模型唯一档位 1K
        self.assertTrue(notice)

    def test_muse_image_caps_exist_and_do_not_send_resolution(self) -> None:
        caps = main.apimart_image_model_caps("muse-image-ext")
        self.assertIsNotNone(caps)
        self.assertIs(caps.get("send_resolution"), False)
        self.assertEqual(caps["ref_max"], 9)
        self.assertEqual(caps["n_max"], 1)
        self.assertIn("webp", caps["output_formats"])
        self.assertEqual(main.model_caps_for(self.provider, "muse-image-ext", "image")["resolutions"], [])

    def test_model_caps_endpoint_exposes_new_models(self) -> None:
        items = {item["model"]: item for item in fresh_client().get("/api/model-caps").json()["items"]}
        ext = items["gpt-image-2.6-ext"]
        self.assertEqual(ext["kind"], "image")
        self.assertEqual(ext["resolutions"], ["1K"])
        self.assertEqual(ext["n_max"], 1)
        self.assertEqual(items["gpt-image-2.6-flare"]["resolutions"], ["1K", "2K", "4K"])
        self.assertEqual(len(items["gpt-image-2.6-flare"]["ratios"]), 16)
        self.assertEqual(len(items["gpt-image-2.6-flare"]["qualities"]), 6)
        self.assertIn("muse-image-ext", items)
        self.assertEqual(items["muse-image-ext"].get("resolutions"), [])
        video = items["muse-video-ext"]
        self.assertEqual(video["kind"], "video")
        self.assertEqual(video["resolutions"], ["720p"])
        self.assertEqual(video["durations"], [10])
        self.assertIn("text_to_video", video["modes"])
        self.assertIn("image_to_video", video["modes"])

    def test_audio_update_list_only_contains_music_models(self) -> None:
        # protocol_updates.json 的音频清单必须是空的：TTS/转写走 /audio/*，Lyria 需要必填 version，
        # 画布音频节点只走 /v1/music/generations，放进去就是“点了就错”的入口。
        response = fresh_client().get("/api/providers/protocol-updates")
        item = response.json()["items"][0]
        self.assertEqual(item["new_models"]["audio"], [])
        self.assertEqual(item["new_models"]["image"], ["gpt-image-2.6-ext", "gpt-image-2.6-flare",
                                                       "gpt-image-2.6-sunburst", "muse-image-ext"])
        self.assertEqual(item["new_models"]["video"], ["muse-video-ext"])
        self.assertEqual(item["new_models"]["chat"], [])


    def test_ext_quality_documented_six_levels(self) -> None:
        caps = main.apimart_image_model_caps("gpt-image-2.6-ext")
        self.assertEqual(caps["qualities"], ("auto", "low", "medium", "high", "xhigh", "max"))
        for level in ("low", "medium", "high", "xhigh", "max"):
            self.assertEqual(main.apimart_quality_for_model("gpt-image-2.6-ext", level), level)
        # auto / 空 = 不发（走上游默认），未知档位也不发
        self.assertEqual(main.apimart_quality_for_model("gpt-image-2.6-ext", "auto"), "")
        self.assertEqual(main.apimart_quality_for_model("gpt-image-2.6-ext", ""), "")
        self.assertEqual(main.apimart_quality_for_model("gpt-image-2.6-ext", "ultra"), "")

    def test_flare_sunburst_quality_six_levels(self) -> None:
        six = ("auto", "low", "medium", "high", "xhigh", "max")
        for model in ("gpt-image-2.6-flare", "gpt-image-2.6-sunburst"):
            self.assertEqual(main.apimart_image_model_caps(model)["qualities"], six)
            self.assertEqual(main.apimart_quality_for_model(model, "auto"), "")
            for level in ("low", "medium", "high", "xhigh", "max"):
                self.assertEqual(main.apimart_quality_for_model(model, level), level)


    def test_extra_caps_fields_seedance_mj_muse_h3(self) -> None:
        items = {i["model"]: i for i in fresh_client().get("/api/model-caps").json()["items"]}
        seedance = items["seedance-2.5"]
        self.assertEqual(seedance["resolutions"], ["480p", "720p", "1080p"])
        self.assertIn("adaptive", seedance["ratios"])
        self.assertIn(-1, seedance["durations"])
        self.assertEqual(seedance["ref_max"], 30)
        self.assertEqual(seedance["video_ref_max"], 10)
        self.assertEqual(seedance["audio_ref_max"], 10)
        mj = items["midjourney"]
        self.assertEqual(len(mj["ratios"]), 9)
        self.assertEqual(mj["sizes"], ["2K"])
        self.assertEqual(mj["batch"], [4])
        self.assertEqual(mj["qualities"], [])
        self.assertEqual(mj["mj"]["versions"], ["8.2", "8.1", "7", "6.1", "5.2", "5.1"])
        self.assertEqual(mj["mj"]["speeds"], ["fast"])
        self.assertEqual(mj["mj"]["hd"], ["8.2", "8.1"])
        muse_image = items["muse-image-ext"]
        self.assertEqual(muse_image["ratios"],
                         ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"])
        self.assertEqual(muse_image["ref_max"], 9)
        self.assertEqual(muse_image["output_formats"], ["webp"])
        muse_video = items["muse-video-ext"]
        self.assertEqual(muse_video["ratios"],
                         ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"])
        self.assertNotIn("auto", muse_video["ratios"])
        context_ir = items["minimax-h3-context-ir"]
        self.assertIs(context_ir["prompt_only"], True)
        self.assertEqual(context_ir["resolutions"], [])
        self.assertEqual(context_ir["durations"], [])
        self.assertEqual(context_ir["modes"], [])
        flare = items["gpt-image-2.6-flare"]
        self.assertEqual(flare["ref_max"], 16)
        self.assertTrue(flare["output_formats"])

    def test_gpt_image_25_quality_behavior_unchanged(self) -> None:
        # 2.5 家族的 qualities 是既有推断，原表与行为都保持原样：
        # 既有用例 tests.test_apimart_mock_upstream 断言 quality=max 会真实下发，本次不能改。
        # task-18：文档确证 2.5 补 auto 档；auto 仍不发字段，其余档原样发送
        self.assertEqual(main.apimart_image_model_caps("gpt-image-2.5-flare")["qualities"],
                         ("auto", "low", "medium", "high", "xhigh", "max"))
        self.assertEqual(main.apimart_quality_for_model("gpt-image-2.5-flare", "auto"), "")
        self.assertEqual(main.apimart_quality_for_model("gpt-image-2.5-flare", "high"), "high")
        self.assertEqual(main.apimart_quality_for_model("gpt-image-2.5-flare", "xhigh"), "xhigh")
        self.assertEqual(main.apimart_quality_for_model("gpt-image-2.5-flare", "max"), "max")

    def test_thinking_mode_only_for_wan27_image_family(self) -> None:
        self.assertIs(main.apimart_image_model_caps("wan2.7-image").get("thinking_mode"), True)
        self.assertIs(main.apimart_image_model_caps("wan2.7-image-pro").get("thinking_mode"), True)
        self.assertIsNone(main.apimart_image_model_caps("gpt-image-2.6-ext").get("thinking_mode"))
        self.assertIs(main.apimart_thinking_mode_value("wan2.7-image", True), True)
        self.assertIs(main.apimart_thinking_mode_value("wan2.7-image", False), False)
        self.assertIsNone(main.apimart_thinking_mode_value("wan2.7-image", None))
        self.assertIsNone(main.apimart_thinking_mode_value("gpt-image-2.6-ext", True))

    def test_online_image_request_thinking_mode_field(self) -> None:
        self.assertIsNone(main.OnlineImageRequest(prompt="p").thinking_mode)
        self.assertIs(main.OnlineImageRequest(prompt="p", thinking_mode=True).thinking_mode, True)
        self.assertIs(main.OnlineImageRequest(prompt="p", thinking_mode=False).thinking_mode, False)

    def test_model_caps_endpoint_quality_and_thinking_mode(self) -> None:
        items = {item["model"]: item for item in fresh_client().get("/api/model-caps").json()["items"]}
        self.assertEqual(items["gpt-image-2.6-ext"]["qualities"],
                         ["auto", "low", "medium", "high", "xhigh", "max"])
        self.assertEqual(items["gpt-image-2.6-flare"]["qualities"],
                         ["auto", "low", "medium", "high", "xhigh", "max"])
        self.assertEqual(items["gpt-image-2.5-flare"]["qualities"],
                         ["auto", "low", "medium", "high", "xhigh", "max"])
        self.assertIs(items["wan2.7-image"]["thinking_mode"], True)
        self.assertIs(items["wan2.7-image-pro"]["thinking_mode"], True)
        self.assertNotIn("thinking_mode", items["gpt-image-2.6-ext"])

    def test_lyria_generic_music_body_is_not_usable(self) -> None:
        # 证据：文档要求 Lyria 的 version 字段必填，通用音乐提交体不带 version；
        # flowmusic-lyria-3.5 会被 flowmusic 分支吃掉、model 发成 flowmusic 而不是用户选的模型。
        lyria = main.apimart_audio_submit_body(
            "lyria-3.5", main.CanvasAudioRequest(model="lyria-3.5", prompt="p"))
        self.assertEqual(lyria.get("model"), "lyria-3.5")
        self.assertNotIn("version", lyria)
        alias = main.apimart_audio_submit_body(
            "flowmusic-lyria-3.5", main.CanvasAudioRequest(model="flowmusic-lyria-3.5", prompt="p"))
        self.assertEqual(alias.get("model"), "flowmusic")


class ModelCapsOverrideTests(unittest.TestCase):
    """协议更新包的 model_caps：apply 落 provider.model_caps_overrides，/api/model-caps 字段级合并。"""

    def setUp(self) -> None:
        self.tmpdir = tempfile.mkdtemp(prefix="novai-caps-override-")
        self.providers_file = os.path.join(self.tmpdir, "api_providers.json")
        self._orig_providers_file = main.API_PROVIDERS_FILE
        main.API_PROVIDERS_FILE = self.providers_file
        self.addCleanup(self._restore)
        main.save_api_providers([apimart_provider(
            image_models=["gpt-image-2.6-ext"],
            video_models=["muse-video-ext"],
        )])
        protocol_updates.load_protocol_updates(force=True)

    def _restore(self) -> None:
        main.API_PROVIDERS_FILE = self._orig_providers_file
        protocol_updates.load_protocol_updates(force=True)
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _stored(self) -> dict:
        with open(self.providers_file, "r", encoding="utf-8") as handle:
            return json.load(handle)[0]

    def _apply(self):
        response = fresh_client().post("/api/providers/protocol-update/apply",
                                       json={"provider_id": "apimart"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def _put_provider(self, stored: dict):
        keys = ("id", "name", "base_url", "protocol", "image_request_mode", "enabled", "primary",
                "image_models", "chat_models", "video_models", "audio_models", "model_names")
        response = fresh_client().put("/api/providers", json=[{k: stored.get(k) for k in keys}])
        self.assertEqual(response.status_code, 200, response.text)

    def _override(self, model: str, kind: str, caps: dict) -> None:
        providers = main.load_api_providers()
        provider = next(p for p in providers if p.get("id") == "apimart")
        overrides = dict(provider.get("model_caps_overrides") or {})
        overrides[model.lower()] = {"model": model, "kind": kind, "caps": caps}
        provider["model_caps_overrides"] = overrides
        main.save_api_providers(providers)

    def test_apply_writes_model_caps_overrides_and_v2(self) -> None:
        body = self._apply()
        stored = self._stored()
        self.assertEqual(stored["protocol_version"], 2)
        overrides = stored.get("model_caps_overrides") or {}
        self.assertEqual(set(overrides), {"gpt-image-2.6-ext", "gpt-image-2.6-flare",
                                          "gpt-image-2.6-sunburst", "muse-image-ext", "muse-video-ext",
                                          "seedance-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
                                          "minimax-h3-context-ir", "midjourney"})
        self.assertEqual(len(overrides["gpt-image-2.6-ext"]["caps"]["ratios"]), 11)
        flare = overrides["gpt-image-2.6-flare"]["caps"]
        self.assertEqual(len(flare["ratios"]), 16)
        self.assertEqual(len(flare["qualities"]), 6)
        self.assertIs(flare["exact_size"], True)
        self.assertEqual(flare["max_pixels"], 8294400)
        muse_video = overrides["muse-video-ext"]
        self.assertEqual(muse_video["kind"], "video")
        self.assertEqual(muse_video["caps"]["durations"], [10])
        seedance = overrides["seedance-2.5"]["caps"]
        self.assertEqual(seedance["resolutions"], ["480p", "720p", "1080p"])
        self.assertIn("adaptive", seedance["ratios"])
        self.assertIn(-1, seedance["durations"])
        self.assertEqual((seedance["ref_max"], seedance["video_ref_max"], seedance["audio_ref_max"]), (30, 10, 10))
        mj = overrides["midjourney"]["caps"]
        self.assertEqual(mj["sizes"], ["2K"])
        self.assertEqual(mj["mj"]["hd"], ["8.2", "8.1"])
        self.assertIs(overrides["minimax-h3-context-ir"]["caps"]["prompt_only"], True)
        self.assertEqual(len(body["applied"]["model_caps"]), 10)
        self.assertTrue(body["applied"]["parameter_changes"])

    def test_apply_is_idempotent(self) -> None:
        self._apply()
        before = self._stored()
        second = self._apply()
        self.assertEqual(second["applied"]["model_caps"], [])
        self.assertEqual(second["applied"]["parameter_changes"], [])
        after = self._stored()
        self.assertEqual(after["protocol_version"], 2)
        self.assertEqual(after.get("model_caps_overrides"), before.get("model_caps_overrides"))
        item = fresh_client().get("/api/providers/protocol-updates").json()["items"][0]
        self.assertEqual(item["current_version"], 2)
        self.assertFalse(item["available"])

    def test_put_providers_keeps_overrides(self) -> None:
        self._apply()
        before = self._stored()
        self._put_provider(before)
        after = self._stored()
        self.assertEqual(after["protocol_version"], 2)
        self.assertEqual(after.get("model_caps_overrides"), before.get("model_caps_overrides"))

    def test_model_caps_field_level_merge(self) -> None:
        self._apply()
        # 把内置表已知模型改成明显不同的参数，验证 /api/model-caps 用的是覆盖值
        self._override("gpt-image-2.6-ext", "image", {
            "ratios": ["1:1", "2:1"], "resolutions": ["2K"], "n_max": 1,
            "qualities": ["low", "high"],
        })
        self._override("gpt-image-2.6-flare", "image", {
            "ratios": ["1:1"], "resolutions": ["4K"], "n_max": 3,
            "qualities": ["xhigh"],
        })
        items = {i["model"]: i for i in fresh_client().get("/api/model-caps").json()["items"]}
        ext = items["gpt-image-2.6-ext"]
        self.assertEqual(ext["ratios"], ["1:1", "2:1"])
        self.assertEqual(ext["resolutions"], ["2K"])
        self.assertEqual(ext["qualities"], ["low", "high"])
        flare = items["gpt-image-2.6-flare"]
        self.assertEqual(flare["ratios"], ["1:1"])
        self.assertEqual(flare["resolutions"], ["4K"])
        self.assertEqual(flare["n_max"], 3)
        self.assertEqual(flare["qualities"], ["xhigh"])

    def test_override_synthesizes_model_missing_from_builtin(self) -> None:
        self._apply()
        self._override("gpt-image-9-exclusive", "image", {
            "ratios": ["1:1", "2:1"], "resolutions": ["2K"], "n_max": 1,
            "qualities": ["low", "high"],
        })
        self._override("muse-video-9-exclusive", "video", {
            "ratios": [], "resolutions": ["1080p"], "durations": [5, 10], "n_max": 1,
            "modes": ["text_to_video"],
        })
        items = {i["model"]: i for i in fresh_client().get("/api/model-caps").json()["items"]}
        exclusive = items["gpt-image-9-exclusive"]
        self.assertEqual(exclusive["provider"], "apimart")
        self.assertEqual(exclusive["kind"], "image")
        self.assertEqual(exclusive["ratios"], ["1:1", "2:1"])
        self.assertEqual(exclusive["resolutions"], ["2K"])
        self.assertEqual(exclusive["qualities"], ["low", "high"])
        video = items["muse-video-9-exclusive"]
        self.assertEqual(video["kind"], "video")
        self.assertEqual(video["resolutions"], ["1080p"])
        self.assertEqual(video["durations"], [5, 10])
        self.assertEqual(video["modes"], ["text_to_video"])
        # 生成侧用的是同一份合并后的 caps
        provider = main.get_api_provider("apimart")
        merged = main.apimart_image_caps_for(provider, "gpt-image-9-exclusive")
        self.assertEqual(merged["resolutions"], ["2K"])
        self.assertEqual(main.apimart_image_resolution_for_model("gpt-image-9-exclusive", "4K", caps=merged), "2K")

    def test_caps_signature_and_cache_follow_overrides(self) -> None:
        self._apply()
        first = fresh_client().get("/api/model-caps").json()
        before_sig = main._model_caps_config_signature()
        self._override("gpt-image-2.6-ext", "image", {
            "ratios": ["1:1"], "resolutions": ["1K"], "n_max": 1, "qualities": ["low"],
        })
        after_sig = main._model_caps_config_signature()
        self.assertNotEqual(before_sig, after_sig)
        second = fresh_client().get("/api/model-caps").json()
        ext_first = next(i for i in first["items"] if i["model"] == "gpt-image-2.6-ext")
        ext_second = next(i for i in second["items"] if i["model"] == "gpt-image-2.6-ext")
        self.assertEqual(len(ext_first["ratios"]), 11)
        self.assertEqual(ext_second["ratios"], ["1:1"])

    def test_view_exposes_model_caps_and_parameter_changes(self) -> None:
        item = fresh_client().get("/api/providers/protocol-updates").json()["items"][0]
        self.assertEqual(item["latest_version"], 2)
        self.assertEqual(len(item["model_caps"]), 10)
        models = {cap["model"] for cap in item["model_caps"]}
        self.assertEqual(models, {"gpt-image-2.6-ext", "gpt-image-2.6-flare",
                                  "gpt-image-2.6-sunburst", "muse-image-ext", "muse-video-ext",
                                  "seedance-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
                                  "minimax-h3-context-ir", "midjourney"})
        self.assertTrue(item["parameter_changes"])
        # v2 没有新模型时，v1 的新模型/协议变更仍要聚合展示
        self.assertEqual(len(item["new_models"]["image"]), 4)
        self.assertTrue(item["protocol_changes"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
