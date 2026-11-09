"""APIMart 视频输入：本地图片默认先走临时图床（图床优先）。

用户要求：本地 /output/ /assets/ 图片做 APIMart 视频输入时，默认先用临时图床
（uguu → Litterbox → temp.sh）换 https 直链，避免消耗 APIMart 的 2000 个/72 小时上传额度；
APIMART_IMAGE_SOURCE=apimart 恢复旧顺序（官方上传优先，429 才用图床兜底）；
图床全失败才回退 APIMart 上传，再失败才由调用方回退压缩 data URL。
图床直链有时效，缓存 entry 带 expires_at：过期即视为未命中并重新上传。
图片生成链路不走 upload_video_image_for_apimart，保持原顺序（不在本文件范围）。
全部离线：假图床 / 假 APIMart 上传 / 假 GET，不联网。
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
    monkeypatch.delenv("APIMART_IMAGE_SOURCE", raising=False)
    yield
    main._APIMART_UPLOAD_CACHE.clear()


def _solid_jpeg(path, size=(320, 240)):
    img = Image.new("RGB", size, (120, 180, 240))
    img.save(str(path), format="JPEG", quality=80)
    return str(path)


def _isolate_output_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "output_path_for", lambda filename, category="output": str(tmp_path / filename))
    monkeypatch.setattr(main, "output_url_for", lambda filename, category="output": "/output/" + filename)


def _stub_upload(monkeypatch, response):
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(upload_url)
        return response

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    return calls


def _stub_temp_host(monkeypatch, url="https://a.uguu.se/temp_first.jpg", service="uguu",
                    error=None, queue=None):
    calls = []

    async def fake_cloud(ref_url, service_name="auto"):
        calls.append(ref_url)
        if error is not None:
            raise error
        chosen = queue.pop(0) if queue else (url, service)
        return {"url": chosen[0], "service": chosen[1], "source": ref_url}

    monkeypatch.setattr(main, "upload_local_video_to_cloud", fake_cloud)
    return calls


def _stub_verify(monkeypatch, content_type="image/jpeg"):
    calls = []

    async def fake_verify(url):
        calls.append(url)
        return {"ok": True, "status": 200, "content_type": content_type, "bytes": 2048, "reason": ""}

    monkeypatch.setattr(main, "verify_cloud_media_direct_url", fake_verify)
    return calls


def _run(ref, provider=None):
    return asyncio.run(main.upload_video_image_for_apimart(object(), provider or _provider(), ref))


def _prepare(monkeypatch, tmp_path, name="online_temp_first.jpg"):
    local = _solid_jpeg(tmp_path / name)
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    return "/assets/output/" + name


# --- 默认策略：图床优先 ---

def test_default_source_uses_temp_host_and_never_uploads_to_apimart(monkeypatch, tmp_path, capsys):
    ref = _prepare(monkeypatch, tmp_path)
    now = [1000.0]
    monkeypatch.setattr(main, "apimart_cache_now", lambda: now[0])
    upload_calls = _stub_upload(monkeypatch, _Resp(200, {"url": "https://getapib.org/image/should_not_be_used.jpg"}))
    temp_calls = _stub_temp_host(monkeypatch, url="https://a.uguu.se/temp_first.jpg", service="uguu")
    verify_calls = _stub_verify(monkeypatch)

    result = _run(ref)

    assert result == "https://a.uguu.se/temp_first.jpg"
    assert upload_calls == [], "默认策略不许调用 APIMart /v1/uploads/images"
    assert temp_calls == [ref]
    assert verify_calls == [result]
    entries = list(main._APIMART_UPLOAD_CACHE.values())
    assert len(entries) == 1
    assert entries[0]["url"] == result
    assert entries[0]["source"] == "temp-host:uguu"
    assert entries[0]["expires_at"] == 1000.0 + 150 * 60
    out = capsys.readouterr().out
    assert "temp-host(uguu)" in out, out
    assert "APIMART_IMAGE_SOURCE=temp" in out, out


def test_apimart_source_restores_official_upload_first(monkeypatch, tmp_path, capsys):
    ref = _prepare(monkeypatch, tmp_path)
    monkeypatch.setenv("APIMART_IMAGE_SOURCE", "apimart")
    now = [2000.0]
    monkeypatch.setattr(main, "apimart_cache_now", lambda: now[0])
    upload_calls = _stub_upload(monkeypatch, _Resp(200, {"url": "https://getapib.org/image/old_order.jpg"}))
    temp_calls = _stub_temp_host(monkeypatch)

    result = _run(ref)

    assert result == "https://getapib.org/image/old_order.jpg"
    assert len(upload_calls) == 1
    assert temp_calls == [], "apimart 模式先官方上传，成功就不碰图床"
    entry = list(main._APIMART_UPLOAD_CACHE.values())[0]
    assert entry["source"] == "apimart-upload"
    assert entry["expires_at"] == 2000.0 + 24 * 60 * 60
    out = capsys.readouterr().out
    assert "APIMART_IMAGE_SOURCE=apimart" in out, out


def test_unknown_source_value_defaults_to_temp(monkeypatch):
    monkeypatch.setenv("APIMART_IMAGE_SOURCE", "whatever")
    assert main.apimart_image_source() == "temp"


def test_temp_host_failure_falls_back_to_apimart_upload(monkeypatch, tmp_path, capsys):
    ref = _prepare(monkeypatch, tmp_path)
    upload_calls = _stub_upload(monkeypatch, _Resp(200, {"url": "https://getapib.org/image/fallback.jpg"}))
    temp_calls = _stub_temp_host(monkeypatch, error=main.HTTPException(status_code=502, detail=TEMP_HOST_FAIL))

    result = _run(ref)

    assert result == "https://getapib.org/image/fallback.jpg"
    assert len(temp_calls) == 1, "默认先试一次图床"
    assert len(upload_calls) == 1, "图床失败必须回退 APIMart 上传"
    entry = list(main._APIMART_UPLOAD_CACHE.values())[0]
    assert entry["source"] == "apimart-upload"
    assert "临时图床不可用，回退 APIMart 上传" in capsys.readouterr().out


def test_temp_host_failure_then_apimart_429_returns_quota_reason(monkeypatch, tmp_path):
    ref = _prepare(monkeypatch, tmp_path)
    upload_calls = _stub_upload(monkeypatch, _Resp(429, QUOTA_PAYLOAD, QUOTA_TEXT))
    temp_calls = _stub_temp_host(monkeypatch, error=main.HTTPException(status_code=502, detail=TEMP_HOST_FAIL))

    result = _run(ref)

    assert result.startswith("ERR:APIMart 图片上传额度已用尽"), result
    assert "临时图床兜底失败" in result and TEMP_HOST_FAIL in result, result
    assert "2000" in result and "建议" in result
    assert len(upload_calls) == 1
    assert len(temp_calls) == 1, "图床已经失败过，429 时不再重复试"
    assert main._APIMART_UPLOAD_CACHE == {}, "额度失败不能进缓存"


# --- 缓存 TTL ---

def test_same_path_hits_cache_within_ttl(monkeypatch, tmp_path):
    ref = _prepare(monkeypatch, tmp_path)
    now = [5000.0]
    monkeypatch.setattr(main, "apimart_cache_now", lambda: now[0])
    upload_calls = _stub_upload(monkeypatch, _Resp(500, {"error": "boom"}))
    temp_calls = _stub_temp_host(monkeypatch, url="https://a.uguu.se/cached_once.jpg", service="uguu")
    _stub_verify(monkeypatch)

    first = _run(ref)
    now[0] += 150 * 60 - 1
    second = _run(ref)

    assert first == second == "https://a.uguu.se/cached_once.jpg"
    assert len(temp_calls) == 1, "TTL 未过期，同 path 第二次不许重复传图床"
    assert upload_calls == []
    assert len(main._APIMART_UPLOAD_CACHE) == 1


def test_expired_cache_entry_reuploads_temp_host(monkeypatch, tmp_path, capsys):
    ref = _prepare(monkeypatch, tmp_path)
    now = [8000.0]
    monkeypatch.setattr(main, "apimart_cache_now", lambda: now[0])
    upload_calls = _stub_upload(monkeypatch, _Resp(500, {"error": "boom"}))
    temp_calls = _stub_temp_host(monkeypatch, queue=[
        ("https://a.uguu.se/first.jpg", "uguu"),
        ("https://a.uguu.se/second.jpg", "uguu"),
    ])
    _stub_verify(monkeypatch)

    first = _run(ref)
    now[0] += 150 * 60
    second = _run(ref)

    assert first == "https://a.uguu.se/first.jpg"
    assert second == "https://a.uguu.se/second.jpg", "uguu 150 分钟 TTL 到期必须重新上传"
    assert len(temp_calls) == 2
    assert upload_calls == []
    entry = list(main._APIMART_UPLOAD_CACHE.values())[0]
    assert entry["url"] == second
    assert entry["expires_at"] == now[0] + 150 * 60
    assert "缓存已过期" in capsys.readouterr().out


@pytest.mark.parametrize("service,ttl", [
    ("litterbox", 66 * 60 * 60),
    ("temp.sh", 66 * 60 * 60),
])
def test_temp_host_ttl_follows_service(monkeypatch, tmp_path, service, ttl):
    ref = _prepare(monkeypatch, tmp_path)
    now = [100.0]
    monkeypatch.setattr(main, "apimart_cache_now", lambda: now[0])
    _stub_upload(monkeypatch, _Resp(500, {"error": "boom"}))
    _stub_temp_host(monkeypatch, url="https://host.example/image.jpg", service=service)
    _stub_verify(monkeypatch)

    _run(ref)

    entry = list(main._APIMART_UPLOAD_CACHE.values())[0]
    assert entry["expires_at"] == now[0] + ttl


def test_cache_still_caps_at_200_entries(monkeypatch):
    now = [0.0]
    monkeypatch.setattr(main, "apimart_cache_now", lambda: now[0])
    for index in range(main.APIMART_UPLOAD_CACHE_MAX + 5):
        main.apimart_upload_cache_put("key-%d" % index, "https://cdn.example/%d.jpg" % index, 60, "test")
    assert len(main._APIMART_UPLOAD_CACHE) == main.APIMART_UPLOAD_CACHE_MAX
    assert "key-0" not in main._APIMART_UPLOAD_CACHE
    assert "key-4" not in main._APIMART_UPLOAD_CACHE
    assert "key-5" in main._APIMART_UPLOAD_CACHE


# --- data URL 输入：同样图床优先，落盘临时文件用完删除 ---

def test_data_url_input_temp_first_spills_and_cleans_up(monkeypatch, tmp_path):
    _isolate_output_dir(monkeypatch, tmp_path)
    raw = Path(_solid_jpeg(tmp_path / "solid_src.jpg")).read_bytes()
    data_url = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
    upload_calls = _stub_upload(monkeypatch, _Resp(200, {"url": "https://getapib.org/image/should_not_be_used.jpg"}))
    seen = []

    async def fake_cloud(ref_url, service_name="auto"):
        name = os.path.basename(ref_url)
        seen.append({"ref": ref_url, "exists": os.path.exists(str(tmp_path / name))})
        return {"url": "https://litterbox.catbox.moe/data_url_temp.jpg", "service": "litterbox", "source": ref_url}

    monkeypatch.setattr(main, "upload_local_video_to_cloud", fake_cloud)
    verify_calls = _stub_verify(monkeypatch)

    result = asyncio.run(main.upload_image_for_apimart(
        object(), _provider(), data_url, prefer_temp_host=True))

    assert result == "https://litterbox.catbox.moe/data_url_temp.jpg"
    assert upload_calls == [], "data URL 默认也先走图床"
    assert len(seen) == 1
    assert seen[0]["ref"].startswith("/output/apimart_tmp_"), seen
    assert seen[0]["ref"].endswith(".jpg"), "mime → 扩展名要保住 image/*，否则图床链路拒收"
    assert seen[0]["exists"] is True
    assert not list(tmp_path.glob("apimart_tmp_*")), "临时文件用完必须删除"
    assert verify_calls == [result]
    assert main._APIMART_UPLOAD_CACHE == {}, "data URL 没有稳定缓存键，不写缓存"