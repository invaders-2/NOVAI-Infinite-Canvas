"""系统代理探测：让「联网搜索 / 读网页 / 搜图」明确跟随操作系统代理。

为什么需要：macOS/Windows 的系统代理只写在系统配置里，不一定出现在 HTTP_PROXY /
HTTPS_PROXY 环境变量里；httpx 的 trust_env 在不同版本/平台上行为并不一致（0.28 会
通过 urllib.getproxies() 读到 macOS 系统代理，旧版本只读环境变量），联网能不能走代理
取决于装的 httpx 版本。这里显式探测系统代理：auto=跟随系统、direct=真直连、url=自定义，
把行为固定下来，被网络限制的站点（Pinterest 等）才不会 12 秒超时。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

MODES = ("auto", "direct", "url")
DEFAULT_MODE = "auto"
ALLOWED_PROXY_SCHEMES = ("http", "https", "socks5", "socks5h")

# scutil 是子进程调用，别每次请求都跑；30 秒内复用上次结果（设置页保存后可 force 重探）
DETECT_CACHE_TTL = 30.0
_CACHE: Dict[str, Any] = {"at": 0.0, "proxy": None}

_ENV_KEYS = ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")


def _proxy_url(value: Any) -> Optional[str]:
    """校验并归一代理地址；不合法返回 None。支持 http/https/socks5/socks5h（可带账号密码）。"""
    text = str(value or "").strip()
    if not text:
        return None
    if "://" not in text:
        text = "http://" + text
    parsed = urlparse(text)
    if parsed.scheme not in ALLOWED_PROXY_SCHEMES or not parsed.hostname:
        return None
    try:
        parsed.port
    except ValueError:
        return None
    # 代理只需要 scheme://host:port（带认证时保留 userinfo），路径/查询一律丢掉
    return f"{parsed.scheme}://{parsed.netloc}"


# ---------------------------------------------------------------------------
# macOS：scutil --proxy
# ---------------------------------------------------------------------------

_SCUTIL_LINE_RE = re.compile(r"^\s*([A-Za-z0-9]+)\s*:\s*(\S.*?)\s*$")


def parse_scutil_proxy(text: str) -> Optional[str]:
    """把 `scutil --proxy` 的输出解析成代理地址：http 优先，其次 https，最后 socks（转 socks5h）。"""
    values: Dict[str, str] = {}
    for line in str(text or "").splitlines():
        match = _SCUTIL_LINE_RE.match(line)
        if match:
            values[match.group(1)] = match.group(2)
    for prefix, scheme in (("HTTP", "http"), ("HTTPS", "https"), ("SOCKS", "socks5h")):
        if str(values.get(prefix + "Enable", "")).strip() != "1":
            continue
        host = str(values.get(prefix + "Proxy", "")).strip()
        port = str(values.get(prefix + "Port", "")).strip()
        if not host or not port:
            continue
        proxy = _proxy_url(f"{scheme}://{host}:{port}")
        if proxy:
            return proxy
    return None


def _scutil_output() -> str:
    try:
        proc = subprocess.run(["scutil", "--proxy"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"[net_proxy] 读取 macOS 系统代理失败：{exc}")
        return ""
    return proc.stdout or ""


# ---------------------------------------------------------------------------
# Windows：HKCU\...\Internet Settings 的 ProxyEnable / ProxyServer
# ---------------------------------------------------------------------------

_WINDOWS_SETTINGS_KEY = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"


def parse_windows_proxy_server(value: Any) -> Optional[str]:
    """ProxyServer 有两种写法：`host:port` 和 `http=host:port;https=host:port`。"""
    text = str(value or "").strip()
    if not text:
        return None
    if "://" in text:
        return _proxy_url(text)
    if "=" not in text:
        return _proxy_url("http://" + text)
    mapping: Dict[str, str] = {}
    for part in text.split(";"):
        if "=" not in part:
            continue
        key, raw = part.split("=", 1)
        key = key.strip().lower()
        if key and raw.strip():
            mapping[key] = raw.strip()
    for key, scheme in (("http", "http"), ("https", "https"), ("socks", "socks5h")):
        if mapping.get(key):
            proxy = _proxy_url(f"{scheme}://{mapping[key]}")
            if proxy:
                return proxy
    return None


def _windows_proxy_server() -> str:
    try:
        import winreg  # type: ignore
    except ImportError:
        return ""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WINDOWS_SETTINGS_KEY) as key:
            try:
                enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
            except OSError:
                return ""
            if not int(enabled or 0):
                return ""
            try:
                server, _ = winreg.QueryValueEx(key, "ProxyServer")
            except OSError:
                return ""
            return str(server or "")
    except OSError as exc:
        print(f"[net_proxy] 读取 Windows 系统代理失败：{exc}")
        return ""


# ---------------------------------------------------------------------------
# Linux / 兜底：环境变量
# ---------------------------------------------------------------------------

def _env_proxy() -> Optional[str]:
    for key in _ENV_KEYS:
        proxy = _proxy_url(os.environ.get(key, ""))
        if proxy:
            return proxy
    return None


# ---------------------------------------------------------------------------
# 对外 API
# ---------------------------------------------------------------------------

def _platform_proxy() -> Optional[str]:
    if sys.platform == "darwin":
        return parse_scutil_proxy(_scutil_output())
    if sys.platform.startswith("win"):
        return parse_windows_proxy_server(_windows_proxy_server())
    return None


def detect_system_proxy(force: bool = False) -> Optional[str]:
    """探测操作系统代理；带 30 秒缓存，重复调用不会反复起子进程。"""
    now = time.monotonic()
    if not force and _CACHE["at"] and now - _CACHE["at"] < DETECT_CACHE_TTL:
        return _CACHE["proxy"]
    proxy = _platform_proxy() or _env_proxy()
    _CACHE["at"] = now
    _CACHE["proxy"] = proxy
    return proxy


def clear_proxy_cache() -> None:
    _CACHE["at"] = 0.0
    _CACHE["proxy"] = None


def _load_settings() -> Dict[str, Any]:
    """settings 统一由 main.py 读写；延迟导入，避免 server/ 与 main 的循环依赖。"""
    try:
        import main as main_module
        cfg = main_module.load_settings()
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def mode_and_proxy(settings: Optional[Dict[str, Any]] = None) -> Tuple[str, Optional[str]]:
    """读出 (mode, 自定义代理地址)；非法配置一律退回 auto，绝不让坏配置把联网打死。"""
    cfg = settings if isinstance(settings, dict) else _load_settings()
    raw = str(cfg.get("agent_web_proxy") or DEFAULT_MODE).strip()
    lowered = raw.lower()
    if lowered == "direct":
        return "direct", None
    if lowered in ("", DEFAULT_MODE):
        return "auto", None
    if lowered == "url":
        url = _proxy_url(cfg.get("agent_web_proxy_url"))
        return ("url", url) if url else ("auto", None)
    # 兼容把地址直接存进 agent_web_proxy 的写法
    url = _proxy_url(raw)
    return ("url", url) if url else ("auto", None)


def resolve_web_proxy(settings: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """联网工具实际要用的代理：auto=系统代理，direct=None，url=自定义地址。"""
    mode, url = mode_and_proxy(settings)
    if mode == "direct":
        return None
    if mode == "url":
        return url
    return detect_system_proxy()


def normalize_proxy_update(mode: Any, proxy: Any = None) -> Tuple[str, Optional[str]]:
    """校验设置页提交的 {mode?, proxy?}，返回可落库的 (mode, url)；非法抛 ValueError（中文原因）。"""
    text_mode = str(mode or "").strip().lower()
    text_proxy = str(proxy or "").strip()
    if not text_mode:
        text_mode = "url" if text_proxy else "auto"
    if text_mode not in MODES:
        raise ValueError("代理模式只能是 auto（跟随系统）、direct（直连）或 url（自定义地址）")
    if text_mode == "url":
        url = _proxy_url(text_proxy)
        if not url:
            raise ValueError("自定义代理地址无效，请填 http://127.0.0.1:7897 或 socks5://127.0.0.1:1080")
        return "url", url
    return text_mode, None


def _disable_env_proxy() -> Dict[str, Any]:
    # httpx 0.28 的 trust_env 不只读环境变量：macOS 上它会通过 urllib.getproxies()
    # 读到系统代理（生成 http:// / https:// 两条 mounts）。直接「不用代理」时必须逐条
    # 用 mounts=None 覆盖掉，否则 direct 模式其实还在走系统代理。
    return {"mounts": {"all://": None, "http://": None, "https://": None}}


def httpx_proxy(proxy_url: Optional[str]) -> Dict[str, Any]:
    """返回 httpx 的参数 dict：有代理用 proxy= 单值（0.28），没有代理显式关掉 env 代理。

    SOCKS 需要 socksio，没装时退回直连（也显式关代理，避免误走系统代理）。
    """
    url = _proxy_url(proxy_url)
    if not url:
        return _disable_env_proxy()
    if url.split(":", 1)[0] in ("socks5", "socks5h"):
        try:
            import socksio  # noqa: F401
        except ImportError:
            print(f"[net_proxy] 未安装 socksio，SOCKS 代理 {url} 不可用，本次直连")
            return _disable_env_proxy()
    return {"proxy": url}


def web_proxy_status(settings: Optional[Dict[str, Any]] = None, refresh: bool = False) -> Dict[str, Any]:
    """设置页要的 {mode, proxy, detected, note}（detected 是系统探测结果，供「跟随系统」行显示）。"""
    cfg = settings if isinstance(settings, dict) else _load_settings()
    mode, url = mode_and_proxy(cfg)
    detected = detect_system_proxy(force=bool(refresh))
    if mode == "direct":
        note = "已关闭代理，联网请求全部直连"
    elif mode == "url":
        note = f"使用自定义代理 {url}"
        if detected and detected != url:
            note += f"（系统代理为 {detected}）"
    elif detected:
        note = f"跟随系统代理 {detected}"
    else:
        note = "未检测到系统代理，联网请求将直连"
    return {"mode": mode, "proxy": url or None, "detected": detected or None, "note": note}
