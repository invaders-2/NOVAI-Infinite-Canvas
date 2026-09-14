#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
capabilities.py —— novai-app/v1 契约的数据模型层。

只定义「能力是什么」，不含任何注册表/调度逻辑（那是 appRegistry.py 的事）。
契约正文见 docs/app-contract.md；校验规则见 server/schemas/novai-app-v1.schema.json。

Python 版本约束
--------------
NOVAI 在 macOS 上用 /usr/bin/python3（**3.9.6**）启动，PEP 604 的 `X | Y` 语法要 3.10+，
写在注解里会在 import 期直接抛 TypeError。故一律用 Optional / Union / Dict / List。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Union


class Risk(str, Enum):
    """风险五级。内核强制，不依赖 MCP 的提示位（契约 v1.2 C12）。"""

    READ = "read"
    WRITE = "write"
    DELETE = "delete"
    EXTERNAL = "external"
    SYSTEM = "system"

    @classmethod
    def values(cls) -> List[str]:
        return [r.value for r in cls]


class HandlerType(str, Enum):
    APP_API = "app-api"                  # 打后端 HTTP 端点
    FRONTEND_BRIDGE = "frontend-bridge"  # 转发到已打开 App 的前端
    MCP_TOOL = "mcp-tool"                # 走 MCP（v1.2 C14：内核做 MCP client）
    SKILL = "skill"                      # 本地脚本


# v1.2 C12：MCP tool annotations → NOVAI 风险五级 的默认推断。
# MCP 只有「提示位」没有强制分级，NOVAI 借此给未显式声明 risk 的能力一个合理默认值；
# manifest 里显式写的 risk 优先。强制拦截始终在内核侧执行。


def infer_risk(annotations: Optional[Dict[str, Any]]) -> str:
    """MCP tool annotations → NOVAI 风险五级默认推断，返回字符串。

    映射（与任务规范 T01/T02 一致）：
        readOnlyHint:true    → "read"
        destructiveHint:true → "delete"
        openWorldHint:true   → "external"
        其余（含无提示位）    → "write"
    破坏性优先于只读，避免互斥提示位冲突时被误判为只读。
    """
    if not annotations:
        return "write"
    if annotations.get("destructiveHint") is True:
        return "delete"
    if annotations.get("openWorldHint") is True:
        return "external"
    if annotations.get("readOnlyHint") is True:
        return "read"
    return "write"


def risk_from_mcp_annotations(annotations: Optional[Dict[str, Any]]) -> Risk:
    """由 MCP tool annotations 推断风险级别（返回 Risk 枚举）；无有效提示位时按最保守的 write 处理。"""
    return Risk(infer_risk(annotations))


@dataclass
class Handler:
    """
    能力的实现方式。字段按 handler.type 选择性生效，由 JSON Schema 的 if/then 约束必填项。
    """

    type: HandlerType
    method: Optional[str] = None                       # app-api 用
    path: Optional[Union[str, List[str]]] = None       # 数组 = 多端点聚合（契约 v1.1 C1）
    aggregate: Optional[str] = None                    # byScope | concat | merge | first | last
    targets: Optional[List[str]] = None                # frontend-bridge 用；v1.1 C3 起为文档性字段
    app_id: Optional[str] = None                       # frontend-bridge 用（内核路由表寻址）
    server: Optional[str] = None                       # mcp-tool 用：内核侧注册的 MCP server 名
    tool: Optional[str] = None                         # mcp-tool 用：MCP server 暴露的工具名
    script: Optional[str] = None                       # skill 用：脚本相对路径
    entrypoint: Optional[str] = None                   # skill 用：入口函数名

    @property
    def paths(self) -> List[str]:
        """把 path 统一成列表，调用方不必区分字符串/数组两种形态。"""
        if self.path is None:
            return []
        if isinstance(self.path, str):
            return [self.path]
        return list(self.path)


@dataclass
class Confirmation:
    required: bool = False
    message: Optional[str] = None


