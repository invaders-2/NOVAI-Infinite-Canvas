"""Agent 选型：用户显式选的平台+模型优先且原样使用，不可用才回退（回退时 model 传空）。

三个入口共用同一个公共选型 _resolve_chat_with_preference：
  · _agent_run_resolve_chat（/api/agent/run）
  · agent_generate_plan（/api/agent/plan 方案生成）
  · _agents_resolve_chat（智能体广场）
下面的 AgentChatResolveTests 用 _agent_run_resolve_chat 覆盖公共逻辑本身，
AgentChatSelectionEntryPointsTests 覆盖三个入口各自的行为（含 plan 的上游重试语义）。

原覆盖（公共逻辑）：
  1) 选 comfly + gemini-3.5-flash → 第一个尝试 comfly、model 原样、fallback=False
  2) 选 apimart + 任意模型 → 同上
  3) 选的平台解析失败 / 无 base → 回退到下一个平台，fallback=True，requested_* 仍是用户选的，回退那次 model 为空
  4) provider 为空 → 与历史行为一致（只走可用平台列表、model 始终为空、fallback=False）
  5) 候选去重、全不可用时报 400、ms_model 只给 modelscope

跑法：python -m unittest tests.test_agent_chat_resolve
（CI 入口见 .github/workflows/tests.yml 的 python -m unittest 列表）
"""
import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def _fake_resolve(calls, fail=(), empty_base=()):
    """假的 resolve_chat_provider：记录入参；fail 里的平台抛 HTTPException；正常时原样返回传入的 model。"""

    def _resolve(provider, model, ms_model, require_model=True):
        calls.append({"provider": provider, "model": model, "ms_model": ms_model})
        if provider in fail:
            raise main.HTTPException(status_code=400, detail=f"{provider} 未配置 API Key")
        if provider in empty_base:
            return "", {}, model or f"{provider}-default-model"
        return f"https://{provider}.example/v1", {"Authorization": "Bearer test"}, (model or f"{provider}-default-model")

    return _resolve


def _fake_provider_cfg(provider_id):
    """"comfly" 是历史别名：真实平台是当前首选平台（这里模拟成 apimart）。"""
    if provider_id == "comfly":
        return {"id": "apimart", "name": "APIMart"}
    return {"id": provider_id, "name": provider_id}


