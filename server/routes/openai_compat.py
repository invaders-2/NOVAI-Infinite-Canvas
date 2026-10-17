#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenAI 兼容模型端点：让 OpenClaw（或任何 OpenAI 客户端）把 NOVAI 当供应商用。

    GET  /v1/models
    POST /v1/chat/completions          （stream 与非 stream）

鉴权：Authorization: Bearer <NOVAI_MODEL_API_KEY>（只读环境变量，不硬编码）。

供应商解析与响应解析全部复用 main.py（通过 server.routes.deps 注入），本模块只负责
OpenAI 请求/响应与上游 SSE 的搬运，不另建一套 provider 体系。
"""
from __future__ import annotations

import hmac
import json
import os
import time
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from server.routes.deps import deps

router = APIRouter()

# 只有这几种协议的 provider 下游也是 OpenAI /chat/completions 形状，可直接当供应商暴露
EXPOSABLE_PROTOCOLS = ("", "openai", "volcengine", "gemini")


def _api_key() -> str:
    return (os.environ.get("NOVAI_MODEL_API_KEY") or "").strip()


def _check_auth(authorization: str) -> None:
    expected = _api_key()
    if not expected:
        raise HTTPException(status_code=503, detail="未配置 NOVAI_MODEL_API_KEY，OpenAI 兼容端点不可用")
    raw = str(authorization or "").strip()
    token = raw[7:].strip() if raw.lower().startswith("bearer ") else ""
    if not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid API key", headers={"WWW-Authenticate": "Bearer"})


def _load_providers() -> List[Dict[str, Any]]:
    loader = deps.get("load_api_providers")
    if loader is None:
        raise HTTPException(status_code=503, detail="NOVAI provider 模块未初始化")
    providers = loader()
    return [p for p in providers if isinstance(p, dict)]


def _usable_providers() -> List[Dict[str, Any]]:
    result = []
    for provider in _load_providers():
        if not provider.get("enabled", True):
            continue
        protocol = str(provider.get("protocol") or "").strip().lower()
        if protocol not in EXPOSABLE_PROTOCOLS:
            continue
        if protocol == "gemini":
            continue
        if not provider.get("chat_models"):
            continue
        result.append(provider)
    return result


def _default_provider_id(providers: List[Dict[str, Any]]) -> str:
    """裸模型名要用哪个平台。只认显式配置或项目既有 primary，不静默取列表里的第一个平台。"""
    configured = (os.environ.get("NOVAI_MODEL_DEFAULT_PROVIDER") or "").strip()
    if configured:
        return configured
    primary = deps.get("get_primary_provider_id")
    if primary is not None and providers:
        try:
            resolved = str(primary(providers) or "").strip()
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail="无法确定 NOVAI 默认平台：读取项目首选平台失败（%s）。请设置 NOVAI_MODEL_DEFAULT_PROVIDER。" % exc,
            ) from exc
        if resolved:
            return resolved
    raise HTTPException(
        status_code=503,
        detail="未指定 NOVAI 默认平台：请设置 NOVAI_MODEL_DEFAULT_PROVIDER=<平台 id>，"
               "或在 API 设置里把某个平台勾选为首选（primary）；也可以直接用 <平台>/<模型> 指定模型。",
    )


def _resolve_target(model: str) -> Tuple[str, str]:
    """把 OpenAI 的 model 字段解析成 (provider_id, model_id)。

    支持 "<provider>"、"<provider>/<model>"；裸模型名则回退默认 provider。
    """
    providers = _usable_providers()
    if not providers:
        raise HTTPException(status_code=503, detail="没有可用的 NOVAI 聊天平台（需已配置密钥与 chat_models）")
    ids = [str(p.get("id")) for p in providers]
    raw = str(model or "").strip()
    provider_id = ""
    model_id = raw
    if "/" in raw:
        head, tail = raw.split("/", 1)
        if head in ids:
            provider_id, model_id = head, tail
    elif raw in ids:
        provider_id, model_id = raw, ""
    if not provider_id:
        provider_id = _default_provider_id(providers)
        model_id = raw
    if provider_id not in ids:
        raise HTTPException(
            status_code=404,
            detail="未知的 NOVAI 模型：%s（解析到的平台「%s」不在可用平台里；可用平台：%s）"
                   % (raw or "(empty)", provider_id, "、".join(ids)),
        )
    return provider_id, model_id


def _resolve_upstream(provider_id: str, model_id: str) -> Tuple[str, Dict[str, str], str]:
    resolver = deps.get("resolve_chat_provider")
    if resolver is None:
        raise HTTPException(status_code=503, detail="NOVAI provider 解析未初始化")
    try:
        base, headers, model = resolver(provider_id, model_id, "")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail="解析 NOVAI 上游平台失败：%s" % exc) from exc
    return base, headers, model


def _upstream_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        http2=False,
        verify=deps.get("_SSL_CONTEXT", True),
        trust_env=bool(deps.get("_TRUST_ENV", False)),
        timeout=float(deps.get("AI_REQUEST_TIMEOUT", 1800.0)),
    )


def _normalize_messages(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="messages 不能为空")
    normalized: List[Dict[str, Any]] = []
    for item in messages:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "user")
        content = item.get("content")
        message: Dict[str, Any] = {"role": role, "content": content}
        if item.get("tool_calls"):
            message["tool_calls"] = item.get("tool_calls")
        if item.get("tool_call_id"):
            message["tool_call_id"] = item.get("tool_call_id")
        if item.get("name"):
            message["name"] = item.get("name")
        normalized.append(message)
    if not normalized:
        raise HTTPException(status_code=400, detail="messages 里没有有效消息")
    return normalized


def _completion_text(raw: Any) -> str:
    extract = deps.get("text_from_chat_response")
    if extract is None:
        return ""
    return str(extract(raw) or "")


def _completion_reasoning(raw: Any) -> str:
    extract = deps.get("reasoning_from_chat_response")
    if extract is None:
        return ""
    try:
        return str(extract(raw) or "")
    except Exception:
        return ""


def _unwrap(raw: Any) -> Any:
    unwrap = deps.get("unwrap_apimart_response")
    if unwrap is None or not isinstance(raw, dict):
        return raw
    return unwrap(raw)


def _first_choice(data: Any) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return {}
    return choices[0]


def _completion_tool_calls(raw: Any) -> List[Dict[str, Any]]:
    """上游返回的 tool_calls 原样透传：OpenClaw 就是靠它才能真的调用工具。

    不透传会让模型只回一句空正文、OpenClaw 判定 Agent 无响应（实测 agnes-2.5-flash
    直接调用时 finish_reason=tool_calls，经本端点转发后 tools 全被丢掉）。
    """
    choice = _first_choice(_unwrap(raw))
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    tool_calls = message.get("tool_calls")
    return [c for c in tool_calls if isinstance(c, dict)] if isinstance(tool_calls, list) else []


def _completion_finish_reason(raw: Any, has_tool_calls: bool = False) -> str:
    choice = _first_choice(_unwrap(raw))
    reason = str(choice.get("finish_reason") or "").strip()
    if reason:
        return reason
    return "tool_calls" if has_tool_calls else "stop"


def _usage(raw: Any) -> Dict[str, Any]:
    data = _unwrap(raw)
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    return usage


def _chunk(model: str, delta: Dict[str, Any], finish_reason: Optional[str] = None) -> str:
    body = {
        "id": "chatcmpl-novai",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    return "data: %s\n\n" % json.dumps(body, ensure_ascii=False)


@router.get("/v1/models")
async def list_models(authorization: str = Header(default="")) -> Dict[str, Any]:
    _check_auth(authorization)
    created = int(time.time())
    data: List[Dict[str, Any]] = []
    for provider in _usable_providers():
        provider_id = str(provider.get("id"))
        data.append({"id": provider_id, "object": "model", "created": created, "owned_by": "novai"})
        for model_id in provider.get("chat_models") or []:
            data.append({
                "id": "%s/%s" % (provider_id, model_id),
                "object": "model",
                "created": created,
                "owned_by": "novai",
            })
    return {"object": "list", "data": data}


@router.post("/v1/chat/completions")
async def chat_completions(request: Request, authorization: str = Header(default="")):
    _check_auth(authorization)
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="请求体不是合法 JSON：%s" % exc) from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")

    messages = _normalize_messages(payload)
    provider_id, requested_model = _resolve_target(payload.get("model"))
    base, headers, model = _resolve_upstream(provider_id, requested_model)
    stream = bool(payload.get("stream"))
    body: Dict[str, Any] = {"model": model, "messages": messages}
    if payload.get("temperature") is not None:
        body["temperature"] = payload.get("temperature")
    if payload.get("top_p") is not None:
        body["top_p"] = payload.get("top_p")
    if payload.get("max_tokens") is not None:
        body["max_tokens"] = payload.get("max_tokens")
    if payload.get("tools"):
        body["tools"] = payload.get("tools")
    if payload.get("tool_choice") is not None:
        body["tool_choice"] = payload.get("tool_choice")

    if stream:
        body["stream"] = True
        return StreamingResponse(_stream_upstream(base, headers, model, body), media_type="text/event-stream")

    is_apimart = deps.get("is_apimart_provider")
    if is_apimart is not None:
        try:
            if is_apimart(deps.get("get_api_provider", lambda _x: {})(provider_id)):
                body["stream"] = False
        except Exception:
            pass

    try:
        async with _upstream_client() as client:
            response = await client.post("%s/chat/completions" % base, headers=headers, json=body)
            response.raise_for_status()
            raw = response.json()
    except httpx.HTTPStatusError as exc:
        detail = (exc.response.text or "")[:500]
        raise HTTPException(status_code=exc.response.status_code, detail="上游接口错误：%s" % detail) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="请求上游接口失败：%s" % exc) from exc

    text = _completion_text(raw)
    tool_calls = _completion_tool_calls(raw)
    message: Dict[str, Any] = {"role": "assistant", "content": text}
    reasoning = _completion_reasoning(raw)
    if reasoning:
        message["reasoning_content"] = reasoning
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "id": "chatcmpl-%s" % uuid.uuid4().hex,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message,
                     "finish_reason": _completion_finish_reason(raw, bool(tool_calls))}],
        "usage": _usage(raw),
    }


async def _stream_upstream(base: str, headers: Dict[str, str], model: str, body: Dict[str, Any]) -> AsyncIterator[str]:
    text_delta = deps.get("text_delta_from_chat_chunk")
    reasoning_delta = deps.get("reasoning_delta_from_chat_chunk")
    finish_reason = "stop"
    yield _chunk(model, {"role": "assistant", "content": ""})
    try:
        async with _upstream_client() as client:
            async with client.stream("POST", "%s/chat/completions" % base, headers=headers, json=body) as response:
                if response.status_code >= 400:
                    raw = await response.aread()
                    detail = raw.decode("utf-8", errors="ignore")[:500]
                    error = {"error": {"message": "上游接口错误：%s" % detail, "type": "upstream_error"}}
                    yield "data: %s\n\n" % json.dumps(error, ensure_ascii=False)
                    yield "data: [DONE]\n\n"
                    return
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if line == "[DONE]":
                        break
                    try:
                        chunk = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    delta: Dict[str, Any] = {}
                    content = str(text_delta(chunk) or "") if text_delta is not None else ""
                    if content:
                        delta["content"] = content
                    if reasoning_delta is not None:
                        thought = str(reasoning_delta(chunk) or "")
                        if thought:
                            delta["reasoning_content"] = thought
                    choice = _first_choice(chunk)
                    tool_calls = choice.get("delta", {}).get("tool_calls") if isinstance(choice.get("delta"), dict) else None
                    if isinstance(tool_calls, list) and tool_calls:
                        delta["tool_calls"] = [c for c in tool_calls if isinstance(c, dict)]
                    reason = str(choice.get("finish_reason") or "").strip()
                    if reason:
                        finish_reason = reason
                    if delta:
                        yield _chunk(model, delta)
    except httpx.HTTPError as exc:
        error = {"error": {"message": "请求上游接口失败：%s" % exc, "type": "upstream_error"}}
        yield "data: %s\n\n" % json.dumps(error, ensure_ascii=False)
        yield "data: [DONE]\n\n"
        return
    yield _chunk(model, {}, finish_reason=finish_reason)
    yield "data: [DONE]\n\n"
