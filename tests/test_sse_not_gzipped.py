# -*- coding: utf-8 -*-
"""SSE 不被 gzip 缓冲 + 流式默认开 + 心跳 2 秒。

背景（2026-11 真机排查）：starlette 0.41 的 GZipMiddleware 没有 event-stream 排除表，
SSE 一旦被压缩，zlib 要攒满缓冲才吐字节 —— run_start / 心跳 / 逐字增量全憋到流结束才到，
面板看起来就是「发了没反应」。这条回归测的就是「浏览器带 Accept-Encoding: gzip 时 SSE 也原样直出」。
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

_TMP = os.environ.get("NOVAI_DATA_DIR") or ""
if not _TMP:
    _TMP = tempfile.mkdtemp(prefix="novai-sse-gzip-")
    os.environ["NOVAI_DATA_DIR"] = _TMP

import main  # noqa: E402


def _build_app():
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse, StreamingResponse

    app = FastAPI()
    app.add_middleware(main.SSEExemptGZipMiddleware, minimum_size=1024, compresslevel=4)

    @app.get("/sse")
    async def sse():
        async def gen():
            for index in range(3):
                yield "event: heartbeat\ndata: {\"n\": %d}\n\n" % index
        return StreamingResponse(gen(), media_type="text/event-stream")

    @app.get("/big.json")
    async def big_json():
        return JSONResponse({"text": "压缩测试" * 400})

    @app.get("/small.json")
    async def small_json():
        return JSONResponse({"ok": True})

    return app


def _client():
    from starlette.testclient import TestClient
    # TestClient 默认带 Accept-Encoding: gzip，正好还原浏览器的行为
    return TestClient(_build_app())


def test_sse_is_not_gzipped_for_browser_requests():
    with _client() as client:
        resp = client.get("/sse", headers={"Accept-Encoding": "gzip, deflate, br"})
        assert resp.headers.get("content-encoding") is None, "SSE 不能被 gzip（会被攒到流结束）"
        assert "event: heartbeat" in resp.text
        assert resp.text.count("event: heartbeat") == 3


def test_sse_is_not_gzipped_by_default():
    with _client() as client:
        resp = client.get("/sse")
        assert resp.headers.get("content-encoding") is None


def test_plain_json_still_gzipped():
    with _client() as client:
        resp = client.get("/big.json", headers={"Accept-Encoding": "gzip"})
        assert resp.headers.get("content-encoding") == "gzip", "普通大 JSON 仍要压缩（省带宽）"
        assert resp.json()["text"].startswith("压缩测试")


def test_small_json_not_compressed():
    with _client() as client:
        resp = client.get("/small.json", headers={"Accept-Encoding": "gzip"})
        assert resp.headers.get("content-encoding") is None, "小于 minimum_size 的响应不压缩"


def test_client_without_gzip_gets_plain_body():
    with _client() as client:
        resp = client.get("/big.json", headers={"Accept-Encoding": "identity"})
        assert resp.headers.get("content-encoding") is None


def test_stream_enabled_by_default_and_can_be_switched_off():
    saved = os.environ.get("NOVAI_AGENT_V2_STREAM")
    try:
        os.environ.pop("NOVAI_AGENT_V2_STREAM", None)
        assert main._agent_v2_stream_enabled() is True, "未配置时流式默认打开"
        os.environ["NOVAI_AGENT_V2_STREAM"] = "0"
        assert main._agent_v2_stream_enabled() is False, "显式 0 仍能退回非流式"
        os.environ["NOVAI_AGENT_V2_STREAM"] = "1"
        assert main._agent_v2_stream_enabled() is True
    finally:
        if saved is None:
            os.environ.pop("NOVAI_AGENT_V2_STREAM", None)
        else:
            os.environ["NOVAI_AGENT_V2_STREAM"] = saved


def test_heartbeat_interval_is_two_seconds():
    assert main._AGENT_HEARTBEAT_SECONDS <= 2.0, "心跳要短到看得出在动（默认 2s）"


def test_thought_limit_widens_when_streaming_default_on():
    saved = os.environ.get("NOVAI_AGENT_V2_STREAM")
    try:
        os.environ.pop("NOVAI_AGENT_V2_STREAM", None)
        assert main._agent_thought_max_chars() == 1200, "流式默认开后思考正文放宽到 1200 字"
        os.environ["NOVAI_AGENT_V2_STREAM"] = "0"
        assert main._agent_thought_max_chars() == 300
    finally:
        if saved is None:
            os.environ.pop("NOVAI_AGENT_V2_STREAM", None)
        else:
            os.environ["NOVAI_AGENT_V2_STREAM"] = saved
