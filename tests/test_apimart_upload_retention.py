# -*- coding: utf-8 -*-
"""APIMart 上传保留期：URL 固定带 retention_days=3 + 响应 bytes/retention_days/expires_at 保真。

文档 L80789–L80912：
  * retention_days 只认 URL query（form 字段无效），不传就跟随控制台默认档；默认是 7/15/30 时
    每次上传都按字节计费 → 本项目固定带 3 天档（免费额度内），可用环境变量覆盖；
  * 响应含 url / bytes / retention_days / expires_at，缓存 TTL 优先用 expires_at。
不联网：全部用假客户端。
"""
import asyncio
import base64
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main  # noqa: E402

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


class _Resp:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


def _provider():
    return {"id": "apimart", "name": "APIMart", "protocol": "apimart",
            "base_url": "https://api.apimart.ai"}


def test_retention_defaults_to_three_days(monkeypatch):
    monkeypatch.delenv(main.APIMART_UPLOAD_RETENTION_ENV, raising=False)
    assert main.apimart_upload_retention_days() == 3
    assert main.apimart_upload_url("https://api.apimart.ai", "/v1/uploads/images") == \
        "https://api.apimart.ai/v1/uploads/images?retention_days=3"


def test_retention_env_override_and_invalid_falls_back(monkeypatch):
    monkeypatch.setenv(main.APIMART_UPLOAD_RETENTION_ENV, "7")
    assert main.apimart_upload_retention_days() == 7
    monkeypatch.setenv(main.APIMART_UPLOAD_RETENTION_ENV, "9")
    assert main.apimart_upload_retention_days() == 3, "非 3/7/15/30 的档位回退 3 天"


def test_upload_response_meta_keeps_all_fields():
    payload = {"url": "https://cdn.example/x.png", "bytes": 235680,
               "retention_days": 3, "expires_at": 1794182400}
    assert main.apimart_upload_response_meta(payload) == {
        "bytes": 235680, "retention_days": 3, "expires_at": 1794182400}
    # data 包裹的写法也认
    assert main.apimart_upload_response_meta({"data": {"bytes": 12, "expires_at": 99}}) == \
        {"bytes": 12, "expires_at": 99}


def test_cache_ttl_prefers_expires_at(monkeypatch):
    now = main.apimart_cache_now()
    payload = {"retention_days": 30, "expires_at": now + 600}
    assert 590 <= main.apimart_upload_cache_ttl(payload, 3600) <= 600
    # 没有 expires_at 时按 retention_days，最多 2 天
    assert main.apimart_upload_cache_ttl({"retention_days": 30}, 3600) == 2 * 24 * 60 * 60


def test_cache_entry_keeps_upload_meta(monkeypatch):
    monkeypatch.setattr(main, "_APIMART_UPLOAD_CACHE", {})
    main.apimart_upload_cache_put("k", "https://cdn.example/x.png", 60, "test",
                                  {"bytes": 5, "retention_days": 3, "expires_at": 1794182400})
    entry = main._APIMART_UPLOAD_CACHE["k"]
    assert entry["meta"] == {"bytes": 5, "retention_days": 3, "expires_at": 1794182400}


def test_native_video_upload_url_and_meta_passthrough(monkeypatch):
    # 不依赖本机 API/.env：上传链路会先过 api_headers 的 Key 校验，这里换成空头
    monkeypatch.setattr(main, "api_headers", lambda *args, **kwargs: {})
    calls = []
    expires_at = int(time.time()) + 3600

    class Client:
        async def post(self, url, headers=None, files=None, timeout=None):
            calls.append(url)
            return _Resp(200, {"url": "https://cdn.example/ref.mp4", "bytes": 42,
                               "retention_days": 3, "expires_at": expires_at})

    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, "ref.mp4")
        with open(path, "wb") as handle:
            handle.write(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32)
        url, error, ttl, meta = asyncio.run(main.apimart_native_video_upload(Client(), _provider(), path))

    assert url == "https://cdn.example/ref.mp4" and error == ""
    assert calls[0].endswith("/v1/uploads/videos?retention_days=3"), calls
    assert meta == {"bytes": 42, "retention_days": 3, "expires_at": expires_at}
    assert 3500 <= ttl <= 3600, ttl
    assert main.apimart_upload_last_meta()["expires_at"] == expires_at


def test_image_upload_url_carries_retention(monkeypatch):
    # 同上：图片上传在组装 headers 时也会校验 Key，测试自带空头保证隔离环境可跑
    monkeypatch.setattr(main, "api_headers", lambda *args, **kwargs: {})
    calls = []
    expires_at = int(time.time()) + 3600

    async def fake_upload(client, upload_url, headers, variants, timeout=60):
        calls.append(upload_url)
        return _Resp(200, {"url": "https://cdn.example/ref.png", "bytes": 7,
                           "retention_days": 3, "expires_at": expires_at}), [1]

    monkeypatch.setattr(main, "apimart_upload_with_shrink", fake_upload)
    data_url = "data:image/png;base64," + base64.b64encode(PNG_1X1).decode()
    url = asyncio.run(main.upload_image_for_apimart(object(), _provider(), data_url))
    assert url == "https://cdn.example/ref.png"
    assert calls[0].endswith("/v1/uploads/images?retention_days=3"), calls
    assert main.apimart_upload_last_meta() == {
        "bytes": 7, "retention_days": 3, "expires_at": expires_at}
