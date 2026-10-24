#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""画布助手的 canvas_cli 元工具：模型只发「一条命令 + 参数」，内部路由到命令表里的真实工具。

为什么已经有 22 个画布工具还要多这一条：一次只挑一条命令、只填它自己的参数，比在 22 份
schema 里挑字段更省 token、更不容易把字段写错（命令表 server/agents/cli_spec.py 是唯一真相源）。

安全设计（本模块存在的全部理由）：
确认闸门 AGENT_PLAN_CONFIRM_TOOLS / 免费判定 / 生成单元计数 / undo / 产物登记全部**按工具名**
工作。所以 canvas_cli 步骤必须在 main._agent_run_normalize_steps 里、在交给任何闸门之前，
展开成内层真实工具的步骤；本模块的 run() 一旦被直接执行就**必然报错**，把「忘记展开」变成
响亮的失败，而不是一个能绕过用户确认改画布的后门。

本模块刻意不 import main（main 是单体，import 一次会拉起整套依赖）：可用工具表由调用方注入。
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from server.agents import cli_spec

TOOL_NAME = "canvas_cli"

_ERROR_PREFIX = "canvas_cli："


class CanvasCliError(Exception):
    """带机器可读 code 的错误，形状与 AgentToolError / AgentFileToolError 一致，便于统一转结构。"""

    def __init__(self, message: str, code: str = "invalid_args", status_code: int = 400):
        super().__init__(message)
        self.message = str(message)
        self.code = str(code)
        self.status_code = int(status_code)


def _as_available(available: Any) -> Dict[str, Any]:
    return available if isinstance(available, dict) else {}


def _command_groups() -> Tuple[List[str], List[str]]:
    """(只读命令, 写命令)，都按字典序，与 schema.enum 同一口径。"""
    readonly, writable = [], []
    for name in sorted(cli_spec.COMMANDS):
        (writable if cli_spec.COMMANDS[name].get("mutates") else readonly).append(name)
    return readonly, writable


def _description(available: Any) -> str:
    """给模型看的一句说明 + 命令清单；available 只用来点出本环境跑不了的命令，不裁剪 enum
    （enum 镜像命令表本身，某条命令此刻能不能跑由展开阶段按实时工具表判定）。"""
    readonly, writable = _command_groups()
    parts = [
        "用一条命令操作画布：command 取自命令表，args 是该命令的参数（字段见命令表）；"
        "写命令需要用户确认后才会执行。",
        "只读命令：%s。" % "、".join(readonly),
        "写命令：%s。" % "、".join(writable),
    ]
    avail = _as_available(available)
    if avail:
        missing = [name for name in sorted(cli_spec.COMMANDS)
                   if cli_spec.COMMANDS[name].get("tool") not in avail]
        if missing:
            parts.append("当前环境跑不了的命令（对应工具没装在这里）：%s。" % "、".join(missing))
    return "".join(parts)


def _validate(args: Any) -> Dict[str, Any]:
    if not isinstance(args, dict):
        raise CanvasCliError("参数必须是对象", code="invalid_args")
    command = args.get("command")
    command = command.strip() if isinstance(command, str) else ""
    if command not in cli_spec.COMMANDS:
        raise CanvasCliError("%s未知命令 %s" % (_ERROR_PREFIX, command or "<空>"),
                             code="unknown_command")
    inner_args = args.get("args")
    if inner_args is None:
        inner_args = {}
    if not isinstance(inner_args, dict):
        raise CanvasCliError("%s%s 的 args 必须是对象" % (_ERROR_PREFIX, command), code="invalid_args")
    return {"command": command, "args": dict(inner_args),
            "description": str(args.get("description") or "")[:300]}


def _run(args: Any) -> Any:
    """永远失败：canvas_cli 的步骤必须先在 _agent_run_normalize_steps 里展开成真实工具步骤。"""
    raise CanvasCliError(
        "canvas_cli 步骤必须先展开成内层真实工具步骤，不应被直接执行（漏展开会绕过用户确认闸门）",
        code="canvas_cli_not_expanded", status_code=500)


def _preview(args: Any, canvas: Any = None) -> str:
    """预览一句话（给方案卡片看）。main.agent_preview 取的就是 entry["preview"]；校验失败时它会
    再拿**原始** args 调一次，所以这里对任何输入都不许抛错。"""
    args = args if isinstance(args, dict) else {}
    command = args.get("command")
    command = command.strip() if isinstance(command, str) else ""
    spec = cli_spec.COMMANDS.get(command)
    if not spec:
        return "canvas_cli：未知命令 %s（不会执行）" % (command or "<空>")
    return "canvas_cli：%s（展开为 %s）— %s" % (
        command, spec.get("tool") or "", str(spec.get("summary") or "").strip())


def build_tool_entry(available: Any) -> Dict[str, Any]:
    """构造 AGENT_TOOLS 形状的一条注册项；available 是调用方注入的当前工具表。"""
    return {
        "description": _description(available),
        "schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "enum": sorted(cli_spec.COMMANDS),
                    "description": "要执行的命令名（点号形式，取值见命令清单）",
                },
                "args": {"type": "object", "description": "该命令的参数，字段见命令表"},
                "description": {"type": "string", "description": "给用户看的一句中文"},
            },
            "required": ["command"],
        },
        "validate": _validate,
        "run": _run,
        "preview": _preview,
        # 一条外壳命令没法统一判定，真正的写判定由展开后的内层工具承担
        "mutates_canvas": False,
    }


def expand_step(step: Any, available: Any) -> Tuple[Any, Optional[str]]:
    """把一条 canvas_cli 步骤展开成内层真实工具步骤。

    返回 (expanded, error)：非 canvas_cli 的步骤原样返回（同一个对象，不复制、不动 args）；
    展开失败返回 (None, 错误文案)，由调用方记进 unknown 而不是放过。
    """
    if not isinstance(step, dict):
        return step, None
    if str(step.get("tool") or "") != TOOL_NAME:
        return step, None
    outer = step.get("args")
    if not isinstance(outer, dict):
        return None, "%sargs 必须是对象" % _ERROR_PREFIX
    command = outer.get("command")
    command = command.strip() if isinstance(command, str) else ""
    spec = cli_spec.COMMANDS.get(command)
    if not spec:
        return None, "%s未知命令 %s" % (_ERROR_PREFIX, command or "<空>")
    inner_tool = str(spec.get("tool") or "")
    if inner_tool not in _as_available(available):
        return None, "%s命令 %s 对应的工具 %s 当前不可用" % (_ERROR_PREFIX, command, inner_tool)
    inner_args = outer.get("args")
    if inner_args is None:
        inner_args = {}
    if not isinstance(inner_args, dict):
        return None, "%s%s 的 args 必须是对象" % (_ERROR_PREFIX, command)
    return {
        "tool": inner_tool,
        "args": dict(inner_args),          # 内层 args（含它自己的 description）原样保留
        "description": str(step.get("description") or "")[:300],   # 外层 description 是给用户看的那句
    }, None


def expand_steps(steps: Any, available: Any) -> Tuple[List[Any], List[str]]:
    """纯函数：逐条展开，返回 (新步骤列表, 错误文案列表)；不改动传入的 steps 与其中任何对象。"""
    if not isinstance(steps, list):
        return [], []
    expanded_steps: List[Any] = []
    errors: List[str] = []
    for step in steps:
        expanded, error = expand_step(step, available)
        if error:
            errors.append(error)
            continue
        expanded_steps.append(expanded)
    return expanded_steps, errors
