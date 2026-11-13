"""动作复刻 / 换产品：火山直连时参考图和参考视频不能被丢掉或降级。

用户反馈「深度动作捕捉复刻视频，换产品效果很差」。查下来火山直连有两处会把素材悄悄丢掉：
  1. 智能画布BEAT 的参考图 role 是 "reference"，以前认不出 → 只取第一张当首帧，
     白底产品图变成视频第一帧，其余参考图（人物 / 第二张产品图）直接丢；
  2. 参考视频只有提示词里带「替换 / 编辑」才整段提交，否则被抽成 4 张静帧当参考图，
     动作和运镜全丢，深度通道视频还会把灰度画面带进成片。
另外动作迁移模板以前写「仅替换动作、其余一切保持不变」，从不提产品，用户要求还被截到 200 字。
"""
import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

VOLC_PROVIDER = {
    "id": "volcengine",
    "name": "火山引擎",
    "protocol": "volcengine",
    "base_url": "https://ark.cn-beijing.volces.com",
    "use_proxy": "off",
}
PERSON = "https://cdn.example/person.png"
PRODUCT = "https://cdn.example/product.png"
CLIP = "https://cdn.example/motion.mp4"


class _Submitted(Exception):
    pass


class _FakeClient:
    def __init__(self):
        self.bodies = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def post(self, url, headers=None, json=None, **kwargs):
        self.bodies.append(json)
        raise _Submitted()


def _run(monkeypatch, prompt, images, videos, model="doubao-seedance-2-0-fast-260128", mode=""):
    client = _FakeClient()
    monkeypatch.setattr(main, "get_api_provider", lambda provider_id: dict(VOLC_PROVIDER))
    monkeypatch.setattr(main, "provider_env_key_value", lambda provider_id: "sk-unit-test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr(main, "probe_local_video_duration_seconds", lambda value: 6.0)
    monkeypatch.setattr(main, "volcengine_mute_video", lambda value: value)

    async def _frames(value, max_frames=6, max_size=768):
        return [f"data:image/jpeg;base64,frame{i}" for i in range(max_frames)]

    monkeypatch.setattr(main, "video_reference_to_frame_data_urls", _frames)
    payload = main.CanvasVideoRequest(
        prompt=prompt, provider_id="volcengine", model=model, duration=5, aspect_ratio="16:9",
        images=images, videos=videos, mode=mode,
    )
    with pytest.raises(BaseException):
        asyncio.run(main._canvas_video_run_unlimited(payload))
    assert client.bodies, "应该走到提交上游这一步"
    return client.bodies[0]


def _items(body, kind):
    return [c for c in body["content"] if c.get("type") == kind]


def test_beat_reference_images_all_kept_as_reference_image(monkeypatch):
    body = _run(monkeypatch, "模特拿着产品走向镜头",
                [{"url": PERSON, "role": "reference"}, {"url": PRODUCT, "role": "reference"}], [])
    images = _items(body, "image_url")
    assert [i["role"] for i in images] == ["reference_image", "reference_image"], \
        "画布参考图不能被当成首帧，也不能只留第一张"


def test_reference_video_role_submits_full_video_not_frames(monkeypatch):
    body = _run(monkeypatch, "按参考视频的动作，模特拿着产品",
                [{"url": PERSON, "role": "reference"}, {"url": PRODUCT, "role": "reference"}],
                [{"url": CLIP, "role": "reference_video"}], model="doubao-seedance-1-0-lite")
    videos = _items(body, "video_url")
    assert len(videos) == 1 and videos[0]["role"] == "reference_video", "参考视频要整段提交，不能抽成静帧"
    assert not any("frame" in str(i["image_url"]["url"]) for i in _items(body, "image_url"))
    assert len(_items(body, "image_url")) == 2, "参考图（人物 + 产品）都要保留"


def test_explicit_reference_video_mode_submits_full_video(monkeypatch):
    body = _run(monkeypatch, "复刻这个动作", [], [CLIP], model="doubao-seedance-1-0-lite",
                mode="reference_video_to_video")
    assert len(_items(body, "video_url")) == 1


def test_seedance2_reference_video_never_downgraded_to_frames(monkeypatch):
    body = _run(monkeypatch, "复刻这个动作", [], [CLIP])
    assert len(_items(body, "video_url")) == 1
    assert _items(body, "image_url") == []


def test_legacy_model_without_hints_still_uses_frames(monkeypatch):
    """老模型、没有任何「参考视频」信号：保持原来的抽帧行为，不扩大影响面。"""
    body = _run(monkeypatch, "生成视频", [], [CLIP], model="doubao-seedance-1-0-lite")
    assert _items(body, "video_url") == []
    assert len(_items(body, "image_url")) == 4


def test_motion_transfer_prompt_mentions_product_and_keeps_user_text():
    note = "图片1 是新模特，图片2 是新产品保温杯，把视频1里手上的旧杯子换成图片2。" + "细节" * 300
    text = main.agent_motion_transfer_prompt(note, 2, 1)
    assert text.startswith("任务：图片1 是新模特"), "用户要求放最前"
    assert len(text) > 600, "用户要求不能再被截到 200 字"
    assert "产品" in text and "logo" in text
    assert "图片1、图片2" in text and "视频1" in text
    assert "仅替换动作" not in text, "不能再告诉模型除了动作什么都别换"
    # 带「替换 / 换成」关键词：火山侧按编辑类整段提交参考视频、参考图全部保留
    assert main.is_volcengine_edit_prompt(text)
