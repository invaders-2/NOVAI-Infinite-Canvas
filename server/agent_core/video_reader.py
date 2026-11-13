#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""画布助手「读参考视频」：关键帧网格 + 带时间戳的口播转写。

为什么要它：视频复刻类技能（如内置的 Hypit 视频复刻）第一步就是看懂参考视频——
它的论证 / 节奏 / 每个画面在回应哪句话。之前画布助手只能用 view_image 看视频封面一帧，
既看不到镜头变化也听不到口播，只能瞎猜。这里用本机 ffmpeg：

  - 在 [start, end] 区间均匀抽 N 帧，拼成一张带时间标注的网格图（一张图 = 一轮视觉输入，
    比 N 张单图省 token），同时把每帧单独落盘，返回地址，可直接当 generate_image /
    generate_video 的参考图（复刻构图 / 人物 / 场景）；
  - 抽 16k 单声道音轨，交给已配置的语音转写（设置 → 通用 → 语音转写；没配就借画布助手的
    对话模型；NOVAI_ASR_COMMAND 本地命令优先），要求按句给 [mm:ss] 时间戳。

只读、不改画布。转写会调用一次用户自己配置的转写模型（与语音输入同一条通道）。
所有产物放在调用方给的 out_dir（main.py 放在 OUTPUT_DIR/agent_video_reader/<key>/，
通过 /output/... 静态挂载可访问），同一视频同一区间重复调用直接复用缓存。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import math
import os
import subprocess
from typing import Any, Awaitable, Callable, Dict, List, Optional

FRAMES_DEFAULT = 12
FRAMES_MIN = 4
FRAMES_MAX = 24
GRID_CELL_WIDTH = 320
FRAME_MAX_WIDTH = 1280
ASR_MAX_SECONDS = 900

TRANSCRIPT_PROMPT = (
    "把这段录音里的话逐字转写出来，不要翻译、不要总结、不要润色；说话人说什么语言就写什么语言。"
    "按句子或意群分行，每行开头写这句话开始的时间，格式 [mm:ss]，例如：\n"
    "[00:00] 第一句话\n[00:03] 第二句话\n"
    "有多个说话人时在时间后面加「A：」「B：」区分。中英混说保留英文原词；"
    "人名、品牌名、产品名按常见写法；保留数字。只输出转写行，不要任何解释。"
    "如果没有人说话，只输出：无语音。"
)


class VideoReadError(Exception):
    def __init__(self, message: str, code: str = "video_read_failed"):
        super().__init__(message)
        self.message = str(message)
        self.code = code


