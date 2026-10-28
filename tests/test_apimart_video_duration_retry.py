"""APIMart 视频：上游对 duration 的合法区间比本地能力表更严时，按报错自愈一次。

用户真实报错（MiniMax-H3-Max）：
  {"error":{"code":"invalid_request","message":"MiniMax-H3-Max duration must be an integer
   between 5 and 15 seconds; got 4","param":"","type":"invalid_request"}}
本地能力表把 H3-Max 写成 4-15，4 秒被原样放行 → 上游 400。这里守三层：
  * 能力表本身改 5-15（纵深防御，见 test_apimart_video_params 的同口径表）；
  * 从上游文案抠出 (low, high) 并把 body 的 duration 夹进区间，同一个 body 原样重试一次
    （图片已经上传好，不重新上传、不重复建视频）；
  * 只重试一次，非时长类 400 一律不重试。
全部离线：假 client / 假上传 / 假落盘，不联网、不真的生成视频。
"""
import asyncio
import copy
import sys
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

REAL_ERROR_TEXT = (
    '{"error":{"code":"invalid_request",'
    '"message":"MiniMax-H3-Max duration must be an integer between 5 and 15 seconds; got 4",'
    '"param":"","type":"invalid_request"}}'
)
SUBMIT_URL = "https://apib.ai/v1/videos/generations"
PROVIDER = {"id": "apimart", "name": "APIMART", "base_url": "https://apib.ai", "use_proxy": "off"}


class _FakeClient:
    """按顺序回放预置响应；记录每次提交的 body，用来看第二次提交的 duration 和重试次数。"""

    def __init__(self, responses):
        self._responses = list(responses)
        self.posts = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def post(self, url, headers=None, json=None):
        self.posts.append({"url": url, "headers": headers, "body": copy.deepcopy(json)})
        return self._responses.pop(0)


def _response(status, payload=None, text=None):
    request = httpx.Request("POST", SUBMIT_URL)
    if text is not None:
        return httpx.Response(status, text=text, request=request,
                              headers={"Content-Type": "application/json"})
    return httpx.Response(status, json=payload, request=request)


def _run_video(monkeypatch, responses, model="minimax-h3", duration=4):
    """跑真实的 _canvas_video_run_unlimited（APIMart 分支），只把网络、上传、落盘换成桩。"""
    client = _FakeClient(responses)
    uploads = []

    async def fake_upload(client_obj, provider, url, *args, **kwargs):
        uploads.append(url)
        return "https://cdn.example/ref.png"

    async def fake_save(url, prefix="video_", category="output"):
        return "/output/video_stub.mp4"

    monkeypatch.setenv("API_PROVIDER_APIMART_KEY", "sk-unit-test")
    monkeypatch.setattr(main, "get_api_provider", lambda provider_id: dict(PROVIDER))
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr(main, "upload_image_for_apimart", fake_upload)
    monkeypatch.setattr(main, "save_remote_video_to_output", fake_save)
    payload = main.CanvasVideoRequest(
        prompt="逐帧动画测试",
        provider_id="apimart",
        model=model,
        duration=duration,
        aspect_ratio="16:9",
        images=[main.AIReference(url="data:image/png;base64,AAAA", role="first_frame")],
    )
    result = asyncio.run(main._canvas_video_run_unlimited(payload))
    return client, uploads, result


def test_parse_real_upstream_error_text():
    assert main.apimart_video_duration_error_bounds(REAL_ERROR_TEXT) == (5, 15)


def test_parse_is_case_insensitive():
    text = '{"error":{"message":"DURATION MUST BE AN INTEGER BETWEEN 5 AND 15 SECONDS; GOT 4"}}'
    assert main.apimart_video_duration_error_bounds(text) == (5, 15)


def test_parse_ignores_other_400_bodies():
    assert main.apimart_video_duration_error_bounds('{"error":{"message":"image url is not accessible"}}') is None
    assert main.apimart_video_duration_error_bounds("") is None
    assert main.apimart_video_duration_error_bounds(None) is None


@pytest.mark.parametrize("value,expected", [(4, 5), (20, 15), (7, 7), ("abc", 5), (None, 5), ("6", 6)])
def test_clamp_into_upstream_range(value, expected):
    assert main.apimart_video_duration_clamp(value, 5, 15) == expected


def test_retry_body_returns_false_when_already_in_range():
    body = {"duration": 7}
    assert main.apimart_video_duration_retry_body(body, REAL_ERROR_TEXT) is False
    assert body["duration"] == 7