class AgentChatResolveTests(unittest.TestCase):

    def _resolve(self, provider, model, available, ms_model="", fail=(), empty_base=()):
        calls = []
        with mock.patch.object(main, "_agent_available_providers", lambda: list(available)), \
             mock.patch.object(main, "resolve_chat_provider", _fake_resolve(calls, fail, empty_base)), \
             mock.patch.object(main, "get_api_provider", _fake_provider_cfg):
            chat = main._agent_run_resolve_chat(provider, model, ms_model)
        return chat, calls

    # ── 1) 用户选 comfly + gemini-3.5-flash：必须原样用 ──────────────────────
    def test_explicit_comfly_model_used_verbatim(self):
        chat, calls = self._resolve("comfly", "gemini-3.5-flash", ["volcengine", "apimart"])
        self.assertEqual(len(calls), 1, "命中所选平台后不再往下试别的平台")
        self.assertEqual(calls[0]["provider"], "comfly", "comfly 必须是第一个候选（旧代码会把它剔掉）")
        self.assertEqual(calls[0]["model"], "gemini-3.5-flash", "用户选的模型必须原样透传")
        self.assertEqual(chat["provider"], "comfly")
        self.assertEqual(chat["model"], "gemini-3.5-flash")
        self.assertEqual(chat["base"], "https://comfly.example/v1")
        self.assertIs(chat["fallback"], False)
        self.assertEqual(chat["requested_provider"], "comfly")
        self.assertEqual(chat["requested_model"], "gemini-3.5-flash")
        self.assertEqual(chat["resolved_provider"], "comfly")
        self.assertEqual(chat["resolved_model"], "gemini-3.5-flash")
        # comfly 是历史别名：真正生效的平台单独给出（这里模拟映射到 apimart）
        self.assertEqual(chat["resolved_platform"], "apimart")

    # ── 2) 选 apimart + 任意模型：同样原样 ─────────────────────────────────
    def test_explicit_apimart_model_used_verbatim(self):
        chat, calls = self._resolve("apimart", "gpt-4o-mini", ["volcengine"])
        self.assertEqual(calls[0]["provider"], "apimart")
        self.assertEqual(calls[0]["model"], "gpt-4o-mini")
        self.assertIs(chat["fallback"], False)
        self.assertEqual(chat["resolved_platform"], "apimart")
        self.assertEqual(chat["model"], "gpt-4o-mini")

    # ── 3) 所选平台解析失败 → 回退，且回退那次 model 传空 ────────────────
    def test_requested_platform_failure_falls_back_with_empty_model(self):
        chat, calls = self._resolve("comfly", "gemini-3.5-flash", ["volcengine", "apimart"], fail=("comfly",))
        self.assertEqual([c["provider"] for c in calls], ["comfly", "volcengine"], "回退顺序就是可用平台列表顺序")
        self.assertEqual(calls[0]["model"], "gemini-3.5-flash", "第一候选仍然带用户选的模型")
        self.assertEqual(calls[1]["model"], "", "回退时 model 传空（用该平台自己的默认模型）")
        self.assertEqual(chat["provider"], "volcengine")
        self.assertEqual(chat["model"], "volcengine-default-model", "回退落到平台默认模型，不硬塞用户的模型名")
        self.assertIs(chat["fallback"], True)
        self.assertEqual(chat["requested_provider"], "comfly", "requested_* 仍是用户当初选的")
        self.assertEqual(chat["requested_model"], "gemini-3.5-flash")
        self.assertEqual(chat["resolved_provider"], "volcengine")
        self.assertEqual(chat["resolved_platform"], "volcengine")

    def test_requested_platform_without_base_falls_back(self):
        chat, calls = self._resolve("comfly", "gemini-3.5-flash", ["lovart"], empty_base=("comfly",))
        self.assertEqual([c["provider"] for c in calls], ["comfly", "lovart"])
        self.assertIs(chat["fallback"], True)
        self.assertEqual(chat["provider"], "lovart")
        self.assertEqual(calls[1]["model"], "")

    # ── 4) provider 为空：与旧行为一致 ────────────────────────────────────
    def test_empty_provider_keeps_legacy_behaviour(self):
        chat, calls = self._resolve("", "gemini-3.5-flash", ["volcengine", "apimart"])
        self.assertEqual([c["provider"] for c in calls], ["volcengine"], "空 provider 只按可用平台顺序挑")
        self.assertEqual(calls[0]["model"], "", "空 provider 时历史行为就是 model 传空（用平台默认）")
        self.assertEqual(chat["provider"], "volcengine")
        self.assertEqual(chat["model"], "volcengine-default-model")
        self.assertIs(chat["fallback"], False, "没有请求就没有回退")
        self.assertEqual(chat["requested_provider"], "", "没有请求平台")
        # requested_model 如实记录调用方传了什么；空 provider 时它不参与选型（历史行为），看 fallback=False
        self.assertEqual(chat["requested_model"], "gemini-3.5-flash")
        self.assertEqual(chat["resolved_platform"], "volcengine")

    def test_empty_provider_with_padding_is_treated_as_empty(self):
        chat, calls = self._resolve("   ", "  ", ["apimart"])
        self.assertEqual(calls[0]["provider"], "apimart")
        self.assertEqual(calls[0]["model"], "")
        self.assertIs(chat["fallback"], False)

    # ── 5) 候选去重 / 全不可用 / ms_model 归 modelscope ───────────────────
    def test_duplicate_candidate_tried_once(self):
        chat, calls = self._resolve("volcengine", "doubao-x", ["volcengine", "apimart"])
        self.assertEqual([c["provider"] for c in calls], ["volcengine"], "请求的平台同时出现在可用列表里也只试一次")
        self.assertEqual(chat["model"], "doubao-x")

    def test_all_unavailable_raises_400(self):
        calls = []
        with mock.patch.object(main, "_agent_available_providers", lambda: ["volcengine"]), \
             mock.patch.object(main, "resolve_chat_provider", _fake_resolve(calls, fail=("comfly", "volcengine"))), \
             mock.patch.object(main, "get_api_provider", _fake_provider_cfg):
            with self.assertRaises(main.HTTPException) as ctx:
                main._agent_run_resolve_chat("comfly", "gemini-3.5-flash", "")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("已尝试", str(ctx.exception.detail))
        self.assertIn("comfly", str(ctx.exception.detail))

    def test_ms_model_only_goes_to_modelscope(self):
        chat, calls = self._resolve("modelscope", "qwen-chat", ["volcengine"], ms_model="qwen-max")
        self.assertEqual(calls[0]["provider"], "modelscope")
        self.assertEqual(calls[0]["ms_model"], "qwen-max")
        self.assertEqual(chat["provider"], "modelscope")
        # 回退到非 modelscope 平台时不能把 ms_model 带过去
        chat2, calls2 = self._resolve("modelscope", "", ["volcengine"], ms_model="qwen-max", fail=("modelscope",))
        self.assertEqual([c["provider"] for c in calls2], ["modelscope", "volcengine"])
        self.assertEqual(calls2[1]["ms_model"], "")

    def test_case_insensitive_provider(self):
        chat, calls = self._resolve("  ComFly ", "gemini-3.5-flash", ["volcengine"])
        self.assertEqual(calls[0]["provider"], "comfly", "大小写/空格归一后再选型")
        self.assertEqual(calls[0]["model"], "gemini-3.5-flash")
        self.assertIs(chat["fallback"], False)


