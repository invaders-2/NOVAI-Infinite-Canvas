#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""积分制后端测试（迁移/充值/扣费/退款/并发/余额不足/估价/加价/流水/SSE/auth-off）。

跑法：
    venv/bin/python -m unittest tests.test_credits -v
或：
    python3 -m unittest tests.test_credits -v

为什么自己建临时数据目录：计费是钱的事，测试必须从空库开始，且不能碰 data/users.db。
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

_TMP_DATA = tempfile.mkdtemp(prefix="novai-credits-test-")
# 合并跑（多个测试套件同一进程）时，谁先 import 谁决定数据目录；这里只用 setdefault，
# 不覆盖别的套件已经设好的 NOVAI_DATA_DIR，也不在收尾时删目录（后面的套件还在用）。
os.environ.setdefault("NOVAI_DATA_DIR", _TMP_DATA)
os.environ.pop("NOVAI_AUTH_ENABLED", None)
os.environ.pop("NOVAI_AUTH_DISABLED", None)
os.environ.pop("NOVAI_CREDITS_DISABLED", None)
os.environ.setdefault("NOVAI_ADMIN_USER", "admin")
# 与仓库里其它 python 测试套件保持同一默认管理员口令，避免合并跑时各模块常量化出不同密码
# （谁先 import main 谁建管理员，后导入的模块常量必须和它一致）。
os.environ.setdefault("NOVAI_ADMIN_PASSWORD", "test-pass-123")
os.environ["NOVAI_REGISTER_IP_LIMIT"] = "5000"
os.environ["NOVAI_SSE_HEARTBEAT_SECONDS"] = "0.2"
os.environ.pop("APIMART_TIER", None)
os.environ.pop("NOVAI_CREDIT_USD", None)
os.environ.pop("CREDIT_MARKUP", None)
# 老用例覆盖 prepaid 兼容路径；全局后付费用例在各自测试里显式切换
os.environ["CREDIT_BILLING_MODE"] = "prepaid"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.auth import service as auth_service  # noqa: E402
from server.credits import audit as credits_audit  # noqa: E402
from server.credits import config, events, integration, model_map, pricing, reset_for_tests, service, store  # noqa: E402
from server.credits.errors import InsufficientCredits  # noqa: E402
from server.credits import api as credits_api  # noqa: E402

ADMIN_USER = os.environ["NOVAI_ADMIN_USER"]
ADMIN_PASS = os.environ["NOVAI_ADMIN_PASSWORD"]

_counter = {"n": 0}


def create_named_user(balance: float = 0.0, prefix: str = "credit_u"):
    _counter["n"] += 1
    username = "%s%d_%d" % (prefix, _counter["n"], os.getpid())
    user = auth_service.create_user(username, "test-pass-123", "user")
    uid = int(user["id"])
    if balance:
        store.adjust_credits(uid, balance, kind="test_seed")
    return uid, username, "test-pass-123"


def unique_user(balance: float = 0.0) -> int:
    return create_named_user(balance)[0]


def force_balance(uid: int, value: float) -> None:
    conn = store.connect()
    try:
        conn.execute("UPDATE users SET credits = ? WHERE id = ?", (float(value), int(uid)))
    finally:
        conn.close()


def set_auth(enabled: bool) -> None:
    if enabled:
        os.environ["NOVAI_AUTH_ENABLED"] = "1"
        os.environ.pop("NOVAI_AUTH_DISABLED", None)
    else:
        os.environ["NOVAI_AUTH_DISABLED"] = "1"
        os.environ.pop("NOVAI_AUTH_ENABLED", None)


def ensure_admin() -> None:
    """合并跑时 main 可能是在 auth 关闭状态下 import 的：这里补齐管理员再登录。"""
    set_auth(True)
    reset_for_tests()
    auth_service.bootstrap_admin()


def admin_client() -> TestClient:
    ensure_admin()
    client = TestClient(main.app)
    response = client.post("/api/auth/login", json={"username": ADMIN_USER, "password": ADMIN_PASS})
    assert response.status_code == 200, response.text
    return client


def setUpModule():
    set_auth(True)
    auth_service.bootstrap_admin()


class SchemaAndAdminTests(unittest.TestCase):
    def test_migration_columns_exist(self):
        conn = store.connect()
        try:
            user_columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)").fetchall()}
            self.assertIn("credits", user_columns)
            tx_columns = {row["name"] for row in conn.execute("PRAGMA table_info(credit_transactions)").fetchall()}
            for column in ("id", "user_id", "delta", "balance_after", "kind", "ref", "note",
                           "cost_usd", "price_usd", "profit_usd", "created_at"):
                self.assertIn(column, tx_columns)
            charge_columns = {row["name"] for row in conn.execute("PRAGMA table_info(credit_charges)").fetchall()}
            for column in ("id", "user_id", "task_ref", "model", "kind", "params_json", "estimate",
                           "charged", "cost_usd", "profit_usd", "status", "created_at", "settled_at",
                           "pricing_fallback", "unmapped_json"):
                self.assertIn(column, charge_columns)
        finally:
            conn.close()

    def test_admin_credit_api_positive_and_negative(self):
        client = admin_client()
        uid = unique_user(0)
        response = client.post("/api/admin/users/%d/credits" % uid, json={"delta": 12.5, "note": "充值"})
        self.assertEqual(response.status_code, 200)
        self.assertAlmostEqual(response.json()["balance"], 12.5)
        self.assertAlmostEqual(store.balance(uid), 12.5)

        response = client.post("/api/admin/users/%d/credits" % uid, json={"delta": -2.5})
        self.assertEqual(response.status_code, 200)
        self.assertAlmostEqual(response.json()["balance"], 10.0)

        response = client.post("/api/admin/users/%d/credits" % uid, json={"delta": -99})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "INSUFFICIENT_BALANCE")
        self.assertAlmostEqual(store.balance(uid), 10.0)

        transactions = service.transactions(uid)
        self.assertEqual([item["kind"] for item in transactions[:2]], ["admin_adjust", "admin_adjust"])
        self.assertAlmostEqual(transactions[0]["balance_after"], 10.0)

    def test_me_and_transactions_contract(self):
        client = admin_client()
        uid = unique_user(7.0)
        response = client.get("/api/credits/me")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["unit"], "credit")
        self.assertAlmostEqual(payload["usd_per_credit"], 0.1)
        self.assertAlmostEqual(payload["markup"], 1.3)
        self.assertEqual(payload["tier"], "gold")
        self.assertIn("balance", payload)

        response = client.get("/api/credits/transactions", params={"limit": 5})
        self.assertEqual(response.status_code, 200)
        self.assertLessEqual(len(response.json()["transactions"]), 5)


