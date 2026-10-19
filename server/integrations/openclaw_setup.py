#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenClaw 按需安装引导（检测 + 安装执行）。

只做两件事，且都不碰既有聊天 / 能力链路：
1. detect()：判断 OpenClaw 是否可用 —— 可执行文件在不在、能不能跑出版本、Gateway 端口是否可达，
   顺带给出本机 Node 版本与官方要求是否满足，以及本机有没有 Chrome/Chromium（OpenClaw 浏览器功能要用，
   官方安装脚本不负责装）。任何一步失败都只记录 errors，不抛异常、不刷屏。
2. OpenClawInstallSession：把 config/openclaw.json 里配置好的官方安装脚本命令交给用户确认后执行，
   实时回传 stdout/stderr，可取消，结束后自动重新 detect() 验证。

安装命令 / 下载地址 / 体积与联网/权限提示 / Node 版本要求 / Chrome 检测路径全部来自配置文件
（默认 config/openclaw.json，可用 NOVAI_OPENCLAW_SETUP_CONFIG 换路径），逐项可用环境变量覆盖；
本模块不写死任何 URL 或命令。安装因权限失败时会识别并给出明确错误与手动指引，而不是只回传原始日志。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_HERE))
DEFAULT_CONFIG_PATH = os.path.join(_REPO_ROOT, "config", "openclaw.json")

# 检测结果短缓存：状态接口默认走缓存，避免每次进对话页都起子进程 / 连端口。
CACHE_TTL_SEC = 30.0
_CACHE: Dict[str, Any] = {"at": 0.0, "data": None}

VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")

# 权限失败识别兜底（配置 install.permission_error_patterns 缺省时用；不含任何 URL / 命令）
DEFAULT_PERMISSION_PATTERNS = [
    r"permission denied",
    r"operation not permitted",
    r"not permitted",
    r"eacces",
    r"eperm",
    r"sudo:.{0,40}password",
    r"a password is required",
    r"no tty present",
    r"must be run as root",
    r"requires? (administrator|root|sudo)",
    r"access is denied",
    r"are you root",
]

# 环境变量覆盖项：值 → 取来源（配置项名），供状态接口如实回传「这条命令从哪来」。
ENV_CONFIG = "NOVAI_OPENCLAW_SETUP_CONFIG"
ENV_COMMAND = "NOVAI_OPENCLAW_INSTALL_COMMAND"
ENV_SCRIPT_URL = "NOVAI_OPENCLAW_INSTALL_SCRIPT_URL"
ENV_SIZE_HINT = "NOVAI_OPENCLAW_INSTALL_SIZE_HINT"
ENV_NETWORK_NOTE = "NOVAI_OPENCLAW_INSTALL_NETWORK_NOTE"
ENV_DOCS_URL = "NOVAI_OPENCLAW_INSTALL_DOCS_URL"
ENV_NODE_MIN = "NOVAI_OPENCLAW_NODE_MIN"
ENV_NODE_ALT_MIN = "NOVAI_OPENCLAW_NODE_ALT_MIN"
ENV_GATEWAY_URL = "NOVAI_OPENCLAW_GATEWAY_URL"
ENV_BIN = "NOVAI_OPENCLAW_BIN"
ENV_BIN_DIRS = "NOVAI_OPENCLAW_BIN_DIRS"
ENV_TIMEOUT_MS = "NOVAI_OPENCLAW_INSTALL_TIMEOUT_MS"
ENV_PRIVILEGE_NOTE = "NOVAI_OPENCLAW_INSTALL_PRIVILEGE_NOTE"
ENV_PERMISSION_HINT = "NOVAI_OPENCLAW_INSTALL_PERMISSION_HINT"
ENV_PERMISSION_PATTERNS = "NOVAI_OPENCLAW_INSTALL_PERMISSION_PATTERNS"
ENV_CHROME_PATHS = "NOVAI_OPENCLAW_CHROME_PATHS"
ENV_CHROME_NAMES = "NOVAI_OPENCLAW_CHROME_NAMES"
ENV_CHROME_IMPACT_NOTE = "NOVAI_OPENCLAW_CHROME_IMPACT_NOTE"
ENV_NODE_WARNING_TITLE = "NOVAI_OPENCLAW_NODE_WARNING_TITLE"
ENV_NODE_WARNING = "NOVAI_OPENCLAW_NODE_WARNING"
ENV_INIT_INCOMPLETE_TITLE = "NOVAI_OPENCLAW_INSTALL_INIT_INCOMPLETE_TITLE"
ENV_INIT_INCOMPLETE_NOTE = "NOVAI_OPENCLAW_INSTALL_INIT_INCOMPLETE_NOTE"
ENV_DOCTOR_STEPS = "NOVAI_OPENCLAW_INSTALL_DOCTOR_STEPS"
ENV_DOCTOR_HINT = "NOVAI_OPENCLAW_INSTALL_DOCTOR_HINT"


