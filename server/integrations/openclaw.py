#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenClaw Gateway WebSocket 客户端 + NOVAI GPT 聊天分流 glue。

为什么是 WS 而不是 hooks：实测 OpenClaw 2026.6.9 的 POST /hooks/agent 只回
{"ok":true,"runId":...}，正文与增量只走 Gateway WS 的 chat 事件（见 README/docs）。
本模块只依赖标准库 + websockets，不引入新的 HTTP 供应商体系。

鉴权走 gateway.auth.token（loopback + client.id=gateway-client / mode=backend 的保留
backend 通道），因此不需要设备签名。任何一轮对话失败都抛明确异常，不吞。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import time
import uuid
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

try:
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:  # pragma: no cover - 运行期由 _require_websockets 抛明确错误
    websockets = None

    class ConnectionClosed(Exception):
        pass


PROTOCOL_VERSION = 4
DEFAULT_WS_URL = "ws://localhost:18789"
DEFAULT_AGENT_ID = "main"
# gateway-client/backend 是 OpenClaw 为「回环 + 共享令牌」保留的后端控制面通道，
# 只有它允许免设备身份连接；普通客户端 id 会被要求设备签名。
BACKEND_CLIENT_ID = "gateway-client"
BACKEND_CLIENT_MODE = "backend"
MAX_PAYLOAD_BYTES = 25 * 1024 * 1024
SESSION_KEY_SAFE = re.compile(r"[^A-Za-z0-9_.-]+")
DEFAULT_CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".openclaw", "openclaw.json")


def _platform_name() -> str:
    """握手上报的平台名，与 Node 的 process.platform 口径一致（win32/darwin/linux）。"""
    if os.name == "nt":
        return "win32"
    return sys.platform if sys.platform == "darwin" else "linux"


class OpenClawError(Exception):
    """OpenClaw 集成错误基类。"""


class OpenClawConfigError(OpenClawError):
    """缺少网关地址/令牌等必需配置。"""


class OpenClawConnectionError(OpenClawError):
    """连不上网关，或连接在对话中途断开。"""


class OpenClawProtocolError(OpenClawError):
    """网关返回了不符合协议的帧。"""


class OpenClawRpcError(OpenClawError):
    """网关对某个 RPC 返回 ok=false。"""

    def __init__(self, method: str, code: str, message: str) -> None:
        self.method = method
        self.code = code
        self.message = message
        super().__init__("OpenClaw RPC %s 失败: %s %s" % (method, code, message))


class OpenClawTimeoutError(OpenClawError):
    """握手、空闲或整轮等待超时。"""


class OpenClawIdleTimeoutError(OpenClawTimeoutError):
    """空闲超时：指定秒数内没收到任何网关事件（与「工具执行失败」区分开）。"""

    def __init__(self, run_id: str, idle_seconds: float, last_event: str,
                 last_tool_step: str) -> None:
        self.run_id = str(run_id or "")
        self.idle_seconds = float(idle_seconds)
        self.last_event = str(last_event or "")
        self.last_tool_step = str(last_tool_step or "")
        super().__init__(
            "OpenClaw 网关无响应：空闲 %.0fs 内没有收到任何事件"
            "（runId=%s，最后事件=%s，最后工具步骤=%s）；这不是工具执行失败。"
            % (self.idle_seconds, self.run_id, self.last_event or "无",
               self.last_tool_step or "无"))


class OpenClawRunError(OpenClawError):
    """本轮 agent run 以 error/aborted 结束。"""


def _require_websockets() -> None:
    if websockets is None:
        raise OpenClawConfigError(
            "缺少 websockets 依赖，请先执行：pip install 'websockets>=12'"
        )


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None:
        return default
    return str(value).strip()