class PricingTests(unittest.TestCase):
    def test_nano_banana_aliases_use_official_pricing(self):
        """alias_map 的这三个别名必须落到 -official 版（同文件 models[...].aliases 与文档
        L1988 / L3337 都这么声明）。回归点：曾指向非官方版，少收 3.9~5.4 倍。"""
        cases = {
            "nano-banana": ("gemini-2.5-flash-image-preview-official", 0.0312),
            "nano-banana-pro": ("gemini-3-pro-image-preview-official", 0.1072),
            "nano-banana-2": ("gemini-3.1-flash-image-preview-official", 0.0536),
            # 压缩拼写不能让别名绕过（resolve_model 会退到 compact 别名）
            "nanobanana": ("gemini-2.5-flash-image-preview-official", 0.0312),
            "nanobananapro": ("gemini-3-pro-image-preview-official", 0.1072),
            "nanobanana2": ("gemini-3.1-flash-image-preview-official", 0.0536),
        }
        for alias, (target, gold) in cases.items():
            record, fallback, _unmapped = pricing.resolve_model(alias, "image")
            self.assertFalse(fallback, alias)
            self.assertEqual(record["id"], target, alias)
            quote = pricing.estimate("image", alias, {"rows": 1})
            self.assertEqual(quote["model"], target, alias)
            self.assertFalse(quote["pricing_fallback"], alias)
            self.assertAlmostEqual(quote["cost_usd"], gold, places=6)
        # -ext 系列对的是非官方/ext 通道，不能一起改
        self.assertEqual(pricing.resolve_model("nano-banana-ext", "image")[0]["id"],
                         "gemini-2.5-flash-image-preview")

    def test_image_resolution_tiers(self):
        low = pricing.estimate("image", "flux-3-image-klein", {"width": 1024, "height": 1024})
        high = pricing.estimate("image", "flux-3-image-klein", {"width": 2880, "height": 2880})
        self.assertEqual(low["matched_spec"], "1K")
        self.assertEqual(high["matched_spec"], "4K")
        self.assertGreater(high["cost"], low["cost"])
        self.assertFalse(low["pricing_fallback"])
        self.assertGreater(low["price"], low["cost"])

    def test_kling_v4_image_new_tiers_include_8k(self):
        """2026-11-25 新增 kling-v4-image：2K/4K/8K 三档，8K 必须能被估价（旧口径只认到 4K）。"""
        two_k = pricing.estimate("image", "kling-v4-image", {"size": "2048x2048", "rows": 1})
        eight_k = pricing.estimate("image", "kling-v4-image", {"size": "8192x8192", "rows": 1})
        self.assertEqual(two_k["matched_spec"], "2K")
        self.assertEqual(eight_k["matched_spec"], "8K")
        self.assertAlmostEqual(two_k["cost_usd"], 0.0571432, places=6)
        self.assertAlmostEqual(eight_k["cost_usd"], 0.1428568, places=6)
        self.assertFalse(eight_k["pricing_fallback"])

    def test_mai_image_2_7_tiered_token_uses_precharge_tier(self):
        """mai-image-2.7 是 tiered_token（image_modalities）+ 按档预扣：估价走 1K/2K 预扣价，
        不能因为 token_rates 存在就按纯 token 计（那样会漏掉按档差价）。"""
        one_k = pricing.estimate("image", "mai-image-2.7", {"size": "1024x1024", "rows": 1})
        two_k = pricing.estimate("image", "mai-image-2.7", {"size": "2048x2048", "rows": 1})
        self.assertEqual(one_k["matched_spec"], "1K")
        self.assertEqual(two_k["matched_spec"], "2K")
        self.assertEqual(one_k["unit"], "per_image")
        self.assertAlmostEqual(one_k["cost_usd"], 0.028, places=6)
        self.assertAlmostEqual(two_k["cost_usd"], 0.112, places=6)
        self.assertFalse(one_k["pricing_fallback"])

    def test_kling_v4_long_image_default_is_1k_medium(self):
        """kling-v4-long-image 的 skill/length 在请求参数里看不到：没给尺寸时按接口默认档 1K-MEDIUM 估。"""
        quote = pricing.estimate("image", "kling-v4-long-image", {"rows": 1})
        self.assertEqual(quote["matched_spec"], "1K-MEDIUM")
        self.assertAlmostEqual(quote["cost_usd"], 0.4285712, places=6)
        self.assertFalse(quote["pricing_fallback"])

    def test_veo_ext_tiers_split_by_resolution(self):
        """veo3.1 ext 档改成 720P/1080P/4K 三档（2026-11-25 报价接口）；4k 没有数字后缀也要选中 4K 档。"""
        hd = pricing.estimate("video", "veo3.1-quality-ext", {"duration": 8, "height": 1080})
        uhd = pricing.estimate("video", "veo3.1-quality-ext", {"duration": 8, "resolution": "4k"})
        self.assertEqual(hd["matched_spec"], "1080P")
        self.assertEqual(uhd["matched_spec"], "4K")
        self.assertAlmostEqual(hd["cost_usd"], 0.58125 * 8, places=6)
        self.assertAlmostEqual(uhd["cost_usd"], 0.7125 * 8, places=6)

    def test_veo_ext_aliases_resolve_to_real_models(self):
        """veo3.1-*-ext 是 veo3.1-fast/quality/lite 的等价别名（文档 L47579）：
        alias_map 不许自映射空转，三个 ID 都必须查到非零价。"""
        payload = pricing.load()
        aliases = payload.get("alias_map") or {}
        # fast-ext 没有独立 models 行 → 指到真实行；quality/lite-ext 自带 models 行 → 删自映射直查
        self.assertEqual(aliases.get("veo3.1-fast-ext"), "veo3.1-fast-ext（veo3.1-fast）")
        for key in ("veo3.1-quality-ext", "veo3.1-lite-ext"):
            self.assertNotIn(key, aliases, key)
            self.assertIn(key, payload["models"], key)
        for model in ("veo3.1-fast-ext", "veo3.1-quality-ext", "veo3.1-lite-ext"):
            record, fallback, _unmapped = pricing.resolve_model(model, "video")
            self.assertFalse(fallback, model)
            self.assertTrue(record.get("tiers"), model)
            quote = pricing.estimate("video", model, {"duration": 8, "resolution": "720p"})
            self.assertFalse(quote["pricing_fallback"], model)
            self.assertGreater(quote["cost_usd"], 0, model)
            self.assertGreater(quote["cost"], 0, model)

    def test_offline_model_ids_have_no_alias_entry(self):
        """2026-11-27 实测已下线 / 不存在的 7 个 ID：别名键清掉，避免查价被别名命中。
        models 行保留作历史价档（不再被任何存活别名指向）。"""
        payload = pricing.load()
        aliases = payload.get("alias_map") or {}
        dead = ("deepseek-r1-250528", "deepseek-v3.2-exp", "deepseek-v3-0324", "gpt-5-chat-latest",
                "gpt-5.2-codex", "gemini-2.5-flash-lite", "seedance-1-5-pro")
        for model in dead:
            self.assertNotIn(model.upper().lower(), aliases, model)
        leaked = [key for key, value in aliases.items() if value in dead]
        self.assertEqual(leaked, [], "别名仍指向已下线 ID")

    def test_magi_2_per_second_price(self):
        """magi-2（2026-11-26 报价接口）：固定 1080P、per_second gold 0.08 → 估价 = 0.08 × 秒数。"""
        five = pricing.estimate("video", "magi-2", {"duration": 5, "resolution": "1080p"})
        twelve = pricing.estimate("video", "magi-2", {"duration": 12, "resolution": "1080p"})
        self.assertEqual(five["matched_spec"], "1080P")
        self.assertFalse(five["pricing_fallback"])
        self.assertEqual(five["unit"], "per_second")
        self.assertAlmostEqual(five["cost_usd"], 0.08 * 5, places=6)
        self.assertAlmostEqual(twelve["cost_usd"], 0.08 * 12, places=6)
        self.assertAlmostEqual(five["cost"], 4.0, places=6)  # credits = usd × 10

    def test_claude_base_ids_resolve_to_dated_models(self):
        """定价页 2026-11-26 把展示名改成基础 ID：claude-*-4-5 用 alias_map 指到日期版，价格逐档一致。"""
        cases = {
            "claude-haiku-4-5": ("claude-haiku-4-5-20251001", 0.8, 4.0),
            "claude-sonnet-4-5": ("claude-sonnet-4-5-20250929", 2.4, 12.0),
            "claude-opus-4-5": ("claude-opus-4-5-20251101", 4.0, 20.0),
        }
        for base, (target, input_gold, output_gold) in cases.items():
            record, fallback, _unmapped = pricing.resolve_model(base, "chat")
            self.assertFalse(fallback, base)
            self.assertEqual(record["id"], target, base)
            quote = pricing.estimate("chat", base, {"tokens_in": 1000000, "tokens_out": 1000000})
            self.assertFalse(quote["pricing_fallback"], base)
            self.assertAlmostEqual(quote["cost_usd"], input_gold + output_gold, places=6)

    def test_video_per_second_scales_with_duration(self):
        five = pricing.estimate("video", "seedance-2.5", {"duration": 5, "height": 720})
        ten = pricing.estimate("video", "seedance-2.5", {"duration": 10, "height": 720})
        self.assertAlmostEqual(ten["cost"], five["cost"] * 2, places=4)
        self.assertGreater(ten["price"], ten["cost"])
        self.assertEqual(five["unit"], "per_second")

    def test_seedance_draft_billing_uses_480p(self):
        """草稿按 480p 预扣：用户传 4k 也只扣 480P 档，不能按成片全价扣。"""
        payload = main.CanvasVideoRequest(
            prompt="draft", provider_id="apimart", model="seedance-2.5",
            duration=8, resolution="4k", draft=True)
        params = main._credits_video_params(payload)
        self.assertEqual(params["resolution"], "480p")
        self.assertEqual(params["height"], 480)
        self.assertIs(params.get("draft"), True)
        quote = pricing.estimate("video", "seedance-2.5", params)
        self.assertEqual(quote["matched_spec"], "480P")
        self.assertFalse(quote["pricing_fallback"])

    def test_seedance_draft_auto_duration_reserves_30s(self):
        payload = main.CanvasVideoRequest(
            prompt="draft auto", provider_id="apimart", model="seedance-2.5",
            duration=-1, draft=True)
        params = main._credits_video_params(payload)
        self.assertEqual(params["duration"], 30)

    def test_seedance_draft_final_uses_input_tier_and_draft_duration(self):
        """成片：有原始参考视频时走 1080P-input；输出时长沿用草稿（11 秒）。"""
        draft_payload = main.CanvasVideoRequest(
            prompt="draft", provider_id="apimart", model="seedance-2.5", duration=11,
            videos=["https://example.com/ref.mp4"])
        main.apimart_draft_context_record("task_draft_pricing_x", draft_payload, 11)
        self.addCleanup(main.APIMART_DRAFT_CONTEXT.pop, "task_draft_pricing_x", None)
        final_payload = main.CanvasVideoRequest(
            prompt="final", provider_id="apimart", model="seedance-2.5",
            draft_task_id="task_draft_pricing_x", resolution="1080p")
        params = main._credits_video_params(final_payload)
        self.assertEqual(params["resolution"], "1080p")
        self.assertEqual(params["duration"], 11)
        self.assertIs(params["video_input"], True)
        quote = pricing.estimate("video", "seedance-2.5", params)
        self.assertEqual(quote["matched_spec"], "1080P-input")
        draft_quote = pricing.estimate("video", "seedance-2.5", main._credits_video_params(
            main.CanvasVideoRequest(prompt="draft", provider_id="apimart", model="seedance-2.5",
                                    duration=11, draft=True)))
        self.assertLess(draft_quote["cost_usd"], quote["cost_usd"])

    def test_whisper_per_minute_tier(self):
        """per_minute 单位的最小支持：引擎能选中 per_minute 档并按分钟计价。
        duration 是秒：120s → 2 分钟 × 0.006 USD；没给时长按 1 分钟（不按 0 漏算）。
        注意 APIMart 语音模型在 model_map 里是 postpaid（按 usage 结算，见 speech.py），
        这里用 direct 映射单测计价公式本身，不代表线上 whisper 会预扣。"""
        with mock.patch.object(model_map, "lookup",
                               return_value={"mode": "direct", "target": "whisper-1"}):
            two_minutes = pricing.estimate("audio", "whisper-1", {"duration": 120, "rows": 1})
            unknown = pricing.estimate("audio", "whisper-1", {"rows": 1})
        self.assertEqual(two_minutes["unit"], "per_minute")
        self.assertEqual(two_minutes["matched_spec"], "default")
        self.assertAlmostEqual(two_minutes["cost_usd"], 0.012, places=6)
        self.assertAlmostEqual(two_minutes["cost"], 0.12, places=6)
        self.assertAlmostEqual(two_minutes["minutes"], 2.0, places=6)
        self.assertFalse(two_minutes["pricing_fallback"])
        self.assertAlmostEqual(unknown["cost_usd"], 0.006, places=6)
        self.assertAlmostEqual(unknown["minutes"], 1.0, places=6)

    def test_speech_models_stay_postpaid_and_do_not_undercut_prepaid(self):
        """2026-11-26 补了 3 条语音价目（gpt-audio-mini / gpt-4o-mini-tts / whisper-1），但他们的
        model_map 映射是 postpaid（按 usage 结算，真实成本见 speech.py）；预扣兼容模式
        （本测试文件全局 CREDIT_BILLING_MODE=prepaid）会落回 conservative，不会因为新价目把
        TTS/转写的预扣价从 0.96 USD/次 悄悄改小。"""
        for model in ("gpt-audio-mini", "gpt-4o-mini-tts", "whisper-1"):
            mapping = model_map.lookup("apimart", "audio", model)
            self.assertEqual(mapping.get("mode"), "postpaid", model)
            record, fallback, _unmapped = pricing.resolve_model(model, "audio")
            self.assertFalse(fallback, model)
            self.assertEqual(record["category"], "audio", model)
            quote = pricing.estimate("audio", model, {"rows": 1})
            self.assertTrue(quote["pricing_fallback"], model)
            self.assertEqual(quote["unit"], "per_call", model)
            self.assertAlmostEqual(quote["cost_usd"], 0.96, places=6)

    def test_audio_per_call(self):
        quote = pricing.estimate("audio", "suno", {"rows": 1})
        self.assertEqual(quote["unit"], "per_call")
        self.assertEqual(quote["cost"], 0.5)  # 0.05 USD / 0.1
        self.assertGreater(quote["price"], quote["cost"])

    def test_midjourney_per_call_split_across_candidates(self):
        """Midjourney imagine：一次提交回 4 张候选、上游只收一次钱 → 画布按张卖就把这次的钱摊到 4 张上。
        回归点：修之前 rows=4 按「单次价 × 4」收 0.18016 USD（把一次的钱收四遍）。"""
        one = pricing.estimate("image", "midjourney", {"rows": 1})
        two = pricing.estimate("image", "midjourney", {"rows": 2})
        four = pricing.estimate("image", "midjourney", {"rows": 4})
        for quote in (one, two, four):
            self.assertEqual(quote["unit"], "per_call")
            self.assertEqual(quote["matched_spec"], "default")
            self.assertFalse(quote["pricing_fallback"])
        self.assertAlmostEqual(one["cost_usd"], 0.01126, places=6)
        self.assertAlmostEqual(two["cost_usd"], 0.02252, places=6)
        # 「4 张的总价 == 一次调用的价」：一张只扣一次
        self.assertAlmostEqual(four["cost_usd"], 0.04504, places=6)
        self.assertAlmostEqual(four["cost"], 0.4504, places=6)
        self.assertAlmostEqual(two["cost_usd"], four["cost_usd"] / 2, places=6)
        # 结算兜底（conservative）也必须落在同一档：这张价目把 imagine / video 共用一个 record，
        # 取「全表最高 per_call」会把 video 的 0.4 USD 当成 imagine 最高成本，结算时把 0.59 抬到 5.2。
        floor = pricing.estimate("image", "midjourney", {"rows": 4}, conservative=True)
        self.assertAlmostEqual(floor["cost_usd"], 0.04504, places=6)

    def test_midjourney_split_only_touches_imagine_per_call(self):
        """分摊只对 imagine（image + per_call）生效：同表的 video 档、per_image 分支都不许动。"""
        # midjourney@video 是单次价（不是 4 张候选），不能被除 4
        video_one = pricing.estimate("image", "midjourney@video", {"rows": 1})
        video_two = pricing.estimate("image", "midjourney@video", {"rows": 2})
        self.assertEqual(video_one["unit"], "per_call")
        self.assertAlmostEqual(video_one["cost_usd"], 0.2, places=6)
        self.assertAlmostEqual(video_two["cost_usd"], 0.4, places=6)
        # per_image：flux 1K 4 张仍是 4 × 0.0072
        flux_one = pricing.estimate("image", "flux-3-image-klein", {"rows": 1, "width": 1024, "height": 1024})
        flux_four = pricing.estimate("image", "flux-3-image-klein", {"rows": 4, "width": 1024, "height": 1024})
        self.assertEqual(flux_four["unit"], "per_image")
        self.assertAlmostEqual(flux_four["cost_usd"], flux_one["cost_usd"] * 4, places=6)
        self.assertAlmostEqual(flux_four["cost_usd"], 0.0288, places=6)
        # proxy 最高档的对照模型也没被碰（gpt-image-2 走 max:4K，4 张 = 4 × 0.022）
        gpt_one = pricing.estimate("image", "gpt-image-2", {"rows": 1, "width": 1024, "height": 1024})
        gpt_four = pricing.estimate("image", "gpt-image-2", {"rows": 4, "width": 1024, "height": 1024})
        self.assertAlmostEqual(gpt_four["cost_usd"], gpt_one["cost_usd"] * 4, places=6)
        self.assertAlmostEqual(gpt_four["cost_usd"], 0.088, places=6)

    def test_text_per_token(self):
        quote = pricing.estimate("text", "gpt-4o-mini", {"tokens_in": 100000, "tokens_out": 10000})
        bigger = pricing.estimate("text", "gpt-4o-mini", {"tokens_in": 200000, "tokens_out": 20000})
        self.assertEqual(quote["unit"], "per_1m_tokens")
        self.assertGreater(quote["cost"], 0)
        self.assertAlmostEqual(bigger["cost"], quote["cost"] * 2, places=3)
        self.assertEqual(quote["model"], "GPT-4o Mini")
        self.assertGreater(quote["price"], quote["cost"])

    def test_two_decimal_examples(self):
        # 验收口径：文本 0.00002 成本 → 0.01；图片 0.072 → 0.10；视频 1.19 → 1.55；TTS 0.00313 → 0.01
        self.assertAlmostEqual(pricing.price_for_cost(0.00002), 0.01)
        self.assertAlmostEqual(pricing.price_for_cost(0.072), 0.10)
        self.assertAlmostEqual(pricing.price_for_cost(1.19), 1.55)
        self.assertAlmostEqual(pricing.price_for_cost(1.0), 1.30)
        self.assertAlmostEqual(pricing.price_for_cost(0.00313), 0.01)
        for cost in (0.0, 0.00002, 0.072, 1.0, 0.00313):
            self.assertGreater(pricing.price_for_cost(cost), cost)

    def test_unmapped_falls_back_with_visibility(self):
        quote = pricing.estimate("image", "no-such-model-xyz", {"width": 1024, "height": 1024})
        self.assertTrue(quote["pricing_fallback"])
        self.assertIn("no-such-model-xyz", quote["unmapped"])
        self.assertTrue(quote["fallback_model"])

    def test_markup_strictly_greater_and_step_aligned(self):
        step = config.price_step()
        self.assertAlmostEqual(step, 0.01)
        for cost in (0.0, 0.000018, 0.0001, 0.01, 0.072, 0.1, 1.0, 12.345, 99.999):
            price = pricing.price_for_cost(cost)
            self.assertGreater(price, cost)
            self.assertAlmostEqual(price / step, round(price / step), places=6)
            self.assertGreater(round(price - cost, 10), 0)