def _env(name: str) -> str:
    value = os.environ.get(name)
    return "" if value is None else str(value).strip()


def _expand(path: str) -> str:
    return os.path.expanduser(os.path.expandvars(str(path or "").strip()))


def _split_list(raw: str) -> List[str]:
    return [part.strip() for part in re.split(r"[,\n]", str(raw or "")) if part.strip()]


def config_path() -> str:
    return _expand(_env(ENV_CONFIG)) or DEFAULT_CONFIG_PATH


def load_config() -> Tuple[Dict[str, Any], str]:
    """读配置文件；返回 (配置, 来源说明)。文件缺失 / 损坏不抛异常，交给上层如实报错。"""
    path = config_path()
    if not os.path.isfile(path):
        return {}, "missing:" + path
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as exc:
        return {}, "invalid:%s (%s)" % (path, exc)
    if not isinstance(data, dict):
        return {}, "invalid:" + path
    return data, path


def _section(config: Dict[str, Any], name: str) -> Dict[str, Any]:
    value = config.get(name)
    return value if isinstance(value, dict) else {}


def _pick(cfg_value: Any, env_name: str, fallback: Any) -> Tuple[Any, str]:
    """值来源优先级：环境变量 > 配置文件 > 调用方给的兜底（仅结构缺省时用，不含任何 URL/命令字面量）。"""
    env_value = _env(env_name)
    if env_value:
        return env_value, "env:" + env_name
    if cfg_value not in (None, ""):
        return cfg_value, ""
    return fallback, ""


def _default_bin_dirs() -> List[str]:
    # GUI 启动的 Electron 拿不到登录 shell 的 PATH，常见的 npm 全局 bin 目录要主动找。
    # 这份目录清单放配置文件（binary.extra_dirs），这里只是结构缺省，可用 NOVAI_OPENCLAW_BIN_DIRS 覆盖。
    if os.name == "nt":
        # 官方 install.ps1：openclaw.cmd 落在 npm 全局目录，私有 Node 落在 OpenClaw deps 目录
        appdata = _expand(os.environ.get("APPDATA") or "")
        localappdata = _expand(os.environ.get("LOCALAPPDATA") or "")
        dirs: List[str] = []
        if appdata:
            dirs.append(os.path.join(appdata, "npm"))
            dirs.append(os.path.join(appdata, "npm", "node_modules", ".bin"))
        if localappdata:
            dirs.append(os.path.join(localappdata, "OpenClaw", "deps", "portable-node"))
        return dirs
    return [
        # OpenClaw 安装脚本自带的用户态 Node（桌面启动时系统 PATH 里没有它）
        os.path.join(os.path.expanduser("~"), ".openclaw", "tools", "node", "bin"),
        os.path.join(os.path.expanduser("~"), ".npm-global", "bin"),
        os.path.join(os.path.expanduser("~"), ".local", "bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin",
    ]


def _exec_names(name: str) -> List[str]:
    # Windows 上 npm 全局装的是 openclaw.cmd（还有 .ps1/.exe），os.path.isfile 拼无扩展名永远 False
    if os.name != "nt":
        return [name]
    if os.path.splitext(name)[1]:
        return [name]
    # PATHEXT 永远用 ";" 分隔，不受 os.pathsep 影响
    exts = [e.strip().lower() for e in (os.environ.get("PATHEXT") or "").split(";") if e.strip()]
    if not exts:
        exts = [".com", ".exe", ".bat", ".cmd"]
    return [name] + [name + ext for ext in exts]


def bin_dirs(config: Dict[str, Any]) -> List[str]:
    raw = _env(ENV_BIN_DIRS)
    if raw:
        items = [p for p in re.split(r"[,\n]", raw) if p.strip()]
    else:
        items = _section(config, "binary").get("extra_dirs")
        if not isinstance(items, list) or not items:
            items = _default_bin_dirs()
    out: List[str] = []
    for item in items:
        path = _expand(str(item))
        if path and path not in out:
            out.append(path)
    return out


def binary_names(config: Dict[str, Any]) -> List[str]:
    names = _section(config, "binary").get("names")
    if not isinstance(names, list) or not names:
        names = ["openclaw"]
    return [str(n).strip() for n in names if str(n).strip()]


def find_binary(config: Dict[str, Any]) -> Tuple[str, List[str]]:
    """返回 (可执行文件绝对路径或空串, 搜过的候选位置)。找不到不报错，交给调用方判断。"""
    explicit = _env(ENV_BIN)
    if explicit:
        path = _expand(explicit)
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path, [path]
        return "", [path]
    searched: List[str] = []
    for name in binary_names(config):
        found = shutil.which(name)
        if found:
            return found, searched + [found]
        for folder in bin_dirs(config):
            for candidate in [os.path.join(folder, n) for n in _exec_names(name)]:
                searched.append(candidate)
                if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                    return candidate, searched
    return "", searched


def chrome_platform() -> str:
    if os.name == "nt":
        return "win32"
    if sys.platform == "darwin":
        return "darwin"
    return "linux"


def _default_chrome_paths() -> List[str]:
    # 结构缺省，真正的路径清单放配置 chrome.paths；可用 NOVAI_OPENCLAW_CHROME_PATHS 覆盖。
    if os.name == "nt":
        return [
            os.path.join(os.environ.get("PROGRAMFILES", r"C:\Program Files"),
                         "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(os.environ.get("LOCALAPPDATA", ""),
                         "Google", "Chrome", "Application", "chrome.exe"),
        ]
    if sys.platform == "darwin":
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]


