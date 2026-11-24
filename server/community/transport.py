#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""社区传输层：CommunityTransport 抽象 + LanTransport（局域网）。

节点发现复用 lan_account：UDP 47823 广播出来的 peers_snapshot() + 好友列表（base_url / token）。
并发拉取作品列表：单节点 4s 超时、失败重试一次；结果缓存 30s（有节点失败时只缓存 5s）。
某个节点一次没拉到，不让它的作品立刻从列表里消失：10 分钟内沿用上次拉到的列表并标 online:false。
详情只取元数据（?lite=1），画布数据只走 package 拉一次；媒体边收边写到缓存文件，单文件上限 500MB。
以后上云端只要再写一个 CloudTransport，前端和本地接口形状不变。

测试注入（deps）：
    COMMUNITY_NODES()  ->  List[Dict]       直接给定节点（跳过 UDP 发现）
    COMMUNITY_HTTP(method, url, headers, body, timeout) -> (status, bytes)   替换真实网络

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y。
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import shutil
import time
import urllib.parse
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx

from server.community import packager, store
from server.routes.deps import deps

NODE_TIMEOUT = 1.5                 # 点赞 / 浏览等小事件
FEED_NODE_TIMEOUT = 4.0            # 拉作品列表：对方在生图 / 跑视频时 1.5s 太紧，会被误判离线
FEED_NODE_ATTEMPTS = 2             # 第一次失败同一超时再试一次
FEED_CACHE_MS = 30 * 1000
FEED_CACHE_PARTIAL_MS = 5 * 1000   # 有节点没拉到时只缓存 5s，下次刷新很快会重试
FEED_STALE_KEEP_MS = 10 * 60 * 1000  # 节点暂时拉不到：10 分钟内沿用它上次的作品列表
DETAIL_TIMEOUT = 15.0              # 详情 / 发布包：httpx 的读超时是「两次收到数据的间隔」，不是总时长
PACKAGE_TIMEOUT = 30.0
MEDIA_TIMEOUT = 15.0
MEDIA_MAX_FILE_BYTES = packager.MAX_MEDIA_FILE_BYTES    # 与发布时单个素材上限一致（500MB）
MEDIA_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
MEDIA_CONCURRENCY = 4
PROFILE_TIMEOUT = 3.0


def _override_nodes() -> Optional[List[Dict[str, Any]]]:
    hook = deps.get("COMMUNITY_NODES")
    if callable(hook):
        try:
            return [node for node in (hook() or []) if isinstance(node, dict)]
        except Exception:
            return []
    return None


def _http_hook():
    hook = deps.get("COMMUNITY_HTTP")
    return hook if callable(hook) else None


def _is_lan_url(url: str) -> bool:
    """局域网地址强制直连：httpx 的 trust_env 会把请求交给系统代理。"""
    try:
        host = urllib.parse.urlsplit(str(url or "")).hostname or ""
    except ValueError:
        return False
    value = str(host or "").strip().lower()
    if value in ("localhost", "0.0.0.0", "::1") or value.endswith(".local"):
        return True
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return bool(address.is_private or address.is_loopback or address.is_link_local)


async def _fetch_bytes(method: str, url: str, token: str = "",
                       body: Optional[Dict[str, Any]] = None,
                       timeout: float = NODE_TIMEOUT) -> Tuple[int, bytes]:
    """发一个请求，返回 (status, bytes)。网络异常返回 (0, b"")。"""
    hook = _http_hook()
    headers = {"Accept": "application/json"}
    if token:
        headers["X-NOVAI-Friend-Token"] = str(token)
    raw = None
    if body is not None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if hook:
        try:
            result = hook(method, url, headers, raw, timeout)
            if asyncio.iscoroutine(result):
                result = await result
            status, payload = result
            return int(status), payload if isinstance(payload, bytes) else json.dumps(payload or {}).encode("utf-8")
        except Exception:
            return 0, b""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=timeout),
                                     follow_redirects=True, trust_env=not _is_lan_url(url)) as client:
            response = await client.request(method, url, headers=headers, content=raw)
            return int(response.status_code), response.content
    except Exception:
        return 0, b""


def _remove_quiet(path: str) -> None:
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def _json_of(content: bytes) -> Any:
    try:
        return json.loads(content.decode("utf-8") or "{}")
    except (ValueError, AttributeError):
        return {}


# ---------------------------------------------------------------- 节点

