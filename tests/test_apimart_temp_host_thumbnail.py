"""APIMart 视频输入（图床优先）：本地大图先压到视频输入够用的档位再传图床。

用户实测 2.4MB / 3392x5056 JPEG 原图能传到 uguu（约 10 秒），但 VEO 这类视频接口首帧
不需要 5000px。这里守五件事：
  * 长边 >2048 或文件 >1.2MB 的本地大图，传给图床的字节 ≤900KB 且长边 ≤2048（JPEG）；
  * 小图（≤1.2MB 且长边 ≤2048）原样字节直传，不额外重编码；
  * 压缩失败（坏图、极窄长图等）回退原文件直传，不直接失败；
  * 压缩用临时文件，上传后立即清理（上传异常也清理）；
  * 缓存键仍是原文件 path+mtime+size，命中时不再压缩 / 上传。
全部离线：假图床 / 假 GET，不联网。
"""
import asyncio
import os
import sys
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

PROVIDER = {"id": "apimart", "name": "APIMART", "base_url": "https://apib.ai", "use_proxy": "off"}
TEMP_HOST_URL = "https://a.uguu.se/video_input_thumb.jpg"


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    main._APIMART_UPLOAD_CACHE.clear()
    monkeypatch.setenv("API_PROVIDER_APIMART_KEY", "sk-unit-test")
    monkeypatch.delenv("APIMART_IMAGE_SOURCE", raising=False)
    yield
    main._APIMART_UPLOAD_CACHE.clear()


def _isolate_output_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "output_path_for", lambda filename, category="output": str(tmp_path / filename))
    monkeypatch.setattr(main, "output_url_for", lambda filename, category="output": "/assets/output/" + filename)


def _noise_jpeg(path, size, quality=95):
    img = Image.frombytes("RGB", size, os.urandom(size[0] * size[1] * 3))
    img.save(str(path), format="JPEG", quality=quality)
    return str(path)


def _solid_jpeg(path, size=(640, 480)):
    img = Image.new("RGB", size, (120, 180, 240))
    img.save(str(path), format="JPEG", quality=80)
    return str(path)


def _prepare(monkeypatch, tmp_path, name, maker):
    local = maker(tmp_path / name)
    monkeypatch.setattr(main, "output_file_from_url", lambda url: local)
    return "/assets/output/" + name


def _stub_cloud(monkeypatch, tmp_path, url=TEMP_HOST_URL, service="uguu", error=None):
    calls = []

    async def fake_cloud(ref_url, service_name="auto"):
        path = str(tmp_path / os.path.basename(str(ref_url)))
        calls.append({
            "ref": ref_url,
            "service": service_name,
            "exists": os.path.exists(path),
            "bytes": Path(path).read_bytes() if os.path.exists(path) else b"",
        })
        if error is not None:
            raise error
        return {"url": url, "service": service, "source": ref_url}

    monkeypatch.setattr(main, "upload_local_video_to_cloud", fake_cloud)
    return calls


def _stub_verify(monkeypatch, content_type="image/jpeg"):
    calls = []

    async def fake_verify(url):
        calls.append(url)
        return {"ok": True, "status": 200, "content_type": content_type, "bytes": 2048, "reason": ""}

    monkeypatch.setattr(main, "verify_cloud_media_direct_url", fake_verify)
    return calls


def _run(ref):
    return asyncio.run(main.upload_video_image_for_apimart(object(), dict(PROVIDER), ref))


# --- 大图：先压缩再传 ---

def test_long_edge_over_2048_compresses_before_upload(monkeypatch, tmp_path, capsys):
    _isolate_output_dir(monkeypatch, tmp_path)
    ref = _prepare(monkeypatch, tmp_path, "big_2600x1400.jpg",
                   lambda path: _noise_jpeg(path, (2600, 1400), quality=95))
    original_bytes = os.path.getsize(str(tmp_path / "big_2600x1400.jpg"))
    assert original_bytes > main.APIMART_VIDEO_INPUT_MAX_BYTES
    calls = _stub_cloud(monkeypatch, tmp_path)
    _stub_verify(monkeypatch)

    result = _run(ref)

    assert result == TEMP_HOST_URL
    assert len(calls) == 1
    uploaded_ref = calls[0]["ref"]
    assert uploaded_ref != ref, "大图不许原图直传"
    assert uploaded_ref.startswith("/assets/output/apimart_thumb_"), uploaded_ref
    assert uploaded_ref.endswith(".jpg")
    assert calls[0]["exists"] is True, "上传发生时临时压缩文件必须已落盘"
    payload = calls[0]["bytes"]
    assert 0 < len(payload) <= main.APIMART_VIDEO_INPUT_MAX_BYTES, len(payload)
    with Image.open(BytesIO(payload)) as shrunk:
        assert max(shrunk.size) <= main.APIMART_VIDEO_INPUT_MAX_DIM, shrunk.size
        assert shrunk.format == "JPEG"
    assert not list(tmp_path.glob("apimart_thumb_*")), "临时压缩文件上传后必须删除"
    entry = list(main._APIMART_UPLOAD_CACHE.values())[0]
    assert entry["url"] == TEMP_HOST_URL
    out = capsys.readouterr().out
    assert "视频输入图床压缩：" in out, out
    assert "2600x1400" in out and "→" in out and "字节" in out, out
    assert "temp-host(uguu)" in out, out