def test_general_branch_retries_once_with_clamped_duration(monkeypatch, capsys):
    client, uploads, result = _run_video(monkeypatch, [
        _response(400, text=REAL_ERROR_TEXT),
        _response(200, {"videos": ["https://cdn.example/out.mp4"]}),
    ])
    assert result["videos"] == ["/output/video_stub.mp4"]
    assert len(client.posts) == 2, "时长被拒应当只重试一次"
    assert client.posts[0]["body"]["duration"] == 4
    assert client.posts[1]["body"]["duration"] == 5, "第二次提交的 duration 必须夹到上游下限 5"
    assert [post["url"] for post in client.posts] == [SUBMIT_URL, SUBMIT_URL]
    assert len(uploads) == 1, "重试复用已上传好的图片，不能再上传一次"
    assert "[apimart-video] duration 4 被上游拒绝，按上游区间 5-15 自动改为 5 重试" in capsys.readouterr().out


def test_veo31_branch_also_gets_duration_retry(monkeypatch):
    veo_text = '{"error":{"message":"duration must be an integer between 5 and 15 seconds; got 4"}}'
    client, uploads, result = _run_video(monkeypatch, [
        _response(400, text=veo_text),
        _response(200, {"videos": ["https://cdn.example/out.mp4"]}),
    ], model="veo3.1-fast", duration=4)
    assert result["videos"] == ["/output/video_stub.mp4"]
    assert len(client.posts) == 2
    assert client.posts[0]["body"]["duration"] == 4
    assert client.posts[1]["body"]["duration"] == 5
    assert client.posts[1]["body"]["aspect_ratio"] == "16:9"
    assert len(uploads) == 1


def test_non_duration_400_is_not_retried(monkeypatch):
    text = '{"error":{"code":"invalid_request","message":"image url is not accessible from upstream"}}'
    uploads = []
    client = _FakeClient([_response(400, text=text)])

    async def fake_upload(client_obj, provider, url, *args, **kwargs):
        uploads.append(url)
        return "https://cdn.example/ref.png"

    async def fake_save(url, prefix="video_", category="output"):
        return "/output/video_stub.mp4"

    monkeypatch.setenv("API_PROVIDER_APIMART_KEY", "sk-unit-test")
    monkeypatch.setattr(main, "get_api_provider", lambda provider_id: dict(PROVIDER))
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr(main, "upload_image_for_apimart", fake_upload)
    monkeypatch.setattr(main, "save_remote_video_to_output", fake_save)
    payload = main.CanvasVideoRequest(
        prompt="逐帧动画测试", provider_id="apimart", model="minimax-h3", duration=4,
        aspect_ratio="16:9",
        images=[main.AIReference(url="data:image/png;base64,AAAA", role="first_frame")],
    )
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main._canvas_video_run_unlimited(payload))
    assert "上游视频接口错误" in str(exc_info.value.detail)
    assert len(client.posts) == 1, "非时长类 400 不许重试"
    assert len(uploads) == 1


def test_second_duration_rejection_is_not_retried_again(monkeypatch):
    first = '{"error":{"message":"duration must be an integer between 6 and 15 seconds; got 4"}}'
    second = '{"error":{"message":"duration must be an integer between 7 and 15 seconds; got 6"}}'
    client = _FakeClient([_response(400, text=first), _response(400, text=second)])
    uploads = []

    async def fake_upload(client_obj, provider, url, *args, **kwargs):
        uploads.append(url)
        return "https://cdn.example/ref.png"

    async def fake_save(url, prefix="video_", category="output"):
        return "/output/video_stub.mp4"

    monkeypatch.setenv("API_PROVIDER_APIMART_KEY", "sk-unit-test")
    monkeypatch.setattr(main, "get_api_provider", lambda provider_id: dict(PROVIDER))
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr(main, "upload_image_for_apimart", fake_upload)
    monkeypatch.setattr(main, "save_remote_video_to_output", fake_save)
    payload = main.CanvasVideoRequest(
        prompt="逐帧动画测试", provider_id="apimart", model="minimax-h3", duration=4,
        aspect_ratio="16:9",
        images=[main.AIReference(url="data:image/png;base64,AAAA", role="first_frame")],
    )
    with pytest.raises(HTTPException):
        asyncio.run(main._canvas_video_run_unlimited(payload))
    assert len(client.posts) == 2, "只允许重试一次，第二次仍被拒就原样抛出"
    assert client.posts[1]["body"]["duration"] == 6
    assert len(uploads) == 1
