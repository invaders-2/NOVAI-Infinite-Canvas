# -*- coding: utf-8 -*-
"""画布「解析」接口 /api/canvas-analyze-media：data URL 落临时文件、超大拒绝、模板四段标记、模型选择启发式。

全部离线：视觉模型调用被打桩，不发任何网络请求；图片源只走 data URL。
"""
import base64
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = tempfile.mkdtemp(prefix="novai-canvas-analyze-")
os.environ.setdefault("NOVAI_DATA_DIR", _TMP)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402

CLIENT = TestClient(main.app)


def teardown_module(module):
    shutil.rmtree(_TMP, ignore_errors=True)


# 1x1 PNG：足够让 data URL 走完整解码链路，不需要真图
_PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05"
    b"\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB\x60\x82"
)
_PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(_PNG_1X1).decode("ascii")

_REPLY = (
    "[中文正向]\n红裙女孩，侧身微笑，城市街头， cinematic 风格，中景，85mm，柔和逆光，暖色调，丝绸材质，8K 超清\n\n"
    "[中文负向]\n低质量，模糊，噪点，过曝，畸变，多余手指，水印，logo，文字\n\n"
    "[English Positive]\nred dress girl, side profile, smiling, city street, cinematic style, medium shot, 85mm, soft backlight, warm tones, silk texture, 8K uhd\n\n"
    "[English Negative]\nlow quality, blurry, noise, overexposed, distorted, extra fingers, watermark, logo, text\n"
)


def _fake_caption_recorder(calls, reply=_REPLY, model="vision-mock"):
    async def _fake(abs_path, prompt, provider_id, model_arg, ms_model=""):
        calls.append({
            "path": abs_path,
            "prompt": prompt,
            "provider": provider_id,
            "model": model_arg,
            "exists_during_call": os.path.exists(abs_path),
            "size": os.path.getsize(abs_path) if os.path.exists(abs_path) else -1,
        })
        return reply, model
    return _fake


def test_data_url_is_decoded_to_temp_file_and_removed(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_image_with_provider", _fake_caption_recorder(calls))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "image": _PNG_DATA_URL, "is_video_frame": False, "provider": "test", "model": "",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["model"] == "vision-mock"
    assert body["prompt"] == main.CANVAS_ANALYZE_PROMPT
    assert "[中文正向]" in body["text"] and "[English Negative]" in body["text"]

    assert len(calls) == 1
    saved = calls[0]
    assert saved["exists_during_call"] is True, "调用视觉模型时必须已经有临时文件"
    assert saved["size"] == len(_PNG_1X1)
    assert os.path.basename(saved["path"]).startswith("canvas_analyze_")
    assert saved["path"].endswith(".png")
    assert saved["provider"] == "test"
    assert not os.path.exists(saved["path"]), "finally 里必须把临时文件删掉"


def test_video_frame_appends_the_same_note(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_image_with_provider", _fake_caption_recorder(calls))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "image": _PNG_DATA_URL, "is_video_frame": True, "provider": "test", "model": "",
    })

    assert resp.status_code == 200, resp.text
    prompt = calls[0]["prompt"]
    assert prompt == main.CANVAS_ANALYZE_PROMPT + main.CANVAS_ANALYZE_VIDEO_FRAME_NOTE + "\n"
    assert resp.json()["prompt"] == prompt


