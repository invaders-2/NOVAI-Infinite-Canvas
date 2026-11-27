# -*- coding: utf-8 -*-
"""画布「解析」接口 /api/canvas-analyze-media：data URL 落临时文件、超大拒绝、模型只吐 JSON 时
由后端拼四段 text + 12 列分镜表、视频多帧走视频专用模板、模型选择启发式。

全部离线：视觉模型调用被打桩，不发任何网络请求；图片源只走 data URL。
"""
import asyncio
import base64
import json
import os

import httpx
import shutil
import sys
import tempfile
from pathlib import Path

from PIL import Image

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


_VIDEO_REPLY = (
    "[中文正向]\n产品在桌面上缓慢旋转，镜头轻推，暖光由左向右移动，商业广告质感，25fps\n\n"
    "[中文负向]\n画面闪烁，抖动，跳帧，形变，穿模，肢体扭曲，拖影，水印，字幕\n\n"
    "[English Positive]\nproduct rotating slowly, camera push in, warm light shifting, "
    "commercial ad look, 25fps\n\n"
    "[English Negative]\nflicker, shake, frame jump, warping, clipping, watermark, subtitles\n"
)

_VIDEO_MARKERS = ["[中文正向]", "[中文负向]", "[English Positive]", "[English Negative]"]

# 模型按新模板「只吐 JSON」时的标准回复（3 行分镜）
_JSON_PROMPT = {
    "cnPos": "红裙女孩，侧身微笑，城市街头，电影感",
    "cnNeg": "低质量，模糊，水印",
    "enPos": "red dress girl, side profile, smiling, city street, cinematic",
    "enNeg": "low quality, blurry, watermark",
}
_JSON_SHOTS = [
    {"no": "1", "dur": "4s", "desc": "红裙女孩走向橱窗", "char": "女孩", "charDesc": "红裙长发",
     "shotSize": "中景", "mood": "期待", "light": "暖色橱窗光", "audio": "街道环境声",
     "line": "", "prompt": "红裙女孩走向橱窗，中景", "motion": "Slow Dolly in"},
    {"no": "2", "dur": "3s", "desc": "她抬手触碰玻璃", "char": "女孩", "charDesc": "红裙长发",
     "shotSize": "近景", "mood": "好奇", "light": "橱窗高光", "audio": "脚步与车流",
     "line": "（无对白）", "prompt": "女孩抬手触碰橱窗，近景", "motion": "Handheld follow"},
    {"no": "3", "dur": "5s", "desc": "镜头拉远收在城市夜景", "char": "女孩", "charDesc": "红裙长发",
     "shotSize": "全景", "mood": "释然", "light": "霓虹冷暖对比", "audio": "城市底噪",
     "line": "", "prompt": "城市夜景中的红裙背影，全景", "motion": "Slow pull out"},
]


def _json_reply(shots=None, prompt=None):
    return json.dumps({
        "prompt": dict(_JSON_PROMPT if prompt is None else prompt),
        "shots": list(_JSON_SHOTS if shots is None else shots),
    }, ensure_ascii=False)


_JSON_REPLY = _json_reply()

_EXPECTED_FOUR_SECTIONS = (
    "[中文正向]\n红裙女孩，侧身微笑，城市街头，电影感\n\n"
    "[中文负向]\n低质量，模糊，水印\n\n"
    "[English Positive]\nred dress girl, side profile, smiling, city street, cinematic\n\n"
    "[English Negative]\nlow quality, blurry, watermark"
)


def _fake_caption_recorder(calls, reply=_REPLY, model="vision-mock"):
    async def _fake(abs_path, prompt, provider_id, model_arg, ms_model="", max_tokens=0,
                    timeout_seconds=None):
        calls.append({
            "path": abs_path,
            "prompt": prompt,
            "provider": provider_id,
            "model": model_arg,
            "max_tokens": max_tokens,
            "timeout_seconds": timeout_seconds,
            "exists_during_call": os.path.exists(abs_path),
            "size": os.path.getsize(abs_path) if os.path.exists(abs_path) else -1,
        })
        return reply, model
    return _fake


def _fake_images_caption_recorder(calls, reply=_VIDEO_REPLY, model="vision-mock"):
    async def _fake(abs_paths, prompt, provider_id, model_arg, ms_model="", max_tokens=0,
                    timeout_seconds=None):
        paths = list(abs_paths)
        calls.append({
            "paths": paths,
            "prompt": prompt,
            "provider": provider_id,
            "model": model_arg,
            "max_tokens": max_tokens,
            "timeout_seconds": timeout_seconds,
            "exists_during_call": [os.path.exists(path) for path in paths],
            "sizes": [os.path.getsize(path) if os.path.exists(path) else -1 for path in paths],
        })
        return reply, model
    return _fake


def _capture_temp_files(monkeypatch):
    """记录本次请求写出过哪些临时文件（断言清理时比直接扫系统临时目录更稳）。"""
    created = []
    real_mkstemp = tempfile.mkstemp

    def _record(*args, **kwargs):
        fd, path = real_mkstemp(*args, **kwargs)
        created.append(path)
        return fd, path

    monkeypatch.setattr(tempfile, "mkstemp", _record)
    return created


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
    assert saved["max_tokens"] == main.CANVAS_ANALYZE_MAX_TOKENS == 8192, "解析要带上输出上限压预扣费"
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
    async def _boom(abs_path, prompt, provider_id, model, ms_model="", max_tokens=0,
                    timeout_seconds=None):
        raise main.HTTPException(
            status_code=502, detail="上游接口错误：<html><body>FORBIDDEN</body></html>")

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 502, resp.text
    detail = resp.json()["detail"]
    assert "<html" not in detail and "FORBIDDEN" not in detail
    assert detail == "上游网关报错 HTTP 502（不是模型接口的正常响应）：请稍后重试，或换一个视觉模型。"
    assert "HTTP 502" in detail


def test_upstream_rate_limit_becomes_chinese_502(monkeypatch):
    async def _boom(abs_path, prompt, provider_id, model, ms_model="", max_tokens=0,
                    timeout_seconds=None):
        raise main.HTTPException(status_code=429, detail="429 rate limit exceeded")

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 502, resp.text
    assert "限流" in resp.json()["detail"]


def test_upstream_400_keeps_400_and_chinese_detail(monkeypatch):
    async def _boom(abs_path, prompt, provider_id, model, ms_model="", max_tokens=0,
                    timeout_seconds=None):
        raise main.HTTPException(status_code=400, detail="未配置 test 的 API Key，请在 API 平台管理中填写。")

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "未配置 test 的 API Key，请在 API 平台管理中填写。"


