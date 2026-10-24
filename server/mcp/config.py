#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP 服务配置：读取、校验、脱敏。

- 用户配置：data/mcp_servers.json（随数据目录走）
- 空模板：config/mcp_servers.json（仓库自带，方便用户抄格式）
- 路径覆盖：环境变量 NOVAI_MCP_CONFIG（绝对路径或相对当前工作目录）
- 顶层键必须是 mcpServers（兼容从别的 MCP 客户端直接粘贴）

校验口径（P0）：
    name     只允许 [a-z0-9_-]
    command  必填、非空字符串
    args     必须是字符串数组（缺省 []）
    env      必须是字符串字典（缺省 {}）；对外脱敏，只给键名
    timeout  数字，默认 30 秒，上限 600
    enabled  布尔，默认 false（不配就不连，避免误连）

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from typing import Any, Dict, List, Optional, Tuple

ENV_ENABLED = "NOVAI_MCP_ENABLED"
ENV_CONFIG_PATH = "NOVAI_MCP_CONFIG"
CONFIG_FILENAME = "mcp_servers.json"
TOP_KEY = "mcpServers"
NAME_RE = re.compile(r"^[a-z0-9_-]+$")
DEFAULT_TIMEOUT = 30
MAX_TIMEOUT = 600
SERVER_TYPE_STDIO = "stdio"
SERVER_TYPE_HTTP = "http"
SERVER_TYPES = (SERVER_TYPE_STDIO, SERVER_TYPE_HTTP)


def repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def data_root() -> str:
    """与 main.py 一致：NOVAI_DATA_DIR 是数据根，下面再挂 data/。"""
    override = os.environ.get("NOVAI_DATA_DIR", "").strip()
    return override or os.path.expanduser("~/.NOVAI")


def data_dir() -> str:
    return os.path.join(data_root(), "data")


def config_path(path: Optional[str] = None) -> str:
    """配置路径优先级：显式入参 → NOVAI_MCP_CONFIG → <数据目录>/mcp_servers.json。"""
    if path:
        return os.path.abspath(os.path.expanduser(str(path)))
    override = os.environ.get(ENV_CONFIG_PATH, "").strip()
    if override:
        return os.path.abspath(os.path.expanduser(override))
    return os.path.join(data_dir(), CONFIG_FILENAME)


def template_path() -> str:
    return os.path.join(repo_root(), "config", CONFIG_FILENAME)


def env_enabled() -> bool:
    """总开关：只有 NOVAI_MCP_ENABLED=1 才连 MCP 服务。"""
    return os.environ.get(ENV_ENABLED, "").strip() == "1"


def _str_list(raw: Any) -> Optional[List[str]]:
    if raw is None:
        return []
    if not isinstance(raw, (list, tuple)):
        return None
    out = []
    for item in raw:
        if not isinstance(item, str):
            return None
        out.append(item)
    return out


def _str_dict(raw: Any) -> Optional[Dict[str, str]]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        return None
    out = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            return None
        if isinstance(value, bool) or value is None or isinstance(value, (dict, list)):
            return None
        out[key] = str(value)
    return out