def _env_float(name: str, default: float) -> float:
    raw = _env(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        raise OpenClawConfigError("环境变量 %s 不是数字：%s" % (name, raw))


def sanitize_session_key_part(value: str, fallback: str = "default") -> str:
    cleaned = SESSION_KEY_SAFE.sub("-", str(value or "").strip())
    cleaned = cleaned.strip("-._")
    return cleaned[:96] or fallback


NOVAI_MEDIA_BRIDGE_SUBDIR = "novai"


def openclaw_state_dir() -> str:
    """OpenClaw 状态目录：OPENCLAW_STATE_DIR（支持 ~ 展开）或默认 ~/.openclaw。"""
    override = _env("OPENCLAW_STATE_DIR")
    if override:
        return os.path.abspath(os.path.expanduser(override))
    return os.path.join(os.path.expanduser("~"), ".openclaw")


def _current_uid() -> int:
    getuid = getattr(os, "getuid", None)
    return int(getuid()) if callable(getuid) else 0


def openclaw_media_roots() -> List[str]:
    """OpenClaw 2026.6.9 buildMediaLocalRoots() 的真实本地媒体允许根目录集合。"""
    state_dir = openclaw_state_dir()
    tmpdir = _env("TMPDIR") or "/tmp"
    return [
        "/tmp/openclaw",
        os.path.join(tmpdir, "openclaw-%d" % _current_uid()),
        os.path.join(state_dir, "media"),
        os.path.join(state_dir, "canvas"),
        os.path.join(state_dir, "workspace"),
        os.path.join(state_dir, "sandboxes"),
    ]


def _writable_dir(path: str) -> bool:
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".novai-write-probe")
        with open(probe, "w", encoding="utf-8") as handle:
            handle.write("")
        os.remove(probe)
        return os.path.isdir(path)
    except OSError:
        return False


def media_bridge_root() -> str:
    """解析媒体桥接根：把模型要看的本地图片复制进该目录后 OpenClaw 才允许读取。

    优先级：NOVAI_OPENCLAW_MEDIA_ROOT → /tmp/openclaw → $TMPDIR/openclaw-<uid>
    → <OPENCLAW_STATE_DIR 或 ~/.openclaw>/media。全部不可用时返回 ""（桥接不可用）。
    """
    tmpdir = _env("TMPDIR") or "/tmp"
    candidates: List[str] = []
    override = _env("NOVAI_OPENCLAW_MEDIA_ROOT")
    if override:
        candidates.append(os.path.expanduser(override))
    candidates.append("/tmp/openclaw")
    candidates.append(os.path.join(tmpdir, "openclaw-%d" % _current_uid()))
    candidates.append(os.path.join(openclaw_state_dir(), "media"))
    for candidate in candidates:
        if _writable_dir(candidate):
            # 不能 realpath：macOS 上 /tmp 是 /private/tmp 的符号链接，换成
            # /private/... 就不再落在 OpenClaw 的字面允许根 /tmp/openclaw 之下。
            return os.path.abspath(candidate)
    return ""


def _media_relative_name(source: str, base_dir: str) -> str:
    resolved = os.path.abspath(source)
    base = os.path.abspath(str(base_dir or ""))
    if base:
        try:
            rel = os.path.relpath(resolved, base)
        except ValueError:
            rel = ""
        if rel and rel != os.curdir and not rel.startswith(os.pardir + os.sep) \
                and not os.path.isabs(rel):
            return rel
    return os.path.basename(resolved)


