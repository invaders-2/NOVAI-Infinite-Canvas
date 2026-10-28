"""视频编辑任务输入视频 4 秒下限：短素材在本地拦下，不发上游。

用户真实报错：content[2].video_url 只有 2.5 秒，视频编辑要求输入视频 4~30 秒，
请求发到火山才回一段看不懂的参数错误。
只拦编辑目标视频（prompt 含编辑关键词，或前端显式 role=video/edit/target）；
普通参考视频（动作参考等）不拦，探不到时长（远程 URL）也跳过。
"""
import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

VOLC_PROVIDER = {
    "id": "volcengine",
    "name": "火山引擎",
    "protocol": "volcengine",
    "base_url": "https://ark.cn-beijing.volces.com",
    "use_proxy": "off",
}
EDIT_PROMPT = "把视频里的鞋子替换成新款白鞋"
TARGET_VIDEO = [{"url": "/assets/input/short.mp4", "role": "video"}]


class _ReachedNextStep(Exception):
    """走到时长校验之后的下一步：证明这次没有被拦。"""


class _FakeClient:
    """不联网的 AsyncClient；正常拦截路径不该走到 post。"""

    def __init__(self):
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def post(self, url, headers=None, json=None):
        self.posts.append({"url": url, "body": json})
        raise AssertionError("这一步不应该发请求")


def _prepare(monkeypatch, prompt, videos, duration):
    client = _FakeClient()
    monkeypatch.setattr(main, "get_api_provider", lambda provider_id: dict(VOLC_PROVIDER))
    monkeypatch.setattr(main, "provider_env_key_value", lambda provider_id: "sk-unit-test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr(main, "probe_local_video_duration_seconds", lambda value: duration)
    payload = main.CanvasVideoRequest(
        prompt=prompt,
        provider_id="volcengine",
        model="doubao-seedance-2-0-fast-260128",
        duration=5,
        aspect_ratio="16:9",
        videos=videos,
    )
    return client, payload


def _stop_after_duration_check(monkeypatch):
    def _raise(value):
        raise _ReachedNextStep()

    monkeypatch.setattr(main, "volcengine_mute_video", _raise)


def test_edit_video_25s_raises_400_before_submit(monkeypatch):
    client, payload = _prepare(monkeypatch, EDIT_PROMPT, TARGET_VIDEO, 2.5)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main._canvas_video_run_unlimited(payload))
    exc = exc_info.value
    assert exc.status_code == 400
    assert "4" in exc.detail
    assert "2.5" in exc.detail
    assert "视频编辑" in exc.detail
    assert "首帧" in exc.detail
    assert client.posts == [], "拦截必须发生在发请求之前"


def test_explicit_role_target_also_counts_as_edit_task(monkeypatch):
    client, payload = _prepare(monkeypatch, "生成视频", [{"url": "/assets/input/short.mp4", "role": "target"}], 2.0)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main._canvas_video_run_unlimited(payload))
    assert exc_info.value.status_code == 400
    assert "2.0" in exc_info.value.detail
    assert client.posts == []


def test_edit_video_40s_passes(monkeypatch):
    _stop_after_duration_check(monkeypatch)
    client, payload = _prepare(monkeypatch, EDIT_PROMPT, TARGET_VIDEO, 4.0)
    with pytest.raises(_ReachedNextStep):
        asyncio.run(main._canvas_video_run_unlimited(payload))
    assert client.posts == []


def test_unknown_duration_skips_check(monkeypatch):
    _stop_after_duration_check(monkeypatch)
    client, payload = _prepare(monkeypatch, EDIT_PROMPT, [{"url": "https://cdn.example/remote.mp4", "role": "video"}], None)
    with pytest.raises(_ReachedNextStep):
        asyncio.run(main._canvas_video_run_unlimited(payload))
    assert client.posts == []


def test_plain_reference_video_is_not_blocked(monkeypatch):
    _stop_after_duration_check(monkeypatch)
    client, payload = _prepare(monkeypatch, "生成视频", [{"url": "/assets/input/action.mp4", "role": "reference"}], 2.5)
    with pytest.raises(_ReachedNextStep):
        asyncio.run(main._canvas_video_run_unlimited(payload))
    assert client.posts == []


@pytest.mark.parametrize("duration,is_edit_target", [(4.0, True), (6.0, True), (None, True), (2.5, False), (3.9, False)])
def test_helper_allows(duration, is_edit_target):
    main.ensure_volcengine_edit_video_duration(duration, is_edit_target)


def test_helper_detail_states_the_three_facts():
    with pytest.raises(HTTPException) as exc_info:
        main.ensure_volcengine_edit_video_duration(3.4, True)
    detail = exc_info.value.detail
    assert exc_info.value.status_code == 400
    assert "这是视频编辑任务" in detail
    assert "4~30 秒" in detail
    assert "3.4 秒" in detail
    assert "建议改用首帧/参考图生视频" in detail
