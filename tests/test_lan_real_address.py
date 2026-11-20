#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""局域网「真实地址」回归测试（2026-11-19）。

问题：对方开了 Clash / VPN TUN 模式时，自报的 base_url / 分享链接 / 媒体地址是 198.18.x.x 这类
虚拟网卡地址 → 加好友回执送不回、在线显示离线、消息发不出、克隆别人的画布失败。
覆盖：
1. server/lan_ip 打分：跳过 utun / 198.18 / bridge，优先真实网卡；
2. 收消息 / 收好友请求 / 收好友结果：主机改用请求来源 IP，端口保留自报的；
3. 画布分享链接、图片地址的主机同样改成来源 IP；
4. 同意好友的回执连不上时进入后台补投，对方恢复后送达；
5. 好友列表并发查在线状态，且刷新到的新地址不会被写回旧值。
用法：venv/bin/python tests/test_lan_real_address.py
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import lan_ip  # noqa: E402
from server.routes.deps import deps  # noqa: E402
from server.routes import lan_account as lan  # noqa: E402

FAILED = 0
PEER_ID = "b1b2c3d4e5f60718"
PEER_TOKEN = "p" * 48
REAL_IP = "192.168.31.77"
FAKE_IP = "198.18.0.1"


def check(label: str, ok: bool, detail: str = "") -> None:
    global FAILED
    print(("PASS  " if ok else "FAIL  ") + label + ((" (" + detail + ")") if detail else ""))
    if not ok:
        FAILED += 1