def test_image_prompt_template_asks_for_prompt_json_only():
    # 图片节点只要提示词：JSON 里只有 prompt 块，不再有 shots / 分镜表要求
    prompt = main.CANVAS_ANALYZE_PROMPT
    assert main.canvas_analyze_prompt(False) == prompt
    assert "只输出一个 JSON 对象" in prompt
    assert '{"prompt":{"cnPos":"","cnNeg":"","enPos":"","enNeg":""}}' in prompt
    assert '"shots"' not in prompt and "shots" not in prompt, "图片模板不该再要求 shots"
    for key in ('"cnPos"', '"cnNeg"', '"enPos"', '"enNeg"'):
        assert key in prompt
    # 四段的内容要求保留
    assert "200–400 字" in prompt and "60–120 字" in prompt and "60–150 词" in prompt
    assert "主体与外观细节" in prompt and "构图与镜头" in prompt
    assert "注意：这是视频的一帧" not in prompt
    assert "[中文正向]" not in prompt
    # 视频一帧的旧说明仍在（is_video_frame=true 时还会再追加一行）
    assert "按静态画面反推，不要描述镜头运动" in prompt


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


# ── 视频多帧解析（2026-11-24 第四轮）─────────────────────────────────────────


def test_video_prompt_template_asks_for_json_storyboard():
    prompt = main.CANVAS_ANALYZE_VIDEO_PROMPT
    assert "只输出一个 JSON 对象" in prompt
    assert "3–8 行分镜" in prompt
    # 英文正向段仍要求交代 motion / camera movement
    assert "motion" in prompt and "camera movement" in prompt
    # 12 个分镜键全部在模板的 JSON 结构里声明
    for key in main.CANVAS_ANALYZE_TABLE_KEYS:
        assert f'"{key}"' in prompt, f"分镜表键 {key} 应出现在模板 JSON 结构里"
    assert "注意：这是视频的一帧" not in prompt
    # 模板不再直接要求四段标记行（标记由后端拼 text 时加）
    assert "[中文正向]" not in prompt
    # 没给 duration 时视频模板就是常量原文
    assert main.canvas_analyze_video_prompt(0, 3) == main.CANVAS_ANALYZE_VIDEO_PROMPT


def test_multi_frame_uses_video_template_and_sends_all_frames(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider", _fake_images_caption_recorder(calls))

    async def _single_should_not_be_used(*args, **kwargs):
        raise AssertionError("多帧不该走单图路径")

    monkeypatch.setattr(main, "caption_image_with_provider", _single_should_not_be_used)
    created = _capture_temp_files(monkeypatch)

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL, _PNG_DATA_URL, _PNG_DATA_URL],
        "provider": "test", "model": "",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["model"] == "vision-mock"
    assert body["prompt"] == main.CANVAS_ANALYZE_VIDEO_PROMPT
    assert "camera movement" in body["prompt"] and "3–8 行分镜" in body["prompt"]
    # 桩返回的是老式四段文本（非 JSON）：text 原样兜底、分镜表为空
    assert body["table"] is None
    assert "[中文正向]" in body["text"] and "[English Negative]" in body["text"]

    assert len(calls) == 1
    saved = calls[0]
    assert saved["max_tokens"] == main.CANVAS_ANALYZE_MAX_TOKENS, "多帧解析也要带上输出上限"
    assert len(saved["paths"]) == 3, "三帧都要发给模型"
    assert saved["exists_during_call"] == [True, True, True], "调用模型时三帧临时文件都得在"
    assert saved["sizes"] == [len(_PNG_1X1)] * 3
    assert len(set(saved["paths"])) == 3, "三帧各落一个临时文件，不能复用同一个"
    assert created and all(not os.path.exists(path) for path in created), "finally 里要把每帧临时文件都删掉"


def test_sixteen_frames_is_accepted_and_temp_files_all_removed(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider", _fake_images_caption_recorder(calls))
    created = _capture_temp_files(monkeypatch)

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 16, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    assert len(calls[0]["paths"]) == 16
    assert len(created) == 16
    assert all(not os.path.exists(path) for path in created)


def test_more_than_sixteen_frames_is_400(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider", _fake_images_caption_recorder(calls))
    created = _capture_temp_files(monkeypatch)

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 17, "provider": "test",
    })

    assert resp.status_code == 400, resp.text
    assert "一次最多 16 帧" in resp.json()["detail"]
    assert calls == []
    assert created == [], "超帧数要在落临时文件之前就拒绝"


def test_total_raw_bytes_over_limit_is_400_and_rolls_back_temp_files(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider", _fake_images_caption_recorder(calls))
    # 两帧加起来一定超过这个上限（一帧刚好不超）
    monkeypatch.setattr(main, "CANVAS_ANALYZE_MAX_TOTAL_BYTES", len(_PNG_1X1) + 1)
    created = _capture_temp_files(monkeypatch)

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL, _PNG_DATA_URL], "provider": "test",
    })

    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "太大" in detail and "20MB" in detail
    assert calls == []
    assert len(created) == 2, "两帧都已落盘，超限后要一起删掉"
    assert all(not os.path.exists(path) for path in created), "超限回滚不能漏临时文件"


def test_video_prompt_includes_duration_and_frame_count(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider", _fake_images_caption_recorder(calls))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "duration": 12.3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    prompt = calls[0]["prompt"]
    assert prompt.startswith("这段视频整段约 12.3 秒，共给出 3 帧，按时间顺序排列。")
    assert main.CANVAS_ANALYZE_VIDEO_PROMPT in prompt
    assert resp.json()["prompt"] == prompt

    resp2 = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "provider": "test",
    })
    assert resp2.status_code == 200, resp2.text
    assert calls[1]["prompt"] == main.CANVAS_ANALYZE_VIDEO_PROMPT, "没给 duration 时不加那句"


def test_kind_video_with_single_frame_uses_video_template(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider", _fake_images_caption_recorder(calls))

    async def _single_should_not_be_used(*args, **kwargs):
        raise AssertionError("kind=video 该走多图版")

    monkeypatch.setattr(main, "caption_image_with_provider", _single_should_not_be_used)

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL], "kind": "video", "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    assert len(calls[0]["paths"]) == 1
    assert resp.json()["prompt"] == main.CANVAS_ANALYZE_VIDEO_PROMPT


def test_kind_video_without_frames_is_400():
    resp = CLIENT.post("/api/canvas-analyze-media", json={"kind": "video", "provider": "test"})

    assert resp.status_code == 400, resp.text
    assert "没有收到视频画面" in resp.json()["detail"]


