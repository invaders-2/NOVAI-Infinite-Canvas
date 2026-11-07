#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOVAI GitHub 令牌中转（本地 / 自托管版，Python 3.9+ 标准库）。

令牌只放在这台中转服务上；客户端只配中转地址，不带任何 GitHub 令牌。

契约（只有 GET，全部只读）：
    GET /v1/health                                  -> {"ok": true}
    GET /v1/default-branch?owner=&repo=              -> {"branch": "main"}
    GET /v1/list?owner=&repo=&ref=                   -> {"files": ["skills/pdf/SKILL.md", ...]}
    GET /v1/raw?owner=&repo=&ref=&path=              -> SKILL.md 原文（text/markdown; charset=utf-8）

环境变量：
    GITHUB_TOKEN  生产必填（不填会走未认证 60 次/小时配额，只适合本地自测）
    RELAY_SECRET  可选；设了就要求请求头 x-relay-token 与之相等

用法：
    GITHUB_TOKEN=ghp_xxx RELAY_SECRET=xxx python3 relay/python_relay.py --host 0.0.0.0 --port 4180

安全：只允许 api.github.com / raw.githubusercontent.com，10s 超时，响应 <=1MB，重定向不出上游白名单，
不开放任意 URL 代理（owner/repo/ref/path 严格校验）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4180
TIMEOUT_SECONDS = 10
MAX_BODY_BYTES = 1024 * 1024
ALLOWED_UPSTREAM = ("api.github.com", "raw.githubusercontent.com")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_USER_AGENT = "NOVAI-GitHub-Relay/1.0"


class BadRequest(Exception):
    """客户端参数不合法（回 400）。"""


def valid_name(value, label):
    text = str(value or "").strip()
    if not _NAME_RE.match(text) or text in (".", ".."):
        raise BadRequest("%s 不合法" % label)
    return text


def valid_ref(value):
    text = str(value or "").strip()
    if not text or len(text) > 255 or "\\" in text or text.startswith("/") or ".." in text.split("/"):
        raise BadRequest("ref 不合法")
    return text


def valid_path(value):
    text = str(value or "").strip().strip("/")
    if not text or len(text) > 512 or "\\" in text or any(part in ("", ".", "..") for part in text.split("/")):
        raise BadRequest("path 不合法")
    return text


def _ssl_context():
    try:
        import certifi          # 可选：装了就用它，没装退回系统 CA
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


_CONTEXT = _ssl_context()


