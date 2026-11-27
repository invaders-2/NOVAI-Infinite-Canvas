# -*- coding: utf-8 -*-
"""Midjourney 图生视频（虚拟视频模型 midjourney-video）：能力下发 / 请求计划 / 计费口径。

证据：/tmp/apimart-llms-20261125.txt L19884–L20060（端点页）、L20400–L20520（参数与计费表）。
计费价目：server/credits/apimart_pricing.json 的 midjourney@video（480p，gold 0.2 USD/次）与
midjourney@video-720p（720p，gold 0.4 USD/次），费用 = 单价 × batch_size。
"""
import copy
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main  # noqa: E402
from server.credits import pricing as credits_pricing  # noqa: E402


PROVIDER = {"id": "apimart", "protocol": "apimart", "base_url": "https://api.apimart.ai"}


def make_payload(**overrides):
    fields = {"prompt": "mock mj video", "provider_id": "apimart", "model": "midjourney-video"}
    fields.update(overrides)
    return main.CanvasVideoRequest(**fields)


def image_payload(**overrides):
    return make_payload(images=[{"url": "/assets/output/ref.png"}], **overrides)


def test_caps_served_for_virtual_video_model():
    caps = main.model_caps_for(PROVIDER, "midjourney-video", "video")
    assert caps["modes"] == ["image_to_video"]
    assert caps["durations"] == [5]
    assert caps["resolutions"] == ["480p", "720p"]
    assert caps["ratios"] == []
    assert caps["n_max"] == 1
    assert caps["batch"] == [1, 2, 4]
    assert caps["ref_max"] == 1
    mj_video = caps["mj_video"]
    assert mj_video["endpoint"] == "/v1/midjourney/generations/video"
    assert mj_video["upstream_model"] == "midjourney"
    assert mj_video["motions"] == ["low", "high"]
    assert mj_video["motion_default"] == "high"
    assert mj_video["video_types"] == [
        "vid_1.1_i2v_480", "vid_1.1_i2v_720",
        "vid_1.1_i2v_start_end_480", "vid_1.1_i2v_start_end_720",
    ]
    assert mj_video["video_type_default"] == "vid_1.1_i2v_480"
    assert mj_video["start_end_by_tier"] == {
        "480p": "vid_1.1_i2v_start_end_480", "720p": "vid_1.1_i2v_start_end_720"}
    assert mj_video["animate_modes"] == ["manual", "auto"]
    assert mj_video["billing"] == ["midjourney@video", "midjourney@video-720p"]
    assert mj_video["billing_by_tier"] == {
        "480p": "midjourney@video", "720p": "midjourney@video-720p"}
    assert mj_video["requires_first_frame"] is True
    assert mj_video["supports_end_frame"] is True
    assert mj_video["duration_seconds"] == 5
    assert main.APIMART_BUILTIN_MODEL_IDS["video"]["midjourney-video"] == ("midjourney-video",)
    # 虚拟模型不能被别的视频模型误命中
    assert main.apimart_mj_video_caps("midjourney") == {}
    assert main.apimart_mj_video_caps("seedance-2.5") == {}


def test_image_midjourney_caps_keep_mj_video():
    caps = main.model_caps_for(PROVIDER, "midjourney", "image")
    served = caps["mj"]["video"]
    assert served == main.model_caps_for(PROVIDER, "midjourney-video", "video")["mj_video"]
    assert served["video_types"][-1] == "vid_1.1_i2v_start_end_720"


def test_plan_defaults_and_end_upgrade():
    plan = main.apimart_mj_video_plan(image_payload())
    assert plan["tier"] == "480p"
    assert plan["video_type"] == "vid_1.1_i2v_480"
    assert plan["motion"] == "high"
    assert plan["batch"] == 1
    assert plan["animate_mode"] == "manual"
    assert plan["billing"] == "midjourney@video"

    plan720 = main.apimart_mj_video_plan(image_payload(video_type="vid_1.1_i2v_720"))
    assert (plan720["tier"], plan720["video_type"], plan720["billing"]) == (
        "720p", "vid_1.1_i2v_720", "midjourney@video-720p")

    upgraded = main.apimart_mj_video_plan(
        make_payload(images=[{"url": "/assets/output/ref.png"}],
                     end_image={"url": "/assets/output/end.png"},
                     video_type="vid_1.1_i2v_720", mj_batch=2))
    assert upgraded["video_type"] == "vid_1.1_i2v_start_end_720"
    assert upgraded["tier"] == "720p"
    assert upgraded["batch"] == 2

    reuse = main.apimart_mj_video_plan(
        make_payload(mj_task_id="task_imagine_mock", mj_index=3, animate_mode="auto"))
    assert reuse["task_id"] == "task_imagine_mock"
    assert reuse["index"] == 3
    assert reuse["video_type"] == "vid_1.1_i2v_480"


