"""APIMart 图片上传：网关按 1MB 请求体拦 413，上传前要压到档位内，413 时逐档降级重试。

实测 apib.ai：1049620 字节 → 413，1035348 字节 → 200，所以首档取 900KB。
用 Pillow 现场生成大图，不依赖用户私有文件，也不联网（真实上传见 /tmp 一次性验证脚本）。
"""
import asyncio
import base64
import json
import os
import sys
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

PNG_MIME = "image/png"


class _Resp:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text or json.dumps(self._payload)

    def json(self):
        return self._payload


def _noise_png(width=2200, height=1500):
    img = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(scope="module")
def big_png_bytes():
    data = _noise_png()
    assert len(data) > main.APIMART_UPLOAD_TIERS[0][0]
    return data


def _data_url(data, mime=PNG_MIME):
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


def _provider():
    return {"id": "apimart", "name": "APIMART", "base_url": "https://apib.ai", "use_proxy": "off"}


@pytest.fixture(autouse=True)
def _api_key(monkeypatch):
    monkeypatch.setenv("API_PROVIDER_APIMART_KEY", "sk-unit-test")


def test_tiers_shrink_and_respect_budget(big_png_bytes):
    variants = list(main.apimart_upload_payload_variants(data=big_png_bytes, mime=PNG_MIME, name_hint="big"))
    assert len(variants) == len(main.APIMART_UPLOAD_TIERS)
    sizes = [len(item[1]) for item in variants]
    assert all(size <= budget for size, (budget, _dim) in zip(sizes, main.APIMART_UPLOAD_TIERS))
    assert all(later < earlier for earlier, later in zip(sizes, sizes[1:])), sizes
    for (filename, content, content_type, _tier), (_budget, max_dim) in zip(variants, main.APIMART_UPLOAD_TIERS):
        assert content_type == "image/jpeg"
        assert filename.endswith(".jpg")
        with Image.open(BytesIO(content)) as out:
            assert out.format == "JPEG"
            assert out.mode == "RGB"
            assert max(out.size) <= max_dim


def test_alpha_flattened_onto_white_rgb_jpeg():
    img = Image.new("RGBA", (1600, 1200), (220, 30, 30, 255))
    img.paste(Image.new("RGBA", (800, 600), (0, 0, 0, 0)), (0, 0))
    filename, payload, content_type = main.apimart_jpeg_payload(img, 256_000, 1024, "alpha")
    assert filename == "alpha.jpg"
    assert content_type == "image/jpeg"
    assert len(payload) <= 256_000
    with Image.open(BytesIO(payload)) as out:
        assert out.format == "JPEG"
        assert out.mode == "RGB"
        r, g, b = out.getpixel((10, 10))
        assert r > 245 and g > 245 and b > 245


def test_413_downgrades_then_succeeds(monkeypatch, big_png_bytes):
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append((file_tuple[0], len(file_tuple[1]), file_tuple[2]))
        if len(calls) == 1:
            return _Resp(413, text="<html><head><title>413 Request Entity Too Large</title></head></html>")
        return _Resp(200, {"url": "https://getapib.org/image/uploaded_ok"})

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    url = asyncio.run(main.upload_image_for_apimart(object(), _provider(), _data_url(big_png_bytes)))
    assert url == "https://getapib.org/image/uploaded_ok"
    assert len(calls) == 2
    assert calls[0][1] <= main.APIMART_UPLOAD_TIERS[0][0]
    assert calls[1][1] < calls[0][1]
    assert calls[0][2] == calls[1][2] == "image/jpeg"


def test_local_path_413_downgrades_then_succeeds(monkeypatch, tmp_path, big_png_bytes):
    local = tmp_path / "online_big.png"
    local.write_bytes(big_png_bytes)
    monkeypatch.setattr(main, "output_file_from_url", lambda url: str(local))
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(len(file_tuple[1]))
        if len(calls) == 1:
            return _Resp(413, text="<html>413 Request Entity Too Large</html>")
        return _Resp(200, {"url": "https://getapib.org/image/local_ok"})

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    url = asyncio.run(main.upload_image_for_apimart(object(), _provider(), "/assets/output/online_big.png"))
    assert url == "https://getapib.org/image/local_ok"
    assert len(calls) == 2


def test_all_413_reports_tiers(monkeypatch, big_png_bytes):
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(len(file_tuple[1]))
        return _Resp(413, text="<html>413 Request Entity Too Large</html>")

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    result = asyncio.run(main.upload_image_for_apimart(object(), _provider(), _data_url(big_png_bytes)))
    assert result.startswith("ERR:")
    assert "413" in result
    assert "最后一档" in result
    assert "900KB/2048px" in result
    assert "256KB/1024px" in result
    assert len(calls) == len(main.APIMART_UPLOAD_TIERS)
    assert f"{calls[-1]} 字节" in result


def test_non_413_is_not_retried(monkeypatch, big_png_bytes):
    calls = []

    async def fake_post(client, upload_url, headers, file_tuple, timeout=60):
        calls.append(len(file_tuple[1]))
        return _Resp(401, {"error": "invalid api key"})

    monkeypatch.setattr(main, "apimart_upload_post", fake_post)
    result = asyncio.run(main.upload_image_for_apimart(object(), _provider(), _data_url(big_png_bytes)))
    assert result == "ERR:APIMart 上传失败(401)"
    assert len(calls) == 1


def test_canvas_llm_chat_images_fit_gateway_budget(big_png_bytes):
    inline = _data_url(big_png_bytes)
    remote = "https://cdn.example.com/reference.png"
    body = {
        "model": "gpt-4o-mini",
        "stream": False,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "描述参考图和视频抽帧"},
                {"type": "image_url", "image_url": {"url": inline}},
                {"type": "image_url", "image_url": {"url": remote}},
            ],
        }],
    }
    assert main.apimart_chat_request_bytes(body) > main.APIMART_JSON_BODY_BUDGET

    result = main.fit_apimart_chat_request_to_gateway(body)

    assert result is body
    assert main.apimart_chat_request_bytes(body) <= main.APIMART_JSON_BODY_BUDGET
    parts = body["messages"][0]["content"]
    assert parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert len(parts[1]["image_url"]["url"]) < len(inline)
    assert parts[2]["image_url"]["url"] == remote


def test_canvas_llm_impl_sends_compressed_request_and_returns_text(monkeypatch, big_png_bytes):
    sent = []

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, headers, json):
            sent.append(json)
            request = main.httpx.Request("POST", url, headers=headers, json=json)
            return main.httpx.Response(
                200,
                request=request,
                json={"choices": [{"message": {"content": "压缩后生成成功"}}]},
            )

    monkeypatch.setattr(main.httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(main, "get_api_provider", lambda _provider_id: _provider())
    monkeypatch.setattr(
        main,
        "resolve_chat_provider",
        lambda _provider_id, _model, _ms_model: ("https://apib.ai/v1", {}, "gpt-4o-mini"),
    )
    payload = main.CanvasLLMRequest(
        message="描述这张参考图",
        provider="apimart",
        model="gpt-4o-mini",
        images=[_data_url(big_png_bytes)],
        no_prompt_intelligence=True,
    )

    result = asyncio.run(main._canvas_llm_impl(payload))

    assert result["text"] == "压缩后生成成功"
    assert len(sent) == 1
    assert main.apimart_chat_request_bytes(sent[0]) <= main.APIMART_JSON_BODY_BUDGET
    image_url = sent[0]["messages"][0]["content"][1]["image_url"]["url"]
    assert image_url.startswith("data:image/jpeg;base64,")
