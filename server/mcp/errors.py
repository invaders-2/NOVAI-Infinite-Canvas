#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MCP 统一异常（stdio 与 https 共用）。"""
from __future__ import annotations

from typing import List, Optional


class McpError(Exception):
    """MCP 调用失败的统一异常（带可读信息与服务端 stderr 尾巴）。"""

    def __init__(self, message: str, code: str = "mcp_error", server: str = "",
                 stderr: Optional[List[str]] = None) -> None:
        super().__init__(message)
        self.message = str(message)
        self.code = str(code)
        self.server = str(server or "")
        self.stderr = list(stderr or [])

    def __str__(self) -> str:
        return self.message
