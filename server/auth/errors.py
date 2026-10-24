#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""邀请制登录的领域错误。

路由层把它映射成 {"detail", "code"} 的 JSON；CLI 直接打印 message。
单独成文件是为了让 store / service 都能抛错而不互相 import。
"""
from __future__ import annotations


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 400, code: str = "auth_error") -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
