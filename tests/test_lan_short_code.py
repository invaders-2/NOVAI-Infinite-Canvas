#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T52：6 位短好友码 + UDP 局域网发现的契约测试。

和 test_lan_account_store.py 一样不启动 main.py：用 deps 绑测试桩直接跑路由与纯函数。
UDP 广播本身不在这里起真 socket：启动 / 幂等用替身循环验证，真实端口留给临时实例手工验收。
用法：venv/bin/python tests/test_lan_short_code.py
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.routes.deps import deps  # noqa: E402
from server.routes import lan_account as lan  # noqa: E402

FAILED = 0
PEER_ID = "e1f2a3b4c5d60718"
PEER_TOKEN = "f" * 48
PEER_CODE = "7K3F9Q"
LEGACY_TOKEN = "0123456789abcdef0123456789abcdef"


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


class Peer:
    """假的好友机：按口令回 account_id，模拟 /api/lan/ping。"""

    def __init__(self) -> None:
        self.accounts = {}

    def __call__(self, url, method="GET", payload=None, headers=None, timeout=1.5):
        token = str((headers or {}).get("X-NOVAI-Friend-Token") or "")
        account_id = str(self.accounts.get(token) or "")
        if str(url).endswith("/api/lan/ping"):
            body = {"ok": True, "account_id": account_id, "authorized": bool(account_id),
                    "can_receive": bool(account_id), "version": "novai-v16"}
            if account_id:
                body["nickname"] = "B 君"
                body["avatar"] = "🐳"
            return 200, body
        return 404, {}


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-lan-short-")
    os.environ["NOVAI_LAN_DISCOVERY"] = "0"     # 单测不占 UDP 端口
    os.environ["NOVAI_LAN_IP"] = "10.25.1.8"
    peer = Peer()
    deps.bind(DATA_DIR=data_dir, LAN_HTTP_JSON=peer, APP_VERSION="novai-v16-test")

    app = FastAPI()
    app.include_router(lan.router)
    client = TestClient(app)

    # 1. /me：6 位 code + friend_code = NOVAI-<code>，其余字段保持原样
    me = client.get("/api/lan/me")
    check("GET /me 200", me.status_code == 200, str(me.status_code))
    account = me.json().get("me") or {}
    code = str(account.get("code") or "")
    check("code 是 6 位合法字符", bool(re.match(r"^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$", code)), code)
    check("friend_code = NOVAI-<code>", account.get("friend_code") == "NOVAI-" + code, str(account.get("friend_code")))
    check("旧字段仍在（id/nickname/avatar/lan_ip/port/version）",
          all(key in account for key in ("id", "nickname", "avatar", "lan_ip", "port", "version")),
          str(sorted(account.keys())))
    raw = json.load(open(os.path.join(data_dir, lan.ACCOUNT_FILE), encoding="utf-8"))
    check("code 已落盘", raw.get("code") == code, str(raw.get("code")))

    own = lan.load_account()
    own_id, own_token = str(own.get("id") or ""), str(own.get("token") or "")
    peer.accounts = {own_token: own_id, PEER_TOKEN: PEER_ID}
    check("重新加载 code 不变", lan.load_account().get("code") == code)
    check("friend_code_of = NOVAI-<code>", lan.friend_code_of(lan.load_account()) == "NOVAI-" + code)

    renamed = client.put("/api/lan/me", json={"nickname": "A 君", "avatar": "🐼"})
    check("改昵称 / 头像不换 code", (renamed.json().get("me") or {}).get("code") == code,
          str((renamed.json().get("me") or {}).get("code")))

    # 2. 老账号文件没有 code：第一次读取补生成并写回，且只由 id 决定
    legacy = {"version": 1, "id": "0123456789abcdef", "token": "a" * 48, "nickname": "老账号",
              "avatar": "🙂", "created_at": 1, "updated_at": 1}
    lan.save_account(legacy)
    migrated = lan.load_account()
    expected = lan.derive_account_code("0123456789abcdef")
    check("老账号补出 code", migrated.get("code") == expected, str(migrated.get("code")))
    raw = json.load(open(os.path.join(data_dir, lan.ACCOUNT_FILE), encoding="utf-8"))
    check("老账号 code 写回文件", raw.get("code") == expected, str(raw.get("code")))
    check("同一 id 派生结果稳定", lan.derive_account_code("0123456789abcdef") == expected)
    check("不同 id 派生不同 code", lan.derive_account_code("fedcba9876543210") != expected)
    own_id, own_token = str(migrated.get("id") or ""), str(migrated.get("token") or "")
    peer.accounts = {own_token: own_id, PEER_TOKEN: PEER_ID}

    # 3. parse_friend_code 三种输入
    parsed = lan.parse_friend_code("NOVAI-10.25.1.8:3000-" + LEGACY_TOKEN)
    check("旧码仍解析出 ip/port/token",
          bool(parsed) and parsed.get("ip") == "10.25.1.8" and parsed.get("port") == "3000"
          and parsed.get("token") == LEGACY_TOKEN, str(parsed))
    check("旧码 base_url 不变", (parsed or {}).get("base_url") == "http://10.25.1.8:3000", str(parsed))
    check("旧码带空格也能解析", lan.parse_friend_code(" NOVAI-10.25.1.8:3000-" + LEGACY_TOKEN + " ") is not None)
    check("旧码端口越界 None", lan.parse_friend_code("NOVAI-10.25.1.8:99999-" + LEGACY_TOKEN) is None)
    check("旧码口令太短 None", lan.parse_friend_code("NOVAI-10.25.1.8:3000-abc") is None)

    short = lan.parse_friend_code("NOVAI-" + PEER_CODE)
    check("新码 NOVAI-<CODE> 解析", bool(short) and short.get("kind") == "short" and short.get("code") == PEER_CODE, str(short))
    bare = lan.parse_friend_code(PEER_CODE.lower())
    check("裸小写短码解析并归一", bool(bare) and bare.get("code") == PEER_CODE, str(bare))
    check("非法短码 None", lan.parse_friend_code("NOVAI-7K3F9") is None)
    check("空串 None", lan.parse_friend_code("") is None)
    check("乱写 None", lan.parse_friend_code("hello") is None)

    # 4. 旧码加好友仍然可用；旧好友记录没有 code 时列表给空串
    added = client.post("/api/lan/friends", json={"code": "NOVAI-10.25.1.9:3000-" + PEER_TOKEN})
    check("旧码加好友 200", added.status_code == 200, added.text[:120])
    friends = client.get("/api/lan/friends").json().get("friends") or []
    old_friend = [item for item in friends if item.get("id") == PEER_ID]
    check("旧好友列表 code 为空串", len(old_friend) == 1 and old_friend[0].get("code") == "", str(old_friend))
    check("旧好友仍在线", len(old_friend) == 1 and old_friend[0].get("online") is True, str(old_friend))

    # 5. 发现表：记 peer、忽略自己、/discover 不泄露 ip/port/token
    lan._PEERS.clear()
    lan._remember_peer({"novai_lan": 1, "code": PEER_CODE, "id": PEER_ID, "port": 3998,
                        "nickname": "B 君", "avatar": "🐳", "token": PEER_TOKEN},
                       "10.25.1.9", own_id)
    found = lan.find_peer(PEER_CODE)
    check("发现表记下 peer 的 ip/port/token",
          bool(found) and found.get("ip") == "10.25.1.9" and found.get("port") == 3998
          and found.get("token") == PEER_TOKEN, str(found))
    own_short = lan.account_code(lan.load_account())
    lan._remember_peer({"novai_lan": 1, "code": own_short, "id": own_id, "port": 3998,
                        "nickname": "自己", "avatar": "🙂", "token": own_token}, "10.25.1.8", own_id)
    check("忽略自己的广播包", lan.find_peer(own_short) is None)
    lan._remember_peer({"novai_lan": 1, "code": "bad", "id": PEER_ID, "port": 3998}, "10.25.1.9", own_id)
    check("非法 code 的包被丢弃", lan.find_peer("BAD") is None)
    lan._remember_peer({"novai_lan": 1, "code": PEER_CODE, "id": PEER_ID, "port": 70000}, "10.25.1.9", own_id)
    check("非法端口的包被丢弃", (lan.find_peer(PEER_CODE) or {}).get("port") == 3998, str(lan.find_peer(PEER_CODE)))

    discovered = client.get("/api/lan/discover")
    check("GET /discover 200", discovered.status_code == 200, str(discovered.status_code))
    peers = discovered.json().get("peers") or []
    check("发现列表含 peer", len(peers) == 1 and peers[0].get("code") == PEER_CODE, str(peers))
    check("/discover 只有 code/nickname/avatar/online",
          len(peers) == 1 and set(peers[0].keys()) == {"code", "nickname", "avatar", "online"}, str(peers))
    check("/discover 不返回 ip/port/token",
          len(peers) == 1 and all(key not in peers[0] for key in ("ip", "port", "token")), str(peers))

    # 6. 短码加好友：查发现表 → 拼 base_url + 用发现到的 token 走原有 ping 流程
    short_add = client.post("/api/lan/friends", json={"code": "NOVAI-" + PEER_CODE})
    check("短码加好友 200", short_add.status_code == 200, short_add.text[:160])
    short_friend = short_add.json().get("friend") or {}
    check("短码加好友带上 code", short_friend.get("code") == PEER_CODE, str(short_friend.get("code")))
    check("短码加好友用广播到的地址", short_friend.get("base_url") == "http://10.25.1.9:3998", str(short_friend.get("base_url")))
    check("短码加好友对方 ID 来自 ping", short_friend.get("id") == PEER_ID, str(short_friend.get("id")))
    friends = client.get("/api/lan/friends").json().get("friends") or []
    updated = [item for item in friends if item.get("id") == PEER_ID]
    check("好友列表每项都有 code 字段", len(updated) == 1 and updated[0].get("code") == PEER_CODE, str(updated))

    missing = client.post("/api/lan/friends", json={"code": "NOVAI-ABCDEF"})
    check("发现不到短码 400", missing.status_code == 400, str(missing.status_code))
    check("发现不到错误文案精确",
          (missing.json().get("detail") or "").startswith("没在局域网里发现这个 ID"),
          str((missing.json() or {}).get("detail")))
    self_add = client.post("/api/lan/friends", json={"code": "NOVAI-" + own_short})
    check("加自己的短码 400", self_add.status_code == 400, str(self_add.status_code))

    # 7. 30 秒没更新就过期：发现列表和短码加好友同时失效
    lan._PEERS[PEER_CODE]["seen_at"] = lan.now_ms() - lan.DISCOVERY_TTL_MS - 1
    check("过期的 peer 从列表消失", lan.peers_snapshot() == [], str(lan.peers_snapshot()))
    check("过期的 peer 查不到", lan.find_peer(PEER_CODE) is None)
    expired_add = client.post("/api/lan/friends", json={"code": "NOVAI-" + PEER_CODE})
    check("过期后再用短码加好友 400", expired_add.status_code == 400, str(expired_add.status_code))

    # 8. start_discovery：默认关闭开关生效、重复调用只起一个线程（用替身循环，不真占端口）
    os.environ["NOVAI_LAN_DISCOVERY"] = "0"
    lan.start_discovery()
    check("NOVAI_LAN_DISCOVERY=0 不启动", lan._DISCOVERY_STARTED is False)
    os.environ["NOVAI_LAN_DISCOVERY"] = "1"
    stop = threading.Event()
    real_loop = lan._discovery_loop
    lan._discovery_loop = lambda: stop.wait(2)
    try:
        lan.start_discovery()
        lan.start_discovery()
        threads = [item for item in threading.enumerate() if item.name == "novai-lan-discovery"]
        check("重复调用只起一个线程", len(threads) == 1, str(len(threads)))
    finally:
        stop.set()
        lan._discovery_loop = real_loop
        lan._DISCOVERY_STARTED = False

    shutil.rmtree(data_dir, ignore_errors=True)
    print("")
    if FAILED:
        print("短好友码 / 局域网发现单测失败 %d 项" % FAILED)
        return 1
    print("短好友码 / 局域网发现单测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
