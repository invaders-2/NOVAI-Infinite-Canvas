#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP 插件目录（应用市场）：Photoshop 精修的一键安装。

契约（冻结）：
    GET  /api/mcp/catalog
    POST /api/mcp/catalog/{item_id}/install
    GET  /api/mcp/catalog/{item_id}/install
    POST /api/mcp/catalog/{item_id}/uninstall

安装跑在后台线程里：检测 Node → 准备安装目录 → npm install → 写 mcp_servers.json →
发现工具。逐行读 npm 输出更新「当前步骤 + 日志」，前端轮询 GET 拿进度；任何一步失败
都停在那一步、保留已下载内容，重试不用重下。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional

from server.mcp import config, registry

NODE_PACKAGE = "@alisaitteke/photoshop-mcp"
# npm 正常 1~6 分钟；超过 15 分钟基本是卡在网络上，主动杀掉并让用户重试
NODE_INSTALL_TIMEOUT = 15 * 60
MAX_LOG_LINES = 200
MAX_LOG_LINE_CHARS = 400
STATUS_FILENAME = "catalog_status.json"
# 验收时要验证「PATH 里没有 node」这条分支，但本机兜底目录里可能还有一份 node；
# 显式设置这个变量（空串也算）就能把兜底目录整个替换掉
ENV_NODE_BIN_DIRS = "NOVAI_MCP_NODE_BIN_DIRS"
ENTRY_SCRIPT_REL = ("node_modules",) + tuple(NODE_PACKAGE.split("/")) + ("dist", "index.js")

CATALOG: List[Dict[str, Any]] = [
    {
        "id": "photoshop",
        "name": "Photoshop 精修",
        "summary": "让助手直接在你的 Photoshop 里抠图、修图、调色、导出，不用来回切软件",
        "description": ("装好后，画布助手可以调用 Photoshop 的 128 个原生动作：一键去背、磨皮修人像、"
                        "局部调色、加蒙版、九宫格和批量导出都在你正在用的 PS 里完成。"
                        "需要本机已装 Photoshop 和 Node.js 18+；没打开 Photoshop 也能先装好并列出工具，"
                        "打开后即可执行。"),
        "icon": "brush",
        "size_hint": "约 500 MB",
        "docs_url": "https://github.com/alisaitteke/photoshop-mcp",
        "server_name": "photoshop",
    },
]

_ITEMS: Dict[str, Dict[str, Any]] = {item["id"]: item for item in CATALOG}
_DEFAULT_STEPS = {
    "idle": "未安装",
    "installing": "正在安装…",
    "installed": "已安装并启用",
    "failed": "安装失败",
}

_DATA_DIR = ""
_records: Dict[str, Dict[str, Any]] = {}
_threads: Dict[str, threading.Thread] = {}
_LOCK = threading.RLock()
_loaded = False


class CatalogError(Exception):
    """目录接口的可读错误；路由按 status_code 转成 HTTP 响应。"""

    def __init__(self, message: str, status_code: int = 500):
        Exception.__init__(self, message)
        self.status_code = int(status_code)


# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------

def set_data_dir(path: str) -> None:
    global _DATA_DIR
    _DATA_DIR = str(path or "")


def data_dir() -> str:
    """与 main.py 的 DATA_DIR 同口径（main 启动时注入；单独调用时退回 MCP 配置目录）。"""
    if _DATA_DIR:
        return os.path.abspath(os.path.expanduser(_DATA_DIR))
    return config.data_dir()


def install_dir(item_id: str) -> str:
    return os.path.join(data_dir(), "mcp", item_id)


def status_path() -> str:
    return os.path.join(data_dir(), "mcp", STATUS_FILENAME)


def entry_script(item_id: str) -> str:
    return os.path.join(install_dir(item_id), *ENTRY_SCRIPT_REL)


def _item(item_id: str) -> Dict[str, Any]:
    item = _ITEMS.get(str(item_id or "").strip())
    if item is None:
        raise CatalogError("目录里没有这个插件：%s" % (item_id or "<空>"), 404)
    return item


def _atomic_write_json(path: str, payload: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".mcp-catalog-", suffix=".tmp", dir=directory)
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


