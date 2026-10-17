#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""能力运行的视频输入解析：视频文件走本机 ffprobe/ffmpeg，视频链接走页面抓取。

为什么这样选（实测结论，见汇报）：
- 本机没有本地语音转写：ffmpeg 未编译 whisper 滤镜，也没有 whisper / faster-whisper。
  云转写走 NOVAI 已配置的对话平台（优先级：环境变量 NOVAI_ASR_PROVIDER / NOVAI_ASR_MODEL，
  其次用户在「设置 → 通用 → 视频口播转写」写入 data/settings.json 的 asr，最后
  config/capability_inputs.json 的 video.asr）：ffmpeg 抽 16k 单声道音轨后按 OpenAI
  input_audio 形状请求，实测 gemini-3-flash-preview 能逐字转写中文口播。
  本地命令入口 NOVAI_ASR_COMMAND 优先；都没配就如实报不可用，绝不用画面编造口播。
- 视频文件（上传）能真实拿到：时长/分辨率/帧率/编码/音轨 + N 张关键帧图片，
  关键帧落盘后模型可用 read 工具查看，这是可用于分镜/节奏分析的真实素材。
- 视频链接（抖音等）用 httpx 尽力抓页面里公开的标题/描述；抓不到就如实记失败，
  并提示模型用 browser 再抓，绝不用标题编造口播文案。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
from typing import Any, Dict, List, Optional

from server.agents import store
from server.integrations import input_sources

VIDEO_EXTS = (".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm")
_VIDEO_LINK_KEYS = ("videoLink", "video_link", "videoUrl", "video_url", "videoURI",
                    "douyinUrl", "douyin_url", "douyin", "shareLink", "share_link",
                    "videoShareText", "video_share_text")
_VIDEO_FILE_KEYS = ("videoFile", "video_file", "videoPath", "video_path")
_FRAME_COUNT_DEFAULT = 8


def _frame_count() -> int:
    raw = os.environ.get("NOVAI_VIDEO_FRAME_COUNT")
    try:
        value = int(str(raw or "").strip() or _FRAME_COUNT_DEFAULT)
    except (TypeError, ValueError):
        value = _FRAME_COUNT_DEFAULT
    return max(1, min(value, 24))