@dataclass
class Capability:
    """
    一条能力声明 = Agent 能对这个 App 做的一件事。

    v1.2 C12：params / returns 是 inputSchema / outputSchema 的 deprecated 别名，
    统一用 effective_input_schema / effective_output_schema 读取，迁移期两种写法都认。
    """

    id: str
    title: str
    risk: Risk
    handler: Handler
    description: Optional[str] = None
    intent: Optional[str] = None                       # v1.2 C12：降级为路由标签
    input_schema: Optional[Dict[str, Any]] = None
    output_schema: Optional[Dict[str, Any]] = None
    params: Optional[Dict[str, Any]] = None            # deprecated 别名
    returns: Optional[Dict[str, Any]] = None           # deprecated 别名
    confirmation: Confirmation = field(default_factory=Confirmation)

    @property
    def effective_input_schema(self) -> Optional[Dict[str, Any]]:
        return self.input_schema if self.input_schema is not None else self.params

    @property
    def effective_output_schema(self) -> Optional[Dict[str, Any]]:
        return self.output_schema if self.output_schema is not None else self.returns

    @property
    def requires_confirmation(self) -> bool:
        """契约/Schema 已保证 delete 与 external 必须为 True，这里做运行时兜底。"""
        risk_value = self.risk.value if isinstance(self.risk, Risk) else str(self.risk)
        return bool(self.confirmation.required) or risk_value in ("delete", "external")

    @property
    def namespace(self) -> str:
        """能力命名空间，用于推导所需权限，如 assets.search → assets。"""
        return self.id.split(".")[0] if "." in self.id else self.id

    def required_permission(self) -> str:
        """
        由「命名空间 + 风险级」推导该能力需要的权限点。

        read/write/delete → `<ns>.<risk>`，如 assets.search → assets.read
        external         → network.write（出网一律按写权限管）
        system           → system.execute
        """
        risk_value = self.risk.value if isinstance(self.risk, Risk) else str(self.risk)
        if risk_value == "external":
            return "network.write"
        if risk_value == "system":
            return "system.execute"
        return "%s.%s" % (self.namespace, risk_value)

    def to_dict(self) -> Dict[str, Any]:
        """给 `/api/apps` 与未来的 `tools/list` 用（v1.2 C12：inputSchema 直接透传）。"""
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "intent": self.intent,
            "risk": self.risk.value if isinstance(self.risk, Risk) else str(self.risk),
            "handler": {
                "type": self.handler.type.value
                if isinstance(self.handler.type, HandlerType)
                else str(self.handler.type),
                "path": self.handler.path,
                "method": self.handler.method,
            },
            "inputSchema": self.effective_input_schema,
            "outputSchema": self.effective_output_schema,
            "confirmation": {
                "required": self.confirmation.required,
                "message": self.confirmation.message,
            },
        }


def capability_from_dict(raw: Dict[str, Any]) -> Capability:
    """从 manifest 的 capability 字典构造 Capability（缺 risk 时保守取 write）。"""
    handler_raw = raw.get("handler") or {}
    conf_raw = raw.get("confirmation") or {}
    risk_raw = raw.get("risk") or risk_from_mcp_annotations(raw.get("annotations")).value
    try:
        risk = Risk(risk_raw)
    except ValueError:
        risk = Risk.WRITE  # 未知风险级按保守处理，由 Schema 在 install 阶段拦下

    return Capability(
        id=raw["id"],
        title=raw.get("title") or raw["id"],
        risk=risk,
        handler=Handler(
            type=HandlerType(handler_raw.get("type", "app-api")),
            method=handler_raw.get("method"),
            path=handler_raw.get("path"),
            aggregate=handler_raw.get("aggregate"),
            targets=handler_raw.get("targets"),
            app_id=handler_raw.get("app_id") or handler_raw.get("appId"),
            server=handler_raw.get("server"),
            tool=handler_raw.get("tool"),
            script=handler_raw.get("script"),
            entrypoint=handler_raw.get("entrypoint"),
        ),
        description=raw.get("description"),
        intent=raw.get("intent"),
        input_schema=raw.get("inputSchema"),
        output_schema=raw.get("outputSchema"),
        params=raw.get("params"),
        returns=raw.get("returns"),
        confirmation=Confirmation(
            required=bool(conf_raw.get("required", False)),
            message=conf_raw.get("message"),
        ),
    )
