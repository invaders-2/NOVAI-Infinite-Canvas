#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
appRegistry.py —— NOVAI 内核的 App 注册表与能力总线后端（T01 + T02 骨架）。

职责边界
--------
只做「注册 + 校验 + 解析 + 调用」，不碰 main.py 的任何现有路由。
main.py 已预留接入桩（main.py:1635-1644）：makedirs + mount /apps +
    from server.appRegistry import registry, apps_router
    registry.scan(APPS_DIR)
    app.include_router(apps_router)
本模块必须导出 `registry`（AppRegistry 单例）与 `apps_router`（APIRouter），否则启动即崩。

设计铁律（来自任务规范）
------------------------
1. **install() 内部全 try/except，绝不向上传播。** 一个坏 App 只让自己 state=failed，
   后端必须照常启动——装 App 失败导致服务起不来是不可接受的。
2. **Python 3.9 语法**（/usr/bin/python3 = 3.9.6），注解一律用 Optional/Union/Dict/List/Set，
   禁止 `X | Y` 这种 3.10+ 写法（dataclass 字段注解里写 `str | None` 会在导入时直接报 TypeError）。
3. **jsonschema 缺失时降级为基础字段检查 + warn**，不让启动失败。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from server.capabilities import Capability, HandlerType, Risk, capability_from_dict

logger = logging.getLogger("novai.appRegistry")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS_DIR = os.path.join(BASE_DIR, "apps")
SCHEMA_PATH = os.path.join(BASE_DIR, "server", "schemas", "novai-app-v1.schema.json")

# 契约强制必填字段（任务规范 T01）。name 等其余字段为可选，由 Schema 的 properties 描述。
REQUIRED_FIELDS = [
    "format",
    "id",
    "version",
    "entry",
    "capabilities",
    "permissions",
    "keepAlive",
    "singleton",
    "dataVersion",
]

# 本期直接拦截的高风险级别（确认流留待后续任务）。
BLOCKED_RISKS = ("delete", "external")


# ---------------------------------------------------------------- 数据模型


@dataclass
class AppRecord:
    """一个已安装 App 的注册记录。

    state 取值：'pending' | 'healthy' | 'failed' | 'rolled-back' | 'suspended'。
    正常安装成功为 'healthy'；契约校验或安装异常为 'failed'（不抛出）。
    """

    id: str
    manifest: Dict[str, Any]
    state: str
    capabilities: Dict[str, Capability]
    grants: Set[str] = field(default_factory=set)
    data_version: int = 1
    dir: str = ""
    error: Optional[str] = None


# ---------------------------------------------------------------- 注册表


