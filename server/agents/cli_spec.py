#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOVAI CLI 命令表（唯一真相源）。

命令由现有工具集派生：画布工具来自 main.py 的 AGENT_TOOLS，文件工具来自
server/agents/tools.py 的 AGENT_FILE_TOOLS。这里刻意不 import main——main 是单体，
import 一次要拉起整套依赖；工具名与标记的一致性由 tests/test_novai_cli.py 解析源码核对。

每条命令的字段：
    tool            对应工具名
    mutates         整条命令是否产生持久化副作用（写画布 / 写素材库或记忆 / 落盘产物 / 发起生成任务）
    mutates_canvas  与工具注册表里的同名标记一致（只表示改动画布内容）
    summary         一句中文说明，直接进 CLI 帮助与 docs
"""
from __future__ import annotations

from typing import Dict, Iterator, List, Optional, Tuple

# 与 main.AGENT_TOOLS 的键一一对应（顺序也照抄，方便人工比对）
CANVAS_TOOL_NAMES = (
    "list_canvases",
    "get_canvas",
    "create_node",
    "delete_node",
    "connect_nodes",
    "disconnect_nodes",
    "update_node",
    "run_generation",
    "generate_image",
    "generate_video",
    "batch_generate",
    "run_batch",
    "list_templates",
    "save_template",
    "apply_template",
    "remember",
    "forget",
    "run_downstream",
    "arrange_canvas",
    "refine_prompt",
    "use_asset",
    "check_task",
)

FILE_TOOL_NAMES = ("read_table", "write_html_report", "write_xlsx", "image_generate")

TOOL_NAMES = CANVAS_TOOL_NAMES + FILE_TOOL_NAMES


COMMANDS: Dict[str, Dict] = {
    # --- 只读 ---------------------------------------------------------------
    "canvas.list": {
        "tool": "list_canvases",
        "mutates": False,
        "mutates_canvas": False,
        "summary": "列出所有画布（ID / 名称 / 项目 / 更新时间）",
    },
    "canvas.get": {
        "tool": "get_canvas",
        "mutates": False,
        "mutates_canvas": False,
        "summary": "读取一张画布的快照摘要（节点、连线、视口）",
    },
    "template.list": {
        "tool": "list_templates",
        "mutates": False,
        "mutates_canvas": False,
        "summary": "列出资产库里的流程模板（名称与包含的节点）",
    },
    "asset.search": {
        "tool": "use_asset",
        "mutates": False,
        "mutates_canvas": False,
        "summary": "按关键词或类型检索素材库，返回素材 URL",
    },
    "task.check": {
        "tool": "check_task",
        "mutates": False,
        "mutates_canvas": False,
        "summary": "查询生成任务的状态与结果 URL",
    },
    "table.read": {
        "tool": "read_table",
        "mutates": False,
        "mutates_canvas": False,
        "summary": "读取用户上传的 xlsx/csv（列名、样例、统计）",
    },
    "canvas.arrange": {
        "tool": "arrange_canvas",
        "mutates": False,
        "mutates_canvas": False,
        "summary": "按连线给出流程排布建议（由前端落位，可一键撤销）",
    },
    "prompt.refine": {
        "tool": "refine_prompt",
        "mutates": False,
        "mutates_canvas": False,
        "summary": "给出提示词改写候选（只出结果，不写节点）",
    },
    # --- 写画布 -------------------------------------------------------------
    "node.create": {
        "tool": "create_node",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "新建节点（提示词 / 图片 / 视频 / 文本 / 表格 / 批量），可同时连上游",
    },
    "node.update": {
        "tool": "update_node",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "修改已有节点的提示词、生成参数、标题或坐标",
    },
    "node.delete": {
        "tool": "delete_node",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "删除节点（被连线引用时需显式强制）",
    },
    "node.connect": {
        "tool": "connect_nodes",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "把上游节点连到下游节点，并校验类型与方向",
    },
    "node.disconnect": {
        "tool": "disconnect_nodes",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "断开两个节点之间的连线",
    },
    "generation.run": {
        "tool": "run_generation",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "重跑一个已有图片/视频节点（会产生真实生成与计费）",
    },
    "generation.downstream": {
        "tool": "run_downstream",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "把一个节点后面还没出结果的节点按顺序跑完",
    },
    "image.generate": {
        "tool": "generate_image",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "一句话出图：建提示词节点→图片节点并发起真实生成",
    },
    "video.generate": {
        "tool": "generate_video",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "一句话出视频：建提示词节点→视频节点并发起真实生成",
    },
    "batch.generate": {
        "tool": "batch_generate",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "按多维表格逐行批量出图/出视频",
    },
    "batch.run": {
        "tool": "run_batch",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "重跑已有的批量生成节点（可只指定行号）",
    },
    "template.apply": {
        "tool": "apply_template",
        "mutates": True,
        "mutates_canvas": True,
        "summary": "按流程模板在画布上搭出一整套节点并默认跑起来",
    },
    # --- 写画布外状态 -------------------------------------------------------
    "template.save": {
        "tool": "save_template",
        "mutates": True,
        "mutates_canvas": False,
        "summary": "把选中的节点连同连线存成流程模板（写资产库）",
    },
    "memory.remember": {
        "tool": "remember",
        "mutates": True,
        "mutates_canvas": False,
        "summary": "把用户要求长期记住的偏好写入项目记忆",
    },
    "memory.forget": {
        "tool": "forget",
        "mutates": True,
        "mutates_canvas": False,
        "summary": "删除一条项目记忆",
    },
    "report.write_html": {
        "tool": "write_html_report",
        "mutates": True,
        "mutates_canvas": False,
        "summary": "生成 HTML 分析报告并登记为可下载产物",
    },
    "xlsx.write": {
        "tool": "write_xlsx",
        "mutates": True,
        "mutates_canvas": False,
        "summary": "生成 Excel 数据表并登记为可下载产物",
    },
    "file.image_generate": {
        "tool": "image_generate",
        "mutates": True,
        "mutates_canvas": False,
        "summary": "按提示词真实生图并把产物登记到本次运行目录",
    },
}


# CLI 本地只读命令（不经过工具集，直接打 HTTP API）
LOCAL_COMMANDS: Dict[str, Dict] = {
    "status": {"summary": "服务地址 / 是否可达 / 画布总数 / 版本号"},
    "canvas.ls": {"summary": "列出画布（ID / 名称 / 项目 / 更新时间）"},
    "canvas.show": {"summary": "画布概要（名称、节点数、按类型分组的计数）"},
    "nodes.ls": {"summary": "逐行列出节点（ID / 类型 / 标题）"},
    "commands": {"summary": "打印本命令表并提示本期只读"},
}


def iter_commands() -> Iterator[Tuple[str, Dict]]:
    """按命令表顺序产出 (命令名, 命令定义)。"""
    for name, spec in COMMANDS.items():
        yield name, spec


def iter_local_commands() -> Iterator[Tuple[str, Dict]]:
    """按顺序产出 CLI 本地只读命令。"""
    for name, spec in LOCAL_COMMANDS.items():
        yield name, spec


def command_names() -> List[str]:
    return list(COMMANDS.keys())


def get_command(name: str) -> Optional[Dict]:
    return COMMANDS.get(str(name or "").strip())


def command_for_tool(tool: str) -> Optional[str]:
    """工具名 → 命令名（一个工具对应一条命令）。"""
    target = str(tool or "").strip()
    for name, spec in COMMANDS.items():
        if spec.get("tool") == target:
            return name
    return None


def is_write_command(name: str) -> bool:
    """命令是否会产生持久化副作用；未知命令按写操作处理（宁可拦下）。"""
    spec = get_command(name)
    if not spec:
        return True
    return bool(spec.get("mutates"))
