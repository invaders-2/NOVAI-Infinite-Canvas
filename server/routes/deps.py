#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deps.py —— 路由层共享依赖的单向绑定容器（契约 §3.4 脚手架）。

本期 assets 等路由尚未迁入内核，先把骨架放好，后续路由模块可直接复用：

    from server.routes.deps import deps
    deps.bind(registry=registry, db=...)        # 内核启动期注入共享依赖
    app = deps.registry                         # 路由里单向读取，未绑定则 AttributeError

设计要点
--------
- **单向绑定**：只允许通过 `bind(**kwargs)` 注入，不允许路由在运行时反向修改内核对象。
- `__getattr__`：未绑定的属性统一抛 AttributeError，错误信息提示先 bind，避免静默 None。
- 模块级单例 `deps` 被各路由模块 import 共享，保证绑定一次、全局可见。

Python 3.9 约束：注解用 Optional/Dict，禁止 `X | Y`。
"""
from __future__ import annotations

from typing import Any, Dict


class Deps:
    """单向依赖绑定容器。"""

    def __init__(self) -> None:
        self._bound: Dict[str, Any] = {}

    def bind(self, **kwargs: Any) -> None:
        """注入共享依赖（如 registry、db、config）。可多次调用，后者覆盖前者。"""
        self._bound.update(kwargs)

    def get(self, name: str, default: Any = None) -> Any:
        """安全读取；未绑定返回 default。"""
        return self._bound.get(name, default)

    def items(self):
        """返回 (name, value) 视图，便于调试。"""
        return self._bound.items()

    def __contains__(self, name: str) -> bool:
        return name in self._bound

    def __getattr__(self, name: str) -> Any:
        # __getattr__ 仅在常规属性查找（含 __dict__）失败时被调用，
        # 故读取 _bound 自身不会递归。
        try:
            return self.__dict__["_bound"][name]
        except KeyError:
            raise AttributeError(
                "未绑定的依赖：%s（请先通过 deps.bind(%s=...) 注入）" % (name, name)
            )


# 模块级单例：各路由模块 import 同一实例，绑定一次全局可见。
deps = Deps()
