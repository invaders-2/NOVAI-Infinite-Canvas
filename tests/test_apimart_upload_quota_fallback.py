"""本地图片转视频输入：429 额度用尽与 data URL 直发。

用户实测 POST /v1/uploads/images 返回 429：
  {"error":{"code":"rate_limit_exceeded","message":"upload limit reached: each account can
   upload at most 2000 files per 72 hours..."},
   "quota":{"limit":2000,"used":2000,"remaining":0,"reset_at":1794204000,"window_hours":72}}
根因不是图片太大，而是账号上传额度用尽；同一张本地图反复上传还会持续烧额度。这里守四件事：
  * 本地图片压成 data URL 能进 JSON 预算时完全不调用 /v1/uploads/images；
  * 同一路径（mtime + size 未变）第二次命中进程内缓存，不再上传；
  * 429 时先试临时图床，图床失败再回退压缩 data URL，塞不下才抛带额度 / 恢复时间 / 建议的可读错误；
  * 413 仍按档位逐级压缩重试，不会被 429 逻辑吞掉。
全部离线：假 client / 假上传，不联网。
"""
import asyncio
import copy
import json
import os
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

PROVIDER = {"id": "apimart", "name": "APIMART", "base_url": "https://apib.ai", "use_proxy": "off"}
QUOTA_PAYLOAD = {
    "error": {
        "code": "rate_limit_exceeded",
        "message": "upload limit reached: each account can upload at most 2000 files per 72 hours",
    },
    "quota": {"limit": 2000, "used": 2000, "remaining": 0, "reset_at": 1794204000, "window_hours": 72},
}
QUOTA_TEXT = json.dumps(QUOTA_PAYLOAD, ensure_ascii=False)
TINY_BODY = {"prompt": "把这张图做成视频", "model": "gpt-image-2"}
VEO_BODY = {
    "prompt": "让这张图动起来",
    "model": "veo3.1-fast",
    "duration": 4,
    "aspect_ratio": "16:9",
    "resolution": "720p",
    "official_fallback": False,
}


class _Resp:
    def __init__(self, status_code, payload=None, text=None):
        self.status_code = status_code
        self._payload = payload
        self.text = text if text is not None else json.dumps(payload or {}, ensure_ascii=False)

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


def _provider():
    return dict(PROVIDER)


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    main._APIMART_UPLOAD_CACHE.clear()
    monkeypatch.setenv("API_PROVIDER_APIMART_KEY", "sk-unit-test")
    yield
    main._APIMART_UPLOAD_CACHE.clear()


@pytest.fixture(autouse=True)
def _no_temp_host(monkeypatch):
    """429 会先试临时图床；本文件的单测只测 data URL 回退，统一让图床离线失败。"""

    async def _fail(ref_url, service="auto"):
        raise main.HTTPException(status_code=502, detail="单元测试不联网：临时图床不可用")

    monkeypatch.setattr(main, "upload_local_video_to_cloud", _fail)


def _noise_jpeg(path, size=(1200, 900), quality=92):
    img = Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3))
    img.save(str(path), format="JPEG", quality=quality)
    return str(path)


def _solid_jpeg(path, size=(320, 240)):
    img = Image.new("RGB", size, (120, 180, 240))
    img.save(str(path), format="JPEG", quality=80)
    return str(path)


def _budget_between_direct_and_second_tier(ref, body):
    """构造一个预算：1536 直发塞不下（所以会去上传），第二档压缩能塞下（所以 429 可降级成功）。"""
    direct_total = main.apimart_json_body_bytes(
        body, [main.apimart_reference_fallback_data_url({"url": ref}, 1536, 88)])
    ladder = main.apimart_fallback_compression_ladder(1)
    second_url = main.reference_to_jpeg_data_url({"url": ref}, ladder[1][0], ladder[1][1])
    second_total = main.apimart_json_body_bytes(body, [second_url])
    budget = direct_total - 1
    assert second_total <= budget, "第二档压缩必须能进预算，否则测不到 429 降级成功"
    return budget


def _fake_upload_client(responses):
    class _FakeClient:
        def __init__(self):
            self._responses = list(responses)
            self.posts = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc_info):
            return False

        async def post(self, url, headers=None, json=None):
            self.posts.append({"url": url, "headers": headers, "body": copy.deepcopy(json)})
            return self._responses.pop(0)

    return _FakeClient()


