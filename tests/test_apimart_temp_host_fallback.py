"""APIMart 上传额度用尽（429）时的临时图床兜底。

用户 APIMart 账号上传额度 2000/72h 已用满（POST /v1/uploads/images → 429），不少图片的压缩
data URL 又塞不进 JSON 预算。这里守六件事：
  * 429 时先复用现有临时图床链路（uguu → Litterbox → temp.sh）换公网直链，成功就写进现有 LRU 缓存；
  * 图床直链必须真发 GET 校验成 image/*，HTML 查看页不算成功；
  * 图床失败才回退压缩 data URL，塞得下就成功；
  * 图床失败 + data URL 超预算，抛 400 且文案依次是「额度用尽 → 图床失败原因 → data URL 超预算」；
  * 非 429（500/401）与 413 不碰图床，默认上传链路不变；
  * data URL 输入命中 429 时先落盘成临时文件再走图床，用完删除。
注：视频输入链路默认已改为「图床优先」（见 test_apimart_image_source_temp_first.py）；
本文件覆盖图片生成链路直接调用 upload_image_for_apimart 时的 429 兜底行为。
全部离线：假 client / 假图床 / 假 GET，不联网。
"""
import asyncio
import base64
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
TEMP_HOST_FAIL = "所有图床都挂了：uguu 连接超时"


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


def _solid_jpeg(path, size=(320, 240)):
    img = Image.new("RGB", size, (120, 180, 240))
    img.save(str(path), format="JPEG", quality=80)
    return str(path)


def _noise_jpeg(path, size=(1200, 900), quality=92):
    img = Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3))
    img.save(str(path), format="JPEG", quality=quality)
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


def _isolate_output_dir(monkeypatch, tmp_path):
    """data URL 落盘用；避免单元测试往真实 assets/output 写临时文件。"""
    monkeypatch.setattr(main, "output_path_for", lambda filename, category="output": str(tmp_path / filename))
    monkeypatch.setattr(main, "output_url_for", lambda filename, category="output": "/output/" + filename)


def _stub_upload(monkeypatch, response):
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(upload_url)
        return response

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    return calls


def _stub_temp_host(monkeypatch, url="https://uguu.se/apimart_quota.jpg", service="uguu", error=None):
    calls = []

    async def fake_cloud(ref_url, service_name="auto"):
        calls.append(ref_url)
        if error is not None:
            raise error
        return {"url": url, "service": service, "source": ref_url}

    monkeypatch.setattr(main, "upload_local_video_to_cloud", fake_cloud)
    return calls


def _stub_verify(monkeypatch, content_type="image/jpeg", ok=True, reason=""):
    calls = []

    async def fake_verify(url):
        calls.append(url)
        return {"ok": ok, "status": 200, "content_type": content_type,
                "bytes": 2048 if ok else 0, "reason": reason}

    monkeypatch.setattr(main, "verify_cloud_media_direct_url", fake_verify)
    return calls


# --- 429 → 临时图床成功 ---

def test_429_temp_host_returns_url_and_second_call_hits_cache(monkeypatch, tmp_path):
    local = _solid_jpeg(tmp_path / "quota_temp_ok.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    ref = "/assets/output/quota_temp_ok.jpg"
    upload_calls = _stub_upload(monkeypatch, _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT))
    temp_calls = _stub_temp_host(monkeypatch, url="https://uguu.se/quota_temp_ok.jpg", service="uguu")
    verify_calls = _stub_verify(monkeypatch)

    first = asyncio.run(main.upload_image_for_apimart(object(), _provider(), ref))
    second = asyncio.run(main.upload_image_for_apimart(object(), _provider(), ref))

    assert first == second == "https://uguu.se/quota_temp_ok.jpg"
    assert temp_calls == [ref], "第一次走图床，第二次必须命中 LRU 缓存"
    assert verify_calls == ["https://uguu.se/quota_temp_ok.jpg"], "图床直链要真发 GET 校验"
    assert len(upload_calls) == 1, "第二次命中缓存后不应再撞 429 上传"
    assert [entry["url"] for entry in main._APIMART_UPLOAD_CACHE.values()] == [
        "https://uguu.se/quota_temp_ok.jpg"]