class AppRegistry:
    """
    App 注册表 + 能力调用的强制执行点（T02 骨架）。

    本期范围（任务规范）：
        - install / scan / unregister / get / list_apps / resolve 完整可用
        - invoke：app-api 类按 handler.path 规则调用后端；其余
          （frontend-bridge / mcp-tool / skill）先返回 {"status":"not_implemented"} 占位，
          保证接口可达。危险级（delete/external）由路由层直接返回 blocked。
        - 权限/确认的完整拦截流是后续任务，本期只保证「接口可达 + 坏 App 不拖垮内核」。
    """

    def __init__(self) -> None:
        self._apps: Dict[str, AppRecord] = {}
        self._schema: Optional[Dict[str, Any]] = None

    # ---- schema

    def _load_schema(self) -> Optional[Dict[str, Any]]:
        if self._schema is not None:
            return self._schema
        try:
            with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
                self._schema = json.load(f)
        except Exception as e:  # 读不到 schema 也不致命，降级为字段检查
            logger.error("加载契约 Schema 失败（%s）：%r", SCHEMA_PATH, e)
            self._schema = None
        return self._schema

    def validate_manifest(self, manifest: Dict[str, Any]) -> List[str]:
        """返回错误列表，空列表表示通过。Schema 缺失或 jsonschema 未装时降级为基础字段检查。"""
        # 基础字段检查始终做（降级路径也要拦住明显缺字段的坏 manifest）
        missing = [k for k in REQUIRED_FIELDS if k not in manifest]
        schema = self._load_schema()
        if schema is None:
            if missing:
                logger.warning("契约 Schema 缺失，仅做基础字段检查；缺少必填字段：%s", ", ".join(missing))
                return ["缺少必填字段：%s" % ", ".join(missing)]
            return []
        try:
            import jsonschema
        except ImportError:
            if missing:
                logger.warning("jsonschema 未安装，降级为基础字段检查；缺少必填字段：%s", ", ".join(missing))
                return ["缺少必填字段：%s" % ", ".join(missing)]
            return []
        try:
            validator = jsonschema.Draft7Validator(schema)
            errors = sorted(validator.iter_errors(manifest), key=lambda e: list(e.path))
            msgs = ["%s: %s" % (".".join(str(p) for p in e.path) or "root", e.message) for e in errors]
            if missing and not msgs:
                msgs = ["缺少必填字段：%s" % ", ".join(missing)]
            return msgs
        except Exception as e:
            logger.error("Schema 校验异常（已忽略，按通过处理）：%r", e)
            return []

    # ---- 安装 / 卸载

    def install(self, manifest_path: str) -> AppRecord:
        """
        安装一个 App。**永不抛异常**：失败时返回 state=failed 的 AppRecord。
        这是「坏 App 不能拖垮内核」这条铁律的落点。
        """
        app_dir = os.path.dirname(os.path.abspath(manifest_path))
        fallback_id = os.path.basename(app_dir) or "unknown"
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception as e:
            logger.error("读取 manifest 失败 %s：%r", manifest_path, e)
            return AppRecord(
                id=fallback_id, manifest={}, state="failed", capabilities={},
                data_version=1, dir=app_dir, error="manifest 读取或解析失败：%s" % e,
            )

        app_id = str(manifest.get("id") or fallback_id)

        errors = self.validate_manifest(manifest)
        if errors:
            logger.error("App %s 契约校验失败：%s", app_id, "; ".join(errors[:5]))
            return AppRecord(
                id=app_id, manifest=manifest, state="failed", capabilities={},
                grants=set(manifest.get("permissions", []) or []),
                data_version=int(manifest.get("dataVersion", 1)), dir=app_dir,
                error="; ".join(errors[:5]),
            )

        try:
            caps: Dict[str, Capability] = {}
            for raw in manifest.get("capabilities", []):
                cap = capability_from_dict(raw)
                caps[cap.id] = cap
            record = AppRecord(
                id=app_id,
                manifest=manifest,
                state="healthy",
                capabilities=caps,
                grants=set(manifest.get("permissions", []) or []),
                data_version=int(manifest.get("dataVersion", 1)),
                dir=app_dir,
            )
            self._apps[app_id] = record
            logger.info("App %s 安装成功（version=%s，%d 条能力）",
                        app_id, record.manifest.get("version", "?"), len(caps))
            return record
        except Exception as e:  # 兜底：任何意外都只让这一个 App 失败
            logger.error("App %s 安装过程异常：%r", app_id, e)
            return AppRecord(
                id=app_id, manifest=manifest, state="failed", capabilities={},
                grants=set(manifest.get("permissions", []) or []),
                data_version=int(manifest.get("dataVersion", 1)), dir=app_dir,
                error="安装异常：%s" % e,
            )

    def scan(self, apps_dir: str = APPS_DIR) -> None:
        """扫描 apps/ 下所有 manifest.json 并 install。目录不存在时静默跳过。"""
        if not os.path.isdir(apps_dir):
            logger.warning("App 目录不存在，跳过扫描：%s", apps_dir)
            return
        for name in sorted(os.listdir(apps_dir)):
            manifest_path = os.path.join(apps_dir, name, "manifest.json")
            if os.path.isfile(manifest_path):
                self.install(manifest_path)

    def unregister(self, app_id: str) -> None:
        self._apps.pop(app_id, None)

    def get(self, app_id: str) -> Optional[AppRecord]:
        return self._apps.get(app_id)

    def list_apps(self, include_failed: bool = False) -> List[Dict[str, Any]]:
        """返回供 GET /api/apps 消费的 App 清单（规范约定形状）。"""
        out: List[Dict[str, Any]] = []
        for rec in self._apps.values():
            if not include_failed and rec.state != "healthy":
                continue
            out.append({
                "id": rec.id,
                "title": rec.manifest.get("name", rec.id),
                "version": str(rec.manifest.get("version", "0.0.0")),
                "state": rec.state,
                "capabilities": [
                    {
                        "id": c.id,
                        "risk": c.risk.value if isinstance(c.risk, Risk) else str(c.risk),
                        "title": c.title,
                    }
                    for c in rec.capabilities.values()
                ],
            })
        return out

    def resolve(self, intent: str) -> List[Capability]:
        """
        Agent 入口：按意图裁剪能力集。

        匹配顺序：intent 精确命中 → 能力 id 精确命中 → 命名空间前缀命中
        （如 intent="assets" 命中 assets.search / assets.delete）。查不到返回空列表。
        """
        out: List[Capability] = []
        if not intent:
            return out
        for rec in self._apps.values():
            if rec.state != "healthy":
                continue
            for cap in rec.capabilities.values():
                if cap.intent == intent or cap.id == intent:
                    out.append(cap)
        if out:
            return out
        prefix = intent + "."
        for rec in self._apps.values():
            if rec.state != "healthy":
                continue
            for cap in rec.capabilities.values():
                if cap.id.startswith(prefix) or (cap.intent or "").startswith(prefix):
                    out.append(cap)
        return out

    # ---- 调用

    def invoke(self, app_id: str, cap_id: str,
               params: Optional[Dict[str, Any]] = None,
               ctx: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """
        执行一次能力调用，返回 dict。本期语义（规范 T02）：
            - app-api 类 → 按 handler.path 规则调用后端，返回 {"status":"ok","data":...}
            - 其余（frontend-bridge / mcp-tool / skill）→ {"status":"not_implemented"} 占位
        危险级（delete/external）的 blocked 由 HTTP 路由层统一返回，不在此处理。
        """
        rec = self.get(app_id)
        if rec is None:
            return {"status": "error", "error": "app not found: %s" % app_id}
        cap = rec.capabilities.get(cap_id)
        if cap is None:
            return {"status": "error", "error": "capability not found: %s" % cap_id}

        if cap.handler.type != HandlerType.APP_API:
            # 本期占位：frontend-bridge / mcp-tool / skill 的投递在后续任务实现
            return {"status": "not_implemented"}

        return self._dispatch_app_api(cap, params or {})

    def _dispatch_app_api(self, cap: Capability,
                          params: Dict[str, Any]) -> Dict[str, Any]:
        """打后端 HTTP 端点（内部回环）。多端点按 aggregate 归并。"""
        paths = cap.handler.paths
        if not paths:
            return {"status": "error", "error": "app-api handler 未配置 path"}
        base = (os.environ.get("NOVAI_BASE_URL")
                or "http://127.0.0.1:%s" % os.environ.get("NOVAI_PORT", "3000")).rstrip("/")
        method = (cap.handler.method or "GET").upper()
        try:
            import httpx
        except ImportError:
            return {"status": "error", "error": "缺少 httpx 依赖"}

        results: List[Any] = []
        errors: List[Dict[str, str]] = []
        for path in paths:
            url = base + path
            try:
                with httpx.Client(timeout=30.0) as client:
                    if method == "GET":
                        resp = client.get(url, params=params)
                    else:
                        resp = client.request(method, url, json=params)
                if resp.status_code >= 400:
                    errors.append({"path": path, "error": "HTTP %d" % resp.status_code})
                    continue
                try:
                    results.append(resp.json())
                except Exception:
                    results.append(resp.text)
            except Exception as e:
                errors.append({"path": path, "error": str(e)})  # 单端点失败不炸整次调用

        if not results:
            return {"status": "error", "error": "全部端点失败：%s" % errors}
        return {"status": "ok", "data": self._aggregate(results, errors, cap.handler.aggregate)}

    @staticmethod
    def _aggregate(results: List[Any], errors: List[Dict[str, str]],
                   aggregate: Optional[str]) -> Any:
        mode = aggregate or ("concat" if len(results) > 1 else "first")
        if mode == "first":
            return results[0]
        if mode == "last":
            return results[-1]
        if mode == "concat":
            merged: List[Any] = []
            for r in results:
                merged.extend(r if isinstance(r, list) else [r])
            return {"items": merged, "errors": errors}
        if mode == "merge":
            merged_dict: Dict[str, Any] = {}
            for r in results:
                if isinstance(r, dict):
                    merged_dict.update(r)
            return merged_dict if not errors else dict(merged_dict, errors=errors)
        if mode == "byScope":
            return {"scopes": results, "errors": errors}
        return results[0]


# ---------------------------------------------------------------- HTTP 路由

# 注意：main.py 用 app.include_router(apps_router) 在根路径挂载（无 prefix），
# 因此路由必须写完整路径 /api/apps*，不能写 ""（否则会被挂到根 "/"）。


registry = AppRegistry()
apps_router = APIRouter()


@apps_router.get("/api/apps")
def api_list_apps(include_failed: bool = Query(False, description="true 时包含安装失败的 App")):
    """已注册 App 及能力清单。默认隐藏 failed App，便于前端直接消费。"""
    return {"apps": registry.list_apps(include_failed=include_failed)}


@apps_router.get("/api/apps/health")
def api_apps_health():
    return {"status": "ok", "apps": len(registry.list_apps())}


@apps_router.post("/api/apps/invoke")
async def api_invoke(request: Request):
    """
    能力调用入口。本期权保证接口可达：
        body: { app_id, cap_id, params }
        - cap_id 不存在 → 404
        - 危险级（delete/external）→ {"status":"blocked","reason":"confirmation required"}
        - 其余 → registry.invoke(...) 的结果
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"status": "error", "error": "请求体不是合法 JSON"})
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"status": "error", "error": "请求体必须是对象"})

    app_id = body.get("app_id")
    cap_id = body.get("cap_id")
    if not app_id or not cap_id:
        return JSONResponse(status_code=400, content={"status": "error", "error": "缺少 app_id 或 cap_id"})

    rec = registry.get(str(app_id))
    if rec is None:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "error": "app not found", "app_id": app_id},
        )
    cap = rec.capabilities.get(str(cap_id))
    if cap is None:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "error": "capability not found", "cap_id": cap_id},
        )

    # 危险级本期直接拦截，确认流留待后续任务
    risk = cap.risk.value if isinstance(cap.risk, Risk) else str(cap.risk)
    if risk in BLOCKED_RISKS:
        return {"status": "blocked", "reason": "confirmation required"}

    # app-api handler 用同步 httpx 回访本服务其它端点，必须丢到线程里，
    # 否则在事件循环里直接调用会把循环堵死（自锁超时，实测踩过）。
    result = await asyncio.to_thread(
        registry.invoke, str(app_id), str(cap_id), body.get("params") or {}, None
    )
    return result