def _response(status, payload=None, text=None):
    request = main.httpx.Request("POST", "https://apib.ai/v1/videos/generations")
    if text is not None:
        return main.httpx.Response(status, text=text, request=request,
                                   headers={"Content-Type": "application/json"})
    return main.httpx.Response(status, json=payload, request=request)


def _run_veo(monkeypatch, responses, image_ref, upload_result, budget=None):
    """跑真实的 _canvas_video_run_unlimited（APIMart VEO3.1 分支），只把网络 / 上传 / 落盘换成桩。"""
    client = _fake_upload_client(responses)
    uploads = []

    async def fake_upload(client_obj, provider, url, *args, **kwargs):
        uploads.append(url)
        return upload_result

    async def fake_save(url, prefix="video_", category="output"):
        return "/output/video_stub.mp4"

    monkeypatch.setattr(main, "get_api_provider", lambda provider_id: dict(PROVIDER))
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr(main, "upload_image_for_apimart", fake_upload)
    monkeypatch.setattr(main, "save_remote_video_to_output", fake_save)
    if budget is not None:
        monkeypatch.setattr(main, "APIMART_JSON_BODY_BUDGET", budget)
    payload = main.CanvasVideoRequest(
        prompt="让这张图动起来",
        provider_id="apimart",
        model="veo3.1-fast",
        duration=4,
        aspect_ratio="16:9",
        images=[main.AIReference(url=image_ref, role="first_frame")],
    )
    result = asyncio.run(main._canvas_video_run_unlimited(payload))
    return client, uploads, result


# --- 不消耗上传额度的路径 ---

