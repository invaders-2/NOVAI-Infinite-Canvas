#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""智能体 / 技能（统一「能力」）路由（契约冻结，前端按此对接）：

    GET  /api/capabilities                -> {capabilities:[{id,kind,name,category,icon,description,
                                                             tags,deliverables,enabled,available}]}
    GET  /api/capabilities/{id}           -> {capability:{...含 input_schema}}
    GET  /api/skills                      -> {skills:[...]}（等价 kind='skill'）
    GET  /api/agents                      -> {agents:[...]}（等价 kind='agent'，原字段不变）
    GET  /api/agents/{agent_id}           -> {agent:{...完整定义含 input_schema}}
    POST /api/agents/{agent_id}/run       -> multipart(form-data): file(可多个) + params(JSON 字符串)
                                             -> {run_id, session_id}
    POST /api/conversations/{conversation_id}/capabilities/{id}/run
                                          -> multipart(file 可多个 + params) 
                                             -> {run_id, conversation_id, user_message_id, assistant_message_id}
    GET  /api/agents/runs/{run_id}        -> {run:{run_id,agent_id,status,steps,artifacts,error,
                                                   created_at,updated_at,conversation_id,
                                                   capability_id,capability_name}}
    GET  /api/agents/runs/{run_id}/stream -> SSE（事件体与 /api/agent/run 完全一致）
    GET  /api/agents/runs/{run_id}/files/{name} -> 受控下载产物

运行循环复用 main.py 的 _agent_run_producer（通过 deps 注入），上下文用 FilesRunContext。
会话读写复用 main.py 的 load_conversation / save_conversation（通过 deps 注入，不另造存储）。
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from server.agents import catalog, platforms, registry, store
from server.agents.context import FilesRunContext
from server.agents.events import bus
from server.integrations import input_sources
from server.integrations import openclaw_capability
from server.integrations import video_sources
from server.skills import registry as skills_registry
from server.routes.deps import deps

router = APIRouter(prefix="/api")

# 运行中的后台任务强引用，避免被 GC
_TASKS = set()


class _BusQueue:
    """把生产循环塞进 queue 的 SSE 分片转发到事件总线（None 表示结束）。"""

    def __init__(self, run_id: str):
        self.run_id = run_id

    def put_nowait(self, chunk: Any) -> None:
        if chunk is None:
            bus.finish(self.run_id)
        else:
            bus.publish(self.run_id, chunk)


def _producer():
    fn = deps.get("AGENT_RUN_PRODUCER")
    if fn is None:
        raise HTTPException(status_code=500, detail="智能体运行时未初始化")
    return fn


def _sse(event: str, data: Dict[str, Any]) -> str:
    """与 main.py 的 _agent_sse_event 完全一致的 SSE 分片（经 deps 注入，避免循环 import）。"""
    fn = deps.get("AGENT_SSE_EVENT")
    if fn is not None:
        return fn(event, data)
    return "event: %s\ndata: %s\n\n" % (event, json.dumps(data, ensure_ascii=False))


def _capability_backend() -> str:
    """NOVAI_CAPABILITY_BACKEND=openclaw|local，默认 openclaw；local 才走原 NOVAI 循环。"""
    return openclaw_capability.backend_name()


def _has_url_input(payload: Dict[str, Any]) -> bool:
    """普通网页地址，以及报告链接/报告文件与视频链接/视频文件，都算有效输入。"""
    if openclaw_capability.extract_urls(payload):
        return True
    if input_sources.has_reference_input(payload):
        return True
    return video_sources.has_video_refs(payload)


# 这些是运行控制字段，不算「用户填了能力参数」
_CONTROL_KEYS = ("provider", "model", "ms_model", "max_steps", "url", "urls")


def _has_param_input(payload: Dict[str, Any]) -> bool:
    """能力自己的参数（如 userNeeds / brandInfo / videoType）是否填了值。

    有些能力（主图策划 / 详情页策划等）在 sealseek 侧就是「报告链接**或**用户需求」，
    只填需求也应该能跑；这个判断只用来放宽这类能力，不改变需要上传表格的能力。
    """
    for key, value in (payload or {}).items():
        if key in _CONTROL_KEYS:
            continue
        if value not in ("", None, [], {}):
            return True
    return False


