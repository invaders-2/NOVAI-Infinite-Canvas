"""参考视频上传临时图床前的可选压缩（mock ffmpeg / 图床，不联网）。

守这些行为：
  * 文件 > 24MB 或长边 > 1280 才压缩；压缩产物交给图床，上传完成（成功或失败）后必删；
  * 长边缩到 1280、H.264、CRF 26、preset veryfast、AAC 128k；无音轨用 -an；
  * 没装 ffmpeg / ffmpeg 失败 / 压缩后反而更大 → 原文件上传；
  * 宽高优先 ffprobe，没 ffprobe 用 opencv；
  * 视频仍走临时图床，不碰 APIMart 上传分支。
"""
import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

PROVIDER = {"id": "apimart", "name": "APIMART", "base_url": "https://apib.ai", "use_proxy": "off"}
CLOUD_URL = "https://a.uguu.se/compressed.mp4"
REF = "/output/ref.mp4"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in ("APIMART_TRY_VIDEO_UPLOAD", "PUBLIC_BASE_URL", "PUBLIC_MEDIA_BASE_URL",
                "CLOUD_MEDIA_UPLOAD_SERVICE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(main, "VIDEO_CLOUD_COMPRESS_THRESHOLD_BYTES", 1024)
    monkeypatch.setattr(main, "VIDEO_CLOUD_COMPRESS_MAX_EDGE", 1280)


def _source(tmp_path, size=4096):
    path = tmp_path / "ref.mp4"
    path.write_bytes(b"\x00" * size)
    return str(path)


def _patch_local(monkeypatch, source):
    monkeypatch.setattr(main, "output_file_from_url", lambda url: source)
    monkeypatch.setattr(main, "local_media_path_for_cloud_upload", lambda url, allowed=("image/", "video/", "audio/"): source)


def _patch_probe(monkeypatch, width=1920, height=1080, duration=10.0, has_audio=True):
    monkeypatch.setattr(main, "probe_video_dimensions", lambda path: (width, height))
    monkeypatch.setattr(main, "probe_video_file_duration_seconds", lambda path: duration)
    monkeypatch.setattr(main, "video_has_audio_stream", lambda ffprobe, path: has_audio)


def _stub_upload(monkeypatch, calls, error=None):
    async def fake(ref_url, service="auto", path_override=""):
        calls.append({
            "ref": ref_url,
            "service": service,
            "path_override": path_override,
            "exists": bool(path_override) and os.path.isfile(path_override),
            "size": os.path.getsize(path_override) if path_override and os.path.isfile(path_override) else 0,
            "bytes": Path(path_override).read_bytes() if path_override and os.path.isfile(path_override) else b"",
        })
        if error is not None:
            raise error
        return {"url": CLOUD_URL, "service": "uguu", "source": ref_url}

    monkeypatch.setattr(main, "upload_local_video_to_cloud", fake)
    return calls


class _FakeFFmpeg:
    def __init__(self, payload=b"compressed", returncode=0, stderr="", ffmpeg="/usr/bin/ffmpeg",
                 ffprobe="/usr/bin/ffprobe"):
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
        out_path = cmd[-1]
        if self.returncode == 0:
            with open(out_path, "wb") as fh:
                fh.write(self.payload)
        return SimpleNamespace(returncode=self.returncode, stdout="", stderr=self.stderr)

    def install(self, monkeypatch):
        monkeypatch.setattr(main.shutil, "which", self.which)
        monkeypatch.setattr(main.subprocess, "run", self.run)


def _run_upload():
    return asyncio.run(main.upload_video_for_apimart(None, PROVIDER, REF))


def test_large_video_compresses_and_uploads_temp_product(monkeypatch, tmp_path, capsys):
    source = _source(tmp_path)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg(payload=b"x" * 512)
    ffmpeg.install(monkeypatch)

    result = _run_upload()

    assert result == CLOUD_URL
    assert len(uploads) == 1
    assert uploads[0]["ref"] == REF, "图床 source 仍记原始 ref"
    temp_path = uploads[0]["path_override"]
    assert temp_path and uploads[0]["exists"], "上传时必须还是压缩临时文件"
    assert uploads[0]["size"] == 512 and uploads[0]["bytes"] == b"x" * 512
    assert not os.path.exists(temp_path), "上传完成后必须删除压缩临时文件"
    cmd = ffmpeg.commands[0]
    assert "-crf" in cmd and cmd[cmd.index("-crf") + 1] == "26"
    assert cmd[cmd.index("-preset") + 1] == "veryfast"
    assert cmd[cmd.index("-vf") + 1] == "scale='min(1280,iw)':-2"
    assert "libx264" in cmd and "aac" in cmd and cmd[cmd.index("-b:a") + 1] == "128k"
    out = capsys.readouterr().out
    assert "原 4096 字节 1920x1080 10.0s" in out, out
    assert "压缩后 512 字节" in out, out
    assert "已上传临时图床（uguu）" in out, out


def test_compression_failure_falls_back_to_original(monkeypatch, tmp_path, capsys):
    source = _source(tmp_path)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg(returncode=1, stderr="encoder exploded")
    ffmpeg.install(monkeypatch)

    result = _run_upload()

    assert result == CLOUD_URL
    assert uploads[0]["path_override"] == "", "压缩失败必须回退原文件"
    failed_output = ffmpeg.commands[0][-1]
    assert not os.path.exists(failed_output), "失败产物不能留在系统临时目录"
    out = capsys.readouterr().out
    assert "压缩失败，回退原文件" in out and "encoder exploded" in out, out


def test_no_ffmpeg_uploads_original(monkeypatch, tmp_path, capsys):
    source = _source(tmp_path)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg(ffmpeg=None)
    ffmpeg.install(monkeypatch)

    result = _run_upload()

    assert result == CLOUD_URL
    assert uploads[0]["path_override"] == ""
    assert ffmpeg.run_calls == 0, "没有 ffmpeg 时不能调用子进程"
    assert "未找到 ffmpeg，跳过压缩" in capsys.readouterr().out


def test_small_video_is_not_compressed(monkeypatch, tmp_path):
    source = _source(tmp_path, size=100)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch, width=640, height=360, duration=2.0)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg()
    ffmpeg.install(monkeypatch)

    result = _run_upload()

    assert result == CLOUD_URL
    assert uploads[0]["path_override"] == ""
    assert ffmpeg.run_calls == 0, "小视频不应触发 ffmpeg"