def test_single_frame_in_images_keeps_old_single_frame_path(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_image_with_provider", _fake_caption_recorder(calls))

    async def _multi_should_not_be_used(*args, **kwargs):
        raise AssertionError("单帧不该走多图版")

    monkeypatch.setattr(main, "caption_images_with_provider", _multi_should_not_be_used)

    # 空串帧被过滤后只剩一帧 -> 仍走旧单帧模板与旧单图调用
    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL, ""], "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    assert len(calls) == 1
    assert calls[0]["path"].endswith(".png")
    assert resp.json()["prompt"] == main.CANVAS_ANALYZE_PROMPT


# ── 分镜表 + JSON 回复（2026-11-24 第五轮）─────────────────────────────────────

_EXPECTED_COLUMNS = ["镜号", "时长", "画面描述", "角色", "角色描述", "景别",
                     "情绪", "光影氛围", "音效", "对白", "分镜提示词", "视频运动提示词"]


def test_video_json_reply_becomes_four_sections_and_storyboard_table(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder(calls, reply=_JSON_REPLY))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "duration": 12.3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"] == _EXPECTED_FOUR_SECTIONS
    assert body["model"] == "vision-mock"
    assert body["table"]["columns"] == _EXPECTED_COLUMNS
    assert body["table"]["columns"] == main.CANVAS_ANALYZE_TABLE_COLUMNS
    rows = body["table"]["rows"]
    assert len(rows) == 3
    assert all(len(row) == 12 for row in rows)
    assert rows[0] == ["1", "4s", "红裙女孩走向橱窗", "女孩", "红裙长发", "中景",
                       "期待", "暖色橱窗光", "街道环境声", "", "红裙女孩走向橱窗，中景", "Slow Dolly in"]
    assert rows[2][0] == "3" and rows[2][11] == "Slow pull out"


def test_image_json_reply_keeps_four_sections_and_never_returns_table(monkeypatch):
    calls = []
    # 就算模型无视模板仍吐了 shots，图片路径也不组表
    reply = _json_reply(shots=[_JSON_SHOTS[0]], prompt=_JSON_PROMPT)
    monkeypatch.setattr(main, "caption_image_with_provider",
                        _fake_caption_recorder(calls, reply=reply))

    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"] == _EXPECTED_FOUR_SECTIONS
    assert body["table"] is None, "图片路径 table 恒为 null"


def test_non_json_reply_falls_back_to_raw_text_with_null_table(monkeypatch):
    monkeypatch.setattr(main, "caption_image_with_provider",
                        _fake_caption_recorder([], reply=_REPLY))

    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"] == _REPLY.strip(), "解析不出 JSON 时 text 用整段回复原文兜底"
    assert body["table"] is None


def test_fenced_json_reply_with_surrounding_prose_is_parsed(monkeypatch):
    wrapped = "这是结果：\n" + "```json\n" + _JSON_REPLY + "\n```\n以上。"
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder([], reply=wrapped))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"] == _EXPECTED_FOUR_SECTIONS
    assert len(body["table"]["rows"]) == 3


def test_storyboard_ignores_unknown_fields_and_fills_missing_with_empty(monkeypatch):
    shot = {"no": 1, "dur": 4, "desc": "只为测试", "unknown": "忽略我"}
    reply = _json_reply(shots=[shot])
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder([], reply=reply))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    row = resp.json()["table"]["rows"][0]
    assert len(row) == 12
    # 非字符串转字符串；缺列补空串；模型自造的列不采信
    assert row[0] == "1" and row[1] == "4" and row[2] == "只为测试"
    assert all(value == "" for value in row[3:])
    assert "忽略我" not in row


def test_storyboard_cell_is_truncated_to_limit(monkeypatch):
    huge = "长" * (main.CANVAS_ANALYZE_TABLE_MAX_CELL_CHARS + 500)
    shot = dict(_JSON_SHOTS[0])
    shot["desc"] = huge
    reply = _json_reply(shots=[shot])
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder([], reply=reply))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    cell = resp.json()["table"]["rows"][0][2]
    assert len(cell) == main.CANVAS_ANALYZE_TABLE_MAX_CELL_CHARS


def test_empty_shots_returns_null_table_but_keeps_four_sections(monkeypatch):
    reply = _json_reply(shots=[])
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder([], reply=reply))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["table"] is None
    assert body["text"] == _EXPECTED_FOUR_SECTIONS


def test_missing_prompt_section_still_keeps_four_marker_lines(monkeypatch):
    prompt = {"cnPos": "只有正向", "cnNeg": "", "enPos": "", "enNeg": ""}
    reply = _json_reply(shots=[_JSON_SHOTS[0]], prompt=prompt)
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder([], reply=reply))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    text = resp.json()["text"]
    marker_lines = [line.strip() for line in text.splitlines() if line.strip() in _VIDEO_MARKERS]
    assert marker_lines == _VIDEO_MARKERS, "四段标记由后端补齐，前端切段逻辑不变"
    assert "[中文正向]\n只有正向" in text


def test_storyboard_caps_rows_at_max(monkeypatch):
    shot = dict(_JSON_SHOTS[0])
    many = [dict(shot, no=str(index + 1)) for index in range(main.CANVAS_ANALYZE_TABLE_MAX_ROWS + 30)]
    reply = _json_reply(shots=many)
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder([], reply=reply))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    rows = resp.json()["table"]["rows"]
    assert len(rows) == main.CANVAS_ANALYZE_TABLE_MAX_ROWS
    assert all(len(row) == 12 for row in rows)


def test_model_json_without_any_prompt_text_falls_back_to_raw_reply(monkeypatch):
    reply = json.dumps({"prompt": {"cnPos": "", "cnNeg": "", "enPos": "", "enNeg": ""},
                        "shots": [_JSON_SHOTS[0]]}, ensure_ascii=False)
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder([], reply=reply))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"] == reply, "四段全空时 text 退回模型原文"
    assert len(body["table"]["rows"]) == 1


# ── 输出上限 / 额度类报错（2026-11-24 第六轮）────────────────────────────────


def _install_chat_stub(monkeypatch, requests):
    """把 OpenAI 兼容分支的 httpx 调用换成记录请求体的假客户端。"""
    class _FakeResponse:
        status_code = 200
        text = ""

        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "收到"}}]}

    class _FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, json=None):
            requests.append({"url": url, "body": json})
            return _FakeResponse()

    monkeypatch.setattr(main.httpx, "AsyncClient", _FakeClient)
    monkeypatch.setattr(main, "resolve_chat_provider",
                        lambda *args, **kwargs: ("http://stub.local/v1", {"X-Test": "1"}, "gpt-4o"))
    monkeypatch.setattr(main, "get_api_provider", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "image_path_to_data_url",
                        lambda path, max_size=1024: "data:image/png;base64,AA==")