def _start_openclaw_task(run_id: str, cap: Dict[str, Any], record: Dict[str, Any],
                         files: List[Dict[str, Any]], params: Dict[str, Any], on_finish=None) -> None:
    """把一次 run 交给 OpenClaw 执行；事件仍走同一事件总线，前端契约不变。"""

    def emit(event: str, data: Dict[str, Any]) -> None:
        bus.publish(run_id, _sse(event, data))

    async def _drive():
        try:
            await openclaw_capability.run(run_id, cap, record, files, params, emit)
        except asyncio.CancelledError:
            store.update_run(run_id, status="aborted", error="运行已取消")
            raise
        except Exception as exc:
            detail = "OpenClaw 能力运行异常：%s: %s" % (type(exc).__name__, exc)
            store.update_run(run_id, status="failed", error=detail, message=detail)
            emit("error", {"message": detail, "code": "openclaw_capability_exception"})
        finally:
            bus.finish(run_id)
            if on_finish is not None:
                try:
                    on_finish()
                except Exception as exc:
                    print("[Agents] run 收尾失败 %s: %s" % (run_id, exc))

    task = asyncio.create_task(_drive())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


def _decode_params(raw: Optional[str]) -> Dict[str, Any]:
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="params 不是合法 JSON：%s" % exc)
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="params 必须是 JSON 对象")
    return data