def _default_chrome_names() -> List[str]:
    return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]


def chrome_paths(config: Dict[str, Any]) -> Tuple[List[str], bool]:
    """返回 (候选路径, 是否被环境变量显式覆盖)。覆盖时不再做 PATH 名字查找，便于确定性地构造「找不到」情形。"""
    raw = _env(ENV_CHROME_PATHS)
    if raw:
        return [_expand(p) for p in _split_list(raw)], True
    paths_cfg = _section(config, "chrome").get("paths")
    items = paths_cfg.get(chrome_platform()) if isinstance(paths_cfg, dict) else None
    if not isinstance(items, list) or not items:
        items = _default_chrome_paths()
    return [_expand(str(p)) for p in items if str(p).strip()], False


def chrome_names(config: Dict[str, Any]) -> List[str]:
    raw = _env(ENV_CHROME_NAMES)
    if raw:
        return _split_list(raw)
    items = _section(config, "chrome").get("names")
    if not isinstance(items, list) or not items:
        items = _default_chrome_names()
    return [str(n).strip() for n in items if str(n).strip()]


def find_chrome(config: Dict[str, Any]) -> Tuple[str, List[str], str]:
    """返回 (Chrome 可执行文件路径或空串, 搜过的候选, 来源)。找不到不报错。"""
    paths, overridden = chrome_paths(config)
    searched: List[str] = []
    for path in paths:
        searched.append(path)
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path, searched, ("env:" + ENV_CHROME_PATHS) if overridden else "chrome.paths"
    if not overridden:
        for name in chrome_names(config):
            found = shutil.which(name)
            if found:
                return found, searched + [found], "chrome.names"
            searched.append(name)
    return "", searched, ""


def probe_chrome(config: Dict[str, Any]) -> Dict[str, Any]:
    """Chrome/Chromium 检测：OpenClaw 的浏览器功能要用系统 Chrome，官方安装脚本不负责装。"""
    chrome_cfg = _section(config, "chrome")
    path, searched, source = find_chrome(config)
    impact_note, impact_origin = _pick(chrome_cfg.get("impact_note"), ENV_CHROME_IMPACT_NOTE, "")
    if not impact_origin:
        impact_origin = "chrome.impact_note"
    return {
        "found": bool(path),
        "path": path,
        "source": source,
        "searched": searched[:40],
        "note": str(chrome_cfg.get("note") or ""),
        "impact_note": impact_note,
        "impact_note_origin": impact_origin,
    }