def test_temp_host_rejects_html_viewer(monkeypatch, tmp_path):
    local = _solid_jpeg(tmp_path / "quota_html.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    _stub_upload(monkeypatch, _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT))
    _stub_temp_host(monkeypatch, url="https://temp.sh/quota_html.jpg", service="temp.sh")
    _stub_verify(monkeypatch, content_type="text/html; charset=utf-8", ok=False,
                 reason="GET 返回的是 HTML 查看页（Content-Type: text/html; charset=utf-8）")

    result = asyncio.run(main.upload_image_for_apimart(object(), _provider(), "/assets/output/quota_html.jpg"))

    assert result.startswith("ERR:APIMart 图片上传额度已用尽"), result
    assert "临时图床兜底失败" in result and "HTML" in result, result
    assert main._APIMART_UPLOAD_CACHE == {}, "校验不过的链接不能进缓存"


def test_temp_host_requires_image_content_type(monkeypatch):
    _stub_temp_host(monkeypatch, url="https://temp.sh/looks_like.html", service="temp.sh")
    _stub_verify(monkeypatch, content_type="text/html", ok=True)

    with pytest.raises(main.HTTPException) as caught:
        asyncio.run(main.apimart_image_via_temp_host("/assets/output/looks_like.png"))
    assert caught.value.status_code == 502
    assert "不是图片" in caught.value.detail and "temp.sh" in caught.value.detail


# --- 429 → 图床失败 → data URL 回退 ---

def test_429_temp_host_fails_then_compressed_data_url_fits(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "quota_data_url_ok.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    _isolate_output_dir(monkeypatch, tmp_path)
    ref = "/assets/output/quota_data_url_ok.jpg"
    budget = _budget_between_direct_and_second_tier(ref, VEO_BODY)
    monkeypatch.setattr(main, "APIMART_JSON_BODY_BUDGET", budget)
    _stub_upload(monkeypatch, _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT))
    temp_calls = _stub_temp_host(monkeypatch, error=main.HTTPException(status_code=502, detail=TEMP_HOST_FAIL))

    urls = asyncio.run(main.apimart_image_reference_inputs(
        object(), _provider(), [{"url": ref}], dict(VEO_BODY)))

    assert len(temp_calls) == 1, "429 必须先试一次图床"
    assert urls[0].startswith("data:image/jpeg;base64,"), urls
    assert main.apimart_json_body_bytes(VEO_BODY, urls) <= budget
    assert main._APIMART_UPLOAD_CACHE == {}, "图床失败不能写缓存"


def test_429_temp_host_and_data_url_both_fail_reports_three_segments(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "quota_all_fail.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    _isolate_output_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "APIMART_JSON_BODY_BUDGET", 200)
    _stub_upload(monkeypatch, _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT))
    _stub_temp_host(monkeypatch, error=main.HTTPException(status_code=502, detail=TEMP_HOST_FAIL))

    with pytest.raises(main.HTTPException) as caught:
        asyncio.run(main.apimart_image_reference_inputs(
            object(), _provider(), [{"url": "/assets/output/quota_all_fail.jpg"}], dict(TINY_BODY)))

    detail = caught.value.detail
    assert caught.value.status_code == 400
    quota_at = detail.index("APIMart 图片上传额度已用尽")
    host_at = detail.index(TEMP_HOST_FAIL)
    data_at = detail.index("压缩 data URL 兜底也放不下")
    assert quota_at < host_at < data_at, detail
    for token in ("2000", "72 小时", "（本地时间）", "建议"):
        assert token in detail, token + " 不在额度文案里：" + detail[:300]
    assert not list(tmp_path.glob("apimart_tmp_*")), "data URL 临时文件必须删掉"


# --- 非 429 与 413 不碰图床 ---

@pytest.mark.parametrize("status", [500, 401])
def test_non_429_does_not_touch_temp_host(monkeypatch, tmp_path, status):
    local = _solid_jpeg(tmp_path / ("status_%d.jpg" % status))
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    _stub_upload(monkeypatch, _Resp(status, {"error": "boom"}))
    temp_calls = _stub_temp_host(monkeypatch)

    result = asyncio.run(main.upload_image_for_apimart(
        object(), _provider(), "/assets/output/status_%d.jpg" % status))

    assert result == "ERR:APIMart 上传失败(%d)" % status, result
    assert temp_calls == []
    assert main._APIMART_UPLOAD_CACHE == {}


def test_413_still_shrinks_tier_by_tier_without_temp_host(monkeypatch, tmp_path):
    local = _noise_jpeg(tmp_path / "shrink_413.jpg")
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(len(file_tuple[1]))
        return _Resp(413, text="<html><head><title>413 Request Entity Too Large</title></head></html>")

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    temp_calls = _stub_temp_host(monkeypatch)

    result = asyncio.run(main.upload_image_for_apimart(object(), _provider(), "/assets/output/shrink_413.jpg"))

    assert result.startswith("ERR:"), result
    assert "413" in result and "最后一档" in result
    assert len(calls) == len(main.APIMART_UPLOAD_TIERS)
    assert calls[-1] < calls[0]
    assert temp_calls == []
    assert main._APIMART_UPLOAD_CACHE == {}


# --- data URL 输入 + 429 ---

def test_data_url_input_429_spills_to_temp_file_then_temp_host(monkeypatch, tmp_path):
    _isolate_output_dir(monkeypatch, tmp_path)
    raw = Path(_solid_jpeg(tmp_path / "solid_src.jpg")).read_bytes()
    data_url = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
    upload_calls = _stub_upload(monkeypatch, _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT))
    seen = []

    async def fake_cloud(ref_url, service_name="auto"):
        name = os.path.basename(ref_url)
        seen.append({"ref": ref_url, "service": service_name, "exists": os.path.exists(str(tmp_path / name))})
        return {"url": "https://litterbox.catbox.moe/data_url_ok.jpg", "service": "litterbox", "source": ref_url}

    monkeypatch.setattr(main, "upload_local_video_to_cloud", fake_cloud)
    verify_calls = _stub_verify(monkeypatch)

    result = asyncio.run(main.upload_image_for_apimart(object(), _provider(), data_url))

    assert result == "https://litterbox.catbox.moe/data_url_ok.jpg"
    assert len(upload_calls) == 1
    assert verify_calls == [result]
    assert len(seen) == 1
    assert seen[0]["ref"].startswith("/output/apimart_tmp_"), seen
    assert seen[0]["ref"].endswith(".jpg"), "mime → 扩展名要保住 image/*，否则图床链路拒收"
    assert seen[0]["exists"] is True, "图床上传发生时临时文件必须已经在磁盘上"
    assert not list(tmp_path.glob("apimart_tmp_*")), "临时文件用完必须删除"
    assert main._APIMART_UPLOAD_CACHE == {}, "data URL 没有稳定缓存键，不写缓存"


def test_data_url_input_429_temp_host_failure_returns_quota_error(monkeypatch, tmp_path):
    _isolate_output_dir(monkeypatch, tmp_path)
    raw = Path(_solid_jpeg(tmp_path / "solid_src_fail.jpg")).read_bytes()
    data_url = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
    _stub_upload(monkeypatch, _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT))
    _stub_temp_host(monkeypatch, error=main.HTTPException(status_code=502, detail=TEMP_HOST_FAIL))

    result = asyncio.run(main.upload_image_for_apimart(object(), _provider(), data_url))

    assert result.startswith("ERR:APIMart 图片上传额度已用尽"), result
    assert "临时图床兜底失败" in result and TEMP_HOST_FAIL in result, result
    assert not list(tmp_path.glob("apimart_tmp_*")), "图床失败也要删掉临时文件"
    assert main._APIMART_UPLOAD_CACHE == {}
