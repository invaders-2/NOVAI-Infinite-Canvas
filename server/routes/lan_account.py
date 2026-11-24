#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""局域网账号 / 好友 / 聊天（T51）。

定位：两台同一局域网、都开着 NOVAI 的电脑，用「好友码」互加之后可以看在线状态、
发文字消息、发一张画布（对方点开只读预览，再克隆到画布 / 存为模板）。

与云账号（server/auth）无关，不注册、不登录、不上公网：
- 数据落 <DATA_DIR>/lan_account.json、lan_friends.json、lan_friend_requests.json、
  lan_chat/<owner>/<friendId>.json（全部原子写）；
- **按账号归属**：登录云账号时 owner = u<账号 id>，各账号有独立身份 / 好友 / 聊天 / 好友申请；
  没登录或鉴权关闭时 owner = _local（就是升级前的整机一份，行为不变）。
  v1 整机数据首次读取时自动升级到 _local，升级后第一个登录并使用局域网的账号接手（只迁一次）；
  注销账号调用 purge_account(account_id) 删掉它的全部局域网数据，其它账号不受影响；
- 好友码 = NOVAI-<6 位数字码>（新，如 NOVAI-483920）或 NOVAI-<局域网IP>:<端口>-<本机口令>（旧码继续可用），
  6 位纯数字只由账号 id 派生、无前导 0；老版本客户端广播的 6 位字母码仍可解析 / 发现，
  IP / 端口靠 UDP 47823 广播自动发现；
- 口令同时是对方 POST /api/lan/messages 的凭据；
- 在线状态靠 ping（超时 1.5s，结果缓存 3s），前端 5s 轮询，最迟 8s 变离线；
  超时（对方在忙 / 网络抖一下）再试一次，地址变了（换端口 / 换 IP）先用 UDP 发现表里的新地址再试；
- 发送失败不直接判死：先主动探测一次地址、重试一次，仍失败才落 status=pending，
  后台线程每 3s 补发一次，对方恢复在线就自动送出（对方按 message_id 去重）。

契约：
    GET    /api/lan/me                         -> {me: {...}}（含 code / friend_code）
    PUT    /api/lan/me                         {nickname, avatar} -> {me}
    GET    /api/lan/discover                   -> {peers: [{code, nickname, avatar, online}]}
    GET    /api/lan/ping                       可选 X-NOVAI-Friend-Token -> {ok, account_id, nickname, version, can_receive, authorized}
    GET    /api/lan/friends                    -> {friends: [...]}（含 online / unread）
    POST   /api/lan/friends                    {code, nickname?} -> {friend} 或 {pending: true, request}（对方是旧版本时回退直接加好友）
    DELETE /api/lan/friends/{friend_id}        -> {ok: true}
    POST   /api/lan/friends/{friend_id}/send   {text|kind/share_url/canvas_title|media_url/media_name/media_size, message_id?} -> {message}
    GET    /api/lan/messages?with=&after=      -> {messages: [...]}
    POST   /api/lan/messages                   （好友机投递，需 X-NOVAI-Friend-Token）-> {ok, duplicate}
    POST   /api/lan/messages/read              {friend_id} -> {ok, unread}
    GET    /api/lan/friend-requests            -> {incoming: [pending...], outgoing: [pending 与 7 天内的结果]}
    POST   /api/lan/friend-requests            （好友机投递，需 X-NOVAI-Friend-Token）{from, ts} -> {ok, request_id}
    POST   /api/lan/friend-requests/{id}/accept（本机）-> {ok, friend}
    POST   /api/lan/friend-requests/{id}/reject（本机）-> {ok: true}
    POST   /api/lan/friend-requests/result     （好友机回调，需 X-NOVAI-Friend-Token）{request_id, accepted, from} -> {ok}
    POST   /api/lan/media                      （本机页面 multipart file）-> {ok, media}
    GET    /api/lan/media/{media_id}           -> 图片 / 视频本体（鉴权开启时需 token 或 X-NOVAI-Friend-Token）

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y。
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import contextlib
import functools
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import socket
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

try:  # Windows 没有 fcntl：查不到真实掩码，退回候选前缀
    import fcntl
except ImportError:  # pragma: no cover - 取决于平台
    fcntl = None  # type: ignore[assignment]

import httpx
from fastapi import APIRouter, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from server.routes.deps import deps

router = APIRouter(prefix="/api/lan")

ACCOUNT_FILE = "lan_account.json"
FRIENDS_FILE = "lan_friends.json"
CHAT_DIR = "lan_chat"
SCHEMA_VERSION = 2            # 2 = 局域网数据按 owner 分桶（v1 整机数据自动升级）
DEFAULT_NICKNAME = "本机用户"
DEFAULT_AVATAR = "🙂"
ACCOUNT_TOKEN_BYTES = 24          # 48 位十六进制，满足「32+ 字符」
PING_TIMEOUT = 1.5
PING_RETRY_TIMEOUT = 1.5          # 只对「连上了但没回」重试一次，拒连说明对方真没开
ADD_FRIEND_TIMEOUT = 4.0          # 加好友 ping / 投递好友请求：1.5s 对局域网抖动太紧
ADD_FRIEND_ATTEMPTS = 2           # 第一次失败后按发现表重新取地址再试一次，两次都失败才 502
PROBE_TIMEOUT = 3.0               # 发现表可达性探测：机器忙 / 并发时 1.2s 会把正常节点误判成不可达
PROBE_ATTEMPTS = 2                # 第一次失败的节点同一超时再试一次，两次都失败才算不可达
PROBE_CACHE_MS = 5000             # 探测结果缓存 5s（只缓存最终结论），避免连点把局域网刷满
PROBE_MAX_PEERS = 20              # 一次最多探测 20 个节点
SEND_TIMEOUT = 1.8                # 投递消息比 ping 宽一点：含建连 + 对方落盘
RETRY_INTERVAL = 3.0              # 待补发消息的后台重试间隔
ONLINE_CACHE_MS = 3000            # 缓存 3s：配前端 5s 轮询，最迟 8s 变离线
MAX_NICKNAME = 40
MAX_TEXT = 4000
MAX_AVATAR_BYTES = 200 * 1024
MAX_URL = 2048
MAX_MESSAGES = 500                # 每个会话只留最近 500 条，避免无限长
# 代取画布快照不设固定上限：默认不限，只有显式设了正数才按上限（超了返回 413）。
# NOVAI_LAN_JSON_MAX_BYTES：未设置 / 0 = 不限；正数 = 字节上限。
LAN_JSON_CHUNK_BYTES = 1024 * 1024
LAN_JSON_BASE_TIMEOUT = 10.0        # 基础超时（连接 / 单次无进展）
LAN_JSON_STEP_BYTES = 10 * 1024 * 1024
LAN_JSON_STEP_SECONDS = 10.0        # 每多 10MB 多给 10s
LAN_JSON_MAX_TIMEOUT = 300.0        # 50MB+ 大画布首次打开留足时间（上限 300s）
FRIEND_CODE_RE = re.compile(r"^NOVAI-((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})-([A-Za-z0-9_-]{32,})$")
FRIEND_ID_RE = re.compile(r"^[0-9a-f]{8,40}$")
SHORT_CODE_PREFIX = "NOVAI-"
SHORT_CODE_RE = re.compile(r"^\d{6}$")
LEGACY_SHORT_CODE_RE = re.compile(r"^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$")   # 旧版字母码，只用于兼容
# 好友请求：A 加 B 不再是「单方面塞进好友列表」，B 同意后才互相成为好友
FRIEND_REQUESTS_FILE = "lan_friend_requests.json"
FRIEND_REQUEST_ID_RE = re.compile(r"^[0-9a-f]{8,40}$")
MAX_FRIEND_REQUESTS = 50            # incoming / outgoing 各留最近 50 条
FRIEND_REQUEST_TTL_MS = 7 * 24 * 3600 * 1000
# 聊天图片 / 视频：落 <DATA_DIR>/lan_media/<随机会话 id>.<扩展名>
MEDIA_DIR = "lan_media"
MEDIA_MAX_BYTES = 200 * 1024 * 1024
MEDIA_MAX_NAME = 120
MEDIA_ID_RE = re.compile(r"^[a-f0-9]{16,40}$")
# 扩展名只按 content-type 映射，不信任上传时的原文件名
MEDIA_TYPES = {
    "image/png": ("image", ".png"),
    "image/jpeg": ("image", ".jpg"),
    "image/jpg": ("image", ".jpg"),
    "image/gif": ("image", ".gif"),
    "image/webp": ("image", ".webp"),
    "image/avif": ("image", ".avif"),
    "video/mp4": ("video", ".mp4"),
    "video/webm": ("video", ".webm"),
    "video/quicktime": ("video", ".mov"),
    "video/x-m4v": ("video", ".m4v"),
}
MEDIA_EXTENSIONS = (".png", ".jpg", ".gif", ".webp", ".avif", ".mp4", ".webm", ".mov", ".m4v")
MEDIA_EXT_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
}
MESSAGE_KINDS = ("text", "canvas", "image", "video")
# 局域网 UDP 发现：短码里没有 IP / 端口，只能靠广播互相报一下
DISCOVERY_PORT = 47823
DISCOVERY_BROADCAST = "255.255.255.255"
DISCOVERY_INTERVAL = 3.0
DISCOVERY_TICK = 0.5              # 收包超时，决定广播的实际间隔精度
DISCOVERY_TTL_MS = 30 * 1000
DISCOVERY_PACKET_BYTES = 8192
DISCOVERY_AVATAR_BYTES = 512      # UDP 单包上限 64KB，超大头像会把整个广播撑爆
# 定向广播：/23、/22 这类网段上写死 /24 会把包打到一个没人占用的普通主机地址，
# 对端永远收不到。拿不到真实掩码时按这几档前缀逐个试，/24 和旧行为一致。
BROADCAST_PREFIXES = (24, 23, 22, 20, 16)
IFACE_CACHE_TTL = 30.0             # 网卡地址 / 掩码缓存：换 WiFi 后能自己跟上
SIOCGIFADDR = 0xC0206921 if sys.platform == "darwin" else 0x8915
SIOCGIFNETMASK = 0xC0206925 if sys.platform == "darwin" else 0x891B

_LOCK = threading.Lock()
_REQUESTS_LOCK = threading.Lock()
_ONLINE_CACHE: Dict[str, Dict[str, Any]] = {}
_ONLINE_LOCK = threading.Lock()
_PEERS: Dict[str, Dict[str, Any]] = {}
_PEERS_LOCK = threading.Lock()
_DISCOVERY_LOCK = threading.Lock()
_DISCOVERY_STARTED = False
_LAST_BROADCAST_ERROR = ""        # 最近一次广播发送失败原因（诊断接口用）
_IFACE_CACHE: Optional[Tuple[float, Dict[str, str]]] = None
_IFACE_LOCK = threading.Lock()
_PROBE_CACHE: Dict[str, Dict[str, Any]] = {}
_PROBE_LOCK = threading.Lock()


class MeUpdateRequest(BaseModel):
    nickname: str = ""
    avatar: str = ""


class FriendAddRequest(BaseModel):
    code: str = ""
    nickname: str = ""


class MessageSendRequest(BaseModel):
    text: str = ""
    kind: str = "text"
    share_url: str = ""
    canvas_title: str = ""
    message_id: str = ""
    media_url: str = ""
    media_name: str = ""
    media_size: Optional[int] = 0


class ReadRequest(BaseModel):
    friend_id: str = ""


# ---------------------------------------------------------------- 基础工具

def data_dir() -> str:
    bound = deps.get("DATA_DIR")
    if bound:
        return str(bound)
    root = os.environ.get("NOVAI_DATA_DIR") or os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(root, "data")


def now_ms() -> int:
    return int(time.time() * 1000)