def test_big_file_with_small_resolution_still_compresses(monkeypatch, tmp_path):
    source = _source(tmp_path, size=4096)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch, width=640, height=360, duration=3.0)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg(payload=b"x" * 512)
    ffmpeg.install(monkeypatch)

    _run_upload()

    assert uploads[0]["path_override"], "只看体积，超过阈值也要压"
    assert os.path.getsize(source) == 4096, "原文件不能被改写"


def test_large_resolution_with_small_file_still_compresses(monkeypatch, tmp_path):
    source = _source(tmp_path, size=100)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch, width=1920, height=1080, duration=1.0)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg(payload=b"x" * 50)
    ffmpeg.install(monkeypatch)

    _run_upload()

    assert uploads[0]["path_override"], "只看长边，超过 1280 也要压"
    assert uploads[0]["size"] == 50


def test_portrait_video_scale_filter_uses_height(monkeypatch, tmp_path):
    source = _source(tmp_path, size=4096)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch, width=1080, height=1920, duration=5.0)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg(payload=b"x" * 512)
    ffmpeg.install(monkeypatch)

    _run_upload()

    assert ffmpeg.commands[0][ffmpeg.commands[0].index("-vf") + 1] == "scale=-2:'min(1280,ih)'"


def test_temp_file_creation_failure_falls_back_to_original(monkeypatch, tmp_path, capsys):
    source = _source(tmp_path)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg()
    ffmpeg.install(monkeypatch)

    def _disk_full(prefix="", suffix=""):
        raise OSError("No space left on device")

    monkeypatch.setattr(main.tempfile, "mkstemp", _disk_full)

    result = _run_upload()

    assert result == CLOUD_URL
    assert uploads[0]["path_override"] == "", "建不了临时文件也要原文件上传"
    assert ffmpeg.run_calls == 0
    assert "创建临时文件失败" in capsys.readouterr().out