def test_max_tokens_is_only_sent_when_positive(monkeypatch):
    requests = []
    _install_chat_stub(monkeypatch, requests)

    text, model = asyncio.run(main.caption_images_with_provider(
        ["/tmp/canvas-analyze-stub.png"], "反推这段视频", "", "", max_tokens=8192))

    assert text == "收到" and model == "gpt-4o"
    assert requests[-1]["body"]["max_tokens"] == 8192

    # 默认 0：请求体里根本不出现 max_tokens，旧调用点行为不变
    requests.clear()
    asyncio.run(main.caption_images_with_provider(["/tmp/canvas-analyze-stub.png"], "描述图片", "", ""))
    assert "max_tokens" not in requests[-1]["body"]

    requests.clear()
    asyncio.run(main.caption_image_with_provider("/tmp/canvas-analyze-stub.png", "描述图片", "", ""))
    assert "max_tokens" not in requests[-1]["body"]


def test_quota_error_detail_markers_become_chinese_sentence():
    for body in ("failed to pre-consume quota (current balance: $3.148456)",
                 "insufficient balance",
                 "HTTP 402 Payment Required",
                 "Quota exceeded"):
        exc = main.HTTPException(status_code=502, detail="上游接口错误：" + body)
        assert main.canvas_analyze_error_detail(exc) == main.CANVAS_ANALYZE_QUOTA_DETAIL, body
    # 普通错误不受影响
    plain = main.HTTPException(status_code=502, detail="普通网络错误")
    assert main.canvas_analyze_error_detail(plain) == "普通网络错误"


def test_preconsume_quota_error_on_single_frame_is_chinese_502(monkeypatch):
    async def _boom(abs_path, prompt, provider_id, model, ms_model="", max_tokens=0,
                    timeout_seconds=None):
        raise main.HTTPException(status_code=402, detail=(
            '上游接口错误：{"error":{"code":402,"message":"failed to pre-consume quota '
            '(current balance: $3.148456, required: $4.981162)"}}'))

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 502, resp.text
    detail = resp.json()["detail"]
    assert detail == main.CANVAS_ANALYZE_QUOTA_DETAIL
    for leaked in ("pre-consume", "quota", "balance", "402", "error", "required"):
        assert leaked not in detail.lower(), f"不该把上游英文原文漏给用户：{leaked}"


def test_preconsume_quota_error_on_multi_frame_is_chinese_502(monkeypatch):
    created = _capture_temp_files(monkeypatch)

    async def _boom(abs_paths, prompt, provider_id, model, ms_model="", max_tokens=0,
                    timeout_seconds=None):
        raise main.HTTPException(status_code=402, detail=(
            "upstream rejected: failed to pre-consume quota, current balance: $3.148456"))

    monkeypatch.setattr(main, "caption_images_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 4, "provider": "test",
    })

    assert resp.status_code == 502, resp.text
    assert resp.json()["detail"] == main.CANVAS_ANALYZE_QUOTA_DETAIL
    assert len(created) == 4 and all(not os.path.exists(path) for path in created), "额度失败也要删干净临时文件"


# ── 只出分镜表（2026-11-25 第七轮）────────────────────────────────────────────


def test_table_only_template_has_no_four_section_requirements():
    prompt = main.CANVAS_ANALYZE_VIDEO_TABLE_ONLY_PROMPT
    assert '"shots":[' in prompt, "只出表格模板必须要求输出 shots"
    assert "3–20 行" in prompt and "中英混排可接受" in prompt
    # 整条视频每个镜头都要覆盖（服务端抽帧后镜头数可能多于前端传的帧数）
    assert "覆盖整条视频的每一个镜头" in prompt
    assert "镜号从 \"1\" 连续递增" in prompt
    assert "各镜时长相加要≈整段视频时长" in prompt
    # 帧数与镜头数要相称，别把多个镜头合并成一行
    assert "镜头数要与给出的帧数 / 画面变化程度相称" in prompt
    assert "每一帧属于哪个镜头要交代清楚" in prompt
    # 不再要 prompt 块 / 四段文本
    assert "cnPos" not in prompt
    assert '"prompt":{"cnPos"' not in prompt
    assert "[中文正向]" not in prompt
    assert "不要输出提示词四段" in prompt
    # 不带 duration 时就是常量原文；带 duration 时前面仍加那句时长说明
    assert main.canvas_analyze_video_prompt(0, 3, table_only=True) == prompt
    with_duration = main.canvas_analyze_video_prompt(12.3, 3, table_only=True)
    assert with_duration.startswith("这段视频整段约 12.3 秒，共给出 3 帧，按时间顺序排列。")
    assert with_duration.endswith(prompt)


def test_table_only_video_returns_empty_text_and_storyboard_table(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder(calls, reply=_JSON_REPLY))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "kind": "video", "duration": 12.3,
        "table_only": True, "provider": "test", "model": "",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"] == "", "table_only 时不返回四段文本"
    assert body["table"]["columns"] == _EXPECTED_COLUMNS
    assert len(body["table"]["rows"]) == 3
    assert body["table"]["rows"][0][0] == "1"
    # 模型收到的是「只出表格」模板（带 duration 前缀句）
    saved_prompt = calls[0]["prompt"]
    assert saved_prompt == main.canvas_analyze_video_prompt(12.3, 3, table_only=True)
    assert '"shots":[' in saved_prompt and "cnPos" not in saved_prompt
    assert "[中文正向]" not in saved_prompt
    assert calls[0]["max_tokens"] == main.CANVAS_ANALYZE_MAX_TOKENS


def test_table_only_false_keeps_current_four_sections(monkeypatch):
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder([], reply=_JSON_REPLY))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"] == _EXPECTED_FOUR_SECTIONS, "缺省 table_only=false 行为不变"
    assert len(body["table"]["rows"]) == 3


def test_table_only_non_json_reply_falls_back_to_raw_text(monkeypatch):
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder([], reply=_REPLY))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 3, "kind": "video", "table_only": True, "provider": "test",
    })

    assert resp.status_code == 200, f"{resp.text}（table_only 解析失败也要 200，不抛 502）"
    body = resp.json()
    assert body["text"] == _REPLY.strip()
    assert body["table"] is None


def test_table_only_on_image_path_is_ignored(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_image_with_provider",
                        _fake_caption_recorder(calls, reply=_json_reply(shots=[_JSON_SHOTS[0]])))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "image": _PNG_DATA_URL, "table_only": True, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # 图片路径忽略 table_only：仍用图片模板、仍返回四段文本、table 恒为 null
    assert calls[0]["prompt"] == main.CANVAS_ANALYZE_PROMPT
    assert body["text"] == _EXPECTED_FOUR_SECTIONS
    assert body["table"] is None


# ── 整条视频服务端抽帧（2026-11-25 第八轮）──────────────────────────────────