class CoverageAndPrecisionTests(unittest.TestCase):
    def test_every_pricing_tier_price_above_cost(self):
        """价目表每个模型/规格：price > cost，profit > 0（含 0 价档按一个 step 收）。"""
        data = pricing.load()
        checked = 0
        for model_id, record in (data.get("models") or {}).items():
            for tier in record.get("tiers") or []:
                usd = (tier.get("gold") or {}).get("usd")
                if usd is None:
                    continue
                cost = float(usd) / config.usd_per_credit()
                price = pricing.price_for_cost(cost)
                self.assertGreater(price, cost, "%s %s price<=cost" % (model_id, tier.get("spec")))
                self.assertGreater(round(price - cost, 10), 0, "%s %s profit<=0" % (model_id, tier.get("spec")))
                checked += 1
        self.assertGreater(checked, 300)

    def test_every_provider_model_has_price_and_source(self):
        """123 个 provider 模型全部有价，来源只允许 direct/proxy/conservative，uncovered=0。"""
        result = credits_audit.audit()
        self.assertTrue(result["ok"], result["counts"])
        coverage = result["coverage"]
        self.assertEqual(int(coverage.get("configured_models") or 0), 123)
        self.assertEqual(int(coverage.get("uncovered") or 0), 0)
        self.assertEqual(result["counts"]["uncovered"], 0)
        rows = result["rows"]
        self.assertGreaterEqual(len(rows), 123)
        for row in rows:
            self.assertIn(row["pricing_source"], ("direct", "proxy", "conservative", "postpaid"))
            if row["mode"] == "postpaid":
                # 默认后付费时 price=0；显式 prepaid 兼容模式下可能展示预扣估价
                continue
            self.assertGreater(float(row["price"]), 0, row)
            self.assertGreater(float(row["profit"]), 0, row)
        self.assertGreater(result["counts"]["proxy"], 0)
        self.assertGreater(result["counts"]["conservative"], 0)

    def test_provider_audit_api(self):
        client = admin_client()
        response = client.get("/api/credits/audit")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["coverage"]["uncovered"], 0)

    def test_text_15_tokens_precision(self):
        quote = pricing.estimate("text", "gpt-4o-mini", {"tokens_in": 15, "tokens_out": 0})
        self.assertLessEqual(quote["price"], 0.01)
        self.assertGreater(quote["price"], quote["cost"])
        self.assertAlmostEqual(quote["price"], 0.01)


