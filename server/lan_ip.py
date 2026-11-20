#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本机「真正的局域网 IP」选择器（好友地址 / 分享链接 / 媒体地址 / 手机访问二维码共用）。

旧做法是 connect("8.8.8.8") 取出口网卡 IP。国内常见的 Clash / Surge / 各类 VPN 开 TUN（增强）模式后，
默认路由走虚拟网卡，拿到的是 198.18.0.1 / 10.x VPN 地址这类别人连不上的 IP：
- 发给好友的 base_url 是假地址 → 对方 ping 不通，显示离线、消息发不出、同意好友的回执送不回来；
- 画布分享链接 / 图片视频地址里的主机也是假地址 → 对方打不开、克隆失败。
另外 launcher 启动时把 IP 写死进 NOVAI_LAN_IP，换 WiFi / DHCP 换地址后一直用旧 IP。

这里改成：枚举本机网卡，跳过虚拟 / 隧道 / 回环 / fake-ip 段，按「家用/办公网段」打分选一个；
结果缓存 10s，换网络能自己跟上。显式指定用 NOVAI_LAN_IP_OVERRIDE 或 NOVAI_LAN_IP。
"""
from __future__ import annotations

import ipaddress
import os
import socket
import struct
import sys
import threading
import time
from typing import Dict, List, Optional, Tuple

try:
    import fcntl  # type: ignore
except Exception:  # Windows
    fcntl = None  # type: ignore

CACHE_SECONDS = 10.0
_SIOCGIFADDR = 0xC0206921 if sys.platform == "darwin" else 0x8915

# 虚拟 / 隧道 / 容器网卡名前缀：这些地址别的电脑连不上
_VIRTUAL_PREFIXES = (
    "lo", "utun", "tun", "tap", "ppp", "ipsec", "gif", "stf", "awdl", "llw", "anpi", "ap1",
    "bridge", "docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "zt", "tailscale", "wg",
    "feth", "vnic", "cni", "flannel", "kube", "lxc", "lxd", "clash", "meta", "mihomo",
)
_FAKE_NETS = [ipaddress.ip_network(net) for net in (
    "198.18.0.0/15",     # Clash / Surge fake-ip、TUN 网关
    "100.64.0.0/10",     # 运营商 NAT / Tailscale
    "169.254.0.0/16",    # 链路本地（没拿到 DHCP）
    "127.0.0.0/8",
    "0.0.0.0/8",
)]

_LOCK = threading.Lock()
_CACHE: Optional[Tuple[float, str]] = None


def _valid_v4(text: str) -> Optional[ipaddress.IPv4Address]:
    try:
        address = ipaddress.ip_address(str(text or "").strip())
    except ValueError:
        return None
    return address if isinstance(address, ipaddress.IPv4Address) else None


def is_fake_ip(text: str) -> bool:
    address = _valid_v4(text)
    if address is None:
        return True
    return any(address in net for net in _FAKE_NETS)


def _route_ip() -> str:
    """系统出口网卡 IP（可能是 TUN 虚拟网卡）。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return str(sock.getsockname()[0])
    except Exception:
        return ""
    finally:
        sock.close()


def _iface_ips() -> List[Tuple[str, str]]:
    """[(网卡名, IPv4)]；macOS / Linux 用 ioctl，Windows 退回主机名解析（不带网卡名）。"""
    found: List[Tuple[str, str]] = []
    if fcntl is not None:
        try:
            names = [name for _, name in socket.if_nameindex()]
        except (AttributeError, OSError):
            names = []
        if names:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                for name in names:
                    try:
                        packed = struct.pack("256s", name[:15].encode("utf-8"))
                        result = fcntl.ioctl(sock.fileno(), _SIOCGIFADDR, packed)
                        found.append((name, socket.inet_ntoa(result[20:24])))
                    except OSError:
                        continue
            finally:
                sock.close()
    if not found:
        seen = set()
        try:
            for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
                if ip not in seen:
                    seen.add(ip)
                    found.append(("", ip))
        except Exception:
            pass
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = str(info[4][0])
                if ip not in seen:
                    seen.add(ip)
                    found.append(("", ip))
        except Exception:
            pass
    return found


def _is_virtual_iface(name: str) -> bool:
    value = str(name or "").strip().lower()
    return bool(value) and value.startswith(_VIRTUAL_PREFIXES)


def _score(name: str, ip: str, route_ip: str) -> int:
    """越大越像「同一个 WiFi / 交换机下别人能连上的地址」；<0 不可用。"""
    address = _valid_v4(ip)
    if address is None or is_fake_ip(ip) or _is_virtual_iface(name):
        return -1
    score = 0
    if address in ipaddress.ip_network("192.168.0.0/16"):
        score += 30
    elif address in ipaddress.ip_network("10.0.0.0/8"):
        score += 20
    elif address in ipaddress.ip_network("172.16.0.0/12"):
        score += 10     # Docker / WSL 也常用 172.x，分数放低
    elif address.is_private:
        score += 5
    else:
        score += 1      # 公网直连的机器也能用，但排最后
    lowered = str(name or "").lower()
    if lowered.startswith(("en", "eth", "wlan", "wl", "以太网", "wi-fi", "wifi")):
        score += 5
    if ip == route_ip:
        score += 8      # 出口网卡正常时优先它（多网卡时和系统选择保持一致）
    return score


def candidates() -> List[Dict[str, object]]:
    """诊断用：每个候选地址和打分。"""
    route_ip = _route_ip()
    items: List[Dict[str, object]] = []
    seen = set()
    pool = list(_iface_ips())
    if route_ip:
        pool.append(("", route_ip))
    for name, ip in pool:
        if ip in seen:
            continue
        seen.add(ip)
        items.append({"iface": name, "ip": ip, "score": _score(name, ip, route_ip),
                      "route": ip == route_ip})
    items.sort(key=lambda item: -int(item["score"]))  # type: ignore[arg-type]
    return items


def _compute() -> str:
    route_ip = _route_ip()
    best_ip, best_score = "", -1
    named: Dict[str, str] = {}
    for name, ip in _iface_ips():
        named.setdefault(ip, name)
        value = _score(name, ip, route_ip)
        if value > best_score:
            best_ip, best_score = ip, value
    if route_ip and route_ip not in named:
        value = _score("", route_ip, route_ip)
        if value > best_score:
            best_ip, best_score = route_ip, value
    if best_ip:
        return best_ip
    return route_ip or ""


def pick_lan_ip(force: bool = False) -> str:
    """本机对局域网可达的 IPv4；拿不到返回空串。"""
    global _CACHE
    # 用户 / 测试显式指定的地址优先（启动器已不再自动写 NOVAI_LAN_IP）
    override = (os.environ.get("NOVAI_LAN_IP_OVERRIDE", "").strip()
                or os.environ.get("NOVAI_LAN_IP", "").strip())
    if override:
        return override
    now = time.monotonic()
    with _LOCK:
        if not force and _CACHE and now - _CACHE[0] < CACHE_SECONDS:
            return _CACHE[1]
    value = _compute()
    with _LOCK:
        _CACHE = (now, value)
    return value


def reset_cache() -> None:
    global _CACHE
    with _LOCK:
        _CACHE = None