def test_quote_480_and_720_times_batch():
    # 480p 单条：gold 0.2 USD → 2 积分成本，售价 2.6
    model, params, quote = main.apimart_mj_video_charge(image_payload())
    assert model == "midjourney@video"
    assert params["rows"] == 1
    assert params["resolution"] == "480p"
    assert (quote["cost"], quote["price"]) == (2.0, 2.6)
    assert quote["unit"] == "per_call"
    assert quote["pricing_fallback"] is False

    # 480p batch=4：成本 2 × 4 = 8，售价 8 × 1.3 = 10.4
    model, params, quote = main.apimart_mj_video_charge(image_payload(mj_batch=4))
    assert (model, params["rows"]) == ("midjourney@video", 4)
    assert (quote["cost"], quote["price"], quote["cost_usd"]) == (8.0, 10.4, 0.8)

    # 720p batch=2：gold 0.4 USD → 单条成本 4，两条 8，售价 10.4（与 480p×4 同价）
    model, params, quote = main.apimart_mj_video_charge(
        image_payload(video_type="vid_1.1_i2v_720", mj_batch=2))
    assert (model, params["rows"], params["resolution"]) == ("midjourney@video-720p", 2, "720p")
    assert (quote["cost"], quote["price"], quote["cost_usd"]) == (8.0, 10.4, 0.8)

    # 尾帧升级不改档位/价格
    model, params, quote = main.apimart_mj_video_charge(
        make_payload(images=[{"url": "/assets/output/ref.png"}],
                     end_image={"url": "/assets/output/end.png"}))
    assert model == "midjourney@video"
    assert params["resolution"] == "480p"

    # 预扣与结算同口径：结算兜底的 conservative 估价不得高于预扣成本（同一 billing id + rows）
    conservative = credits_pricing.estimate("video", model, params, provider="apimart", conservative=True)
    assert conservative["cost_usd"] == quote["cost_usd"]
    assert conservative["pricing_fallback"] is False

    # 虚拟模型名直接估价（前端拿它做报价）也要认档位 × rows，不能落到 conservative 高价
    for resolution, rows, expected in (("480p", 1, (2.0, 2.6)), ("720p", 2, (8.0, 10.4))):
        virtual = credits_pricing.estimate(
            "video", "midjourney-video",
            {"rows": rows, "resolution": resolution, "duration": 5}, provider="")
        assert (virtual["cost"], virtual["price"]) == expected, (resolution, rows, virtual)
        assert virtual["pricing_fallback"] is False
        assert virtual["model"] in ("midjourney@video", "midjourney@video-720p")


def test_public_price_endpoint_maps_virtual_model(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.delenv("NOVAI_AUTH_ENABLED", raising=False)
    # 默认全局后付费时 /api/credits/price 对外 cost=0（只给 estimated_*），这条用例验的是预扣口径
    monkeypatch.setenv("CREDIT_BILLING_MODE", "prepaid")
    client = TestClient(main.app)
    response = client.get("/api/credits/price", params={
        "model": "midjourney-video", "kind": "video", "resolution": "720p", "rows": 2})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert (payload["cost"], payload["price"]) == (8.0, 10.4)
    assert payload["pricing_fallback"] is False


def test_missing_price_key_fails_loudly(tmp_path, monkeypatch):
    source = Path(os.path.dirname(os.path.abspath(main.__file__))) / "server" / "credits" / "apimart_pricing.json"
    data = json.loads(source.read_text(encoding="utf-8"))
    data = copy.deepcopy(data)
    data["models"].pop("midjourney@video", None)
    data["alias_map"].pop("midjourney@video", None)
    target = tmp_path / "pricing-without-mj-video.json"
    target.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv("NOVAI_PRICING_FILE", str(target))
    credits_pricing.reset_cache()
    try:
        with pytest.raises(main.HTTPException) as raised:
            main.apimart_mj_video_charge(image_payload())
        assert raised.value.status_code == 500
        assert "价目缺少 midjourney@video" in str(raised.value.detail)
    finally:
        monkeypatch.delenv("NOVAI_PRICING_FILE", raising=False)
        credits_pricing.reset_cache()


def test_local_validation_branches():
    cases = [
        ({}, "首帧图"),
        ({"images": [{"url": "/a.png"}], "mj_task_id": "task_x"}, "互斥"),
        ({"mj_task_id": "task_x", "animate_mode": "auto"}, "animate_mode=auto"),
        ({"images": [{"url": "/a.png"}], "mj_index": 1}, "mj_index"),
        ({"images": [{"url": "/a.png"}], "video_type": "vid_bad"}, "video_type"),
        ({"images": [{"url": "/a.png"}], "mj_batch": 3}, "mj_batch"),
        ({"images": [{"url": "/a.png"}], "motion": "medium"}, "motion"),
        ({"images": [{"url": "/a.png"}], "resolution": "1080p"}, "480p"),
        ({"images": [{"url": "/a.png"}], "mode": "text_to_video"}, "image_to_video"),
        ({"prompt": " ", "images": [{"url": "/a.png"}]}, "提示词"),
    ]
    for overrides, expected in cases:
        with pytest.raises(main.HTTPException) as raised:
            main.apimart_mj_video_plan(make_payload(**overrides))
        assert raised.value.status_code == 400, overrides
        assert expected in str(raised.value.detail), (overrides, raised.value.detail)


def test_non_midjourney_model_has_no_plan():
    assert main.apimart_mj_video_plan(make_payload(model="seedance-2.0")) is None
    with pytest.raises(main.HTTPException) as raised:
        main.apimart_mj_video_charge(make_payload(model="seedance-2.0"))
    assert raised.value.status_code == 400
