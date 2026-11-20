#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""局域网数据按云账号归属（隔离 / 迁移 / 注销清理）的后端测试。

真正的 pytest 用例：4 条 test_* 各自用 tmp_path 造独立数据目录，
用 server.auth 真实注册 + 会话 cookie 造登录态（不依赖鉴权中间件），
好友机用另一个主机:端口的 HTTP 桩（deps.LAN_HTTP_JSON）模拟。

跑法：
    venv/bin/python -m pytest -q tests/test_lan_account_owner.py
    venv/bin/python tests/test_lan_account_owner.py          # 等价（node 测试用它）
"""
from __future__ import annotations

import json
import os
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server.routes.deps import deps  # noqa: E402
from server.routes import lan_account as lan  # noqa: E402
from server.auth import ratelimit as auth_ratelimit  # noqa: E402
from server.auth import service as auth_service  # noqa: E402
from server.auth import store as auth_store  # noqa: E402

PASSWORD = "Novai-pass-123"
PEER_ID = "0f1e2d3c4b5a6978"
PEER_TOKEN = "b" * 47 + "1"
PEER_ID_2 = "1122334455667788"
PEER_TOKEN_2 = "c" * 47 + "2"


class Peer:
    """对面那台机器：另一个主机:端口上的 /api/lan/ping、/api/lan/messages 桩。

    accounts = {本机身份口令: 对面认得的账号 id}，用来模拟两台机器互认 token。"""

    def __init__(self) -> None:
        self.accounts = {}
        self.received = []

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
        if str(url).endswith("/api/lan/messages"):
            if not account_id:
                return 403, {"detail": "好友凭据无效"}
            self.received.append({"payload": payload, "headers": dict(headers or {})})
            return 200, {"ok": True, "duplicate": False}
        return 404, {}


@pytest.fixture(autouse=True)
def _isolated_lan_state(monkeypatch):
    """每条用例从干净状态开始：不占 UDP 端口、不跑后台补发线程、清掉模块级缓存。"""
    monkeypatch.setenv("NOVAI_LAN_DISCOVERY", "0")
    monkeypatch.setenv("NOVAI_AUTH_MODE", "optional")
    monkeypatch.setenv("NOVAI_REGISTER_IP_LIMIT", "1000")
    previous_retry = lan.AUTO_RETRY
    lan.AUTO_RETRY = False
    with lan._PENDING_LOCK:
        lan._PENDING_FRIENDS.clear()
    with lan._PEERS_LOCK:
        lan._PEERS.clear()
    with lan._ONLINE_LOCK:
        lan._ONLINE_CACHE.clear()
    lan._reset_local_ids()
    auth_ratelimit.reset()
    try:
        yield
    finally:
        lan.AUTO_RETRY = previous_retry
        lan._reset_local_ids()


@pytest.fixture()
def data_dir(tmp_path):
    """独立数据目录：LAN 走 deps.DATA_DIR，auth 的 users.db 也落在同一个目录。"""
    path = str(tmp_path / "data")
    os.makedirs(path, exist_ok=True)
    deps.bind(DATA_DIR=path, APP_VERSION="novai-v16-test")
    auth_store.set_data_dir(path)
    try:
        yield path
    finally:
        auth_store.set_data_dir("")


@pytest.fixture()
def peer():
    return Peer()


@pytest.fixture()
def app(data_dir, peer):
    deps.bind(LAN_HTTP_JSON=peer)
    application = FastAPI()
    application.include_router(lan.router)
    return application


def login(app, username: str):
    """真实注册一个云账号，拿它的会话 cookie 造一个已登录客户端。"""
    user, token = auth_service.register(username, PASSWORD, "", "", "")
    client = TestClient(app)
    client.cookies.set(auth_service.COOKIE_NAME, token)
    return client, user


def anonymous(app):
    return TestClient(app)


def me(client) -> dict:
    return (client.get("/api/lan/me").json() or {}).get("me") or {}


def friends(client) -> list:
    return client.get("/api/lan/friends").json().get("friends") or []


def chat(client, friend_id: str) -> list:
    return client.get("/api/lan/messages", params={"with": friend_id}).json().get("messages") or []


def legacy_code(peer_token: str) -> str:
    return "NOVAI-192.168.1.9:3000-" + peer_token


def add_peer(client, peer_token: str):
    return client.post("/api/lan/friends", json={"code": legacy_code(peer_token)})


def test_two_accounts_are_isolated(app, peer, data_dir):
    """同一台机器两个账号：各自 me / 好友 / 聊天 / 好友申请 / ping 互不可见。"""
    ua, user_a = login(app, "lan-user-1")
    ub, user_b = login(app, "lan-user-2")
    assert user_a["id"] != user_b["id"]
    key_a, key_b = "u%d" % user_a["id"], "u%d" % user_b["id"]

    me_a, me_b = me(ua), me(ub)
    assert me_a["id"] and me_b["id"] and me_a["id"] != me_b["id"]
    assert me_a["code"] != me_b["code"]

    tokens = {key: str(account.get("token") or "") for key, account in lan.load_accounts().items()}
    assert key_a in tokens and key_b in tokens
    peer.accounts = {tokens[key_a]: me_a["id"], tokens[key_b]: me_b["id"], PEER_TOKEN: PEER_ID}

    ua.put("/api/lan/me", json={"nickname": "甲", "avatar": "🐼"})
    ub.put("/api/lan/me", json={"nickname": "乙", "avatar": "🦊"})
    assert me(ua)["nickname"] == "甲"
    assert me(ub)["nickname"] == "乙"

    assert add_peer(ua, PEER_TOKEN).status_code == 200
    assert len(friends(ua)) == 1
    assert friends(ub) == []

    sent = ua.post("/api/lan/friends/%s/send" % PEER_ID, json={"text": "只发给账号 1", "message_id": "m-own-0001"})
    assert sent.status_code == 200, sent.text
    assert any(item.get("id") == "m-own-0001" for item in chat(ua, PEER_ID))
    assert chat(ub, PEER_ID) == []
    # 聊天按账号分目录
    assert os.path.isfile(os.path.join(data_dir, lan.CHAT_DIR, key_a, PEER_ID + ".json"))
    assert not os.path.exists(os.path.join(data_dir, lan.CHAT_DIR, key_b, PEER_ID + ".json"))

    # 好友机投递：带账号 1 的口令，只进账号 1 的会话
    inbox = {"from": {"id": PEER_ID, "nickname": "B 君", "avatar": "🐳",
                      "base_url": "http://192.168.1.9:3000", "token": PEER_TOKEN},
             "message": {"id": "in-own-0001", "kind": "text", "text": "回给账号 1", "ts": lan.now_ms()}}
    delivered = TestClient(app).post("/api/lan/messages", json=inbox,
                                     headers={"X-NOVAI-Friend-Token": tokens[key_a]})
    assert delivered.status_code == 200, delivered.text
    assert any(item.get("id") == "in-own-0001" for item in chat(ua, PEER_ID))
    assert chat(ub, PEER_ID) == []

    # 好友申请同样按账号隔离
    request_body = {"from": {"id": PEER_ID_2, "nickname": "C 君", "avatar": "🦉",
                             "base_url": "http://192.168.1.10:3000", "token": PEER_TOKEN_2, "code": "111111"},
                    "ts": lan.now_ms()}
    asked = TestClient(app).post("/api/lan/friend-requests", json=request_body,
                                 headers={"X-NOVAI-Friend-Token": tokens[key_a]})
    assert asked.status_code == 200, asked.text
    incoming_a = ua.get("/api/lan/friend-requests").json().get("incoming") or []
    incoming_b = ub.get("/api/lan/friend-requests").json().get("incoming") or []
    assert len(incoming_a) == 1
    assert incoming_b == []

    # ping 以口令认身份
    ping_a = TestClient(app).get("/api/lan/ping", headers={"X-NOVAI-Friend-Token": tokens[key_a]}).json()
    ping_b = TestClient(app).get("/api/lan/ping", headers={"X-NOVAI-Friend-Token": tokens[key_b]}).json()
    assert ping_a["account_id"] == me_a["id"] and ping_a["nickname"] == "甲"
    assert ping_b["account_id"] == me_b["id"] and ping_b["nickname"] == "乙"
    stranger = TestClient(app).get("/api/lan/ping").json()
    assert stranger["authorized"] is False and "nickname" not in stranger


def test_anonymous_uses_local_bucket(app, peer, data_dir):
    """没登录（= 鉴权关闭 / 老单机模式）：走无归属桶 _local，和云账号各算各的。

    注意顺序：先有云账号、再有整机桶，_local 才不会被当成「升级前的整机旧数据」等着被
    第一个登录账号接手（那条规则由 test_migration_runs_once_and_first_login_claims 覆盖）。"""
    ua, user_a = login(app, "lan-user-1")
    who_a = me(ua)                      # 账号先有自己的局域网身份
    anonymous_client = anonymous(app)
    who = me(anonymous_client)          # 之后才出现的整机桶不再被当成「旧数据」
    accounts = lan.load_accounts()
    assert "_local" in accounts
    assert who["id"] == accounts["_local"]["id"]
    assert who["id"] != who_a["id"]
    assert "u%d" % user_a["id"] in accounts

    # 未登录加的好友 / 消息，登录账号看不到；反过来也一样
    anonymous_client.put("/api/lan/me", json={"nickname": "整机用户", "avatar": "🙂"})
    peer.accounts = {str(accounts["_local"]["token"]): who["id"], PEER_TOKEN: PEER_ID}
    assert add_peer(anonymous_client, PEER_TOKEN).status_code == 200
    assert len(friends(anonymous_client)) == 1
    assert friends(ua) == []
    assert me(anonymous_client)["id"] == who["id"]


def test_migration_runs_once_and_first_login_claims(app, peer, data_dir):
    """v1 整机数据只升级一次；升级后第一个登录账号接手，第二个账号是全新身份。"""
    old_id = "aaaabbbbccccdddd"
    with open(os.path.join(data_dir, lan.ACCOUNT_FILE), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "id": old_id, "token": "d" * 48, "nickname": "老用户", "avatar": "🐼"}, fh)
    with open(os.path.join(data_dir, lan.FRIENDS_FILE), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "friends": [{"id": PEER_ID, "nickname": "B 君", "avatar": "🐳",
                                              "base_url": "http://192.168.1.9:3000", "token": PEER_TOKEN,
                                              "code": "", "added_by": "code"}]}, fh)
    with open(os.path.join(data_dir, lan.FRIEND_REQUESTS_FILE), "w", encoding="utf-8") as fh:
        json.dump({"version": 1,
                   "incoming": [{"id": "0123456789abcdef", "ts": lan.now_ms(), "status": "pending",
                                 "from": {"id": PEER_ID_2, "nickname": "C 君", "avatar": "🦉",
                                          "base_url": "http://192.168.1.10:3000", "token": PEER_TOKEN_2}}],
                   "outgoing": []}, fh)
    os.makedirs(os.path.join(data_dir, lan.CHAT_DIR), exist_ok=True)
    with open(os.path.join(data_dir, lan.CHAT_DIR, PEER_ID + ".json"), "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "friend_id": PEER_ID,
                   "messages": [{"id": "m-old-0001", "kind": "text", "text": "旧消息", "ts": lan.now_ms(),
                                 "dir": "out", "status": "sent", "read": True}]}, fh)

    anonymous_client = anonymous(app)
    who = me(anonymous_client)
    assert who["id"] == old_id          # 升级后旧数据在 _local，行为与升级前一致
    assert len(friends(anonymous_client)) == 1
    assert os.path.isfile(os.path.join(data_dir, lan.CHAT_DIR, "_local", PEER_ID + ".json"))
    assert not os.path.exists(os.path.join(data_dir, lan.CHAT_DIR, PEER_ID + ".json"))
    raw = json.load(open(os.path.join(data_dir, lan.ACCOUNT_FILE), encoding="utf-8"))
    assert isinstance(raw.get("accounts"), dict) and raw.get("legacy_unclaimed") is True

    # 第二次读不会重复搬
    assert me(anonymous_client)["id"] == old_id
    assert os.path.isfile(os.path.join(data_dir, lan.CHAT_DIR, "_local", PEER_ID + ".json"))

    # 第一个登录账号接手整机旧数据
    ua, user_a = login(app, "lan-user-1")
    claimed = me(ua)
    assert claimed["id"] == old_id and claimed["nickname"] == "老用户"
    raw = json.load(open(os.path.join(data_dir, lan.ACCOUNT_FILE), encoding="utf-8"))
    assert "_local" not in raw["accounts"]
    assert "u%d" % user_a["id"] in raw["accounts"]
    assert raw.get("legacy_unclaimed") is False
    assert [item["id"] for item in friends(ua)] == [PEER_ID]
    assert os.path.isfile(os.path.join(data_dir, lan.CHAT_DIR, "u%d" % user_a["id"], PEER_ID + ".json"))
    assert any(item.get("id") == "m-old-0001" for item in chat(ua, PEER_ID))
    assert len(ua.get("/api/lan/friend-requests").json().get("incoming") or []) == 1

    # 第二个账号是全新身份，看不到旧数据
    ub, user_b = login(app, "lan-user-2")
    assert me(ub)["id"] not in (old_id, "")
    assert friends(ub) == []


def test_purge_account_is_idempotent_and_scoped(app, peer, data_dir):
    """注销只删自己：幂等，账号 2 与无归属桶完好。"""
    ua, user_a = login(app, "lan-user-1")
    ub, user_b = login(app, "lan-user-2")
    anonymous_client = anonymous(app)      # 账号已存在，_local 不会再被当成待接手的旧数据
    key_a, key_b = "u%d" % user_a["id"], "u%d" % user_b["id"]

    me_a, me_b, me_local = me(ua), me(ub), me(anonymous_client)
    tokens = {key: str(account.get("token") or "") for key, account in lan.load_accounts().items()}
    peer.accounts = {tokens[key_a]: me_a["id"], tokens[key_b]: me_b["id"],
                     tokens["_local"]: me_local["id"], PEER_TOKEN: PEER_ID}

    for client, label in ((ua, "u1"), (ub, "u2"), (anonymous_client, "local")):
        assert add_peer(client, PEER_TOKEN).status_code == 200, label
        sent = client.post("/api/lan/friends/%s/send" % PEER_ID,
                           json={"text": "hi " + label, "message_id": "m-purge-" + label})
        assert sent.status_code == 200, sent.text

    request_body = {"from": {"id": PEER_ID_2, "nickname": "C 君", "avatar": "🦉",
                             "base_url": "http://192.168.1.10:3000", "token": PEER_TOKEN_2},
                    "ts": lan.now_ms()}
    assert TestClient(app).post("/api/lan/friend-requests", json=request_body,
                                headers={"X-NOVAI-Friend-Token": tokens[key_a]}).status_code == 200
    assert friends(ua) and os.path.isdir(os.path.join(data_dir, lan.CHAT_DIR, key_a))

    removed = lan.purge_account(user_a["id"])
    assert removed["accounts"] == 1
    assert removed["friends"] == 1
    assert removed["chats"] >= 1
    assert key_a not in lan.load_accounts()
    assert key_b in lan.load_accounts()
    assert "_local" in lan.load_accounts()
    assert not os.path.exists(os.path.join(data_dir, lan.CHAT_DIR, key_a))
    stored = json.load(open(os.path.join(data_dir, lan.FRIENDS_FILE), encoding="utf-8"))
    assert key_a not in (stored.get("friends") or {})
    assert stored["friends"].get(key_b)
    requests = json.load(open(os.path.join(data_dir, lan.FRIEND_REQUESTS_FILE), encoding="utf-8"))
    assert (requests.get("incoming") or {}).get(key_a) in (None, [])

    again = lan.purge_account(str(user_a["id"]))
    assert again["accounts"] == 0 and again["friends"] == 0

    # 账号 2 与无归属桶都还能正常用
    assert len(friends(ub)) == 1
    assert os.path.isdir(os.path.join(data_dir, lan.CHAT_DIR, key_b))
    assert ub.post("/api/lan/friends/%s/send" % PEER_ID,
                   json={"text": "after purge", "message_id": "m-after-0001"}).status_code == 200
    assert me(anonymous_client)["id"] == me_local["id"]
    assert len(friends(anonymous_client)) == 1

    # 注销后同一账号再登录是全新身份
    ua_again = TestClient(app)
    user_again, token_again = auth_service.login("lan-user-1", PASSWORD, "", "")
    ua_again.cookies.set(auth_service.COOKIE_NAME, token_again)
    assert me(ua_again)["id"] not in (me_a["id"], "")


def test_pending_queue_is_per_account(data_dir):
    """待补发队列按账号分开：注销只清自己的条目。"""
    lan.mark_pending(PEER_ID, "u1")
    lan.mark_pending(PEER_ID, "u2")
    assert "u1" in [owner for owner, _ in lan.pending_entries()]
    lan.purge_account(1)
    assert "u1" not in [owner for owner, _ in lan.pending_entries()]
    assert "u2" in [owner for owner, _ in lan.pending_entries()]


if __name__ == "__main__":
    try:
        import pytest as _pytest
    except ImportError:
        print("跳过：没有 pytest（venv/bin/python -m pytest tests/test_lan_account_owner.py）")
        raise SystemExit(0)
    raise SystemExit(_pytest.main([os.path.abspath(__file__), "-q"]))