def _fake_ffmpeg_runner(records, scene_count=3, even_count=8, scene_times=None):
    """桩掉真实 ffmpeg：记录命令、造假帧文件，并用 showinfo 格式的 stderr 给出场景帧时间。"""
    def _run(args, timeout=180):
        records.append(list(args))
        vf = args[args.index("-vf") + 1]
        pattern = args[-1]
        if "select=" in vf:
            count, prefix = scene_count, "scene"
            times = (scene_times if scene_times is not None
                     else [round(0.5 + index, 3) for index in range(count)])
        else:
            count = min(int(even_count), int(args[args.index("-frames:v") + 1]))
            prefix = "even"
            times = []
        for index in range(count):
            path = pattern % (index + 1)
            with open(path, "wb") as f:
                f.write(prefix.encode("ascii") + b"-frame-%02d" % (index + 1))
        stderr = "\n".join(
            f"[Parsed_showinfo_1 @ 0x0] n:{index} pts_time:{times[index]}"
            for index in range(min(len(times), count)))
        return True, stderr
    return _run


def test_scene_threshold_is_015_and_min_frames_guarantee():
    assert main.CANVAS_ANALYZE_SCENE_THRESHOLD == 0.15, "缓变镜头 0.3 会把多个镜头并掉（实测 4 帧）"
    assert main.CANVAS_ANALYZE_MIN_FRAMES == 8
    vf = main.canvas_analyze_scene_filter()
    assert "gt(scene,0.15)" in vf and "showinfo" in vf