class ChargeLifecycleTests(unittest.TestCase):
    def test_settlement_actual_double_estimate(self):
        """actual = 预估 2 倍：结算补扣到 actual×1.3（0.026），余额可负，profit>0。"""
        uid = create_named_user(0.01)[0]
        charge = store.create_charge(
            uid, estimate=0.01, kind="image", model="flux-3-image-klein",
            params={"width": 1024, "height": 1024}, estimate_cost=0.0001,
            cost_usd=0.00001, price_usd=0.001, profit_usd=0.00099,
            provider="apimart", pricing_source="direct",
        )
        settled = service.charge_settle(charge["id"], actual_cost_usd=0.002, actual=True)
        # 0.002 USD = 0.02 积分成本 → ceil(0.02×1.3/0.01)=0.03
        self.assertAlmostEqual(settled["charged"], 0.03)
        self.assertAlmostEqual(settled["cost_usd"], 0.002)
        self.assertGreater(settled["profit_usd"], 0)
        self.assertAlmostEqual(store.balance(uid), -0.02)
        self.assertLess(store.balance(uid), 0)

    def test_settlement_extra_charge_can_go_negative(self):
        """预扣 0.01、实际成本 0.1 积分 → 补扣到 0.13，余额允许为负，利润仍 > 0。"""
        uid = create_named_user(0.01)[0]
        charge = store.create_charge(
            uid, estimate=0.01, kind="image", model="flux-3-image-klein",
            params={"width": 1024, "height": 1024}, estimate_cost=0.0001,
            cost_usd=0.00001, price_usd=0.001, profit_usd=0.00099,
            provider="apimart", pricing_source="direct",
        )
        self.assertAlmostEqual(store.balance(uid), 0.0)
        settled = service.charge_settle(charge["id"], actual_cost_usd=0.01, actual=True)
        # 实际成本 0.1 积分 → 售价 0.13；预扣 0.01，补扣 0.12
        self.assertAlmostEqual(settled["charged"], 0.13)
        self.assertAlmostEqual(settled["cost_usd"], 0.01)
        self.assertAlmostEqual(settled["profit_usd"], 0.003)
        self.assertAlmostEqual(store.balance(uid), -0.12)
        self.assertLess(store.balance(uid), 0)
        transactions = service.transactions(uid, limit=5)
        self.assertTrue(any(item["kind"] == "settle" and item["delta"] < 0 for item in transactions))

    def test_precharge_settle_and_refund(self):
        uid = unique_user(10.0)
        quote = pricing.estimate("image", "flux-3-image-klein", {"width": 1024, "height": 1024})
        charge = service.charge_start(uid, "image", "flux-3-image-klein", {"width": 1024, "height": 1024})
        self.assertEqual(charge["status"], "pending")
        self.assertAlmostEqual(charge["charged"], quote["price"])
        self.assertAlmostEqual(store.balance(uid), 10.0 - quote["price"])

        settled = service.charge_settle(charge["id"], actual_cost_usd=0.0036, actual=True)
        self.assertEqual(settled["status"], "settled")
        self.assertTrue(settled["actual"])
        # 实际成本 0.0036 USD = 0.036 积分 → 售价 ceil(0.036×1.3/0.01)=0.05
        expected = pricing.price_for_cost(0.036)
        self.assertAlmostEqual(settled["charged"], expected)
        self.assertAlmostEqual(store.balance(uid), 10.0 - expected)
        # 幂等：再结算一次余额不变
        service.charge_settle(charge["id"], actual_cost_usd=1.0, actual=True)
        self.assertAlmostEqual(store.balance(uid), 10.0 - expected)

        charge2 = service.charge_start(uid, "audio", "suno", {"rows": 1})
        before = store.balance(uid)
        refunded = service.charge_refund(charge2["id"], "test")
        self.assertEqual(refunded["status"], "refunded")
        self.assertAlmostEqual(store.balance(uid), before + charge2["charged"])

    def test_midjourney_four_images_precharge_and_settle_stay_at_one_call_price(self):
        """MJ 4 张：预扣与结算都停在一次调用的成本上（0.4504 积分），不会因为 4 张变成 1.8016。
        上游 MJ 回报只有 quota、没有 cost/credits_cost，所以结算沿用预扣（不退不加）。"""
        uid = unique_user(10.0)
        params = {"rows": 4}
        quote = pricing.estimate("image", "midjourney", params)
        self.assertAlmostEqual(quote["cost_usd"], 0.04504, places=6)
        charge = integration.credits_charge_start("image", "midjourney", params, user_id=uid)
        self.assertIsNotNone(charge)
        # 预扣按售价（成本 × 1.3 后向上取到 0.01 积分）→ 0.59；成本仍是 0.4504
        self.assertAlmostEqual(charge["charged"], quote["price"], places=4)
        self.assertAlmostEqual(charge["cost_usd"], 0.04504, places=6)
        settled = integration.credits_charge_settle(charge, result={"images": ["/assets/output/mj_%d.png" % i for i in range(4)]})
        self.assertIsNotNone(settled)
        detail = service.charges(user_id=uid, limit=1)[0]
        self.assertEqual(detail["status"], "settled")
        self.assertAlmostEqual(detail["charged"], charge["charged"], places=4)
        self.assertAlmostEqual(detail["cost_usd"], 0.04504, places=6)

    def test_task_delete_does_not_deadlock(self):
        """task_delete 在 TASK_STORE_LOCK 内不能回读 task（不可重入）；有/无扣费单都要能删。"""
        # 无扣费单：旧实现 task_delete -> _task_credit_refund -> task_get 会自锁死
        plain = main.task_create(kind="video", payload={"prompt": "x"}, runner_name="run_canvas_video_task")
        thread = threading.Thread(target=main.task_delete, args=(plain["id"],), daemon=True)
        thread.start()
        thread.join(2)
        self.assertFalse(thread.is_alive(), "task_delete 无扣费单时死锁")

        # 有扣费单：删除未结束任务要退款，且退款在锁外执行
        uid = unique_user(5.0)
        charge = service.charge_start(uid, "image", "flux-3-image-klein", {"width": 1024, "height": 1024})
        task = main.task_create(kind="video", payload={"prompt": "x"}, runner_name="run_canvas_video_task",
                                extra={"credits_charge_id": charge["id"]})
        before = store.balance(uid)
        thread = threading.Thread(target=main.task_delete, args=(task["id"],), daemon=True)
        thread.start()
        thread.join(2)
        self.assertFalse(thread.is_alive(), "task_delete 有扣费单时死锁")
        self.assertAlmostEqual(store.balance(uid), before + charge["charged"])
        self.assertEqual(service.charges(user_id=uid, limit=1)[0]["status"], "refunded")

    def test_task_cancel_refunds_and_blocks_late_settlement(self):
        uid = unique_user(10.0)
        charge = service.charge_start(uid, "image", "flux-3-image-klein", {"width": 1024, "height": 1024})
        task = main.task_create(kind="online-image", payload={"prompt": "x"},
                                runner_name="run_canvas_image_task", extra={"credits_charge_id": charge["id"]})
        main.task_set_status(task["id"], "running")
        before = store.balance(uid)
        response = main.asyncio.run(main.task_cancel(task["id"]))
        self.assertEqual(response["status"], "cancel_requested")
        self.assertEqual(response["credits"]["status"], "refunded")
        self.assertAlmostEqual(store.balance(uid), before + charge["charged"])

        main._task_credit_settle(task["id"], result={"images": ["late.png"]})
        main.task_set_status(task["id"], "succeeded")
        self.assertEqual(main.task_get(task["id"])["status"], "cancelled")
        self.assertAlmostEqual(store.balance(uid), before + charge["charged"])
        self.assertEqual(service.charges(user_id=uid, limit=1)[0]["status"], "refunded")

    def test_direct_cancelled_status_refunds_without_worker(self):
        uid = unique_user(5.0)
        charge = service.charge_start(uid, "image", "flux-3-image-klein", {"width": 1024, "height": 1024})
        task = main.task_create(kind="online-image", payload={"prompt": "x"},
                                runner_name="run_canvas_image_task", extra={"credits_charge_id": charge["id"]})
        before = store.balance(uid)
        main.task_set_status(task["id"], "cancelled", error="停止前清理")
        self.assertAlmostEqual(store.balance(uid), before + charge["charged"])
        self.assertEqual(service.charges(user_id=uid, limit=1)[0]["status"], "refunded")

    def test_failed_generation_refunds_via_api(self):
        uid = unique_user(5.0)
        client = TestClient(main.app)
        # 直接调用 integration，模拟失败分支
        charge = integration.credits_charge_start("image", "flux-3-image-klein",
                                                  {"width": 1024, "height": 1024}, user_id=uid)
        self.assertIsNotNone(charge)
        integration.credits_charge_refund(charge, "boom")
        self.assertAlmostEqual(store.balance(uid), 5.0)
        self.assertEqual(service.charges(user_id=uid, limit=5)[0]["status"], "refunded")

    def test_insufficient_credits_402_payload(self):
        uid = unique_user(0.05)
        with self.assertRaises(InsufficientCredits) as ctx:
            integration.credits_charge_start("video", "seedance-2.5", {"duration": 5}, user_id=uid)
        payload = ctx.exception.payload
        self.assertEqual(payload["code"], "INSUFFICIENT_CREDITS")
        self.assertGreater(payload["estimate"], payload["balance"])

    def test_concurrent_charges_do_not_overdraw(self):
        price = 0.1  # flux 1K 售价
        uid = unique_user(0.5)
        results = []
        lock = threading.Lock()

        def worker():
            try:
                service.charge_start(uid, "image", "flux-3-image-klein", {"width": 1024, "height": 1024})
                outcome = "ok"
            except InsufficientCredits:
                outcome = "insufficient"
            with lock:
                results.append(outcome)

        threads = [threading.Thread(target=worker) for _ in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(results.count("ok"), 5)
        self.assertEqual(results.count("insufficient"), 7)
        price = pricing.estimate("image", "flux-3-image-klein", {"width": 1024, "height": 1024})["price"]
        self.assertGreaterEqual(store.balance(uid), 0.0)
        self.assertAlmostEqual(store.balance(uid), round(0.5 - price * 5, 6), places=5)

    def test_ledger_consistency(self):
        uid = unique_user(20.0)
        initial = store.balance(uid)
        baseline_tx = service.transactions(uid, limit=1)[0]["id"]
        charge = service.charge_start(uid, "image", "flux-3-image-klein", {"width": 1024, "height": 1024})
        service.charge_settle(charge["id"], actual_cost_usd=0.001, actual=True)
        second = service.charge_start(uid, "audio", "suno", {"rows": 1})
        service.charge_refund(second["id"], "taxi")
        transactions = [item for item in service.transactions(uid, limit=100) if item["id"] > baseline_tx]
        self.assertAlmostEqual(sum(item["delta"] for item in transactions), store.balance(uid) - initial, places=5)
        replay = initial
        for item in sorted(transactions, key=lambda row: row["id"]):
            replay = round(replay + item["delta"], 6)
            self.assertAlmostEqual(item["balance_after"], replay, places=5)
        self.assertAlmostEqual(store.balance(uid), replay, places=5)


class GlobalPostpaidTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["CREDIT_BILLING_MODE"] = "postpaid"

    def test_default_mode_is_postpaid(self):
        old = os.environ.pop("CREDIT_BILLING_MODE", None)
        try:
            self.assertEqual(config.billing_mode(), "postpaid")
        finally:
            os.environ["CREDIT_BILLING_MODE"] = old or "postpaid"

    @classmethod
    def tearDownClass(cls):
        os.environ["CREDIT_BILLING_MODE"] = "prepaid"

    def test_price_all_kinds_postpaid_with_estimate(self):
        client = admin_client()
        cases = [
            ({"model": "flux-3-image-klein", "kind": "image", "width": 1024, "height": 1024}),
            ({"model": "seedance-2.5", "kind": "video", "duration": 5, "height": 720}),
            ({"model": "gpt-4o-mini", "kind": "text", "tokens_in": 100, "tokens_out": 50}),
            ({"model": "suno", "kind": "audio"}),
        ]
        for params in cases:
            params["provider"] = "apimart"
            response = client.get("/api/credits/price", params=params)
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertEqual(payload["mode"], "postpaid")
            self.assertTrue(payload["postpaid"])
            self.assertAlmostEqual(float(payload["price"]), 0.0)
            self.assertIn("生成后按实际用量扣费", payload.get("message", ""))
            self.assertIn("estimated_cost", payload)
            self.assertIn("estimated_price", payload)
            self.assertAlmostEqual(payload["overdraft_limit"], 0.01)

    def test_funded_image_actual_cost(self):
        uid, username, password = create_named_user(1.0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def fake_image(payload):
            return {"images": ["/output/fake.png"], "model": "flux-3-image-klein",
                    "provider_id": "apimart", "cost": 0.0072}

        with mock.patch.object(main, "build_online_image_result", fake_image):
            response = client.post("/api/online-image", json={
                "prompt": "cat", "provider_id": "apimart", "model": "flux-3-image-klein",
                "size": "1024x1024", "quality": "auto", "n": 1})
        self.assertEqual(response.status_code, 200, response.text)
        credits = response.json().get("credits") or {}
        self.assertEqual(credits.get("mode"), "postpaid")
        self.assertAlmostEqual(credits.get("actual_cost_usd"), 0.0072)
        self.assertAlmostEqual(credits.get("cost_usd"), 0.0072)
        self.assertAlmostEqual(credits.get("price"), 0.10)
        self.assertTrue(credits.get("actual"))
        self.assertEqual(credits.get("cost_source"), "cost")
        self.assertEqual(credits.get("pricing_source"), "upstream")
        self.assertGreater(credits.get("profit_usd"), 0)
        self.assertGreater(credits.get("balance_after"), 0)
        self.assertAlmostEqual(store.balance(uid), 1.0 - credits["price"], places=5)

    def test_zero_balance_text_allowed_twice(self):
        uid, username, password = create_named_user(0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def fake_llm(payload):
            return {"text": "hi", "model": "gpt-4o-mini",
                    "raw_usage": {"prompt_tokens": 10, "completion_tokens": 1}}

        with mock.patch.object(main, "_canvas_llm_impl", fake_llm):
            first = client.post("/api/canvas-llm", json={
                "message": "hi", "provider": "apimart", "model": "gpt-4o-mini"})
            self.assertEqual(first.status_code, 200, first.text)
            self.assertAlmostEqual(store.balance(uid), -0.01)
            second = client.post("/api/canvas-llm", json={
                "message": "hi", "provider": "apimart", "model": "gpt-4o-mini"})
            self.assertEqual(second.status_code, 402, second.text)

    def test_zero_balance_image_blocked_by_overdraft(self):
        uid, username, password = create_named_user(0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)
        response = client.post("/api/online-image", json={
            "prompt": "cat", "provider_id": "apimart", "model": "flux-3-image-klein",
            "size": "1024x1024", "quality": "auto", "n": 1})
        self.assertEqual(response.status_code, 402, response.text)
        payload = response.json()
        self.assertEqual(payload["code"], "INSUFFICIENT_CREDITS")
        self.assertAlmostEqual(payload["balance"], 0.0)
        self.assertAlmostEqual(payload["overdraft_limit"], 0.01)
        self.assertGreater(payload["estimate"], 0.01)

    def test_negative_balance_within_limit_can_generate(self):
        uid, username, password = create_named_user(0)
        force_balance(uid, -0.005)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def fake_llm(payload):
            return {"text": "hi", "model": "gpt-4o-mini",
                    "raw_usage": {"prompt_tokens": 10, "completion_tokens": 1}}

        with mock.patch.object(main, "_canvas_llm_impl", fake_llm):
            response = client.post("/api/canvas-llm", json={
                "message": "hi", "provider": "apimart", "model": "gpt-4o-mini"})
        self.assertEqual(response.status_code, 200, response.text)

        force_balance(uid, -0.02)
        blocked = client.post("/api/canvas-llm", json={
            "message": "hi", "provider": "apimart", "model": "gpt-4o-mini"})
        self.assertEqual(blocked.status_code, 402, blocked.text)
        image_blocked = client.post("/api/online-image", json={
            "prompt": "cat", "provider_id": "apimart", "model": "flux-3-image-klein",
            "size": "1024x1024", "quality": "auto", "n": 1})
        self.assertEqual(image_blocked.status_code, 402, image_blocked.text)

    def test_actual_cost_over_limit_marks_flag_and_blocks_next(self):
        uid = create_named_user(0)[0]
        # 直接构造一单实际成本 0.01 USD，结算后余额 -0.13 < -0.01
        charge = integration.credits_charge_start("text", "gpt-4o-mini",
                                                  {"tokens_in": 10, "tokens_out": 1}, user_id=uid,
                                                  provider="apimart")
        settled = service.charge_settle(charge["id"], actual_cost_usd=0.01, actual=True)
        self.assertLess(store.balance(uid), -0.01)
        self.assertTrue(settled["credits"]["overdrawn_over_limit"])
        self.assertAlmostEqual(store.balance(uid), -0.13, places=2)
        with self.assertRaises(InsufficientCredits):
            integration.credits_charge_start("text", "gpt-4o-mini",
                                             {"tokens_in": 10, "tokens_out": 1}, user_id=uid,
                                             provider="apimart")

    def test_debtors_endpoint_lists_negative_balance(self):
        uid = create_named_user(0.1)[0]
        charge = integration.credits_charge_start("image", "flux-3-image-klein",
                                                  {"width": 1024, "height": 1024}, user_id=uid,
                                                  provider="apimart")
        service.charge_settle(charge["id"], actual_cost_usd=0.5, actual=True)
        self.assertLess(store.balance(uid), 0)
        client = admin_client()
        response = client.get("/api/credits/debtors")
        self.assertEqual(response.status_code, 200)
        ids = [int(item["id"]) for item in response.json()["users"]]
        self.assertIn(uid, ids)
        over = client.get("/api/credits/debtors", params={"over_limit": "true"}).json()
        self.assertIn(uid, [int(item["id"]) for item in over["users"]])
        self.assertTrue(all(item["over_limit"] for item in over["users"]))

    def test_funded_image_estimate_when_cost_missing(self):
        uid, username, password = create_named_user(1.0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def fake_image(payload):
            return {"images": ["/output/fake.png"], "model": "flux-3-image-klein"}

        with mock.patch.object(main, "build_online_image_result", fake_image):
            response = client.post("/api/online-image", json={
                "prompt": "cat", "provider_id": "apimart", "model": "flux-3-image-klein",
                "size": "1024x1024", "quality": "auto", "n": 1})
        self.assertEqual(response.status_code, 200, response.text)
        credits = response.json().get("credits") or {}
        self.assertEqual(credits.get("mode"), "postpaid")
        self.assertFalse(credits.get("actual"))
        self.assertEqual(credits.get("pricing_source"), "estimate")
        self.assertEqual(credits.get("cost_source"), "estimate")
        self.assertGreater(credits.get("price_usd"), 0)
        self.assertLess(credits.get("balance_after"), 1.0)

    def test_zero_balance_text_actual_usage(self):
        uid, username, password = create_named_user(0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def fake_llm(payload):
            return {"text": "hi", "model": "gpt-4o-mini",
                    "raw_usage": {"prompt_tokens": 100, "completion_tokens": 50}}

        with mock.patch.object(main, "_canvas_llm_impl", fake_llm):
            response = client.post("/api/canvas-llm", json={
                "message": "hi", "provider": "apimart", "model": "gpt-4o-mini"})
        self.assertEqual(response.status_code, 200, response.text)
        credits = response.json().get("credits") or {}
        self.assertEqual(credits.get("mode"), "postpaid")
        self.assertTrue(credits.get("actual"))
        self.assertEqual(credits.get("cost_source"), "usage")
        self.assertGreater(credits.get("price_usd"), credits.get("cost_usd"))
        self.assertLess(credits.get("balance_after"), 0)

    def test_table_rows_estimate_and_charge(self):
        uid = create_named_user(0.3)[0]
        charge = integration.credits_charge_start(
            "image", "flux-3-image-klein",
            {"width": 1024, "height": 1024, "rows": 3}, user_id=uid, provider="apimart")
        self.assertIsNotNone(charge)
        self.assertEqual(charge["mode"], "postpaid")
        self.assertAlmostEqual(charge["estimate"], 0.0)
        settled = service.charge_settle(charge["id"], actual_cost_usd=0.03, actual=True)
        self.assertTrue(settled["actual"])
        self.assertGreater(settled["charged"], 0)

    def test_funded_video_task(self):
        uid, username, password = create_named_user(50.0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def fake_video(payload):
            return {"videos": ["/output/fake.mp4"], "cost": 0.1}

        with mock.patch.object(main, "canvas_video_run", fake_video):
            response = client.post("/api/canvas-video", json={
                "prompt": "x", "provider_id": "apimart", "model": "veo3-fast", "duration": 5})
        self.assertEqual(response.status_code, 200, response.text)
        credits = response.json().get("credits") or {}
        self.assertEqual(credits.get("mode"), "postpaid")
        self.assertAlmostEqual(credits.get("cost_usd"), 0.1)
        self.assertGreater(credits.get("price_usd"), 0.1)
        self.assertLess(credits.get("balance_after"), 50.0)

    def test_failure_closes_pending_without_charge(self):
        uid, username, password = create_named_user(0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def boom(payload):
            raise main.HTTPException(status_code=502, detail="upstream boom")

        with mock.patch.object(main, "generate_canvas_tts", boom):
            response = client.post("/api/canvas-tts", json={
                "provider_id": "apimart", "model": "gpt-4o-mini-tts", "input": "hi"})
        self.assertEqual(response.status_code, 502)
        self.assertAlmostEqual(store.balance(uid), 0.0)
        self.assertEqual(service.charges(user_id=uid, limit=1)[0]["status"], "refunded")

    def test_concurrent_postpaid_no_lost_charges(self):
        uid = create_named_user(0)[0]
        quote = pricing.postpaid_quote("text", "gpt-4o-mini", {"tokens_in": 10, "tokens_out": 1}, "apimart")
        charges = []
        lock = threading.Lock()
        barrier = threading.Barrier(8)

        def worker():
            # 先并发建单（此时余额 0，所有单都应允许），再一起结算，验证不丢单
            charge = service.charge_start(uid, "text", "gpt-4o-mini",
                                          {"tokens_in": 10, "tokens_out": 1}, estimate=quote,
                                          provider="apimart")
            barrier.wait(timeout=5)
            settled = service.charge_settle(charge["id"], actual_cost_usd=0.001, actual=True)
            with lock:
                charges.append(settled)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(charges), 8)
        self.assertTrue(all(item["status"] == "settled" for item in charges))
        self.assertLess(store.balance(uid), 0)
        self.assertEqual(len(service.charges(user_id=uid, limit=20)), 8)

    def test_prepaid_mode_still_works(self):
        os.environ["CREDIT_BILLING_MODE"] = "prepaid"
        try:
            uid = create_named_user(0)[0]
            with self.assertRaises(InsufficientCredits):
                integration.credits_charge_start("image", "flux-3-image-klein",
                                                  {"width": 1024, "height": 1024}, user_id=uid)
        finally:
            os.environ["CREDIT_BILLING_MODE"] = "postpaid"


class PostpaidSpeechTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["CREDIT_BILLING_MODE"] = "postpaid"

    @classmethod
    def tearDownClass(cls):
        os.environ["CREDIT_BILLING_MODE"] = "prepaid"

    def test_price_api_returns_postpaid_not_12_48(self):
        client = admin_client()
        response = client.get("/api/credits/price", params={
            "model": "gpt-4o-mini-tts", "kind": "audio", "provider": "apimart"})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["mode"], "postpaid")
        self.assertTrue(payload["postpaid"])
        self.assertEqual(float(payload["price"]), 0.0)
        self.assertNotEqual(float(payload["price"]), 12.48)
        self.assertIn("生成后按实际用量扣费", payload.get("message", ""))

    def test_tts1_official_character_cost(self):
        from server.credits import speech
        info = speech.estimate_speech_cost("tts-1", {"characters": 11})
        self.assertIsNotNone(info)
        self.assertAlmostEqual(info["usd"], 11 * 15.0 / 1_000_000, places=10)
        self.assertEqual(info["source"], "openai_official")
        price = pricing.price_for_cost(info["usd"] / config.usd_per_credit())
        self.assertAlmostEqual(price, 0.01)
        self.assertGreater(price, info["usd"] / config.usd_per_credit())

    def test_balance_zero_tts_submits_and_settles_actual_usage(self):
        uid, username, password = create_named_user(0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def fake_tts(payload):
            return {"audios": ["/output/fake.wav"], "model": "gpt-4o-mini-tts",
                    "characters": 11,
                    "usage": {"characters": 11, "seconds": 1.0, "bytes": 1000}}

        with mock.patch.object(main, "generate_canvas_tts", fake_tts):
            response = client.post("/api/canvas-tts", json={
                "provider_id": "apimart", "model": "gpt-4o-mini-tts",
                "input": "hello world", "voice": "alloy", "response_format": "wav",
            })
        self.assertEqual(response.status_code, 200, response.text)
        credits = response.json().get("credits") or {}
        self.assertEqual(credits.get("mode"), "postpaid")
        self.assertTrue(credits.get("postpaid"))
        self.assertAlmostEqual(credits.get("estimate"), 0.0)
        # 1 秒 gpt-4o-mini-tts = $0.00025 → 0.0025 积分 → 售价 0.0033
        self.assertAlmostEqual(credits.get("price"), 0.01)
        self.assertEqual(credits.get("cost_source"), "openai_official")
        self.assertEqual(credits.get("status"), "settled")
        self.assertLess(credits.get("balance_after"), 0)
        charge = service.charges(user_id=uid, limit=1)[0]
        self.assertEqual(charge["mode"], "postpaid")
        self.assertEqual(int(charge["actual"]), 1)
        self.assertIn("openai_official", charge["note"])
        self.assertAlmostEqual(store.balance(uid), -0.01)

    def test_postpaid_without_usage_is_unpriced_zero_charge(self):
        uid, username, password = create_named_user(0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def fake_tts(payload):
            return {"audios": ["/output/fake.wav"], "model": "gpt-4o-mini-tts"}

        with mock.patch.object(main, "generate_canvas_tts", fake_tts):
            response = client.post("/api/canvas-tts", json={
                "provider_id": "apimart", "model": "gpt-4o-mini-tts",
                "input": "hello", "voice": "alloy", "response_format": "wav",
            })
        self.assertEqual(response.status_code, 200, response.text)
        credits = response.json().get("credits") or {}
        self.assertEqual(credits.get("mode"), "postpaid")
        self.assertEqual(credits.get("status"), "unpriced")
        self.assertAlmostEqual(credits.get("price"), 0.0)
        self.assertAlmostEqual(store.balance(uid), 0.0)
        charge = service.charges(user_id=uid, limit=1)[0]
        self.assertEqual(charge["status"], "unpriced")
        self.assertIn("unpriced", charge["note"])


class ProviderVisibilityTests(unittest.TestCase):
    FAKE_PROVIDERS = [
        {"id": "apimart", "name": "APIMART", "base_url": "https://apib.ai", "protocol": "apimart",
         "enabled": True, "image_models": ["flux-3-image-klein"], "chat_models": ["gpt-4o-mini"],
         "video_models": ["seedance-2.5"], "audio_models": ["suno"]},
        {"id": "lovart", "name": "Lovart", "base_url": "https://lgw.lovart.ai", "protocol": "lovart",
         "enabled": True, "image_models": ["generate_image_nano_banana_pro"], "chat_models": ["lovart-agent"],
         "video_models": ["generate_video_seedance_v2_5"], "audio_models": []},
        {"id": "modelscope", "name": "ModelScope", "base_url": "https://api-inference.modelscope.cn/v1",
         "protocol": "openai", "enabled": True, "image_models": ["Qwen/Qwen-Image-2512"],
         "chat_models": [], "video_models": [], "audio_models": []},
    ]

    def test_member_only_sees_apimart(self):
        uid, username, password = create_named_user(0)
        member = TestClient(main.app)
        self.assertEqual(member.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)
        with mock.patch.object(main, "load_api_providers", return_value=self.FAKE_PROVIDERS):
            providers = member.get("/api/providers").json()["providers"]
            self.assertEqual([item["id"] for item in providers], ["apimart"])
            models = member.get("/api/models").json()
            self.assertEqual(models["image_models"], ["flux-3-image-klein"])
            self.assertEqual(models["chat_models"], ["gpt-4o-mini"])
            self.assertEqual(models["video_models"], ["seedance-2.5"])
            config = member.get("/api/config").json()
            self.assertEqual([item["id"] for item in config["api_providers"]], ["apimart"])
            self.assertEqual(config["image_models"], ["flux-3-image-klein"])
            admin = admin_client()
            admin_providers = admin.get("/api/providers").json()["providers"]
            self.assertIn("lovart", [item["id"] for item in admin_providers])
            self.assertIn("modelscope", [item["id"] for item in admin_providers])

    def test_member_non_apimart_generation_forbidden(self):
        uid, username, password = create_named_user(0)
        member = TestClient(main.app)
        self.assertEqual(member.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)
        cases = [
            ("/api/canvas-video", {"prompt": "x", "provider_id": "lovart", "model": "veo3-fast", "duration": 5}),
            ("/api/canvas-audio", {"provider_id": "modelscope", "model": "suno", "prompt": "x"}),
            ("/api/canvas-llm", {"message": "hi", "provider": "agnes-ai", "model": "gpt-4o-mini"}),
            ("/api/ms/generate", {"prompt": "x", "model": "Qwen/Qwen-Image-2512"}),
        ]
        for path, body in cases:
            response = member.post(path, json=body)
            self.assertEqual(response.status_code, 403, "%s -> %s" % (path, response.text[:200]))
            self.assertEqual(response.json().get("code"), "provider_not_allowed", path)

    def test_member_legacy_default_provider_becomes_apimart(self):
        uid, username, password = create_named_user(0)
        member = TestClient(main.app)
        self.assertEqual(member.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)
        response = member.post("/api/canvas-video", json={
            "prompt": "x", "provider_id": "comfly", "model": "veo3-fast", "duration": 5})
        # comfly 是旧默认值：归一成 apimart 后因为余额 0 回 402，而不是 provider_not_allowed
        self.assertEqual(response.status_code, 402, response.text)
        self.assertEqual(response.json().get("code"), "INSUFFICIENT_CREDITS")

    def test_auth_off_keeps_all_providers(self):
        set_auth(False)
        try:
            client = TestClient(main.app)
            with mock.patch.object(main, "load_api_providers", return_value=self.FAKE_PROVIDERS):
                providers = client.get("/api/providers").json()["providers"]
                self.assertGreaterEqual(len(providers), 3)
                self.assertIn("lovart", [item["id"] for item in providers])
        finally:
            set_auth(True)


class ApiIntegrationTests(unittest.TestCase):
    def test_generation_returns_402_then_charges(self):
        """打桩上游生图，验证：余额不足 402；充值后成功扣费并返回 credits。"""
        uid, username, password = create_named_user(0)
        client = TestClient(main.app)
        login = client.post("/api/auth/login", json={"username": username, "password": password})
        self.assertEqual(login.status_code, 200, login.text)

        async def fake_generate(payload):
            return {"images": ["/output/fake.png"], "model": "flux-3-image-klein", "provider_id": "apimart"}

        body = {"prompt": "cat", "provider_id": "apimart", "model": "flux-3-image-klein",
                "size": "1024x1024", "quality": "auto", "n": 1}
        with mock.patch.object(main, "build_online_image_result", fake_generate):
            response = client.post("/api/online-image", json=body)
            self.assertEqual(response.status_code, 402, response.text)
            payload = response.json()
            self.assertEqual(payload["code"], "INSUFFICIENT_CREDITS")
            self.assertIn("estimate", payload)
            self.assertIn("balance", payload)

            store.adjust_credits(uid, 3.0, kind="test_seed")
            response = client.post("/api/online-image", json=body)
            self.assertEqual(response.status_code, 200, response.text)
            credits = response.json().get("credits") or {}
            self.assertGreater(credits.get("price", 0), 0)
            self.assertIn("balance_after", credits)
            charges = service.charges(user_id=uid, limit=5)
            self.assertEqual(charges[0]["status"], "settled")
            # 上游没给实际成本 → 用「该模型最高可能成本 × 1.3」兜底（actual=0），不再用普通档位估价
            floor_quote = pricing.estimate("image", "flux-3-image-klein",
                                           {"width": 1024, "height": 1024}, "apimart", conservative=True)
            self.assertEqual(int(charges[0]["actual"]), 0)
            self.assertAlmostEqual(charges[0]["cost_usd"], floor_quote["cost_usd"], places=6)
            self.assertAlmostEqual(charges[0]["price_usd"], floor_quote["price_usd"], places=6)
            self.assertGreater(charges[0]["price_usd"], charges[0]["cost_usd"])

    def test_task_endpoints_402_fast_and_no_deadlock(self):
        """余额 0：task 型生成必须先 402（1s 内），不能建 task 后死锁。"""
        uid, username, password = create_named_user(0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)
        cases = [
            ("/api/canvas-video", {"prompt": "x", "provider_id": "apimart", "model": "veo3-fast", "duration": 5}),
            ("/api/canvas-image-tasks", {"prompt": "x", "provider_id": "apimart",
                                          "model": "flux-3-image-klein", "size": "1024x1024", "n": 1}),
            ("/api/canvas-audio", {"provider_id": "apimart", "model": "suno", "prompt": "x"}),
        ]
        for path, body in cases:
            holder = {}

            def call():
                try:
                    holder["response"] = client.post(path, json=body)
                except BaseException as exc:  # noqa: BLE001
                    holder["error"] = exc

            started = time.monotonic()
            thread = threading.Thread(target=call, daemon=True)
            thread.start()
            thread.join(1.5)
            elapsed = time.monotonic() - started
            self.assertFalse(thread.is_alive(), "%s 卡住超过 1.5s（402 异常路径死锁）" % path)
            self.assertNotIn("error", holder, "%s 抛异常：%r" % (path, holder.get("error")))
            response = holder.get("response")
            self.assertIsNotNone(response, "%s 没有响应" % path)
            self.assertEqual(response.status_code, 402, "%s -> %s" % (path, response.text[:300]))
            payload = response.json()
            self.assertEqual(payload.get("code"), "INSUFFICIENT_CREDITS")
            self.assertLess(elapsed, 1.5)
        self.assertEqual(client.get("/api/credits/me").status_code, 200)

    def test_text_actual_tokens_settled_to_4_decimals(self):
        """15 个真实 token 走 /api/canvas-llm：结算价约 0.0001，不再是固定 0.02。"""
        uid, username, password = create_named_user(1.0)
        client = TestClient(main.app)
        self.assertEqual(client.post("/api/auth/login",
                                     json={"username": username, "password": password}).status_code, 200)

        async def fake_llm(payload):
            return {"text": "hi", "model": "gpt-4o-mini",
                    "raw_usage": {"prompt_tokens": 10, "completion_tokens": 5}}

        with mock.patch.object(main, "_canvas_llm_impl", fake_llm):
            response = client.post("/api/canvas-llm", json={
                "message": "hi", "provider": "apimart", "model": "gpt-4o-mini",
            })
            self.assertEqual(response.status_code, 200, response.text)
            credits = response.json().get("credits") or {}
            self.assertLessEqual(credits.get("price", 1), 0.01)
            self.assertAlmostEqual(credits.get("price"), 0.01)
            self.assertNotEqual(credits.get("price"), 0.02)
            charge = service.charges(user_id=uid, limit=1)[0]
            self.assertTrue(int(charge.get("actual") or 0))
            self.assertLessEqual(charge["price_usd"], 0.001)

    def test_auth_off_disables_charging(self):
        uid = unique_user(5.0)
        set_auth(False)
        try:
            charge = integration.credits_charge_start("image", "flux-3-image-klein",
                                                      {"width": 1024, "height": 1024}, user_id=uid)
            self.assertIsNone(charge)
            self.assertFalse(config.credits_enabled())
            self.assertAlmostEqual(store.balance(uid), 5.0)
            client = TestClient(main.app)
            response = client.get("/api/credits/me")
            self.assertEqual(response.status_code, 200)
            self.assertFalse(response.json()["enabled"])
            self.assertFalse(response.json()["auth_enabled"])
        finally:
            set_auth(True)

    def test_sse_pushes_balance_and_heartbeat(self):
        admin_row = auth_service.store.get_user_by_username(ADMIN_USER)
        uid = int(admin_row["id"])
        token = admin_client().cookies.get("novai_session")

        class FakeRequest:
            cookies = {"novai_session": token}

        async def run():
            response = await credits_api.credits_stream(FakeRequest())
            generator = response.body_iterator
            first = await generator.__anext__()
            self.assertIn('"type":"balance"', first)
            events.publish(uid, 9.5)
            second = await generator.__anext__()
            self.assertIn('"type":"balance"', second)
            self.assertIn("9.5", second)
            await generator.aclose()
            self.assertEqual(events.subscriber_count(uid), 0)

        import asyncio
        asyncio.run(run())

    def test_sse_repeated_open_close_does_not_recurse(self):
        """模拟前端反复打开/断线：20 次 aclose 必须干净退出、订阅清空，之后接口仍可用。"""
        admin_row = auth_service.store.get_user_by_username(ADMIN_USER)
        uid = int(admin_row["id"])
        token = admin_client().cookies.get("novai_session")
        os.environ["NOVAI_SSE_HEARTBEAT_SECONDS"] = "0.05"

        class FakeRequest:
            cookies = {"novai_session": token}

        async def run():
            for _ in range(20):
                response = await credits_api.credits_stream(FakeRequest())
                generator = response.body_iterator
                first = await generator.__anext__()
                self.assertIn('"type":"balance"', first)
                await generator.aclose()
                self.assertEqual(events.subscriber_count(uid), 0)
                self.assertEqual(events.subscriber_count(0), 0)
                # unsubscribe 后即使还有在途 publish，也不能再往已关闭队列写
                events.publish(uid, 1.23)
                await asyncio.sleep(0)
                self.assertEqual(events.subscriber_count(uid), 0)

        import asyncio
        asyncio.run(run())
        client = admin_client()
        self.assertEqual(client.get("/api/credits/me").status_code, 200)

    def test_price_endpoint_contract(self):
        client = admin_client()
        response = client.get("/api/credits/price", params={
            "model": "flux-3-image-klein", "kind": "image", "width": 2048, "height": 2048})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        for key in ("cost", "price", "currency", "usd", "matched_spec", "pricing_fallback"):
            self.assertIn(key, payload)
        self.assertEqual(payload["currency"], "credit")
        self.assertIn("cost", payload["usd"])
        self.assertIn("price", payload["usd"])
        self.assertIn("profit", payload["usd"])


def tearDownModule():
    # 不删 _TMP_DATA：合并跑时它可能已是后续套件正在使用的共享库（谁先 import 谁建库）。
    # 单个套件跑完留下的临时目录由系统清理，和其他 python 测试套件的行为保持一致。
    # 退出时把 auth 开关清干净：本套件用 NOVAI_AUTH_DISABLED=1 关鉴权，留着会让后续套件
    # （如 test_lan_account_owner）以为「登录体系未启用」而失败；默认 optional 即可。
    os.environ.pop("NOVAI_AUTH_DISABLED", None)
    os.environ.pop("NOVAI_AUTH_ENABLED", None)
    os.environ.pop("NOVAI_AUTH_MODE", None)
    reset_for_tests()


if __name__ == "__main__":
    unittest.main(verbosity=2)