def discover_nodes() -> List[Dict[str, Any]]:
    """本机能看到的社区节点：UDP 发现到的 NOVAI + 已加的好友（去重，好友优先用 base_url）。"""
    override = _override_nodes()
    if override is not None:
        return [{
            "id": str(node.get("id") or ""),
            "nickname": str(node.get("nickname") or "局域网用户"),
            "avatar": str(node.get("avatar") or ""),
            "base": str(node.get("base") or node.get("base_url") or "").rstrip("/"),
            "token": str(node.get("token") or ""),
            "online": bool(node.get("online", True)),
        } for node in override if str(node.get("base") or node.get("base_url") or "").strip()]
    try:
        from server.routes.lan_account import load_account, load_friends, peers_snapshot
    except Exception:
        return []
    own = ""
    try:
        own = str(load_account().get("id") or "")
    except Exception:
        own = ""
    nodes: Dict[str, Dict[str, Any]] = {}
    for peer in peers_snapshot():
        peer_id = str(peer.get("id") or "")
        if not peer_id or peer_id == own:
            continue
        ip = str(peer.get("ip") or "").strip()
        port = int(peer.get("port") or 0)
        if not ip or not port:
            continue
        nodes[peer_id] = {
            "id": peer_id,
            "nickname": str(peer.get("nickname") or "局域网用户"),
            "avatar": str(peer.get("avatar") or ""),
            "base": "http://%s:%d" % (ip, port),
            "token": str(peer.get("token") or ""),
            "online": True,
        }
    try:
        friends = load_friends()
    except Exception:
        friends = []
    for friend in friends:
        base = str(friend.get("base_url") or "").rstrip("/")
        friend_id = str(friend.get("id") or "")
        if not base or not friend_id or friend_id == own:
            continue
        # UDP 30s 内刚发现的地址比好友表里存的新（对方换了 IP / 端口），已有就不拿旧地址覆盖
        nodes.setdefault(friend_id, {
            "id": friend_id,
            "nickname": str(friend.get("nickname") or "好友"),
            "avatar": str(friend.get("avatar") or ""),
            "base": base,
            "token": str(friend.get("token") or ""),
            "online": True,
        })
    return list(nodes.values())


_ITEM_NODES: Dict[str, Dict[str, Any]] = {}


def node_of(item_id: str) -> Optional[Dict[str, Any]]:
    node = _ITEM_NODES.get(str(item_id or ""))
    return dict(node) if node else None


def remember_item_node(item_id: str, node: Dict[str, Any]) -> None:
    if item_id and node:
        _ITEM_NODES[str(item_id)] = dict(node)


# ---------------------------------------------------------------- 传输实现

