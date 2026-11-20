#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T51 局域网账号 / 好友 / 聊天后端单测。

不依赖 main.py：用 server.routes.deps 把 DATA_DIR 与出网请求绑成测试桩，
再用 fastapi TestClient 跑真实路由。
用法：venv/bin/python tests/test_lan_account_store.py（node tests/test_novai_lan_chat.js 会自动调用）
"""
from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import socket
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server.routes.deps import deps  # noqa: E402
from server.routes import lan_account as lan  # noqa: E402

FAILED = 0
PEER_ID = "a1b2c3d4e5f60718"
PEER_TOKEN = "0" * 47 + "1"


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


class Peer:
    """假的好友机：记录收到的消息 / 好友请求，可切换在线 / 口令正确 / 是否支持好友请求接口。"""

    def __init__(self) -> None:
        self.online = True
        self.authorized = True
        self.accepting = True
        self.supports_requests = False   # False = 旧版本：没有 /api/lan/friend-requests，应回退直接加好友
        self.accounts = {}
        self.received = []
        self.request_calls = []
        self.result_calls = []
        self.peer_nickname = "B 君"
        self.share_status = 200
        self.share_calls = []
        # 非空时只认这个前缀：用来模拟「对方已经搬到别的地址」
        self.base_url = ""
        self.share_body = {
            "share": {"token": "share_token_1234567890", "permission": "template",
                      "can_clone": True, "can_save_template": True, "owner_name": "小B"},
            "title": "B 的画布",
            "canvas": {"title": "B 的画布", "nodes": [{"id": "n1", "kind": "text", "x": 0, "y": 0, "w": 100, "h": 40, "text": "hi"}],
                       "connections": []},
        }

    def resolved(self, token):
        if not self.authorized:
            return ""
        return str(self.accounts.get(str(token or "")) or "")

    def __call__(self, url, method="GET", payload=None, headers=None, timeout=1.5):
        if not self.online:
            raise OSError("connection refused")
        if self.base_url and not str(url).startswith(self.base_url):
            raise OSError(61, "Connection refused")     # 旧地址没人监听
        token = str((headers or {}).get("X-NOVAI-Friend-Token") or "")
        account_id = self.resolved(token)
        if str(url).endswith("/api/lan/ping"):
            body = {"ok": True, "account_id": account_id, "authorized": bool(account_id),
                    "can_receive": bool(account_id), "version": "novai-v16"}
            if account_id:
                body["nickname"] = self.peer_nickname if account_id == PEER_ID else "A 君"
                body["avatar"] = "🐳" if account_id == PEER_ID else "🐼"
            return 200, body
        if "/api/canvas-share/" in str(url):
            self.share_calls.append(str(url))
            self.share_headers = dict(headers or {})
            return self.share_status, self.share_body if self.share_status == 200 else {"detail": "x"}
        if str(url).endswith("/api/lan/messages"):
            if not self.accepting or not account_id:
                return 403, {"detail": "好友凭据无效"}
            self.received.append({"payload": payload, "headers": dict(headers or {})})
            return 200, {"ok": True, "duplicate": False}
        if str(url).endswith("/api/lan/friend-requests/result"):
            self.result_calls.append({"payload": payload, "headers": dict(headers or {})})
            if not account_id:
                return 403, {"detail": "好友凭据无效"}
            return 200, {"ok": True}
        if str(url).endswith("/api/lan/friend-requests"):
            if not self.supports_requests:
                return 404, {}
            if not account_id:
                return 403, {"detail": "好友凭据无效"}
            self.request_calls.append({"payload": payload, "headers": dict(headers or {})})
            return 200, {"ok": True, "request_id": "0123456789abcdef"}
        return 404, {}


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-lan-test-")
    os.environ["NOVAI_LAN_DISCOVERY"] = "0"     # 单测不占真实 UDP 端口
    lan.AUTO_RETRY = False                      # 后台补发由用例手动调 retry_pending_once()
    peer = Peer()
    deps.bind(DATA_DIR=data_dir, LAN_HTTP_JSON=peer, APP_VERSION="novai-v16-test")

    app = FastAPI()
    app.include_router(lan.router)
    client = TestClient(app)

    # 1. 我的资料 + 好友码
    me = client.get("/api/lan/me")
    check("GET /me 200", me.status_code == 200, str(me.status_code))
    account = me.json().get("me") or {}
    code_match = re.search(r"^NOVAI-(\d{6})$", str(account.get("friend_code") or ""))
    check("好友码格式 NOVAI-<6位数字码>", bool(code_match), str(account.get("friend_code")))
    check("好友码数字在 100000..999999",
          bool(code_match) and 100000 <= int(code_match.group(1)) <= 999999, str(account.get("friend_code")))
    check("me.code 与好友码一致", account.get("code") == (code_match.group(1) if code_match else ""), str(account.get("code")))
    check("默认昵称", account.get("nickname") == "本机用户", str(account.get("nickname")))
    check("账号文件落盘", os.path.isfile(os.path.join(data_dir, lan.ACCOUNT_FILE)))
    own_token = str((lan.load_account()).get("token") or "")
    own_id = str(lan.load_account().get("id") or "")
    peer.accounts = {own_token: own_id, PEER_TOKEN: PEER_ID}
    check("账号口令长度 >= 32", len(own_token) >= 32, str(len(own_token)))

    updated = client.put("/api/lan/me", json={"nickname": "A 君", "avatar": "🐼"})
    check("PUT /me 200", updated.status_code == 200, str(updated.status_code))
    check("昵称已保存", (updated.json().get("me") or {}).get("nickname") == "A 君")
    check("空昵称 400", client.put("/api/lan/me", json={"nickname": "  "}).status_code == 400)
    check("超大 emoji 400", client.put("/api/lan/me", json={"nickname": "x", "avatar": "😀" * 30}).status_code == 400)

    # 2. ping：陌生人只看到在不在，口令正确才回昵称
    plain = client.get("/api/lan/ping")
    check("ping 200", plain.status_code == 200, str(plain.status_code))
    check("ping 无口令不返回昵称", "nickname" not in (plain.json() or {}))
    check("ping 无口令 authorized=false", (plain.json() or {}).get("authorized") is False)
    authed = client.get("/api/lan/ping", headers={"X-NOVAI-Friend-Token": own_token})
    check("ping 带口令 authorized=true", (authed.json() or {}).get("authorized") is True)
    check("ping 带口令返回昵称", (authed.json() or {}).get("nickname") == "A 君", str((authed.json() or {}).get("nickname")))
    check("ping 错口令 authorized=false", (client.get("/api/lan/ping", headers={"X-NOVAI-Friend-Token": "x" * 48}).json() or {}).get("authorized") is False)

    # 3. 加好友：格式 / 口令 / 离线
    check("好友码格式错 400", client.post("/api/lan/friends", json={"code": "hello"}).status_code == 400)
    check("好友码口令太短 400", client.post("/api/lan/friends", json={"code": "NOVAI-192.168.1.9:3000-abc"}).status_code == 400)
    peer.authorized = False
    wrong = client.post("/api/lan/friends", json={"code": "NOVAI-192.168.1.9:3000-" + PEER_TOKEN})
    check("对方口令不对 400", wrong.status_code == 400, str(wrong.status_code))
    check("口令不对不泄露对方昵称", "B 君" not in wrong.text)
    peer.authorized = True
    peer.online = False
    down = client.post("/api/lan/friends", json={"code": "NOVAI-192.168.1.9:3000-" + PEER_TOKEN})
    check("对方离线 502", down.status_code == 502, str(down.status_code))
    peer.online = True
    added = client.post("/api/lan/friends", json={"code": "NOVAI-192.168.1.9:3000-" + PEER_TOKEN})
    check("加好友 200", added.status_code == 200, str(added.status_code))
    friend = added.json().get("friend") or {}
    check("好友 ID 来自对方 ping", friend.get("id") == PEER_ID, str(friend.get("id")))
    check("好友昵称来自对方 ping", friend.get("nickname") == "B 君", str(friend.get("nickname")))
    check("好友在线", friend.get("online") is True)
    check("好友文件落盘", os.path.isfile(os.path.join(data_dir, lan.FRIENDS_FILE)))
    self_code = "NOVAI-192.168.1.9:3000-" + own_token
    check("不能加自己 400", client.post("/api/lan/friends", json={"code": self_code}).status_code == 400)

    # 4. 在线状态缓存：3s 内复用结果，超过 3s 重新探测（离线 1 次就变 false）
    listed = client.get("/api/lan/friends").json().get("friends") or []
    check("好友列表 1 个", len(listed) == 1, str(len(listed)))
    check("好友列表在线", listed[0].get("online") is True)
    cached = lan.online_of(lan.find_friend(PEER_ID), now=lan.now_ms())
    peer.online = False
    still = lan.online_of(lan.find_friend(PEER_ID), now=int(cached["checked_at"]) + 1000)
    check("3s 内沿用缓存（仍显示在线）", still.get("online") is True)
    fresh = lan.online_of(lan.find_friend(PEER_ID), now=int(cached["checked_at"]) + lan.ONLINE_CACHE_MS + 1)
    check("超过 3s 重新探测后离线", fresh.get("online") is False)
    peer.online = True
    lan._clear_online_cache(PEER_ID)

    # 4.5 对方在线时把新昵称写回文件；离线后仍显示最后认识的名字
    peer.peer_nickname = "B 改名了"
    lan._clear_online_cache(PEER_ID)
    client.get("/api/lan/friends")
    stored = lan.find_friend(PEER_ID) or {}
    check("在线时昵称写回好友文件", stored.get("nickname") == "B 改名了", str(stored.get("nickname")))
    peer.online = False
    lan._clear_online_cache(PEER_ID)
    listed = client.get("/api/lan/friends").json().get("friends") or []
    check("离线后仍显示最后认识的昵称", bool(listed) and listed[0].get("nickname") == "B 改名了", str(listed[:1]))
    peer.online = True
    peer.peer_nickname = "B 君"
    lan._clear_online_cache(PEER_ID)

    # 4.6 对方换端口 / 换 IP：发现表里的新地址要接管旧地址
    peer.base_url = "http://192.168.1.9:3000"
    stored = lan.find_friend(PEER_ID) or {}
    stored["base_url"] = "http://192.168.1.9:3999"      # 旧地址，已经没人监听
    lan._upsert_friend(stored)
    with lan._PEERS_LOCK:
        lan._PEERS["770001"] = {"code": "770001", "id": PEER_ID, "ip": "192.168.1.9", "port": 3000,
                                "nickname": "B 君", "avatar": "🐳", "token": PEER_TOKEN, "seen_at": lan.now_ms()}
    lan._clear_online_cache(PEER_ID)
    state = lan.online_of(lan.find_friend(PEER_ID))
    check("旧地址不通时按发现表自愈为在线", state.get("online") is True, str(state))
    check("好友地址已刷新成广播里的地址",
          str((lan.find_friend(PEER_ID) or {}).get("base_url")) == "http://192.168.1.9:3000",
          str((lan.find_friend(PEER_ID) or {}).get("base_url")))

    # 4.7 过期的广播不能拿来改地址（30s 之外的一律不认）
    stored = lan.find_friend(PEER_ID) or {}
    stored["base_url"] = "http://192.168.1.9:3999"
    lan._upsert_friend(stored)
    with lan._PEERS_LOCK:
        lan._PEERS["770001"]["seen_at"] = lan.now_ms() - lan.DISCOVERY_TTL_MS - 1000
    lan._clear_online_cache(PEER_ID)
    state = lan.online_of(lan.find_friend(PEER_ID))
    check("过期广播不拿来改地址", state.get("online") is False, str(state))

    # 4.8 地址变了也要能把消息发出去（不是只显示在线）
    with lan._PEERS_LOCK:
        lan._PEERS["770001"] = {"code": "770001", "id": PEER_ID, "ip": "192.168.1.9", "port": 3000,
                                "nickname": "B 君", "avatar": "🐳", "token": PEER_TOKEN, "seen_at": lan.now_ms()}
    stored = lan.find_friend(PEER_ID) or {}
    stored["base_url"] = "http://192.168.1.9:3999"
    lan._upsert_friend(stored)
    lan._clear_online_cache(PEER_ID)
    moved_msg = lan.make_message("m-moved-0001", "text", "搬家后也收得到", "", "",
                                 lan.now_ms(), "out", "pending")
    moved_ok, moved_kind, moved_status = lan._deliver_with_recovery(lan.find_friend(PEER_ID), moved_msg)
    check("旧地址发不出去时改地址重试成功", moved_ok is True, "%s %s" % (moved_kind, moved_status))
    check("重试仍用同一个消息 ID",
          bool(peer.received) and peer.received[-1]["payload"]["message"]["id"] == "m-moved-0001")
    with lan._PEERS_LOCK:
        lan._PEERS.pop("770001", None)
    stored = lan.find_friend(PEER_ID) or {}
    stored["base_url"] = "http://192.168.1.9:3000"
    lan._upsert_friend(stored)
    peer.base_url = ""
    peer.received = []                                  # 后面的用例只看第 5 步发的消息
    lan._clear_online_cache(PEER_ID)

    # 4.9 对方卡一下（超时）不直接判离线：超时重试一次；拒连不重试
    flaky_calls = {"n": 0}

    def flaky(url, method="GET", payload=None, headers=None, timeout=1.5):
        if str(url).endswith("/api/lan/ping"):
            flaky_calls["n"] += 1
            if flaky_calls["n"] == 1:
                raise socket.timeout("timed out")
        return peer(url, method, payload, headers, timeout)

    deps.bind(LAN_HTTP_JSON=flaky)
    lan._clear_online_cache(PEER_ID)
    # 发现表里没有它：超时直接判离线，别把 5s 轮询拖成 3s
    state = lan.online_of(lan.find_friend(PEER_ID))
    check("没有广播记录时超时不重试", state.get("online") is False and flaky_calls["n"] == 1, str(flaky_calls))
    # 发现表里有 30s 内的广播：说明它确实在跑，超时再等一次
    with lan._PEERS_LOCK:
        lan._PEERS["770005"] = {"code": "770005", "id": PEER_ID, "ip": "192.168.1.9", "port": 3000,
                                "nickname": "B 君", "avatar": "🐳", "token": PEER_TOKEN, "seen_at": lan.now_ms()}
    flaky_calls["n"] = 0
    lan._clear_online_cache(PEER_ID)
    state = lan.online_of(lan.find_friend(PEER_ID))
    check("有广播记录时超时重试后在线", state.get("online") is True, str(state))
    check("超时确实重试了一次", flaky_calls["n"] == 2, str(flaky_calls))
    with lan._PEERS_LOCK:
        lan._PEERS.pop("770005", None)
    deps.bind(LAN_HTTP_JSON=peer)
    peer.online = False
    lan._clear_online_cache(PEER_ID)
    check("拒连直接判离线", lan.online_of(lan.find_friend(PEER_ID)).get("online") is False)
    peer.online = True
    lan._clear_online_cache(PEER_ID)

    # 4.10 发现包：别人主动问地址要单播回一包；普通广播不回
    class FakeSock:
        def __init__(self) -> None:
            self.sent = []

        def sendto(self, data, addr):
            self.sent.append((data, addr))

    own_id = str(lan.load_account().get("id") or "")
    ask = {"novai_lan": 1, "code": "770003", "id": "abcdef0123456789", "port": 3999, "solicit": True}
    fake = FakeSock()
    lan._handle_discovery_packet(fake, json.dumps(ask).encode("utf-8"), ("192.168.1.77", 5555), own_id)
    check("主动问地址时单播回应", len(fake.sent) == 1 and fake.sent[0][1] == ("192.168.1.77", 5555), str(fake.sent))
    reply = json.loads(fake.sent[0][0].decode("utf-8")) if fake.sent else {}
    check("回应不带 solicit（两边不会互相回答）", reply.get("novai_lan") == 1 and not reply.get("solicit"), str(reply))
    check("问地址的机器被记进发现表", lan.find_peer("770003") is not None)
    plain = FakeSock()
    lan._handle_discovery_packet(plain, json.dumps({"novai_lan": 1, "code": "770004",
                                                    "id": "1234567890abcdef", "port": 3999}).encode("utf-8"),
                                 ("192.168.1.78", 5555), own_id)
    check("普通广播不回包", plain.sent == [], str(plain.sent))
    with lan._PEERS_LOCK:
        lan._PEERS.pop("770003", None)
        lan._PEERS.pop("770004", None)

    # 5. 发消息：成功 / 离线 / 重发
    sent = client.post("/api/lan/friends/%s/send" % PEER_ID, json={"text": "你好", "message_id": "m-000001"})
    check("发消息 200", sent.status_code == 200, str(sent.status_code))
    check("对方收到 1 条", len(peer.received) == 1, str(len(peer.received)))
    body = peer.received[0]["payload"]
    check("转发带 from.token", body["from"]["token"] == own_token)
    check("转发带 from.base_url", str(body["from"]["base_url"]).startswith("http://"))
    check("转发带消息正文", body["message"]["text"] == "你好")
    check("转发带消息 ID", body["message"]["id"] == "m-000001")
    check("发消息写入会话", len(client.get("/api/lan/messages", params={"with": PEER_ID}).json().get("messages") or []) == 2)

    peer.online = False
    offline = client.post("/api/lan/friends/%s/send" % PEER_ID, json={"text": "在吗", "message_id": "m-000002"})
    # 发送失败不再判死：落 status=pending，后台自动补发（重发保持原 message_id）
    check("离线发送 502", offline.status_code == 502, str(offline.status_code))
    check("离线错误文案明确", "离线" in offline.text and "自动补发" in offline.text, offline.text)
    chat = client.get("/api/lan/messages", params={"with": PEER_ID}).json().get("messages") or []
    pending = [item for item in chat if item.get("id") == "m-000002"]
    check("离线消息落为待补发", len(pending) == 1 and pending[0].get("status") == "pending", str(pending))
    check("待补发已排进队列", PEER_ID in lan.pending_friend_ids(), str(lan.pending_friend_ids()))

    peer.online = True
    lan._clear_online_cache(PEER_ID)
    before = len(peer.received)
    stats = lan.retry_pending_once()
    check("对方恢复后自动补发成功", stats.get("delivered") == 1, str(stats))
    check("补发真的投出去了", len(peer.received) == before + 1, str(len(peer.received)))
    check("补发的消息 ID 不变", peer.received[-1]["payload"]["message"]["id"] == "m-000002")
    chat = client.get("/api/lan/messages", params={"with": PEER_ID}).json().get("messages") or []
    healed = [item for item in chat if item.get("id") == "m-000002"]
    check("补发后状态变 sent 且不重复", len(healed) == 1 and healed[0].get("status") == "sent", str(healed))
    check("补发完移出队列", PEER_ID not in lan.pending_friend_ids(), str(lan.pending_friend_ids()))

    # 对方还没恢复时补发不出任何东西，消息继续保持 pending，恢复后自动送出
    peer.online = False
    lan._clear_online_cache(PEER_ID)
    second = client.post("/api/lan/friends/%s/send" % PEER_ID,
                         json={"text": "离线再来一条", "message_id": "m-000004"})
    check("离线第二条也是 502", second.status_code == 502, str(second.status_code))
    check("离线第二条进队列", PEER_ID in lan.pending_friend_ids(), str(lan.pending_friend_ids()))
    check("对方离线时补发不投递", lan.retry_pending_once().get("delivered") == 0)
    check("离线期间仍在队列里", PEER_ID in lan.pending_friend_ids(), str(lan.pending_friend_ids()))
    peer.online = True
    lan._clear_online_cache(PEER_ID)
    check("对方恢复后第二条也补发出去", lan.retry_pending_once().get("delivered") == 1)
    chat = client.get("/api/lan/messages", params={"with": PEER_ID}).json().get("messages") or []
    second_row = [item for item in chat if item.get("id") == "m-000004"]
    check("补发的第二条状态变 sent", len(second_row) == 1 and second_row[0].get("status") == "sent", str(second_row))
    lan._clear_online_cache(PEER_ID)
    again = client.post("/api/lan/friends/%s/send" % PEER_ID, json={"text": "在吗", "message_id": "m-000002"})
    check("手动重发 200", again.status_code == 200, str(again.status_code))
    chat = client.get("/api/lan/messages", params={"with": PEER_ID}).json().get("messages") or []
    retried = [item for item in chat if item.get("id") == "m-000002"]
    check("重发不重复，状态变 sent", len(retried) == 1 and retried[0].get("status") == "sent", str(retried))
    check("空文本 400", client.post("/api/lan/friends/%s/send" % PEER_ID, json={"text": " "}).status_code == 400)
    check("画布卡片缺链接 400", client.post("/api/lan/friends/%s/send" % PEER_ID, json={"kind": "canvas"}).status_code == 400)
    canvas_card = client.post("/api/lan/friends/%s/send" % PEER_ID,
                              json={"kind": "canvas", "share_url": "http://192.168.1.9:3000/static/canvas.html?share=tok",
                                    "canvas_title": "主图工作流", "message_id": "m-000003"})
    check("画布卡片 200", canvas_card.status_code == 200, str(canvas_card.status_code))
    check("画布卡片带标题", (canvas_card.json().get("message") or {}).get("canvas_title") == "主图工作流")

    # 6. 收消息：口令 / 幂等 / 自动加好友 / 未读
    inbox_payload = {
        "from": {"id": "b" * 8 + "00000000", "nickname": "C 君", "avatar": "🦊",
                 "base_url": "http://192.168.1.10:3000", "token": "t" * 40},
        "message": {"id": "in-000001", "kind": "text", "text": "收到啦", "ts": lan.now_ms()},
    }
    check("收消息错口令 403", client.post("/api/lan/messages", json=inbox_payload,
                                        headers={"X-NOVAI-Friend-Token": "bad"}).status_code == 403)
    check("收消息缺口令 403", client.post("/api/lan/messages", json=inbox_payload).status_code == 403)
    accepted = client.post("/api/lan/messages", json=inbox_payload,
                           headers={"X-NOVAI-Friend-Token": own_token})
    check("收消息 200", accepted.status_code == 200, str(accepted.status_code))
    check("首次不是重复", (accepted.json() or {}).get("duplicate") is False)
    duplicate = client.post("/api/lan/messages", json=inbox_payload,
                            headers={"X-NOVAI-Friend-Token": own_token})
    check("同 msgId 幂等 duplicate=true", (duplicate.json() or {}).get("duplicate") is True)
    peer_friend = lan.find_friend("b" * 8 + "00000000")
    check("收到陌生人消息自动加好友", bool(peer_friend))
    check("自动加好友标记 added_by=message", str((peer_friend or {}).get("added_by")) == "message")
    inbox = client.get("/api/lan/messages", params={"with": "b" * 8 + "00000000"}).json().get("messages") or []
    check("收消息只存一条", len(inbox) == 1, str(len(inbox)))
    listed = client.get("/api/lan/friends").json().get("friends") or []
    new_friend = [item for item in listed if item.get("id") == "b" * 8 + "00000000"]
    check("好友列表未读 1", len(new_friend) == 1 and new_friend[0].get("unread") == 1, str(new_friend))
    read = client.post("/api/lan/messages/read", json={"friend_id": "b" * 8 + "00000000"})
    check("标记已读 200", read.status_code == 200 and (read.json() or {}).get("unread") == 0, str(read.text))
    listed = client.get("/api/lan/friends").json().get("friends") or []
    new_friend = [item for item in listed if item.get("id") == "b" * 8 + "00000000"]
    check("已读后未读 0", new_friend[0].get("unread") == 0, str(new_friend))

    # 7. after 过滤 + 合并排序
    all_messages = client.get("/api/lan/messages", params={"with": PEER_ID}).json().get("messages") or []
    stamps = [int(item.get("ts") or 0) for item in all_messages]
    check("消息按时间升序", stamps == sorted(stamps))
    last_ts = stamps[-1]
    tail = client.get("/api/lan/messages", params={"with": PEER_ID, "after": last_ts}).json().get("messages") or []
    check("after 过滤只取更新的", all(int(item.get("ts") or 0) > last_ts for item in tail), str(len(tail)))
    check("缺 with 参数 400", client.get("/api/lan/messages").status_code == 400)
    check("with 传目录穿越 400", client.get("/api/lan/messages", params={"with": "../../etc/passwd"}).status_code == 400)
    check("with 不是好友也返回空会话", client.get("/api/lan/messages", params={"with": "deadbeef"}).status_code == 200)

    # 8. 删好友（连会话文件一起清）
    chat_file = lan.chat_path(PEER_ID)
    check("会话文件存在", os.path.isfile(chat_file))
    removed = client.delete("/api/lan/friends/" + PEER_ID)
    check("删好友 200", removed.status_code == 200 and (removed.json() or {}).get("ok") is True)
    check("删好友后会话文件清掉", not os.path.isfile(chat_file))
    left = client.get("/api/lan/friends").json().get("friends") or []
    check("删好友后列表不再有它", all(item.get("id") != PEER_ID for item in left), str([item.get("id") for item in left]))
    check("删除不存在的好友也是 200", client.delete("/api/lan/friends/deadbeef").status_code == 200)
    check("非法好友 ID 400", client.delete("/api/lan/friends/not-hex-id").status_code == 400)
    check("好友 ID 目录穿越被挡", client.delete("/api/lan/friends/..%2Fevil").status_code in (400, 404))
    check("给不存在的好友发消息 404",
          client.post("/api/lan/friends/deadbeef/send", json={"text": "x"}).status_code == 404)

    # 9. 画布卡片快照代取（跨域 + 对方口令在服务端解决）
    good_url = "http://192.168.1.9:3000/static/canvas.html?share=share_token_1234567890&token=peerlan"
    proxied = client.get("/api/lan/share-preview", params={"url": good_url})
    check("代取画布快照 200", proxied.status_code == 200, str(proxied.status_code))
    body = proxied.json() or {}
    check("代取返回 origin", body.get("origin") == "http://192.168.1.9:3000", str(body.get("origin")))
    check("代取返回画布标题", (body.get("snapshot") or {}).get("title") == "B 的画布")
    check("代取只请求令牌接口", peer.share_calls and peer.share_calls[-1].endswith("/api/canvas-share/share_token_1234567890"), str(peer.share_calls[-1:]))
    check("代取带上对方的局域网口令", peer.share_headers.get("X-NOVAI-Token") == "peerlan", str(peer.share_headers))
    by_path = client.get("/api/lan/share-preview", params={"url": "http://192.168.1.9:3000/api/canvas-share/share_token_1234567890"})
    check("也认 /api/canvas-share/<token> 形式", by_path.status_code == 200, str(by_path.status_code))
    check("缺链接 400", client.get("/api/lan/share-preview").status_code == 400)
    check("非 http 链接 400", client.get("/api/lan/share-preview", params={"url": "file:///etc/passwd"}).status_code == 400)
    check("非 IP 主机 400", client.get("/api/lan/share-preview", params={"url": "http://evil.test/x?share=share_token_1234567890"}).status_code == 400)
    check("没有令牌 400", client.get("/api/lan/share-preview", params={"url": "http://192.168.1.9:3000/static/canvas.html"}).status_code == 400)
    peer.share_status = 404
    check("对方分享失效 404", client.get("/api/lan/share-preview", params={"url": good_url}).status_code == 404)
    peer.share_status = 410
    check("对方分享过期 410", client.get("/api/lan/share-preview", params={"url": good_url}).status_code == 410)
    peer.share_status = 401
    check("对方口令不一致 401", client.get("/api/lan/share-preview", params={"url": good_url}).status_code == 401)
    peer.share_status = 200
    peer.online = False
    check("对方离线 502", client.get("/api/lan/share-preview", params={"url": good_url}).status_code == 502)
    peer.online = True

    # 10. 中间件放行清单（main.py 的 lan_access_guard 调这个）
    check("放行 GET /api/lan/ping", lan.lan_api_public_without_token("/api/lan/ping", "GET") is True)
    check("放行 POST /api/lan/messages", lan.lan_api_public_without_token("/api/lan/messages", "POST") is True)
    check("放行带尾斜杠", lan.lan_api_public_without_token("/api/lan/ping/", "GET") is True)
    check("不放行 GET /api/lan/friends", lan.lan_api_public_without_token("/api/lan/friends", "GET") is False)
    check("不放行 POST /api/lan/ping", lan.lan_api_public_without_token("/api/lan/ping", "POST") is False)
    check("不放行 GET /api/lan/messages", lan.lan_api_public_without_token("/api/lan/messages", "GET") is False)
    check("不放行其它接口", lan.lan_api_public_without_token("/api/canvases", "GET") is False)
    check("放行 POST /api/lan/friend-requests", lan.lan_api_public_without_token("/api/lan/friend-requests", "POST") is True)
    check("放行 POST /api/lan/friend-requests/result",
          lan.lan_api_public_without_token("/api/lan/friend-requests/result", "POST") is True)
    check("放行 GET /api/lan/media/<id>",
          lan.lan_api_public_without_token("/api/lan/media/0123456789abcdef01234567", "GET") is True)
    check("不放行 POST /api/lan/media（上传只给本机页面）",
          lan.lan_api_public_without_token("/api/lan/media", "POST") is False)
    check("不放行 GET /api/lan/media（没 id）", lan.lan_api_public_without_token("/api/lan/media", "GET") is False)
    check("不放行 GET /api/lan/media/（只有斜杠）", lan.lan_api_public_without_token("/api/lan/media/", "GET") is False)
    check("不放行 POST /api/lan/friend-requests/<id>/accept",
          lan.lan_api_public_without_token("/api/lan/friend-requests/0123456789abcdef/accept", "POST") is False)
    check("不放行 GET /api/lan/friend-requests",
          lan.lan_api_public_without_token("/api/lan/friend-requests", "GET") is False)
    check("不放行 GET /api/lan/friend-requests/result",
          lan.lan_api_public_without_token("/api/lan/friend-requests/result", "GET") is False)

    # 11. 纯函数
    parsed = lan.parse_friend_code("NOVAI-192.168.1.8:3000-" + PEER_TOKEN)
    check("解析好友码 base_url", bool(parsed) and parsed["base_url"] == "http://192.168.1.8:3000", str(parsed))
    check("解析空串 None", lan.parse_friend_code("") is None)
    check("解析端口越界 None", lan.parse_friend_code("NOVAI-192.168.1.8:99999-" + PEER_TOKEN) is None)
    check("解析带空格容忍", lan.parse_friend_code(" NOVAI-192.168.1.8:3000-" + PEER_TOKEN + " ") is not None)
    merged = lan.merge_messages([
        {"id": "b", "ts": 200}, {"id": "a", "ts": 100}, {"id": "c", "ts": 200},
    ])
    check("merge 排序稳定", [item["id"] for item in merged] == ["a", "b", "c"], str(merged))
    check("unread 只算收到的未读", lan.unread_of([
        {"dir": "in", "read": False}, {"dir": "in", "read": True}, {"dir": "out", "read": False},
    ]) == 1)

    # 12. 好友请求：A 投递 → B 同意 / 拒绝 → 结果回调
    peer.supports_requests = True
    peer.request_calls = []
    requested = client.post("/api/lan/friends", json={"code": "NOVAI-192.168.1.9:3000-" + PEER_TOKEN})
    check("投递好友请求 200", requested.status_code == 200, str(requested.status_code))
    requested_body = requested.json() or {}
    check("投递后 pending=true", requested_body.get("pending") is True, str(requested_body.get("pending")))
    check("投递成功不回 friend", "friend" not in requested_body, str(list(requested_body.keys())))
    request_row = requested_body.get("request") or {}
    check("投递返回 request.id（16 位十六进制）",
          bool(re.match(r"^[0-9a-f]{16}$", str(request_row.get("id") or ""))), str(request_row.get("id")))
    check("投递 request.to 是对方", (request_row.get("to") or {}).get("id") == PEER_ID, str(request_row.get("to")))
    check("投递 request.status=pending", request_row.get("status") == "pending", str(request_row.get("status")))
    check("对方收到 1 次好友请求", len(peer.request_calls) == 1, str(len(peer.request_calls)))
    sent_from = (peer.request_calls[0]["payload"] or {}).get("from") or {}
    check("请求 from.id 是本机", sent_from.get("id") == own_id, str(sent_from.get("id")))
    check("请求 from.token 是本机口令", sent_from.get("token") == own_token)
    check("请求 from.base_url 是 http", str(sent_from.get("base_url")).startswith("http://"), str(sent_from.get("base_url")))
    check("请求 from.code 是 6 位好友码",
          bool(re.match(r"^\d{6}$", str(sent_from.get("code") or ""))), str(sent_from.get("code")))
    check("请求头带对方口令", peer.request_calls[0]["headers"].get("X-NOVAI-Friend-Token") == PEER_TOKEN)
    listed_requests = client.get("/api/lan/friend-requests").json() or {}
    check("outgoing 里这条是 pending",
          len(listed_requests.get("outgoing") or []) == 1
          and (listed_requests.get("outgoing") or [{}])[0].get("status") == "pending",
          str(listed_requests.get("outgoing")))
    check("outgoing 不暴露口令", "token" not in ((listed_requests.get("outgoing") or [{}])[0].get("to") or {}),
          str(listed_requests.get("outgoing")))
    check("incoming 为空", listed_requests.get("incoming") == [], str(listed_requests.get("incoming")))
    check("对方同意前还不是好友", lan.find_friend(PEER_ID) is None)
    client.post("/api/lan/friends", json={"code": "NOVAI-192.168.1.9:3000-" + PEER_TOKEN})
    listed_requests = client.get("/api/lan/friend-requests").json() or {}
    check("重复投递旧 pending 被替换，只留 1 条", len(listed_requests.get("outgoing") or []) == 1,
          str(listed_requests.get("outgoing")))
    check("重复投递对方收到第 2 次", len(peer.request_calls) == 2, str(len(peer.request_calls)))

    request_id = str(((client.get("/api/lan/friend-requests").json() or {}).get("outgoing") or [{}])[0].get("id"))
    result_payload = {"request_id": request_id, "accepted": True, "from": {
        "id": PEER_ID, "nickname": "B 君", "avatar": "🐳",
        "base_url": "http://192.168.1.9:3000", "token": PEER_TOKEN, "code": "123456"}}
    check("结果回调错口令 403",
          client.post("/api/lan/friend-requests/result", json=result_payload,
                      headers={"X-NOVAI-Friend-Token": "bad"}).status_code == 403)
    result_ok = client.post("/api/lan/friend-requests/result", json=result_payload,
                            headers={"X-NOVAI-Friend-Token": own_token})
    check("结果回调 200", result_ok.status_code == 200, str(result_ok.status_code))
    accepted_friend = lan.find_friend(PEER_ID) or {}
    check("对方同意后成为好友", bool(accepted_friend), str(accepted_friend))
    check("同意加好友标记 added_by=request", str(accepted_friend.get("added_by")) == "request",
          str(accepted_friend.get("added_by")))
    check("同意后好友记录带对方口令", str(accepted_friend.get("token")) == PEER_TOKEN)
    check("同意后好友地址来自回调", str(accepted_friend.get("base_url")) == "http://192.168.1.9:3000",
          str(accepted_friend.get("base_url")))
    listed_requests = client.get("/api/lan/friend-requests").json() or {}
    check("outgoing 状态变 accepted",
          (listed_requests.get("outgoing") or [{}])[0].get("status") == "accepted",
          str(listed_requests.get("outgoing")))
    notes = client.get("/api/lan/messages", params={"with": PEER_ID}).json().get("messages") or []
    check("本地留了「对方已同意」系统提示",
          any(item.get("dir") == "sys" and "对方已同意" in str(item.get("text")) for item in notes), str(notes))
    check("结果回调幂等 200",
          client.post("/api/lan/friend-requests/result", json=result_payload,
                      headers={"X-NOVAI-Friend-Token": own_token}).status_code == 200)
    check("未知 request_id 也 200（幂等）",
          client.post("/api/lan/friend-requests/result", json={"request_id": "ffffffffffffffff", "accepted": True},
                      headers={"X-NOVAI-Friend-Token": own_token}).status_code == 200)
    already = client.post("/api/lan/friends", json={"code": "NOVAI-192.168.1.9:3000-" + PEER_TOKEN})
    check("已是好友直接返回 friend",
          already.status_code == 200 and (already.json() or {}).get("pending") is False
          and bool((already.json() or {}).get("friend")), already.text)
    check("已是好友不再投递请求", len(peer.request_calls) == 2, str(len(peer.request_calls)))

    # 拒绝：先把 PEER_ID 删掉，重新发一次请求，再回 accepted=false
    client.delete("/api/lan/friends/" + PEER_ID)
    check("拒绝场景准备：好友已删除", lan.find_friend(PEER_ID) is None)
    peer.request_calls = []
    client.post("/api/lan/friends", json={"code": "NOVAI-192.168.1.9:3000-" + PEER_TOKEN})
    reject_id = str(((client.get("/api/lan/friend-requests").json() or {}).get("outgoing") or [{}])[0].get("id"))
    rejected_result = client.post("/api/lan/friend-requests/result",
                                  json={"request_id": reject_id, "accepted": False,
                                        "from": {"id": PEER_ID, "nickname": "B 君", "avatar": "🐳",
                                                 "base_url": "http://192.168.1.9:3000", "token": PEER_TOKEN}},
                                  headers={"X-NOVAI-Friend-Token": own_token})
    check("拒绝结果回调 200", rejected_result.status_code == 200, str(rejected_result.status_code))
    check("对方拒绝后不是好友", lan.find_friend(PEER_ID) is None)
    check("拒绝后 outgoing 状态 rejected",
          ((client.get("/api/lan/friend-requests").json() or {}).get("outgoing") or [{}])[0].get("status") == "rejected",
          str(client.get("/api/lan/friend-requests").json()))

    # 13. 本机收到好友请求：投递校验 / 同意 / 拒绝 / 回调失败 / 清理
    sender_from = {"id": "c1c2c3c4d5d6e7f8", "nickname": "C 君", "avatar": "🦊",
                   "base_url": "http://192.168.1.77:3941", "token": "s" * 40, "code": "654321"}
    delivered = client.post("/api/lan/friend-requests", json={"from": sender_from, "ts": lan.now_ms()},
                            headers={"X-NOVAI-Friend-Token": own_token})
    check("收到好友请求 200", delivered.status_code == 200, str(delivered.status_code))
    incoming_id = str((delivered.json() or {}).get("request_id") or "")
    check("收到 request_id 是 16 位十六进制", bool(re.match(r"^[0-9a-f]{16}$", incoming_id)), incoming_id)
    wrong_delivery = client.post("/api/lan/friend-requests", json={"from": sender_from},
                                 headers={"X-NOVAI-Friend-Token": "bad"})
    check("投递接口错口令 403", wrong_delivery.status_code == 403 and "好友凭据无效" in wrong_delivery.text,
          wrong_delivery.text)
    check("投递缺口令 403",
          client.post("/api/lan/friend-requests", json={"from": sender_from}).status_code == 403)
    check("投递 from.id 不合法 400",
          client.post("/api/lan/friend-requests", json={"from": dict(sender_from, id="not-hex")},
                      headers={"X-NOVAI-Friend-Token": own_token}).status_code == 400)
    check("投递 from.token 太短 400",
          client.post("/api/lan/friend-requests", json={"from": dict(sender_from, token="short")},
                      headers={"X-NOVAI-Friend-Token": own_token}).status_code == 400)
    check("投递 base_url 非 http 400",
          client.post("/api/lan/friend-requests", json={"from": dict(sender_from, base_url="file:///etc/passwd")},
                      headers={"X-NOVAI-Friend-Token": own_token}).status_code == 400)
    incoming_list = client.get("/api/lan/friend-requests").json().get("incoming") or []
    check("incoming 显示 1 条 pending", len(incoming_list) == 1 and incoming_list[0].get("id") == incoming_id,
          str(incoming_list))
    check("incoming 保留对方口令", (incoming_list[0].get("from") or {}).get("token") == "s" * 40,
          str(incoming_list[0].get("from")))
    check("incoming 是 C 君", (incoming_list[0].get("from") or {}).get("nickname") == "C 君")
    peer.result_calls = []
    accepted_request = client.post("/api/lan/friend-requests/%s/accept" % incoming_id)
    check("同意好友请求 200", accepted_request.status_code == 200, str(accepted_request.status_code))
    sender_friend = lan.find_friend("c1c2c3c4d5d6e7f8") or {}
    check("同意后好友加上了", bool(sender_friend))
    check("同意加好友标记 added_by=request", str(sender_friend.get("added_by")) == "request",
          str(sender_friend.get("added_by")))
    check("同意后回调对方 1 次", len(peer.result_calls) == 1, str(len(peer.result_calls)))
    callback = peer.result_calls[0]
    check("回调 body.accepted=true", (callback["payload"] or {}).get("accepted") is True, str(callback["payload"]))
    check("回调 body.request_id 对应", (callback["payload"] or {}).get("request_id") == incoming_id)
    check("回调 body.from 是本机", ((callback["payload"] or {}).get("from") or {}).get("id") == own_id)
    check("回调带对方口令", callback["headers"].get("X-NOVAI-Friend-Token") == "s" * 40)
    check("处理后 incoming 不再显示", client.get("/api/lan/friend-requests").json().get("incoming") == [])
    check("重复同意 404", client.post("/api/lan/friend-requests/%s/accept" % incoming_id).status_code == 404)
    check("非法 request_id 400", client.post("/api/lan/friend-requests/not-hex/accept").status_code == 400)

    sender2 = {"id": "d1d2d3d4d5d6e7f8", "nickname": "D 君", "avatar": "🦉",
               "base_url": "http://192.168.1.78:3942", "token": "t" * 40, "code": "111111"}
    delivered2 = client.post("/api/lan/friend-requests", json={"from": sender2, "ts": lan.now_ms()},
                             headers={"X-NOVAI-Friend-Token": own_token})
    incoming2 = str((delivered2.json() or {}).get("request_id") or "")
    peer.online = False
    offline_accept = client.post("/api/lan/friend-requests/%s/accept" % incoming2)
    peer.online = True
    check("回调失败不影响本地同意 200", offline_accept.status_code == 200, str(offline_accept.status_code))
    check("回调失败也加上好友", bool(lan.find_friend("d1d2d3d4d5d6e7f8")))
    stored_incoming = [item for item in lan._load_friend_requests()["incoming"] if item.get("id") == incoming2]
    check("回调失败记录了原因", bool(stored_incoming) and "没收到" in str(stored_incoming[0].get("error")),
          str(stored_incoming))

    sender3 = {"id": "e1e2e3e4d5d6e7f8", "nickname": "E 君", "avatar": "🐺",
               "base_url": "http://192.168.1.79:3943", "token": "u" * 40, "code": "222222"}
    delivered3 = client.post("/api/lan/friend-requests", json={"from": sender3, "ts": lan.now_ms()},
                             headers={"X-NOVAI-Friend-Token": own_token})
    incoming3 = str((delivered3.json() or {}).get("request_id") or "")
    peer.result_calls = []
    rejected_request = client.post("/api/lan/friend-requests/%s/reject" % incoming3)
    check("拒绝好友请求 200", rejected_request.status_code == 200, str(rejected_request.status_code))
    check("拒绝后不是好友", lan.find_friend("e1e2e3e4d5d6e7f8") is None)
    check("拒绝也回调 accepted=false", len(peer.result_calls) == 1
          and (peer.result_calls[0]["payload"] or {}).get("accepted") is False, str(peer.result_calls))

    old_record = {"id": "abcdef0123456789", "ts": lan.now_ms() - 8 * 24 * 3600 * 1000, "status": "pending",
                  "from": {"id": "f0f1f2f3f4f5f6f7", "nickname": "旧请求", "avatar": "🐢",
                           "base_url": "http://192.168.1.90:3943", "token": "v" * 40, "code": "333333"}}
    with open(lan.friend_requests_path(), "w", encoding="utf-8") as handle:
        json.dump({"incoming": [old_record], "outgoing": []}, handle)
    check("超过 7 天的请求被清理", client.get("/api/lan/friend-requests").json().get("incoming") == [])
    many_incoming = []
    stamp = lan.now_ms()
    for index in range(60):
        many_incoming.append({"id": "%016x" % (index + 1), "ts": stamp - index * 1000, "status": "pending",
                              "from": {"id": "%016x" % (0x1000 + index), "nickname": "邻居 %d" % index,
                                       "avatar": "🐼", "base_url": "http://192.168.1.%d:3941" % (index % 200 + 1),
                                       "token": "w" * 40, "code": "444444"}})
    with open(lan.friend_requests_path(), "w", encoding="utf-8") as handle:
        json.dump({"incoming": many_incoming, "outgoing": []}, handle)
    check("request 文件最多只留 50 条",
          len(client.get("/api/lan/friend-requests").json().get("incoming") or []) == 50,
          str(len(client.get("/api/lan/friend-requests").json().get("incoming") or [])))
    lan._save_friend_requests({"incoming": [], "outgoing": []})

    # 14. 聊天图片 / 视频：上传落盘 / 口令下发 / send/接收扩展
    MEDIA_TOKEN = "media-lan-token-123"
    deps.bind(LAN_AUTH_ENABLED=lambda: True, LOAD_LAN_TOKEN=lambda: MEDIA_TOKEN)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    uploaded = client.post("/api/lan/media", files={"file": ("封面 1.png", png, "image/png")})
    check("上传图片 200", uploaded.status_code == 200, uploaded.text)
    media = (uploaded.json() or {}).get("media") or {}
    media_id = str(media.get("id") or "")
    check("媒体 id 是 24 位十六进制", bool(re.match(r"^[a-f0-9]{24}$", media_id)), media_id)
    check("媒体 url 是局域网绝对地址",
          str(media.get("url")).startswith("http://") and "/api/lan/media/" in str(media.get("url")),
          str(media.get("url")))
    check("局域网口令开启时 url 带 token", ("token=" + MEDIA_TOKEN) in str(media.get("url")), str(media.get("url")))
    check("媒体类型 image", media.get("kind") == "image", str(media.get("kind")))
    check("媒体 mime 原样返回", media.get("mime") == "image/png", str(media.get("mime")))
    check("媒体大小等于字节数", media.get("size") == len(png), str(media.get("size")))
    check("媒体原名保留", media.get("name") == "封面 1.png", str(media.get("name")))
    check("媒体落盘", os.path.isfile(os.path.join(data_dir, lan.MEDIA_DIR, media_id + ".png")))
    served = client.get("/api/lan/media/" + media_id, params={"token": MEDIA_TOKEN})
    check("带局域网口令下载 200", served.status_code == 200, str(served.status_code))
    check("下载命中图片类型", str(served.headers.get("content-type") or "").startswith("image/png"),
          str(served.headers.get("content-type")))
    check("下载允许长缓存", "immutable" in str(served.headers.get("cache-control") or ""),
          str(served.headers.get("cache-control")))
    check("下载内容一致", served.content == png)
    check("用本机账号口令也能下载",
          client.get("/api/lan/media/" + media_id, headers={"X-NOVAI-Friend-Token": own_token}).status_code == 200)
    check("无口令下载 401", client.get("/api/lan/media/" + media_id).status_code == 401)
    check("错口令下载 401", client.get("/api/lan/media/" + media_id, params={"token": "bad"}).status_code == 401)
    check("不存在的媒体 404",
          client.get("/api/lan/media/" + "0" * 24, params={"token": MEDIA_TOKEN}).status_code == 404)
    check("媒体扩展名不在白名单 404",
          client.get("/api/lan/media/" + "0" * 24 + ".exe", params={"token": MEDIA_TOKEN}).status_code == 404)
    check("媒体目录穿越被挡",
          client.get("/api/lan/media/..%2F..%2Fetc%2Fpasswd", params={"token": MEDIA_TOKEN}).status_code in (400, 404))
    deps.bind(LAN_AUTH_ENABLED=lambda: False, LOAD_LAN_TOKEN=lambda: "")
    check("关闭鉴权后无口令也能下载", client.get("/api/lan/media/" + media_id).status_code == 200)
    deps.bind(LAN_AUTH_ENABLED=lambda: True, LOAD_LAN_TOKEN=lambda: MEDIA_TOKEN)
    check("非图片 / 视频 400",
          client.post("/api/lan/media", files={"file": ("a.pdf", b"%PDF-1.4", "application/pdf")}).status_code == 400)
    check("空文件 400", client.post("/api/lan/media", files={"file": ("a.png", b"", "image/png")}).status_code == 400)
    original_limit = lan.MEDIA_MAX_BYTES
    lan.MEDIA_MAX_BYTES = len(png) - 1
    oversize = client.post("/api/lan/media", files={"file": ("big.png", png, "image/png")})
    lan.MEDIA_MAX_BYTES = original_limit
    check("超过单文件上限 413", oversize.status_code == 413 and "文件太大" in oversize.text, oversize.text)
    check("超限不留残文件", len(os.listdir(os.path.join(data_dir, lan.MEDIA_DIR))) == 1,
          str(os.listdir(os.path.join(data_dir, lan.MEDIA_DIR))))
    mp4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 24
    uploaded_video = client.post("/api/lan/media", files={"file": ("片段.mp4", mp4, "video/mp4")})
    check("上传视频 200", uploaded_video.status_code == 200, uploaded_video.text)
    video_media = (uploaded_video.json() or {}).get("media") or {}
    check("视频类型 video", video_media.get("kind") == "video", str(video_media.get("kind")))
    check("视频扩展名按 content-type 落盘",
          os.path.isfile(os.path.join(data_dir, lan.MEDIA_DIR, str(video_media.get("id")) + ".mp4")))
    long_name = client.post("/api/lan/media", files={"file": ("很长文件名" * 40 + ".png", png, "image/png")})
    check("文件名截到 120 字符",
          len(str(((long_name.json() or {}).get("media") or {}).get("name") or "")) == lan.MEDIA_MAX_NAME,
          str(len(str(((long_name.json() or {}).get("media") or {}).get("name") or ""))))

    peer.supports_requests = False
    peer.online = True
    client.post("/api/lan/friends", json={"code": "NOVAI-192.168.1.9:3000-" + PEER_TOKEN})
    check("媒体测试前好友就绪（旧版本回退直接加）", lan.find_friend(PEER_ID) is not None)
    media_url = str(media.get("url"))
    check("图片消息缺 media_url 400",
          client.post("/api/lan/friends/%s/send" % PEER_ID, json={"kind": "image"}).status_code == 400)
    check("视频消息缺 media_url 400",
          client.post("/api/lan/friends/%s/send" % PEER_ID, json={"kind": "video"}).status_code == 400)
    check("图片消息 media_url 非 http 400",
          client.post("/api/lan/friends/%s/send" % PEER_ID,
                      json={"kind": "image", "media_url": "javascript:alert(1)"}).status_code == 400)
    peer.received = []
    sent_image = client.post("/api/lan/friends/%s/send" % PEER_ID,
                             json={"kind": "image", "media_url": media_url, "media_name": "封面 1.png",
                                   "media_size": len(png), "message_id": "m-img-0001"})
    check("发图片 200", sent_image.status_code == 200, sent_image.text)
    check("对方收到 1 条", len(peer.received) == 1, str(len(peer.received)))
    sent_body = (peer.received[0]["payload"] or {}).get("message") or {}
    check("投递 body 带 media_url", sent_body.get("media_url") == media_url, str(sent_body))
    check("投递 body 带 media_name", sent_body.get("media_name") == "封面 1.png", str(sent_body))
    check("投递 body 带 media_size", sent_body.get("media_size") == len(png), str(sent_body))
    local_image = [item for item in (client.get("/api/lan/messages", params={"with": PEER_ID}).json().get("messages") or [])
                   if item.get("id") == "m-img-0001"]
    check("本地图片消息 kind=image", len(local_image) == 1 and local_image[0].get("kind") == "image", str(local_image))
    check("本地图片消息带媒体三字段",
          len(local_image) == 1 and local_image[0].get("media_url") == media_url
          and local_image[0].get("media_name") == "封面 1.png" and local_image[0].get("media_size") == len(png),
          str(local_image))
    sent_video = client.post("/api/lan/friends/%s/send" % PEER_ID,
                             json={"kind": "video", "media_url": str(video_media.get("url")),
                                   "media_name": "片段.mp4", "media_size": len(mp4), "message_id": "m-vid-0001"})
    check("发视频 200", sent_video.status_code == 200, sent_video.text)
    check("视频消息 kind=video", (sent_video.json().get("message") or {}).get("kind") == "video",
          str(sent_video.json()))

    inbox_from = {"id": "f1f2f3f4f5f6f7f8", "nickname": "F 君", "avatar": "🐹",
                  "base_url": "http://192.168.1.66:3944", "token": "x" * 40}
    remote_media = "http://192.168.1.66:3944/api/lan/media/0123456789abcdef01234567"
    check("收图片消息缺 media_url 400",
          client.post("/api/lan/messages",
                      json={"from": inbox_from, "message": {"id": "in-img-0000", "kind": "image",
                                                            "ts": lan.now_ms()}},
                      headers={"X-NOVAI-Friend-Token": own_token}).status_code == 400)
    received_image = client.post("/api/lan/messages",
                                 json={"from": inbox_from, "message": {
                                     "id": "in-img-0001", "kind": "image", "media_url": remote_media,
                                     "media_name": "对方图.png", "media_size": 1234, "ts": lan.now_ms()}},
                                 headers={"X-NOVAI-Friend-Token": own_token})
    check("收图片消息 200", received_image.status_code == 200, received_image.text)
    inbox_messages = client.get("/api/lan/messages", params={"with": "f1f2f3f4f5f6f7f8"}).json().get("messages") or []
    check("收到图片消息落盘 kind=image",
          len(inbox_messages) == 1 and inbox_messages[0].get("kind") == "image", str(inbox_messages))
    check("收到图片消息带媒体字段",
          len(inbox_messages) == 1 and inbox_messages[0].get("media_url") == remote_media
          and inbox_messages[0].get("media_name") == "对方图.png"
          and inbox_messages[0].get("media_size") == 1234, str(inbox_messages))
    media_friend_row = [item for item in (client.get("/api/lan/friends").json().get("friends") or [])
                        if item.get("id") == "f1f2f3f4f5f6f7f8"]
    check("好友列表最后一条预览是图片",
          len(media_friend_row) == 1 and (media_friend_row[0].get("last_message") or {}).get("kind") == "image",
          str(media_friend_row))
    received_video = client.post("/api/lan/messages",
                                 json={"from": inbox_from, "message": {
                                     "id": "in-vid-0001", "kind": "video", "media_url": remote_media,
                                     "media_name": "对方视频.mp4", "media_size": 4321, "ts": lan.now_ms()}},
                                 headers={"X-NOVAI-Friend-Token": own_token})
    check("收视频消息 200", received_video.status_code == 200, received_video.text)
    check("非法媒体类型归一到 text（缺正文报 400）",
          client.post("/api/lan/messages",
                      json={"from": inbox_from, "message": {"id": "in-bad-0001", "kind": "audio",
                                                            "ts": lan.now_ms()}},
                      headers={"X-NOVAI-Friend-Token": own_token}).status_code == 400)
    deps.bind(LAN_AUTH_ENABLED=lambda: False, LOAD_LAN_TOKEN=lambda: "")

    shutil.rmtree(data_dir, ignore_errors=True)
    print("")
    if FAILED:
        print("局域网好友后端单测失败 %d 项" % FAILED)
        return 1
    print("局域网好友后端单测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