def _decode_capability(raw: Optional[str]) -> Dict[str, Any]:
    """可选字段：sealseek 形态的 capability 描述符（type / agentId / skillCode / cardType）。

    缺省 / 非法都当作没带，不阻塞运行；它只用于如实记录这次运行挂的是哪个能力。
    """
    text = str(raw or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _get_capability_or_404(capability_id: str):
    cap, kind = catalog.get_capability(capability_id)
    if not cap:
        raise HTTPException(status_code=404, detail="能力不存在")
    return cap, kind


def _ensure_runnable(cap: Dict[str, Any]) -> None:
    if not cap.get("enabled", True):
        raise HTTPException(status_code=400, detail="该能力已停用")
    if not cap.get("available", True):
        raise HTTPException(status_code=400, detail="该能力即将上线，暂不可运行")


def _save_uploads(run_id: str, files: List[UploadFile], contents: List[bytes]) -> List[Dict[str, Any]]:
    folder = store.run_uploads_dir(run_id)
    saved: List[Dict[str, Any]] = []
    used = set()
    for upload, raw in zip(files, contents):
        base = store.safe_filename(upload.filename or "", default="upload")
        name, n = base, 1
        stem, ext = base.rsplit(".", 1) if "." in base else (base, "")
        while name.lower() in used:
            n += 1
            name = "%s-%d%s" % (stem, n, ("." + ext) if ext else "")
        used.add(name.lower())
        path = _safe_join(folder, name)
        with open(path, "wb") as f:
            f.write(raw)
        saved.append({"name": name, "original": upload.filename or name, "size": len(raw)})
    return saved


def _safe_join(folder: str, name: str) -> str:
    import os
    path = os.path.abspath(os.path.join(folder, name))
    if os.path.commonpath([path, os.path.abspath(folder)]) != os.path.abspath(folder):
        raise HTTPException(status_code=400, detail="非法文件名")
    return path


def _build_instruction(agent: Dict[str, Any], files: List[Dict[str, Any]], params: Dict[str, Any]) -> str:
    names = "、".join([str(f.get("name") or "") for f in files]) or "无"
    deliverables = agent.get("deliverables") or []
    deliver_text = "、".join([str(d.get("label") or d.get("name")) for d in deliverables]) or "按技能要求"
    parts = [
        "请使用「%s」完成本次分析。" % agent.get("name"),
        "输入文件：%s。" % names,
        "本次交付物：%s。" % deliver_text,
    ]
    subject = params.get("category") or params.get("product") or params.get("productName") or \
        params.get("targetMarket") or params.get("subject")
    if subject:
        parts.append("分析对象：%s。" % subject)
    if params.get("goal"):
        parts.append("补充要求：%s。" % params.get("goal"))
    parts.append("先调用 read_table 读取真实数据，再严格按技能说明完成分析与交付文件。")
    return "\n".join(parts)


def _user_message_text(cap: Dict[str, Any], files: List[Dict[str, Any]], params: Dict[str, Any]) -> str:
    for key in ("message", "goal", "content"):
        value = params.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    names = "、".join([str(f.get("name") or "") for f in files]) or "无"
    return "使用「%s」分析上传的文件：%s" % (cap.get("name") or cap.get("id"), names)


def _message_status(record: Dict[str, Any]) -> str:
    status = str(record.get("status") or "running")
    return status if status in ("running", "ok", "failed", "aborted") else status


def _steps_for_message(record: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for step in record.get("steps") or []:
        if not isinstance(step, dict):
            continue
        ok = bool(step.get("ok"))
        summary = str(step.get("description") or "")
        if not ok and step.get("error"):
            summary = ("%s：%s" % (summary, step["error"])) if summary else str(step["error"])
        out.append({
            "index": step.get("index"),
            "tool": str(step.get("tool") or ""),
            "status": "done" if ok else "failed",
            "summary": summary,
        })
    return out


def _artifact_label(record: Dict[str, Any], artifact: Dict[str, Any]) -> str:
    cap, _kind = catalog.get_capability(record.get("capability_id") or record.get("agent_id") or "")
    for item in (cap or {}).get("deliverables") or []:
        if not isinstance(item, dict):
            continue
        if item.get("name") == artifact.get("name") or item.get("kind") == artifact.get("kind"):
            return str(item.get("label") or item.get("name") or "")
    return str(artifact.get("name") or "")


def _artifacts_for_message(record: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for item in record.get("artifacts") or []:
        if not isinstance(item, dict):
            continue
        out.append({
            "kind": str(item.get("kind") or ""),
            "name": str(item.get("name") or ""),
            "url": str(item.get("url") or ""),
            "label": str(item.get("label") or _artifact_label(record, item)),
        })
    return out


def _assistant_message_fields(record: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "capability_id": record.get("capability_id") or record.get("agent_id") or "",
        "capability_name": record.get("capability_name") or "",
        "run_id": record.get("run_id"),
        "status": _message_status(record),
        "steps": _steps_for_message(record),
        "artifacts": _artifacts_for_message(record),
        "content": str(record.get("message") or ""),
    }


def sync_conversation_message(record: Dict[str, Any]) -> None:
    """把 run 的最新状态写回会话里的助手消息（幂等；非会话 run 直接跳过）。

    复用 main.py 的 load_conversation / save_conversation（经 deps 注入），不另造存储。
    """
    if not isinstance(record, dict):
        return
    conversation_id = str(record.get("conversation_id") or "")
    message_id = str(record.get("assistant_message_id") or "")
    user_id = str(record.get("conversation_user_id") or "")
    if not (conversation_id and message_id and user_id):
        return
    load = deps.get("CONVERSATION_LOAD")
    save = deps.get("CONVERSATION_SAVE")
    if load is None or save is None:
        return
    try:
        conversation = load(user_id, conversation_id)
    except Exception:
        return
    if not isinstance(conversation, dict):
        return
    messages = conversation.get("messages")
    if not isinstance(messages, list):
        return
    fields = _assistant_message_fields(record)
    changed = False
    for message in messages:
        if not isinstance(message, dict) or message.get("id") != message_id:
            continue
        for key, value in fields.items():
            if message.get(key) != value:
                message[key] = value
                changed = True
        break
    if not changed:
        return
    try:
        save(user_id, conversation)
    except Exception as exc:
        print("[Agents] 写回会话消息失败 %s: %s" % (conversation_id, exc))


def _conversation_io():
    load = deps.get("CONVERSATION_LOAD")
    save = deps.get("CONVERSATION_SAVE")
    resolve_user = deps.get("CONVERSATION_USER_ID")
    if load is None or save is None or resolve_user is None:
        raise HTTPException(status_code=500, detail="会话运行时未初始化")
    return load, save, resolve_user


def _resolve_chat(payload: Dict[str, Any]) -> Dict[str, Any]:
    resolve_chat = deps.get("AGENT_RESOLVE_CHAT")
    if resolve_chat is None:
        raise HTTPException(status_code=500, detail="智能体运行时未初始化")
    provider = str(payload.get("provider") or "").strip()
    model = str(payload.get("model") or "").strip()
    ms_model = str(payload.get("ms_model") or "").strip()
    return resolve_chat(provider, model, ms_model)


def _build_run_request(cap: Dict[str, Any], record: Dict[str, Any], files: List[Dict[str, Any]],
                       payload: Dict[str, Any], chat: Dict[str, Any]) -> Dict[str, Any]:
    ctx = FilesRunContext(record, cap, files, payload)
    normalize_focus = deps.get("AGENT_RUN_NORMALIZE_FOCUS")
    focus = normalize_focus(None) if normalize_focus else {}
    cap_steps = int(deps.get("AGENT_RUN_MAX_STEPS_CAP") or 24)
    try:
        max_steps = int(payload.get("max_steps") or 12)
    except (TypeError, ValueError):
        max_steps = 12
    max_steps = max(1, min(max_steps, cap_steps))
    return {
        "context": ctx,
        "canvas_id": "",
        "instruction": _build_instruction(cap, files, payload),
        "focus": focus,
        "history": [],
        "chat": chat,
        "max_steps": max_steps,
        "mode": "run",
        "approved_steps": [],
        "image_provider": "",
        "image_model": "",
        "use_thread": False,
    }


def _start_run_task(run_id: str, req: Dict[str, Any], on_finish=None) -> None:
    producer = _producer()

    async def _drive():
        try:
            await producer(req, _BusQueue(run_id))
        except asyncio.CancelledError:
            store.update_run(run_id, status="aborted", error="运行已取消")
            bus.finish(run_id)
            raise
        except Exception as exc:
            store.update_run(run_id, status="failed", error="%s: %s" % (type(exc).__name__, exc))
            bus.finish(run_id)
        finally:
            if on_finish is not None:
                try:
                    on_finish()
                except Exception as exc:
                    print("[Agents] run 收尾失败 %s: %s" % (run_id, exc))

    task = asyncio.create_task(_drive())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


# --- 统一能力目录 ---

@router.get("/capabilities")
async def capabilities_list():
    return {"capabilities": catalog.list_capabilities()}


# 这两个固定段必须先于 /capabilities/{capability_id} 注册，否则会被当成能力 id
@router.get("/capabilities/platforms")
async def capabilities_platforms():
    return {"platforms": platforms.list_platforms()}


@router.get("/capabilities/suggestions")
async def capabilities_suggestions():
    return {"suggestions": catalog.list_suggestions()}


@router.get("/capabilities/{capability_id}")
async def capability_get(capability_id: str):
    cap, kind = _get_capability_or_404(capability_id)
    return {"capability": catalog.capability_detail(cap, kind)}


@router.get("/skills")
async def skills_list():
    counts = store.usage_counts()
    return {"skills": [skills_registry.public_skill(s, kind="skill", usage_count=counts.get(str(s.get("id")), 0))
                       for s in catalog.list_skills()]}


@router.post("/skills/import")
async def skills_import(data: Dict[str, Any] = Body(...)):
    """导入一份技能定义（JSON 对象）到 data/skills/{id}.json，导入后就是「我的技能」。"""
    try:
        skill, created = skills_registry.import_skill(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"skill": skills_registry.public_skill(skill, kind="skill"), "created": created}


# --- 目录：列表 / 详情 ---

@router.get("/agents")
async def agents_list():
    # skills 目录里已登记的 id（关键词找钱 / 优势找钱）不再出现在智能体目录
    return {"agents": [registry.public_agent(a) for a in catalog.list_agents()]}


# --- 运行记录（必须先于 /agents/{agent_id} 注册，避免被通用段吞掉） ---

@router.get("/agents/runs/{run_id}")
async def agent_run_get(run_id: str):
    record = store.load_run(run_id)
    if not record:
        raise HTTPException(status_code=404, detail="运行记录不存在")
    sync_conversation_message(record)
    return {"run": store.public_run(record)}


@router.get("/agents/runs/{run_id}/stream")
async def agent_run_stream(run_id: str):
    if not store.load_run(run_id):
        raise HTTPException(status_code=404, detail="运行记录不存在")
    headers = {"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
    return StreamingResponse(bus.subscribe(run_id), media_type="text/event-stream", headers=headers)


@router.get("/agents/runs/{run_id}/files/{name}")
async def agent_run_file(run_id: str, name: str):
    path = store.is_safe_output_path(run_id, name)
    if not path:
        raise HTTPException(status_code=404, detail="产物不存在")
    return FileResponse(path, filename=store.safe_filename(name))


# --- 详情 ---

@router.get("/agents/{agent_id}")
async def agent_get(agent_id: str):
    cap, _kind = catalog.get_capability(agent_id)
    if not cap:
        raise HTTPException(status_code=404, detail="智能体不存在")
    return {"agent": cap}


# --- 运行（老契约：不需要会话，原样保留） ---

@router.post("/agents/{agent_id}/run")
async def agent_run_start(agent_id: str,
                          file: List[UploadFile] = File(default=[]),
                          params: str = Form("{}")):
    cap, kind = _get_capability_or_404(agent_id)
    _ensure_runnable(cap)
    payload = _decode_params(params)
    if not file and not _has_url_input(payload):
        # 需要上传文件的的能力仍必须给文件；其余能力（报告链接或用户需求二选一）允许只用参数跑
        if catalog.required_files(cap) or not _has_param_input(payload):
            raise HTTPException(status_code=400,
                                detail="请至少上传一个输入文件（表格 / 图片 / 视频），"
                                       "或提供网址、报告链接、视频链接、能力参数")
    backend = _capability_backend()
    # OpenClaw 后端不需要 NOVAI 侧的对话模型；local 后端才解析（挑不出会 400，不静默兜底）
    chat = _resolve_chat(payload) if backend == "local" else {"provider": "openclaw", "model": ""}

    contents = []
    for upload in file:
        contents.append(await upload.read())

    session_id = store.new_session_id()
    record = store.create_run(cap["id"], session_id, files=[], params=payload,
                              provider=chat.get("provider") or "", model=chat.get("model") or "",
                              capability_id=cap["id"], capability_name=cap.get("name") or "",
                              capability_kind=kind)
    run_id = record["run_id"]
    saved = _save_uploads(run_id, file, contents)
    store.update_run(run_id, files=saved)
    record["files"] = saved

    if backend == "openclaw":
        _start_openclaw_task(run_id, cap, record, saved, payload)
    else:
        req = _build_run_request(cap, record, saved, payload, chat)
        _start_run_task(run_id, req, on_finish=lambda: sync_conversation_message(store.load_run(run_id) or {}))
    return {"run_id": run_id, "session_id": session_id}


# --- 会话作用域运行：能力在对话里跑，结果写回会话 ---

@router.post("/conversations/{conversation_id}/capabilities/{capability_id}/run")
async def conversation_capability_run(conversation_id: str, capability_id: str, request: Request,
                                      file: List[UploadFile] = File(default=[]),
                                      params: str = Form("{}"),
                                      capability: str = Form(""),
                                      x_user_id: str = Header(default="")):
    cap, kind = _get_capability_or_404(capability_id)
    _ensure_runnable(cap)
    payload = _decode_params(params)
    descriptor = _decode_capability(capability)
    if catalog.required_files(cap) and not file and not _has_url_input(payload):
        raise HTTPException(status_code=400, detail="请至少上传一个输入文件（表格 / 图片 / 视频），或提供网址、报告链接、视频链接")
    backend = _capability_backend()
    chat = _resolve_chat(payload) if backend == "local" else {"provider": "openclaw", "model": ""}
    load_conversation, save_conversation, resolve_user = _conversation_io()
    user_id = resolve_user(x_user_id, request)
    conversation = load_conversation(user_id, conversation_id)

    contents = []
    for upload in file:
        contents.append(await upload.read())

    session_id = store.new_session_id()
    record = store.create_run(cap["id"], session_id, files=[], params=payload,
                              provider=chat.get("provider") or "", model=chat.get("model") or "",
                              conversation_id=conversation_id, capability_id=cap["id"],
                              capability_name=cap.get("name") or "", capability_kind=kind,
                              conversation_user_id=user_id)
    run_id = record["run_id"]
    saved = _save_uploads(run_id, file, contents)
    store.update_run(run_id, files=saved)
    record["files"] = saved

    now = int(time.time() * 1000)
    attachments = [{"name": f.get("name"), "original": f.get("original"), "size": f.get("size")}
                   for f in saved]
    user_message = {
        "id": store.new_message_id(),
        "role": "user",
        "content": _user_message_text(cap, saved, payload),
        "attachments": attachments,
        "capability_id": cap["id"],
        "capability_name": cap.get("name") or "",
        "created_at": now,
    }
    # 可选：如前端带了 sealseek 形态的 capability 描述符，就原样留档（刷新后仍能对上挂的是哪个能力）
    if descriptor:
        user_message["capability"] = descriptor
    assistant_message = {
        "id": store.new_message_id(),
        "role": "assistant",
        "type": "capability",
        "capability_id": cap["id"],
        "capability_name": cap.get("name") or "",
        "run_id": run_id,
        "status": "running",
        "steps": [],
        "artifacts": [],
        "content": "",
        "created_at": now,
    }
    messages = conversation.get("messages")
    if not isinstance(messages, list):
        messages = []
        conversation["messages"] = messages
    if not messages:
        conversation["title"] = (cap.get("name") or "新对话")[:80]
    messages.append(user_message)
    messages.append(assistant_message)
    conversation["updated_at"] = now
    save_conversation(user_id, conversation)
    store.update_run(run_id, assistant_message_id=assistant_message["id"])

    if backend == "openclaw":
        _start_openclaw_task(run_id, cap, record, saved, payload,
                             on_finish=lambda: sync_conversation_message(store.load_run(run_id) or {}))
    else:
        req = _build_run_request(cap, record, saved, payload, chat)
        _start_run_task(run_id, req, on_finish=lambda: sync_conversation_message(store.load_run(run_id) or {}))
    return {
        "run_id": run_id,
        "conversation_id": conversation_id,
        "user_message_id": user_message["id"],
        "assistant_message_id": assistant_message["id"],
    }
