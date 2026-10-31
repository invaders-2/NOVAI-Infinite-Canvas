"""PixVerse custom-voice and LipSync API client."""
from __future__ import annotations

import asyncio
import mimetypes
import os
import time
import uuid
from typing import Any, Dict, Optional

import httpx

DEFAULT_BASE_URL = "https://app-api.pixverse.ai"


class PixverseError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


def _headers(api_key: str, auth_mode: str = "api-key", json_body: bool = False) -> Dict[str, str]:
    if not str(api_key or "").strip():
        raise PixverseError("未配置 PixVerse API Key，请在 API 设置中填写。", 400)
    auth_header = "Authorization" if auth_mode == "bearer" else "API-KEY"
    auth_value = "Bearer " + str(api_key).strip() if auth_mode == "bearer" else str(api_key).strip()
    headers = {auth_header: auth_value, "Ai-Trace-Id": uuid.uuid4().hex, "Accept": "application/json"}
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def _payload(response: httpx.Response) -> Dict[str, Any]:
    if response.status_code >= 400:
        raise PixverseError(f"PixVerse 接口返回 HTTP {response.status_code}：{response.text[:500]}", response.status_code)
    try:
        data = response.json()
    except ValueError as exc:
        raise PixverseError("PixVerse 接口返回了非 JSON 响应") from exc
    if int(data.get("ErrCode") or 0) != 0:
        raise PixverseError(f"PixVerse 接口错误：{data.get('ErrMsg') or data}", 502)
    return data


def _resp(data: Dict[str, Any]) -> Dict[str, Any]:
    value = data.get("Resp")
    return value if isinstance(value, dict) else {}


async def upload_media(client: httpx.AsyncClient, base_url: str, api_key: str, auth_mode: str = "api-key",
                       file_path: Optional[str] = None, file_url: str = "",
                       content_type: str = "") -> Dict[str, Any]:
    if not file_path and not file_url:
        raise PixverseError("媒体上传需要本地文件或公网 URL", 400)
    kwargs: Dict[str, Any] = {}
    if file_url:
        kwargs["data"] = {"file_url": file_url}
    else:
        path = os.path.abspath(file_path or "")
        if not os.path.isfile(path):
            raise PixverseError("本地媒体文件不存在", 400)
        content = await asyncio.to_thread(lambda: open(path, "rb").read())
        mime = content_type or mimetypes.guess_type(path)[0] or "application/octet-stream"
        kwargs["files"] = {"file": (os.path.basename(path), content, mime)}
    paths = ["/openapi/v2/media/upload"]
    if auth_mode == "bearer":
        paths.append("/openapi/v2/media/upload/binary")
    response = None
    for path in paths:
        response = await client.post(base_url.rstrip("/") + path,
                                     headers=_headers(api_key, auth_mode), **kwargs)
        if response.status_code != 404:
            break
    data = _payload(response)
    resp = _resp(data)
    if not resp.get("media_id"):
        raise PixverseError("PixVerse 媒体上传未返回 media_id")
    return resp


async def create_custom_voice(client: httpx.AsyncClient, base_url: str, api_key: str,
                              audio_media_id: int, name: str = "NOVAI Voice", auth_mode: str = "api-key") -> str:
    response = await client.post(base_url.rstrip("/") + "/openapi/v2/video/tts_speaker",
                                 headers=_headers(api_key, auth_mode, json_body=True),
                                 json={"name": str(name or "NOVAI Voice")[:80], "audio_media_id": int(audio_media_id)})
    speaker_id = str(_resp(_payload(response)).get("speaker_id") or "").strip()
    if not speaker_id:
        raise PixverseError("PixVerse 未返回自定义声音 speaker_id")
    return speaker_id


async def generate_lipsync(client: httpx.AsyncClient, base_url: str, api_key: str, auth_mode: str = "api-key",
                           video_media_id: Optional[int] = None, source_video_id: Optional[int] = None,
                           audio_media_id: Optional[int] = None, speaker_id: str = "",
                           script: str = "") -> Dict[str, Any]:
    body: Dict[str, Any] = {}
    if video_media_id:
        body["video_media_id"] = int(video_media_id)
    elif source_video_id:
        body["source_video_id"] = int(source_video_id)
    else:
        raise PixverseError("LipSync 需要原视频", 400)
    if audio_media_id:
        body["audio_media_id"] = int(audio_media_id)
    else:
        if not speaker_id or not script.strip():
            raise PixverseError("克隆声音需要 speaker_id 和新台词", 400)
        body["lip_sync_tts_speaker_id"] = speaker_id
        body["lip_sync_tts_content"] = script.strip()
    response = await client.post(base_url.rstrip("/") + "/openapi/v2/video/lip_sync/generate",
                                 headers=_headers(api_key, auth_mode, json_body=True), json=body)
    data = _payload(response)
    if not _resp(data).get("video_id"):
        raise PixverseError("PixVerse LipSync 未返回 video_id")
    return data


async def wait_for_video(client: httpx.AsyncClient, base_url: str, api_key: str,
                         video_id: int, timeout: float = 900.0, interval: float = 5.0,
                         auth_mode: str = "api-key") -> Dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = await client.get(base_url.rstrip("/") + f"/openapi/v2/video/result/{int(video_id)}",
                                    headers=_headers(api_key, auth_mode))
        data = _payload(response)
        resp = _resp(data)
        status = int(resp.get("status") or 0)
        if status == 1 and resp.get("url"):
            return data
        if status == 7:
            raise PixverseError("PixVerse 内容审核未通过", 400)
        if status == 8:
            raise PixverseError("PixVerse LipSync 生成失败", 502)
        await asyncio.sleep(interval)
    raise PixverseError("PixVerse LipSync 生成超时", 504)