def _write_atomic(path: str, data: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def _read_json(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def _lan_ip() -> str:
    """本机局域网 IP：跳过 Clash/VPN TUN、Docker 等虚拟网卡（见 server/lan_ip.py）。"""
    try:
        from server.lan_ip import pick_lan_ip
        value = pick_lan_ip()
    except Exception:
        value = os.environ.get("NOVAI_LAN_IP", "").strip()
    return value or "127.0.0.1"


def _port() -> str:
    return os.environ.get("NOVAI_PORT", "").strip() or "3000"


def _ifreq_ipv4(sock: socket.socket, name: str, request: int) -> str:
    """ioctl(SIOCGIFADDR / SIOCGIFNETMASK) 读一张网卡的 IPv4 地址 / 掩码，失败返回空串。

    ifreq 里 sockaddr 的 IPv4 地址在偏移 20（macOS 与 Linux 都是这个布局）。"""
    if fcntl is None:
        return ""
    try:
        result = fcntl.ioctl(sock.fileno(), request,
                             struct.pack("256s", name.encode("utf-8")[:15]))
    except (OSError, ValueError):
        return ""
    try:
        return socket.inet_ntoa(result[20:24])
    except OSError:
        return ""


def _iface_netmasks() -> Dict[str, str]:
    """本机各 IPv4 网卡的真实掩码 {ip: netmask}，缓存 30s。

    getaddrinfo(gethostname()) 在多网卡机器上经常只给一张网卡，这里直接枚举网卡
    （POSIX）；Windows 没有 fcntl，返回空，调用方退回候选前缀。"""
    global _IFACE_CACHE
    if fcntl is None:
        return {}
    now = time.monotonic()
    with _IFACE_LOCK:
        if _IFACE_CACHE is not None and now - _IFACE_CACHE[0] < IFACE_CACHE_TTL:
            return dict(_IFACE_CACHE[1])
    found: Dict[str, str] = {}
    try:
        names = [name for _, name in socket.if_nameindex()]
    except (AttributeError, OSError):
        names = []
    sock: Optional[socket.socket] = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for name in names:
            address = _ifreq_ipv4(sock, name, SIOCGIFADDR)
            netmask = _ifreq_ipv4(sock, name, SIOCGIFNETMASK)
            if address and netmask and not address.startswith("127."):
                found[address] = netmask
    except OSError:
        pass
    finally:
        if sock is not None:
            sock.close()
    with _IFACE_LOCK:
        _IFACE_CACHE = (now, dict(found))
    return found


def _local_ipv4s() -> List[str]:
    found: List[str] = []

    def add(value: Any) -> None:
        text = str(value or "").strip()
        parts = text.split(".")
        if len(parts) != 4:
            return
        for part in parts:
            if not part.isdigit() or int(part) > 255:
                return
        if text.startswith("127.") or text in found:
            return
        found.append(text)

    try:
        add(_lan_ip())
    except Exception:
        pass
    try:
        for ip in _iface_netmasks():
            add(ip)
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            try:
                add(info[4][0])
            except Exception:
                pass
    except Exception:
        pass
    try:  # Windows 上 fcntl 不可用，gethostbyname_ex 常能多给一张网卡
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            add(ip)
    except Exception:
        pass
    return found


def _mask_prefix(netmask: Any) -> Optional[int]:
    """点分掩码 -> 前缀长度；不是左侧连续的 1 就返回 None。"""
    try:
        parts = [int(part) for part in str(netmask or "").split(".")]
    except (TypeError, ValueError):
        return None
    if len(parts) != 4 or any(part < 0 or part > 255 for part in parts):
        return None
    bits = "".join(format(part, "08b") for part in parts)
    if "01" in bits:
        return None
    prefix = bits.count("1")
    return prefix or None


def _broadcast_for_prefix(ip: str, prefix: int) -> Optional[str]:
    """/31、/32 没有定向广播地址，其余按子网算。"""
    if prefix < 8 or prefix > 30:
        return None
    try:
        return str(ipaddress.ip_network("%s/%d" % (ip, prefix), strict=False).broadcast_address)
    except ValueError:
        return None


def _iface_entries() -> List[Dict[str, Any]]:
    """诊断用：本机每张 IPv4 网卡的 name / ip / netmask / broadcast（复用真实掩码逻辑）。"""
    entries: List[Dict[str, Any]] = []
    names: List[str] = []
    if fcntl is not None:
        try:
            names = [name for _, name in socket.if_nameindex()]
        except (AttributeError, OSError):
            names = []
    sock: Optional[socket.socket] = None
    if names:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            for name in names:
                address = _ifreq_ipv4(sock, name, SIOCGIFADDR)
                netmask = _ifreq_ipv4(sock, name, SIOCGIFNETMASK)
                if not address or not netmask:
                    continue
                prefix = _mask_prefix(netmask)
                entries.append({
                    "name": name,
                    "ip": address,
                    "netmask": netmask,
                    "broadcast": _broadcast_for_prefix(address, prefix) if prefix else None,
                })
        except OSError:
            entries = []
        finally:
            if sock is not None:
                sock.close()
    if not entries:      # Windows 没有 fcntl：退回现有 _local_ipv4s 候选
        netmasks = _iface_netmasks()
        for ip in _local_ipv4s():
            netmask = str(netmasks.get(ip) or "")
            prefix = _mask_prefix(netmask) if netmask else None
            entries.append({
                "name": "",
                "ip": ip,
                "netmask": netmask,
                "broadcast": _broadcast_for_prefix(ip, prefix) if prefix else None,
            })
    return entries


def _directed_broadcasts(ip: str, netmask: Optional[str] = None) -> List[str]:
    """一个本机 IPv4 候选的定向广播（去重、保序）。

    有真实掩码就按它算准的那一条；没有就按 BROADCAST_PREFIXES 逐档猜。
    真实掩码比 /24 粗时（/23、/16…）额外补 /24 那条，和旧版本行为兼容；
    比 /24 细时（/25 以上）不再猜 /24，免得往不在本子网里的地址发。"""
    prefix = _mask_prefix(netmask) if netmask else None
    if prefix is None:
        candidates = list(BROADCAST_PREFIXES)
    elif prefix > 24:
        candidates = [prefix]
    else:
        candidates = [prefix, 24]
    targets: List[str] = []
    for item in candidates:
        target = _broadcast_for_prefix(ip, item)
        if target and target not in targets:
            targets.append(target)
    return targets


def broadcast_targets() -> List[str]:
    """VPN / 多网卡 / 非 /24 网段下 255.255.255.255 可能不可达：
    每个本机 IPv4 再补一份定向广播（有真实掩码按掩码算，拿不到按常见前缀猜）。"""
    netmasks = _iface_netmasks()
    targets: List[str] = []
    for ip in _local_ipv4s():
        for target in _directed_broadcasts(ip, netmasks.get(ip)):
            if target not in targets:
                targets.append(target)
    if DISCOVERY_BROADCAST not in targets:
        targets.append(DISCOVERY_BROADCAST)
    return targets


def _version() -> str:
    value = deps.get("APP_VERSION")
    return str(value or "novai-v16")


def _proxy_info() -> Dict[str, Any]:
    """诊断用：环境变量代理 / 系统代理是否开着（不联网，只读配置）。"""
    env_keys: List[str] = []
    for key, value in os.environ.items():
        if key.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy") and str(value or "").strip():
            env_keys.append(key.lower())
    system_keys: List[str] = []
    try:
        if sys.platform == "darwin":
            from _scproxy import getproxies as _system_proxies
            detected = _system_proxies() or {}
        else:
            detected = urllib.request.getproxies_registry() or {}
    except Exception:
        detected = {}
    for key, value in (detected or {}).items():
        name = str(key or "").lower()
        if name in ("no", "no_proxy") or not str(value or "").strip():
            continue
        if name not in env_keys:
            system_keys.append(name)
    detected = bool(env_keys or system_keys)
    hint = "局域网请求已强制直连，系统代理只影响公网请求" if detected else ""
    return {
        # 旧字段保持
        "env": sorted(set(env_keys)),
        "system": sorted(set(system_keys)),
        "detected": detected,
        "lan_requests_direct": True,
        "hint": hint,
        # 新增别名：前端不必再判断数组是否为空
        "env_proxy": bool(env_keys),
        "system_proxy": bool(system_keys),
        "note": hint or "未检测到系统代理或环境变量代理；局域网请求始终直连",
    }


# ---------------------------------------------------------------- 好友码

def derive_account_code(account_id: Any) -> str:
    """短码只由账号 id 派生：改昵称 / 头像 / IP 都不换码，对方记住的码一直有效。
    前 8 字节取整数后映射到 100000..999999，永远 6 位、无前导 0。"""
    digest = hashlib.sha256(("novai-lan-code:" + str(account_id or "")).encode("utf-8")).digest()
    value = int.from_bytes(digest[:8], "big")
    return str(100000 + value % 900000)


def account_code(account: Dict[str, Any]) -> str:
    current = str(account.get("code") or "").strip().upper()
    if SHORT_CODE_RE.match(current):
        return current
    return derive_account_code(account.get("id"))


def friend_code_of(account: Dict[str, Any]) -> str:
    return SHORT_CODE_PREFIX + account_code(account)


def parse_friend_code(code: Any) -> Optional[Dict[str, str]]:
    """旧码 'NOVAI-IP:端口-口令' 返 {kind: legacy, ip, port, token, base_url}；
    新码 'NOVAI-<CODE>' / 裸 '<CODE>' 返 {kind: short, code}（地址要靠局域网发现补）；
    不合法返回 None。旧码必须一直能解析，已经发出去的好友码不能失效。"""
    text = str(code or "").strip().replace(" ", "")
    match = FRIEND_CODE_RE.match(text)
    if match:
        ip, port, token = match.group(1), match.group(2), match.group(3)
        port_int = int(port)
        if port_int < 1 or port_int > 65535:
            return None
        return {"kind": "legacy", "ip": ip, "port": port, "token": token,
                "base_url": "http://%s:%s" % (ip, port)}
    candidate = text[len(SHORT_CODE_PREFIX):] if text[:len(SHORT_CODE_PREFIX)].upper() == SHORT_CODE_PREFIX else text
    short = candidate.strip().upper()
    if SHORT_CODE_RE.match(short) or LEGACY_SHORT_CODE_RE.match(short):
        return {"kind": "short", "code": short}
    return None


def _normalize_base_url(value: Any) -> str:
    text = str(value or "").strip().rstrip("/")
    if not text:
        return ""
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return ""
    return text[:MAX_URL]


def _source_ip(request: Optional[Request]) -> str:
    """这次请求真实的来源 IPv4（局域网直连时就是对方网卡地址）；拿不到 / 回环返回空串。"""
    try:
        host = str(getattr(getattr(request, "client", None), "host", "") or "").strip()
        address = ipaddress.ip_address(host)
    except (ValueError, TypeError):
        return ""
    if address.version != 4 or address.is_loopback or address.is_unspecified:
        return ""
    return str(address)


def _rehost_url(url: Any, old_host: str, new_host: str) -> str:
    """把对方自报地址里的主机换成真实来源 IP（端口 / 路径 / 口令不动）。"""
    text = str(url or "")
    if not text or not new_host:
        return text
    try:
        parts = urllib.parse.urlsplit(text)
    except ValueError:
        return text
    host = str(parts.hostname or "")
    if not host or host == new_host or (old_host and host != old_host):
        return text
    netloc = new_host + (":%d" % parts.port if parts.port else "")
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def _peer_base_from_request(request: Optional[Request], claimed: Any) -> str:
    """对方自报的 base_url 可能是 VPN / TUN 虚拟网卡地址（198.18.x.x 等），别人连不上；
    局域网直连收到的请求，来源 IP 才是真的可达地址：主机用来源 IP，端口仍用自报的。"""
    base = _normalize_base_url(claimed)
    source = _source_ip(request)
    if not base or not source:
        return base
    return _rehost_url(base, "", source)


def _valid_friend_id(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not FRIEND_ID_RE.match(text):
        raise HTTPException(status_code=400, detail="好友 ID 不合法")
    return text


# ---------------------------------------------------------------- 账号归属
# 一台机器可以同时有多个局域网身份：登录云账号时按账号隔离，没登录 / 鉴权关闭时用
# 「无归属桶」_local（就是升级前的整机一份，行为不变）。
# 归属键直接用在文件名里：无归属 = _local，云账号 = u<id>。

OWNER_LOCAL = "_local"
_OWNER_STATE = threading.local()
_SCHEMA_LOCK = threading.Lock()
_SCHEMA_DONE: Dict[str, bool] = {}


def owner_key(account_id: Any) -> str:
    """云账号 id -> 归属键；不是正整数就返回空串（调用方退回 _local）。"""
    text = str(account_id or "").strip()
    if text.isdigit() and int(text) > 0:
        return "u" + str(int(text))
    if re.match(r"^u[1-9]\d{0,18}$", text):
        return text
    return ""


def normalize_owner(value: Any) -> str:
    text = str(value or "").strip()
    if text == OWNER_LOCAL:
        return OWNER_LOCAL
    return owner_key(text) or OWNER_LOCAL


def current_owner() -> str:
    return getattr(_OWNER_STATE, "owner", OWNER_LOCAL) or OWNER_LOCAL


@contextlib.contextmanager
def use_owner(owner: Any):
    """在这段代码里按指定账号读写局域网数据（后台线程 / 好友机投递都用它）。"""
    previous = current_owner()
    _OWNER_STATE.owner = normalize_owner(owner)
    try:
        yield current_owner()
    finally:
        _OWNER_STATE.owner = previous


def _session_owner(request: Optional[Request]) -> str:
    """当前页面所属账号：优先用鉴权中间件放好的 user，其次自己查一次会话 cookie。"""
    if request is None:
        return ""
    user = getattr(getattr(request, "state", None), "auth_user", None)
    key = owner_key((user or {}).get("id")) if isinstance(user, dict) else ""
    if key:
        return key
    hook = deps.get("LAN_SESSION_OWNER")
    if callable(hook):
        try:
            return owner_key(hook(request))
        except Exception:
            return ""
    try:
        from server.auth import service as auth_service
        token = request.cookies.get(auth_service.COOKIE_NAME, "")
        if not token:
            return ""
        return owner_key((auth_service.session_user(token) or {}).get("id"))
    except Exception:
        return ""


def owner_from_request(request: Optional[Request]) -> str:
    return _session_owner(request) or OWNER_LOCAL


def owner_impact(owner: Any) -> Dict[str, int]:
    """注销确认清单用（只读）：这个归属桶里的局域网身份 / 好友 / 好友申请 / 聊天条数。"""
    key = normalize_owner(owner)
    counts: Dict[str, int] = {"account": 0, "friends": 0, "requests": 0, "chat_messages": 0}
    if not key.startswith("u"):
        return counts
    _ensure_schema()
    try:
        accounts = _account_store().get("accounts") or {}
        counts["account"] = 1 if key in accounts else 0
    except Exception:
        pass
    try:
        counts["friends"] = len(load_friends(owner=key))
    except Exception:
        pass
    try:
        raw = _read_json(friend_requests_path(), None)
        if isinstance(raw, dict):
            for section in ("incoming", "outgoing"):
                mapping = raw.get(section)
                if isinstance(mapping, dict):
                    counts["requests"] += len(mapping.get(key) or [])
    except Exception:
        pass
    chat_dir = os.path.join(data_dir(), CHAT_DIR, key)
    try:
        if os.path.isdir(chat_dir):
            for name in os.listdir(chat_dir):
                if not name.endswith(".json"):
                    continue
                raw = _read_json(os.path.join(chat_dir, name), None)
                items = raw.get("messages") if isinstance(raw, dict) else raw
                if isinstance(items, list):
                    counts["chat_messages"] += len(items)
    except Exception:
        pass
    return counts


def _account_path() -> str:
    return os.path.join(data_dir(), ACCOUNT_FILE)


def _account_store() -> Dict[str, Any]:
    _ensure_schema()
    raw = _read_json(_account_path(), None)
    if not isinstance(raw, dict) or not isinstance(raw.get("accounts"), dict):
        return {"version": SCHEMA_VERSION, "accounts": {}, "legacy_unclaimed": False}
    return raw


def load_accounts() -> Dict[str, Dict[str, Any]]:
    """全部局域网身份 {归属键: 账号}；机器级逻辑（广播 / 口令校验）用它。"""
    accounts = _account_store().get("accounts") or {}
    return {str(key): dict(value) for key, value in accounts.items()
            if isinstance(value, dict) and value.get("id") and value.get("token")}


def save_accounts(store: Dict[str, Any]) -> None:
    store["version"] = SCHEMA_VERSION
    _write_atomic(_account_path(), store)
    try:
        _reset_local_ids()
    except Exception:
        pass


def primary_account() -> Dict[str, Any]:
    """机器级「门面」身份：老客户端只认一个码，优先给无归属桶，没有再取第一个账号。"""
    accounts = load_accounts()
    if OWNER_LOCAL in accounts:
        return accounts[OWNER_LOCAL]
    if not accounts:
        return {}
    return accounts[sorted(accounts.keys())[0]]


def owner_for_token(token: Any) -> str:
    """好友机带 X-NOVAI-Friend-Token 来投递时，这个口令属于哪个本地身份。"""
    given = str(token or "")
    if not given:
        return ""
    for key, account in load_accounts().items():
        expected = str(account.get("token") or "")
        if expected and hmac.compare_digest(given, expected):
            return key
    return ""


def _claim_legacy(owner: str) -> None:
    """升级后第一个登录账号：把「无归属桶」里的整机旧数据整体搬给它，只搬一次。"""
    if not owner or owner == OWNER_LOCAL:
        return
    _ensure_schema()
    with _SCHEMA_LOCK:
        store = _account_store()
        if not store.get("legacy_unclaimed"):
            return
        accounts = store.setdefault("accounts", {})
        local = accounts.pop(OWNER_LOCAL, None)
        if local and owner not in accounts:
            accounts[owner] = local
        store["legacy_unclaimed"] = False
        save_accounts(store)
        _move_bucket(OWNER_LOCAL, owner)
        print("[LAN] 整机旧局域网数据已归到账号 %s（只迁一次）" % owner, flush=True)


def _move_bucket(source: str, target: str) -> None:
    """好友 / 好友申请 / 聊天目录 从 source 桶搬到 target 桶（已有内容按 id 合并）。"""
    source, target = owner_key(source) or source, owner_key(target) or target
    if not source or not target or source == target:
        return
    try:
        raw = _read_json(friends_path(), None)
        mapping = raw.get("friends") if isinstance(raw, dict) else None
        if isinstance(mapping, dict):
            items = mapping.pop(source, None)
            if isinstance(items, list) and items:
                merged = {str(item.get("id")): item for item in (mapping.get(target) or []) if isinstance(item, dict)}
                for item in items:
                    if isinstance(item, dict):
                        merged.setdefault(str(item.get("id")), item)
                mapping[target] = list(merged.values())
            _write_atomic(friends_path(), {"version": SCHEMA_VERSION, "friends": mapping})
    except Exception as exc:
        print("[LAN] 旧好友数据迁移失败（不影响新数据）：%s" % exc, flush=True)
    try:
        raw = _read_json(friend_requests_path(), None)
        if isinstance(raw, dict):
            changed = False
            for section in ("incoming", "outgoing"):
                mapping = raw.get(section)
                if not isinstance(mapping, dict):
                    continue
                items = mapping.pop(source, None)
                if isinstance(items, list) and items:
                    mapping[target] = list(mapping.get(target) or []) + items
                    changed = True
            if changed:
                _write_atomic(friend_requests_path(), raw)
    except Exception as exc:
        print("[LAN] 旧好友申请迁移失败（不影响新数据）：%s" % exc, flush=True)
    try:
        src_dir = os.path.join(data_dir(), CHAT_DIR, source)
        dst_dir = os.path.join(data_dir(), CHAT_DIR, target)
        if os.path.isdir(src_dir):
            os.makedirs(dst_dir, exist_ok=True)
            for name in os.listdir(src_dir):
                if not name.endswith(".json"):
                    continue
                src = os.path.join(src_dir, name)
                dst = os.path.join(dst_dir, name)
                if os.path.exists(dst):
                    continue
                os.replace(src, dst)
            try:
                os.rmdir(src_dir)
            except OSError:
                pass
    except Exception as exc:
        print("[LAN] 旧聊天记录迁移失败（不影响新数据）：%s" % exc, flush=True)


def _ensure_schema() -> None:
    """v1（整机一份）升到 v2（按 owner 分桶）；每个数据目录只做一次。"""
    root = data_dir()
    if _SCHEMA_DONE.get(root):
        return
    with _SCHEMA_LOCK:
        if _SCHEMA_DONE.get(root):
            return
        try:
            _migrate_v1(root)
        except Exception as exc:
            print("[LAN] 局域网数据升级失败（按旧结构继续可用）：%s" % exc, flush=True)
        _SCHEMA_DONE[root] = True


def _migrate_v1(root: str) -> None:
    changed = False
    raw = _read_json(_account_path(), None)
    if isinstance(raw, dict) and raw.get("id") and not isinstance(raw.get("accounts"), dict):
        store = {"version": SCHEMA_VERSION, "accounts": {OWNER_LOCAL: raw},
                 "legacy_unclaimed": True, "migrated_at": now_ms()}
        save_accounts(store)
        changed = True
    raw = _read_json(friends_path(), None)
    if isinstance(raw, dict) and isinstance(raw.get("friends"), list):
        _write_atomic(friends_path(), {"version": SCHEMA_VERSION, "friends": {OWNER_LOCAL: raw["friends"]}})
        changed = True
    raw = _read_json(friend_requests_path(), None)
    if isinstance(raw, dict) and (isinstance(raw.get("incoming"), list) or isinstance(raw.get("outgoing"), list)):
        _write_atomic(friend_requests_path(), {
            "version": SCHEMA_VERSION,
            "incoming": {OWNER_LOCAL: raw.get("incoming") or []},
            "outgoing": {OWNER_LOCAL: raw.get("outgoing") or []},
        })
        changed = True
    chat_root = os.path.join(data_dir(), CHAT_DIR)
    if os.path.isdir(chat_root):
        legacy = [name for name in os.listdir(chat_root)
                  if name.endswith(".json") and os.path.isfile(os.path.join(chat_root, name))]
        if legacy:
            target = os.path.join(chat_root, OWNER_LOCAL)
            os.makedirs(target, exist_ok=True)
            for name in legacy:
                os.replace(os.path.join(chat_root, name), os.path.join(target, name))
            changed = True
    if changed:
        print("[LAN] 局域网数据已升级为按账号分桶（旧数据暂存 %s，第一个登录账号会接手）" % OWNER_LOCAL, flush=True)


def load_account(owner: Optional[str] = None) -> Dict[str, Any]:
    _ensure_schema()
    key = owner or current_owner()
    store = _account_store()
    accounts = store.setdefault("accounts", {})
    raw = accounts.get(key)
    if isinstance(raw, dict) and str(raw.get("token") or "") and str(raw.get("id") or ""):
        # 老账号文件没有短码：第一次读到时补上并写回，之后所有人看到的都是同一个码
        code = account_code(raw)
        if str(raw.get("code") or "") != code:
            raw["code"] = code
            save_account(raw, key)
        return raw
    account = {
        "version": SCHEMA_VERSION,
        "id": secrets.token_hex(8),
        "token": secrets.token_hex(ACCOUNT_TOKEN_BYTES),
        "nickname": DEFAULT_NICKNAME,
        "avatar": DEFAULT_AVATAR,
        "created_at": now_ms(),
        "updated_at": now_ms(),
    }
    account["code"] = account_code(account)
    accounts[key] = account
    # 没有任何云账号时，无归属桶里的数据就是「整机旧数据」，等第一个登录账号接手
    if key == OWNER_LOCAL and not any(other != OWNER_LOCAL for other in accounts):
        store["legacy_unclaimed"] = True
    save_accounts(store)
    return account


def save_account(account: Dict[str, Any], owner: Optional[str] = None) -> None:
    key = owner or current_owner()
    store = _account_store()
    accounts = store.setdefault("accounts", {})
    accounts[key] = account
    save_accounts(store)


def _sanitize_avatar(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return DEFAULT_AVATAR
    if text.startswith("data:image/"):
        if len(text.encode("utf-8")) > MAX_AVATAR_BYTES:
            raise HTTPException(status_code=400, detail="头像图片太大（上限 200KB）")
        if ";base64," not in text:
            raise HTTPException(status_code=400, detail="头像格式不支持")
        return text
    if len(text) > 8:
        raise HTTPException(status_code=400, detail="头像只能是一个 emoji 或一张小图")
    return text


def direct_code_of(account: Dict[str, Any]) -> str:
    """完整好友码：自动发现不可用时唯一能手动加好友的路子，回环地址下没有意义。"""
    token = str(account.get("token") or "")
    ip = _lan_ip()
    if not token or not ip or ip.startswith("127."):
        return ""
    return "NOVAI-%s:%s-%s" % (ip, _port(), token)


def me_payload(account: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": str(account.get("id") or ""),
        "nickname": str(account.get("nickname") or DEFAULT_NICKNAME),
        "avatar": str(account.get("avatar") or DEFAULT_AVATAR),
        "code": account_code(account),
        "friend_code": friend_code_of(account),
        "direct_code": direct_code_of(account),
        "lan_ip": _lan_ip(),
        "port": _port(),
        "version": _version(),
    }


# ---------------------------------------------------------------- 好友存储

def friends_path() -> str:
    return os.path.join(data_dir(), FRIENDS_FILE)


def load_friends(owner: Optional[str] = None) -> List[Dict[str, Any]]:
    _ensure_schema()
    key = normalize_owner(owner) if owner else current_owner()
    raw = _read_json(friends_path(), None)
    mapping = raw.get("friends") if isinstance(raw, dict) else None
    if isinstance(mapping, dict):
        items = mapping.get(key) or []
    elif isinstance(mapping, list):        # 兜底：还没升级完的老结构
        items = mapping
    else:
        items = []
    cleaned: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        friend_id = str(item.get("id") or "")
        if not FRIEND_ID_RE.match(friend_id):
            continue
        cleaned.append(item)
    return cleaned


def save_friends(friends: List[Dict[str, Any]], owner: Optional[str] = None) -> None:
    _ensure_schema()
    key = normalize_owner(owner) if owner else current_owner()
    raw = _read_json(friends_path(), None)
    mapping = raw.get("friends") if isinstance(raw, dict) else None
    if not isinstance(mapping, dict):
        mapping = {}
    mapping[key] = friends
    _write_atomic(friends_path(), {"version": SCHEMA_VERSION, "friends": mapping})


def find_friend(friend_id: str) -> Optional[Dict[str, Any]]:
    wanted = str(friend_id or "")
    for item in load_friends():
        if str(item.get("id")) == wanted:
            return item
    return None


def _upsert_friend(friend: Dict[str, Any]) -> Dict[str, Any]:
    """按 id 合并好友记录（自动加好友与手动加好友共用）。"""
    with _LOCK:
        friends = load_friends()
        current = next((item for item in friends if str(item.get("id")) == str(friend.get("id"))), None)
        if current is None:
            current = {"id": str(friend.get("id")), "added_at": now_ms(), "added_by": str(friend.get("added_by") or "code")}
            friends.append(current)
        for key in ("nickname", "avatar", "base_url", "token", "last_seen", "code"):
            value = friend.get(key)
            if value is not None and str(value) != "":
                current[key] = value
        current["nickname"] = str(current.get("nickname") or "好友")[:MAX_NICKNAME]
        current["avatar"] = str(current.get("avatar") or DEFAULT_AVATAR)
        save_friends(friends)
        return dict(current)


def _drop_friend(friend_id: str) -> bool:
    with _LOCK:
        friends = load_friends()
        kept = [item for item in friends if str(item.get("id")) != friend_id]
        if len(kept) == len(friends):
            return False
        save_friends(kept)
    try:
        os.remove(chat_path(friend_id))
    except OSError:
        pass
    return True


# ---------------------------------------------------------------- 好友请求存储

def friend_requests_path() -> str:
    return os.path.join(data_dir(), FRIEND_REQUESTS_FILE)


def _clean_request_peer(value: Any) -> Dict[str, Any]:
    peer = value if isinstance(value, dict) else {}
    cleaned: Dict[str, Any] = {
        "id": str(peer.get("id") or "").strip().lower(),
        "nickname": str(peer.get("nickname") or "")[:MAX_NICKNAME],
        "avatar": str(peer.get("avatar") or DEFAULT_AVATAR),
        "base_url": _normalize_base_url(peer.get("base_url")),
        "code": str(peer.get("code") or "")[:16],
    }
    # incoming 里存对方口令（同意 / 拒绝时要回调对方）；outgoing 不存，等对方把结果带回来
    token = str(peer.get("token") or "")
    if token:
        cleaned["token"] = token
    return cleaned


def _clean_requests(items: Any, peer_key: str) -> List[Dict[str, Any]]:
    """读文件时统一清洗：id / 对方 id 不合法就丢，超过 7 天也丢，最后只留最近 50 条。"""
    cutoff = now_ms() - FRIEND_REQUEST_TTL_MS
    cleaned: List[Dict[str, Any]] = []
    if not isinstance(items, list):
        return cleaned
    for item in items:
        if not isinstance(item, dict):
            continue
        request_id = str(item.get("id") or "").strip().lower()
        peer = _clean_request_peer(item.get(peer_key))
        if not FRIEND_REQUEST_ID_RE.match(request_id) or not FRIEND_ID_RE.match(peer["id"]):
            continue
        ts = int(item.get("ts") or 0)
        if ts and ts < cutoff:
            continue
        status = str(item.get("status") or "pending")
        if status not in ("pending", "accepted", "rejected", "failed"):
            status = "pending"
        record: Dict[str, Any] = {
            "id": request_id,
            "ts": ts or now_ms(),
            "status": status,
            peer_key: peer,
        }
        error = str(item.get("error") or "")
        if error:
            record["error"] = error[:200]
        cleaned.append(record)
    cleaned.sort(key=lambda entry: (int(entry.get("ts") or 0), str(entry.get("id") or "")))
    return cleaned[-MAX_FRIEND_REQUESTS:]


def _request_bucket(raw: Any, section: str, key: str) -> Any:
    """从请求文件里取某个 owner 的那一段；兼容还没升级的 list 结构。"""
    if not isinstance(raw, dict):
        return []
    mapping = raw.get(section)
    if isinstance(mapping, dict):
        return mapping.get(key) or []
    if isinstance(mapping, list):
        return mapping
    return []


def _load_friend_requests(owner: Optional[str] = None) -> Dict[str, List[Dict[str, Any]]]:
    _ensure_schema()
    key = normalize_owner(owner) if owner else current_owner()
    raw = _read_json(friend_requests_path(), None)
    return {
        "incoming": _clean_requests(_request_bucket(raw, "incoming", key), "from"),
        "outgoing": _clean_requests(_request_bucket(raw, "outgoing", key), "to"),
    }


def _save_friend_requests(data: Dict[str, List[Dict[str, Any]]], owner: Optional[str] = None) -> None:
    _ensure_schema()
    key = normalize_owner(owner) if owner else current_owner()
    raw = _read_json(friend_requests_path(), None)
    payload: Dict[str, Any] = {"version": SCHEMA_VERSION}
    for section, peer_key in (("incoming", "from"), ("outgoing", "to")):
        mapping = raw.get(section) if isinstance(raw, dict) else None
        if not isinstance(mapping, dict):
            mapping = {}
        mapping[key] = _clean_requests(data.get(section), peer_key)
        payload[section] = mapping
    _write_atomic(friend_requests_path(), payload)


def _upsert_incoming(record: Dict[str, Any]) -> Dict[str, Any]:
    """同一个请求方再投一次就替换旧记录（拒绝之后允许重新请求）。"""
    peer_id = str((record.get("from") or {}).get("id") or "")
    cleaned = _clean_requests([record], "from")
    stored = cleaned[-1] if cleaned else record
    with _REQUESTS_LOCK:
        data = _load_friend_requests()
        kept = [item for item in data["incoming"] if str((item.get("from") or {}).get("id")) != peer_id]
        kept.append(stored)
        data["incoming"] = kept
        _save_friend_requests(data)
    return stored


def _upsert_outgoing(record: Dict[str, Any]) -> Dict[str, Any]:
    peer_id = str((record.get("to") or {}).get("id") or "")
    cleaned = _clean_requests([record], "to")
    stored = cleaned[-1] if cleaned else record
    with _REQUESTS_LOCK:
        data = _load_friend_requests()
        kept = [item for item in data["outgoing"] if str((item.get("to") or {}).get("id")) != peer_id]
        kept.append(stored)
        data["outgoing"] = kept
        _save_friend_requests(data)
    return stored


def _find_request(section: str, request_id: str) -> Optional[Dict[str, Any]]:
    for item in _load_friend_requests().get(section) or []:
        if str(item.get("id")) == request_id:
            return dict(item)
    return None


def _set_request_status(section: str, request_id: str, status: str, error: str = "",
                        clear_error: bool = False) -> bool:
    with _REQUESTS_LOCK:
        data = _load_friend_requests()
        found = False
        for item in data.get(section) or []:
            if str(item.get("id")) != request_id:
                continue
            item["status"] = status
            if error:
                item["error"] = error[:200]
            elif clear_error:
                item.pop("error", None)
            found = True
        if found:
            _save_friend_requests(data)
        return found


# ---------------------------------------------------------------- 聊天媒体（图片 / 视频）

def media_dir() -> str:
    return os.path.join(data_dir(), MEDIA_DIR)


def _media_kind_ext(content_type: Any) -> Tuple[str, str]:
    """content-type -> (kind, 扩展名)；不在白名单返回 ("", "")。"""
    value = str(content_type or "").split(";", 1)[0].strip().lower()
    return MEDIA_TYPES.get(value, ("", ""))


def _media_sig(media_id: Any) -> str:
    """单个聊天媒体的访问签名：HMAC(本机局域网口令, media_id)。只能取这一个文件，
    以前直接把整机口令拼在 ?token= 上，拿到图片地址的人能调本机全部接口。"""
    loader = deps.get("LOAD_LAN_TOKEN")
    secret = ""
    if callable(loader):
        try:
            secret = str(loader() or "")
        except Exception:
            secret = ""
    if not secret:
        return ""
    stem = str(media_id or "").strip().lower().split(".", 1)[0]
    return hmac.new(secret.encode("utf-8"), ("lan-media:" + stem).encode("utf-8"), "sha256").hexdigest()[:32]


def _media_url(media_id: str) -> str:
    """给聊天用的绝对地址：对方浏览器不在本机，必须带 IP 和端口。
    开了局域网口令时再追一个只对这个文件有效的 sig（不再带整机口令）。"""
    url = "http://%s:%s/api/lan/media/%s" % (_lan_ip(), _port(), urllib.parse.quote(str(media_id)))
    enabled = deps.get("LAN_AUTH_ENABLED")
    if callable(enabled):
        try:
            if enabled():
                sig = _media_sig(media_id)
                if sig:
                    url += "?sig=" + sig
        except Exception:
            pass
    return url


def _media_path(media_id: Any) -> str:
    """media_id -> 落盘路径；只认 16..40 位十六进制，可带白名单扩展名，其它一律空串。"""
    raw = str(media_id or "").strip().lower()
    stem, ext = raw, ""
    if "." in raw:
        stem, ext = raw.rsplit(".", 1)
        if "." + ext not in MEDIA_EXTENSIONS:
            return ""
    if not MEDIA_ID_RE.match(stem):
        return ""
    folder = media_dir()
    if ext:
        path = os.path.join(folder, stem + "." + ext)
        return path if os.path.isfile(path) else ""
    for candidate in MEDIA_EXTENSIONS:
        path = os.path.join(folder, stem + candidate)
        if os.path.isfile(path):
            return path
    return ""


def _sanitize_media_url(value: Any) -> str:
    """媒体地址和画布分享链接同一套校验：只认 http(s)，长度 <= 2048。"""
    return _sanitize_share_url(value)


def _sanitize_media_name(value: Any) -> str:
    text = str(value or "").replace("\\", "/").split("/")[-1].strip()
    return text[:MEDIA_MAX_NAME]


def _sanitize_media_size(value: Any) -> int:
    try:
        size = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, min(size, 1024 * 1024 * 1024))


# ---------------------------------------------------------------- 聊天存储

def chat_path(friend_id: str, owner: Optional[str] = None) -> str:
    key = normalize_owner(owner) if owner else current_owner()
    return os.path.join(data_dir(), CHAT_DIR, key, _valid_friend_id(friend_id) + ".json")


def load_chat(friend_id: str, owner: Optional[str] = None) -> List[Dict[str, Any]]:
    raw = _read_json(chat_path(friend_id, owner), None)
    items = raw.get("messages") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict) and str(item.get("id") or "")]


def save_chat(friend_id: str, messages: List[Dict[str, Any]], owner: Optional[str] = None) -> None:
    trimmed = messages[-MAX_MESSAGES:] if len(messages) > MAX_MESSAGES else messages
    _write_atomic(chat_path(friend_id, owner),
                  {"version": SCHEMA_VERSION, "friend_id": friend_id, "messages": trimmed})


def append_message(friend_id: str, message: Dict[str, Any]) -> bool:
    """追加一条消息；同 id 已存在则幂等返回 False（不写盘）。"""
    with _LOCK:
        messages = load_chat(friend_id)
        if any(str(item.get("id")) == str(message.get("id")) for item in messages):
            return False
        messages.append(message)
        save_chat(friend_id, messages)
        return True


def put_outgoing(friend_id: str, message: Dict[str, Any]) -> bool:
    """发出/重发同一条消息：同 id 已存在就覆盖（重发后状态从 failed 变 sent），否则追加。"""
    with _LOCK:
        messages = load_chat(friend_id)
        replaced = False
        for index, item in enumerate(messages):
            if str(item.get("id")) == str(message.get("id")):
                messages[index] = message
                replaced = True
                break
        if not replaced:
            messages.append(message)
        save_chat(friend_id, messages)
        return not replaced


def unread_of(messages: List[Dict[str, Any]]) -> int:
    return sum(1 for item in messages if str(item.get("dir")) == "in" and not bool(item.get("read")))


def last_message_of(messages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """右下角新消息弹窗只要一句预览：取最后一条非系统消息，前端因此不用再打一次 messages 接口。"""
    latest: Optional[Dict[str, Any]] = None
    for item in messages:
        if not isinstance(item, dict) or str(item.get("kind")) == "system":
            continue
        if latest is None or (int(item.get("ts") or 0), str(item.get("id") or "")) >= (
                int(latest.get("ts") or 0), str(latest.get("id") or "")):
            latest = item
    if latest is None:
        return None
    kind = _message_kind(latest.get("kind"))
    payload: Dict[str, Any] = {
        "kind": kind,
        "text": _sanitize_text(latest.get("text"), MAX_TEXT),
        "ts": int(latest.get("ts") or 0),
        "dir": "in" if str(latest.get("dir")) == "in" else "out",
    }
    if kind in ("image", "video"):
        # 右下角弹窗只看 kind 就能显示「[图片] / [视频]」，有 caption 时前端再拼上
        payload["media_url"] = str(latest.get("media_url") or "")
        payload["media_name"] = str(latest.get("media_name") or "")
        payload["media_size"] = int(latest.get("media_size") or 0)
    return payload


def merge_messages(messages: List[Dict[str, Any]], after: int = 0) -> List[Dict[str, Any]]:
    """按 ts 升序（同 ts 用 id 兜底）合并；after 之后（不含）的消息。"""
    kept = [dict(item) for item in messages if int(item.get("ts") or 0) > int(after or 0)]
    kept.sort(key=lambda item: (int(item.get("ts") or 0), str(item.get("id") or "")))
    return kept


def mark_read(friend_id: str) -> int:
    with _LOCK:
        messages = load_chat(friend_id)
        changed = False
        for item in messages:
            if str(item.get("dir")) == "in" and not bool(item.get("read")):
                item["read"] = True
                changed = True
        if changed:
            save_chat(friend_id, messages)
        return unread_of(messages)


# ---------------------------------------------------------------- 投递 / 自动补发
# 失败不判死：先重新发现地址再投一次，仍失败才落 status=pending，后台线程每 3s 补一次。
# 对方 /api/lan/messages 按 message_id 去重，补发不会产生重复消息。

_PENDING_LOCK = threading.Lock()
_PENDING_FRIENDS: Dict[str, float] = {}
_RETRY_STARTED = False
AUTO_RETRY = True                    # 测试可关掉后台线程，改成手动调 retry_pending_once()


def _message_wire(message: Dict[str, Any]) -> Dict[str, Any]:
    """落库结构 -> 发给对方的 wire 结构（补发时按同一份数据重建请求）。"""
    return {
        "id": str(message.get("id") or ""),
        "kind": _message_kind(message.get("kind")),
        "text": str(message.get("text") or ""),
        "share_url": str(message.get("share_url") or ""),
        "canvas_title": str(message.get("canvas_title") or ""),
        "ts": int(message.get("ts") or 0),
        "media_url": str(message.get("media_url") or ""),
        "media_name": str(message.get("media_name") or ""),
        "media_size": _sanitize_media_size(message.get("media_size")),
    }


def _deliver(friend: Dict[str, Any], message: Dict[str, Any],
             timeout: float = SEND_TIMEOUT) -> Tuple[bool, str, int]:
    """投递一条已落库的消息：返回 (成功?, 失败类型, HTTP 状态)。"""
    base = _normalize_base_url(friend.get("base_url"))
    if not base:
        return False, "no-address", 0
    body = {"from": _identity(load_account()), "message": _message_wire(message)}
    headers = {"X-NOVAI-Friend-Token": str(friend.get("token") or "")}
    try:
        status, data = _http_json(base + "/api/lan/messages", "POST", body, headers, timeout)
    except Exception as exc:
        return False, _error_kind(exc), 0
    if status == 200 and isinstance(data, dict) and bool(data.get("ok")):
        return True, "", status
    return False, "http", status


def _deliver_with_recovery(friend: Dict[str, Any], message: Dict[str, Any]) -> Tuple[bool, str, int]:
    """按记录投一次；连不上就主动要一次地址、按新地址再投一次。

    - 超时 / 连接被重置：可能只是抖一下，一定重试；
    - 拒连：先看发现表里对方是不是换了地址，换了才值得重试（真关机就快速失败）；
    - 对方明确拒收（HTTP 4xx/5xx）或没地址：重试没意义，直接交给上层判失败。"""
    ok, kind, status = _deliver(friend, message)
    if ok:
        return True, "", status
    if kind in ("http", "no-address"):
        return False, kind, status
    fresh = _peer_entry_for(friend) is not None
    moved = refresh_friend_address(friend)
    if not moved and not fresh:
        # 发现表里根本没有它（广播丢了 / 对方刚启动）才值得当场问一圈；
        # 表里有且地址没变说明地址是对的，多问一次只是白等 0.8s。
        solicit_peers()
        moved = refresh_friend_address(friend)
    if kind == "refused" and not moved:
        return False, kind, status
    ok, kind, status = _deliver(friend, message)
    if ok:
        return True, "", status
    return False, kind, status


def _pending_key(friend_id: str, owner: Optional[str] = None) -> str:
    return "%s|%s" % (normalize_owner(owner) if owner else current_owner(), str(friend_id or ""))


def mark_pending(friend_id: str, owner: Optional[str] = None) -> None:
    """把好友加入待补发队列（落库的 pending 消息由后台线程负责送出）。"""
    clean = str(friend_id or "")
    if not clean:
        return
    with _PENDING_LOCK:
        _PENDING_FRIENDS[_pending_key(clean, owner)] = now_ms()
    if AUTO_RETRY:
        _start_retry_thread()


def pending_entries() -> List[Tuple[str, str]]:
    with _PENDING_LOCK:
        keys = list(_PENDING_FRIENDS)
    entries: List[Tuple[str, str]] = []
    for key in keys:
        owner, _, friend_id = key.partition("|")
        if owner and friend_id:
            entries.append((owner, friend_id))
    return entries


def pending_friend_ids(owner: Optional[str] = None) -> List[str]:
    wanted = normalize_owner(owner) if owner else current_owner()
    return [friend_id for key_owner, friend_id in pending_entries() if key_owner == wanted]


def _unmark_pending(friend_id: str, owner: Optional[str] = None) -> None:
    with _PENDING_LOCK:
        _PENDING_FRIENDS.pop(_pending_key(friend_id, owner), None)


def _pending_messages(friend_id: str) -> List[Dict[str, Any]]:
    return [item for item in load_chat(friend_id)
            if str(item.get("dir")) == "out" and str(item.get("status")) == "pending"]


def retry_pending_once() -> Dict[str, int]:
    """一轮补发：每个有待补发消息的好友，在线就按落库顺序投一遍（按账号各自补）。"""
    stats = {"friends": 0, "delivered": 0, "failed": 0}
    for owner, friend_id in pending_entries():
        with use_owner(owner):
            friend = find_friend(friend_id)
            if not friend:
                _unmark_pending(friend_id, owner)
                continue
            messages = _pending_messages(friend_id)
            if not messages:
                _unmark_pending(friend_id, owner)
                continue
            if not bool(online_of(friend).get("online")):
                continue
            stats["friends"] += 1
            stuck = False
            for message in messages:
                ok, _kind, _status = _deliver(friend, message)
                if not ok:
                    stuck = True
                    stats["failed"] += 1
                    break
                message["status"] = "sent"
                put_outgoing(friend_id, message)
                stats["delivered"] += 1
            if not stuck:
                _unmark_pending(friend_id, owner)
    try:
        retry_callbacks_once()
    except Exception:
        pass
    return stats


def _retry_loop() -> None:
    while True:
        time.sleep(RETRY_INTERVAL)
        try:
            retry_pending_once()
        except Exception as exc:
            print("[LAN] 待补发消息重试失败（不影响其它功能）：%s" % exc, flush=True)


def _start_retry_thread() -> None:
    global _RETRY_STARTED
    with _PENDING_LOCK:
        if _RETRY_STARTED:
            return
        _RETRY_STARTED = True
    try:
        threading.Thread(target=_retry_loop, name="novai-lan-redeliver", daemon=True).start()
    except Exception as exc:
        with _PENDING_LOCK:
            _RETRY_STARTED = False
        print("[LAN] 待补发消息重试线程启动失败（不影响使用）：%s" % exc, flush=True)


# ---------------------------------------------------------------- 网络探测

class LanPeerTimeout(Exception):
    """对方在预算时间内没把响应读完（画布太大或网络太慢）。"""


class LanResponseTooLarge(Exception):
    """对方响应超过本机设置的上限（默认不限，只有显式配置才会出现）。"""


def _lan_json_max_bytes() -> int:
    """NOVAI_LAN_JSON_MAX_BYTES：未设置 / 空 / 0 = 不限；正数 = 字节上限。"""
    raw = str(os.environ.get("NOVAI_LAN_JSON_MAX_BYTES", "") or "").strip()
    if not raw:
        return 0
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 0
    return max(0, value)


def _json_budget_seconds(bytes_read: int) -> float:
    """基础 10s，每收到 10MB 加 10s，封顶 300s（50MB+ 首次打开允许更久）。"""
    steps = max(0, int(bytes_read)) / float(LAN_JSON_STEP_BYTES)
    return min(LAN_JSON_MAX_TIMEOUT, LAN_JSON_BASE_TIMEOUT + steps * LAN_JSON_STEP_SECONDS)


def _http_json(url: str, method: str = "GET", payload: Optional[Dict[str, Any]] = None,
               headers: Optional[Dict[str, str]] = None, timeout: float = PING_TIMEOUT) -> Tuple[int, Any]:
    """发一个 JSON 请求，返回 (status, body)。连接失败时抛 OSError。测试用 deps.LAN_HTTP_JSON 替换。
    响应体默认不限（NOVAI_LAN_JSON_MAX_BYTES 可设上限）；画布快照走 _http_json_stream。"""
    custom = deps.get("LAN_HTTP_JSON")
    if callable(custom):
        return custom(url, method, payload, headers, timeout)
    body: Optional[bytes] = None
    merged = dict(headers or {})
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        merged["Content-Type"] = "application/json"
    limit = _lan_json_max_bytes()
    request = urllib.request.Request(url, data=body, headers=merged, method=str(method or "GET").upper())
    opener = _LAN_DIRECT_OPENER.open if _is_lan_url(url) else urllib.request.urlopen
    try:
        with opener(request, timeout=timeout) as response:
            raw = response.read(limit + 1 if limit else -1)
            if limit and len(raw) > limit:
                raise LanResponseTooLarge("响应超过 %d MB" % max(1, limit // (1024 * 1024)))
            try:
                return int(response.status), json.loads(raw.decode("utf-8") or "{}")
            except ValueError:
                return int(response.status), {}
    except urllib.error.HTTPError as exc:
        raw = exc.read(65536)
        try:
            return int(exc.code), json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return int(exc.code), {}


async def _http_json_stream(url: str, method: str = "GET",
                            headers: Optional[Dict[str, str]] = None,
                            base_timeout: float = LAN_JSON_BASE_TIMEOUT) -> Tuple[int, Any]:
    """流式读取 JSON（httpx + 分块累积）：不预读整包、默认不设硬上限。
    超时按已收字节动态放宽（10s 起，每 10MB +10s，封顶 300s）；超时抛 LanPeerTimeout。"""
    import asyncio as _asyncio

    limit = _lan_json_max_bytes()
    merged = dict(headers or {})
    started = time.monotonic()
    received = bytearray()
    timeout = httpx.Timeout(base_timeout, connect=base_timeout, read=None, write=base_timeout, pool=base_timeout)
    try:
        # 局域网地址强制直连：HTTP(S)_PROXY / 系统代理不能接局域网请求
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout,
                                     trust_env=not _is_lan_url(url)) as client:
            async with client.stream(str(method or "GET").upper(), url, headers=merged) as response:
                status = int(response.status_code)
                if status >= 400:
                    raw = await response.aread()
                    try:
                        return status, json.loads(raw.decode("utf-8") or "{}")
                    except ValueError:
                        return status, {}
                iterator = response.aiter_bytes(LAN_JSON_CHUNK_BYTES).__aiter__()
                while True:
                    try:
                        chunk = await _asyncio.wait_for(iterator.__anext__(), base_timeout)
                    except StopAsyncIteration:
                        break
                    except _asyncio.TimeoutError as exc:
                        raise LanPeerTimeout("读取对方响应超时") from exc
                    if not chunk:
                        continue
                    received.extend(chunk)
                    if limit and len(received) > limit:
                        raise LanResponseTooLarge("响应超过 %d MB" % max(1, limit // (1024 * 1024)))
                    if time.monotonic() - started > _json_budget_seconds(len(received)):
                        raise LanPeerTimeout("响应体较大且读取超时")
    except httpx.TimeoutException as exc:
        raise LanPeerTimeout("读取对方响应超时") from exc
    try:
        return 200, json.loads(bytes(received).decode("utf-8") or "{}")
    except ValueError:
        return 200, {}


def _error_kind(exc: BaseException) -> str:
    """把连接异常分三档：timeout（连上了没回，值得重试）/ refused（对方没开，别重试）/ error。"""
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout"
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return "timeout"
    code = getattr(reason, "errno", None)
    if code in (61, 111, 10061):          # macOS / Linux / Windows: connection refused
        return "refused"
    if code in (60, 110):                  # ETIMEDOUT
        return "timeout"
    text = str(reason).lower()
    if "timed out" in text or "timeout" in text:
        return "timeout"
    if "refused" in text or "unreachable" in text:
        return "refused"
    return "error"


def _is_lan_host(host: Any) -> bool:
    """局域网地址：RFC1918 / 回环 / 链路本地 / *.local / 本机网卡 IP。"""
    value = str(host or "").strip().lower().strip("[]")
    if not value:
        return False
    if value in ("localhost", "0.0.0.0", "::1") or value.endswith(".local"):
        return True
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        try:
            return value in _local_ipv4s()
        except Exception:
            return False
    return bool(address.is_private or address.is_loopback or address.is_link_local)


def _is_lan_url(url: Any) -> bool:
    try:
        host = urllib.parse.urlsplit(str(url or "")).hostname or ""
    except ValueError:
        return False
    return _is_lan_host(host)


# 局域网地址强制直连：macOS 的 urllib 会读系统代理，把 192.168.x.x 的请求转给代理就永远连不上
_LAN_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _connect_error_text(kind: str) -> str:
    """502 文案按原因拆开：拒连 / 超时 / 其它网络错误各给一句可操作提示。"""
    if kind == "refused":
        return "对方拒绝了连接（端口没有监听）：确认对方开着 NOVAI，且防火墙放行 TCP 端口"
    if kind == "timeout":
        return "连接对方超时：对方电脑可能卡住或网络不稳，等两秒重试；两边都关掉 VPN 再试"
    return "网络不通：确认两台电脑在同一 WiFi / 网段，VPN 或代理可能挡了局域网直连"


def _http_json_attempt(url: str, method: str = "GET", payload: Optional[Dict[str, Any]] = None,
                       headers: Optional[Dict[str, str]] = None) -> Tuple[Optional[int], Any, str]:
    """一次局域网 JSON 请求：连不上返回 (None, {}, 失败类型)，HTTP 错误照常返回状态码。"""
    try:
        status, body = _http_json(url, method, payload, headers, ADD_FRIEND_TIMEOUT)
        return status, body, ""
    except Exception as exc:
        return None, {}, _error_kind(exc)


def _resolve_peer_target(target: Dict[str, Any]) -> Dict[str, Any]:
    """短码加好友重试前，按 30s 内的广播重新取一遍最新 ip / port / token。"""
    if str(target.get("kind") or "") != "short":
        return dict(target)
    peer = find_peer(target.get("code"))
    if not peer:
        return dict(target)
    ip = str(peer.get("ip") or "")
    try:
        port = int(peer.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    if not ip or not 0 < port < 65536:
        return dict(target)
    fresh = dict(target)
    fresh["ip"] = ip
    fresh["port"] = str(port)
    fresh["base_url"] = "http://%s:%d" % (ip, port)
    token = str(peer.get("token") or "")
    if token:
        fresh["token"] = token
    return fresh


def _ping_friend(target: Dict[str, Any]) -> Tuple[int, Any, Dict[str, Any]]:
    """加好友前 ping：第一次失败后重新取地址再试一次，两次都失败才 502。"""
    current = dict(target)
    last_kind = "error"
    for attempt in range(ADD_FRIEND_ATTEMPTS):
        if attempt:
            current = _resolve_peer_target(current)
        status, body, kind = _http_json_attempt(
            str(current.get("base_url") or "") + "/api/lan/ping", "GET", None,
            {"X-NOVAI-Friend-Token": str(current.get("token") or "")})
        if status is not None:
            return status, body, current
        last_kind = kind
    raise HTTPException(status_code=502, detail=_connect_error_text(last_kind))


def _post_friend_request(target: Dict[str, Any],
                         payload: Dict[str, Any]) -> Tuple[int, Any, Dict[str, Any]]:
    """投递好友请求：同样失败重试一次（重试前刷新地址），两次都失败才 502。"""
    current = dict(target)
    last_kind = "error"
    for attempt in range(ADD_FRIEND_ATTEMPTS):
        if attempt:
            current = _resolve_peer_target(current)
        status, body, kind = _http_json_attempt(
            str(current.get("base_url") or "") + "/api/lan/friend-requests", "POST", payload,
            {"X-NOVAI-Friend-Token": str(current.get("token") or "")})
        if status is not None:
            return status, body, current
        last_kind = kind
    raise HTTPException(status_code=502, detail=_connect_error_text(last_kind))


def _peer_entry_for(friend: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """发现表里这个好友的最新广播：优先按账号 id 对，没有 id 才退回好友码。"""
    friend_id = str(friend.get("id") or "")
    code = str(friend.get("code") or "").strip().upper()
    _prune_peers()
    with _PEERS_LOCK:
        if friend_id:
            for item in _PEERS.values():
                if str(item.get("id")) == friend_id:
                    return dict(item)
        if code:
            item = _PEERS.get(code)
            # 码是公开的，别的机器可以冒充：只有拿不到 id 时才信码
            if item and (not friend_id or str(item.get("id")) == friend_id):
                return dict(item)
    return None


def refresh_friend_address(friend: Dict[str, Any]) -> bool:
    """用 30s 内的广播把好友地址改回最新（对方换端口 / 换 IP / 换 WiFi 之后自愈）。

    返回是否真的改过。只改 ip:port（和随包口令），账号 id 对不上的一律不认。"""
    entry = _peer_entry_for(friend)
    if not entry:
        return False
    seen = int(entry.get("seen_at") or 0)
    if not seen or now_ms() - seen > DISCOVERY_TTL_MS:
        return False
    try:
        port = int(entry.get("port") or 0)
    except (TypeError, ValueError):
        return False
    ip = str(entry.get("ip") or "")
    if not ip or port < 1 or port > 65535:
        return False
    base = "http://%s:%d" % (ip, port)
    token = str(entry.get("token") or "")
    changed = base != _normalize_base_url(friend.get("base_url"))
    if not changed and (not token or token == str(friend.get("token") or "")):
        return False
    friend["base_url"] = base
    if token:
        friend["token"] = token
    _upsert_friend(friend)
    _clear_online_cache(str(friend.get("id") or ""))
    return True


def _probe_ex(friend: Dict[str, Any], timeout: float = PING_TIMEOUT) -> Tuple[bool, Dict[str, Any], str]:
    """ping 一次，返回 (是否在线, 响应体, 失败类型)；失败类型见 _error_kind。"""
    base = _normalize_base_url(friend.get("base_url"))
    if not base:
        return False, {}, "no-address"
    headers = {"X-NOVAI-Friend-Token": str(friend.get("token") or "")}
    try:
        status, body = _http_json(base + "/api/lan/ping", "GET", None, headers, timeout)
    except Exception as exc:
        return False, {}, _error_kind(exc)
    if status != 200 or not isinstance(body, dict):
        return False, {}, "http"
    authorized = bool(body.get("authorized")) or hmac.compare_digest(
        str(body.get("account_id") or "x"), str(friend.get("id") or "y"))
    return bool(body.get("ok", True)) and authorized, body, "ok" if authorized else "denied"


def _probe(friend: Dict[str, Any], timeout: float = PING_TIMEOUT) -> Tuple[bool, Dict[str, Any]]:
    online, body, _ = _probe_ex(friend, timeout)
    return online, body


def online_of(friend: Dict[str, Any], now: Optional[int] = None) -> Dict[str, Any]:
    """在线状态：3s 缓存，避免每次轮询都打对方。

    一次失败不再直接判离线：超时（对方在忙 / 网络抖一下）再试一次，
    拒连或地址变了先用 UDP 发现表里的新地址再试一次，两次都不行才报离线。"""
    friend_id = str(friend.get("id") or "")
    stamp = now_ms() if now is None else int(now)
    with _ONLINE_LOCK:
        cached = _ONLINE_CACHE.get(friend_id)
        if cached and stamp - int(cached.get("checked_at") or 0) < ONLINE_CACHE_MS:
            return dict(cached)
    online, body, kind = _probe_ex(friend)
    if not online:
        fresh = _peer_entry_for(friend) is not None
        moved = refresh_friend_address(friend)
        # 表里 30s 内有它的广播 = 它确实在跑，超时多半是抖一下，值得再等一次；
        # 表里没有它，拒连就是拒连，别把 5s 轮询拖成 3s。
        if moved or (fresh and kind in ("timeout", "error")):
            again, again_body, _ = _probe_ex(friend, PING_RETRY_TIMEOUT)
            if again:
                online, body = again, again_body
    result = {
        "online": bool(online),
        "checked_at": stamp,
        "last_seen": stamp if online else int(friend.get("last_seen") or 0),
        "nickname": str(body.get("nickname") or friend.get("nickname") or ""),
        "avatar": str(body.get("avatar") or friend.get("avatar") or DEFAULT_AVATAR),
    }
    with _ONLINE_LOCK:
        _ONLINE_CACHE[friend_id] = result
    return dict(result)


def _clear_online_cache(friend_id: str) -> None:
    with _ONLINE_LOCK:
        _ONLINE_CACHE.pop(str(friend_id or ""), None)


# ---------------------------------------------------------------- 消息

def _sanitize_text(value: Any, limit: int = MAX_TEXT) -> str:
    return str(value or "").strip()[:limit]


def _sanitize_share_url(value: Any) -> str:
    text = str(value or "").strip()[:MAX_URL]
    if not text:
        return ""
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme not in ("http", "https"):
        return ""
    return text


def _message_kind(value: Any) -> str:
    """消息类型白名单：旧版本 / 未知类型一律当文本，避免历史会话读不出来。"""
    text = str(value or "").strip().lower()
    return text if text in MESSAGE_KINDS else "text"


def make_message(msg_id: str, kind: str, text: str, share_url: str, canvas_title: str,
                 ts: int, direction: str, status: str,
                 media: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    media = media or {}
    return {
        "id": msg_id,
        "kind": _message_kind(kind),
        "text": text,
        "share_url": share_url,
        "canvas_title": canvas_title[:80],
        "media_url": str(media.get("media_url") or ""),
        "media_name": str(media.get("media_name") or "")[:MEDIA_MAX_NAME],
        "media_size": _sanitize_media_size(media.get("media_size")),
        "ts": int(ts),
        "dir": direction,
        "status": status,
        "read": direction == "out",
    }


def _identity(account: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": str(account.get("id") or ""),
        "nickname": str(account.get("nickname") or DEFAULT_NICKNAME),
        "avatar": str(account.get("avatar") or DEFAULT_AVATAR),
        "base_url": "http://%s:%s" % (_lan_ip(), _port()),
        "token": str(account.get("token") or ""),
    }


def _friend_identity(account: Dict[str, Any]) -> Dict[str, Any]:
    """好友请求里的 from：比 _identity 多带 6 位好友码，对方列表里能显示 #CODE。"""
    identity = _identity(account)
    identity["code"] = account_code(account)
    return identity


def _friend_out(friend: Dict[str, Any]) -> Dict[str, Any]:
    """加好友接口回给页面的好友记录（刚加完一定算在线）。"""
    friend_id = str(friend.get("id"))
    return {
        "id": friend_id,
        "code": str(friend.get("code") or ""),
        "nickname": friend.get("nickname"),
        "avatar": friend.get("avatar"),
        "base_url": friend.get("base_url"),
        "online": True,
        "last_seen": int(friend.get("last_seen") or now_ms()),
        "unread": unread_of(load_chat(friend_id)),
        "added_by": str(friend.get("added_by") or "code"),
    }


# ---------------------------------------------------------------- 局域网自动发现
# 短码只有 6 位，不含 IP / 端口：两台机器必须在同一局域网里通过 UDP 广播互相认识。
# 广播包里带 token 是必须的（短码加好友时本机要拿它去对方 /api/lan/ping 鉴权），
# 这份取舍和现有好友码一致：好友码本来就在同一局域网里明文转发 token，这里不新增暴露面。

def _discovery_enabled() -> bool:
    """NOVAI_LAN_DISCOVERY=0 时整体关闭：测试避免占固定端口，排障也能一键停。"""
    return str(os.environ.get("NOVAI_LAN_DISCOVERY", "") or "").strip() != "0"


def _port_int() -> int:
    try:
        value = int(_port())
    except (TypeError, ValueError):
        return 3000
    return value if 1 <= value <= 65535 else 3000


def _prune_peers(now: Optional[int] = None) -> None:
    stamp = now_ms() if now is None else int(now)
    with _PEERS_LOCK:
        expired = [code for code, item in _PEERS.items()
                   if stamp - int(item.get("seen_at") or 0) > DISCOVERY_TTL_MS]
        for code in expired:
            _PEERS.pop(code, None)


def peers_snapshot() -> List[Dict[str, Any]]:
    _prune_peers()
    with _PEERS_LOCK:
        items = [dict(item) for item in _PEERS.values()]
    items.sort(key=lambda item: (-int(item.get("seen_at") or 0), str(item.get("code") or "")))
    return items


def find_peer(code: Any) -> Optional[Dict[str, Any]]:
    """短码加好友时用：只认 30s 内广播过的机器，过期就当没发现。"""
    text = str(code or "").strip().upper()
    _prune_peers()
    with _PEERS_LOCK:
        item = _PEERS.get(text)
        return dict(item) if item else None


def _probe_key(peer: Dict[str, Any]) -> str:
    return "%s:%s" % (str(peer.get("ip") or ""), str(peer.get("port") or ""))


def _probe_peer(peer: Dict[str, Any], timeout: float = PROBE_TIMEOUT) -> Dict[str, Any]:
    """探测一个发现到的节点是否真的可达（只打 /api/lan/ping，不探测外部）。"""
    ip = str(peer.get("ip") or "").strip()
    try:
        port = int(peer.get("port") or 0)
    except (TypeError, ValueError):
        port = 0
    if not ip or not 0 < port < 65536:
        return {"reachable": False, "latency_ms": None, "http_status": None, "error": "no-address"}
    headers = {"X-NOVAI-Friend-Token": str(peer.get("token") or "")}
    started = time.monotonic()
    try:
        status, body = _http_json("http://%s:%d/api/lan/ping" % (ip, port), "GET", None,
                                  headers, timeout)
    except Exception as exc:
        return {"reachable": False, "latency_ms": None, "http_status": None, "error": _error_kind(exc)}
    latency = int((time.monotonic() - started) * 1000)
    reachable = status == 200 and isinstance(body, dict) and bool(body.get("ok", True))
    return {
        "reachable": bool(reachable),
        "latency_ms": latency if reachable else None,
        "http_status": int(status),
        # 区分原因：timeout / refused / http_<code> / no-address，前端才能分别给话术
        "error": "" if reachable else "http_%d" % int(status),
    }


def _run_probes(peers: List[Dict[str, Any]], timeout: float) -> Dict[str, Dict[str, Any]]:
    """一轮并发探测（单节点 timeout），返回 {ip:port: 探测结果}。"""
    results: Dict[str, Dict[str, Any]] = {}
    if not peers:
        return results
    with ThreadPoolExecutor(max_workers=min(PROBE_MAX_PEERS, len(peers))) as pool:
        futures = [(pool.submit(_probe_peer, peer, timeout), peer) for peer in peers]
        for future, peer in futures:
            try:
                state = future.result(timeout=timeout + 1.0)
            except Exception:
                state = {"reachable": False, "latency_ms": None, "http_status": None, "error": "error"}
            results[_probe_key(peer)] = dict(state)
    return results


def probe_peers(peers: List[Dict[str, Any]], force: bool = False) -> Dict[str, Dict[str, Any]]:
    """并发探测发现表（最多 20 个），失败的再试一轮，只缓存最终结论 5s。

    单节点超时 3s；最坏 3s + 3s，接口整体上限 6s（诊断宁可慢一点，也不能把正常节点误判成离线）。
    返回 {ip:port: 探测结果}。"""
    targets = list(peers[:PROBE_MAX_PEERS])
    results: Dict[str, Dict[str, Any]] = {}
    todo: List[Dict[str, Any]] = []
    stamp = now_ms()
    with _PROBE_LOCK:
        for peer in targets:
            key = _probe_key(peer)
            cached = _PROBE_CACHE.get(key)
            if cached and not force and stamp - int(cached.get("at") or 0) < PROBE_CACHE_MS:
                results[key] = {name: cached.get(name) for name in
                                ("reachable", "latency_ms", "http_status", "error")}
            else:
                todo.append(peer)
    if todo:
        results.update(_run_probes(todo, PROBE_TIMEOUT))
        retry = [peer for peer in todo
                 if not (results.get(_probe_key(peer)) or {}).get("reachable")]
        if PROBE_ATTEMPTS > 1 and retry:
            again = _run_probes(retry, PROBE_TIMEOUT)
            for peer in retry:
                key = _probe_key(peer)
                if key in again:
                    results[key] = again[key]
        # 只缓存最终结论：重试后成功的不再带着上一轮的失败被缓存
        with _PROBE_LOCK:
            for peer in todo:
                state = results.get(_probe_key(peer))
                if not state:
                    continue
                cached = dict(state)
                cached["at"] = now_ms()
                _PROBE_CACHE[_probe_key(peer)] = cached
    return results


_LOCAL_IDS_LOCK = threading.Lock()
_LOCAL_IDS_CACHE: Optional[Tuple[float, List[str]]] = None


def _reset_local_ids() -> None:
    global _LOCAL_IDS_CACHE
    with _LOCAL_IDS_LOCK:
        _LOCAL_IDS_CACHE = None


def _local_identity_ids() -> List[str]:
    """本机所有局域网身份 id（含无归属桶）：广播里出现这些 id 的就是自己，不能当好友。"""
    global _LOCAL_IDS_CACHE
    now = time.monotonic()
    with _LOCAL_IDS_LOCK:
        cached = _LOCAL_IDS_CACHE
        if cached and now - cached[0] < 3.0:
            return list(cached[1])
    try:
        ids = [str(account.get("id") or "") for account in load_accounts().values()]
    except Exception:
        ids = []
    ids = [value for value in ids if value]
    with _LOCAL_IDS_LOCK:
        _LOCAL_IDS_CACHE = (now, list(ids))
    return ids


def _remember_peer(packet: Dict[str, Any], ip: str, own_id: str = "") -> None:
    """收一包广播：按「一台机器可以有多个身份」展开，每个身份都进发现表。"""
    own_ids = set(_local_identity_ids())
    if own_id:
        own_ids.add(str(own_id))
    try:
        port = int(packet.get("port") or 0)
    except (TypeError, ValueError):
        return
    if port < 1 or port > 65535:
        return
    identities: List[Dict[str, Any]] = []
    listed = packet.get("accounts")
    if isinstance(listed, list) and listed:
        for item in listed:
            if isinstance(item, dict):
                identities.append(item)
    else:
        identities.append(packet)          # 老版本只广播一个身份
    for identity in identities:
        code = str(identity.get("code") or "").strip().upper()
        peer_id = str(identity.get("id") or "").strip()
        if not (SHORT_CODE_RE.match(code) or LEGACY_SHORT_CODE_RE.match(code)):
            continue
        if not FRIEND_ID_RE.match(peer_id) or peer_id in own_ids:
            continue
        avatar = str(identity.get("avatar") or "")
        if avatar.startswith("data:"):
            avatar = DEFAULT_AVATAR      # 发现只用于展示和找地址，不搬大头像
        with _PEERS_LOCK:
            _PEERS[code] = {
                "code": code,
                "id": peer_id,
                "ip": str(ip or ""),
                "port": port,
                "nickname": str(identity.get("nickname") or "")[:MAX_NICKNAME],
                "avatar": (avatar or DEFAULT_AVATAR)[:8],
                "token": str(identity.get("token") or ""),
                "seen_at": now_ms(),
            }


def _identity_entry(account: Dict[str, Any]) -> Dict[str, Any]:
    avatar = str(account.get("avatar") or DEFAULT_AVATAR)
    if len(avatar.encode("utf-8")) > DISCOVERY_AVATAR_BYTES:
        avatar = DEFAULT_AVATAR           # 大头像会把 UDP 单包撑爆，宁可只发默认表情
    return {
        "code": account_code(account),
        "id": str(account.get("id") or ""),
        "nickname": str(account.get("nickname") or DEFAULT_NICKNAME)[:MAX_NICKNAME],
        "avatar": avatar,
        "token": str(account.get("token") or ""),
    }


def _discovery_payload() -> Dict[str, Any]:
    """机器级广播：本机所有局域网身份一起带上；顶层字段留给老客户端（只认一个码）。"""
    accounts = load_accounts()
    if not accounts:
        accounts = {OWNER_LOCAL: load_account(OWNER_LOCAL)}
    primary = primary_account()
    entries = [_identity_entry(account) for account in accounts.values()]
    payload: Dict[str, Any] = {
        "novai_lan": 1,
        "port": _port_int(),
        "accounts": entries,
    }
    if primary:
        payload.update(_identity_entry(primary))
    return payload


def _discovery_raw(solicit: bool = False) -> Optional[bytes]:
    try:
        payload = _discovery_payload()
        if solicit:
            payload["solicit"] = True
        return json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except Exception:
        return None


def _broadcast_once(sock: socket.socket, warned: bool) -> bool:
    """逐个目标发一遍；只有全部失败才算失败，且只提示一次（成功一次就复位）。"""
    global _LAST_BROADCAST_ERROR
    raw = _discovery_raw()
    if raw is None:
        return warned
    last_error: Optional[BaseException] = None
    sent = False
    for target in broadcast_targets():
        try:
            sock.sendto(raw, (target, DISCOVERY_PORT))
            sent = True
        except Exception as exc:
            last_error = exc
    if sent:
        _LAST_BROADCAST_ERROR = ""
        return False
    if last_error is None:
        return warned
    _LAST_BROADCAST_ERROR = str(last_error)
    if not warned:
        print("[LAN] 局域网广播发送失败：%s" % last_error, flush=True)
    return True


def _handle_discovery_packet(sock: Optional[socket.socket], data: bytes,
                              addr: Tuple[str, int], own_id: str) -> None:
    """收一包广播：记地址；对方是「主动要地址」就单播回一包（谁问给谁，不再广播）。"""
    try:
        packet = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return
    if not isinstance(packet, dict):
        return
    try:
        if int(packet.get("novai_lan") or 0) != 1:
            return
        _remember_peer(packet, str(addr[0] if addr else ""), own_id)
    except Exception:
        return
    if not packet.get("solicit") or sock is None:
        return
    raw = _discovery_raw()      # 回应不带 solicit，避免两边互相回答
    if raw is None:
        return
    try:
        sock.sendto(raw, addr)
    except Exception:
        pass


def _run_discovery_socket(sock: socket.socket) -> None:
    broadcast_warned = False
    last_broadcast = 0.0
    own_id = ""          # 自己的身份在 _remember_peer 里按「本机全部 id」过滤，这里不用提前创建
    while True:
        now = time.monotonic()
        if now - last_broadcast >= DISCOVERY_INTERVAL:
            last_broadcast = now
            broadcast_warned = _broadcast_once(sock, broadcast_warned)
        try:
            data, addr = sock.recvfrom(DISCOVERY_PACKET_BYTES)
        except socket.timeout:
            continue
        _handle_discovery_packet(sock, data, addr, own_id)


_SOLICIT_LOCK = threading.Lock()
_LAST_SOLICIT = 0.0
DISCOVERY_SOLICIT_WAIT = 0.8      # 主动要地址最多等这么久（只等对方单播回应）


def solicit_peers(wait: Optional[float] = None) -> bool:
    """当场广播一包「我在找地址」，等对方单播回应写回发现表。

    3s 一次的被动广播在丢包 / 对方刚启动时可能要等下一轮，发送失败时用它补一刀。
    2s 内最多问一次，避免连点「重发」把局域网刷满。"""
    global _LAST_SOLICIT
    if not _discovery_enabled():
        return False
    stamp = time.monotonic()
    with _SOLICIT_LOCK:
        if stamp - _LAST_SOLICIT < 2.0:
            return False
        _LAST_SOLICIT = stamp
    raw = _discovery_raw(solicit=True)
    if raw is None:
        return False
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    except OSError:
        return False
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(("", 0))
        sock.settimeout(0.15)
    except OSError:
        try:
            sock.close()
        except Exception:
            pass
        return False
    own_id = ""
    try:
        for target in broadcast_targets():
            try:
                sock.sendto(raw, (target, DISCOVERY_PORT))
            except OSError:
                pass
        budget = DISCOVERY_SOLICIT_WAIT if wait is None else max(0.0, float(wait))
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            try:
                data, addr = sock.recvfrom(DISCOVERY_PACKET_BYTES)
            except socket.timeout:
                continue
            except OSError:
                break
            _handle_discovery_packet(sock, data, addr, own_id)
        return True
    finally:
        try:
            sock.close()
        except Exception:
            pass


def _discovery_loop() -> None:
    global _DISCOVERY_STARTED
    try:
        while True:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                if hasattr(socket, "SO_REUSEPORT"):
                    # 同机第二个实例也要能收广播；不支持就按老的独占端口跑
                    try:
                        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
                    except Exception:
                        pass
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                sock.bind(("", DISCOVERY_PORT))
                sock.settimeout(DISCOVERY_TICK)
            except Exception as exc:
                print("[LAN] 局域网自动发现不可用（不影响使用）：%s，稍后重试" % exc, flush=True)
                try:
                    sock.close()
                except Exception:
                    pass
                time.sleep(5)
                continue
            try:
                _run_discovery_socket(sock)
            except Exception as exc:
                print("[LAN] 局域网自动发现不可用（不影响使用）：%s，稍后重试" % exc, flush=True)
            finally:
                try:
                    sock.close()
                except Exception:
                    pass
            time.sleep(5)
    finally:
        with _DISCOVERY_LOCK:
            _DISCOVERY_STARTED = False


def start_discovery() -> None:
    """起 UDP 发现线程（幂等）；任何失败都只打日志，不影响后端启动。"""
    global _DISCOVERY_STARTED
    if not _discovery_enabled():
        return
    with _DISCOVERY_LOCK:
        if _DISCOVERY_STARTED:
            return
        _DISCOVERY_STARTED = True
    try:
        threading.Thread(target=_discovery_loop, name="novai-lan-discovery", daemon=True).start()
    except Exception as exc:
        with _DISCOVERY_LOCK:
            _DISCOVERY_STARTED = False
        print("[LAN] 局域网自动发现启动失败（不影响使用）：%s" % exc, flush=True)


# ---------------------------------------------------------------- 接口

def with_owner(handler):
    """页面侧接口：按当前登录账号读写局域网数据；没登录 / 鉴权关闭 = 无归属桶（老行为）。"""
    @functools.wraps(handler)
    def wrapper(*args, **kwargs):
        request = kwargs.get("request")
        if request is None:
            request = next((value for value in args if isinstance(value, Request)), None)
        owner = owner_from_request(request)
        with use_owner(owner):
            _claim_legacy(owner)
            return handler(*args, **kwargs)
    return wrapper


def with_friend_token(handler):
    """好友机投递接口：按 X-NOVAI-Friend-Token 认出是哪个本地身份，落到它的数据里。"""
    @functools.wraps(handler)
    def wrapper(*args, **kwargs):
        owner = owner_for_token(kwargs.get("x_novai_friend_token") or "")
        with use_owner(owner or OWNER_LOCAL):
            return handler(*args, **kwargs)
    return wrapper


@router.get("/me")
@with_owner
def get_me(request: Request) -> Dict[str, Any]:
    return {"me": me_payload(load_account())}


@router.put("/me")
@with_owner
def put_me(payload: MeUpdateRequest, request: Request) -> Dict[str, Any]:
    account = load_account()
    nickname = _sanitize_text(payload.nickname, MAX_NICKNAME)
    if not nickname:
        raise HTTPException(status_code=400, detail="昵称不能为空")
    account["nickname"] = nickname
    account["avatar"] = _sanitize_avatar(payload.avatar)
    account["updated_at"] = now_ms()
    save_account(account)
    return {"me": me_payload(account)}


@router.get("/ping")
@with_friend_token
def ping(request: Request, x_novai_friend_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    given = str(x_novai_friend_token or "")
    owner = owner_for_token(given) if given else ""
    account = load_account(owner) if owner else (primary_account() or {})
    expected = str(account.get("token") or "")
    authorized = bool(expected) and bool(given) and hmac.compare_digest(given, expected)
    payload: Dict[str, Any] = {
        "ok": True,
        "account_id": str(account.get("id") or ""),
        "version": _version(),
        "can_receive": authorized,
        "authorized": authorized,
    }
    # 陌生人 ping：只给「你在不在」，不回昵称，避免随口令探测泄露资料
    if authorized:
        payload["nickname"] = str(account.get("nickname") or DEFAULT_NICKNAME)
        payload["avatar"] = str(account.get("avatar") or DEFAULT_AVATAR)
        payload["port"] = _port()
    return payload


@router.get("/discover")
def discover_peers(probe: Optional[str] = None) -> Dict[str, Any]:
    # 表里只有 30s 内广播过的身份（一台机器可登录多个账号，各自一行）。
    # 不带 probe：保持旧形状（不探测、不下发 ip / port / token）；
    # probe=1：并发探测每个节点是否真的可达，额外给 reachable / latency_ms。
    snapshot = peers_snapshot()
    probing = str(probe or "").strip().lower() in ("1", "true", "yes", "on")
    states: Dict[str, Dict[str, Any]] = probe_peers(snapshot) if probing else {}
    peers: List[Dict[str, Any]] = []
    for item in snapshot:
        row: Dict[str, Any] = {
            "code": str(item.get("code") or ""),
            "nickname": str(item.get("nickname") or "局域网用户"),
            "avatar": str(item.get("avatar") or DEFAULT_AVATAR),
            "online": True,
        }
        if probing:
            state = states.get(_probe_key(item)) or {}
            row["reachable"] = state.get("reachable") if state else None
            row["latency_ms"] = state.get("latency_ms") if state else None
        peers.append(row)
    return {"peers": peers}


def _udp_bind_check() -> Tuple[bool, str]:
    sock: Optional[socket.socket] = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except Exception:
                pass
        sock.bind(("", DISCOVERY_PORT))
        return True, ""
    except Exception as exc:
        return False, str(exc)
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass


@router.get("/diagnostics")
@with_owner
def lan_diagnostics(request: Request) -> Dict[str, Any]:
    """一次性排障数据（只读、只探测发现表里的本机局域网节点，不碰外网，3s 内返回）。"""
    started = time.monotonic()
    account = load_account()
    enabled = deps.get("LAN_AUTH_ENABLED")
    lan_auth = False
    if callable(enabled):
        try:
            lan_auth = bool(enabled())
        except Exception:
            lan_auth = False
    snapshot = peers_snapshot()
    states = probe_peers(snapshot, force=True)
    stamp = now_ms()
    nicknames = {str(item.get("code") or ""): str(item.get("nickname") or "") for item in snapshot}
    probe_rows: List[Dict[str, Any]] = []
    for item in snapshot[:PROBE_MAX_PEERS]:
        state = states.get(_probe_key(item)) or {}
        code = str(item.get("code") or "")
        probe_rows.append({
            "code": code,
            "nickname": nicknames.get(code, ""),
            "ip": str(item.get("ip") or ""),
            "port": int(item.get("port") or 0),
            "reachable": bool(state.get("reachable")),
            "latency_ms": state.get("latency_ms"),
            "http_status": state.get("http_status"),
            "error": str(state.get("error") or ""),
        })
    udp_ok, udp_error = _udp_bind_check()
    interfaces = _iface_entries()
    discovery_started = bool(_DISCOVERY_STARTED)
    checks: Dict[str, Any] = {
        "udp_bind": udp_ok,
        "udp_error": udp_error,
        "discovery_enabled": _discovery_enabled(),
        "iface_count": len(interfaces),
        "lan_auth": lan_auth,
    }
    checks_list: List[Dict[str, Any]] = [
        {"name": "udp_bind", "ok": udp_ok,
         "detail": udp_error or ("UDP %d 可绑定" % DISCOVERY_PORT)},
        {"name": "discovery_enabled", "ok": _discovery_enabled(),
         "detail": "自动发现已启用" if _discovery_enabled() else "NOVAI_LAN_DISCOVERY=0，自动发现已关闭"},
        {"name": "discovery_started", "ok": discovery_started,
         "detail": "发现线程已启动" if discovery_started else "发现线程未启动（可能绑定 47823 失败）"},
        {"name": "interfaces", "ok": bool(interfaces),
         "detail": "%d 张 IPv4 网卡" % len(interfaces)},
        {"name": "lan_auth", "ok": lan_auth,
         "detail": "局域网口令已开启" if lan_auth else "局域网口令已关闭"},
    ]
    if sys.platform == "darwin":
        # macOS 没有命令行加防火墙的稳定做法，只能让用户自己放行本地网络
        hint = "系统设置 → 隐私与安全性 → 本地网络需允许 NOVAI"
        checks["macos_local_network_hint"] = hint
        checks_list.append({"name": "macos_local_network", "ok": True, "detail": hint})
    checks["elapsed_ms"] = int((time.monotonic() - started) * 1000)
    return {
        "self": {
            "id": str(account.get("id") or ""),
            "code": account_code(account),
            "friend_code": friend_code_of(account),
            "nickname": str(account.get("nickname") or DEFAULT_NICKNAME),
            "lan_ip": _lan_ip(),
            "port": _port(),
            "version": _version(),
            "lan_auth": lan_auth,
        },
        "interfaces": interfaces,
        "proxy": _proxy_info(),
        "discovery": {
            "enabled": _discovery_enabled(),
            "started": bool(_DISCOVERY_STARTED),
            "port": DISCOVERY_PORT,
            "last_broadcast_error": _LAST_BROADCAST_ERROR,
            "broadcast_targets": broadcast_targets(),
            "peers": [{
                "code": str(item.get("code") or ""),
                "nickname": str(item.get("nickname") or ""),
                "ip": str(item.get("ip") or ""),
                "port": int(item.get("port") or 0),
                "seen_ms_ago": max(0, stamp - int(item.get("seen_at") or 0)),
            } for item in snapshot],
        },
        "probe": probe_rows,
        "checks": checks,
        "checks_list": checks_list,
    }


def _online_states(friends: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """并发查所有好友在线状态。以前逐个串行 ping（超时的好友每个要等 1.5~3s），
    好友一多整个列表接口超过前端 5s 轮询，结果大家都显示离线。"""
    if len(friends) <= 1:
        return {}
    owner = current_owner()

    def one(friend: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        with use_owner(owner):        # 归属是线程局部的：工作线程里要重新指定
            return str(friend.get("id")), online_of(friend)

    results: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=min(16, len(friends))) as pool:
        # 传原对象：online_of 刷新到的新地址要留在 friends 里，下面 save_friends 才不会写回旧地址
        for future in [pool.submit(one, friend) for friend in friends]:
            try:
                key, state = future.result(timeout=PING_TIMEOUT + PING_RETRY_TIMEOUT + 3.0)
                results[key] = state
            except Exception:
                continue
    return results


@router.get("/friends")
@with_owner
def list_friends(request: Request) -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    friends = load_friends()
    touched = False
    states = _online_states(friends)
    for friend in friends:
        state = states.get(str(friend.get("id"))) or online_of(friend)
        messages = load_chat(str(friend.get("id")))
        unread = unread_of(messages)
        # 重启后也要能补发：轮询顺手把「待补发」的好友重新排进队列
        if any(str(item.get("status")) == "pending" and str(item.get("dir")) == "out" for item in messages):
            mark_pending(str(friend.get("id")))
        # 对方在线时把昵称 / 头像 / 最近在线写回文件：离线后列表还显示最后认识的样子
        if state.get("online"):
            for key in ("nickname", "avatar"):
                value = str(state.get(key) or "")
                if value and value != str(friend.get(key) or ""):
                    friend[key] = value
                    touched = True
            seen = int(state.get("last_seen") or 0)
            if seen and seen != int(friend.get("last_seen") or 0):
                friend["last_seen"] = seen
                touched = True
        items.append({
            "id": str(friend.get("id")),
            "code": str(friend.get("code") or ""),   # 老好友记录没存码：给空串，前端自己决定怎么显示
            "nickname": state.get("nickname") or str(friend.get("nickname") or "好友"),
            "avatar": state.get("avatar") or str(friend.get("avatar") or DEFAULT_AVATAR),
            "base_url": str(friend.get("base_url") or ""),
            "online": bool(state.get("online")),
            "last_seen": int(state.get("last_seen") or 0),
            "unread": int(unread),
            "last_message": last_message_of(messages),
            "added_by": str(friend.get("added_by") or "code"),
        })
    if touched:
        save_friends(friends)
    items.sort(key=lambda item: (0 if item["online"] else 1, -int(item["last_seen"] or 0), item["nickname"]))
    return {"friends": items}


@router.post("/friends")
@with_owner
def add_friend(payload: FriendAddRequest, request: Request) -> Dict[str, Any]:
    parsed = parse_friend_code(payload.code)
    if not parsed:
        raise HTTPException(status_code=400, detail="好友码格式不对：应为 6 位数字 ID（如 483920），或旧的 NOVAI-IP:端口-口令")
    account = load_account()
    if parsed.get("kind") == "short":
        # 短码里没有地址：只认广播表里 30s 内见过的机器，否则没法知道往哪台机器发请求
        if parsed["code"] == account_code(account):
            raise HTTPException(status_code=400, detail="这是你自己的好友码，发给对方才对")
        peer = find_peer(parsed["code"])
        if not peer:
            raise HTTPException(status_code=400, detail="没在局域网里发现这个 ID：确认两台电脑在同一个网络、对方 NOVAI 正在运行，VPN 和访客 WiFi 会挡住广播；也可以让对方在「我的资料」复制「直连好友码」，整串粘贴进加好友输入框即可，不依赖自动发现")
        parsed = {
            "kind": "short",
            "code": parsed["code"],
            "ip": str(peer.get("ip") or ""),
            "port": str(peer.get("port") or ""),
            "token": str(peer.get("token") or ""),
            "base_url": "http://%s:%s" % (peer.get("ip"), peer.get("port")),
        }
    status, body, parsed = _ping_friend(parsed)
    if status != 200 or not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="对方端口不通：确认对方 NOVAI 还在运行，防火墙放行了 TCP 端口")
    if not bool(body.get("authorized")):
        raise HTTPException(status_code=400, detail="好友码里的口令不对，让对方重新复制一份")
    peer_id = str(body.get("account_id") or "")
    if not FRIEND_ID_RE.match(peer_id):
        raise HTTPException(status_code=502, detail="对方的 NOVAI 版本太旧，不支持好友码")
    if peer_id == str(account.get("id") or ""):
        raise HTTPException(status_code=400, detail="这是你自己的好友码，发给对方才对")
    nickname = _sanitize_text(payload.nickname, MAX_NICKNAME) or str(body.get("nickname") or "好友")
    avatar = str(body.get("avatar") or DEFAULT_AVATAR)
    existing = find_friend(peer_id)
    if existing:
        # 已经是好友：按这次 ping 到的最新资料刷新（昵称 / 地址 / 好友码可能变了），
        # 但不再往对方发一遍请求，也不再重复写「已加为好友」的系统提示
        friend = _upsert_friend({
            "id": peer_id,
            "nickname": nickname,
            "avatar": avatar,
            "base_url": parsed["base_url"],
            "token": parsed["token"],
            "code": str(parsed.get("code") or ""),
            "last_seen": now_ms(),
        })
        _clear_online_cache(peer_id)
        return {"ok": True, "friend": _friend_out(friend), "pending": False}
    request_body = {"from": _friend_identity(account), "ts": now_ms()}
    req_status, req_body, parsed = _post_friend_request(parsed, request_body)
    if req_status in (404, 405):
        # 对方是旧版本，没有好友请求接口：回退成老行为，直接互相加好友
        friend = _upsert_friend({
            "id": peer_id,
            "nickname": nickname,
            "avatar": avatar,
            "base_url": parsed["base_url"],
            "token": parsed["token"],
            "code": str(parsed.get("code") or ""),
            "last_seen": now_ms(),
            "added_by": "code",
        })
        _clear_online_cache(peer_id)
        _write_system_note(peer_id)
        return {"ok": True, "friend": _friend_out(friend), "pending": False}
    if req_status != 200 or not isinstance(req_body, dict) or not bool(req_body.get("ok")):
        raise HTTPException(status_code=502, detail="对方没有收到好友请求（HTTP %s）：确认对方在线，并且 NOVAI 是最新版本" % req_status)
    request_id = str(req_body.get("request_id") or "").strip().lower()
    if not FRIEND_REQUEST_ID_RE.match(request_id):
        request_id = secrets.token_hex(8)
    record = _upsert_outgoing({
        "id": request_id,
        "ts": now_ms(),
        "status": "pending",
        "to": {
            "id": peer_id,
            "nickname": nickname,
            "avatar": avatar,
            "base_url": parsed["base_url"],
            "code": str(parsed.get("code") or ""),
        },
    })
    _clear_online_cache(peer_id)
    return {"ok": True, "pending": True, "request": {
        "id": str(record.get("id")),
        "to": record.get("to"),
        "ts": int(record.get("ts") or 0),
        "status": "pending",
    }}


def _write_system_note(friend_id: str, text: str = "已加为好友，可以开始聊天了") -> None:
    """加好友成功后在会话里留一条本地系统提示（不发给对方）。"""
    append_message(friend_id, make_message(
        secrets.token_hex(8), "system", text, "", "", now_ms(), "sys", "sent"))


# ---------------------------------------------------------------- 好友请求接口

def _valid_request_id(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not FRIEND_REQUEST_ID_RE.match(text):
        raise HTTPException(status_code=400, detail="好友请求 ID 不合法")
    return text


def _require_friend_token(account: Dict[str, Any], given: Optional[str]) -> None:
    """好友机调用这两个公开接口时的唯一凭据：本机账号口令。"""
    expected = str(account.get("token") or "")
    value = str(given or "")
    if not expected or not value or not hmac.compare_digest(value, expected):
        raise HTTPException(status_code=403, detail="好友凭据无效")


@router.get("/friend-requests")
@with_owner
def list_friend_requests(request: Request) -> Dict[str, Any]:
    """前端每 5s 轮询：incoming 只给待处理的，outgoing 给待处理 + 最近 7 天的结果。"""
    data = _load_friend_requests()
    incoming = [dict(item) for item in data["incoming"] if str(item.get("status")) == "pending"]
    outgoing = [dict(item) for item in data["outgoing"]]
    incoming.sort(key=lambda item: -int(item.get("ts") or 0))
    outgoing.sort(key=lambda item: -int(item.get("ts") or 0))
    return {"incoming": incoming, "outgoing": outgoing}


@router.post("/friend-requests")
@with_friend_token
def receive_friend_request(payload: Dict[str, Any], request: Request,
                           x_novai_friend_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    account = load_account()
    _require_friend_token(account, x_novai_friend_token)
    raw_from = payload.get("from") if isinstance(payload.get("from"), dict) else {}
    peer_id = str(raw_from.get("id") or "").strip().lower()
    if not FRIEND_ID_RE.match(peer_id):
        raise HTTPException(status_code=400, detail="对方信息不完整：好友 ID 不合法")
    peer_token = str(raw_from.get("token") or "")
    if len(peer_token) < 32:
        raise HTTPException(status_code=400, detail="对方信息不完整：缺少好友口令")
    base_url = _peer_base_from_request(request, raw_from.get("base_url"))
    if not base_url:
        raise HTTPException(status_code=400, detail="对方信息不完整：地址不是有效的局域网地址")
    try:
        ts = int(payload.get("ts") or 0)
    except (TypeError, ValueError):
        ts = 0
    record = _upsert_incoming({
        "id": secrets.token_hex(8),
        "ts": ts if ts > 0 else now_ms(),
        "status": "pending",
        "from": {
            "id": peer_id,
            "nickname": _sanitize_text(raw_from.get("nickname"), MAX_NICKNAME) or "局域网用户",
            "avatar": str(raw_from.get("avatar") or DEFAULT_AVATAR),
            "base_url": base_url,
            "token": peer_token,
            "code": _sanitize_text(raw_from.get("code"), 16),
        },
    })
    return {"ok": True, "request_id": str(record.get("id"))}


def _callback_friend_result(account: Dict[str, Any], record: Dict[str, Any], accepted: bool) -> str:
    """把同意 / 拒绝结果回投给对方；失败只返回一句原因，不影响本机已经加上的好友。"""
    peer = record.get("from") or {}
    base = _normalize_base_url(peer.get("base_url"))
    if not base:
        return "对方没有可用的地址，结果没送出去"
    payload = {"request_id": str(record.get("id") or ""), "accepted": bool(accepted),
               "from": _identity(account)}
    headers = {"X-NOVAI-Friend-Token": str(peer.get("token") or "")}
    try:
        status, _body = _http_json(base + "/api/lan/friend-requests/result", "POST", payload, headers,
                                   ADD_FRIEND_TIMEOUT)
    except Exception:
        return "对方没收到%s结果（连不上对方）" % ("同意" if accepted else "拒绝")
    if status != 200:
        return "对方没收到%s结果（HTTP %s）" % ("同意" if accepted else "拒绝", status)
    return ""


def _callback_with_recovery(account: Dict[str, Any], record: Dict[str, Any], accepted: bool) -> str:
    """回投失败（以前只试一次 1.5s，失败后对方永远停在「等待验证」）：
    按发现表里对方的最新地址再投一次；地址变了顺手把本机好友记录也改过来。"""
    error = _callback_friend_result(account, record, accepted)
    if not error or "HTTP" in error:
        return error
    peer = dict(record.get("from") or {})
    entry = _peer_entry_for({"id": peer.get("id"), "code": peer.get("code")})
    if entry is None:
        solicit_peers()
        entry = _peer_entry_for({"id": peer.get("id"), "code": peer.get("code")})
    if not entry:
        return error
    try:
        fresh = "http://%s:%d" % (str(entry.get("ip") or ""), int(entry.get("port") or 0))
    except (TypeError, ValueError):
        return error
    if fresh == _normalize_base_url(peer.get("base_url")):
        return error
    peer["base_url"] = fresh
    if entry.get("token"):
        peer["token"] = str(entry.get("token"))
    record = dict(record)
    record["from"] = peer
    error = _callback_friend_result(account, record, accepted)
    if not error:
        friend = find_friend(str(peer.get("id") or ""))
        if friend:
            friend["base_url"] = fresh
            if entry.get("token"):
                friend["token"] = str(entry.get("token"))
            _upsert_friend(friend)
            _clear_online_cache(str(peer.get("id") or ""))
    return error


# 回投没送达的好友结果：后台线程每 3s 再试，最多约 30 分钟（重启后对方下次发消息也会自愈）
_PENDING_CALLBACKS: Dict[str, Dict[str, Any]] = {}
_CALLBACK_LOCK = threading.Lock()
CALLBACK_MAX_TRIES = 600


def _queue_callback(request_id: str, accepted: bool) -> None:
    key = "%s|%s" % (current_owner(), str(request_id or ""))
    with _CALLBACK_LOCK:
        _PENDING_CALLBACKS[key] = {"accepted": bool(accepted), "tries": 0}
    if AUTO_RETRY:
        _start_retry_thread()


def retry_callbacks_once() -> int:
    """一轮补投好友结果；返回这轮送达的条数。"""
    with _CALLBACK_LOCK:
        items = list(_PENDING_CALLBACKS.items())
    delivered = 0
    for key, state in items:
        owner, _, request_id = key.partition("|")
        with use_owner(owner):
            record = _find_request("incoming", request_id)
            if not record:
                with _CALLBACK_LOCK:
                    _PENDING_CALLBACKS.pop(key, None)
                continue
            accepted = bool(state.get("accepted"))
            error = _callback_friend_result(load_account(), record, accepted)
            if error and "HTTP" not in error:
                peer = record.get("from") or {}
                entry = _peer_entry_for({"id": peer.get("id"), "code": peer.get("code")})
                if entry:
                    error = _callback_with_recovery(load_account(), record, accepted)
            if not error:
                delivered += 1
                _set_request_status("incoming", request_id, "accepted" if accepted else "rejected",
                                    clear_error=True)
                with _CALLBACK_LOCK:
                    _PENDING_CALLBACKS.pop(key, None)
                continue
            with _CALLBACK_LOCK:
                current = _PENDING_CALLBACKS.get(key)
                if current is not None:
                    current["tries"] = int(current.get("tries") or 0) + 1
                    if current["tries"] >= CALLBACK_MAX_TRIES or "HTTP" in error:
                        _PENDING_CALLBACKS.pop(key, None)
    return delivered


@router.post("/friend-requests/{request_id}/accept")
@with_owner
def accept_friend_request(request_id: str, request: Request) -> Dict[str, Any]:
    clean = _valid_request_id(request_id)
    record = _find_request("incoming", clean)
    if not record or str(record.get("status")) != "pending":
        raise HTTPException(status_code=404, detail="这条好友请求不存在或已经处理过了")
    peer = record.get("from") or {}
    peer_id = str(peer.get("id") or "")
    account = load_account()
    friend = _upsert_friend({
        "id": peer_id,
        "nickname": str(peer.get("nickname") or "好友"),
        "avatar": str(peer.get("avatar") or DEFAULT_AVATAR),
        "base_url": str(peer.get("base_url") or ""),
        "token": str(peer.get("token") or ""),
        "code": str(peer.get("code") or ""),
        "last_seen": now_ms(),
        "added_by": "request",
    })
    _clear_online_cache(peer_id)
    _write_system_note(peer_id)
    error = _callback_with_recovery(account, record, True)
    _set_request_status("incoming", clean, "accepted", error)
    if error and "HTTP" not in error:
        _queue_callback(clean, True)
    return {"ok": True, "friend": _friend_out(friend)}


@router.post("/friend-requests/{request_id}/reject")
@with_owner
def reject_friend_request(request_id: str, request: Request) -> Dict[str, Any]:
    clean = _valid_request_id(request_id)
    record = _find_request("incoming", clean)
    if not record or str(record.get("status")) != "pending":
        raise HTTPException(status_code=404, detail="这条好友请求不存在或已经处理过了")
    error = _callback_with_recovery(load_account(), record, False)
    _set_request_status("incoming", clean, "rejected", error)
    if error and "HTTP" not in error:
        _queue_callback(clean, False)
    return {"ok": True}


@router.post("/friend-requests/result")
@with_friend_token
def friend_request_result(payload: Dict[str, Any], request: Request,
                          x_novai_friend_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    account = load_account()
    _require_friend_token(account, x_novai_friend_token)
    request_id = str(payload.get("request_id") or "").strip().lower()
    accepted = bool(payload.get("accepted"))
    record = _find_request("outgoing", request_id) if FRIEND_REQUEST_ID_RE.match(request_id) else None
    if record is None:
        # 幂等：对方重试 / 本地已经清理掉这条记录，都当成功，别让对面卡住
        return {"ok": True, "ignored": True}
    to = record.get("to") or {}
    peer_id = str(to.get("id") or "")
    if not FRIEND_ID_RE.match(peer_id):
        return {"ok": True, "ignored": True}
    if not accepted:
        _set_request_status("outgoing", request_id, "rejected")
        return {"ok": True}
    raw_from = payload.get("from") if isinstance(payload.get("from"), dict) else {}
    base_url = (_peer_base_from_request(request, raw_from.get("base_url"))
                or _normalize_base_url(to.get("base_url")))
    friend = _upsert_friend({
        "id": peer_id,
        "nickname": _sanitize_text(raw_from.get("nickname"), MAX_NICKNAME) or str(to.get("nickname") or "好友"),
        "avatar": str(raw_from.get("avatar") or to.get("avatar") or DEFAULT_AVATAR),
        "base_url": base_url,
        "token": str(raw_from.get("token") or ""),
        "code": str(to.get("code") or ""),
        "last_seen": now_ms(),
        "added_by": "request",
    })
    _clear_online_cache(peer_id)
    _write_system_note(peer_id, "对方已同意你的好友请求")
    _set_request_status("outgoing", request_id, "accepted")
    return {"ok": True}


@router.delete("/friends/{friend_id}")
@with_owner
def delete_friend(friend_id: str, request: Request) -> Dict[str, Any]:
    clean = _valid_friend_id(friend_id)
    removed = _drop_friend(clean)
    _clear_online_cache(clean)
    return {"ok": True, "removed": bool(removed)}


@router.post("/friends/{friend_id}/send")
@with_owner
def send_message(friend_id: str, payload: MessageSendRequest, request: Request) -> Dict[str, Any]:
    clean = _valid_friend_id(friend_id)
    friend = find_friend(clean)
    if not friend:
        raise HTTPException(status_code=404, detail="好友不存在，可能已被删除")
    kind = _message_kind(payload.kind)
    text = _sanitize_text(payload.text)
    share_url = _sanitize_share_url(payload.share_url)
    canvas_title = _sanitize_text(payload.canvas_title, 80)
    media_url = _sanitize_media_url(payload.media_url)
    media_name = _sanitize_media_name(payload.media_name)
    media_size = _sanitize_media_size(payload.media_size)
    if kind == "canvas" and not share_url:
        raise HTTPException(status_code=400, detail="画布卡片缺少有效的分享链接")
    if kind == "text" and not text:
        raise HTTPException(status_code=400, detail="消息不能为空")
    if kind in ("image", "video") and not media_url:
        raise HTTPException(status_code=400,
                            detail="%s消息缺少媒体地址，重新上传一次再发" % ("图片" if kind == "image" else "视频"))
    msg_id = _sanitize_text(payload.message_id, 64) or secrets.token_hex(10)
    if not re.match(r"^[A-Za-z0-9_-]{6,64}$", msg_id):
        msg_id = secrets.token_hex(10)
    account = load_account()
    media = {"media_url": media_url, "media_name": media_name, "media_size": media_size}
    message = make_message(msg_id, kind, text, share_url, canvas_title, now_ms(), "out", "sent", media)
    delivered, kind, status = _deliver_with_recovery(friend, message)
    error = ""
    if delivered:
        message["status"] = "sent"
    elif kind == "http" and status == 403:
        # 口令不对：重试也没用，等对方重新加你
        message["status"] = "failed"
        error = "对方没有接受这条消息（好友码口令可能已过期），让对方重新加你"
    elif kind == "http":
        message["status"] = "failed"
        error = "对方没有接收这条消息（HTTP %s）" % status
    elif kind == "no-address":
        message["status"] = "failed"
        error = "这个好友没有可用的地址，删掉后重新用好友码添加"
    else:
        # 连不上（超时 / 拒连 / 网络错）：先落库等对方恢复，后台自动补发
        message["status"] = "pending"
        error = "对方离线或暂时没响应，消息已保存，对方恢复在线后会自动补发"
    put_outgoing(clean, message)
    with _LOCK:
        friends = load_friends()
        for item in friends:
            if str(item.get("id")) == clean:
                item["last_seen"] = now_ms()
        save_friends(friends)
    _clear_online_cache(clean)
    if not delivered:
        if message["status"] == "pending":
            mark_pending(clean)
        raise HTTPException(status_code=502, detail=error)
    return {"message": message}


@router.get("/messages")
@with_owner
def list_messages(request: Request) -> Dict[str, Any]:
    friend_id = str(request.query_params.get("with") or "").strip()
    if not friend_id:
        raise HTTPException(status_code=400, detail="缺少 with 参数")
    clean = _valid_friend_id(friend_id)
    try:
        after = int(request.query_params.get("after") or 0)
    except ValueError:
        after = 0
    messages = load_chat(clean)
    if any(str(item.get("status")) == "pending" and str(item.get("dir")) == "out" for item in messages):
        mark_pending(clean)
    return {"messages": merge_messages(messages, after)}


@router.post("/messages")
@with_friend_token
def receive_message(request: Request, payload: Dict[str, Any],
                    x_novai_friend_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    account = load_account()
    expected = str(account.get("token") or "")
    given = str(x_novai_friend_token or "")
    if not expected or not given or not hmac.compare_digest(given, expected):
        raise HTTPException(status_code=403, detail="好友凭据无效")
    raw_from = payload.get("from") if isinstance(payload.get("from"), dict) else {}
    raw_msg = payload.get("message") if isinstance(payload.get("message"), dict) else {}
    peer_id = str(raw_from.get("id") or "")
    if not FRIEND_ID_RE.match(peer_id):
        raise HTTPException(status_code=400, detail="发件人 ID 不合法")
    claimed_base = _normalize_base_url(raw_from.get("base_url"))
    base_url = _peer_base_from_request(request, claimed_base)
    peer_token = str(raw_from.get("token") or "")
    if not base_url or len(peer_token) < 32:
        raise HTTPException(status_code=400, detail="发件人信息不完整")
    msg_id = _sanitize_text(raw_msg.get("id"), 64)
    if not re.match(r"^[A-Za-z0-9_-]{6,64}$", msg_id):
        raise HTTPException(status_code=400, detail="消息 ID 不合法")
    kind = _message_kind(raw_msg.get("kind"))
    text = _sanitize_text(raw_msg.get("text"))
    share_url = _sanitize_share_url(raw_msg.get("share_url"))
    canvas_title = _sanitize_text(raw_msg.get("canvas_title"), 80)
    media_url = _sanitize_media_url(raw_msg.get("media_url"))
    media_name = _sanitize_media_name(raw_msg.get("media_name"))
    media_size = _sanitize_media_size(raw_msg.get("media_size"))
    # 画布分享链接 / 图片视频地址的主机是对方自报的，和 base_url 一样可能是虚拟网卡地址：
    # 主机和自报地址一致时换成真实来源 IP，否则对方的画布打不开、克隆失败、图片裂开
    source = _source_ip(request)
    if source and claimed_base:
        claimed_host = str(urllib.parse.urlsplit(claimed_base).hostname or "")
        share_url = _rehost_url(share_url, claimed_host, source)
        media_url = _rehost_url(media_url, claimed_host, source)
    if kind == "text" and not text:
        raise HTTPException(status_code=400, detail="消息不能为空")
    if kind in ("image", "video") and not media_url:
        raise HTTPException(status_code=400,
                            detail="对方发来的%s消息没有媒体地址" % ("图片" if kind == "image" else "视频"))

    _upsert_friend({
        "id": peer_id,
        "nickname": _sanitize_text(raw_from.get("nickname"), MAX_NICKNAME) or "好友",
        "avatar": str(raw_from.get("avatar") or DEFAULT_AVATAR),
        "base_url": base_url,
        "token": peer_token,
        "last_seen": now_ms(),
        "added_by": "message",
    })
    _clear_online_cache(peer_id)
    # 对方刚联系上我们：这是补发待发消息最稳的时机
    mark_pending(peer_id)
    message = make_message(msg_id, kind, text, share_url, canvas_title,
                           int(raw_msg.get("ts") or now_ms()), "in", "received",
                           {"media_url": media_url, "media_name": media_name, "media_size": media_size})
    created = append_message(peer_id, message)
    return {"ok": True, "duplicate": not created}


@router.post("/messages/read")
@with_owner
def read_messages(payload: ReadRequest, request: Request) -> Dict[str, Any]:
    clean = _valid_friend_id(payload.friend_id)
    if not find_friend(clean):
        raise HTTPException(status_code=404, detail="好友不存在")
    return {"ok": True, "unread": mark_read(clean)}


# ---------------------------------------------------------------- 图片 / 视频接口

@router.post("/media")
async def upload_media(file: UploadFile = File(...)) -> Dict[str, Any]:
    """本机页面选好文件后传到这里，落盘换成随机 id，再回一个局域网绝对地址给聊天消息用。"""
    mime = str(getattr(file, "content_type", "") or "").split(";", 1)[0].strip().lower()
    kind, ext = _media_kind_ext(mime)
    if not kind:
        raise HTTPException(status_code=400,
                            detail="只支持图片或视频（PNG / JPG / GIF / WebP / AVIF / MP4 / WebM / MOV / M4V）")
    folder = media_dir()
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="本机媒体目录不可写，检查数据目录权限（%s）" % exc)
    media_id = secrets.token_hex(12)
    target = os.path.join(folder, media_id + ext)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=folder)
    size = 0
    stored = False
    try:
        with os.fdopen(fd, "wb") as handle:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MEDIA_MAX_BYTES:
                    raise HTTPException(status_code=413, detail="文件太大（上限 200MB）")
                handle.write(chunk)
            handle.flush()
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
        if size <= 0:
            raise HTTPException(status_code=400, detail="文件是空的，重新选一个")
        os.replace(tmp_path, target)
        stored = True
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(status_code=500, detail="媒体文件没存下来（%s）" % exc)
    finally:
        if not stored:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    name = _sanitize_media_name(getattr(file, "filename", "")) or ("图片" if kind == "image" else "视频")
    return {"ok": True, "media": {
        "id": media_id,
        "url": _media_url(media_id),
        "name": name,
        "size": size,
        "mime": mime,
        "kind": kind,
    }}


@router.get("/media/{media_id}")
def get_media(media_id: str, request: Request,
              x_novai_friend_token: Optional[str] = Header(default=None)) -> FileResponse:
    """好友机浏览器直接加载图片 / 视频：鉴权开启时要求本机账号口令或局域网口令。"""
    enabled = deps.get("LAN_AUTH_ENABLED")
    auth_on = False
    if callable(enabled):
        try:
            auth_on = bool(enabled())
        except Exception:
            auth_on = True
    if auth_on:
        # 图片/视频是机器级文件，本机任意身份的 token 都该能取（登录别的账号不该看不了自己的图）
        allowed = [str(account.get("token") or "") for account in load_accounts().values()]
        if not allowed:
            allowed = [str(load_account().get("token") or "")]
        loader = deps.get("LOAD_LAN_TOKEN")
        if callable(loader):
            try:
                allowed.append(str(loader() or ""))
            except Exception:
                pass
        # 换口令前发出去的聊天图片地址带的是旧口令：旧口令只在这里还认（只读单个媒体文件）
        retired_loader = deps.get("LOAD_RETIRED_LAN_TOKENS")
        if callable(retired_loader):
            try:
                allowed.extend(str(item or "") for item in (retired_loader() or []))
            except Exception:
                pass
        candidates = [str(request.query_params.get("token") or ""), str(x_novai_friend_token or "")]
        matched = False
        given_sig = str(request.query_params.get("sig") or "")
        expected_sig = _media_sig(media_id) if given_sig else ""
        if expected_sig and hmac.compare_digest(given_sig, expected_sig):
            matched = True
        for given in candidates:
            if not given:
                continue
            for expected in allowed:
                if expected and hmac.compare_digest(given, expected):
                    matched = True
        if not matched:
            raise HTTPException(status_code=401, detail="需要局域网访问口令")
    path = _media_path(media_id)
    if not path:
        raise HTTPException(status_code=404, detail="这个图片 / 视频不存在或已经被清理了")
    ext = os.path.splitext(path)[1].lower()
    return FileResponse(path, media_type=MEDIA_EXT_MIME.get(ext, "application/octet-stream"),
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})


SHARE_HOST_RE = re.compile(r"^([0-9]{1,3}[.]){3}[0-9]{1,3}$")


@router.get("/share-preview")
async def share_preview(request: Request) -> Dict[str, Any]:
    """画布卡片的只读快照：好友机上的画布不能从本机页面直接 fetch（跨域），
    这里由后端代取一次，顺便把「对方的局域网口令」用在本机这一侧，页面只拿 JSON。
    大快照走 httpx 流式读取（默认不限体量，超时按体量分档）。"""
    raw = str(request.query_params.get("url") or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="缺少画布分享链接")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="这不是一条有效的画布分享链接")
    if not SHARE_HOST_RE.match(str(parsed.hostname)):
        raise HTTPException(status_code=400, detail="只支持局域网 IP 的分享链接")
    token = str(parsed.query and urllib.parse.parse_qs(parsed.query).get("share", [""])[0] or "")
    if not token:
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 3 and parts[0] == "api" and parts[1] == "canvas-share":
            token = parts[2]
    if not re.match(r"^[A-Za-z0-9_-]{16,64}$", token):
        raise HTTPException(status_code=400, detail="分享链接里没有有效的画布令牌")
    origin = "%s://%s" % (parsed.scheme, parsed.netloc)
    target = origin + "/api/canvas-share/" + urllib.parse.quote(token)
    # 分享链接里带着对方的局域网口令：好友机之间也是非回环来源，不带就会被对方的 lan_access_guard 挡成 401
    lan_token = str(urllib.parse.parse_qs(parsed.query).get("token", [""])[0] or "")
    headers = {"X-NOVAI-Token": lan_token} if lan_token else {}
    custom = deps.get("LAN_HTTP_JSON")
    try:
        if callable(custom):
            # 测试 / 探针钩子优先级最高：保留原来的同步替换语义
            status, body = custom(target, "GET", None, headers, PING_TIMEOUT)
        else:
            status, body = await _http_json_stream(target, "GET", headers)
    except LanResponseTooLarge as exc:
        raise HTTPException(status_code=413, detail="分享快照已超过本机设置的分享快照上限（%s）" % str(exc))
    except LanPeerTimeout:
        raise HTTPException(status_code=504, detail="对方的画布读取超时（画布较大或网络较慢），点重试再来一次")
    except Exception:
        raise HTTPException(status_code=502, detail="连不上对方的 NOVAI，确认两台机器在同一个局域网")
    if status == 401:
        raise HTTPException(status_code=401, detail="对方的局域网口令不一致，让对方重新发一张画布")
    if status == 404:
        raise HTTPException(status_code=404, detail="对方的 NOVAI 版本过旧或不支持画布分享（HTTP 404），请对方升级后重发；也可能这条分享已被撤销")
    if status == 410:
        raise HTTPException(status_code=410, detail="这条画布分享已经过期，请对方重新发一张")
    if status != 200 or not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="对方返回了异常结果（HTTP %s）" % status)
    return {"ok": True, "origin": origin, "snapshot": body}


# ---------------------------------------------------------------- 注销清理

def purge_account(account_id: Any) -> Dict[str, int]:
    """注销云账号时清掉它的局域网数据：身份 / 好友 / 聊天 / 好友申请 / 待补发队列。

    幂等；只动这个账号自己的桶，无归属桶（auth 关闭时的整机数据）和别的账号一概不碰。
    返回删除计数，方便调用方记日志 / 断言。"""
    key = owner_key(account_id)
    removed = {"accounts": 0, "friends": 0, "chats": 0, "requests": 0}
    if not key or key == OWNER_LOCAL:
        return removed
    _ensure_schema()
    with _SCHEMA_LOCK:
        store = _account_store()
        accounts = store.setdefault("accounts", {})
        if accounts.pop(key, None) is not None:
            removed["accounts"] = 1
            save_accounts(store)
        raw = _read_json(friends_path(), None)
        mapping = raw.get("friends") if isinstance(raw, dict) else None
        if isinstance(mapping, dict) and mapping.pop(key, None) is not None:
            removed["friends"] = 1
            _write_atomic(friends_path(), {"version": SCHEMA_VERSION, "friends": mapping})
        raw = _read_json(friend_requests_path(), None)
        if isinstance(raw, dict):
            changed = False
            for section in ("incoming", "outgoing"):
                mapping = raw.get(section)
                if isinstance(mapping, dict) and mapping.pop(key, None) is not None:
                    changed = True
                    removed["requests"] += 1
            if changed:
                _write_atomic(friend_requests_path(), raw)
    chat_dir = os.path.join(data_dir(), CHAT_DIR, key)
    if os.path.isdir(chat_dir):
        try:
            for name in os.listdir(chat_dir):
                if name.endswith(".json"):
                    removed["chats"] += 1
            import shutil as _shutil
            _shutil.rmtree(chat_dir, ignore_errors=True)
        except OSError:
            pass
    # 队列里这个账号的待补发全部撤掉（下次补发线程不会再去读它的数据）
    with _PENDING_LOCK:
        for pending_key in [item for item in _PENDING_FRIENDS if item.split("|", 1)[0] == key]:
            _PENDING_FRIENDS.pop(pending_key, None)
    _reset_local_ids()
    print("[LAN] 已清掉账号 %s 的局域网数据：%s" % (key, removed), flush=True)
    return removed


# ---------------------------------------------------------------- 中间件放行

LAN_TOKEN_EXEMPT = (
    ("GET", "/api/lan/ping"),
    ("POST", "/api/lan/messages"),
    ("POST", "/api/lan/friend-requests"),
    ("POST", "/api/lan/friend-requests/result"),
)

# 媒体文件路径后面带 id，只能按前缀放行（GET /api/lan/media/<id>）
LAN_TOKEN_EXEMPT_PREFIXES = (("GET", "/api/lan/media/"),)


def lan_api_public_without_token(path: Any, method: Any = "GET") -> bool:
    """这些请求必须对好友机开放（对方没有本机局域网口令）；
    放行之后由路由内的 X-NOVAI-Friend-Token / token 校验把门，其余 /api/lan/* 仍要口令。"""
    value = str(path or "").rstrip("/") or "/"
    verb = str(method or "").upper()
    if (verb, value) in LAN_TOKEN_EXEMPT:
        return True
    for prefix_verb, prefix in LAN_TOKEN_EXEMPT_PREFIXES:
        if verb == prefix_verb and value.startswith(prefix) and len(value) > len(prefix):
            return True
    return False