def test_video_extraction_uses_scene_filter_and_returns_frames_in_time_order(monkeypatch):
    records = []
    monkeypatch.setattr(main, "ffmpeg_binary", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(main, "probe_video_file_duration_seconds", lambda path: 12.5)
    monkeypatch.setattr(main, "canvas_analyze_run_ffmpeg",
                        _fake_ffmpeg_runner(records, scene_count=10))
    dirs = []
    real_mkdtemp = tempfile.mkdtemp

    def _record_mkdtemp(*args, **kwargs):
        path = real_mkdtemp(*args, **kwargs)
        dirs.append(path)
        return path

    monkeypatch.setattr(tempfile, "mkdtemp", _record_mkdtemp)

    urls, duration = main.canvas_analyze_video_frames("/tmp/not-really-a-video.mp4")

    assert duration == 12.5
    assert len(urls) == 10, "关键帧 >= 8 时不再等距补齐"
    assert len(records) == 1
    first = records[0]
    vf = first[first.index("-vf") + 1]
    assert "select=" in vf and "scene" in vf and "0.15" in vf, "要用 0.15 的场景切换检测"
    assert "showinfo" in vf, "要拿到 scene 帧的 pts_time 才能和等距帧按时间合并"
    assert "896" in vf and "force_original_aspect_ratio=decrease" in vf, "视频抽帧长边降到 896"
    assert first[first.index("-q:v") + 1] == "4", "JPEG 质量用 -q:v 4"
    assert first[first.index("-frames:v") + 1] == "12", "视频抽帧最多 12 帧"
    assert main.CANVAS_ANALYZE_VIDEO_MAX_FRAMES == 12
    assert first[-1].endswith("scene_%04d.jpg")
    decoded = [base64.b64decode(url.split(",", 1)[1]) for url in urls]
    assert decoded == [b"scene-frame-%02d" % index for index in range(1, 11)], "按时间顺序"
    assert dirs and all(not os.path.exists(path) for path in dirs), "抽帧临时目录必须删"


def test_scene_frames_less_than_eight_merges_even_frames_in_time_order(monkeypatch):
    records = []
    monkeypatch.setattr(main, "ffmpeg_binary", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(main, "probe_video_file_duration_seconds", lambda path: 8.0)
    monkeypatch.setattr(main, "canvas_analyze_run_ffmpeg",
                        _fake_ffmpeg_runner(records, scene_count=4, even_count=8,
                                            scene_times=[0.5, 1.5, 2.5, 3.5]))
    dirs = []
    real_mkdtemp = tempfile.mkdtemp

    def _record_mkdtemp(*args, **kwargs):
        path = real_mkdtemp(*args, **kwargs)
        dirs.append(path)
        return path

    monkeypatch.setattr(tempfile, "mkdtemp", _record_mkdtemp)

    urls, duration = main.canvas_analyze_video_frames("/tmp/not-really-a-video.mp4")

    assert duration == 8.0
    assert len(urls) == 12, "4 张关键帧不足 8 张 -> 再等距抽 8 帧并合并"
    assert len(records) == 2
    even = records[1]
    vf = even[even.index("-vf") + 1]
    assert vf.startswith("fps=1.000000"), "8 帧 / 8 秒 = 每秒 1 帧"
    assert even[even.index("-frames:v") + 1] == "8"
    assert even[-1].endswith("even_%04d.jpg")
    decoded = [base64.b64decode(url.split(",", 1)[1]) for url in urls]
    # 等距帧时间 0,1,2…7；场景帧 0.5,1.5,2.5,3.5 -> 按时间交错
    assert decoded == [
        b"even-frame-01", b"scene-frame-01", b"even-frame-02", b"scene-frame-02",
        b"even-frame-03", b"scene-frame-03", b"even-frame-04", b"scene-frame-04",
        b"even-frame-05", b"even-frame-06", b"even-frame-07", b"even-frame-08",
    ]
    assert dirs and all(not os.path.exists(path) for path in dirs), "补齐路径也要删临时文件"


def test_merged_frames_never_exceed_twelve(monkeypatch):
    records = []
    monkeypatch.setattr(main, "ffmpeg_binary", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(main, "probe_video_file_duration_seconds", lambda path: 8.0)
    monkeypatch.setattr(main, "canvas_analyze_run_ffmpeg",
                        _fake_ffmpeg_runner(records, scene_count=7, even_count=8,
                                            scene_times=[0.2 + index for index in range(7)]))

    urls, duration = main.canvas_analyze_video_frames("/tmp/not-really-a-video.mp4")

    assert duration == 8.0
    assert len(urls) == 12, "7 张关键帧 + 补齐 5 张 = 12 帧（视频上限 12）"
    even = records[1]
    assert even[even.index("-frames:v") + 1] == "5", "补齐帧数 = min(8, 12 - 已有帧数)"
    decoded = [base64.b64decode(url.split(",", 1)[1]) for url in urls]
    assert decoded[0] == b"even-frame-01" and decoded[1] == b"scene-frame-01"
    assert len(decoded) == 12


def test_video_url_route_uses_server_frames_ignores_images_and_cleans_video_temp(monkeypatch, tmp_path):
    video_file = tmp_path / "clip.mp4"
    video_file.write_bytes(b"fake-video-bytes")
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder(calls, reply=_JSON_REPLY))

    async def _source(url):
        return str(video_file), str(video_file)

    monkeypatch.setattr(main, "canvas_analyze_video_source", _source)
    frames = ["data:image/jpeg;base64," + base64.b64encode(b"server-frame-%d" % i).decode("ascii")
              for i in range(3)]
    monkeypatch.setattr(main, "canvas_analyze_video_frames", lambda path: (frames, 8.0))

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "video_url": "/assets/input/clip.mp4",
        "images": [_PNG_DATA_URL],           # 有 video_url 时应当被忽略
        "table_only": True,
        "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"] == ""
    assert len(body["table"]["rows"]) == 3
    assert len(calls[0]["paths"]) == 3, "用服务端抽的 3 帧，不用 images"
    assert calls[0]["prompt"].startswith("这段视频整段约 8 秒，共给出 3 帧，按时间顺序排列。"), \
        "没传 duration 时用 ffprobe 探到的时长"
    assert calls[0]["prompt"] == main.canvas_analyze_video_prompt(8.0, 3, table_only=True)
    assert calls[0]["timeout_seconds"] == main.CANVAS_ANALYZE_SLOW_SECONDS, "视频第一次请求带 100s 超时"
    assert not video_file.exists(), "视频临时文件必须在请求结束后删掉"


def test_video_url_unresolvable_falls_back_to_images(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_image_with_provider", _fake_caption_recorder(calls))

    async def _should_not_extract(path):
        raise AssertionError("video_url 解析不了时不该抽帧")

    monkeypatch.setattr(main, "canvas_analyze_video_frames", _should_not_extract)

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "video_url": "/assets/does-not-exist.mp4",
        "image": _PNG_DATA_URL,
        "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    assert len(calls) == 1
    assert calls[0]["prompt"] == main.CANVAS_ANALYZE_PROMPT


# ── 帧体积预算 / 网关失败重试（2026-11-25 第十一轮）──────────────────────────


class _StubHTTPResponse:
    def __init__(self, status_code, body="", payload=None):
        self.status_code = status_code
        self.text = body
        self._payload = payload

    def raise_for_status(self):
        if self.status_code >= 400:
            request = httpx.Request("POST", "http://stub.local/v1/chat/completions")
            raise httpx.HTTPStatusError(f"HTTP {self.status_code}", request=request, response=self)

    def json(self):
        return self._payload


def _install_chat_sequence(monkeypatch, responses):
    requests, sleeps = [], []

    class _FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, headers=None, json=None):
            requests.append(json)
            return responses.pop(0)

    async def _sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(main.httpx, "AsyncClient", _FakeClient)
    monkeypatch.setattr(main.asyncio, "sleep", _sleep)
    monkeypatch.setattr(main, "resolve_chat_provider",
                        lambda *args, **kwargs: ("http://stub.local/v1", {}, "gpt-4o"))
    monkeypatch.setattr(main, "get_api_provider", lambda *args, **kwargs: {})
    monkeypatch.setattr(main, "image_path_to_data_url",
                        lambda path, max_size=1024: "data:image/png;base64,AA==")
    return requests, sleeps


def test_budget_keep_indices_drops_alternating_and_keeps_first_last():
    keep = main.canvas_analyze_budget_keep_indices([100] * 16, 450)
    assert keep[0] == 0 and keep[-1] == 15, "必须保留首帧与末帧"
    assert keep == sorted(keep)
    assert len(keep) < 16


def test_frame_budget_downgrades_then_drops_frames_and_logs(monkeypatch, capsys, tmp_path):
    paths = []
    for index in range(16):
        path = tmp_path / f"scene_{index + 1:04d}.jpg"
        path.write_bytes(b"x" * 10)
        paths.append(str(path))
    monkeypatch.setattr(main, "CANVAS_ANALYZE_MAX_TOTAL_B64", 4 * 1024 * 1024)
    monkeypatch.setattr(
        main, "canvas_analyze_b64_size",
        lambda path: 300 * 1024 if os.path.basename(path).startswith("frame_") else 600 * 1024)

    def _reencode(path, out_path, max_edge, quality):
        with open(out_path, "wb") as f:
            f.write(b"y")
        return out_path

    monkeypatch.setattr(main, "canvas_analyze_reencode_jpeg", _reencode)

    result = main.canvas_analyze_apply_frame_budget(paths, str(tmp_path))

    out = capsys.readouterr().out
    assert "帧体积预算：帧数=9" in out
    assert "原始总字节=9830400" in out
    assert "最终总字节=2764800" in out
    assert "降档次数=2" in out
    assert len(result) == 9, "16 帧 4.8MB -> 重编后仍超 -> 隔帧丢到 9 帧"
    assert result[0].endswith("frame_0001.jpg") and result[-1].endswith("frame_0016.jpg")
    assert result[1].endswith("frame_0003.jpg")


def test_gateway_failure_retries_once_then_succeeds(monkeypatch, capsys):
    responses = [
        _StubHTTPResponse(502, body="<html><body>Bad Gateway</body></html>"),
        _StubHTTPResponse(200, payload={"choices": [{"message": {"content": "OK"}}]}),
    ]
    requests, sleeps = _install_chat_sequence(monkeypatch, responses)

    text, model = asyncio.run(main.caption_images_with_provider(["/tmp/x.png"], "反推", "", ""))

    assert text == "OK" and model == "gpt-4o"
    assert len(requests) == 2, "网关类失败要重试一次"
    assert sleeps == [1.5]
    out = capsys.readouterr().out
    assert "[canvas-analyze-media] 上游 HTTP 502" in out
    assert "Bad Gateway" in out, "上游 body 前段要留在日志里"


def test_gateway_failure_retries_only_once_and_reports_status(monkeypatch, capsys):
    responses = [
        _StubHTTPResponse(504, body="<html>gateway timeout</html>"),
        _StubHTTPResponse(504, body="<html>gateway timeout</html>"),
    ]
    requests, sleeps = _install_chat_sequence(monkeypatch, responses)

    with pytest.raises(main.HTTPException) as caught:
        asyncio.run(main.caption_images_with_provider(["/tmp/x.png"], "反推", "", ""))

    assert len(requests) == 2, "只重试一次"
    assert sleeps == [1.5]
    assert caught.value.status_code == 504
    detail = main.canvas_analyze_error_detail(caught.value)
    assert detail == "上游网关报错 HTTP 504（不是模型接口的正常响应）：请稍后重试，或换一个视觉模型。"
    assert "<html" not in detail and "gateway timeout" not in detail.lower()


def test_non_gateway_error_is_not_retried(monkeypatch):
    responses = [_StubHTTPResponse(400, body='{"error":"bad request"}')]
    requests, sleeps = _install_chat_sequence(monkeypatch, responses)

    with pytest.raises(main.HTTPException):
        asyncio.run(main.caption_images_with_provider(["/tmp/x.png"], "反推", "", ""))

    assert len(requests) == 1
    assert sleeps == []


def test_non_html_502_detail_keeps_status_code():
    exc = main.HTTPException(status_code=502, detail="上游接口错误：HTTP 502：upstream overloaded")
    detail = main.canvas_analyze_error_detail(exc)
    assert "HTTP 502" in detail


def test_empty_upstream_reply_is_logged_shape(monkeypatch, capsys):
    responses = [_StubHTTPResponse(200, payload={"choices": []})]
    _install_chat_sequence(monkeypatch, responses)

    text, _model = asyncio.run(main.caption_images_with_provider(["/tmp/x.png"], "反推", "", ""))

    assert text == "接口返回了空回复。"
    out = capsys.readouterr().out
    assert "[canvas-analyze-media] 上游返回空内容" in out
    assert '"choices": []' in out


# ── 12 帧上限 / 慢请求降级 8 帧 640（2026-11-25 第十二轮）───────────────────


def test_video_frame_cap_and_slow_constants():
    assert main.CANVAS_ANALYZE_VIDEO_MAX_FRAMES == 12
    assert main.CANVAS_ANALYZE_SCENE_MAX_FRAMES == 12
    assert main.CANVAS_ANALYZE_MIN_FRAMES == 8
    assert main.CANVAS_ANALYZE_SLOW_SECONDS == 100
    assert main.CANVAS_ANALYZE_FALLBACK_FRAMES == 8
    assert main.CANVAS_ANALYZE_FALLBACK_MAX_EDGE == 640


def test_pick_even_paths_keeps_first_and_last():
    paths = [f"/tmp/frame-{index}.jpg" for index in range(12)]
    picked = main.canvas_analyze_pick_even_paths(paths, 8)
    assert len(picked) == 8
    assert picked[0] == paths[0] and picked[-1] == paths[-1]
    assert picked == [paths[index] for index in sorted({round(i * 11 / 7) for i in range(8)})]


def test_fallback_builder_resizes_to_eight_frames_at_640(tmp_path):
    sources = []
    for index in range(12):
        path = tmp_path / f"src_{index:02d}.jpg"
        Image.new("RGB", (896, 500), (index * 20 % 255, 80, 160)).save(path, format="JPEG", quality=90)
        sources.append(str(path))

    temps, total = main.canvas_analyze_build_fallback_frames(sources)
    try:
        assert len(temps) == 8
        assert total > 0
        for path in temps:
            with Image.open(path) as img:
                assert max(img.size) <= 640
    finally:
        for path in temps:
            os.remove(path)


def test_fallback_builder_cleans_temp_files_on_failure(monkeypatch, tmp_path):
    source = tmp_path / "src.jpg"
    Image.new("RGB", (100, 100), (10, 20, 30)).save(source, format="JPEG")

    def _boom(*args, **kwargs):
        raise OSError("reencode failed")

    monkeypatch.setattr(main, "canvas_analyze_reencode_jpeg", _boom)
    before = set(Path(tempfile.gettempdir()).glob("canvas_analyze_small_*"))

    with pytest.raises(OSError):
        main.canvas_analyze_build_fallback_frames([str(source)])

    after = set(Path(tempfile.gettempdir()).glob("canvas_analyze_small_*"))
    assert after == before, "降级重编失败也要删掉已写的临时文件"


def _patch_video_caption(monkeypatch, fake):
    monkeypatch.setattr(main, "caption_images_with_provider", fake)


def test_slow_video_request_degrades_to_eight_640(monkeypatch, capsys):
    monkeypatch.setattr(main, "CANVAS_ANALYZE_SLOW_SECONDS", 0.0)
    calls = []

    async def _fake(paths, prompt, provider_id, model, ms_model="", max_tokens=0, timeout_seconds=None):
        calls.append({"paths": list(paths), "timeout": timeout_seconds})
        if len(calls) == 1:
            await asyncio.sleep(0.01)
            return "第一次太慢的文本", "model-a"
        return "降级成功", "model-b"

    fallback = [f"/tmp/canvas-fallback-{index}.jpg" for index in range(8)]
    monkeypatch.setattr(main, "canvas_analyze_build_fallback_frames",
                        lambda paths, **kwargs: (fallback, 123456))
    _patch_video_caption(monkeypatch, _fake)

    text, used_model = asyncio.run(main.canvas_analyze_caption_video_with_fallback(
        ["/tmp/full-1.jpg"], "反推", "", ""))

    assert text == "降级成功" and used_model == "model-b"
    assert len(calls) == 2, "慢请求只降级重试一次"
    assert calls[0]["paths"] == ["/tmp/full-1.jpg"]
    assert calls[1]["paths"] == fallback, "降级请求要用 8 张 640 帧"
    assert calls[0]["timeout"] == 0.0 and calls[1]["timeout"] == 0.0
    out = capsys.readouterr().out
    assert "第一次耗时=" in out and "进入降级=True" in out
    assert "降级帧数=8" in out and "降级总字节=123456" in out and "最终耗时=" in out


def test_empty_reply_triggers_degrade(monkeypatch):
    calls = []

    async def _fake(paths, prompt, provider_id, model, ms_model="", max_tokens=0, timeout_seconds=None):
        calls.append(list(paths))
        if len(calls) == 1:
            return "接口返回了空回复。", "model-a"
        return "降级后的文本", "model-b"

    monkeypatch.setattr(main, "canvas_analyze_build_fallback_frames",
                        lambda paths, **kwargs: ([f"/tmp/small-{index}.jpg" for index in range(8)], 100))
    _patch_video_caption(monkeypatch, _fake)

    text, used_model = asyncio.run(main.canvas_analyze_caption_video_with_fallback(
        ["/tmp/full.jpg"], "反推", "", ""))

    assert text == "降级后的文本" and used_model == "model-b"
    assert len(calls) == 2


def test_gateway_error_triggers_degrade_then_success(monkeypatch):
    calls = []

    async def _fake(paths, prompt, provider_id, model, ms_model="", max_tokens=0, timeout_seconds=None):
        calls.append(list(paths))
        if len(calls) == 1:
            raise main.HTTPException(502, "上游接口错误：HTTP 502：<html>bad gateway</html>")
        return "网关重试成功", "model-b"

    monkeypatch.setattr(main, "canvas_analyze_build_fallback_frames",
                        lambda paths, **kwargs: ([f"/tmp/small-{index}.jpg" for index in range(8)], 100))
    _patch_video_caption(monkeypatch, _fake)

    text, _model = asyncio.run(main.canvas_analyze_caption_video_with_fallback(
        ["/tmp/full.jpg"], "反推", "", ""))

    assert text == "网关重试成功"
    assert len(calls) == 2, "502/HTML 要降级重试一次"


def test_both_attempts_fail_raises_more_informative_error(monkeypatch):
    calls = []

    async def _fake(paths, prompt, provider_id, model, ms_model="", max_tokens=0, timeout_seconds=None):
        calls.append(list(paths))
        if len(calls) == 1:
            raise main.HTTPException(502, "上游接口错误：HTTP 502：<html>gateway</html>")
        raise main.HTTPException(400, "第二次的详细错误：请求里图片太多，网关拒绝处理。" + "请减少帧数后再试。" * 5)

    monkeypatch.setattr(main, "canvas_analyze_build_fallback_frames",
                        lambda paths, **kwargs: ([f"/tmp/small-{index}.jpg" for index in range(8)], 100))
    _patch_video_caption(monkeypatch, _fake)

    with pytest.raises(main.HTTPException) as caught:
        asyncio.run(main.canvas_analyze_caption_video_with_fallback(["/tmp/full.jpg"], "反推", "", ""))

    assert len(calls) == 2
    assert caught.value.status_code == 400, "两次都失败要选信息量更大的第二次"
    assert "第二次的详细错误" in str(caught.value.detail)


def test_more_informative_error_prefers_longer_detail():
    first = main.HTTPException(502, "短错误")
    second = main.HTTPException(400, "更长的错误详情" * 5)
    assert main.canvas_analyze_more_informative_error(first, second) is second
    assert main.canvas_analyze_more_informative_error(second, first) is second
    assert main.canvas_analyze_more_informative_error(None, first) is first


# —— 分镜模板（「更多 › 解析设置」）：template 给了就按模板列出表，带起止时间与首帧截图 ——

_TEMPLATE_REPLY = json.dumps({"shots": [
    {"no": "1", "start": 0, "end": 1.5, "dur": "", "desc": "红色画面", "shotSize": "全景",
     "camera": "正面", "move": "固定", "prompt": "red", "motion": "static"},
    {"no": "2", "start": 1.5, "end": 3, "dur": "1.5s", "desc": "蓝色画面", "shotSize": "特写",
     "camera": "俯拍", "move": "缓推", "prompt": "blue", "motion": "push in"},
]}, ensure_ascii=False)


def _make_two_color_video(path):
    ffmpeg = main.ffmpeg_binary()
    if not ffmpeg:
        pytest.skip("没有 ffmpeg")
    import subprocess
    subprocess.run([
        ffmpeg, "-hide_banner", "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=c=red:s=320x180:d=1.5:r=10",
        "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=1.5:r=10",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]",
        "-pix_fmt", "yuv420p", str(path),
    ], check=True)