def parse_version(raw: str) -> str:
    match = VERSION_RE.search(str(raw or ""))
    if not match:
        return ""
    return "%s.%s.%s" % (match.group(1), match.group(2), match.group(3))


def version_tuple(value: str) -> Tuple[int, int, int]:
    match = VERSION_RE.search(str(value or ""))
    if not match:
        return (0, 0, 0)
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def node_satisfies(version: str, required_min: str, required_alt_min: str) -> bool:
    """官方口径：>= required_min（默认 24.16.0）或 >= required_alt_min（默认 26.1.0）。"""
    current = version_tuple(version)
    if current == (0, 0, 0):
        return False
    low = version_tuple(required_min)
    alt = version_tuple(required_alt_min)
    if low != (0, 0, 0) and current < low:
        return False
    if alt == (0, 0, 0):
        return True
    # required_min 与 required_alt_min 之间的「非推荐区间」整段不算满足：
    # 26.0.x 既没到 26.1，也不是 24.16+ 的推荐线，如实判不满足。
    alt_floor = (alt[0], 0, 0)
    if current >= alt_floor and current < alt:
        return False
    return True


def permission_patterns(config: Dict[str, Any]) -> List[str]:
    raw = _env(ENV_PERMISSION_PATTERNS)
    items = _split_list(raw) if raw else _section(config, "install").get("permission_error_patterns")
    if not isinstance(items, list) or not items:
        items = DEFAULT_PERMISSION_PATTERNS
    return [str(item).strip() for item in items if str(item or "").strip()]


def doctor_steps(config: Dict[str, Any]) -> Tuple[List[Dict[str, str]], str]:
    """收尾（doctor 失败）指引步骤。默认取 install.doctor_steps；环境变量可逐行覆盖：
    每行 `label::command` 或 `label=command`，只写 command 时 label 为空。"""
    raw = _env(ENV_DOCTOR_STEPS)
    if raw:
        out: List[Dict[str, str]] = []
        for line in raw.splitlines():
            item = line.strip()
            if not item:
                continue
            label, value = "", item
            for sep in ("::", "="):
                if sep in item:
                    head, tail = item.split(sep, 1)
                    label, value = head.strip(), tail.strip()
                    break
            if value:
                out.append({"label": label, "value": value})
        return out, "env:" + ENV_DOCTOR_STEPS
    items = _section(config, "install").get("doctor_steps")
    out = []
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict):
                value = str(item.get("value") or "").strip()
                label = str(item.get("label") or "").strip()
            else:
                value, label = str(item or "").strip(), ""
            if value:
                out.append({"label": label, "value": value})
    return out, "install.doctor_steps"


def permission_failure(config: Dict[str, Any], logs: List[str]) -> str:
    """在安装日志里找 sudo / 权限报错特征；命中返回该模式，未命中返回空串。"""
    text = "\n".join(logs)
    if not text:
        return ""
    for pattern in permission_patterns(config):
        try:
            if re.search(pattern, text, re.IGNORECASE):
                return pattern
        except re.error:
            continue
    return ""