def _fetch(url, token):
    """访问上游：返回 (status, body_bytes)。只允许白名单 https 主机。"""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or (parsed.hostname or "").lower() not in ALLOWED_UPSTREAM:
        raise BadRequest("上游地址不在白名单")
    headers = {"User-Agent": _USER_AGENT, "Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS, context=_CONTEXT) as response:
        final_host = (urllib.parse.urlparse(response.geturl()).hostname or "").lower()
        if final_host not in ALLOWED_UPSTREAM:
            raise BadRequest("上游重定向出了白名单")
        return response.status, response.read(MAX_BODY_BYTES + 1)


def _json_bytes(payload):
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _safe_json(body):
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _github_error(status):
    """上游错误码 → 中转自己的可读文案（对客户端保持同一状态码）。"""
    if status in (401, 403):
        return 403, {"error": "GitHub 拒绝访问（令牌权限不足或被限流）"}
    if status == 429:
        return 429, {"error": "GitHub 请求过于频繁（限流）"}
    if status == 404:
        return 404, {"error": "GitHub 上找不到对应资源"}
    if status >= 500:
        return 502, {"error": "GitHub 返回 HTTP %s" % status}
    return 502, {"error": "GitHub 返回 HTTP %s" % status}


class RelayHandler(BaseHTTPRequestHandler):
    server_version = "NOVAI-GitHub-Relay/1.0"
    protocol_version = "HTTP/1.1"

    @property
    def token(self):
        return getattr(self.server, "token", "")

    @property
    def secret(self):
        return getattr(self.server, "secret", "")

    # --- 基础设施 ---
    def log_message(self, fmt, *args):
        sys.stderr.write("[relay] %s %s\n" % (self.address_string(), fmt % args))

    def _send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, payload):
        self._send(status, _json_bytes(payload), "application/json; charset=utf-8")

    def _text(self, status, text):
        self._send(status, text.encode("utf-8"), "text/markdown; charset=utf-8")

    def _method_not_allowed(self):
        self.send_response(405)
        self.send_header("Allow", "GET")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        body = _json_bytes({"error": "method not allowed"})
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_PUT = do_DELETE = do_PATCH = _method_not_allowed

    def _param(self, query, name):
        values = query.get(name) or [""]
        return str(values[0] or "").strip()

    # --- 路由 ---
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        if path == "/v1/health":
            return self._json(200, {"ok": True})
        if self.secret and (self.headers.get("x-relay-token") or "") != self.secret:
            return self._json(401, {"error": "unauthorized"})
        try:
            if path == "/v1/default-branch":
                return self._default_branch(query)
            if path == "/v1/list":
                return self._list(query)
            if path == "/v1/raw":
                return self._raw(query)
        except BadRequest as exc:
            return self._json(400, {"error": str(exc)})
        except (urllib.error.URLError, TimeoutError, OSError):
            return self._json(502, {"error": "无法连接 GitHub"})
        return self._json(404, {"error": "not found"})

    def _default_branch(self, query):
        owner = valid_name(self._param(query, "owner"), "owner")
        repo = valid_name(self._param(query, "repo"), "repo")
        status, body = _fetch("https://api.github.com/repos/%s/%s" % (owner, repo), self.token)
        if status == 200:
            branch = str(_safe_json(body).get("default_branch") or "").strip()
            if not branch:
                return self._json(502, {"error": "GitHub 没有返回默认分支"})
            return self._json(200, {"branch": branch})
        code, payload = _github_error(status)
        if status == 404:
            payload = {"error": "仓库不存在或名字不对：%s/%s" % (owner, repo)}
        return self._json(code, payload)

    def _list(self, query):
        owner = valid_name(self._param(query, "owner"), "owner")
        repo = valid_name(self._param(query, "repo"), "repo")
        ref = valid_ref(self._param(query, "ref"))
        url = "https://api.github.com/repos/%s/%s/git/trees/%s?recursive=1" % (
            owner, repo, urllib.parse.quote(ref, safe=""))
        status, body = _fetch(url, self.token)
        if status != 200:
            code, payload = _github_error(status)
            if status == 404:
                payload = {"error": "仓库或分支不存在：%s/%s@%s" % (owner, repo, ref)}
            return self._json(code, payload)
        if len(body) > MAX_BODY_BYTES:
            return self._json(413, {"error": "目录树超过 1MB 上限"})
        tree = _safe_json(body).get("tree") or []
        files = []
        for item in tree:
            if not isinstance(item, dict) or item.get("type") != "blob":
                continue
            item_path = str(item.get("path") or "")
            if item_path == "SKILL.md" or item_path.endswith("/SKILL.md"):
                files.append(item_path)
        return self._json(200, {"files": files})

    def _raw(self, query):
        owner = valid_name(self._param(query, "owner"), "owner")
        repo = valid_name(self._param(query, "repo"), "repo")
        ref = valid_ref(self._param(query, "ref"))
        path = valid_path(self._param(query, "path"))
        url = "https://raw.githubusercontent.com/%s/%s/%s/%s" % (
            owner, repo, urllib.parse.quote(ref, safe="/"), urllib.parse.quote(path, safe="/"))
        status, body = _fetch(url, self.token)
        if status == 200:
            if len(body) > MAX_BODY_BYTES:
                return self._json(413, {"error": "SKILL.md 超过 1MB 上限"})
            return self._text(200, body.decode("utf-8", "replace"))
        code, payload = _github_error(status)
        if status == 404:
            payload = {"error": "文件不存在：%s/%s@%s/%s" % (owner, repo, ref, path)}
        return self._json(code, payload)


def make_server(host=DEFAULT_HOST, port=DEFAULT_PORT, token="", secret=""):
    """建好（但还没启动）中转服务；端口传 0 表示随机端口（测试用）。"""
    server = ThreadingHTTPServer((host, int(port)), RelayHandler)
    server.daemon_threads = True
    server.token = str(token or "").strip()
    server.secret = str(secret or "").strip()
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description="NOVAI GitHub 令牌中转（只读）")
    parser.add_argument("--host", default=os.environ.get("RELAY_HOST") or DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=int(os.environ.get("RELAY_PORT") or DEFAULT_PORT))
    args = parser.parse_args(argv)
    token = str(os.environ.get("GITHUB_TOKEN") or "").strip()
    secret = str(os.environ.get("RELAY_SECRET") or "").strip()
    if not token:
        print("[relay] 警告：没配 GITHUB_TOKEN，将使用 GitHub 未认证配额（60 次/小时，仅适合本地自测）",
              file=sys.stderr)
    if not secret:
        print("[relay] 提示：没配 RELAY_SECRET，任何能访问到本服务的人都能用（建议公网部署时设置）",
              file=sys.stderr)
    server = make_server(args.host, args.port, token=token, secret=secret)
    host, port = server.server_address[:2]
    print("[relay] listening on http://%s:%s （GITHUB_TOKEN=%s, RELAY_SECRET=%s）" % (
        host, port, "已配置" if token else "未配置", "已配置" if secret else "未配置"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[relay] bye")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