def test_oversize_original_skips_compression_and_keeps_size_error(monkeypatch, tmp_path):
    source = _source(tmp_path)
    monkeypatch.setattr(main, "output_file_from_url", lambda url: source)

    def _too_large(url, allowed=("image/", "video/", "audio/")):
        raise main.HTTPException(status_code=400, detail="媒体文件超过云端上传大小限制：4294967296 bytes")

    monkeypatch.setattr(main, "local_media_path_for_cloud_upload", _too_large)
    ffmpeg = _FakeFFmpeg()
    ffmpeg.install(monkeypatch)

    result = _run_upload()

    assert result.startswith("ERR:APIMart 上传入口不可用"), result
    assert "超过云端上传大小限制" in result
    assert ffmpeg.run_calls == 0, "超过图床上限的文件不应先烧 CPU 压缩"


def test_compressed_output_larger_falls_back_to_original(monkeypatch, tmp_path, capsys):
    source = _source(tmp_path, size=4096)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg(payload=b"y" * 4096)
    ffmpeg.install(monkeypatch)

    result = _run_upload()

    assert result == CLOUD_URL
    assert uploads[0]["path_override"] == "", "压完不比原文件小就用原文件"
    assert not os.path.exists(ffmpeg.commands[0][-1])
    assert "压缩后更大" in capsys.readouterr().out


def test_temp_file_removed_even_when_upload_fails(monkeypatch, tmp_path):
    source = _source(tmp_path)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch)
    uploads = []
    _stub_upload(monkeypatch, uploads, error=main.HTTPException(status_code=502, detail="all channels down"))
    ffmpeg = _FakeFFmpeg(payload=b"x" * 512)
    ffmpeg.install(monkeypatch)

    result = _run_upload()

    assert result.startswith("ERR:APIMart 上传入口不可用"), result
    assert "all channels down" in result
    assert uploads[0]["path_override"]
    assert not os.path.exists(uploads[0]["path_override"]), "上传失败也要删临时文件"


def test_video_without_audio_uses_an(monkeypatch, tmp_path):
    source = _source(tmp_path)
    _patch_local(monkeypatch, source)
    _patch_probe(monkeypatch, has_audio=False)
    uploads = []
    _stub_upload(monkeypatch, uploads)
    ffmpeg = _FakeFFmpeg(payload=b"x" * 512)
    ffmpeg.install(monkeypatch)

    _run_upload()

    cmd = ffmpeg.commands[0]
    assert "-an" in cmd
    assert "-c:a" not in cmd and "aac" not in cmd


def test_probe_dimensions_prefers_ffprobe(monkeypatch):
    class _Proc:
        returncode = 0
        stdout = "1920x1080\n"
        stderr = ""

    monkeypatch.setattr(main.shutil, "which", lambda name: "/usr/bin/ffprobe")
    calls = []
    monkeypatch.setattr(main.subprocess, "run", lambda cmd, **kwargs: calls.append(cmd) or _Proc())

    assert main.probe_video_dimensions("/x.mp4") == (1920, 1080)
    assert "-show_entries" in calls[0]


def test_probe_dimensions_falls_back_to_opencv(monkeypatch):
    class _Cap:
        def __init__(self):
            self.released = False

        def isOpened(self):
            return True

        def get(self, prop):
            return 1280 if prop == 3 else 720

        def release(self):
            self.released = True

    cap = _Cap()
    fake_cv2 = SimpleNamespace(
        CAP_PROP_FRAME_WIDTH=3,
        CAP_PROP_FRAME_HEIGHT=4,
        VideoCapture=lambda path: cap,
    )
    monkeypatch.setattr(main.shutil, "which", lambda name: None)
    monkeypatch.setitem(sys.modules, "cv2", fake_cv2)

    assert main.probe_video_dimensions("/x.mp4") == (1280, 720)
    assert cap.released is True
