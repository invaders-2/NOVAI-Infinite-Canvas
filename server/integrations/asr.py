#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""画布助手语音输入的服务端转写入口。

为什么单独成模块：平台/模型解析与「按 OpenAI input_audio 形状请求上游」已经由
server/integrations/video_sources.py 实现（视频口播转写），画布助手这里只多出
「小段麦克风 WAV 的大小/格式校验、错误码、临时文件生命周期」，所以只做入口适配，
不另造一套 provider 解析；平台解析仍走 main 注册到 deps 的 resolve_chat_provider。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from typing import Any, Dict, Optional, Tuple

from server.agents import store
from server.integrations import video_sources

MAX_AUDIO_BYTES = 20 * 1024 * 1024
_AUDIO_EXTS = (".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac", ".aiff", ".aif")
_EMPTY_TEXTS = ("", "无语音", "没有语音", "（无语音）",
                "(无语音)", "no speech")
_UPSTREAM_STATUS_RE = re.compile(r"ASR 平台返回\s+(\d{3})")
_AUDIO_REJECTION_WORDS = ("audio", "input_audio", "音频", "声音", "不支持",
                          "unsupported", "not supported", "mime", "invalid_argument",
                          "模态", "modality")
_LOCAL_COMMAND_PROVIDER = "local-command"


def _agent_chat_model() -> Dict[str, str]:
    """settings.json 的 agent_chat_model（provider::model）作为最后一层兜底。

    为什么放在这里：它本来是「画布助手用哪个对话模型」的设置，语音转写只是借用同一个
    支持音频的模型；读不到或格式不完整就当没有，绝不猜平台。
    """
    provider = ""
    model = ""
    raw = ""
    try:
        path = os.path.join(store.data_dir(), "settings.json")
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            raw = str(data.get("agent_chat_model") or "").strip()
    except Exception:
        raw = ""
    if "::" in raw:
        head, _, tail = raw.partition("::")
        provider = head.strip()
        model = tail.strip()
    return {"provider": provider, "model": model}


def resolve_asr_settings() -> Dict[str, str]:
    """按契约顺序给出本轮生效的平台/模型/来源，不重复实现各层解析。"""
    detail = video_sources.asr_settings_detail()
    provider = str(detail.get("provider") or "").strip()
    model = str(detail.get("model") or "").strip()
    source = str(detail.get("source") or "none")
    if source == "none":
        agent = _agent_chat_model()
        if agent["provider"] and agent["model"]:
            provider, model, source = agent["provider"], agent["model"], "agent"
    return {"provider": provider, "model": model, "source": source}


def _local_command() -> str:
    return (os.environ.get("NOVAI_ASR_COMMAND") or "").strip()


def _status_hint(settings: Dict[str, str], ready: bool) -> str:
    provider = settings["provider"]
    model = settings["model"]
    if ready:
        if settings["source"] == "agent":
            return ("未单独配置语音转写，当前借用画布助手的对话模型（%s / %s）。"
                    "如需固定转写模型：设置 → 通用 → 语音转写。" % (provider, model))
        return "语音转写已启用：%s / %s。" % (provider, model)
    if provider or model:
        return "语音转写配置不完整：请到「设置 → 通用 → 语音转写」同时选择平台和模型。"
    return ("未配置语音转写：请在「设置 → 通用 → 语音转写」选择平台和模型"
            "（或设置环境变量 NOVAI_ASR_PROVIDER / NOVAI_ASR_MODEL）。")


def asr_status() -> Dict[str, Any]:
    """给画布助手判断「麦克风按钮能不能用」以及给用户的下一步提示。"""
    command = _local_command()
    if command:
        return {"ready": True, "provider": _LOCAL_COMMAND_PROVIDER, "model": "",
                "source": "env",
                "hint": "语音转写已启用：使用本机命令通道（NOVAI_ASR_COMMAND）。"}
    settings = resolve_asr_settings()
    ready = bool(settings["provider"] and settings["model"])
    return {"ready": ready, "provider": settings["provider"], "model": settings["model"],
            "source": settings["source"], "hint": _status_hint(settings, ready)}