def test_oversized_data_url_rejected_before_decoding(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_image_with_provider", _fake_caption_recorder(calls))
    monkeypatch.setattr(main, "CANVAS_ANALYZE_MAX_IMAGE_BYTES", 1024)
    big = "data:image/jpeg;base64," + base64.b64encode(b"x" * 4096).decode("ascii")

    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": big, "provider": "test"})

    assert resp.status_code == 400, resp.text
    assert "图片太大" in resp.json()["detail"]
    assert calls == [], "超大图片不该走到视觉模型"


def test_empty_model_reply_becomes_502(monkeypatch):
    monkeypatch.setattr(main, "caption_image_with_provider",
                        _fake_caption_recorder([], reply="接口返回了空回复。", model="vision-mock"))

    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 502, resp.text
    assert "换一个视觉模型" in resp.json()["detail"]


def test_missing_image_is_400():
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": ""})
    assert resp.status_code == 400
    assert "没有收到图片" in resp.json()["detail"]


def test_upstream_html_error_page_not_leaked(monkeypatch):
    async def _boom(abs_path, prompt, provider_id, model, ms_model=""):
        raise main.HTTPException(
            status_code=502, detail="上游接口错误：<html><body>FORBIDDEN</body></html>")

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 502, resp.text
    detail = resp.json()["detail"]
    assert "<html" not in detail and "FORBIDDEN" not in detail
    assert detail == "上游返回的是网关错误页，不是模型接口的正常响应：请稍后重试，或换一个视觉模型。"


def test_upstream_rate_limit_becomes_chinese_502(monkeypatch):
    async def _boom(abs_path, prompt, provider_id, model, ms_model=""):
        raise main.HTTPException(status_code=429, detail="429 rate limit exceeded")

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 502, resp.text
    assert "限流" in resp.json()["detail"]


def test_upstream_400_keeps_400_and_chinese_detail(monkeypatch):
    async def _boom(abs_path, prompt, provider_id, model, ms_model=""):
        raise main.HTTPException(status_code=400, detail="未配置 test 的 API Key，请在 API 平台管理中填写。")

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "未配置 test 的 API Key，请在 API 平台管理中填写。"


def test_prompt_template_has_exactly_four_marker_lines():
    markers = ["[中文正向]", "[中文负向]", "[English Positive]", "[English Negative]"]
    # 标记要作为独立一整行出现、顺序固定（前端按这四行切段）；正文里「1. [中文正向]：」不算标记行
    marker_lines = [line.strip() for line in main.CANVAS_ANALYZE_PROMPT.splitlines()
                    if line.strip() in markers]
    assert marker_lines == markers
    assert "注意：这是视频的一帧" not in main.CANVAS_ANALYZE_PROMPT
    assert main.canvas_analyze_prompt(False) == main.CANVAS_ANALYZE_PROMPT


def test_vision_model_heuristic_picks_first_matching_usable_provider(monkeypatch):
    providers = [
        {"id": "disabled", "enabled": False, "chat_models": ["gpt-4o"]},
        {"id": "nokey", "enabled": True, "chat_models": ["claude-3-7"]},
        {"id": "plain", "enabled": True, "chat_models": ["deepseek-chat"]},
        {"id": "vision-a", "enabled": True, "chat_models": ["deepseek-chat", "qwen-vl-max"]},
        {"id": "vision-b", "enabled": True, "chat_models": ["gemini-2.5-pro"]},
    ]
    monkeypatch.setattr(main, "load_api_providers", lambda: providers)
    monkeypatch.setattr(main, "provider_has_usable_key", lambda provider: provider["id"] != "nokey")
    monkeypatch.setattr(main, "_is_admin_actor", lambda request=None: True)
    monkeypatch.setattr(main, "agent_default_chat_model", lambda: "")

    assert main.canvas_analyze_vision_provider("") == ("vision-a", "qwen-vl-max")
    # 显式给了平台就不猜模型，让它按平台的 chat_models 解析
    assert main.canvas_analyze_vision_provider("vision-b") == ("vision-b", "")


def test_vision_model_heuristic_falls_back_to_default(monkeypatch):
    providers = [{"id": "plain", "enabled": True, "chat_models": ["deepseek-chat", "gpt-3.5"]}]
    monkeypatch.setattr(main, "load_api_providers", lambda: providers)
    monkeypatch.setattr(main, "provider_has_usable_key", lambda provider: True)
    monkeypatch.setattr(main, "_is_admin_actor", lambda request=None: True)
    monkeypatch.setattr(main, "agent_default_chat_model", lambda: "")

    # gpt-3.5 不命中 → 交给 resolve_chat_provider("", "", "") 的默认值，响应里再回填实际模型
    assert main.canvas_analyze_vision_provider("") == ("", "")


def test_vision_model_heuristic_member_only_sees_apimart(monkeypatch):
    providers = [
        {"id": "comfly", "enabled": True, "chat_models": ["gpt-4o"]},
        {"id": "apimart", "enabled": True, "chat_models": ["gpt-4o-mini"]},
    ]
    monkeypatch.setattr(main, "load_api_providers", lambda: providers)
    monkeypatch.setattr(main, "provider_has_usable_key", lambda provider: True)
    monkeypatch.setattr(main, "_is_admin_actor", lambda request=None: False)
    monkeypatch.setattr(main, "agent_default_chat_model", lambda: "")

    assert main.canvas_analyze_vision_provider("") == ("apimart", "gpt-4o-mini")


def test_vision_model_prefers_settings_default_chat_model(monkeypatch):
    providers = [
        {"id": "modelscope", "enabled": True, "chat_models": ["OpenGVLab/InternVL3_5-241B-A28B"]},
        {"id": "apimart", "enabled": True, "chat_models": ["claude-opus-5"]},
    ]
    monkeypatch.setattr(main, "load_api_providers", lambda: providers)
    monkeypatch.setattr(main, "provider_has_usable_key", lambda provider: True)
    monkeypatch.setattr(main, "_is_admin_actor", lambda request=None: True)
    # 用户在设置里选的默认对话模型（platform::model）优先于扫描，哪怕 modelscope 排在平台列表最前面
    monkeypatch.setattr(main, "agent_default_chat_model", lambda: "apimart::claude-opus-5")

    assert main.canvas_analyze_vision_provider("") == ("apimart", "claude-opus-5")
    # 显式指定平台时仍然不猜模型
    assert main.canvas_analyze_vision_provider("modelscope") == ("modelscope", "")


def test_vision_model_settings_default_skipped_when_provider_unusable(monkeypatch):
    providers = [
        {"id": "modelscope", "enabled": True, "chat_models": ["OpenGVLab/InternVL3_5-241B-A28B"]},
        {"id": "apimart", "enabled": True, "chat_models": ["claude-opus-5"]},
        {"id": "comfly", "enabled": True, "chat_models": ["deepseek-chat", "gpt-4o"]},
    ]
    monkeypatch.setattr(main, "load_api_providers", lambda: providers)
    # 默认模型指向的平台没有可用 Key -> 跳过它，回到扫描
    monkeypatch.setattr(main, "provider_has_usable_key", lambda provider: provider["id"] != "apimart")
    monkeypatch.setattr(main, "_is_admin_actor", lambda request=None: True)
    monkeypatch.setattr(main, "agent_default_chat_model", lambda: "apimart::claude-opus-5")

    assert main.canvas_analyze_vision_provider("") == ("comfly", "gpt-4o")


def test_vision_model_settings_default_skipped_when_model_not_vision(monkeypatch):
    providers = [{"id": "apimart", "enabled": True,
                  "chat_models": ["seedance-2.0", "claude-opus-5"]}]
    monkeypatch.setattr(main, "load_api_providers", lambda: providers)
    monkeypatch.setattr(main, "provider_has_usable_key", lambda provider: True)
    monkeypatch.setattr(main, "_is_admin_actor", lambda request=None: True)
    # 设置里的默认模型不是视觉模型（seedance 是视频模型）-> 不用它，继续扫同一个平台
    monkeypatch.setattr(main, "agent_default_chat_model", lambda: "apimart::seedance-2.0")

    assert main.canvas_analyze_vision_provider("") == ("apimart", "claude-opus-5")


def test_vision_model_heuristic_scans_modelscope_last(monkeypatch):
    providers = [
        {"id": "modelscope", "enabled": True, "chat_models": ["OpenGVLab/InternVL3_5-241B-A28B"]},
        {"id": "volcengine", "enabled": True, "chat_models": ["deepseek-v4-flash"]},
        {"id": "comfly", "enabled": True, "chat_models": ["gpt-4o"]},
    ]
    monkeypatch.setattr(main, "load_api_providers", lambda: providers)
    monkeypatch.setattr(main, "provider_has_usable_key", lambda provider: True)
    monkeypatch.setattr(main, "_is_admin_actor", lambda request=None: True)
    monkeypatch.setattr(main, "agent_default_chat_model", lambda: "")

    # modelscope 即使排在最前、名字也命中，也要等其他平台先扫完
    assert main.canvas_analyze_vision_provider("") == ("comfly", "gpt-4o")


def test_vision_model_heuristic_uses_modelscope_only_as_last_resort(monkeypatch):
    providers = [
        {"id": "modelscope", "enabled": True, "chat_models": ["OpenGVLab/InternVL3_5-241B-A28B"]},
        {"id": "volcengine", "enabled": True, "chat_models": ["deepseek-v4-flash"]},
    ]
    monkeypatch.setattr(main, "load_api_providers", lambda: providers)
    monkeypatch.setattr(main, "provider_has_usable_key", lambda provider: True)
    monkeypatch.setattr(main, "_is_admin_actor", lambda request=None: True)
    monkeypatch.setattr(main, "agent_default_chat_model", lambda: "")

    assert main.canvas_analyze_vision_provider("") == ("modelscope", "OpenGVLab/InternVL3_5-241B-A28B")