# ---------------------------------------------------------------------------
# 本机检测：node / npm / Photoshop
# ---------------------------------------------------------------------------

def _bin_dirs() -> List[str]:
    raw = os.environ.get(ENV_NODE_BIN_DIRS)
    if raw is not None:
        out: List[str] = []
        for part in re.split(r"[,\n]", raw):
            for piece in part.split(os.pathsep):
                piece = piece.strip()
                if piece and piece not in out:
                    out.append(piece)
        return out
    home = os.path.expanduser("~")
    dirs = ["/opt/homebrew/bin", "/usr/local/bin", os.path.join(home, ".local", "bin")]
    nvm_root = os.path.join(home, ".nvm", "versions", "node")
    try:
        versions = sorted(os.listdir(nvm_root), reverse=True) if os.path.isdir(nvm_root) else []
    except OSError:
        versions = []
    for version in versions:
        dirs.append(os.path.join(nvm_root, version, "bin"))
    if os.name == "nt":
        appdata = os.environ.get("APPDATA") or ""
        if appdata:
            dirs.append(os.path.join(appdata, "npm"))
        program_files = os.environ.get("ProgramFiles") or r"C:\Program Files"
        dirs.append(os.path.join(program_files, "nodejs"))
    out = []
    for folder in dirs:
        if folder and folder not in out:
            out.append(folder)
    return out


def _exec_names(name: str) -> List[str]:
    if os.name != "nt" or os.path.splitext(name)[1]:
        return [name]
    exts = [e.strip().lower() for e in (os.environ.get("PATHEXT") or "").split(";") if e.strip()]
    if not exts:
        exts = [".com", ".exe", ".bat", ".cmd"]
    return [name] + [name + ext for ext in exts]