def _not_configured_message() -> str:
    return ("未配置语音转写：请在「设置 → 通用 → 语音转写」选择平台和模型，"
            "或设置环境变量 NOVAI_ASR_PROVIDER / NOVAI_ASR_MODEL 后再试。")


def _failure(code: str, error: str, settings: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    current = settings or {"provider": "", "model": "", "source": "none"}
    return {"ok": False, "code": code, "error": error,
            "provider": current.get("provider") or "",
            "model": current.get("model") or "",
            "source": current.get("source") or "none"}


def _local_settings() -> Dict[str, str]:
    return {"provider": _LOCAL_COMMAND_PROVIDER, "model": "", "source": "env"}


def _audio_suffix(filename: str) -> Optional[str]:
    name = os.path.basename(str(filename or "").strip())
    ext = os.path.splitext(name)[1].lower()
    if not ext:
        return ".wav"
    return ext if ext in _AUDIO_EXTS else None


_EN_ASR_PROMPT = ("Transcribe this recording verbatim. Do not translate or summarize; "
                  "write in the language the speaker used. When Chinese and English are mixed, "
                  "keep the English words and their correct spelling. Keep proper nouns such as "
                  "names, brands, products and abbreviations in their common spelling "
                  "(for example NOVAI, Midjourney, ChatGPT, iPhone), and keep Chinese names and "
                  "place names in their correct characters. Keep numbers and punctuation. "
                  "Only output the transcript, with no timestamps, numbering or speaker labels; "
                  "if nobody speaks, output exactly: no speech.")


def _prompt_for_lang(lang: str) -> str:
    """中英文共用一套「不翻译、保留专有名词」的约束；英文只换语言，不和中文分叉。"""
    if str(lang or "").strip().lower().startswith("en"):
        return _EN_ASR_PROMPT
    # 与视频口播共用同一份中文口径，避免两条转写链路对名字的处理不一致。
    return video_sources._ASR_PROMPT


def _is_empty_text(text: Any) -> bool:
    cleaned = str(text or "").strip().strip("\"'“”‘’").strip()
    cleaned = cleaned.rstrip("。.!！?？…").strip()
    return cleaned in _EMPTY_TEXTS


def _classify_provider_error(message: str) -> str:
    """只把「400 且像在拒绝音频/模型」归到 ASR_UNSUPPORTED，其余上游失败仍是 PROVIDER_ERROR。"""
    match = _UPSTREAM_STATUS_RE.search(str(message or ""))
    if not match:
        return "ASR_PROVIDER_ERROR"
    if int(match.group(1)) != 400:
        return "ASR_PROVIDER_ERROR"
    lowered = str(message or "").lower()
    if any(word in lowered for word in _AUDIO_REJECTION_WORDS):
        return "ASR_UNSUPPORTED"
    return "ASR_PROVIDER_ERROR"


def _provider_error_text(code: str, message: str) -> str:
    detail = str(message or "").strip()
    if code == "ASR_UNSUPPORTED":
        suffix = "（上游：%s）" % detail[:200] if detail else ""
        return ("当前模型不支持音频转写：请在「设置 → 通用 → 语音转写」"
                "换一个支持音频的模型" + suffix)
    reason = detail[:300] if detail else "上游没有返回原因"
    return "语音转写失败：" + reason + "。请检查网络，或换一个支持音频的模型后再试。"


def _resolve_provider(provider: str, model: str) -> Tuple[bool, str]:
    """先独立解析一次平台：HTTPException 的原始 detail 比 _provider_transcript 包出来的字符串
    更适合直接展示给用户；真正发请求仍交给 _provider_transcript。"""
    from server.routes.deps import deps

    resolver = deps.get("resolve_chat_provider")
    if resolver is None:
        return False, "语音转写服务未就绪：缺少平台解析依赖，请重启 NOVAI 后再试。"
    try:
        resolver(provider, model, "")
    except Exception as exc:
        detail = getattr(exc, "detail", None)
        if isinstance(detail, str) and detail.strip():
            return False, detail.strip()
        return False, "解析语音转写平台失败：%s: %s" % (type(exc).__name__, exc)
    return True, ""


def _run_local_command(command: str, audio_path: str) -> Dict[str, Any]:
    run = command.replace("{audio}", audio_path)
    try:
        timeout = float(os.environ.get("NOVAI_ASR_TIMEOUT") or 300.0)
    except (TypeError, ValueError):
        timeout = 300.0
    try:
        completed = subprocess.run(run, shell=True, capture_output=True, text=True, timeout=timeout)
    except Exception as exc:
        return _failure("ASR_PROVIDER_ERROR",
                        "本机转写命令执行失败：%s: %s" % (type(exc).__name__, exc),
                        _local_settings())
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip()[:200]
        return _failure("ASR_PROVIDER_ERROR",
                        "本机转写命令失败：%s" % (stderr or "退出码 %s" % completed.returncode),
                        _local_settings())
    text = (completed.stdout or "").strip()
    if _is_empty_text(text):
        return _failure("ASR_EMPTY", "没听清，再说一次试试。", _local_settings())
    return {"ok": True, "text": text, "provider": _LOCAL_COMMAND_PROVIDER, "model": "",
            "source": "env"}


async def transcribe_audio(raw_bytes: bytes, filename: str = "", lang: str = "zh") -> Dict[str, Any]:
    """把前端录好的音频转成文本；业务失败一律返回 ok=false + code，不抛 HTTP 错误码。"""
    if not raw_bytes:
        return _failure("ASR_AUDIO_INVALID", "录音是空的：请重新录制后再试。")
    if len(raw_bytes) > MAX_AUDIO_BYTES:
        return _failure("ASR_AUDIO_INVALID", "录音太大（超过 20MB）：请缩短录音后再试。")
    suffix = _audio_suffix(filename)
    if suffix is None:
        return _failure("ASR_AUDIO_INVALID",
                        "录音格式不支持：请上传 WAV / MP3 / M4A / AAC / OGG / FLAC 音频。")
    settings = resolve_asr_settings()
    command = _local_command()
    if not command and not (settings["provider"] and settings["model"]):
        return _failure("ASR_NOT_CONFIGURED", _not_configured_message(), settings)
    prompt = _prompt_for_lang(lang)
    try:
        with tempfile.TemporaryDirectory(prefix="novai-asr-") as workdir:
            audio_path = os.path.join(workdir, "audio" + suffix)
            with open(audio_path, "wb") as handle:
                handle.write(raw_bytes)
            if command:
                return _run_local_command(command, audio_path)
            ok, message = _resolve_provider(settings["provider"], settings["model"])
            if not ok:
                return _failure("ASR_PROVIDER_ERROR", message, settings)
            result = await video_sources._provider_transcript(
                audio_path, settings["provider"], settings["model"], prompt=prompt)
            if not result.get("ok"):
                raw_error = str(result.get("error") or "")
                code = _classify_provider_error(raw_error)
                return _failure(code, _provider_error_text(code, raw_error), settings)
            text = str(result.get("text") or "").strip()
            if _is_empty_text(text):
                return _failure("ASR_EMPTY", "没听清，再说一次试试。", settings)
            return {"ok": True, "text": text,
                    "provider": settings["provider"],
                    "model": str(result.get("model") or settings["model"]),
                    "source": settings["source"]}
    except Exception as exc:
        return _failure("ASR_PROVIDER_ERROR",
                        "语音转写失败：%s: %s" % (type(exc).__name__, exc), settings)