def test_template_prompt_lists_template_keys_and_frame_times():
    prompt = main.canvas_analyze_template_prompt("storyboard", 3.0, 2, [0.0, 1.5])
    assert prompt.startswith("这段视频整段约 3 秒，共给出 2 帧，按时间顺序排列。")
    assert "各帧在原视频里的时间点（秒）依次是：0、1.5。" in prompt
    for key in ("\"start\"", "\"end\"", "\"camera\"", "\"move\"", "\"motion\""):
        assert key in prompt
    # 首帧 / 起止由后端填，不让模型写
    assert "\"first\"" not in prompt and "\"range\"" not in prompt
    lite = main.canvas_analyze_template_prompt("lite", 0, 2)
    assert "\"camera\"" not in lite and "\"move\"" in lite
    assert main.canvas_analyze_template_name("ECOM") == "ecom"
    assert main.canvas_analyze_template_name("nope") == ""


def test_shot_times_fill_gaps_from_duration_and_clamp():
    times = main.canvas_analyze_shot_times([
        {"start": 0, "end": 2},
        {"dur": "3s"},            # 没给起止：接上一镜，按时长累加
        {"start": "6", "end": 99},  # 超出整段时长：夹到 7
    ], duration=7)
    assert times == [(0.0, 2.0), (2.0, 5.0), (6.0, 7.0)]