def _run(command: List[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout)


def _fps(value: Any) -> Optional[float]:
    text = str(value or "")
    if "/" in text:
        head, _, tail = text.partition("/")
        try:
            den = float(tail)
            return round(float(head) / den, 3) if den else None
        except ValueError:
            return None
    try:
        return round(float(text), 3)
    except ValueError:
        return None


def probe(ffprobe: str, path: str) -> Dict[str, Any]:
    if not ffprobe:
        raise VideoReadError("本机没有找到 ffprobe，无法读取视频（安装 ffmpeg 或设置 FFPROBE_PATH）",
                             code="ffmpeg_missing")
    completed = _run([ffprobe, "-v", "error", "-print_format", "json",
                      "-show_format", "-show_streams", path], timeout=60)
    if completed.returncode != 0:
        raise VideoReadError("读取视频信息失败：%s" % (completed.stderr or "").strip()[:200])
    data = json.loads(completed.stdout or "{}")
    fmt = data.get("format") if isinstance(data.get("format"), dict) else {}
    video: Dict[str, Any] = {}
    has_audio = False
    for stream in data.get("streams") or []:
        if not isinstance(stream, dict):
            continue
        if stream.get("codec_type") == "video" and not video:
            video = {"width": int(stream.get("width") or 0), "height": int(stream.get("height") or 0),
                     "fps": _fps(stream.get("avg_frame_rate") or stream.get("r_frame_rate"))}
        elif stream.get("codec_type") == "audio":
            has_audio = True
    if not video:
        raise VideoReadError("这个文件里没有视频画面轨")
    try:
        duration = float(fmt.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    return {"duration": round(duration, 3), "width": video["width"], "height": video["height"],
            "fps": video["fps"], "has_audio": has_audio}


def stamp_label(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    minutes = int(seconds // 60)
    return "%02d:%04.1f" % (minutes, seconds - minutes * 60)


def plan_stamps(duration: float, start: float, end: float, count: int) -> List[float]:
    """区间内均匀取 count 个时间点（取每段中点，避开黑场开头 / 结尾）。"""
    if duration <= 0:
        return [0.0]
    start = max(0.0, min(float(start or 0), duration))
    end = float(end or 0)
    end = duration if end <= 0 or end > duration else end
    if end - start < 0.2:
        start, end = max(0.0, end - 0.2), max(end, 0.2)
    span = end - start
    return [round(start + span * (index + 0.5) / count, 3) for index in range(count)]


def extract_frames(ffmpeg: str, path: str, out_dir: str, stamps: List[float],
                   max_width: int = FRAME_MAX_WIDTH) -> List[Dict[str, Any]]:
    if not ffmpeg:
        raise VideoReadError("本机没有找到 ffmpeg，无法抽帧（安装 ffmpeg 或设置 FFMPEG_PATH）",
                             code="ffmpeg_missing")
    os.makedirs(out_dir, exist_ok=True)
    frames: List[Dict[str, Any]] = []
    for index, seconds in enumerate(stamps):
        name = "frame_%02d.jpg" % (index + 1)
        target = os.path.join(out_dir, name)
        command = [ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-ss", "%.3f" % seconds, "-i", path,
                   "-frames:v", "1", "-vf", "scale='min(%d,iw)':-2" % max_width, "-q:v", "3", target]
        completed = _run(command, timeout=120)
        if completed.returncode != 0 or not os.path.isfile(target):
            continue
        frames.append({"name": name, "path": target, "seconds": seconds, "label": stamp_label(seconds)})
    return frames


def build_grid(frames: List[Dict[str, Any]], target: str, cell_width: int = GRID_CELL_WIDTH) -> Optional[str]:
    """把帧拼成带时间标注的网格图（4 列）。失败返回 None（不影响单帧结果）。"""
    if not frames:
        return None
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception:
        return None
    images = []
    for frame in frames:
        try:
            with Image.open(frame["path"]) as img:
                img = img.convert("RGB")
                ratio = cell_width / float(img.width or 1)
                images.append(img.resize((cell_width, max(1, int(round(img.height * ratio))))))
        except Exception:
            continue
    if not images:
        return None
    cols = 4 if len(images) >= 4 else len(images)
    rows = int(math.ceil(len(images) / float(cols)))
    cell_h = max(img.height for img in images)
    label_h = 26
    gap = 6
    width = cols * cell_width + (cols + 1) * gap
    height = rows * (cell_h + label_h) + (rows + 1) * gap
    sheet = Image.new("RGB", (width, height), (18, 18, 18))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=18)
    except TypeError:
        font = ImageFont.load_default()
    for index, img in enumerate(images):
        row, col = divmod(index, cols)
        x = gap + col * (cell_width + gap)
        y = gap + row * (cell_h + label_h + gap)
        draw.text((x + 4, y + 3), "#%d  %s" % (index + 1, frames[index]["label"]), fill=(240, 240, 240), font=font)
        sheet.paste(img, (x, y + label_h))
    sheet.save(target, "JPEG", quality=85)
    return target


def detect_cuts(ffmpeg: str, path: str, threshold: float = 0.2) -> List[float]:
    """用 ffmpeg 场景变化检测找硬切点（全片时间，秒；全片扫一遍，调用方按区间过滤）。
    失败返回空表（不影响其它结果）。相隔 0.5 秒内的连续突变（闪白、快速转场）只记第一个。"""
    import re

    command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "info", "-i", path, "-an",
               "-vf", "scale=320:-2,select='gt(scene,%.2f)',showinfo" % threshold, "-f", "null", "-"]
    try:
        completed = _run(command, timeout=300)
    except Exception:
        return []
    cuts: List[float] = []
    for match in re.finditer(r"pts_time:([0-9.]+)", completed.stderr or ""):
        value = round(float(match.group(1)), 2)
        if not cuts or value - cuts[-1] > 0.5:
            cuts.append(value)
    return cuts


def video_cuts(ffmpeg: str, path: str, out_dir: str) -> List[float]:
    """全片切点，按视频缓存在 out_dir/cuts.json。"""
    cache = os.path.join(out_dir, "cuts.json")
    if os.path.isfile(cache):
        try:
            with open(cache, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, list):
                return [float(x) for x in data]
        except Exception:
            pass
    cuts = detect_cuts(ffmpeg, path)
    try:
        os.makedirs(out_dir, exist_ok=True)
        with open(cache, "w", encoding="utf-8") as fh:
            json.dump(cuts, fh)
    except OSError:
        pass
    return cuts


CLIP_MIN_SECONDS = 2.0
CLIP_MAX_SECONDS = 15.0


def extract_clip(ffmpeg: str, path: str, target: str, start: float, end: float) -> str:
    """截出 [start, end] 一段 H.264 mp4（带原声），给 generate_video 当 reference_video。"""
    span = end - start
    if span < CLIP_MIN_SECONDS - 1e-6 or span > CLIP_MAX_SECONDS + 1e-6:
        raise VideoReadError("参考片段要在 %d–%d 秒之间（现在是 %.1f 秒），请调整 start / end"
                             % (CLIP_MIN_SECONDS, CLIP_MAX_SECONDS, span), code="invalid_args")
    if os.path.isfile(target):
        return target
    command = [ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-ss", "%.3f" % start, "-i", path,
               "-t", "%.3f" % span, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
               "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", target]
    completed = _run(command, timeout=300)
    if completed.returncode != 0 or not os.path.isfile(target):
        raise VideoReadError("截取参考片段失败：%s" % (completed.stderr or "").strip()[:200])
    return target


def extract_edge_frames(ffmpeg: str, path: str, out_dir: str) -> Dict[str, str]:
    """整条视频真正的第一帧和最后一帧（原尺寸），按视频缓存。镜头接镜头时：下一个镜头的首帧 = 上一个镜头的尾帧。"""
    os.makedirs(out_dir, exist_ok=True)
    out: Dict[str, str] = {}
    jobs = (("first", ["-ss", "0.03"]), ("last", ["-sseof", "-0.12"]))
    for name, seek in jobs:
        target = os.path.join(out_dir, "%s_frame.jpg" % name)
        if not os.path.isfile(target):
            command = [ffmpeg, "-nostdin", "-loglevel", "error", "-y"] + seek + [
                "-i", path, "-frames:v", "1", "-q:v", "2", target]
            try:
                _run(command, timeout=120)
            except Exception:
                pass
        if os.path.isfile(target):
            out[name] = os.path.basename(target)
    return out


def extract_soundtrack(ffmpeg: str, path: str, target: str, start: float, end: float) -> str:
    """把 [start, end] 的原声导出成 AAC（192k 立体声），给时间线当整段配乐用。"""
    if os.path.isfile(target):
        return target
    command = [ffmpeg, "-nostdin", "-loglevel", "error", "-y"]
    if start > 0:
        command += ["-ss", "%.3f" % start]
    command += ["-i", path]
    if end > start:
        command += ["-t", "%.3f" % (end - start)]
    command += ["-vn", "-c:a", "aac", "-b:a", "192k", "-ac", "2", target]
    completed = _run(command, timeout=300)
    if completed.returncode != 0 or not os.path.isfile(target):
        raise VideoReadError("导出原声失败：%s" % (completed.stderr or "").strip()[:200])
    return target


def extract_audio(ffmpeg: str, path: str, target: str, start: float = 0.0, end: float = 0.0) -> Optional[str]:
    """抽 16k 单声道 mp3。成功返回 None，失败返回原因。"""
    command = [ffmpeg, "-nostdin", "-loglevel", "error", "-y"]
    if start > 0:
        command += ["-ss", "%.3f" % start]
    command += ["-i", path, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k"]
    limit = float(ASR_MAX_SECONDS)
    if end > start:
        limit = min(limit, max(1.0, end - start))
    command += ["-t", "%.3f" % limit, target]
    completed = _run(command, timeout=600)
    if completed.returncode != 0 or not os.path.isfile(target):
        return "抽取音轨失败：%s" % (completed.stderr or "").strip()[:200]
    return None


def _shift_stamps(text: str, offset: float) -> str:
    """区间转写的时间是相对区间开头的：加回 offset，换成全片时间。"""
    if offset <= 0:
        return text
    import re

    def repl(match: "re.Match[str]") -> str:
        total = int(match.group(1)) * 60 + float(match.group(2)) + offset
        minutes = int(total // 60)
        return "[%02d:%02d]" % (minutes, int(round(total - minutes * 60)))

    return re.sub(r"\[(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]", repl, text)


async def read_video(path: str, out_dir: str, url_prefix: str, ffmpeg: str, ffprobe: str,
                     transcribe: Callable[[str, str], Awaitable[Dict[str, Any]]],
                     frames: int = FRAMES_DEFAULT, start: float = 0.0, end: float = 0.0,
                     want_transcript: bool = True, want_clip: bool = False,
                     want_audio: bool = False) -> Dict[str, Any]:
    """读一个本地视频文件。transcribe(audio_path, prompt) -> {ok, text, error}。

    out_dir 下按区间 / 帧数分子目录缓存；url_prefix 是 out_dir 对应的 URL 前缀（不带结尾 /）。
    """
    count = max(FRAMES_MIN, min(FRAMES_MAX, int(frames or FRAMES_DEFAULT)))
    meta = probe(ffprobe, path)
    stamps = plan_stamps(meta["duration"], start, end, count)
    range_start = max(0.0, float(start or 0))
    range_end = float(end or 0)
    if range_end <= 0 or range_end > meta["duration"]:
        range_end = meta["duration"]
    key = "r%d-%d-n%d" % (int(range_start * 10), int(range_end * 10), count)
    frame_dir = os.path.join(out_dir, key)
    cache_path = os.path.join(frame_dir, "frames.json")
    frame_list: List[Dict[str, Any]] = []
    grid_name = ""
    if os.path.isfile(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as fh:
                cached = json.load(fh)
            frame_list = [f for f in cached.get("frames") or []
                          if os.path.isfile(os.path.join(frame_dir, f.get("name") or ""))]
            grid_name = str(cached.get("grid") or "")
        except Exception:
            frame_list = []
    if not frame_list:
        frame_list = extract_frames(ffmpeg, path, frame_dir, stamps)
        if not frame_list:
            raise VideoReadError("没能从视频里抽到画面（文件可能损坏或格式不支持）")
        grid = build_grid(frame_list, os.path.join(frame_dir, "grid.jpg"))
        grid_name = os.path.basename(grid) if grid else ""
        with open(cache_path, "w", encoding="utf-8") as fh:
            json.dump({"frames": [{k: v for k, v in f.items() if k != "path"} for f in frame_list],
                       "grid": grid_name}, fh, ensure_ascii=False)
    cuts = [c for c in video_cuts(ffmpeg, path, out_dir) if range_start <= c <= range_end]
    base = "%s/%s" % (url_prefix.rstrip("/"), key)
    out_frames = [{"index": i + 1, "time": f.get("label") or stamp_label(f.get("seconds") or 0),
                   "seconds": f.get("seconds"), "url": "%s/%s" % (base, f.get("name"))}
                  for i, f in enumerate(frame_list)]
    result: Dict[str, Any] = {
        "duration": meta["duration"], "width": meta["width"], "height": meta["height"], "fps": meta["fps"],
        "aspect": ("%d:%d" % (meta["width"], meta["height"])) if meta["width"] and meta["height"] else "",
        "range": [round(range_start, 2), round(range_end, 2)],
        "frames": out_frames,
        "grid_url": ("%s/%s" % (base, grid_name)) if grid_name else "",
        # 硬切点（场景突变）；溶解 / 粒子转场这类渐变不一定算切点，要结合网格图判断
        "cuts": [{"seconds": c, "time": stamp_label(c)} for c in cuts],
        "cuts_note": ("没检测到硬切：这段可能是一镜到底，靠运镜 / 特效转场推进，复刻时也要保持连续"
                      if not cuts else "硬切点之外的溶解、粒子、变形转场要看网格图判断"),
    }
    edges = extract_edge_frames(ffmpeg, path, out_dir)
    root = url_prefix.rstrip("/")
    if edges.get("first"):
        result["first_frame_url"] = "%s/%s" % (root, edges["first"])
    if edges.get("last"):
        result["last_frame_url"] = "%s/%s" % (root, edges["last"])
    if want_audio:
        if not meta["has_audio"]:
            raise VideoReadError("这个视频没有音轨，导不出原声")
        extract_soundtrack(ffmpeg, path, os.path.join(frame_dir, "soundtrack.m4a"), range_start,
                           range_end if range_end < meta["duration"] else 0)
        result["audio_url"] = "%s/%s" % (base, "soundtrack.m4a")
    if want_clip:
        clip_name = "clip.mp4"
        extract_clip(ffmpeg, path, os.path.join(frame_dir, clip_name), range_start, range_end)
        result["clip_url"] = "%s/%s" % (base, clip_name)
    if not want_transcript:
        result["transcript"] = {"ok": False, "skipped": True, "text": ""}
        return result
    if not meta["has_audio"]:
        result["transcript"] = {"ok": False, "text": "", "error": "这个视频没有音轨（无口播 / 无声音）"}
        return result
    t_key = "t%d-%d" % (int(range_start * 10), int(range_end * 10))
    t_cache = os.path.join(out_dir, t_key + ".json")
    if os.path.isfile(t_cache):
        try:
            with open(t_cache, "r", encoding="utf-8") as fh:
                result["transcript"] = json.load(fh)
            return result
        except Exception:
            pass
    audio_path = os.path.join(out_dir, t_key + ".mp3")
    failure = extract_audio(ffmpeg, path, audio_path, range_start, range_end if range_end < meta["duration"] else 0)
    if failure:
        result["transcript"] = {"ok": False, "text": "", "error": failure}
        return result
    try:
        transcript = await transcribe(audio_path, TRANSCRIPT_PROMPT)
    except Exception as exc:
        transcript = {"ok": False, "text": "", "error": "%s: %s" % (type(exc).__name__, exc)}
    transcript = dict(transcript or {})
    text = str(transcript.get("text") or "").strip()
    if transcript.get("ok") and text:
        transcript["text"] = _shift_stamps(text, range_start)
        try:
            with open(t_cache, "w", encoding="utf-8") as fh:
                json.dump(transcript, fh, ensure_ascii=False)
        except OSError:
            pass
    result["transcript"] = {"ok": bool(transcript.get("ok")), "text": transcript.get("text") or "",
                            "error": str(transcript.get("error") or "")}
    return result
