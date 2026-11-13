from __future__ import annotations

import os
import shutil
from collections import deque
import subprocess
import threading
import time
from typing import Callable

import numpy as np

from . import config

MODEL_FILENAME = "depth_anything_v2_small_int8.onnx"
INFER_SIZE = 518
# Depth Anything V2 官方预处理：ImageNet 归一化，输出是相对深度（越大越近）
_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)

# 深度值按分位数归一化，避免个别噪点把整幅画面压暗
_LOW_PCT = 0.5
_HIGH_PCT = 99.5
# 帧间平滑：整幅深度做指数滑动，抑制逐帧归一化带来的呼吸感
_SMOOTH_ALPHA = 0.16  # 只平滑「归一化尺度」，不动深度图本身，避免动作被拖影
_SMOOTH_CUT_DIFF = 0.22  # 归一化下界跳变超过这个比例就判定为切镜，重置平滑

_SESSION = None
_SESSION_ATTEMPTED = False
_LOAD_REASON = ""
_SESSION_LOCK = threading.Lock()
_INFER_LOCK = threading.Lock()


def _model_path() -> tuple[str | None, str]:
    """模型路径：<data_root>/assets/models 优先，其次安装目录内置的那份。"""
    override = (os.environ.get("NOVAI_DEPTH_MODEL") or "").strip()
    if override:
        if os.path.isfile(override):
            return override, ""
        return None, "深度模型文件不存在（%s）" % override
    primary = config.data_root() / "assets" / "models" / MODEL_FILENAME
    if primary.is_file():
        return str(primary), ""
    fallback = config.repo_root() / "assets" / "models" / MODEL_FILENAME
    if fallback.is_file():
        return str(fallback), ""
    return None, "本地深度模型未下载（找不到 %s）" % primary


def _session() -> tuple[object | None, str]:
    """onnxruntime 会话（懒加载单例）。模型/组件缺失只记原因，不抛异常。"""
    global _SESSION, _SESSION_ATTEMPTED, _LOAD_REASON
    if _SESSION is not None:
        return _SESSION, ""
    with _SESSION_LOCK:
        if _SESSION is not None:
            return _SESSION, ""
        if _SESSION_ATTEMPTED:
            return None, _LOAD_REASON
        path, reason = _model_path()
        if path is None:
            return None, reason
        _SESSION_ATTEMPTED = True
        try:
            import onnxruntime
        except Exception as exc:  # noqa: BLE001 - 缺组件/ABI 不匹配都只降级
            _LOAD_REASON = "缺少推理组件 onnxruntime（%s）" % str(exc)[:120]
            return None, _LOAD_REASON
        try:
            options = onnxruntime.SessionOptions()
            options.intra_op_num_threads = min(8, os.cpu_count() or 4)
            options.inter_op_num_threads = 1
            _SESSION = onnxruntime.InferenceSession(
                path, options, providers=["CPUExecutionProvider"]
            )
        except Exception as exc:  # noqa: BLE001 - 模型损坏也只是降级
            _LOAD_REASON = "深度模型加载失败（%s）" % str(exc)[:120]
            return None, _LOAD_REASON
        _LOAD_REASON = ""
        return _SESSION, ""


def available(ffmpeg: str = "") -> tuple[bool, str]:
    """给前端/接口探测用：模型和推理组件是否就绪。ffmpeg 由调用方传（安装版走内置那份）。"""
    session, reason = _session()
    if session is None:
        return False, reason
    if not (ffmpeg or _ffmpeg()):
        return False, "本机没有找到 ffmpeg，无法处理视频（安装 ffmpeg 或设置 FFMPEG_PATH）"
    return True, ""


def _ffmpeg() -> str:
    override = (os.environ.get("FFMPEG_PATH") or "").strip()
    if override and os.path.isfile(override):
        return override
    return shutil.which("ffmpeg") or ""


def probe(ffmpeg: str, path: str) -> dict:
    """读时长/分辨率/帧率，供上层决定是否放行（时长上限、结果分辨率）。"""
    ffprobe = os.path.join(os.path.dirname(ffmpeg), "ffprobe") if ffmpeg else "ffprobe"
    if not os.path.isfile(ffprobe):
        ffprobe = shutil.which("ffprobe") or ""
    if not ffprobe:
        return {}
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height,r_frame_rate:format=duration",
             "-of", "default=nw=1", path],
            capture_output=True, text=True, timeout=60,
        ).stdout
    except Exception:  # noqa: BLE001
        return {}
    info: dict = {}
    for line in out.splitlines():
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key in ("width", "height"):
            try:
                info[key] = int(value)
            except ValueError:
                pass
        elif key == "duration":
            try:
                info["duration"] = float(value)
            except ValueError:
                pass
        elif key == "r_frame_rate" and "/" in value:
            num, _, den = value.partition("/")
            try:
                fps = float(num) / float(den or 1)
                if fps > 0:
                    info["fps"] = round(fps, 3)
            except (ValueError, ZeroDivisionError):
                pass
    return info


def _infer(session, frame_rgb: np.ndarray) -> np.ndarray:
    tensor = frame_rgb.astype(np.float32) / 255.0
    tensor = (tensor - _MEAN) / _STD
    tensor = tensor.transpose(2, 0, 1)[None]
    with _INFER_LOCK:
        output = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    return np.asarray(output[0], dtype=np.float32)


def _normalize(depth: np.ndarray, low: float | None = None, high: float | None = None) -> np.ndarray:
    if low is None or high is None:
        low = float(np.percentile(depth, _LOW_PCT))
        high = float(np.percentile(depth, _HIGH_PCT))
        if high - low < 1e-6:
            low, high = float(depth.min()), float(depth.max())
    if high - low < 1e-6:
        return np.zeros_like(depth, dtype=np.uint8)
    scaled = np.clip((depth - low) / (high - low), 0.0, 1.0)
    return (scaled * 255.0).astype(np.uint8)


