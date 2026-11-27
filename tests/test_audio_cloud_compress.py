"""APIMart 参考音频按 1MiB 上传预算压缩（mock ffmpeg / 图床 / 原生上传，不联网）。

守这些行为：
  * 文件 ≤ 预算直接用原文件，不调 ffmpeg；
  * 超预算按「预算 × 8 / 时长」算目标码率（10% 余量，32~128kbps），<96kbps 单声道，输出 mp3；
  * 32kbps 单声道仍超预算 → over_budget，文案写「音频 N 秒，1MB 上限最多容纳约 4 分 10 秒」；
  * /v1/uploads/audios 413 立即失败，不再试 /files、/images；
  * 成功写缓存（TTL ≤ 2 天），二次生成不重复上传；
  * data URL 音频先落临时文件，压缩/上传后（成功失败都）删除。
"""
import asyncio
import base64
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

PROVIDER = {"id": "apimart", "name": "APIMART", "base_url": "https://apib.ai", "use_proxy": "off"}
REF = "/output/ref.mp3"
AUDIO_URL = "https://getapib.org/audio/ref.mp3"
CLOUD_URL = "https://a.uguu.se/audio.mp3"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in ("PUBLIC_BASE_URL", "PUBLIC_MEDIA_BASE_URL", "CLOUD_MEDIA_UPLOAD_SERVICE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("API_PROVIDER_APIMART_KEY", "sk-unit-test")
    main._APIMART_UPLOAD_CACHE.clear()
    yield
    main._APIMART_UPLOAD_CACHE.clear()


class _FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text or json.dumps(payload or {}, ensure_ascii=False)

    def json(self):
        if self._payload is None:
            raise ValueError("no json body")
        return self._payload


class _FakeClient:
    """原生上传用的假 client：记录每次 POST，按预设状态码返回。"""

    def __init__(self, status_code=404, payload=None, text=""):
        self.response = _FakeResponse(status_code, payload, text)
        self.calls = []

    async def post(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        return self.response


class _FakeFFmpeg:
    def __init__(self, payload=b"compressed-audio", returncode=0, stderr="",
                 ffmpeg="/usr/bin/ffmpeg", ffprobe="/usr/bin/ffprobe"):
        self.payload = payload
        self.returncode = returncode
        self.stderr = stderr
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
        self.commands = []
        self.run_calls = 0

    def which(self, name):
        if name == "ffmpeg":
            return self.ffmpeg
        if name == "ffprobe":
            return self.ffprobe
        return None

    def run(self, cmd, **kwargs):
        self.run_calls += 1
        self.commands.append(list(cmd))
        if self.returncode == 0:
            with open(cmd[-1], "wb") as fh:
                fh.write(self.payload)
        return SimpleNamespace(returncode=self.returncode, stdout="", stderr=self.stderr)

    def install(self, monkeypatch):
        monkeypatch.setattr(main.shutil, "which", self.which)
        monkeypatch.setattr(main.subprocess, "run", self.run)


def _source(tmp_path, size=1024):
    path = tmp_path / "ref.mp3"
    path.write_bytes(b"\x00" * size)
    return str(path)


def _patch_local(monkeypatch, source):
    monkeypatch.setattr(main, "output_file_from_url", lambda url: source)


def _patch_duration(monkeypatch, value):
    monkeypatch.setattr(main, "probe_video_file_duration_seconds", lambda path: value)


def _stub_cloud(monkeypatch, calls, error=None):
    async def fake(ref_url, service="auto", path_override=""):
        info = {
            "ref": ref_url,
            "path_override": path_override,
            "exists": bool(path_override) and os.path.isfile(path_override),
            "size": os.path.getsize(path_override) if path_override and os.path.isfile(path_override) else 0,
        }
        calls.append(info)
        if error is not None:
            raise error
        return {"url": CLOUD_URL, "service": "uguu", "source": ref_url}

    monkeypatch.setattr(main, "upload_local_video_to_cloud", fake)
    return calls


def _isolate_temp(monkeypatch, tmp_path):
    created = []
    counter = iter(range(1000))

    def fake_mkstemp(prefix="", suffix="", dir=None, **kwargs):
        path = str(tmp_path / f"{prefix}{next(counter)}{suffix or ''}")
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        created.append(path)
        return fd, path

    monkeypatch.setattr(main.tempfile, "mkstemp", fake_mkstemp)
    return created


def _run(client=None):
    return asyncio.run(main.upload_audio_for_apimart(client or _FakeClient(), PROVIDER, REF))


def test_audio_under_budget_skips_ffmpeg_and_caches(monkeypatch, tmp_path):
    source = _source(tmp_path, size=1000)
    _patch_local(monkeypatch, source)
    _patch_duration(monkeypatch, 10.0)
    ffmpeg = _FakeFFmpeg()
    ffmpeg.install(monkeypatch)
    client = _FakeClient(200, {"url": AUDIO_URL, "retention_days": 3})

    result = _run(client)

    assert result == AUDIO_URL
    assert ffmpeg.run_calls == 0, "文件没超预算不能调 ffmpeg"
    assert client.calls[0]["url"].endswith("/v1/uploads/audios?retention_days=3")
    assert client.calls[0]["files"]["file"][1] == b"\x00" * 1000
    entries = list(main._APIMART_UPLOAD_CACHE.values())
    assert [entry["url"] for entry in entries] == [AUDIO_URL]
    ttl = entries[0]["expires_at"] - main.apimart_cache_now()
    assert 0 < ttl <= 2 * 24 * 60 * 60


def test_audio_over_budget_picks_bitrate_and_mono(monkeypatch, tmp_path):
    source = _source(tmp_path, size=4_000_000)
    _patch_local(monkeypatch, source)
    _patch_duration(monkeypatch, 100.0)
    created = _isolate_temp(monkeypatch, tmp_path)
    ffmpeg = _FakeFFmpeg(payload=b"a" * 700_000)
    ffmpeg.install(monkeypatch)
    client = _FakeClient(200, {"url": AUDIO_URL})

    result = _run(client)

    assert result == AUDIO_URL
    cmd = ffmpeg.commands[0]
    assert cmd[cmd.index("-c:a") + 1] == "libmp3lame"
    assert cmd[cmd.index("-b:a") + 1] == "72k", "1MB / 100 秒 → 72kbps（留 10% 余量）"
    assert cmd[cmd.index("-ac") + 1] == "1", "低于 96kbps 降单声道"
    assert client.calls[0]["files"]["file"][1] == b"a" * 700_000, "原生上传必须用压缩后的文件"
    assert created and all(not os.path.exists(path) for path in created), "压缩临时文件必须删"


def test_audio_short_file_clamps_to_128kbps_stereo(monkeypatch, tmp_path):
    source = _source(tmp_path, size=4_000_000)
    _patch_local(monkeypatch, source)
    _patch_duration(monkeypatch, 30.0)
    ffmpeg = _FakeFFmpeg(payload=b"b" * 400_000)
    ffmpeg.install(monkeypatch)
    client = _FakeClient(200, {"url": AUDIO_URL})

    result = _run(client)

    assert result == AUDIO_URL
    cmd = ffmpeg.commands[0]
    assert cmd[cmd.index("-b:a") + 1] == "128k", "算出来超过 128kbps 时封顶"
    assert cmd[cmd.index("-ac") + 1] == "2"


def test_audio_32kbps_still_over_budget_reports_capacity(monkeypatch, tmp_path):
    source = _source(tmp_path, size=4_000_000)
    _patch_local(monkeypatch, source)
    _patch_duration(monkeypatch, 300.0)
    created = _isolate_temp(monkeypatch, tmp_path)
    ffmpeg = _FakeFFmpeg(payload=b"c" * 1_200_000)
    ffmpeg.install(monkeypatch)
    _stub_cloud(monkeypatch, [], error=main.HTTPException(
        status_code=502, detail="<html><body><h1>502 Bad Gateway</h1></body></html>"))
    client = _FakeClient(413, text="<html><head><title>413 Request Entity Too Large</title></head></html>")

    result = _run(client)

    assert result.startswith("ERR:参考音频上传失败"), result
    cmd = ffmpeg.commands[0]
    assert cmd[cmd.index("-b:a") + 1] == "32k", "1MB / 300 秒算出来低于 32kbps 时取下限"
    assert cmd[cmd.index("-ac") + 1] == "1"
    assert "音频 300 秒" in result and "4 分 10 秒" in result, result
    assert "1MB" in result and "PUBLIC_BASE_URL" in result and "检查网络" in result
    assert "临时图床也不可用" in result and "502 Bad Gateway" in result
    assert "<html" not in result.lower() and "Request Entity Too Large" not in result
    assert len(client.calls) == 1, "413 后不再试 /files、/images"
    assert client.calls[0]["url"].endswith("/v1/uploads/audios?retention_days=3")
    assert created and all(not os.path.exists(path) for path in created), "失败也要删临时文件"


def test_audio_success_cached_across_runs(monkeypatch, tmp_path):
    source = _source(tmp_path, size=1000)
    _patch_local(monkeypatch, source)
    _patch_duration(monkeypatch, 10.0)
    ffmpeg = _FakeFFmpeg()
    ffmpeg.install(monkeypatch)
    cloud_calls = _stub_cloud(monkeypatch, [])
    client = _FakeClient(200, {"url": AUDIO_URL, "retention_days": 3})

    first = _run(client)
    second = _run(client)

    assert first == second == AUDIO_URL
    assert len(client.calls) == 1, "第二次应命中缓存，不重复烧上传额度"
    assert ffmpeg.run_calls == 0
    assert cloud_calls == []
    ttl = next(iter(main._APIMART_UPLOAD_CACHE.values()))["expires_at"] - main.apimart_cache_now()
    assert 2 * 24 * 60 * 60 - 5 <= ttl <= 2 * 24 * 60 * 60 + 5


def test_audio_data_url_spills_to_temp_then_cleans(monkeypatch, tmp_path):
    created = _isolate_temp(monkeypatch, tmp_path)
    raw = b"ID3\x04\x00\x00" + b"\x00" * 100
    data_url = "data:audio/mpeg;base64," + base64.b64encode(raw).decode("ascii")
    ffmpeg = _FakeFFmpeg()
    ffmpeg.install(monkeypatch)
    client = _FakeClient(200, {"url": AUDIO_URL})

    result = asyncio.run(main.upload_audio_for_apimart(client, PROVIDER, data_url))

    assert result == AUDIO_URL
    assert ffmpeg.run_calls == 0, "data URL 没超预算也不能调 ffmpeg"
    assert created, "data URL 必须先落临时文件"
    assert all(not os.path.exists(path) for path in created), "成功也要删临时文件"
    assert client.calls[0]["files"]["file"][0].endswith(".mp3")
    assert client.calls[0]["files"]["file"][1] == raw


def test_audio_no_ffmpeg_falls_back_to_original(monkeypatch, tmp_path, capsys):
    source = _source(tmp_path, size=4_000_000)
    _patch_local(monkeypatch, source)
    _patch_duration(monkeypatch, 100.0)
    ffmpeg = _FakeFFmpeg(ffmpeg=None)
    ffmpeg.install(monkeypatch)
    monkeypatch.setattr(main, "_system_media_dirs", lambda: [])
    monkeypatch.setattr(main, "_bundled_ffmpeg_dirs", lambda: [])
    monkeypatch.delenv("FFMPEG_PATH", raising=False)
    client = _FakeClient(200, {"url": AUDIO_URL})

    result = _run(client)

    assert result == AUDIO_URL
    assert ffmpeg.run_calls == 0
    assert client.calls[0]["files"]["file"][1] == b"\x00" * 4_000_000, "没 ffmpeg 就用原文件"
    assert "未找到 ffmpeg" in capsys.readouterr().out


def test_audio_unknown_duration_falls_back_to_original(monkeypatch, tmp_path, capsys):
    source = _source(tmp_path, size=4_000_000)
    _patch_local(monkeypatch, source)
    _patch_duration(monkeypatch, None)
    ffmpeg = _FakeFFmpeg()
    ffmpeg.install(monkeypatch)
    client = _FakeClient(200, {"url": AUDIO_URL})

    result = _run(client)

    assert result == AUDIO_URL
    assert ffmpeg.run_calls == 0, "探测不到时长不能瞎压"
    assert client.calls[0]["files"]["file"][1] == b"\x00" * 4_000_000
    assert "探测不到时长" in capsys.readouterr().out


def test_audio_compressed_larger_falls_back_to_original(monkeypatch, tmp_path, capsys):
    source = _source(tmp_path, size=4_000_000)
    _patch_local(monkeypatch, source)
    _patch_duration(monkeypatch, 100.0)
    created = _isolate_temp(monkeypatch, tmp_path)
    ffmpeg = _FakeFFmpeg(payload=b"d" * 5_000_000)
    ffmpeg.install(monkeypatch)
    client = _FakeClient(200, {"url": AUDIO_URL})

    result = _run(client)

    assert result == AUDIO_URL
    assert client.calls[0]["files"]["file"][1] == b"\x00" * 4_000_000, "压完更大就用原文件"
    assert all(not os.path.exists(path) for path in created)
    assert "压缩后更大" in capsys.readouterr().out