def _iter_texts(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            for text in _iter_texts(item):
                yield text
    elif isinstance(value, dict):
        for item in value.values():
            for text in _iter_texts(item):
                yield text


def extract_video_refs(params: Dict[str, Any]) -> Dict[str, List[Dict[str, str]]]:
    """返回 {"links": [{url, raw}], "files": [str]}；files 是用户写的视频文件名/路径。"""
    data = params if isinstance(params, dict) else {}
    links: List[Dict[str, str]] = []
    files: List[str] = []

    def add_links(value: Any) -> None:
        for text in _iter_texts(value):
            raw = str(text or "").strip()
            for match in re.findall(r"https?://[^\s，。；、）)]+", raw):
                if not any(item["url"] == match for item in links):
                    links.append({"url": match, "raw": raw})

    def add_files(value: Any) -> None:
        for text in _iter_texts(value):
            for token in re.split(r"[\s,，;；]+", str(text or "")):
                name = token.strip().strip('"').strip("'")
                if name and os.path.splitext(name)[1].lower() in VIDEO_EXTS and name not in files:
                    files.append(name)

    for key in _VIDEO_LINK_KEYS:
        if key in data:
            add_links(data.get(key))
    for key in _VIDEO_FILE_KEYS:
        if key in data:
            add_files(data.get(key))
    return {"links": links, "files": files}


def has_video_refs(params: Dict[str, Any]) -> bool:
    refs = extract_video_refs(params)
    return bool(refs["links"] or refs["files"])


def _fps(value: Any) -> Optional[float]:
    text = str(value or "").strip()
    if "/" in text:
        head, _, tail = text.partition("/")
        try:
            denom = float(tail)
            return round(float(head) / denom, 3) if denom else None
        except ValueError:
            return None
    try:
        return round(float(text), 3)
    except ValueError:
        return None


def _to_float(value: Any) -> Optional[float]:
    try:
        return round(float(str(value).strip()), 3)
    except (TypeError, ValueError):
        return None


def probe_video(path: str, timeout: float = 60.0) -> Dict[str, Any]:
    command = ["ffprobe", "-v", "error", "-print_format", "json",
               "-show_format", "-show_streams", path]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if completed.returncode != 0:
        raise RuntimeError("ffprobe 退出码 %s：%s"
                           % (completed.returncode, (completed.stderr or "").strip()[:300]))
    data = json.loads(completed.stdout or "{}")
    fmt = data.get("format") if isinstance(data.get("format"), dict) else {}
    video = {}
    audio = {}
    for stream in data.get("streams") or []:
        if not isinstance(stream, dict):
            continue
        if stream.get("codec_type") == "video" and not video:
            video = {
                "codec": str(stream.get("codec_name") or ""),
                "width": int(stream.get("width") or 0),
                "height": int(stream.get("height") or 0),
                "fps": _fps(stream.get("avg_frame_rate") or stream.get("r_frame_rate")),
                "pix_fmt": str(stream.get("pix_fmt") or ""),
            }
        elif stream.get("codec_type") == "audio" and not audio:
            audio = {
                "codec": str(stream.get("codec_name") or ""),
                "sample_rate": str(stream.get("sample_rate") or ""),
                "channels": int(stream.get("channels") or 0),
            }
    return {
        "format": str(fmt.get("format_name") or ""),
        "duration": _to_float(fmt.get("duration")),
        "size": int(fmt.get("size") or os.path.getsize(path)),
        "bit_rate": int(fmt.get("bit_rate") or 0),
        "video": video,
        "audio": audio,
    }


def extract_keyframes(path: str, out_dir: str, duration: Optional[float],
                      count: int = 8, max_width: int = 720) -> List[Dict[str, Any]]:
    os.makedirs(out_dir, exist_ok=True)
    stamps: List[float] = []
    if duration and duration > 0:
        for index in range(count):
            stamps.append(round(duration * (index + 0.5) / count, 3))
    else:
        stamps = [0.0]
    frames: List[Dict[str, Any]] = []
    for index, seconds in enumerate(stamps):
        target = os.path.join(out_dir, "frame_%02d.jpg" % (index + 1))
        command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
                   "-ss", "%.3f" % seconds, "-i", path,
                   "-frames:v", "1", "-vf", "scale=%d:-2" % max_width, "-q:v", "3", target]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=120)
        if completed.returncode != 0 or not os.path.isfile(target):
            continue
        frames.append({"path": target, "seconds": seconds,
                       "bytes": os.path.getsize(target)})
    return frames


