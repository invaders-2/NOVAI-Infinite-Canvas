#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上游用量网关 X-User-Id：只发给本地区域网关、只带解析得出的 username。"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import upstream_user
from server.auth import store as auth_store


class UpstreamUserHeaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._old_dir = auth_store.data_dir()
        data_dir = os.path.join(self._tmp.name, "data")
        os.makedirs(data_dir, exist_ok=True)
        auth_store.set_data_dir(data_dir)
        self.db = os.path.join(data_dir, "users.db")
        conn = sqlite3.connect(self.db)
        conn.execute(
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,"
            " password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',"
            " status TEXT NOT NULL DEFAULT 'active', avatar TEXT NOT NULL DEFAULT '',"
            " created_at INTEGER NOT NULL)")
        for name in ("admin", "lwp19940324@gmail.com"):
            conn.execute(
                "INSERT INTO users (username, password_hash, role, status, avatar, created_at)"
                " VALUES (?, 'x', 'user', 'active', '', 0)", (name,))
        conn.commit()
        conn.close()
        upstream_user._CACHE.clear()
        self._token = upstream_user.bind_request("")
        self._old_tenant_dir = None

    def tearDown(self) -> None:
        upstream_user.reset_request(self._token)
        auth_store.set_data_dir(self._old_dir)
        upstream_user._CACHE.clear()
        self._tmp.cleanup()

    def test_resolve_username_by_name_and_numeric_id(self) -> None:
        self.assertEqual(upstream_user.resolve_username("admin"), "admin")
        self.assertEqual(upstream_user.resolve_username("2"), "lwp19940324@gmail.com")
        self.assertEqual(upstream_user.resolve_username("ADMIN"), "admin")

    def test_unknown_ids_resolve_to_empty(self) -> None:
        for key in ("ip-127.0.0.1", "anonymous", "nobody", "", "999"):
            self.assertEqual(upstream_user.resolve_username(key), "", key)

    def test_only_local_gateways_are_annotated(self) -> None:
        local = ("http://127.0.0.1:8000/v1", "http://localhost:8000/v1",
                 "http://10.25.128.94:8000/v1", "http://192.168.1.9:8000/v1",
                 "http://172.16.3.4:8000/v1", "http://[::1]:8000/v1")
        public = ("https://apib.ai", "https://api.apimart.ai/v1", "https://ai.comfly.chat",
                  "https://api-inference.modelscope.cn/v1", "http://8.8.8.8:8000/v1", "")
        for url in local:
            self.assertTrue(upstream_user.is_local_gateway(url), url)
        for url in public:
            self.assertFalse(upstream_user.is_local_gateway(url), url)

    def test_header_uses_request_user_then_falls_back(self) -> None:
        token = upstream_user.bind_request("2")
        try:
            self.assertEqual(upstream_user.upstream_user_header(), {"X-User-Id": "lwp19940324@gmail.com"})
        finally:
            upstream_user.reset_request(token)
        self.assertEqual(upstream_user.upstream_user_header("admin"), {"X-User-Id": "admin"})
        self.assertEqual(upstream_user.upstream_user_header("ghost"), {})

    def test_apply_keeps_headers_untouched_for_public_and_unknown(self) -> None:
        base = {"Accept": "application/json", "Authorization": "Bearer k"}
        token = upstream_user.bind_request("admin")
        try:
            self.assertEqual(upstream_user.apply_upstream_user_header(dict(base), "https://apib.ai"), base)
            merged = upstream_user.apply_upstream_user_header(dict(base), "http://127.0.0.1:8000/v1")
            self.assertEqual(merged, {**base, "X-User-Id": "admin"})
        finally:
            upstream_user.reset_request(token)
        token = upstream_user.bind_request("ghost")
        try:
            self.assertEqual(
                upstream_user.apply_upstream_user_header(dict(base), "http://127.0.0.1:8000/v1"), base)
        finally:
            upstream_user.reset_request(token)


if __name__ == "__main__":
    unittest.main()