def _run_capture(argv: List[str], timeout: float, env: Optional[Dict[str, str]] = None) -> Tuple[int, str]:
    try:
        proc = subprocess.run(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            env=env,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return -1, str(exc)
    text = (proc.stdout or b"").decode("utf-8", "replace")
    return int(proc.returncode), text.strip()


def probe_binary(path: str, timeout: float, env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    if not path:
        return {"ok": False, "raw": "", "version": "", "error": "未找到可执行文件"}
    code, out = _run_capture([path, "--version"], timeout, env=env)
    if code != 0:
        return {"ok": False, "raw": out, "version": "", "error": out or ("退出码 %s" % code)}
    version = parse_version(out)
    if not version:
        return {"ok": False, "raw": out, "version": "", "error": "无法从 --version 输出解析版本"}
    return {"ok": True, "raw": out, "version": version, "error": ""}


def probe_node(config: Dict[str, Any]) -> Dict[str, Any]:
    node_cfg = _section(config, "node")
    required_min = str(node_cfg.get("required_min") or "0.0.0")
    required_alt_min = str(node_cfg.get("required_alt_min") or "0.0.0")
    path = shutil.which("node") or ""
    if not path:
        for folder in bin_dirs(config):
            candidate = next(
                (c for c in [os.path.join(folder, n) for n in _exec_names("node")]
                 if os.path.isfile(c) and os.access(c, os.X_OK)),
                "",
            )
            if candidate:
                path = candidate
                break
    raw = ""
    version = ""
    if path:
        code, out = _run_capture([path, "--version"], 5.0)
        raw = out
        if code == 0:
            version = parse_version(out)
    return {
        "path": path,
        "version": version,
        "raw": raw,
        "satisfies": node_satisfies(version, required_min, required_alt_min) if version else False,
        "required_min": required_min,
        "required_alt_min": required_alt_min,
        "note": str(node_cfg.get("note") or ""),
    }


def _gateway_target(config: Dict[str, Any]) -> Tuple[str, int, str]:
    gw = _section(config, "gateway")
    url = _env(ENV_GATEWAY_URL) or str(gw.get("url") or "")
    host = str(gw.get("host") or "")
    port = gw.get("port")
    match = re.search(r"//([^/:]+)(?::(\d+))?", url)
    if match:
        host = host or match.group(1)
        if not port and match.group(2):
            port = int(match.group(2))
    try:
        port_int = int(port)
    except (TypeError, ValueError):
        port_int = 0
    return host or "127.0.0.1", port_int, url


def probe_gateway(config: Dict[str, Any], timeout: float = 0.4) -> Dict[str, Any]:
    host, port, url = _gateway_target(config)
    reachable = False
    error = ""
    if port:
        sock = None
        try:
            sock = socket.create_connection((host, port), timeout=timeout)
            reachable = True
        except OSError as exc:
            error = str(exc)
        finally:
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
    else:
        error = "未配置 Gateway 端口"
    return {"url": url, "host": host, "port": port, "reachable": reachable, "error": error}


def resolved_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    """把「配置 + 环境变量」解析成界面要展示的字面值，并记录每一项的来源。"""
    install = _section(config, "install")
    windows = os.name == "nt"

    command, command_origin = _pick(
        install.get("command_windows") if windows else install.get("command_unix"),
        ENV_COMMAND,
        "",
    )
    if not command_origin:
        command_origin = "install.%s" % ("command_windows" if windows else "command_unix")

    script_url, script_origin = _pick(
        install.get("script_url_windows") if windows else install.get("script_url_unix"),
        ENV_SCRIPT_URL,
        "",
    )
    if not script_origin:
        script_origin = "install.%s" % ("script_url_windows" if windows else "script_url_unix")

    size_hint, size_origin = _pick(install.get("size_hint"), ENV_SIZE_HINT, "")
    if not size_origin:
        size_origin = "install.size_hint"
    network_note, network_origin = _pick(install.get("network_note"), ENV_NETWORK_NOTE, "")
    if not network_origin:
        network_origin = "install.network_note"
    privilege_note, privilege_origin = _pick(install.get("privilege_note"), ENV_PRIVILEGE_NOTE, "")
    if not privilege_origin:
        privilege_origin = "install.privilege_note"
    permission_hint, permission_origin = _pick(install.get("permission_hint"), ENV_PERMISSION_HINT, "")
    if not permission_origin:
        permission_origin = "install.permission_hint"

    node_cfg = _section(config, "node")
    node_warning_title, node_warning_title_origin = _pick(
        node_cfg.get("warning_title"), ENV_NODE_WARNING_TITLE, "")
    if not node_warning_title_origin:
        node_warning_title_origin = "node.warning_title"
    node_warning, node_warning_origin = _pick(node_cfg.get("warning"), ENV_NODE_WARNING, "")
    if not node_warning_origin:
        node_warning_origin = "node.warning"

    init_title, init_title_origin = _pick(
        install.get("init_incomplete_title"), ENV_INIT_INCOMPLETE_TITLE, "")
    if not init_title_origin:
        init_title_origin = "install.init_incomplete_title"
    init_note, init_note_origin = _pick(
        install.get("init_incomplete_note"), ENV_INIT_INCOMPLETE_NOTE, "")
    if not init_note_origin:
        init_note_origin = "install.init_incomplete_note"
    steps, steps_origin = doctor_steps(config)
    doctor_hint, doctor_hint_origin = _pick(install.get("doctor_hint"), ENV_DOCTOR_HINT, "")
    if not doctor_hint_origin:
        doctor_hint_origin = "install.doctor_hint"

    docs_url, docs_origin = _pick(install.get("docs_url"), ENV_DOCS_URL, "")
    if not docs_origin:
        docs_origin = "install.docs_url"

    shell = str(install.get("shell_windows" if windows else "shell_unix") or "")

    timeout_ms = install.get("timeout_ms")
    env_timeout = _env(ENV_TIMEOUT_MS)
    if env_timeout:
        try:
            timeout_ms = int(float(env_timeout))
        except ValueError:
            pass
    try:
        timeout_ms = int(timeout_ms)
    except (TypeError, ValueError):
        timeout_ms = 0

    return {
        "platform": "win32" if windows else ("darwin" if sys.platform == "darwin" else "linux"),
        "windows": windows,
        "command": command,
        "command_origin": command_origin,
        "shell": shell,
        "script_url": script_url,
        "script_url_origin": script_origin,
        "size_hint": size_hint,
        "size_hint_origin": size_origin,
        "network_note": network_note,
        "network_note_origin": network_origin,
        "privilege_note": privilege_note,
        "privilege_note_origin": privilege_origin,
        "permission_hint": permission_hint,
        "permission_hint_origin": permission_origin,
        "node_warning_title": node_warning_title,
        "node_warning_title_origin": node_warning_title_origin,
        "node_warning": node_warning,
        "node_warning_origin": node_warning_origin,
        "init_incomplete_title": init_title,
        "init_incomplete_title_origin": init_title_origin,
        "init_incomplete_note": init_note,
        "init_incomplete_note_origin": init_note_origin,
        "doctor_steps": steps,
        "doctor_steps_origin": steps_origin,
        "doctor_hint": doctor_hint,
        "doctor_hint_origin": doctor_hint_origin,
        "docs_url": docs_url,
        "docs_url_origin": docs_origin,
        "install_docs_url": str(install.get("install_docs_url") or ""),
        "windows_docs_url": str(install.get("windows_docs_url") or ""),
        "npm_command": str(install.get("npm_command") or ""),
        "timeout_ms": timeout_ms,
    }


def detect(force: bool = False) -> Dict[str, Any]:
    """OpenClaw 可用性检测。失败只进 errors，永远返回结构完整的 dict。"""
    now = time.time()
    if not force and _CACHE["data"] is not None and (now - float(_CACHE["at"])) < CACHE_TTL_SEC:
        cached = dict(_CACHE["data"])
        cached["cached"] = True
        return cached

    config, source = load_config()
    config_ok = bool(config) and not source.startswith(("missing:", "invalid:"))
    errors: List[str] = []

    binary_cfg = _section(config, "binary")
    try:
        version_timeout = float(binary_cfg.get("version_timeout_ms") or 5000) / 1000.0
    except (TypeError, ValueError):
        version_timeout = 5.0

    binary_path, searched = find_binary(config)
    probed = probe_binary(binary_path, version_timeout, env=install_environ(config))
    if binary_path and not probed.get("ok"):
        errors.append("openclaw 可执行文件存在但 --version 失败：%s" % probed.get("error"))

    node = probe_node(config)
    gateway = probe_gateway(config)
    chrome = probe_chrome(config)

    gw_cfg = _section(config, "gateway")
    gw_config_path = _expand(str(gw_cfg.get("config_path") or ""))
    config_exists = bool(gw_config_path) and os.path.isfile(gw_config_path)

    installed = bool(binary_path)
    available = installed and bool(probed.get("version"))

    data = {
        "ok": True,
        "config_ok": config_ok,
        "config_source": source,
        "config_error": "" if config_ok else ("配置文件不可用：%s" % source),
        "available": available,
        "installed": installed,
        "binary_path": binary_path,
        "binary_searched": searched[:40],
        "version": str(probed.get("version") or ""),
        "version_raw": str(probed.get("raw") or ""),
        "gateway": gateway,
        "gateway_config": {"path": gw_config_path, "exists": config_exists},
        "node": node,
        "chrome": chrome,
        "errors": errors,
        "checked_at": int(now * 1000),
        "cached": False,
        "setup": resolved_settings(config),
    }
    _CACHE["at"] = now
    _CACHE["data"] = data
    return data


def invalidate_cache() -> None:
    _CACHE["at"] = 0.0
    _CACHE["data"] = None


def install_environ(config: Dict[str, Any]) -> Dict[str, str]:
    """给安装脚本一个带上常见 bin 目录的 PATH（GUI 启动时 PATH 很短，脚本会找不到 node/npm）。"""
    env = dict(os.environ)
    current = env.get("PATH") or ""
    parts = [p for p in current.split(os.pathsep) if p]
    # 倒序插入 → 最终 PATH 保持 bin_dirs 的顺序（首个目录优先级最高）
    for folder in reversed(bin_dirs(config)):
        if folder and folder not in parts:
            parts.insert(0, folder)
    env["PATH"] = os.pathsep.join(parts)
    env.setdefault("CI", "1")
    return env


class InstallError(Exception):
    pass


class OpenClawInstallSession(object):
    """一次安装执行。单例由 _ACTIVE 持有，路由层保证同一时间只跑一个。"""

    def __init__(self) -> None:
        config, source = load_config()
        self.config = config
        self.config_source = source
        self.settings = resolved_settings(config)
        self.id = uuid.uuid4().hex
        self.started_at = int(time.time() * 1000)
        self.finished_at = 0
        self.status = "pending"  # pending | running | done | failed | cancelled
        self.command = str(self.settings.get("command") or "")
        self.timeout_ms = int(self.settings.get("timeout_ms") or 900000)
        self.logs: List[str] = []
        self.error = ""
        self.error_code = ""
        self.outcome = "pending"  # pending | running | success | partial | failed | cancelled
        self.init_incomplete = False
        self.result: Optional[Dict[str, Any]] = None
        self._proc = None  # type: Optional[asyncio.subprocess.Process]
        self._cancelled = False
        self._returncode = -1

    def snapshot(self) -> Dict[str, Any]:
        return {
            "session_id": self.id,
            "status": self.status,
            "command": self.command,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "logs": self.logs[-400:],
            "error": self.error,
            "error_code": self.error_code,
            "outcome": self.outcome,
            "init_incomplete": self.init_incomplete,
            "result": self.result,
        }

    def cancel(self) -> bool:
        if self.status != "running":
            return False
        self._cancelled = True
        self._kill()
        return True

    def _kill(self) -> None:
        proc = self._proc
        if proc is None or proc.returncode is not None:
            return
        try:
            if os.name == "nt":
                proc.terminate()
            else:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (OSError, ProcessLookupError):
            try:
                proc.terminate()
            except (OSError, ProcessLookupError):
                pass

    async def _reap(self, proc) -> Optional[int]:
        try:
            return await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            try:
                if os.name == "nt":
                    proc.kill()
                else:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
            try:
                return await asyncio.wait_for(proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                return None

    async def stream(self) -> Any:
        """异步生成器：逐条产出 {event, ...} 供路由层包成 SSE。"""
        if not self.command:
            self.status = "failed"
            self.error = "安装命令未配置：请检查 %s 的 install.command_* 或设置环境变量 %s" % (
                self.config_source, ENV_COMMAND)
            self.finished_at = int(time.time() * 1000)
            yield {"event": "error", "message": self.error, "code": "command_missing"}
            yield {"event": "done", "ok": False, "session": self.snapshot()}
            return

        self.status = "running"
        self.outcome = "running"
        env = install_environ(self.config)
        cwd = os.path.expanduser("~") or None
        usage = "在 NOVAI 里点「安装 OpenClaw」后执行（用户已确认）"
        yield {
            "event": "start",
            "session_id": self.id,
            "command": self.command,
            "shell": self.settings.get("shell") or "",
            "script_url": self.settings.get("script_url") or "",
            "config_source": self.config_source,
            "command_origin": self.settings.get("command_origin") or "",
            "note": usage,
            "timeout_ms": self.timeout_ms,
        }

        try:
            self._proc = await asyncio.create_subprocess_shell(
                self.command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=cwd,
                env=env,
                start_new_session=(os.name != "nt"),
            )
        except (OSError, ValueError) as exc:
            self.status = "failed"
            self.error = "启动安装进程失败：%s" % exc
            self.finished_at = int(time.time() * 1000)
            yield {"event": "error", "message": self.error, "code": "spawn_failed"}
            yield {"event": "done", "ok": False, "session": self.snapshot()}
            return

        proc = self._proc
        deadline = time.monotonic() + max(self.timeout_ms, 1000) / 1000.0
        timed_out = False
        reached_end = False
        try:
            while True:
                if self._cancelled:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    raw = await asyncio.wait_for(proc.stdout.readline(), timeout=min(remaining, 5.0))
                except asyncio.TimeoutError:
                    continue
                if not raw:
                    reached_end = True
                    break
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line:
                    self.logs.append(line)
                    yield {"event": "log", "line": line, "stream": "stdout"}
        finally:
            # 正常读完 / 取消 / 超时 / 客户端断流（GeneratorExit）都在这里收口，绝不留下孤儿安装进程
            if not reached_end and not timed_out:
                self._cancelled = True
            self._kill()
            returncode = await self._reap(proc)
            self._returncode = -2 if returncode is None else int(returncode)

        if self._cancelled:
            self.status = "cancelled"
            self.error = "安装已取消"
        elif timed_out:
            self.status = "failed"
            self.error = "安装超时（%d 秒），已终止" % int(max(self.timeout_ms, 1000) / 1000)
        else:
            self.status = "done" if self._returncode == 0 else "failed"
            if self.status == "failed":
                matched = permission_failure(self.config, self.logs)
                if matched:
                    # 权限失败单独识别：给明确原因 + 配置里的手动指引，不把原始日志当结论甩出去
                    self.error_code = "permission_denied"
                    hint = str(self.settings.get("permission_hint") or "")
                    self.error = "安装因权限不足中断（日志中出现「%s」）：%s" % (
                        matched, hint or "请检查管理员权限后重试，或按手动指引在终端里执行。")
                    yield {
                        "event": "error",
                        "code": "permission_denied",
                        "message": self.error,
                        "hint": hint,
                        "matched": matched,
                    }
                else:
                    tail = "；".join(self.logs[-5:])[:600]
                    self.error = "安装脚本退出码 %s%s" % (self._returncode, ("：" + tail) if tail else "")

        yield {"event": "verify", "message": "安装结束，正在重新检测 openclaw --version 与 Gateway 端口…"}

        invalidate_cache()
        status = detect(force=True)
        self.result = status
        installed = bool(status.get("installed"))
        available = bool(status.get("available"))
        script_ok = bool(self.status == "done")
        ok = bool(script_ok and available)

        if ok:
            self.outcome = "success"
        elif self.status == "cancelled":
            self.outcome = "cancelled"
        elif installed and not self._cancelled and not timed_out and self.error_code != "permission_denied":
            # 装包成功但收尾失败（实测 doctor 以 EXIT=1 结束、升级后 session store 要迁移）：
            # 如实归为「初始化未完成」并给官方收尾指引，而不是笼统地报「安装失败」。
            self.init_incomplete = True
            self.outcome = "partial"
            self.error_code = "init_incomplete"
            title = str(self.settings.get("init_incomplete_title") or "").strip()
            note = str(self.settings.get("init_incomplete_note") or "").strip()
            self.error = ("%s：%s" % (title, note)).strip("：") or "OpenClaw 包已安装，但初始化未完成"
            self.status = "failed"
        else:
            self.outcome = "failed"
            if script_ok and not available:
                self.error = "安装脚本已退出，但重新检测仍未找到可用的 openclaw（可能是 PATH 未生效或安装未完成），可重试或手动安装"
            if script_ok:
                self.status = "failed"

        self.finished_at = int(time.time() * 1000)
        yield {
            "event": "done",
            "ok": ok,
            "code": self.error_code,
            "outcome": self.outcome,
            "init_incomplete": self.init_incomplete,
            "message": "OpenClaw 已可用：%s" % (status.get("version") or "")
            if ok else (self.error or "安装未完成"),
            "result": status,
            "session": self.snapshot(),
        }


_ACTIVE: Optional[OpenClawInstallSession] = None


def active_install() -> Optional[OpenClawInstallSession]:
    global _ACTIVE
    if _ACTIVE is not None and _ACTIVE.status == "running":
        return _ACTIVE
    return None


def begin_install() -> OpenClawInstallSession:
    global _ACTIVE
    if active_install() is not None:
        raise InstallError("已有安装在进行中")
    _ACTIVE = OpenClawInstallSession()
    return _ACTIVE


def cancel_install() -> bool:
    session = active_install()
    if session is None:
        return False
    return session.cancel()


def current_snapshot() -> Optional[Dict[str, Any]]:
    """最近一次安装会话的快照（含已结束的），供刷新页面后恢复进度显示。"""
    if _ACTIVE is None:
        return None
    return _ACTIVE.snapshot()