def main() -> int:
    # ---- 1. 选 IP 打分
    check("utun 上的 198.18 不可用", lan_ip._score("utun4", FAKE_IP, FAKE_IP) < 0)
    check("198.18 即使网卡名正常也不可用", lan_ip._score("en0", "198.18.0.5", "") < 0)
    check("bridge100（虚拟机）不可用", lan_ip._score("bridge100", "192.168.64.1", "") < 0)
    check("en0 192.168.x 可用", lan_ip._score("en0", REAL_IP, FAKE_IP) > 0)
    check("192.168 优先于 172.17（Docker）",
          lan_ip._score("en0", REAL_IP, "") > lan_ip._score("eth1", "172.17.0.2", ""))
    os.environ.pop("NOVAI_LAN_IP", None)
    os.environ["NOVAI_LAN_IP_OVERRIDE"] = "10.0.0.9"
    check("NOVAI_LAN_IP_OVERRIDE 优先", lan_ip.pick_lan_ip(force=True) == "10.0.0.9")
    os.environ.pop("NOVAI_LAN_IP_OVERRIDE", None)

    # ---- 2~5 路由
    data_dir = tempfile.mkdtemp(prefix="novai-lan-real-")
    os.environ["NOVAI_LAN_DISCOVERY"] = "0"
    os.environ["NOVAI_LAN_IP"] = "192.168.31.10"
    lan.AUTO_RETRY = False
    calls = []
    state = {"up": True}

    def fake_http(url, method="GET", payload=None, headers=None, timeout=1.5):
        calls.append(str(url))
        if not state["up"]:
            raise OSError(61, "Connection refused")
        if str(url).endswith("/api/lan/ping"):
            return 200, {"ok": True, "account_id": PEER_ID, "authorized": True, "nickname": "B"}
        if str(url).endswith("/api/lan/friend-requests/result"):
            return 200, {"ok": True}
        return 200, {"ok": True}

    deps.bind(DATA_DIR=data_dir, LAN_HTTP_JSON=fake_http, APP_VERSION="novai-v16-test")
    app = FastAPI()
    app.include_router(lan.router)
    local = TestClient(app)                                   # 本机页面
    remote = TestClient(app, client=(REAL_IP, 50123))         # 好友机直连
    try:
        me = local.get("/api/lan/me").json()["me"]
        with lan.use_owner(lan.OWNER_LOCAL):
            my_token = str(lan.load_account().get("token") or "")
        sender = {"id": PEER_ID, "nickname": "B", "avatar": "🐳",
                  "base_url": "http://%s:3000" % FAKE_IP, "token": PEER_TOKEN}

        # 2. 收消息：base_url 用来源 IP
        msg = {"id": "msgabc123", "kind": "canvas", "text": "",
               "share_url": "http://%s:3000/static/canvas.html?share=abcdefghijklmnop1234&token=t1" % FAKE_IP,
               "canvas_title": "B 的画布", "ts": int(time.time() * 1000)}
        r = remote.post("/api/lan/messages", json={"from": sender, "message": msg},
                        headers={"X-NOVAI-Friend-Token": my_token})
        check("收消息 200", r.status_code == 200, r.text[:120])
        with lan.use_owner(lan.OWNER_LOCAL):
            friend = lan.find_friend(PEER_ID) or {}
            chat = lan.load_chat(PEER_ID)
        check("好友地址改成真实来源 IP、端口保留", friend.get("base_url") == "http://%s:3000" % REAL_IP,
              str(friend.get("base_url")))
        share = str((chat[-1] if chat else {}).get("share_url") or "")
        check("画布分享链接主机换成来源 IP", share.startswith("http://%s:3000/static/canvas.html" % REAL_IP), share)
        check("分享链接里的令牌保留", "share=abcdefghijklmnop1234" in share and "token=t1" in share, share)

        # 3. 图片地址同样换主机；指向第三方主机的地址不动
        img = {"id": "msgimg1234", "kind": "image", "text": "",
               "media_url": "http://%s:3000/api/lan/media/0123456789abcdef0123" % FAKE_IP,
               "media_name": "a.png", "ts": int(time.time() * 1000)}
        remote.post("/api/lan/messages", json={"from": sender, "message": img},
                    headers={"X-NOVAI-Friend-Token": my_token})
        with lan.use_owner(lan.OWNER_LOCAL):
            last = lan.load_chat(PEER_ID)[-1]
        check("图片地址主机换成来源 IP", str(last.get("media_url", "")).startswith("http://%s:3000/" % REAL_IP),
              str(last.get("media_url")))
        check("_rehost_url 不动别的主机",
              lan._rehost_url("http://10.9.9.9:3000/x", FAKE_IP, REAL_IP) == "http://10.9.9.9:3000/x")

        # 本机页面（testclient / 回环）来的请求不改地址
        check("非 IP 来源不改写", lan._peer_base_from_request(None, "http://%s:3000" % FAKE_IP)
              == "http://%s:3000" % FAKE_IP)

        # 4. 收好友请求：记录里的地址是来源 IP
        other_id = "c1c2c3d4e5f60718"
        req_from = dict(sender, id=other_id, code="123456")
        r = remote.post("/api/lan/friend-requests", json={"from": req_from, "ts": int(time.time() * 1000)},
                        headers={"X-NOVAI-Friend-Token": my_token})
        check("收好友请求 200", r.status_code == 200, r.text[:120])
        incoming = local.get("/api/lan/friend-requests").json()["incoming"]
        rec = next((x for x in incoming if x["from"]["id"] == other_id), {})
        check("好友请求记录用来源 IP", rec.get("from", {}).get("base_url") == "http://%s:3000" % REAL_IP,
              str(rec.get("from")))

        # 同意时对方暂时连不上：本机照样加上好友，回执进入后台补投
        state["up"] = False
        r = local.post("/api/lan/friend-requests/%s/accept" % rec["id"])
        check("同意 200（对方离线也先加上）", r.status_code == 200, r.text[:120])
        check("回执进入补投队列", any(k.endswith("|" + rec["id"]) for k in lan._PENDING_CALLBACKS))
        check("对方离线时补投不成功", lan.retry_callbacks_once() == 0)
        state["up"] = True
        calls.clear()
        check("对方恢复后补投送达", lan.retry_callbacks_once() == 1)
        check("补投打的是真实地址",
              any(u == "http://%s:3000/api/lan/friend-requests/result" % REAL_IP for u in calls), str(calls))
        check("补投队列清空", not any(k.endswith("|" + rec["id"]) for k in lan._PENDING_CALLBACKS))
        with lan.use_owner(lan.OWNER_LOCAL):
            stored = lan._find_request("incoming", rec["id"]) or {}
        check("送达后清掉失败提示", "error" not in stored, str(stored.get("error")))

        # 5. 收好友结果（我发出的请求被对方同意）：地址用来源 IP
        with lan.use_owner(lan.OWNER_LOCAL):
            lan._upsert_outgoing({"id": "00112233445566ff", "ts": int(time.time() * 1000), "status": "pending",
                                  "to": {"id": "d1d2c3d4e5f60718", "nickname": "D",
                                         "base_url": "http://%s:3000" % FAKE_IP, "code": "654321"}})
        r = remote.post("/api/lan/friend-requests/result",
                        json={"request_id": "00112233445566ff", "accepted": True,
                              "from": dict(sender, id="d1d2c3d4e5f60718")},
                        headers={"X-NOVAI-Friend-Token": my_token})
        check("收好友结果 200", r.status_code == 200, r.text[:120])
        with lan.use_owner(lan.OWNER_LOCAL):
            d = lan.find_friend("d1d2c3d4e5f60718") or {}
        check("同意结果里的好友地址用来源 IP", d.get("base_url") == "http://%s:3000" % REAL_IP, str(d.get("base_url")))

        # 6. 好友列表：多个好友并发查在线
        lan._ONLINE_CACHE.clear()
        friends = local.get("/api/lan/friends").json()["friends"]
        check("好友列表返回全部好友", len(friends) >= 3, str(len(friends)))
        check("在线好友显示在线", all(f["online"] for f in friends), str([f["online"] for f in friends]))
    finally:
        shutil.rmtree(data_dir, ignore_errors=True)
        os.environ.pop("NOVAI_LAN_IP", None)
    print("\n%s" % ("全部通过" if not FAILED else "失败 %d 项" % FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