def _find_executable(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    for folder in _bin_dirs():
        for candidate in _exec_names(name):
            path = os.path.join(folder, candidate)
            if os.path.isfile(path) and os.access(path, os.X_OK):
                return path
    return ""


def find_node() -> str:
    return _find_executable("node")


def find_npm() -> str:
    return _find_executable("npm")


def photoshop_paths() -> List[str]:
    paths: List[str] = []
    if sys.platform == "darwin":
        paths.extend(sorted(glob.glob("/Applications/Adobe Photoshop*.app")))
        # 新版 Adobe 装在 /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app 里，
        # 只按第一层 glob 会漏检（这台机器就是这种布局）
        paths.extend(sorted(glob.glob("/Applications/Adobe Photoshop*/*.app")))
    elif os.name == "nt":
        roots = [os.environ.get("ProgramFiles") or r"C:\Program Files",
                 os.environ.get("ProgramFiles(x86)") or r"C:\Program Files (x86)"]
        for root in roots:
            paths.extend(sorted(glob.glob(os.path.join(root, "Adobe", "Adobe Photoshop*", "Photoshop.exe"))))
    return paths


def detect_photoshop() -> bool:
    return bool(photoshop_paths())


def _probe_node_version(node: str) -> str:
    try:
        result = subprocess.run([node, "--version"], capture_output=True, text=True,
                                timeout=15, encoding="utf-8", errors="replace")
    except Exception:
        return ""
    text = str(result.stdout or result.stderr or "").strip()
    return text.splitlines()[0].strip() if text else ""


def _node_major(version: str) -> int:
    match = re.search(r"(\d+)", str(version or ""))
    try:
        return int(match.group(1)) if match else 0
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# 安装状态（内存 + 落盘；重启后前端仍能看到「已安装 / 上次失败」）
# ---------------------------------------------------------------------------

def _load_status_locked() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    try:
        with open(status_path(), "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        return
    for key, raw in payload.items():
        if key not in _ITEMS or not isinstance(raw, dict):
            continue
        state = str(raw.get("state") or "idle")
        log = raw.get("log") if isinstance(raw.get("log"), list) else []
        record = {
            "state": state,
            "step": str(raw.get("step") or ""),
            "log": [str(line)[:MAX_LOG_LINE_CHARS] for line in log if str(line).strip()][-MAX_LOG_LINES:],
            "error": str(raw.get("error") or ""),
            "tool_count": int(raw.get("tool_count") or 0),
        }
        if state == "installing":
            # 进程重启后没有线程还在跑，留着 installing 会让前端永远转圈
            record["state"] = "failed"
            record["step"] = "安装中断"
            record["error"] = "上次安装在程序退出前没跑完，请重新点「安装」"
        _records[key] = record


def _save_status_locked() -> None:
    payload = {key: dict(record) for key, record in _records.items()}
    try:
        _atomic_write_json(status_path(), payload)
    except OSError as exc:
        print("[MCP Catalog] 写入安装状态失败（不影响安装）：%s" % exc)


def _update(item_id: str, state: Optional[str] = None, step: Optional[str] = None,
            error: Optional[str] = None, tool_count: Optional[int] = None,
            log_line: Optional[str] = None) -> None:
    with _LOCK:
        _load_status_locked()
        record = _records.setdefault(item_id, {"state": "idle", "step": _DEFAULT_STEPS["idle"],
                                               "log": [], "error": "", "tool_count": 0})
        changed = False
        if state is not None and record.get("state") != state:
            record["state"] = state
            changed = True
        if step is not None and record.get("step") != step:
            record["step"] = step
            changed = True
        if error is not None and record.get("error") != error:
            record["error"] = error
            changed = True
        if tool_count is not None and record.get("tool_count") != int(tool_count):
            record["tool_count"] = int(tool_count)
            changed = True
        if log_line is not None:
            line = str(log_line).rstrip()
            if line:
                record["log"].append(line[:MAX_LOG_LINE_CHARS])
                if len(record["log"]) > MAX_LOG_LINES:
                    record["log"] = record["log"][-MAX_LOG_LINES:]
        record["updated_at"] = int(time.time())
        if changed:
            _save_status_locked()


def _step(item_id: str, text: str) -> None:
    _update(item_id, step=text)


def _log(item_id: str, line: str) -> None:
    _update(item_id, log_line=line)


def _fail(item_id: str, message: str) -> bool:
    _log(item_id, message)
    _update(item_id, state="failed", step="安装失败", error=message)
    return False


def _default_step(state: str) -> str:
    return _DEFAULT_STEPS.get(state, "")


def _server_entry(server_name: str) -> Optional[Dict[str, Any]]:
    try:
        return (config.load_config().get("servers") or {}).get(server_name)
    except Exception:
        return None


def _entry_installed(entry: Optional[Dict[str, Any]]) -> bool:
    """配置里有这条、且启动文件真的存在才算装好。

    手工装过的机器（比如 ~/.novai/mcp/photoshop）没有本模块的安装状态文件，
    只看「安装目录在不在」会误判成未安装，所以按配置里的 args 指向的文件判断。
    """
    if not entry:
        return False
    if str(entry.get("type") or config.SERVER_TYPE_STDIO) == config.SERVER_TYPE_HTTP:
        return bool(str(entry.get("url") or "").strip())
    args = [str(part) for part in (entry.get("args") or [])]
    if args:
        return any(os.path.isfile(part) for part in args)
    command = str(entry.get("command") or "")
    return bool(command) and os.path.isfile(command)


def _live_server_states() -> Dict[str, Dict[str, Any]]:
    """当前注册表的真实发现结果（走 registry 的 60s 缓存；总开关关着时是「未启用」+ 0 工具，不会连进程）。"""
    try:
        rows = registry.servers_view()
    except Exception as exc:
        print("[MCP Catalog] 读取注册表状态失败（工具数回落安装状态）：%s" % exc)
        return {}
    states: Dict[str, Dict[str, Any]] = {}
    for row in rows or []:
        if isinstance(row, dict) and str(row.get("name") or ""):
            states[str(row["name"])] = row
    return states


def _tool_count_for(server_name: str, installed: bool, record: Dict[str, Any],
                    live: Dict[str, Dict[str, Any]]) -> int:
    """工具数优先用当前发现结果：手工装好的机器没有安装记录，只能从注册表拿。"""
    if not installed:
        return 0
    row = live.get(server_name)
    status = str((row or {}).get("status") or "")
    if row is not None and status in ("就绪", "未启用"):
        try:
            return int(row.get("tool_count") or 0)
        except (TypeError, ValueError):
            pass
    return int(record.get("tool_count") or 0)


def _resolved_state(item_id: str, installed: bool, record: Dict[str, Any]) -> str:
    state = str(record.get("state") or ("installed" if installed else "idle"))
    if state == "installed" and not installed:
        state = "idle"
    elif state == "idle" and installed:
        state = "installed"
    return state


# ---------------------------------------------------------------------------
# 目录视图
# ---------------------------------------------------------------------------

def items() -> List[Dict[str, Any]]:
    cfg = config.load_config()
    servers = cfg.get("servers") or {}
    switch_on = config.enabled()
    live = _live_server_states()
    node = find_node()
    npm = find_npm()
    photoshop = detect_photoshop()
    out: List[Dict[str, Any]] = []
    for item in CATALOG:
        entry = servers.get(item["server_name"])
        installed = _entry_installed(entry)
        with _LOCK:
            _load_status_locked()
            record = dict(_records.get(item["id"]) or {})
        state = _resolved_state(item["id"], installed, record)
        tool_count = _tool_count_for(item["server_name"], installed, record, live)
        out.append({
            "id": item["id"],
            "name": item["name"],
            "summary": item["summary"],
            "description": item["description"],
            "icon": item["icon"],
            "size_hint": item["size_hint"],
            "docs_url": item["docs_url"],
            "server_name": item["server_name"],
            "requires": {"node": bool(node), "npm": bool(npm), "photoshop": bool(photoshop)},
            "installed": bool(installed),
            "enabled": bool(installed and entry.get("enabled") and switch_on),
            "tool_count": tool_count,
            "state": state,
            "step": str(record.get("step") or _default_step(state)),
            "error": str(record.get("error") or "") if state == "failed" else "",
        })
    return out


def install_status(item_id: str) -> Dict[str, Any]:
    item = _item(item_id)
    with _LOCK:
        _load_status_locked()
        record = dict(_records.get(item["id"]) or {})
    entry = _server_entry(item["server_name"])
    installed = _entry_installed(entry)
    state = _resolved_state(item["id"], installed, record)
    return {
        "ok": True,
        "state": state,
        "step": str(record.get("step") or _default_step(state)),
        "log": list(record.get("log") or []),
        "error": str(record.get("error") or ""),
    }


# ---------------------------------------------------------------------------
# 安装
# ---------------------------------------------------------------------------

def start_install(item_id: str) -> str:
    """启动安装线程；重复调用返回当前状态，不会起第二个线程。"""
    item = _item(item_id)
    with _LOCK:
        _load_status_locked()
        record = _records.get(item["id"]) or {}
        running = _threads.get(item["id"])
        if record.get("state") == "installing" and running is not None and running.is_alive():
            return "installing"
        entry = _server_entry(item["server_name"])
        if _entry_installed(entry):
            # 已经装好再点一次：只保证配置处于启用态，不重新下载（手工装好的也走这里）
            try:
                if not entry.get("enabled"):
                    config.set_server_enabled(item["server_name"], True)
                config.set_enabled(True)
                registry.reset_cache()
            except Exception as exc:
                print("[MCP Catalog] 重新启用 %s 失败：%s" % (item["server_name"], exc))
            _records[item["id"]] = {"state": "installed", "step": _DEFAULT_STEPS["installed"],
                                    "log": list(record.get("log") or []),
                                    "error": "", "tool_count": int(record.get("tool_count") or 0)}
            _save_status_locked()
            return "installed"
        _records[item["id"]] = {"state": "installing", "step": "正在检测 Node.js…",
                                "log": [], "error": "", "tool_count": 0}
        _save_status_locked()
        thread = threading.Thread(target=_install_worker, args=(item["id"],),
                                  name="mcp-catalog-install-%s" % item["id"], daemon=True)
        _threads[item["id"]] = thread
        thread.start()
        return "installing"


def _install_worker(item_id: str) -> None:
    try:
        _run_install(item_id)
    except Exception as exc:
        _fail(item_id, "安装过程出错：%s: %s" % (type(exc).__name__, exc))


def _run_install(item_id: str) -> None:
    item = _item(item_id)
    node = find_node()
    if not node:
        _fail(item_id, "这台电脑没有 Node.js（18+），请先安装：https://nodejs.org/ ")
        return
    npm = find_npm()
    if not npm:
        _fail(item_id, "这台电脑没有 npm（随 Node.js 一起提供），请重装 Node.js：https://nodejs.org/ ")
        return
    version = _probe_node_version(node)
    major = _node_major(version)
    if major and major < 18:
        _fail(item_id, "Node.js 版本过低（当前 %s，需要 18+），请升级：https://nodejs.org/ " % version)
        return
    _log(item_id, "Node.js %s：%s" % (version or "版本未知", node))
    _log(item_id, "npm：%s" % npm)

    _step(item_id, "正在准备安装目录…")
    target = install_dir(item_id)
    try:
        os.makedirs(target, exist_ok=True)
        # 单独放一份最小 package.json：父目录有 package.json 时 npm 会把依赖装到父目录去
        _atomic_write_json(os.path.join(target, "package.json"),
                           {"name": "novai-mcp-%s" % item_id, "version": "0.0.0", "private": True})
    except OSError as exc:
        _fail(item_id, "创建安装目录失败（%s）：%s" % (target, exc))
        return

    _step(item_id, "正在下载依赖…")
    code, timed_out, tail = _npm_install(item_id, node, npm, target)
    if timed_out:
        _fail(item_id, "npm install 超过 15 分钟没结束，已中止；已下载的内容保留，可以直接重试")
        return
    if code != 0:
        hint = _npm_error_hint(tail)
        message = "npm install 失败（退出码 %s）" % code
        if hint:
            message += "：%s" % hint
        _fail(item_id, message + "。已下载的内容保留，可以直接重试")
        return

    script = entry_script(item_id)
    if not os.path.isfile(script):
        _fail(item_id, "装完了但没找到启动文件（%s），可能是包结构变了；已下载的内容保留，可以直接重试"
              % os.path.relpath(script, target))
        return

    _step(item_id, "正在写入 MCP 配置…")
    try:
        _write_mcp_config(item, node, script)
    except Exception as exc:
        _fail(item_id, "写入 MCP 配置失败：%s" % exc)
        return

    _step(item_id, "正在读取工具列表…")
    tool_count = _discover_count(item_id)
    _update(item_id, state="installed", step=_DEFAULT_STEPS["installed"], error="",
            tool_count=tool_count)
    _log(item_id, "安装完成：%s 个工具" % tool_count if tool_count else "安装完成：工具列表稍后自动刷新")


def _npm_install(item_id: str, node: str, npm: str, target: str):
    argv = [npm, "install", "--no-audit", "--no-fund", "--loglevel=error",
            "--prefix", target, NODE_PACKAGE]
    if os.name == "nt":
        argv = ["cmd", "/c"] + argv
    env = os.environ.copy()
    node_dir = os.path.dirname(node)
    if node_dir:
        env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")
    env["NO_COLOR"] = "1"
    try:
        proc = subprocess.Popen(argv, cwd=target, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", bufsize=1, env=env)
    except OSError as exc:
        return -1, False, ["启动 npm 失败：%s" % exc]
    timeout_hit = threading.Event()

    def kill_on_timeout() -> None:
        timeout_hit.set()
        try:
            proc.kill()
        except OSError:
            pass

    timer = threading.Timer(NODE_INSTALL_TIMEOUT, kill_on_timeout)
    timer.daemon = True
    timer.start()
    tail: List[str] = []
    try:
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            tail.append(line)
            if len(tail) > 20:
                tail = tail[-20:]
            _log(item_id, line)
            progress = _npm_progress(line)
            if progress:
                _step(item_id, progress)
        proc.wait()
    finally:
        timer.cancel()
        try:
            if proc.stdout is not None:
                proc.stdout.close()
        except OSError:
            pass
    return int(proc.returncode if proc.returncode is not None else -1), timeout_hit.is_set(), tail


def _npm_progress(line: str) -> str:
    low = str(line or "").lower()
    if "package" in low and re.search(r"\b(added|changed|removed|up to date)\b", low):
        return "依赖安装完成，正在写入配置…"
    if any(key in low for key in ("postinstall", "node-gyp", "gyp info", "prebuild")):
        return "正在编译依赖…"
    if any(key in low for key in ("reify", "idealtree", "http fetch", "tarball", "extract",
                                  "sill", "placedep", "resolved")):
        return "正在下载依赖…"
    return ""


def _npm_error_hint(lines: List[str]) -> str:
    for line in reversed(lines):
        text = str(line or "").strip()
        if not text:
            continue
        low = text.lower()
        if low.startswith("npm error") or low.startswith("npm err") or " error" in low:
            return text[:200]
    return str(lines[-1]).strip()[:200] if lines else ""


def _write_mcp_config(item: Dict[str, Any], node: str, script: str) -> None:
    """复用 config 的读写与校验写 mcp_servers.json，并把总开关置开。"""
    config.ensure_user_config()
    cfg = config.load_config()
    for error in cfg.get("errors") or []:
        if str(error.get("name") or "") == "<file>":
            raise RuntimeError("现有 MCP 配置读不出来：%s" % (error.get("error") or "格式不对"))
    payload = cfg.get("raw")
    if not isinstance(payload, dict):
        payload = {config.TOP_KEY: {}}
    servers = payload.get(config.TOP_KEY)
    if not isinstance(servers, dict):
        servers = {}
        payload[config.TOP_KEY] = servers
    entry = {
        "type": config.SERVER_TYPE_STDIO,
        "command": node,
        "args": [script],
        "env": {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "PSMCP_FEEDBACK": "0",
            "PSMCP_UPDATE_CHECK": "0",
            "PHOTOSHOP_SCRIPT_TIMEOUT": "600000",
        },
        "timeout": 600,
        "enabled": True,
    }
    _, error = config.normalize_server(item["server_name"], entry)
    if error:
        raise RuntimeError(error)
    servers[item["server_name"]] = entry
    config.save_raw(payload)
    config.set_enabled(True)
    registry.reset_cache()


def _discover_count(item_id: str) -> int:
    item = _item(item_id)
    registry.reset_cache()
    try:
        found = registry.discover(force=True)
    except Exception as exc:
        _log(item_id, "读取工具列表失败（不影响安装）：%s" % exc)
        return 0
    if not found.get("enabled"):
        _log(item_id, "MCP 总开关没开，先跳过工具列表（打开后会自动刷新）")
        return 0
    state = (found.get("servers") or {}).get(item["server_name"]) or {}
    if str(state.get("status") or "") != "就绪":
        _log(item_id, "工具列表暂时没读到（%s），不影响安装" % (state.get("error") or "服务未连接"))
    try:
        return int(state.get("tool_count") or 0)
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# 卸载
# ---------------------------------------------------------------------------

def uninstall(item_id: str) -> Dict[str, Any]:
    item = _item(item_id)
    with _LOCK:
        _load_status_locked()
        running = _threads.get(item["id"])
        if running is not None and running.is_alive():
            raise CatalogError("正在安装中，等装完再卸载（或重启后重试）", 409)
        payload = config.load_config().get("raw")
        removed = False
        if isinstance(payload, dict) and isinstance(payload.get(config.TOP_KEY), dict):
            servers = payload[config.TOP_KEY]
            if item["server_name"] in servers:
                servers.pop(item["server_name"], None)
                config.save_raw(payload)
                removed = True
        registry.reset_cache()
        renamed = _rename_install_dir(item["id"])
        if renamed:
            print("[MCP Catalog] 安装目录已改名保留：%s" % renamed)
        _records[item["id"]] = {"state": "idle", "step": _DEFAULT_STEPS["idle"], "log": [],
                                "error": "", "tool_count": 0}
        _save_status_locked()
        return {"ok": True, "state": "idle", "removed": removed, "renamed": renamed}


def _rename_install_dir(item_id: str) -> str:
    """卸载只改名不删：用户误点、或想找回下载好的依赖时还能捞回来。"""
    target = install_dir(item_id)
    if not os.path.isdir(target):
        return ""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = "%s.removed-%s" % (target, stamp)
    index = 1
    while os.path.exists(backup):
        backup = "%s.removed-%s-%d" % (target, stamp, index)
        index += 1
    try:
        os.replace(target, backup)
    except OSError as exc:
        raise CatalogError("安装目录改名失败（配置已删除）：%s" % exc)
    return backup