def _extract_link_text(raw: bytes, content_type: str) -> Dict[str, Any]:
    text = input_sources._decode_text(raw)
    html = input_sources.html_to_text(text, max_chars=6000)
    titles = re.findall(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
    title = re.sub(r"\s+", " ", titles[0]).strip() if titles else ""
    metas = re.findall(
        r"<meta[^>]+(?:property|name)=[\"'](?:og:description|description|og:title)[\"'][^>]*>",
        text, re.I)
    descriptions: List[str] = []
    for tag in metas:
        content = re.search(r"content=[\"'](.*?)[\"']", tag, re.S | re.I)
        if content:
            value = input_sources.html_to_text(content.group(1), max_chars=1500).strip()
            if value and value not in descriptions:
                descriptions.append(value)
    for match in re.finditer(r'"desc"\s*:\s*"((?:[^"\\]|\\.){6,})"', text):
        try:
            value = json.loads('"%s"' % match.group(1)).strip()
        except Exception:
            value = match.group(1).strip()
        if value and value not in descriptions:
            descriptions.append(value)
        if len(descriptions) >= 6:
            break
    return {"title": title, "descriptions": descriptions[:6], "page_text": html,
            "content_type": content_type}


_ASR_CONFIG_FILE = os.path.join(input_sources._project_root(), "config", "capability_inputs.json")
_ASR_PROMPT = ("把这段音频里的话逐字转写成中文（保留数字与专有名词）。只输出转写文本；"
               "如果没有语音，只输出：无语音。")


def _config_asr_settings() -> Dict[str, str]:
    """config/capability_inputs.json 的 video.asr（仓库自带的兜底层）；读不到按空处理。"""
    provider = ""
    model = ""
    try:
        with open(_ASR_CONFIG_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        video = data.get("video") if isinstance(data, dict) else None
        asr = video.get("asr") if isinstance(video, dict) else None
        if isinstance(asr, dict):
            provider = str(asr.get("provider") or "").strip()
            model = str(asr.get("model") or "").strip()
    except Exception:
        pass
    return {"provider": provider, "model": model}


def _user_asr_settings() -> Dict[str, str]:
    """用户层：data/settings.json 的 asr（「设置 → 通用 → 视频口播转写」写入）。

    settings.json 缺失/损坏一律按空处理，绝不抛错影响转写入口。
    """
    provider = ""
    model = ""
    try:
        path = os.path.join(store.data_dir(), "settings.json")
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        asr = data.get("asr") if isinstance(data, dict) else None
        if isinstance(asr, dict):
            provider = str(asr.get("provider") or "").strip()
            model = str(asr.get("model") or "").strip()
    except Exception:
        pass
    return {"provider": provider, "model": model}


def asr_settings_detail() -> Dict[str, str]:
    """当前生效的语音转写平台/模型 + 来源层级：环境变量 > settings.json 的 asr > 配置文件。

    provider/model 逐字段按优先级取第一个非空值；source 表示当前生效值来自哪一层。
    """
    env_provider = (os.environ.get("NOVAI_ASR_PROVIDER") or "").strip()
    env_model = (os.environ.get("NOVAI_ASR_MODEL") or "").strip()
    user = _user_asr_settings()
    config = _config_asr_settings()
    provider = env_provider or user["provider"] or config["provider"]
    model = env_model or user["model"] or config["model"]
    if env_provider or env_model:
        source = "env"
    elif user["provider"] or user["model"]:
        source = "user"
    elif config["provider"] or config["model"]:
        source = "config"
    else:
        source = "none"
    return {"provider": provider, "model": model, "source": source}


def asr_settings() -> Dict[str, str]:
    """语音转写平台（返回结构保持 {"provider","model"}，不破坏既有调用方）。

    不把模型名写死在代码里：默认值来自用户的设置或配置文件，代码只读配置。
    """
    detail = asr_settings_detail()
    return {"provider": detail["provider"], "model": detail["model"]}


def _response_text(data: Any) -> str:
    choices = data.get("choices") if isinstance(data, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message") if isinstance(choices[0].get("message"), dict) else {}
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        chunks = [str(b.get("text") or "") for b in content if isinstance(b, dict)]
        return "\n".join([c for c in chunks if c]).strip()
    return ""


def _extract_audio(path: str, target: str) -> Optional[str]:
    os.makedirs(os.path.dirname(target), exist_ok=True)
    seconds = int(float(os.environ.get("NOVAI_ASR_MAX_SECONDS") or 900))
    command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", path,
               "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-t", str(seconds), target]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=600)
    if completed.returncode != 0 or not os.path.isfile(target):
        return "抽取音轨失败：%s" % (completed.stderr or "").strip()[:200]
    return None


async def _provider_transcript(audio_path: str, provider: str, model: str) -> Dict[str, Any]:
    from server.routes.deps import deps

    resolver = deps.get("resolve_chat_provider")
    if resolver is None:
        return {"ok": False, "text": "", "error": "deps.resolve_chat_provider 未注册，无法解析 ASR 平台"}
    try:
        base, headers, resolved_model = resolver(provider, model, "")
    except Exception as exc:
        return {"ok": False, "text": "", "error": "解析 ASR 平台失败：%s: %s"
                % (type(exc).__name__, exc)}
    with open(audio_path, "rb") as handle:
        encoded = base64.b64encode(handle.read()).decode()
    fmt = os.path.splitext(audio_path)[1].lstrip(".").lower() or "mp3"
    payload = {
        "model": resolved_model,
        "stream": False,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": _ASR_PROMPT},
            {"type": "input_audio", "input_audio": {"data": encoded, "format": fmt}},
        ]}],
    }
    import httpx

    timeout = float(os.environ.get("NOVAI_ASR_TIMEOUT") or 300.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(base.rstrip("/") + "/chat/completions",
                                         headers=headers, json=payload)
    except Exception as exc:
        return {"ok": False, "text": "", "error": "ASR 请求失败：%s: %s" % (type(exc).__name__, exc)}
    if response.status_code >= 400:
        return {"ok": False, "text": "", "error": "ASR 平台返回 %s：%s"
                % (response.status_code, (response.text or "")[:300])}
    try:
        text = _response_text(response.json())
    except Exception as exc:
        return {"ok": False, "text": "", "error": "ASR 响应解析失败：%s" % exc}
    if not text:
        return {"ok": False, "text": "", "error": "ASR 平台返回了空转写"}
    return {"ok": True, "text": text, "error": "", "provider": provider, "model": resolved_model}


async def transcribe_video_audio(path: str, out_dir: str) -> Dict[str, Any]:
    """先抽音轨，再按 NOVAI_ASR_COMMAND（本地命令）或配置的平台（云转写）执行。"""
    target = os.path.join(out_dir, "audio_16k.mp3")
    failure = _extract_audio(path, target)
    if failure:
        return {"ok": False, "text": "", "error": failure}
    command = (os.environ.get("NOVAI_ASR_COMMAND") or "").strip()
    if command:
        run = command.replace("{audio}", target)
        try:
            completed = subprocess.run(run, shell=True, capture_output=True, text=True, timeout=1800)
        except Exception as exc:
            return {"ok": False, "text": "", "error": "转写命令异常：%s: %s" % (type(exc).__name__, exc)}
        if completed.returncode != 0:
            return {"ok": False, "text": "", "error": "转写命令失败：%s"
                    % (completed.stderr or "").strip()[:200]}
        return {"ok": True, "text": (completed.stdout or "").strip(), "error": "",
                "provider": "local-command", "model": ""}
    settings = asr_settings()
    if not (settings["provider"] and settings["model"]):
        return {"ok": False, "text": "", "error": "未配置语音转写：本机无 whisper，"
                                                 "「设置 → 通用 → 视频口播转写」未启用，"
                                                 "config/capability_inputs.json 的 video.asr 为空，"
                                                 "且未设置 NOVAI_ASR_PROVIDER / NOVAI_ASR_MODEL"}
    return await _provider_transcript(target, settings["provider"], settings["model"])


async def prepare_video_sources(run_id: str, files: Optional[List[Dict[str, Any]]],
                                params: Dict[str, Any], output_dir: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {"files": [], "links": [], "errors": [], "notes": []}
    uploads_dir = store.run_uploads_dir(run_id) if run_id else ""
    refs = extract_video_refs(params)
    candidates: List[str] = []
    for item in files or []:
        name = str(item.get("name") or "")
        if os.path.splitext(name)[1].lower() not in VIDEO_EXTS:
            continue
        path = os.path.join(uploads_dir, name) if uploads_dir else ""
        if path and os.path.isfile(path):
            candidates.append(path)
    for name in refs["files"]:
        path = os.path.join(uploads_dir, os.path.basename(name)) if uploads_dir else ""
        if path and os.path.isfile(path) and path not in candidates:
            candidates.append(path)

    for index, path in enumerate(candidates[:2]):
        entry: Dict[str, Any] = {"name": os.path.basename(path), "path": path,
                                 "size": os.path.getsize(path), "meta": {}, "frames": [],
                                 "error": "", "transcript": None}
        try:
            entry["meta"] = probe_video(path)
        except Exception as exc:
            entry["error"] = "ffprobe 失败：%s: %s" % (type(exc).__name__, exc)
            result["errors"].append("%s 元数据读取失败：%s" % (entry["name"], entry["error"]))
        if not entry["error"]:
            frame_dir = os.path.join(output_dir, "video_frames", "v%d" % (index + 1))
            try:
                entry["frames"] = extract_keyframes(path, frame_dir,
                                                    entry["meta"].get("duration"),
                                                    count=_frame_count())
            except Exception as exc:
                result["errors"].append("%s 关键帧提取失败：%s: %s"
                                        % (entry["name"], type(exc).__name__, exc))
            if not entry["frames"]:
                result["errors"].append("%s 没有提取到关键帧（视频可能受损或时长异常）" % entry["name"])
            entry["transcript"] = await transcribe_video_audio(
                path, os.path.join(output_dir, "video_audio"))
        result["files"].append(entry)

    for link in refs["links"][:2]:
        entry = {"url": link.get("url") or "", "raw": link.get("raw") or "", "title": "",
                 "descriptions": [], "page_text": "", "error": ""}
        try:
            raw, ctype, _final = await input_sources.fetch_external(
                entry["url"], max_bytes=4 * 1024 * 1024, timeout=25.0)
            entry.update(_extract_link_text(raw, ctype))
        except Exception as exc:
            entry["error"] = "%s: %s" % (type(exc).__name__, exc)
            result["errors"].append("视频链接抓取失败（%s）：%s" % (entry["url"], entry["error"]))
        result["links"].append(entry)
    return result


def render_video_block(video: Optional[Dict[str, Any]],
                       media: Optional[Dict[str, Any]] = None) -> str:
    data = video if isinstance(video, dict) else {}
    if not (data.get("files") or data.get("links")):
        return ""
    lines = ["## 已解析的视频输入（真实提取，不是猜测）"]
    for entry in data.get("files") or []:
        meta = entry.get("meta") or {}
        video_meta = meta.get("video") or {}
        audio_meta = meta.get("audio") or {}
        lines.append("【视频文件】%s（绝对路径 %s，%s 字节）"
                     % (entry.get("name"), entry.get("path"), entry.get("size")))
        if meta:
            lines.append("元数据：时长 %s 秒｜分辨率 %sx%s｜帧率 %s fps｜编码 %s｜格式 %s｜码率 %s bps｜音轨 %s"
                         % (meta.get("duration"), video_meta.get("width"), video_meta.get("height"),
                            video_meta.get("fps"), video_meta.get("codec"), meta.get("format"),
                            meta.get("bit_rate"),
                            ("有（%s / %s Hz / %s 声道）" % (audio_meta.get("codec"),
                                                          audio_meta.get("sample_rate"),
                                                          audio_meta.get("channels")))
                            if audio_meta else "无"))
        else:
            lines.append("元数据：读取失败（%s）" % (entry.get("error") or "未知原因"))
        frames = entry.get("frames") or []
        if frames:
            mapped = (media or {}).get("mapped") or {}
            shown = [mapped.get(str(frame.get("path")), str(frame.get("path"))) for frame in frames]
            bridged = any(shown[i] != str(frames[i].get("path")) for i in range(len(frames)))
            if bridged:
                lines.append("关键帧（NOVAI 用 ffmpeg 抽出，共 %d 张，已复制到 OpenClaw 允许目录，"
                             "用 read 工具查看；不要用 image 工具：它依赖 OpenClaw 图像描述模型，"
                             "本机未配置可用的 provider/key，每次调用会超时 60 秒）：" % len(frames))
            else:
                lines.append("关键帧（NOVAI 用 ffmpeg 抽出，共 %d 张，用 read 工具查看图片）：" % len(frames))
            for index, frame in enumerate(frames):
                lines.append("- %s（第 %s 秒，%s 字节）"
                             % (shown[index], frame.get("seconds"), frame.get("bytes")))
            lines.append("路径以本块列出的绝对路径为准，禁止编造路径。")
        transcript = entry.get("transcript") or {}
        if transcript.get("ok") and transcript.get("text"):
            lines.append("音频口播转写（ASR：%s/%s）："
                         % (transcript.get("provider") or "未知", transcript.get("model") or ""))
            lines.append(transcript.get("text")[:8000])
        else:
            lines.append("音频口播转写：不可用 —— %s" % (transcript.get("error") or "未配置"))
        lines.append("")
    for entry in data.get("links") or []:
        lines.append("【视频链接】%s" % entry.get("url"))
        if entry.get("raw") and entry.get("raw") != entry.get("url"):
            lines.append("用户原话（可能已含分享文案）：%s" % entry.get("raw")[:800])
        if entry.get("error"):
            lines.append("页面抓取：失败（%s）。请用 browser 工具打开该链接抓页面可见的标题/文案/话题/评论；"
                         "抓不到就写「数据不足」，不要编造口播文案。" % entry.get("error"))
        else:
            if entry.get("title"):
                lines.append("页面标题：%s" % entry.get("title"))
            for index, desc in enumerate(entry.get("descriptions") or [], 1):
                lines.append("页面文案 %d：%s" % (index, desc))
            if entry.get("page_text"):
                lines.append("页面正文（截取）：%s" % entry.get("page_text")[:4000])
            lines.append("说明：以上只是页面公开文案；平台完整口播文案需要拿到视频文件后做 ASR，"
                         "可用 browser 继续抓取；仍然拿不到就写「数据不足」。")
        lines.append("")
    for note in data.get("notes") or []:
        lines.append("注意：%s" % note)
    for error in data.get("errors") or []:
        lines.append("注意：%s" % error)
    return "\n".join(lines)


def has_reference_input(params: Dict[str, Any]) -> bool:
    return has_video_refs(params)