# ── 三个入口都要走同一套选型（plan 方案生成 / 智能体广场 / agent run）───────────
class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _plan_payload():
    """回一个合法计划 JSON（工具名从 main.AGENT_TOOLS 取，避免写死）。"""
    tool = next(iter(main.AGENT_TOOLS))
    plan = {"intent": "建图", "steps": [{"tool": tool, "args": {}, "description": "生成一张图"}]}
    return {"choices": [{"message": {"content": json.dumps(plan, ensure_ascii=False)}}]}


class _FakeAsyncClient:
    """假的 httpx.AsyncClient：记录每次请求的 url/model，回一个合法计划 JSON。"""
    calls = []
    fail_urls = ()

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        type(self).calls.append({"url": url, "model": (json or {}).get("model")})
        if any(marker in str(url) for marker in type(self).fail_urls):
            raise main.httpx.HTTPError("boom")
        return _FakeResponse(_plan_payload())


class AgentChatSelectionEntryPointsTests(unittest.TestCase):
    """plan 生成 / 智能体广场 / agent run 三个入口的选型一致性。"""

    def setUp(self):
        _FakeAsyncClient.calls = []
        _FakeAsyncClient.fail_urls = ()

    def _plan(self, provider, model, available, fail=()):
        calls = []
        with mock.patch.object(main, "_agent_available_providers", lambda: list(available)), \
             mock.patch.object(main, "resolve_chat_provider", _fake_resolve(calls, fail)), \
             mock.patch.object(main, "get_api_provider", _fake_provider_cfg), \
             mock.patch.object(main, "load_canvas", lambda canvas_id: {"nodes": [], "connections": []}), \
             mock.patch.object(main, "_agent_canvas_summary", lambda canvas: {}), \
             mock.patch.object(main, "_agent_build_tools_catalog", lambda: {}), \
             mock.patch.object(main.httpx, "AsyncClient", _FakeAsyncClient):
            plan = asyncio.run(main.agent_generate_plan("c1", "生成一张鞋的图", "", provider, model))
        return plan, calls, list(_FakeAsyncClient.calls)

    # plan：comfly + 显式模型 → 上游请求就用这个模型
    def test_plan_uses_explicit_comfly_model(self):
        plan, resolve_calls, http_calls = self._plan("comfly", "gemini-3.5-flash", ["volcengine"])
        self.assertEqual([c["provider"] for c in resolve_calls], ["comfly"], "plan 第一候选必须是用户选的 comfly")
        self.assertEqual(resolve_calls[0]["model"], "gemini-3.5-flash")
        self.assertEqual(len(http_calls), 1)
        self.assertEqual(http_calls[0]["model"], "gemini-3.5-flash", "发给上游的 model 就是用户选的")
        self.assertTrue(http_calls[0]["url"].startswith("https://comfly.example/v1"))
        self.assertEqual(plan["model"], "gemini-3.5-flash")

    # plan：comfly 解析失败 → 回退到下一个平台，model 传空 → 用平台默认
    def test_plan_falls_back_with_platform_default_model(self):
        plan, resolve_calls, http_calls = self._plan("comfly", "gemini-3.5-flash", ["volcengine"], fail=("comfly",))
        self.assertEqual([c["provider"] for c in resolve_calls], ["comfly", "volcengine"])
        self.assertEqual(resolve_calls[1]["model"], "", "回退那一轮 model 传空")
        self.assertEqual(http_calls[0]["model"], "volcengine-default-model")
        self.assertEqual(plan["model"], "volcengine-default-model")

    # plan：第一个平台上游报错 → 继续试下一个平台（原有语义保留）
    def test_plan_retries_next_platform_on_upstream_error(self):
        _FakeAsyncClient.fail_urls = ("comfly.example",)
        plan, resolve_calls, http_calls = self._plan("comfly", "gemini-3.5-flash", ["volcengine"])
        self.assertEqual(http_calls[0]["url"].split("/")[2], "comfly.example")
        self.assertEqual(http_calls[1]["model"], "volcengine-default-model")
        self.assertEqual(plan["model"], "volcengine-default-model")

    # 智能体广场：comfly + 显式模型 → 原样
    def test_agents_plaza_uses_explicit_comfly_model(self):
        calls = []
        with mock.patch.object(main, "_agent_available_providers", lambda: ["volcengine"]), \
             mock.patch.object(main, "resolve_chat_provider", _fake_resolve(calls)), \
             mock.patch.object(main, "get_api_provider", _fake_provider_cfg), \
             mock.patch.object(main, "_agent_auto_chat_model", lambda pid: f"{pid}-auto-model"):
            chat = main._agents_resolve_chat("comfly", "gemini-3.5-flash", "")
        self.assertEqual([c["provider"] for c in calls], ["comfly"])
        self.assertEqual(calls[0]["model"], "gemini-3.5-flash")
        self.assertIs(chat["fallback"], False)
        self.assertEqual(chat["resolved_platform"], "apimart")
        self.assertEqual(chat["model"], "gemini-3.5-flash")

    # 智能体广场：comfly 失败 → 回退平台用它自己声明的 chat_models（不是用户的模型）
    def test_agents_plaza_falls_back_to_auto_model(self):
        calls = []
        with mock.patch.object(main, "_agent_available_providers", lambda: ["volcengine"]), \
             mock.patch.object(main, "resolve_chat_provider", _fake_resolve(calls, fail=("comfly",))), \
             mock.patch.object(main, "get_api_provider", _fake_provider_cfg), \
             mock.patch.object(main, "_agent_auto_chat_model", lambda pid: f"{pid}-auto-model"):
            chat = main._agents_resolve_chat("comfly", "gemini-3.5-flash", "")
        self.assertEqual([c["provider"] for c in calls], ["comfly", "volcengine"])
        self.assertEqual(calls[1]["model"], "volcengine-auto-model", "回退平台用自己声明的对话模型")
        self.assertIs(chat["fallback"], True)
        self.assertEqual(chat["requested_provider"], "comfly")
        self.assertEqual(chat["requested_model"], "gemini-3.5-flash")

    # 智能体广场：用户没给模型 → 按该平台 chat_models 自动挑
    def test_agents_plaza_auto_model_when_model_empty(self):
        calls = []
        with mock.patch.object(main, "_agent_available_providers", lambda: ["volcengine"]), \
             mock.patch.object(main, "resolve_chat_provider", _fake_resolve(calls)), \
             mock.patch.object(main, "get_api_provider", _fake_provider_cfg), \
             mock.patch.object(main, "_agent_auto_chat_model", lambda pid: f"{pid}-auto-model"):
            chat = main._agents_resolve_chat("comfly", "", "")
        self.assertEqual(calls[0]["model"], "comfly-auto-model")
        self.assertIs(chat["fallback"], False)
        self.assertEqual(chat["requested_model"], "")

    # 智能体广场：全不可用 → 400，错误里汇总每个候选的原因
    def test_agents_plaza_all_fail_reports_reasons(self):
        calls = []
        with mock.patch.object(main, "_agent_available_providers", lambda: ["volcengine"]), \
             mock.patch.object(main, "resolve_chat_provider", _fake_resolve(calls, fail=("comfly", "volcengine"))), \
             mock.patch.object(main, "get_api_provider", _fake_provider_cfg), \
             mock.patch.object(main, "_agent_auto_chat_model", lambda pid: f"{pid}-auto-model"):
            with self.assertRaises(main.HTTPException) as ctx:
                main._agents_resolve_chat("comfly", "gemini-3.5-flash", "")
        detail = str(ctx.exception.detail)
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("comfly", detail)
        self.assertIn("volcengine", detail)
        self.assertIn("；", detail, "逐个候选的原因用「；」串起来（原有汇总行为）")

    # 三个入口对同一组输入的选型结论必须一致
    def test_all_entry_points_agree(self):
        calls = []
        with mock.patch.object(main, "_agent_available_providers", lambda: ["volcengine"]), \
             mock.patch.object(main, "resolve_chat_provider", _fake_resolve(calls)), \
             mock.patch.object(main, "get_api_provider", _fake_provider_cfg), \
             mock.patch.object(main, "_agent_auto_chat_model", lambda pid: f"{pid}-auto-model"):
            run_chat = main._agent_run_resolve_chat("comfly", "gemini-3.5-flash", "")
            plaza_chat = main._agents_resolve_chat("comfly", "gemini-3.5-flash", "")
        plan, _, http_calls = self._plan("comfly", "gemini-3.5-flash", ["volcengine"])
        self.assertEqual(
            (run_chat["resolved_provider"], run_chat["resolved_model"], run_chat["fallback"]),
            (plaza_chat["resolved_provider"], plaza_chat["resolved_model"], plaza_chat["fallback"]))
        self.assertEqual(http_calls[0]["model"], run_chat["resolved_model"])
        self.assertEqual(plan["model"], run_chat["resolved_model"])


if __name__ == "__main__":
    unittest.main()
