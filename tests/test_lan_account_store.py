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
    """假的好友机：记录收到的消息，可切换在线 / 口令正确。"""

    def __init__(self) -> None:
        self.online = True
        self.authorized = True
        self.accepting = True
        self.accounts = {}
        self.received = []
        self.peer_nickname = "B 君"
        self.share_status = 200
        self.share_calls = []
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
        return 404, {}


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="novai-lan-test-")
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
    # 重发测试保持原 message_id，验证本地状态从 failed 变 sent
    check("离线发送 502", offline.status_code == 502, str(offline.status_code))
    check("离线错误文案明确", "离线" in offline.text, offline.text)
    chat = client.get("/api/lan/messages", params={"with": PEER_ID}).json().get("messages") or []
    failed = [item for item in chat if item.get("id") == "m-000002"]
    check("离线消息保留为待重发", len(failed) == 1 and failed[0].get("status") == "failed", str(failed))
    peer.online = True
    again = client.post("/api/lan/friends/%s/send" % PEER_ID, json={"text": "在吗", "message_id": "m-000002"})
    check("重发 200", again.status_code == 200, str(again.status_code))
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

    shutil.rmtree(data_dir, ignore_errors=True)
    print("")
    if FAILED:
        print("局域网好友后端单测失败 %d 项" % FAILED)
        return 1
    print("局域网好友后端单测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
