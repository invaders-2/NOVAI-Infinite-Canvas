# -*- coding: utf-8 -*-
"""画布「解析」接口 /api/canvas-analyze-media：data URL 落临时文件、超大拒绝、模型只吐 JSON 时
由后端拼四段 text + 12 列分镜表、视频多帧走视频专用模板、模型选择启发式。

全部离线：视觉模型调用被打桩，不发任何网络请求；图片源只走 data URL。
"""
import asyncio
import base64
import json
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
    async def _fake(abs_path, prompt, provider_id, model_arg, ms_model="", max_tokens=0):
        calls.append({
            "path": abs_path,
            "prompt": prompt,
            "provider": provider_id,
            "model": model_arg,
            "max_tokens": max_tokens,
            "exists_during_call": os.path.exists(abs_path),
            "size": os.path.getsize(abs_path) if os.path.exists(abs_path) else -1,
        })
        return reply, model
    return _fake


def _fake_images_caption_recorder(calls, reply=_VIDEO_REPLY, model="vision-mock"):
    async def _fake(abs_paths, prompt, provider_id, model_arg, ms_model="", max_tokens=0):
        paths = list(abs_paths)
        calls.append({
            "paths": paths,
            "prompt": prompt,
            "provider": provider_id,
            "model": model_arg,
            "max_tokens": max_tokens,
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
    async def _boom(abs_path, prompt, provider_id, model, ms_model="", max_tokens=0):
        raise main.HTTPException(
            status_code=502, detail="上游接口错误：<html><body>FORBIDDEN</body></html>")

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 502, resp.text
    detail = resp.json()["detail"]
    assert "<html" not in detail and "FORBIDDEN" not in detail
    assert detail == "上游返回的是网关错误页，不是模型接口的正常响应：请稍后重试，或换一个视觉模型。"


def test_upstream_rate_limit_becomes_chinese_502(monkeypatch):
    async def _boom(abs_path, prompt, provider_id, model, ms_model="", max_tokens=0):
        raise main.HTTPException(status_code=429, detail="429 rate limit exceeded")

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 502, resp.text
    assert "限流" in resp.json()["detail"]


def test_upstream_400_keeps_400_and_chinese_detail(monkeypatch):
    async def _boom(abs_path, prompt, provider_id, model, ms_model="", max_tokens=0):
        raise main.HTTPException(status_code=400, detail="未配置 test 的 API Key，请在 API 平台管理中填写。")

    monkeypatch.setattr(main, "caption_image_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "未配置 test 的 API Key，请在 API 平台管理中填写。"


def test_image_prompt_template_asks_for_json_only():
    # 模板改成「只输出一个 JSON」：四段标记不再由模型吐，改由后端拼 text
    assert main.canvas_analyze_prompt(False) == main.CANVAS_ANALYZE_PROMPT
    assert "只输出一个 JSON 对象" in main.CANVAS_ANALYZE_PROMPT
    for key in ('"prompt"', '"shots"', '"cnPos"', '"cnNeg"', '"enPos"', '"enNeg"',
                '"no"', '"dur"', '"desc"', '"char"', '"charDesc"', '"shotSize"',
                '"mood"', '"light"', '"audio"', '"line"', '"prompt"', '"motion"'):
        assert key in main.CANVAS_ANALYZE_PROMPT, f"JSON 结构里应声明 {key}"
    assert "这一张画面只给 1 行" in main.CANVAS_ANALYZE_PROMPT
    assert "注意：这是视频的一帧" not in main.CANVAS_ANALYZE_PROMPT
    assert "[中文正向]" not in main.CANVAS_ANALYZE_PROMPT
    # 视频一帧的旧说明仍在（is_video_frame=true 时还会再追加一行）
    assert "按静态画面反推，不要描述镜头运动" in main.CANVAS_ANALYZE_PROMPT


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


def test_eight_frames_is_accepted_and_temp_files_all_removed(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider", _fake_images_caption_recorder(calls))
    created = _capture_temp_files(monkeypatch)

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 8, "provider": "test",
    })

    assert resp.status_code == 200, resp.text
    assert len(calls[0]["paths"]) == 8
    assert len(created) == 8
    assert all(not os.path.exists(path) for path in created)


def test_more_than_eight_frames_is_400(monkeypatch):
    calls = []
    monkeypatch.setattr(main, "caption_images_with_provider", _fake_images_caption_recorder(calls))
    created = _capture_temp_files(monkeypatch)

    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 9, "provider": "test",
    })

    assert resp.status_code == 400, resp.text
    assert "一次最多 8 帧" in resp.json()["detail"]
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


def test_image_json_reply_has_single_storyboard_row(monkeypatch):
    calls = []
    reply = _json_reply(shots=[_JSON_SHOTS[0]], prompt=_JSON_PROMPT)
    monkeypatch.setattr(main, "caption_image_with_provider",
                        _fake_caption_recorder(calls, reply=reply))

    resp = CLIENT.post("/api/canvas-analyze-media", json={"image": _PNG_DATA_URL, "provider": "test"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"] == _EXPECTED_FOUR_SECTIONS
    assert body["table"]["columns"] == _EXPECTED_COLUMNS
    assert len(body["table"]["rows"]) == 1
    assert body["table"]["rows"][0][0] == "1"
    assert body["table"]["rows"][0][10] == "红裙女孩走向橱窗，中景"


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
    async def _boom(abs_path, prompt, provider_id, model, ms_model="", max_tokens=0):
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

    async def _boom(abs_paths, prompt, provider_id, model, ms_model="", max_tokens=0):
        raise main.HTTPException(status_code=402, detail=(
            "upstream rejected: failed to pre-consume quota, current balance: $3.148456"))

    monkeypatch.setattr(main, "caption_images_with_provider", _boom)
    resp = CLIENT.post("/api/canvas-analyze-media", json={
        "images": [_PNG_DATA_URL] * 4, "provider": "test",
    })

    assert resp.status_code == 502, resp.text
    assert resp.json()["detail"] == main.CANVAS_ANALYZE_QUOTA_DETAIL
    assert len(created) == 4 and all(not os.path.exists(path) for path in created), "额度失败也要删干净临时文件"
