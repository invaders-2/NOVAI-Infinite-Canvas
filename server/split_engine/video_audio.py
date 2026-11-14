"""把一条音轨贴到另一个视频上：纯 ffmpeg 后期，不调用模型、不花额度。

复刻场景里生成出来的片子是无声音的（模型侧本来就不复刻声音），这里把参考视频的
BGM / 旁白按需贴回去：音乐整段裁到成片长度，或按镜头区间截取那一段再贴。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time

MAX_SECONDS = 300.0


def available(ffmpeg: str = "") -> tuple[bool, str]:
    if not ffmpeg or not os.path.isfile(ffmpeg):
        return False, "没有找到 ffmpeg，本机音频处理不可用"
    return True, ""


def _ffprobe(ffmpeg: str) -> str:
    probe = os.path.join(os.path.dirname(ffmpeg), "ffprobe") if ffmpeg else "ffprobe"
    if not os.path.isfile(probe):
        probe = shutil.which("ffprobe") or ""
    return probe


def _duration(ffmpeg: str, path: str, stream: str = "v:0") -> float:
    probe = _ffprobe(ffmpeg)
    if not probe or not os.path.isfile(path):
        return 0.0
    try:
        done = subprocess.run(
            [probe, "-v", "error", "-select_streams", stream, "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=30)
        return float((done.stdout or "").strip() or 0) or 0.0
    except Exception:  # noqa: BLE001 - 读不到当 0 处理，下面会兜底
        return 0.0


def has_audio(ffmpeg: str, path: str) -> bool:
    """这个文件里有没有音轨：没有就没什么可贴的，别白跑一遍 ffmpeg。"""
    probe = _ffprobe(ffmpeg)
    if not probe or not os.path.isfile(path):
        return False
    try:
        done = subprocess.run(
            [probe, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
             "-of", "csv=p=0", path], capture_output=True, text=True, timeout=30)
        return bool((done.stdout or "").strip())
    except Exception:  # noqa: BLE001
        return False


def mux(ffmpeg: str, video_path: str, audio_path: str, dst: str, *,
        start: float | None = None, duration: float | None = None) -> tuple[dict | None, str]:
    """把 audio_path 的音轨贴到 video_path 上，画质不重编码（-c:v copy）。

    start/duration：只取原声里这一段（复刻按镜头切段时用）。成片长度以视频为准：
    音轨短了补静音，长了裁掉。
    """
    ready, reason = available(ffmpeg)
    if not ready:
        return None, reason
    if not os.path.isfile(video_path):
        return None, "成片文件不存在"
    if not os.path.isfile(audio_path):
        return None, "参考视频不存在（原声来源读不到）"
    video_seconds = _duration(ffmpeg, video_path)
    if not video_seconds:
        return None, "读不出成片时长"
    if video_seconds > MAX_SECONDS:
        return None, "成片 %.0f 秒，超过本机音频处理上限 %d 秒，先裁短" % (video_seconds, int(MAX_SECONDS))
    started = time.time()
    args = ["-hide_banner", "-loglevel", "error", "-y", "-i", video_path]
    if duration is not None and float(duration) > 0:
        # 音轨只取 start..start+duration 这一段，其余裁掉
        args += ["-ss", "%.3f" % float(start or 0), "-t", "%.3f" % float(duration), "-i", audio_path]
    else:
        args += ["-i", audio_path]
    args += [
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        # 音轨短了补静音、长了按成片长度裁：成片必须和画面完全对齐
        "-af", "apad", "-t", "%.3f" % video_seconds,
        "-movflags", "+faststart", dst,
    ]
    try:
        done = subprocess.run([ffmpeg, *args], capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        return None, "音频合流超时"
    except Exception as exc:  # noqa: BLE001
        return None, "音频合流启动失败：%s" % exc
    if done.returncode != 0:
        tail = " / ".join((done.stderr or "").strip().splitlines()[-3:])
        return None, "ffmpeg 失败：" + tail
    return {
        "duration": round(_duration(ffmpeg, dst) or video_seconds, 3),
        "videoDuration": round(video_seconds, 3),
        "audioStart": float(start or 0),
        "elapsed": round(time.time() - started, 1),
    }, ""