def capture_video(ffmpeg: str, src: str, dst: str, *, max_seconds: float = 30.0,
                  out_size: tuple[int, int] | None = None, keep_audio: bool = True,
                  on_progress: Callable[[int, int], None] | None = None) -> tuple[dict | None, str]:
    """把源视频逐帧转成深度视频（灰度，越近越亮），返回 (结果, 失败原因)。

    失败只返回人能看懂的原因，不抛异常：这是画布上的一个动作，不能把异常冒到接口层。
    """
    session, reason = _session()
    if session is None:
        return None, reason
    if not ffmpeg:
        return None, "本机没有找到 ffmpeg，无法处理视频（安装 ffmpeg 或设置 FFMPEG_PATH）"
    if not os.path.isfile(src):
        return None, "源视频不存在（%s）" % src
    info = probe(ffmpeg, src)
    duration = float(info.get("duration") or 0)
    if duration > max_seconds + 0.05:
        return None, "视频时长 %0.1f 秒超过 %d 秒上限，请先裁剪" % (duration, int(max_seconds))
    fps = float(info.get("fps") or 24)
    width = int(info.get("width") or 0)
    height = int(info.get("height") or 0)
    if not width or not height:
        return None, "读不到源视频分辨率，无法处理"
    if out_size:
        width, height = int(out_size[0]), int(out_size[1])
    # 出片分辨率对齐源片但不超过 1080p，且保持偶数（libx264 要求）
    scale = min(1.0, 1920.0 / max(width, height))
    width = max(2, int(round(width * scale / 2)) * 2)
    height = max(2, int(round(height * scale / 2)) * 2)

    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    decode = [
        ffmpeg, "-nostdin", "-loglevel", "error", "-i", src,
        "-vf", "fps=%0.3f,scale=%d:%d" % (fps, INFER_SIZE, INFER_SIZE),
        "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ]
    encode = [
        ffmpeg, "-nostdin", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "gray", "-s", "%dx%d" % (INFER_SIZE, INFER_SIZE),
        "-r", "%0.3f" % fps, "-i", "-",
    ]
    if keep_audio and _has_audio(ffmpeg, src):
        encode += ["-i", src, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-shortest"]
    encode += ["-vf", "scale=%d:%d" % (width, height), "-c:v", "libx264",
               "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst]

    frame_bytes = INFER_SIZE * INFER_SIZE * 3
    total_estimate = max(1, int(round(duration * fps))) if duration > 0 else 0
    started = time.time()
    count = 0
    previous: tuple[float, float] | None = None
    recent: deque[np.ndarray] = deque()
    proc_in = subprocess.Popen(decode, stdout=subprocess.PIPE, bufsize=frame_bytes * 4)
    proc_out = subprocess.Popen(encode, stdin=subprocess.PIPE, bufsize=frame_bytes * 4)
    try:
        assert proc_in.stdout is not None and proc_out.stdin is not None
        while True:
            buffer = proc_in.stdout.read(frame_bytes)
            if len(buffer) < frame_bytes:
                break
            frame = np.frombuffer(buffer, dtype=np.uint8).reshape(INFER_SIZE, INFER_SIZE, 3)
            raw = _infer(session, frame)
            # 三帧时间中值：单目深度逐帧会有呼吸式抖动，中值滤波压掉又不拖动作
            recent.append(raw)
            if len(recent) > 3:
                recent.popleft()
            depth = np.median(np.stack(list(recent)), axis=0) if len(recent) > 1 else raw
            low = float(np.percentile(depth, _LOW_PCT))
            high = float(np.percentile(depth, _HIGH_PCT))
            if high - low < 1e-6:
                low, high = float(depth.min()), float(depth.max())
            if previous is not None and previous[1] - previous[0] > 1e-6:
                cut = abs(low - previous[0]) / (previous[1] - previous[0]) > _SMOOTH_CUT_DIFF
                if not cut:
                    low = _SMOOTH_ALPHA * previous[0] + (1.0 - _SMOOTH_ALPHA) * low
                    high = _SMOOTH_ALPHA * previous[1] + (1.0 - _SMOOTH_ALPHA) * high
            previous = (low, high)
            proc_out.stdin.write(_normalize(depth, low, high).tobytes())
            count += 1
            if on_progress and (count % 8 == 0):
                on_progress(count, total_estimate)
        proc_out.stdin.close()
        proc_out.wait(timeout=600)
        proc_in.kill()
    except Exception as exc:  # noqa: BLE001
        return None, "深度视频生成失败（%s）" % str(exc)[:160]
    finally:
        for proc in (proc_in, proc_out):
            try:
                if proc.poll() is None:
                    proc.kill()
            except Exception:  # noqa: BLE001
                pass
    if count == 0:
        return None, "没有解出任何画面帧，源视频可能损坏"
    if not os.path.isfile(dst) or os.path.getsize(dst) == 0:
        return None, "深度视频编码失败"
    return {
        "path": dst,
        "frames": count,
        "duration": round(count / fps, 3),
        "width": width,
        "height": height,
        "fps": round(fps, 3),
        "elapsed": round(time.time() - started, 2),
    }, ""


def _has_audio(ffmpeg: str, path: str) -> bool:
    ffprobe = shutil.which("ffprobe") or (os.path.join(os.path.dirname(ffmpeg), "ffprobe") if ffmpeg else "")
    if not ffprobe or not os.path.isfile(ffprobe):
        return False
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
             "-of", "csv=p=0", path], capture_output=True, text=True, timeout=30,
        ).stdout.strip()
    except Exception:  # noqa: BLE001
        return False
    return bool(out)
