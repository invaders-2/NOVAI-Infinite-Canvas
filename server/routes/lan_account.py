#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""局域网账号 / 好友 / 聊天（T51）。

定位：两台同一局域网、都开着 NOVAI 的电脑，用「好友码」互加之后可以看在线状态、
发文字消息、发一张画布（对方点开只读预览，再克隆到画布 / 存为模板）。

与云账号（server/auth）无关，不注册、不登录、不上公网：
- 数据落 <DATA_DIR>/lan_account.json、lan_friends.json、lan_chat/<friendId>.json（全部原子写）；
- 好友码 = NOVAI-<6 位数字码>（新，如 NOVAI-483920）或 NOVAI-<局域网IP>:<端口>-<本机口令>（旧码继续可用），
  6 位纯数字只由账号 id 派生、无前导 0；老版本客户端广播的 6 位字母码仍可解析 / 发现，
  IP / 端口靠 UDP 47823 广播自动发现；
- 口令同时是对方 POST /api/lan/messages 的凭据；
- 在线状态靠 ping（超时 1.5s，结果缓存 3s），前端 5s 轮询，最迟 8s 变离线。

契约：
    GET    /api/lan/me                         -> {me: {...}}（含 code / friend_code）
    PUT    /api/lan/me                         {nickname, avatar} -> {me}
    GET    /api/lan/discover                   -> {peers: [{code, nickname, avatar, online}]}
    GET    /api/lan/ping                       可选 X-NOVAI-Friend-Token -> {ok, account_id, nickname, version, can_receive, authorized}
    GET    /api/lan/friends                    -> {friends: [...]}（含 online / unread）
    POST   /api/lan/friends                    {code, nickname?} -> {friend}
    DELETE /api/lan/friends/{friend_id}        -> {ok: true}
    POST   /api/lan/friends/{friend_id}/send   {text|kind/share_url/canvas_title, message_id?} -> {message}
    GET    /api/lan/messages?with=&after=      -> {messages: [...]}
    POST   /api/lan/messages                   （好友机投递，需 X-NOVAI-Friend-Token）-> {ok, duplicate}
    POST   /api/lan/messages/read              {friend_id} -> {ok, unread}

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y。
"""
from __future__ import annotations

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
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel

from server.routes.deps import deps

router = APIRouter(prefix="/api/lan")

ACCOUNT_FILE = "lan_account.json"
FRIENDS_FILE = "lan_friends.json"
CHAT_DIR = "lan_chat"
SCHEMA_VERSION = 1
DEFAULT_NICKNAME = "本机用户"
DEFAULT_AVATAR = "🙂"
ACCOUNT_TOKEN_BYTES = 24          # 48 位十六进制，满足「32+ 字符」
PING_TIMEOUT = 1.5
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
_ONLINE_CACHE: Dict[str, Dict[str, Any]] = {}
_ONLINE_LOCK = threading.Lock()
_PEERS: Dict[str, Dict[str, Any]] = {}
_PEERS_LOCK = threading.Lock()
_DISCOVERY_LOCK = threading.Lock()
_DISCOVERY_STARTED = False
_IFACE_CACHE: Optional[Tuple[float, Dict[str, str]]] = None
_IFACE_LOCK = threading.Lock()


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
    env_ip = os.environ.get("NOVAI_LAN_IP", "").strip()
    if env_ip:
        return env_ip
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return str(sock.getsockname()[0])
    except Exception:
        return "127.0.0.1"
    finally:
        sock.close()


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


def _valid_friend_id(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not FRIEND_ID_RE.match(text):
        raise HTTPException(status_code=400, detail="好友 ID 不合法")
    return text


# ---------------------------------------------------------------- 账号

def load_account() -> Dict[str, Any]:
    path = os.path.join(data_dir(), ACCOUNT_FILE)
    raw = _read_json(path, None)
    if isinstance(raw, dict) and str(raw.get("token") or "") and str(raw.get("id") or ""):
        # 老账号文件没有短码：第一次读到时补上并写回，之后所有人看到的都是同一个码
        code = account_code(raw)
        if str(raw.get("code") or "") != code:
            raw["code"] = code
            save_account(raw)
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
    save_account(account)
    return account


def save_account(account: Dict[str, Any]) -> None:
    _write_atomic(os.path.join(data_dir(), ACCOUNT_FILE), account)


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


def load_friends() -> List[Dict[str, Any]]:
    raw = _read_json(friends_path(), None)
    items = raw.get("friends") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    cleaned: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        friend_id = str(item.get("id") or "")
        if not FRIEND_ID_RE.match(friend_id):
            continue
        cleaned.append(item)
    return cleaned


def save_friends(friends: List[Dict[str, Any]]) -> None:
    _write_atomic(friends_path(), {"version": SCHEMA_VERSION, "friends": friends})


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


# ---------------------------------------------------------------- 聊天存储

def chat_path(friend_id: str) -> str:
    return os.path.join(data_dir(), CHAT_DIR, _valid_friend_id(friend_id) + ".json")


def load_chat(friend_id: str) -> List[Dict[str, Any]]:
    raw = _read_json(chat_path(friend_id), None)
    items = raw.get("messages") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict) and str(item.get("id") or "")]


def save_chat(friend_id: str, messages: List[Dict[str, Any]]) -> None:
    trimmed = messages[-MAX_MESSAGES:] if len(messages) > MAX_MESSAGES else messages
    _write_atomic(chat_path(friend_id), {"version": SCHEMA_VERSION, "friend_id": friend_id, "messages": trimmed})


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
    return {
        "kind": "canvas" if str(latest.get("kind")) == "canvas" else "text",
        "text": _sanitize_text(latest.get("text"), MAX_TEXT),
        "ts": int(latest.get("ts") or 0),
        "dir": "in" if str(latest.get("dir")) == "in" else "out",
    }


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
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
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
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
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


def _probe(friend: Dict[str, Any], timeout: float = PING_TIMEOUT) -> Tuple[bool, Dict[str, Any]]:
    base = _normalize_base_url(friend.get("base_url"))
    if not base:
        return False, {}
    headers = {"X-NOVAI-Friend-Token": str(friend.get("token") or "")}
    try:
        status, body = _http_json(base + "/api/lan/ping", "GET", None, headers, timeout)
    except Exception:
        return False, {}
    if status != 200 or not isinstance(body, dict):
        return False, {}
    authorized = bool(body.get("authorized")) or hmac.compare_digest(
        str(body.get("account_id") or "x"), str(friend.get("id") or "y"))
    return bool(body.get("ok", True)) and authorized, body


def online_of(friend: Dict[str, Any], now: Optional[int] = None) -> Dict[str, Any]:
    """在线状态：3s 缓存，避免每次轮询都打对方。"""
    friend_id = str(friend.get("id") or "")
    stamp = now_ms() if now is None else int(now)
    with _ONLINE_LOCK:
        cached = _ONLINE_CACHE.get(friend_id)
        if cached and stamp - int(cached.get("checked_at") or 0) < ONLINE_CACHE_MS:
            return dict(cached)
    online, body = _probe(friend)
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


def make_message(msg_id: str, kind: str, text: str, share_url: str, canvas_title: str,
                 ts: int, direction: str, status: str) -> Dict[str, Any]:
    return {
        "id": msg_id,
        "kind": "canvas" if kind == "canvas" else "text",
        "text": text,
        "share_url": share_url,
        "canvas_title": canvas_title[:80],
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


def _remember_peer(packet: Dict[str, Any], ip: str, own_id: str) -> None:
    code = str(packet.get("code") or "").strip().upper()
    peer_id = str(packet.get("id") or "").strip()
    if not (SHORT_CODE_RE.match(code) or LEGACY_SHORT_CODE_RE.match(code)) or not FRIEND_ID_RE.match(peer_id):
        return
    if peer_id == str(own_id or ""):
        return
    try:
        port = int(packet.get("port") or 0)
    except (TypeError, ValueError):
        return
    if port < 1 or port > 65535:
        return
    avatar = str(packet.get("avatar") or "")
    if avatar.startswith("data:"):
        avatar = DEFAULT_AVATAR          # 发现只用于展示和找地址，不搬大头像
    with _PEERS_LOCK:
        _PEERS[code] = {
            "code": code,
            "id": peer_id,
            "ip": str(ip or ""),
            "port": port,
            "nickname": str(packet.get("nickname") or "")[:MAX_NICKNAME],
            "avatar": (avatar or DEFAULT_AVATAR)[:8],
            "token": str(packet.get("token") or ""),
            "seen_at": now_ms(),
        }


def _discovery_payload() -> Dict[str, Any]:
    account = load_account()
    avatar = str(account.get("avatar") or DEFAULT_AVATAR)
    if len(avatar.encode("utf-8")) > DISCOVERY_AVATAR_BYTES:
        avatar = DEFAULT_AVATAR           # 大头像会把 UDP 单包撑爆，宁可只发默认表情
    return {
        "novai_lan": 1,
        "code": account_code(account),
        "id": str(account.get("id") or ""),
        "port": _port_int(),
        "nickname": str(account.get("nickname") or DEFAULT_NICKNAME),
        "avatar": avatar,
        "token": str(account.get("token") or ""),
    }


def _broadcast_once(sock: socket.socket, warned: bool) -> bool:
    """逐个目标发一遍；只有全部失败才算失败，且只提示一次（成功一次就复位）。"""
    try:
        raw = json.dumps(_discovery_payload(), ensure_ascii=False).encode("utf-8")
    except Exception:
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
        return False
    if last_error is None:
        return warned
    if not warned:
        print("[LAN] 局域网广播发送失败：%s" % last_error, flush=True)
    return True


def _run_discovery_socket(sock: socket.socket) -> None:
    broadcast_warned = False
    last_broadcast = 0.0
    while True:
        now = time.monotonic()
        if now - last_broadcast >= DISCOVERY_INTERVAL:
            last_broadcast = now
            broadcast_warned = _broadcast_once(sock, broadcast_warned)
        try:
            data, addr = sock.recvfrom(DISCOVERY_PACKET_BYTES)
        except socket.timeout:
            continue
        try:
            packet = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            continue
        if not isinstance(packet, dict):
            continue
        try:
            if int(packet.get("novai_lan") or 0) != 1:
                continue
            _remember_peer(packet, str(addr[0] if addr else ""),
                           str(load_account().get("id") or ""))
        except Exception:
            continue


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

@router.get("/me")
def get_me() -> Dict[str, Any]:
    return {"me": me_payload(load_account())}


@router.put("/me")
def put_me(payload: MeUpdateRequest) -> Dict[str, Any]:
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
def ping(request: Request, x_novai_friend_token: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    account = load_account()
    expected = str(account.get("token") or "")
    given = str(x_novai_friend_token or "")
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
def discover_peers() -> Dict[str, Any]:
    # 表里只有 30s 内广播过的机器，所以在线恒为 True；不下发 ip / port / token，前端只需要展示
    peers = [{
        "code": str(item.get("code") or ""),
        "nickname": str(item.get("nickname") or "局域网用户"),
        "avatar": str(item.get("avatar") or DEFAULT_AVATAR),
        "online": True,
    } for item in peers_snapshot()]
    return {"peers": peers}


@router.get("/friends")
def list_friends() -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    friends = load_friends()
    touched = False
    for friend in friends:
        state = online_of(friend)
        messages = load_chat(str(friend.get("id")))
        unread = unread_of(messages)
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
def add_friend(payload: FriendAddRequest) -> Dict[str, Any]:
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
            raise HTTPException(status_code=400, detail="没在局域网里发现这个 ID：确认两台电脑在同一个网络；也可以让对方在「我的资料」复制「直连好友码」，整串粘贴进加好友输入框即可，不依赖自动发现")
        parsed = {
            "kind": "short",
            "code": parsed["code"],
            "ip": str(peer.get("ip") or ""),
            "port": str(peer.get("port") or ""),
            "token": str(peer.get("token") or ""),
            "base_url": "http://%s:%s" % (peer.get("ip"), peer.get("port")),
        }
    headers = {"X-NOVAI-Friend-Token": parsed["token"]}
    try:
        status, body = _http_json(parsed["base_url"] + "/api/lan/ping", "GET", None, headers, PING_TIMEOUT)
    except Exception:
        raise HTTPException(status_code=502, detail="连不上对方：确认两台机器在同一个局域网，并且对方开着 NOVAI")
    if status != 200 or not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="对方没有回应这个好友码（端口不通或服务没起来）")
    if not bool(body.get("authorized")):
        raise HTTPException(status_code=400, detail="好友码里的口令不对，让对方重新复制一份")
    peer_id = str(body.get("account_id") or "")
    if not FRIEND_ID_RE.match(peer_id):
        raise HTTPException(status_code=502, detail="对方的 NOVAI 版本太旧，不支持好友码")
    if peer_id == str(account.get("id") or ""):
        raise HTTPException(status_code=400, detail="这是你自己的好友码，发给对方才对")
    nickname = _sanitize_text(payload.nickname, MAX_NICKNAME) or str(body.get("nickname") or "好友")
    friend = _upsert_friend({
        "id": peer_id,
        "nickname": nickname,
        "avatar": str(body.get("avatar") or DEFAULT_AVATAR),
        "base_url": parsed["base_url"],
        "token": parsed["token"],
        "code": str(parsed.get("code") or ""),
        "last_seen": now_ms(),
        "added_by": "code",
    })
    _clear_online_cache(peer_id)
    _write_system_note(peer_id)
    return {"friend": {
        "id": peer_id,
        "code": str(friend.get("code") or ""),
        "nickname": friend.get("nickname"),
        "avatar": friend.get("avatar"),
        "base_url": friend.get("base_url"),
        "online": True,
        "last_seen": int(friend.get("last_seen") or now_ms()),
        "unread": unread_of(load_chat(peer_id)),
        "added_by": str(friend.get("added_by") or "code"),
    }}


def _write_system_note(friend_id: str) -> None:
    """加好友成功后在会话里留一条本地系统提示（不发给对方）。"""
    append_message(friend_id, make_message(
        secrets.token_hex(8), "system", "已加为好友，可以开始聊天了", "", "", now_ms(), "sys", "sent"))


@router.delete("/friends/{friend_id}")
def delete_friend(friend_id: str) -> Dict[str, Any]:
    clean = _valid_friend_id(friend_id)
    removed = _drop_friend(clean)
    _clear_online_cache(clean)
    return {"ok": True, "removed": bool(removed)}


@router.post("/friends/{friend_id}/send")
def send_message(friend_id: str, payload: MessageSendRequest) -> Dict[str, Any]:
    clean = _valid_friend_id(friend_id)
    friend = find_friend(clean)
    if not friend:
        raise HTTPException(status_code=404, detail="好友不存在，可能已被删除")
    kind = "canvas" if str(payload.kind) == "canvas" else "text"
    text = _sanitize_text(payload.text)
    share_url = _sanitize_share_url(payload.share_url)
    canvas_title = _sanitize_text(payload.canvas_title, 80)
    if kind == "canvas" and not share_url:
        raise HTTPException(status_code=400, detail="画布卡片缺少有效的分享链接")
    if kind == "text" and not text:
        raise HTTPException(status_code=400, detail="消息不能为空")
    msg_id = _sanitize_text(payload.message_id, 64) or secrets.token_hex(10)
    if not re.match(r"^[A-Za-z0-9_-]{6,64}$", msg_id):
        msg_id = secrets.token_hex(10)
    account = load_account()
    message = make_message(msg_id, kind, text, share_url, canvas_title, now_ms(), "out", "sent")
    body = {"from": _identity(account), "message": {
        "id": msg_id, "kind": message["kind"], "text": text,
        "share_url": share_url, "canvas_title": canvas_title, "ts": message["ts"],
    }}
    headers = {"X-NOVAI-Friend-Token": str(friend.get("token") or "")}
    base = _normalize_base_url(friend.get("base_url"))
    error = ""
    delivered = False
    if not base:
        error = "这个好友没有可用的地址，删掉后重新用好友码添加"
    else:
        try:
            status, data = _http_json(base + "/api/lan/messages", "POST", body, headers, PING_TIMEOUT)
        except Exception:
            status, data = 0, {}
        if status == 200 and isinstance(data, dict) and data.get("ok"):
            delivered = True
        elif status == 403:
            error = "对方没有接受这条消息（好友码口令可能已过期），让对方重新加你"
        elif status == 0:
            error = "对方离线或端口不通，消息已保存，可以稍后重发"
        else:
            error = "对方没有接收这条消息（HTTP %s）" % status
    if not delivered:
        message["status"] = "failed"
    put_outgoing(clean, message)
    with _LOCK:
        friends = load_friends()
        for item in friends:
            if str(item.get("id")) == clean:
                item["last_seen"] = now_ms()
        save_friends(friends)
    _clear_online_cache(clean)
    if not delivered:
        raise HTTPException(status_code=502, detail=error)
    return {"message": message}


@router.get("/messages")
def list_messages(request: Request) -> Dict[str, Any]:
    friend_id = str(request.query_params.get("with") or "").strip()
    if not friend_id:
        raise HTTPException(status_code=400, detail="缺少 with 参数")
    clean = _valid_friend_id(friend_id)
    try:
        after = int(request.query_params.get("after") or 0)
    except ValueError:
        after = 0
    return {"messages": merge_messages(load_chat(clean), after)}


@router.post("/messages")
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
    base_url = _normalize_base_url(raw_from.get("base_url"))
    peer_token = str(raw_from.get("token") or "")
    if not base_url or len(peer_token) < 32:
        raise HTTPException(status_code=400, detail="发件人信息不完整")
    msg_id = _sanitize_text(raw_msg.get("id"), 64)
    if not re.match(r"^[A-Za-z0-9_-]{6,64}$", msg_id):
        raise HTTPException(status_code=400, detail="消息 ID 不合法")
    kind = "canvas" if str(raw_msg.get("kind")) == "canvas" else "text"
    text = _sanitize_text(raw_msg.get("text"))
    share_url = _sanitize_share_url(raw_msg.get("share_url"))
    canvas_title = _sanitize_text(raw_msg.get("canvas_title"), 80)
    if kind == "text" and not text:
        raise HTTPException(status_code=400, detail="消息不能为空")

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
    message = make_message(msg_id, kind, text, share_url, canvas_title, int(raw_msg.get("ts") or now_ms()), "in", "received")
    created = append_message(peer_id, message)
    return {"ok": True, "duplicate": not created}


@router.post("/messages/read")
def read_messages(payload: ReadRequest) -> Dict[str, Any]:
    clean = _valid_friend_id(payload.friend_id)
    if not find_friend(clean):
        raise HTTPException(status_code=404, detail="好友不存在")
    return {"ok": True, "unread": mark_read(clean)}


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
        raise HTTPException(status_code=404, detail="这条画布分享已经失效或被撤销了")
    if status == 410:
        raise HTTPException(status_code=410, detail="这条画布分享已经过期，请对方重新发一张")
    if status != 200 or not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="对方返回了异常结果（HTTP %s）" % status)
    return {"ok": True, "origin": origin, "snapshot": body}


# ---------------------------------------------------------------- 中间件放行

LAN_TOKEN_EXEMPT = (("GET", "/api/lan/ping"), ("POST", "/api/lan/messages"))


def lan_api_public_without_token(path: Any, method: Any = "GET") -> bool:
    """这两条必须对好友机开放（对方没有本机局域网口令）；
    放行之后由路由内的 X-NOVAI-Friend-Token 校验把门，其余 /api/lan/* 仍要口令。"""
    value = str(path or "").rstrip("/") or "/"
    return (str(method or "").upper(), value) in LAN_TOKEN_EXEMPT