def test_local_image_data_url_fits_never_calls_upload(monkeypatch, tmp_path):
    local = _solid_jpeg(tmp_path / "online_small.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(upload_url)
        return _Resp(200, {"url": "https://getapib.org/image/should_not_be_used"})

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    urls = asyncio.run(main.apimart_image_reference_inputs(
        object(), _provider(), [{"url": "/assets/output/online_small.jpg"}], dict(TINY_BODY)))
    assert calls == [], "data URL 进得了预算就不许调用上传接口"
    assert len(urls) == 1 and urls[0].startswith("data:image/")
    assert main.apimart_json_body_bytes(TINY_BODY, urls) <= main.APIMART_JSON_BODY_BUDGET


def test_veo31_local_image_data_url_skips_upload(monkeypatch, tmp_path):
    local = _solid_jpeg(tmp_path / "veo_ref.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    client, uploads, result = _run_veo(
        monkeypatch, [_response(200, {"videos": ["https://cdn.example/out.mp4"]})],
        "/assets/output/veo_ref.jpg", "https://getapib.org/image/should_not_be_used")
    assert uploads == [], "VEO3.1 本地图能直发 data URL 时不许上传"
    assert result["videos"] == ["/output/video_stub.mp4"]
    body = client.posts[0]["body"]
    assert body["model"] == "veo3.1-fast"
    assert body["image_urls"][0].startswith("data:image/jpeg;base64,")


# --- 超预算仍走上传，上传结果有缓存 ---

def test_over_budget_still_uploads(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "online_big.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    monkeypatch.setattr(main, "APIMART_JSON_BODY_BUDGET", 1024)
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(len(file_tuple[1]))
        return _Resp(200, {"url": "https://getapib.org/image/cdn_big.jpg"})

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    urls = asyncio.run(main.apimart_image_reference_inputs(
        object(), _provider(), [{"url": "/assets/output/online_big.jpg"}], dict(TINY_BODY)))
    assert len(calls) == 1, "超预算必须走上传"
    assert urls == ["https://getapib.org/image/cdn_big.jpg"]


def test_same_local_path_uploads_only_once(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "online_cache.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(len(file_tuple[1]))
        return _Resp(200, {"url": "https://getapib.org/image/cached_once.jpg"})

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    first = asyncio.run(main.upload_image_for_apimart(object(), _provider(), "/assets/output/online_cache.jpg"))
    second = asyncio.run(main.upload_image_for_apimart(object(), _provider(), "/assets/output/online_cache.jpg"))
    assert first == second == "https://getapib.org/image/cached_once.jpg"
    assert len(calls) == 1, "同一路径第二次应命中缓存，不再上传"
    assert len(main._APIMART_UPLOAD_CACHE) == 1

    _solid_jpeg(local, size=(256, 256))
    third = asyncio.run(main.upload_image_for_apimart(object(), _provider(), "/assets/output/online_cache.jpg"))
    assert third == "https://getapib.org/image/cached_once.jpg"
    assert len(calls) == 2, "文件被覆盖后 mtime / size 变了，缓存必须失效"


# --- 429 额度用尽 ---

def test_429_falls_back_to_compressed_data_url(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "online_quota.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    ref = "/assets/output/online_quota.jpg"
    budget = _budget_between_direct_and_second_tier(ref, VEO_BODY)
    monkeypatch.setattr(main, "APIMART_JSON_BODY_BUDGET", budget)
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(upload_url)
        return _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT)

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    urls = asyncio.run(main.apimart_image_reference_inputs(
        object(), _provider(), [{"url": ref}], dict(VEO_BODY)))
    assert len(calls) == 1
    assert urls[0].startswith("data:image/jpeg;base64,")
    assert main.apimart_json_body_bytes(VEO_BODY, urls) <= budget


def test_429_with_no_budget_reports_quota_reset_and_advice(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "online_quota_over.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    monkeypatch.setattr(main, "APIMART_JSON_BODY_BUDGET", 200)

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        return _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT)

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    with pytest.raises(main.HTTPException) as caught:
        asyncio.run(main.apimart_image_reference_inputs(
            object(), _provider(), [{"url": "/assets/output/online_quota_over.jpg"}], dict(TINY_BODY)))
    detail = caught.value.detail
    assert caught.value.status_code == 400
    for token in ("2000", "72 小时", "已用 2000 个", "剩余 0 个", "（本地时间）", "恢复",
                  "建议", "换一个 APIMart 账号", "减少参考图", "upload limit reached"):
        assert token in detail, token + " 不在额度文案里：" + detail[:300]


def test_veo31_429_falls_back_to_data_url(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "veo_quota.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    ref = "/assets/output/veo_quota.jpg"
    budget = _budget_between_direct_and_second_tier(ref, VEO_BODY)
    quota_err = "ERR:" + main.apimart_upload_quota_reason(_Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT))
    client, uploads, result = _run_veo(
        monkeypatch, [_response(200, {"videos": ["https://cdn.example/out.mp4"]})],
        ref, quota_err, budget=budget)
    assert len(uploads) == 1
    assert result["videos"] == ["/output/video_stub.mp4"]
    body = client.posts[0]["body"]
    assert body["image_urls"][0].startswith("data:image/jpeg;base64,")
    assert main.apimart_json_body_bytes(body, body["image_urls"]) <= budget


def test_veo31_429_with_no_budget_raises_quota_detail(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "veo_quota_over.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    quota_err = "ERR:" + main.apimart_upload_quota_reason(_Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT))
    with pytest.raises(main.HTTPException) as caught:
        _run_veo(monkeypatch, [_response(200, {"videos": []})],
                 "/assets/output/veo_quota_over.jpg", quota_err, budget=200)
    detail = caught.value.detail
    assert caught.value.status_code == 400
    for token in ("2000", "72 小时", "已用 2000 个", "恢复", "建议", "换一个 APIMart 账号"):
        assert token in detail, token + " 不在额度文案里：" + detail[:300]


def test_upload_image_429_returns_quota_reason(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "online_quota_direct.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        return _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT)

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    result = asyncio.run(main.upload_image_for_apimart(
        object(), _provider(), "/assets/output/online_quota_direct.jpg"))
    assert result.startswith("ERR:APIMart 图片上传额度已用尽")
    assert "2000" in result and "（本地时间）" in result and "建议" in result
    assert main._APIMART_UPLOAD_CACHE == {}, "额度失败不能进缓存"


# --- 413 逻辑保留 ---

def test_413_still_shrinks_tier_by_tier(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "online_413.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(len(file_tuple[1]))
        return _Resp(413, text="<html><head><title>413 Request Entity Too Large</title></head></html>")

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    result = asyncio.run(main.upload_image_for_apimart(
        object(), _provider(), "/assets/output/online_413.jpg"))
    assert result.startswith("ERR:")
    assert "413" in result and "最后一档" in result, result
    assert len(calls) == len(main.APIMART_UPLOAD_TIERS)
    assert calls[-1] < calls[0]