def test_file_over_1_2mb_compresses_even_when_long_edge_is_2048(monkeypatch, tmp_path, capsys):
    _isolate_output_dir(monkeypatch, tmp_path)
    ref = _prepare(monkeypatch, tmp_path, "big_2048.jpg",
                   lambda path: _noise_jpeg(path, (2048, 2048), quality=100))
    assert os.path.getsize(str(tmp_path / "big_2048.jpg")) > main.APIMART_VIDEO_INPUT_PASSTHROUGH_BYTES
    calls = _stub_cloud(monkeypatch, tmp_path)
    _stub_verify(monkeypatch)

    _run(ref)

    uploaded_ref = calls[0]["ref"]
    assert uploaded_ref.startswith("/assets/output/apimart_thumb_"), uploaded_ref
    with Image.open(BytesIO(calls[0]["bytes"])) as shrunk:
        assert max(shrunk.size) <= main.APIMART_VIDEO_INPUT_MAX_DIM
    assert len(calls[0]["bytes"]) <= main.APIMART_VIDEO_INPUT_MAX_BYTES
    assert not list(tmp_path.glob("apimart_thumb_*"))
    assert "视频输入图床压缩：" in capsys.readouterr().out


# --- 小图：原样直传 ---

def test_small_image_uploads_original_bytes_without_reencode(monkeypatch, tmp_path, capsys):
    _isolate_output_dir(monkeypatch, tmp_path)
    ref = _prepare(monkeypatch, tmp_path, "small_640x480.jpg", _solid_jpeg)
    original = Path(str(tmp_path / "small_640x480.jpg")).read_bytes()
    assert len(original) <= main.APIMART_VIDEO_INPUT_PASSTHROUGH_BYTES
    calls = _stub_cloud(monkeypatch, tmp_path)
    _stub_verify(monkeypatch)

    result = _run(ref)

    assert result == TEMP_HOST_URL
    assert calls[0]["ref"] == ref, "小图必须原样直传，不落临时文件"
    assert calls[0]["bytes"] == original, "小图不许重编码"
    assert not list(tmp_path.glob("apimart_thumb_*"))
    out = capsys.readouterr().out
    assert "视频输入图床压缩：" not in out, out
    assert "temp-host(uguu)" in out, out


# --- 压缩失败：回退原文件 ---

def test_compress_error_falls_back_to_original_file(monkeypatch, tmp_path, capsys):
    _isolate_output_dir(monkeypatch, tmp_path)
    ref = _prepare(monkeypatch, tmp_path, "broken_big.jpg",
                   lambda path: _noise_jpeg(path, (2600, 1400), quality=90))
    original = Path(str(tmp_path / "broken_big.jpg")).read_bytes()

    def boom(img, budget, max_dim, stem):
        raise ValueError("模拟极窄长图压缩失败")

    monkeypatch.setattr(main, "apimart_jpeg_payload", boom)
    calls = _stub_cloud(monkeypatch, tmp_path)
    _stub_verify(monkeypatch)

    result = _run(ref)

    assert result == TEMP_HOST_URL, "压缩失败必须回退原文件直传，不能整体失败"
    assert calls[0]["ref"] == ref
    assert calls[0]["bytes"] == original
    assert not list(tmp_path.glob("apimart_thumb_*"))
    out = capsys.readouterr().out
    assert "视频输入图床压缩失败，回退原图直传" in out, out


def test_upload_failure_cleans_temp_thumbnail(monkeypatch, tmp_path):
    _isolate_output_dir(monkeypatch, tmp_path)
    _prepare(monkeypatch, tmp_path, "big_upload_fail.jpg",
             lambda path: _noise_jpeg(path, (2600, 1400), quality=90))
    _stub_cloud(monkeypatch, tmp_path,
                error=main.HTTPException(status_code=502, detail="uguu 连接超时"))

    with pytest.raises(main.HTTPException):
        asyncio.run(main.apimart_image_via_temp_host("/assets/output/big_upload_fail.jpg"))

    assert not list(tmp_path.glob("apimart_thumb_*")), "上传异常也要删掉临时压缩文件"
    assert main._APIMART_UPLOAD_CACHE == {}


# --- 缓存命中：不压缩、不重复上传 ---

def test_cache_hit_skips_compression_and_upload(monkeypatch, tmp_path, capsys):
    _isolate_output_dir(monkeypatch, tmp_path)
    ref = _prepare(monkeypatch, tmp_path, "big_cached.jpg",
                   lambda path: _noise_jpeg(path, (2600, 1400), quality=95))
    calls = _stub_cloud(monkeypatch, tmp_path)
    _stub_verify(monkeypatch)

    first = _run(ref)
    capsys.readouterr()
    second = _run(ref)

    assert first == second == TEMP_HOST_URL
    assert len(calls) == 1, "TTL 未过期，第二次必须命中缓存、不再压缩上传"
    assert not list(tmp_path.glob("apimart_thumb_*"))
    out = capsys.readouterr().out
    assert "缓存命中" in out, out
    assert "视频输入图床压缩：" not in out, "缓存命中不做压缩"