def _copy_media_if_changed(source: str, dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.isfile(dest) and os.path.getsize(dest) == os.path.getsize(source):
        return
    shutil.copyfile(source, dest)


def bridge_run_media(run_id: str, media_paths: List[str],
                     base_dir: str = "") -> Dict[str, Any]:
    """把本次 run 要看的本地图片复制到 <桥接根>/novai/<run_id>/...，保持相对路径与文件名。

    fail-soft：单个文件出错只记进 failed（原路径照用），不抛异常、不让整次运行失败；
    幂等：目标已存在且大小一致就跳过。
    """
    paths: List[str] = []
    for item in media_paths or []:
        text = str(item or "")
        if text and text not in paths:
            paths.append(text)
    result: Dict[str, Any] = {"root": "", "mapped": {}, "failed": []}
    root = media_bridge_root()
    if not root:
        for path in paths:
            result["failed"].append({"path": path, "error": "桥接根不可用"})
        return result
    result["root"] = root
    target_dir = os.path.join(root, NOVAI_MEDIA_BRIDGE_SUBDIR,
                              sanitize_session_key_part(run_id, "run"))
    for path in paths:
        if not os.path.isfile(path):
            result["failed"].append({"path": path, "error": "源文件不存在"})
            continue
        dest = os.path.join(target_dir, _media_relative_name(path, base_dir))
        try:
            _copy_media_if_changed(path, dest)
        except OSError as exc:
            result["failed"].append({
                "path": path, "error": "%s: %s" % (type(exc).__name__, exc)})
            continue
        result["mapped"][path] = dest
    return result


def _tool_step_label(data: Dict[str, Any]) -> str:
    """空闲超时文案用的「最后工具步骤」：工具名 + 阶段 + 关键参数摘要。"""
    name = str(data.get("name") or "tool")
    phase = str(data.get("phase") or "")
    args = data.get("args") if isinstance(data.get("args"), dict) else {}
    detail = ""
    for key in ("path", "file_path", "url", "command", "action"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            detail = value.strip()
            break
    label = name + ((":" + phase) if phase else "")
    if detail:
        label += " " + detail[:160]
    return label


def extract_text(value: Any) -> str:
    """从 OpenAI/OpenClaw 消息 content 里取出纯文本：str / 文本块数组 / message dict 都兼容。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: List[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                chunk = item.get("text")
                if not isinstance(chunk, str):
                    chunk = item.get("content")
                if isinstance(chunk, str):
                    parts.append(chunk)
        return "".join(parts)
    if isinstance(value, dict):
        if "content" in value:
            return extract_text(value.get("content"))
        text = value.get("text")
        if isinstance(text, str):
            return text
    return ""


class OpenClawSettings(object):
    """一次运行用的网关配置，全部来自环境变量 + OpenClaw 本地配置。"""

    def __init__(self) -> None:
        self.ws_url = _env("NOVAI_OPENCLAW_WS_URL", DEFAULT_WS_URL) or DEFAULT_WS_URL
        self.token = _env("NOVAI_OPENCLAW_TOKEN")
        self.token_file = _env("NOVAI_OPENCLAW_TOKEN_FILE")
        self.config_path = _env("NOVAI_OPENCLAW_CONFIG", DEFAULT_CONFIG_PATH)
        self.agent_id = _env("NOVAI_OPENCLAW_AGENT", DEFAULT_AGENT_ID) or DEFAULT_AGENT_ID
        self.session_prefix = _env("NOVAI_OPENCLAW_SESSION_PREFIX", "novai") or "novai"
        self.model = _env("NOVAI_OPENCLAW_MODEL")
        self.connect_timeout = _env_float("NOVAI_OPENCLAW_CONNECT_TIMEOUT", 10.0)
        self.rpc_timeout = _env_float("NOVAI_OPENCLAW_RPC_TIMEOUT", 30.0)
        self.run_timeout = _env_float("NOVAI_OPENCLAW_RUN_TIMEOUT", 300.0)
        self.idle_timeout = _env_float("NOVAI_OPENCLAW_IDLE_TIMEOUT", 180.0)

    def resolve_token(self) -> str:
        if self.token:
            return self.token
        if self.token_file and os.path.isfile(self.token_file):
            with open(self.token_file, "r", encoding="utf-8") as handle:
                value = handle.read().strip()
            if value:
                return value
        return self._token_from_config()

    def _token_from_config(self) -> str:
        path = self.config_path
        if not path or not os.path.isfile(path):
            return ""
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return ""
        gateway = data.get("gateway") if isinstance(data, dict) else None
        auth = gateway.get("auth") if isinstance(gateway, dict) else None
        if isinstance(auth, dict):
            return str(auth.get("token") or "").strip()
        return ""

    def require_token(self) -> str:
        token = self.resolve_token()
        if not token:
            raise OpenClawConfigError(
                "缺少 OpenClaw 网关令牌：请设置 NOVAI_OPENCLAW_TOKEN（或 NOVAI_OPENCLAW_TOKEN_FILE），"
                "或在 %s 的 gateway.auth.token 中配置" % self.config_path
            )
        return token

    def _agent_default_model_from_config(self) -> str:
        """OpenClaw 把模型分成「显式指定」和「agent 默认」两层；没给 NOVAI_OPENCLAW_MODEL 时读配置里的 agent 默认模型。"""
        path = self.config_path
        if not path or not os.path.isfile(path):
            return ""
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return ""
        agents = data.get("agents") if isinstance(data, dict) else None
        if not isinstance(agents, dict):
            return ""
        for item in agents.get("list") or []:
            if not isinstance(item, dict) or str(item.get("id") or "") != self.agent_id:
                continue
            model = item.get("model")
            if isinstance(model, dict):
                return str(model.get("primary") or "").strip()
            if isinstance(model, str):
                return model.strip()
        defaults = agents.get("defaults")
        model = defaults.get("model") if isinstance(defaults, dict) else None
        if isinstance(model, dict):
            return str(model.get("primary") or "").strip()
        if isinstance(model, str):
            return model.strip()
        return ""

    def require_model(self) -> str:
        """显式模型优先；没指定就要求 OpenClaw 该 agent 已配默认模型，两者都没有直接报错，不静默兜底。"""
        if self.model:
            return self.model
        default_model = self._agent_default_model_from_config()
        if default_model:
            return default_model
        raise OpenClawConfigError(
            "模型未指定：请设置 NOVAI_OPENCLAW_MODEL（形如 <平台>/<模型>），"
            "或在 %s 的 agents 配置中为该 agent 设置 model.primary。" % self.config_path
        )

    def session_key(self, conversation_id: str = "") -> str:
        suffix = sanitize_session_key_part(conversation_id, "default")
        return "agent:%s:%s:%s" % (self.agent_id, self.session_prefix, suffix)

    def capability_session_key(self, run_id: str) -> str:
        """能力运行用独立会话：一次 run 一条会话，互不串上下文。"""
        suffix = sanitize_session_key_part(run_id, "run")
        return "agent:%s:%s-cap:%s" % (self.agent_id, self.session_prefix, suffix)


class OpenClawGatewayClient(object):
    """一次对话 = 一条短连接；connect → 建会话 → chat.send → 收 chat 事件。"""

    def __init__(self, settings: Optional[OpenClawSettings] = None) -> None:
        self.settings = settings or OpenClawSettings()
        self._seq = 0

    def _next_id(self, prefix: str = "r") -> str:
        self._seq += 1
        return "%s-%d-%d" % (prefix, self._seq, int(time.time() * 1000))

    async def _open(self):
        _require_websockets()
        try:
            return await websockets.connect(
                self.settings.ws_url,
                max_size=MAX_PAYLOAD_BYTES,
                open_timeout=self.settings.connect_timeout,
                close_timeout=5,
                ping_interval=None,
            )
        except Exception as exc:
            raise OpenClawConnectionError(
                "连接 OpenClaw 网关失败 %s：%s" % (self.settings.ws_url, exc)
            ) from exc

    async def _recv_json(self, ws, timeout: float) -> Dict[str, Any]:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise OpenClawTimeoutError("等待网关消息超时（%.0fs）" % timeout) from exc
        except ConnectionClosed as exc:
            raise OpenClawConnectionError("与 OpenClaw 网关的连接已断开：%s" % exc) from exc
        try:
            data = json.loads(raw)
        except (TypeError, ValueError) as exc:
            raise OpenClawProtocolError("网关返回了非 JSON 帧：%s" % str(raw)[:200]) from exc
        if not isinstance(data, dict):
            raise OpenClawProtocolError("网关帧不是对象：%s" % str(raw)[:200])
        return data

    async def _handshake(self, ws, token: str, scopes: List[str]) -> Dict[str, Any]:
        first = await self._recv_json(ws, self.settings.connect_timeout)
        if first.get("type") == "event" and first.get("event") == "connect.challenge":
            pass
        elif first.get("type") == "event":
            raise OpenClawProtocolError("connect 阶段收到意外事件：%s" % first.get("event"))
        params = {
            "minProtocol": PROTOCOL_VERSION,
            "maxProtocol": PROTOCOL_VERSION,
            "client": {
                "id": BACKEND_CLIENT_ID,
                "version": "novai-openclaw/1.0",
                "platform": _platform_name(),
                "mode": BACKEND_CLIENT_MODE,
            },
            "role": "operator",
            "scopes": scopes,
            "caps": ["tool-events"],
            "commands": [],
            "permissions": {},
            "auth": {"token": token},
            "locale": "zh-CN",
            "userAgent": "novai-openclaw/1.0",
        }
        request = {"type": "req", "id": self._next_id("connect"), "method": "connect", "params": params}
        await ws.send(json.dumps(request))

        deadline = time.monotonic() + self.settings.connect_timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OpenClawTimeoutError("OpenClaw 握手超时")
            frame = await self._recv_json(ws, remaining)
            if frame.get("type") == "res" and frame.get("id") == request["id"]:
                if not frame.get("ok"):
                    error = frame.get("error") or {}
                    raise OpenClawConnectionError(
                        "OpenClaw 网关鉴权/握手失败：%s %s"
                        % (error.get("code") or "ERROR", error.get("message") or "")
                    )
                return frame.get("payload") or {}

    async def _rpc(self, ws, method: str, params: Dict[str, Any], timeout: Optional[float] = None) -> Dict[str, Any]:
        request = {"type": "req", "id": self._next_id(method.split(".")[-1]), "method": method, "params": params}
        await ws.send(json.dumps(request))
        deadline = time.monotonic() + (timeout if timeout is not None else self.settings.rpc_timeout)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OpenClawTimeoutError("OpenClaw RPC %s 超时" % method)
            frame = await self._recv_json(ws, remaining)
            if frame.get("type") != "res" or frame.get("id") != request["id"]:
                continue
            if not frame.get("ok"):
                error = frame.get("error") or {}
                raise OpenClawRpcError(method, str(error.get("code") or "ERROR"), str(error.get("message") or ""))
            payload = frame.get("payload")
            return payload if isinstance(payload, dict) else {}

    async def invoke_tool(self, name: str, args: Dict[str, Any], session_key: str = "",
                          agent_id: str = "", timeout: Optional[float] = None) -> Dict[str, Any]:
        """通过网关 tools.invoke 直接调 OpenClaw 自己的工具（不经过模型）。

        实测可用：browser（open/snapshot/...）。实测不可用：exec / write / read 会返回
        "Tool not available"（OpenClaw 2026.6.9 只对插件类工具开放 RPC 调用）。
        用于编排模式：模型不会/无需自行决定工具调用时，由 NOVAI 明确驱动 OpenClaw 的
        浏览器抓取，分析仍由 OpenClaw 会话的模型完成。
        """
        token = self.settings.require_token()
        ws = await self._open()
        try:
            await self._handshake(ws, token, ["operator.read", "operator.write", "operator.admin"])
            params = {
                "name": name,
                "args": args or {},
                "agentId": agent_id or self.settings.agent_id,
                "idempotencyKey": str(uuid.uuid4()),
            }
            if session_key:
                params["sessionKey"] = session_key
            return await self._rpc(
                ws, "tools.invoke", params,
                timeout=timeout if timeout is not None else self.settings.rpc_timeout)
        finally:
            try:
                await ws.close()
            except Exception:
                pass

    async def _prepare_session(self, ws, session_key: str, model: str = "") -> None:
        await self._rpc(ws, "sessions.create", {"key": session_key, "agentId": self.settings.agent_id})
        effective = str(model or self.settings.model or "").strip()
        if effective:
            await self._rpc(
                ws,
                "sessions.patch",
                {"key": session_key, "agentId": self.settings.agent_id, "model": effective},
            )

    async def _subscribe(self, ws, session_key: str) -> None:
        try:
            await self._rpc(ws, "sessions.messages.subscribe", {"key": session_key, "agentId": self.settings.agent_id})
        except OpenClawError:
            # 订阅只是取最终正文的兜底；chat 事件本身是广播，不因订阅失败而中断本轮
            pass

    async def _history_text(self, ws, session_key: str) -> str:
        try:
            payload = await self._rpc(ws, "chat.history", {"sessionKey": session_key, "limit": 8})
        except OpenClawError:
            return ""
        messages = payload.get("messages")
        if not isinstance(messages, list):
            return ""
        for item in reversed(messages):
            if not isinstance(item, dict):
                continue
            if str(item.get("role") or "") != "assistant":
                continue
            text = extract_text(item.get("content"))
            if text.strip():
                return text
        return ""

    async def chat(
        self,
        message: str,
        session_key: str = "",
        on_delta: Optional[Callable[[str, bool], None]] = None,
        timeout: Optional[float] = None,
        idle_timeout: Optional[float] = None,
    ) -> str:
        """发送一轮对话并返回正文；增量通过 on_delta(text, replace) 回调。"""
        token = self.settings.require_token()
        self.settings.require_model()
        session_key = session_key or self.settings.session_key()
        scopes = ["operator.read", "operator.write"]
        if self.settings.model:
            scopes.append("operator.admin")
        run_timeout = timeout if timeout is not None else self.settings.run_timeout

        ws = await self._open()
        try:
            await self._handshake(ws, token, scopes)
            await self._prepare_session(ws, session_key)
            await self._subscribe(ws, session_key)
            run_id = await self._send(ws, session_key, message)
            return await self._collect(ws, run_id, session_key, on_delta, run_timeout, idle_timeout)
        finally:
            try:
                await ws.close()
            except Exception:
                pass

    async def chat_stream(
        self,
        message: str,
        session_key: str = "",
        model: str = "",
        on_delta: Optional[Callable[[str, bool], None]] = None,
        on_tool: Optional[Callable[[Dict[str, Any]], None]] = None,
        timeout: Optional[float] = None,
        idle_timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """带工具事件的一轮对话，返回 {"text": 正文, "run_id": runId}。

        与 chat() 的区别：额外解析 event=agent 的 stream=assistant（正文增量）与
        stream=tool（真实工具调用 start/update/result），让 NOVAI 能把 OpenClaw
        实际执行的动作映射成既有 step_start/step_result 事件。终态仍以 chat 事件
        或 lifecycle phase=end 为准；phase=error 直接抛明确异常，不静默兜底。
        """
        token = self.settings.require_token()
        session_key = session_key or self.settings.session_key()
        effective_model = str(model or self.settings.model or "").strip()
        scopes = ["operator.read", "operator.write"]
        if effective_model:
            scopes.append("operator.admin")
        run_timeout = timeout if timeout is not None else self.settings.run_timeout

        ws = await self._open()
        try:
            await self._handshake(ws, token, scopes)
            await self._prepare_session(ws, session_key, effective_model)
            await self._subscribe(ws, session_key)
            run_id = await self._send(ws, session_key, message)
            text = await self._collect_stream(ws, run_id, session_key, on_delta, on_tool,
                                              run_timeout, idle_timeout)
            return {"text": text, "run_id": run_id}
        finally:
            try:
                await ws.close()
            except Exception:
                pass

    async def _collect_stream(
        self,
        ws,
        run_id: str,
        session_key: str,
        on_delta: Optional[Callable[[str, bool], None]],
        on_tool: Optional[Callable[[Dict[str, Any]], None]],
        run_timeout: float,
        idle_timeout: Optional[float] = None,
    ) -> str:
        buffer = ""
        cumulative = ""
        final_text = ""
        message_text = ""
        last_event = ""
        last_tool_step = ""
        idle = self.settings.idle_timeout if idle_timeout is None else float(idle_timeout)
        deadline = time.monotonic() + run_timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OpenClawTimeoutError(
                    "OpenClaw 本轮执行超时（%.0fs，runId=%s，最后事件=%s，最后工具步骤=%s）"
                    % (run_timeout, run_id, last_event or "无", last_tool_step or "无"))
            idle_wait = remaining >= idle
            wait = idle if idle_wait else remaining
            try:
                frame = await self._recv_json(ws, wait)
            except OpenClawTimeoutError:
                if idle_wait:
                    raise OpenClawIdleTimeoutError(run_id, idle, last_event, last_tool_step)
                raise
            if frame.get("type") != "event":
                continue
            event = frame.get("event")
            last_event = str(event or "")
            payload = frame.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            if event == "agent":
                if payload.get("runId") and str(payload.get("runId")) != run_id:
                    continue
                stream = str(payload.get("stream") or "")
                data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
                if stream == "assistant":
                    text_now = str(data.get("text") or "")
                    if text_now:
                        cumulative = text_now
                    delta = str(data.get("delta") or "")
                    if delta:
                        buffer += delta
                        if on_delta is not None:
                            on_delta(delta, False)
                elif stream == "tool":
                    last_tool_step = _tool_step_label(data)
                    if on_tool is not None:
                        on_tool(data)
                elif stream == "lifecycle":
                    phase = str(data.get("phase") or "")
                    if phase == "error":
                        detail = str(data.get("error") or "").strip()
                        raise OpenClawRunError(detail or ("OpenClaw 本轮执行失败（runId=%s）" % run_id))
                    if phase == "end":
                        break
            elif event == "chat":
                if payload.get("runId") and str(payload.get("runId")) != run_id:
                    continue
                state = str(payload.get("state") or "")
                if state == "delta":
                    delta = str(payload.get("deltaText") or "")
                    replace = bool(payload.get("replace"))
                    if replace:
                        buffer = delta
                    else:
                        buffer += delta
                    if delta and on_delta is not None:
                        on_delta(delta, replace)
                elif state == "final":
                    message = payload.get("message")
                    if isinstance(message, dict):
                        final_text = extract_text(message.get("content"))
                    break
                elif state == "aborted":
                    raise OpenClawRunError("OpenClaw 本轮执行被中止（runId=%s）" % run_id)
                elif state == "error":
                    detail = str(payload.get("errorMessage") or "").strip()
                    if not detail and isinstance(payload.get("message"), dict):
                        detail = extract_text(payload["message"].get("content"))
                    raise OpenClawRunError(detail or ("OpenClaw 本轮执行失败（runId=%s）" % run_id))
            elif event == "session.message":
                message = payload.get("message")
                if isinstance(message, dict) and str(message.get("role") or "") == "assistant":
                    text = extract_text(message.get("content"))
                    if text.strip():
                        message_text = text

        text = (final_text or cumulative or buffer or message_text or "").strip()
        if not text:
            text = (await self._history_text(ws, session_key)).strip()
        return text

    async def _send(self, ws, session_key: str, message: str) -> str:
        params = {
            "sessionKey": session_key,
            "agentId": self.settings.agent_id,
            "message": message,
            "idempotencyKey": str(uuid.uuid4()),
            "deliver": False,
        }
        payload = await self._rpc(ws, "chat.send", params)
        run_id = str(payload.get("runId") or "")
        if not run_id:
            raise OpenClawProtocolError("chat.send 未返回 runId：%s" % json.dumps(payload, ensure_ascii=False)[:200])
        return run_id

    async def _collect(
        self,
        ws,
        run_id: str,
        session_key: str,
        on_delta: Optional[Callable[[str, bool], None]],
        run_timeout: float,
        idle_timeout: Optional[float] = None,
    ) -> str:
        buffer = ""
        final_text = ""
        last_message_text = ""
        last_event = ""
        idle = self.settings.idle_timeout if idle_timeout is None else float(idle_timeout)
        deadline = time.monotonic() + run_timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise OpenClawTimeoutError(
                    "OpenClaw 本轮对话超时（%.0fs，runId=%s，最后事件=%s）"
                    % (run_timeout, run_id, last_event or "无"))
            idle_wait = remaining >= idle
            wait = idle if idle_wait else remaining
            try:
                frame = await self._recv_json(ws, wait)
            except OpenClawTimeoutError:
                if idle_wait:
                    raise OpenClawIdleTimeoutError(run_id, idle, last_event, "")
                raise
            if frame.get("type") != "event":
                continue
            event = frame.get("event")
            last_event = str(event or "")
            payload = frame.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            if event == "chat":
                if payload.get("runId") and str(payload.get("runId")) != run_id:
                    continue
                state = str(payload.get("state") or "")
                if state == "delta":
                    delta = str(payload.get("deltaText") or "")
                    replace = bool(payload.get("replace"))
                    if replace:
                        buffer = delta
                    else:
                        buffer += delta
                    message_text = extract_text((payload.get("message") or {}).get("content")) if isinstance(payload.get("message"), dict) else ""
                    if message_text.strip():
                        last_message_text = message_text
                    if delta and on_delta is not None:
                        on_delta(delta, replace)
                elif state == "final":
                    message = payload.get("message")
                    if isinstance(message, dict):
                        final_text = extract_text(message.get("content"))
                    break
                elif state == "aborted":
                    raise OpenClawRunError("OpenClaw 本轮对话被中止（runId=%s）" % run_id)
                elif state == "error":
                    detail = str(payload.get("errorMessage") or "").strip()
                    if not detail and isinstance(payload.get("message"), dict):
                        detail = extract_text(payload["message"].get("content"))
                    raise OpenClawRunError(detail or ("OpenClaw 本轮对话失败（runId=%s）" % run_id))
            elif event == "session.message":
                message = payload.get("message")
                if isinstance(message, dict) and str(message.get("role") or "") == "assistant":
                    text = extract_text(message.get("content"))
                    if text.strip():
                        last_message_text = text

        text = (final_text or last_message_text or buffer).strip()
        if not text:
            text = (await self._history_text(ws, session_key)).strip()
        if not text:
            raise OpenClawRunError("OpenClaw 返回了空回复（runId=%s）" % run_id)
        return text


def backend_enabled() -> bool:
    return _env("NOVAI_CHAT_BACKEND", "openclaw").lower() == "openclaw"


def _fallback_sse(data: Dict[str, Any]) -> str:
    return "data: %s\n\n" % json.dumps(data, ensure_ascii=False)


def compose_message(message: str, system_prompt: str = "", reference_urls: Optional[List[str]] = None) -> str:
    parts: List[str] = []
    prompt = str(system_prompt or "").strip()
    if prompt:
        parts.append("[系统提示]\n" + prompt)
    urls = [str(u).strip() for u in (reference_urls or []) if str(u).strip()]
    if urls:
        parts.append("[参考图片]\n" + "\n".join(urls))
    parts.append(str(message or ""))
    return "\n\n".join(parts)


async def stream_openclaw_chat(
    payload: Any,
    conversation: Dict[str, Any],
    user_id: str,
    save_conversation: Callable[[str, Dict[str, Any]], Any],
) -> AsyncIterator[str]:
    """把一轮 OpenClaw 对话转成 /api/chat/stream 已有的 SSE 事件（meta/delta/error/done）。"""
    from server.routes.deps import deps

    sse_event = deps.get("sse_event", _fallback_sse)
    now_ms = deps.get("now_ms", lambda: int(time.time() * 1000))

    settings = OpenClawSettings()
    client = OpenClawGatewayClient(settings)
    session_key = settings.session_key(str(getattr(payload, "conversation_id", "") or conversation.get("id") or ""))
    if not str(getattr(payload, "conversation_id", "") or ""):
        session_key = settings.session_key(str(conversation.get("id") or ""))

    reference_urls: List[str] = []
    for ref in getattr(payload, "reference_images", None) or []:
        url = getattr(ref, "url", "") if not isinstance(ref, dict) else ref.get("url")
        if url:
            reference_urls.append(str(url))
    message = compose_message(
        str(getattr(payload, "message", "") or ""),
        str(getattr(payload, "system_prompt", "") or ""),
        reference_urls,
    )

    yield sse_event({"type": "meta", "conversation": conversation})

    queue: "asyncio.Queue" = asyncio.Queue()

    def on_delta(text: str, replace: bool) -> None:
        queue.put_nowait((text, replace))

    task = asyncio.ensure_future(client.chat(message, session_key=session_key, on_delta=on_delta))
    while True:
        getter = asyncio.ensure_future(queue.get())
        done, _pending = await asyncio.wait([task, getter], return_when=asyncio.FIRST_COMPLETED)
        if getter in done:
            delta_text, _replace = getter.result()
            yield sse_event({"type": "delta", "delta": delta_text})
        else:
            getter.cancel()

        if task in done:
            while not queue.empty():
                delta_text, _replace = queue.get_nowait()
                yield sse_event({"type": "delta", "delta": delta_text})
            break

    try:
        text = task.result()
    except OpenClawError as exc:
        yield sse_event({"type": "error", "detail": str(exc)})
        return
    except Exception as exc:  # 非预期异常也要报出来，不静默兜底
        yield sse_event({"type": "error", "detail": "OpenClaw 集成异常：%s" % exc})
        return

    assistant_message = {
        "id": uuid.uuid4().hex,
        "role": "assistant",
        "content": text,
        "created_at": now_ms(),
        "model": settings.model or ("openclaw:%s" % settings.agent_id),
        "raw_usage": None,
        "backend": "openclaw",
    }
    conversation.setdefault("messages", []).append(assistant_message)
    conversation["updated_at"] = now_ms()
    save_conversation(user_id, conversation)
    yield sse_event({"type": "done", "conversation": conversation, "message": assistant_message})