class CommunityTransport:
    """社区传输接口。前端与本地接口只认这层，换云端实现不改路由。"""

    name = "abstract"

    async def aggregate(self, force: bool = False) -> Dict[str, Any]:
        raise NotImplementedError

    async def item_detail(self, item_id: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    async def item_package(self, item_id: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    async def download_media(self, item_id: str, filename: str) -> Optional[bytes]:
        raise NotImplementedError

    async def download_cover(self, item_id: str) -> Optional[bytes]:
        raise NotImplementedError

    async def post_event(self, item_id: str, payload: Dict[str, Any]) -> bool:
        raise NotImplementedError

    async def author_profile(self, item_id: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    async def profile_from_node(self, node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        raise NotImplementedError


class LanTransport(CommunityTransport):
    name = "lan"

    def __init__(self) -> None:
        self._feed_cache: Dict[str, Any] = {"at": 0, "data": None, "ttl": FEED_CACHE_MS}
        # 节点 id -> {"at": 最近一次拉到的时间, "items": [...]}：节点抖一下时作品不消失
        self._last_good: Dict[str, Dict[str, Any]] = {}

    async def aggregate(self, force: bool = False) -> Dict[str, Any]:
        stamp = store.now_ms()
        cached = self._feed_cache.get("data")
        ttl = int(self._feed_cache.get("ttl") or FEED_CACHE_MS)
        if cached and not force and stamp - int(self._feed_cache.get("at") or 0) < ttl:
            return cached

        nodes = discover_nodes()
        results = await asyncio.gather(*[self._node_items(node) for node in nodes], return_exceptions=True)
        items: List[Dict[str, Any]] = []
        reachable: List[Dict[str, Any]] = []
        seen = set()
        partial = False
        for node, result in zip(nodes, results):
            node_id = str(node.get("id") or "")
            online = True
            if isinstance(result, Exception) or result is None:
                partial = True
                online = False
                last = self._last_good.get(node_id) or {}
                if last and stamp - int(last.get("at") or 0) <= FEED_STALE_KEEP_MS:
                    node_items = list(last.get("items") or [])
                else:
                    # 发现到但拉不到：节点照样进列表并标 offline，前端才能显示「发现到但连不上」
                    reachable.append({**node, "item_count": 0, "online": False})
                    continue
            else:
                node_items = result
                if node_id:
                    self._last_good[node_id] = {"at": stamp, "items": list(node_items)}
            reachable.append({**node, "item_count": len(node_items), "online": online})
            for raw in node_items:
                if not isinstance(raw, dict):
                    continue
                item_id = str(raw.get("id") or "")
                if not store.valid_item_id(item_id) or item_id in seen:
                    continue
                seen.add(item_id)
                remember_item_node(item_id, node)
                public = store.item_public(raw, online=online)
                public["node"] = {"id": node.get("id"), "nickname": node.get("nickname"),
                                  "avatar": node.get("avatar"), "online": online}
                items.append(public)
        data = {
            "items": items,
            "nodes": reachable,
            "creators_online": sum(1 for node in reachable if node.get("online")),
            "at": stamp,
        }
        self._feed_cache = {"at": stamp, "data": data,
                            "ttl": FEED_CACHE_PARTIAL_MS if partial else FEED_CACHE_MS}
        return data

    async def _node_items(self, node: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
        base = str(node.get("base") or "").rstrip("/")
        if not base:
            return None
        status, content = 0, b""
        for _attempt in range(FEED_NODE_ATTEMPTS):
            status, content = await _fetch_bytes("GET", base + "/api/community/public/items",
                                                 str(node.get("token") or ""), timeout=FEED_NODE_TIMEOUT)
            # 只对「连不上 / 超时」重试；对方明确回了 4xx（没开可见 / 限流）就不再打扰
            if status != 0:
                break
        if status == 404:
            # 对方明确关了「局域网社区可见」：作品就该下架，不沿用旧列表
            self._last_good.pop(str(node.get("id") or ""), None)
            return []
        if status != 200:
            return None
        body = _json_of(content)
        items = body.get("items") if isinstance(body, dict) else None
        author = body.get("author") if isinstance(body, dict) else None
        if isinstance(author, dict) and not items:
            return []
        return [entry for entry in (items or []) if isinstance(entry, dict)]

    def _node_for_item(self, item_id: str) -> Optional[Dict[str, Any]]:
        node = node_of(item_id)
        if node:
            return node
        # 没聚合过：现场发现一次（单节点超时内很快）
        for candidate in discover_nodes():
            remember_item_node(item_id, candidate)
        return node_of(item_id)

    async def item_detail(self, item_id: str, lite: bool = False) -> Optional[Dict[str, Any]]:
        """lite=True 只要元数据（画布数据走 package 拉一次，不重复传）；老版本节点忽略参数照样带 payload。"""
        node = self._node_for_item(item_id)
        if not node:
            return None
        status, content = await _fetch_bytes(
            "GET", str(node["base"]) + "/api/community/public/items/" + item_id + ("?lite=1" if lite else ""),
            str(node.get("token") or ""), timeout=DETAIL_TIMEOUT)
        if status != 200:
            return None
        body = _json_of(content)
        if not isinstance(body, dict) or not isinstance(body.get("item"), dict):
            return None
        remember_item_node(item_id, node)
        return body

    async def item_package(self, item_id: str) -> Optional[Dict[str, Any]]:
        node = self._node_for_item(item_id)
        if not node:
            return None
        status, content = await _fetch_bytes(
            "GET", str(node["base"]) + "/api/community/public/items/" + item_id + "/package",
            str(node.get("token") or ""), timeout=PACKAGE_TIMEOUT)
        if status != 200:
            return None
        body = _json_of(content)
        package = body.get("package") if isinstance(body, dict) else None
        if not isinstance(package, dict):
            return None
        remember_item_node(item_id, node)
        return package

    async def download_media(self, item_id: str, filename: str) -> Optional[bytes]:
        node = self._node_for_item(item_id)
        if not node or not store.valid_file_name(filename):
            return None
        url = str(node["base"]) + "/api/community/public/media/" + item_id + "/" + filename
        status, content = await _fetch_bytes("GET", url, str(node.get("token") or ""), timeout=MEDIA_TIMEOUT)
        if status != 200 or not content:
            return None
        if len(content) > MEDIA_MAX_FILE_BYTES:
            return None
        return content

    async def download_media_to(self, item_id: str, filename: str, dest_path: str) -> bool:
        """媒体流式写到 dest_path（先写 .part 再改名），不整段读进内存；成功返回 True。"""
        node = self._node_for_item(item_id)
        if not node or not store.valid_file_name(filename):
            return False
        url = str(node["base"]) + "/api/community/public/media/" + item_id + "/" + filename
        token = str(node.get("token") or "")
        # 后台预取和克隆可能同时拉同一个文件：临时名各自唯一，改名是原子的
        # 点开头：不会被 cached_media_names 的文件名白名单当成素材
        temp_path = os.path.join(os.path.dirname(dest_path) or ".",
                                 ".%s.%s.part" % (os.path.basename(dest_path), uuid.uuid4().hex[:8]))
        os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
        if _http_hook():
            status, content = await _fetch_bytes("GET", url, token, timeout=MEDIA_TIMEOUT)
            if status != 200 or not content or len(content) > MEDIA_MAX_FILE_BYTES:
                return False
            try:
                with open(temp_path, "wb") as handle:
                    handle.write(content)
                os.replace(temp_path, dest_path)
                return True
            except OSError:
                _remove_quiet(temp_path)
                return False
        headers = {"X-NOVAI-Friend-Token": token} if token else {}
        timeout = httpx.Timeout(MEDIA_TIMEOUT, connect=MEDIA_TIMEOUT, read=MEDIA_TIMEOUT,
                                write=MEDIA_TIMEOUT, pool=None)
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                         trust_env=not _is_lan_url(url)) as client:
                async with client.stream("GET", url, headers=headers) as response:
                    if response.status_code != 200:
                        return False
                    received = 0
                    with open(temp_path, "wb") as handle:
                        async for chunk in response.aiter_bytes(256 * 1024):
                            if not chunk:
                                continue
                            received += len(chunk)
                            if received > MEDIA_MAX_FILE_BYTES:
                                raise ValueError("too large")
                            handle.write(chunk)
            if received <= 0:
                _remove_quiet(temp_path)
                return False
            os.replace(temp_path, dest_path)
            return True
        except Exception:
            _remove_quiet(temp_path)
            return False

    async def download_cover(self, item_id: str) -> Optional[bytes]:
        """封面在发布包根目录，/public/media 只服务 media/ 子目录，得走专门的封面路由。"""
        node = self._node_for_item(item_id)
        if not node:
            return None
        url = str(node["base"]) + "/api/community/public/items/" + item_id + "/cover"
        status, content = await _fetch_bytes("GET", url, str(node.get("token") or ""),
                                             timeout=MEDIA_TIMEOUT)
        if status == 200 and content and len(content) <= MEDIA_MAX_FILE_BYTES:
            return content
        # 老版本节点没有封面路由：退回 media 目录再试一次
        return await self.download_media(item_id, "cover.webp")

    async def post_event(self, item_id: str, payload: Dict[str, Any]) -> bool:
        node = self._node_for_item(item_id)
        if not node:
            return False
        status, _content = await _fetch_bytes(
            "POST", str(node["base"]) + "/api/community/public/items/" + item_id + "/event",
            str(node.get("token") or ""), body=payload, timeout=NODE_TIMEOUT)
        return status == 200

    async def profile_from_node(self, node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """直接按节点取对方的主页（好友列表里给「主页」用，不必先有作品 id）。"""
        base = str((node or {}).get("base") or "").rstrip("/")
        if not base:
            return None
        status, content = await _fetch_bytes("GET", base + "/api/community/public/profile",
                                             str(node.get("token") or ""), timeout=PROFILE_TIMEOUT)
        if status != 200:
            return None
        body = _json_of(content)
        return body if isinstance(body, dict) else None

    async def author_profile(self, item_id: str) -> Optional[Dict[str, Any]]:
        node = self._node_for_item(item_id)
        if not node:
            return None
        status, content = await _fetch_bytes(
            "GET", str(node["base"]) + "/api/community/public/profile",
            str(node.get("token") or ""), timeout=PROFILE_TIMEOUT)
        if status != 200:
            return None
        body = _json_of(content)
        return body if isinstance(body, dict) else None


TRANSPORT: CommunityTransport = LanTransport()


def get_transport() -> CommunityTransport:
    return TRANSPORT


def set_transport(transport: CommunityTransport) -> None:
    global TRANSPORT
    TRANSPORT = transport


def clear_feed_cache() -> None:
    transport = get_transport()
    if isinstance(transport, LanTransport):
        transport._feed_cache = {"at": 0, "data": None, "ttl": FEED_CACHE_MS}


# ---------------------------------------------------------------- 缓存（作者离线时仍可浏览 / 克隆）

def cache_meta_path(item_id: str) -> str:
    return os.path.join(store.cache_item_dir(item_id), "meta.json")


def _write_meta(item: Dict[str, Any]) -> None:
    directory = store.cache_item_dir(str(item.get("id") or ""))
    os.makedirs(directory, exist_ok=True)
    tmp = cache_meta_path(str(item.get("id") or "")) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(item, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, cache_meta_path(str(item.get("id") or "")))


def load_cached_items() -> List[Dict[str, Any]]:
    root = store.cache_dir()
    if not os.path.isdir(root):
        return []
    items: List[Dict[str, Any]] = []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    for name in names:
        if not store.valid_item_id(name):
            continue
        try:
            with open(cache_meta_path(name), "r", encoding="utf-8") as handle:
                item = json.load(handle)
        except (OSError, ValueError):
            continue
        if isinstance(item, dict):
            items.append(item)
    return items


def remember_cached_item(item: Dict[str, Any]) -> None:
    item_id = str((item or {}).get("id") or "")
    if not store.valid_item_id(item_id):
        return
    _write_meta(store.item_public(item, online=False))


def cache_media_dir(item_id: str) -> str:
    return os.path.join(store.cache_item_dir(item_id), "media")


def cached_media_path(item_id: str, filename: str) -> Optional[str]:
    if not store.valid_file_name(filename):
        return None
    path = os.path.join(cache_media_dir(item_id), filename)
    return path if os.path.isfile(path) and os.path.getsize(path) > 0 else None


def cached_media_names(item_id: str) -> List[str]:
    directory = cache_media_dir(item_id)
    try:
        return [name for name in sorted(os.listdir(directory)) if store.valid_file_name(name)]
    except OSError:
        return []


async def fetch_media_to_cache(item_id: str, filename: str) -> Optional[str]:
    """确保媒体在本机缓存里，返回缓存路径（已在缓存直接返回）；拉不到返回 None。"""
    cached = cached_media_path(item_id, filename)
    if cached:
        return cached
    if not store.valid_file_name(filename):
        return None
    transport = get_transport()
    target = os.path.join(cache_media_dir(item_id), filename)
    saver = getattr(transport, "download_media_to", None)
    if callable(saver):
        ok = await saver(item_id, filename, target)
        return target if ok and os.path.isfile(target) else None
    content = await transport.download_media(item_id, filename)
    if not content:
        return None
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(content)
    except OSError:
        return None
    return target


async def prefetch_media(item_id: str, filenames: List[str]) -> int:
    """把作品媒体拉到本机缓存（打开详情后调用），成功的返回条数。"""
    semaphore = asyncio.Semaphore(MEDIA_CONCURRENCY)
    budget = {"bytes": 0}
    saved = {"count": 0}

    async def one(filename: str) -> None:
        if cached_media_path(item_id, filename):
            saved["count"] += 1
            return
        async with semaphore:
            if budget["bytes"] >= MEDIA_MAX_TOTAL_BYTES:
                return
            path = await fetch_media_to_cache(item_id, filename)
        if not path:
            return
        try:
            budget["bytes"] += os.path.getsize(path)
        except OSError:
            pass
        saved["count"] += 1

    await asyncio.gather(*[one(name) for name in (filenames or [])[:packager.MAX_MEDIA_FILES]],
                         return_exceptions=True)
    return saved["count"]


def media_names_from_payload(package: Dict[str, Any], item_id: str) -> List[str]:
    """从 package / payload 里找出「这个作品自己的媒体文件」名字。"""
    names: List[str] = []
    seen = set()
    for url in packager.collect_canvas_media((package or {}).get("payload") or {}):
        text = str(url or "")
        name = packager.media_filename_of(text, item_id)
        if name and store.valid_file_name(name) and name not in seen:
            seen.add(name)
            names.append(name)
    return names


def media_content_type(filename: str) -> str:
    return packager._media_content_type(filename)


def purge_cache() -> None:
    shutil.rmtree(store.cache_dir(), ignore_errors=True)
