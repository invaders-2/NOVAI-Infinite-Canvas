# -*- coding: utf-8 -*-
"""SSE 不被 gzip 缓冲（starlette 0.41.3 回归）。

本机 starlette 0.41.3 的 GZipMiddleware 只判断 Accept-Encoding，没有 content-type 排除表：
浏览器默认带 gzip，text/event-stream 会被 zlib 攒到缓冲满/流结束才吐，逐字流式直接失效。
SSEExemptGZipMiddleware 按响应 content-type 放行 SSE，其余响应保持原压缩行为。
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if not os.environ.get("NOVAI_DATA_DIR"):
    os.environ["NOVAI_DATA_DIR"] = tempfile.mkdtemp(prefix="novai-sse-gzip-")

import main  # noqa: E402

GZIP_HEADERS = {"Accept-Encoding": "gzip, deflate, br"}
BIG_TEXT = "压缩测试" * 400


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

    @app.get("/sse-with-charset")
    async def sse_with_charset():
        async def gen():
            yield "event: heartbeat\ndata: {}\n\n"
        # 部分平台/中间件会补 charset，判断时必须先剥掉参数
        return StreamingResponse(gen(), media_type="text/event-stream; charset=utf-8")

    @app.get("/big.json")
    async def big_json():
        return JSONResponse({"text": BIG_TEXT})

    @app.get("/small.json")
    async def small_json():
        return JSONResponse({"ok": True})

    return app


def _client():
    from starlette.testclient import TestClient
    # TestClient 默认带 Accept-Encoding: gzip，正好还原浏览器行为
    return TestClient(_build_app())


def test_sse_is_not_gzipped_for_browser_requests():
    with _client() as client:
        resp = client.get("/sse", headers=GZIP_HEADERS)
        assert resp.status_code == 200
        assert resp.headers.get("content-encoding") is None, "SSE 被 gzip 会攒到流结束才吐"
        assert resp.headers.get("content-type", "").startswith("text/event-stream")
        assert resp.text.count("event: heartbeat") == 3


def test_sse_with_charset_is_not_gzipped():
    with _client() as client:
        resp = client.get("/sse-with-charset", headers=GZIP_HEADERS)
        assert resp.headers.get("content-encoding") is None


def test_sse_response_start_passes_through_immediately():
    """start 必须在 app 发完第一条 start 后就到客户端，不能等 body（缓冲的判据）。"""
    sent = []
    seen = {}

    async def app(scope, receive, send):
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/event-stream; charset=utf-8")],
        })
        seen["after_start"] = len(sent)
        await send({"type": "http.response.body", "body": b"data: 1\n\n", "more_body": True})
        await send({"type": "http.response.body", "body": b"data: 2\n\n", "more_body": False})

    async def send(message):
        sent.append(message)

    middleware = main.SSEExemptGZipMiddleware(app, minimum_size=1024, compresslevel=4)
    scope = {"type": "http", "headers": [(b"accept-encoding", b"gzip")]}
    asyncio.run(middleware(scope, None, send))

    assert seen["after_start"] == 1, "start 被缓存住了：客户端会等到第一条 body 才拿到响应头"
    assert [m["type"] for m in sent] == [
        "http.response.start", "http.response.body", "http.response.body"]
    assert b"content-encoding" not in b"".join(
        name + value for name, value in sent[0]["headers"])
    assert sent[1]["body"] == b"data: 1\n\n" and sent[2]["body"] == b"data: 2\n\n"


def test_big_json_is_still_gzipped():
    with _client() as client:
        resp = client.get("/big.json", headers=GZIP_HEADERS)
        assert resp.headers.get("content-encoding") == "gzip", "普通大 JSON 仍要压缩省带宽"
        assert resp.json()["text"] == BIG_TEXT


def test_small_json_is_not_compressed():
    with _client() as client:
        resp = client.get("/small.json", headers=GZIP_HEADERS)
        assert resp.headers.get("content-encoding") is None, "小于 minimum_size 不付压缩成本"


def test_client_without_gzip_gets_plain_body():
    with _client() as client:
        resp = client.get("/big.json", headers={"Accept-Encoding": "identity"})
        assert resp.headers.get("content-encoding") is None
        assert resp.json()["text"] == BIG_TEXT