def normalize_server(name: Any, raw: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """单条配置校验。返回 (server, error)；error 非空表示这条被跳过。"""
    server_name = str(name or "").strip()
    if not NAME_RE.match(server_name):
        return None, "名称只能用小写字母、数字、下划线、连字符：%r" % (server_name,)
    if not isinstance(raw, dict):
        return None, "配置必须是对象（含 command/args/env，或 type=http + url）"
    transport = raw.get("type", SERVER_TYPE_STDIO)
    if not isinstance(transport, str) or transport not in SERVER_TYPES:
        return None, "type 只能是 %s 或 %s" % (SERVER_TYPE_STDIO, SERVER_TYPE_HTTP)
    command, url = "", ""
    if transport == SERVER_TYPE_HTTP:
        if "command" in raw and str(raw.get("command") or "").strip():
            return None, "http 传输不能配置 command"
        url = raw.get("url")
        if not isinstance(url, str) or not url.strip():
            return None, "http 传输必须配置 url"
        url = url.strip()
        if not (url.startswith("http://") or url.startswith("https://")):
            return None, "url 必须是 http:// 或 https:// 开头"
    else:
        command = raw.get("command")
        if not isinstance(command, str) or not command.strip():
            return None, "command 必填（要启动的可执行文件）"
    args = _str_list(raw.get("args"))
    if args is None:
        return None, "args 必须是字符串数组"
    env = _str_dict(raw.get("env"))
    if env is None:
        return None, "env 必须是字符串字典"
    headers = _str_dict(raw.get("headers"))
    if headers is None:
        return None, "headers 必须是字符串字典"
    timeout = raw.get("timeout", DEFAULT_TIMEOUT)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        return None, "timeout 必须是数字（秒）"
    timeout = float(timeout)
    if timeout <= 0:
        return None, "timeout 必须大于 0"
    enabled = raw.get("enabled", False)
    if not isinstance(enabled, bool):
        return None, "enabled 必须是布尔值"
    return {
        "name": server_name,
        "type": transport,
        "command": command.strip(),
        "args": args,
        "env": env,
        "url": url,
        "headers": headers,
        "timeout": min(timeout, MAX_TIMEOUT),
        "enabled": enabled,
    }, None


def _empty_payload() -> Dict[str, Any]:
    return {TOP_KEY: {}}


def load_config(path: Optional[str] = None) -> Dict[str, Any]:
    """读取并校验配置。任何问题都收进 errors，不抛异常。

    返回 {"path", "missing", "servers": {name: server}, "errors": [{"name", "error"}], "raw": payload}
    """
    target = config_path(path)
    result: Dict[str, Any] = {"path": target, "missing": False, "servers": {},
                              "errors": [], "raw": None}
    if not os.path.isfile(target):
        result["missing"] = True
        return result
    try:
        with open(target, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception as exc:
        result["errors"].append({"name": "<file>", "error": "配置不是合法 JSON：%s" % exc})
        return result
    result["raw"] = payload
    if not isinstance(payload, dict) or not isinstance(payload.get(TOP_KEY), dict):
        result["errors"].append({"name": "<file>", "error": "顶层键必须是 %s（对象）" % TOP_KEY})
        return result
    for name, raw in payload.get(TOP_KEY, {}).items():
        server, error = normalize_server(name, raw)
        if error:
            result["errors"].append({"name": str(name), "error": error})
            continue
        result["servers"][server["name"]] = server
    return result


def redacted(server: Dict[str, Any]) -> Dict[str, Any]:
    """对外视图：env / headers 只给键名，不给值。"""
    transport = str(server.get("type") or SERVER_TYPE_STDIO)
    return {
        "name": server.get("name"),
        "type": transport,
        "command": str(server.get("command") or "") if transport == SERVER_TYPE_STDIO else "",
        "args": list(server.get("args") or []) if transport == SERVER_TYPE_STDIO else [],
        "url": str(server.get("url") or "") if transport == SERVER_TYPE_HTTP else "",
        "timeout": server.get("timeout"),
        "enabled": bool(server.get("enabled")),
        "env_keys": sorted((server.get("env") or {}).keys()),
        "header_keys": sorted((server.get("headers") or {}).keys()),
    }


def ensure_template() -> str:
    """空模板不存在时补一份（仓库自带，只含顶层键）。"""
    target = template_path()
    if not os.path.isfile(target):
        os.makedirs(os.path.dirname(target), exist_ok=True)
        _atomic_write_json(target, _empty_payload())
    return target


def ensure_user_config() -> str:
    """用户配置不存在时补一份空文件（首次打开开关即可编辑）。"""
    target = config_path()
    if not os.path.isfile(target):
        os.makedirs(os.path.dirname(target), exist_ok=True)
        _atomic_write_json(target, _empty_payload())
    return target


def _atomic_write_json(path: str, payload: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".mcp-", suffix=".partial", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def set_server_enabled(name: str, enabled: bool = True, path: Optional[str] = None) -> Dict[str, Any]:
    """把某个 server 的 enabled 写回配置文件（保留其余字段与顺序）。返回落盘后的 payload。"""
    target = config_path(path)
    if not os.path.isfile(target):
        ensure_user_config()
    try:
        with open(target, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception:
        payload = _empty_payload()
    if not isinstance(payload, dict):
        payload = _empty_payload()
    servers = payload.get(TOP_KEY)
    if not isinstance(servers, dict):
        servers = {}
        payload[TOP_KEY] = servers
    if name not in servers:
        raise KeyError(name)
    entry = servers[name]
    if not isinstance(entry, dict):
        raise KeyError(name)
    entry["enabled"] = bool(enabled)
    _atomic_write_json(target, payload)
    return payload


def save_raw(payload: Dict[str, Any], path: Optional[str] = None) -> str:
    target = config_path(path)
    _atomic_write_json(target, copy.deepcopy(payload))
    return target