def test_template_table_columns_range_and_duration():
    table = main.canvas_analyze_template_table(json.loads(_TEMPLATE_REPLY), "storyboard", 3.0)
    assert table["columns"][:4] == ["镜号", "首帧", "起止", "时长"]
    assert "机位" in table["columns"] and "运镜" in table["columns"]
    first, second = table["rows"]
    assert first[2] == "0.0–1.5s" and first[3] == "1.5s", "时长缺了按起止算"
    assert second[table["columns"].index("机位")] == "俯拍"
    assert second[table["columns"].index("运镜")] == "缓推"
    assert table["starts"] == [0.0, 1.5]


def test_template_video_url_returns_first_frames_from_real_video(monkeypatch, tmp_path):
    video = tmp_path / "two.mp4"
    _make_two_color_video(video)
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder(calls, reply=_TEMPLATE_REPLY))

    async def _source(url):
        return str(video), ""

    monkeypatch.setattr(main, "canvas_analyze_video_source", _source)
    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "video_url": "/assets/input/two.mp4", "kind": "video", "table_only": True,
        "template": "storyboard", "provider": "test",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["template"] == "storyboard"
    assert body["text"] == ""
    table = body["table"]
    assert "starts" not in table, "内部用的开始时间不往外吐"
    at = table["columns"].index("首帧")
    urls = [row[at] for row in table["rows"]]
    assert all(url.startswith("/output/storyboard_frames/") for url in urls), urls
    colors = []
    for url in urls:
        path = main.output_file_from_url(url)
        assert path and os.path.getsize(path) > 0
        with Image.open(path) as img:
            r, g, b = img.convert("RGB").getpixel((10, 10))
        colors.append("red" if r > b else "blue")
    assert colors == ["red", "blue"], "每镜首帧要按开始时间截"
    assert "时间点（秒）依次是" in calls[0]["prompt"]


def test_template_with_frontend_frames_has_empty_first_frames(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider",
                        _fake_images_caption_recorder(calls, reply=_TEMPLATE_REPLY))
    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 2, "kind": "video", "duration": 3,
        "template": "lite", "provider": "test",
    })
    assert resp.status_code == 200, resp.text
    table = resp.json()["table"]
    assert table["columns"] == ["镜号", "首帧", "起止", "画面描述", "景别", "运镜", "分镜提示词"]
    assert [row[1] for row in table["rows"]] == ["", ""], "没有视频文件就不截首帧"
    assert resp.json()["text"] == "", "给了模板就按只出表格走"
