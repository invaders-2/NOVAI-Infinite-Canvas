#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Agent 运行时的「上下文提供者」抽象。

生产循环（main.py 的 _agent_run_producer）只依赖本基类声明的方法：
- 画布上下文 _CanvasRunContext 在 main.py 里实现，逐项复用原有画布函数，保证零回归；
- 上传文件上下文 FilesRunContext 在本模块实现，跑「上传表格 → 分析 → 出报告」链路。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import contextlib
import json
import time
from typing import Any, Dict, List, Optional, Tuple

from server.agents import registry, store, tools


class AgentRunContext:
    """上下文提供者基类：默认实现全部是安全的空操作，子类只覆盖自己关心的部分。"""

    kind = "generic"

    def __init__(self, context_id: str = ""):
        self.context_id = str(context_id or "")
        self.run_id = ""
        self.use_thread = False
        self.recent_refs: List[str] = []

    # --- 载入 ---
    def load(self) -> Any:
        return {}

    def reload(self) -> Any:
        return self.load()

    def is_available(self, snapshot: Any) -> bool:
        return isinstance(snapshot, dict)

    def unavailable_message(self) -> str:
        return "运行上下文不可用，运行已停止"

    def collect_images(self, snapshot: Any) -> List[Dict[str, Any]]:
        return []

    def pre_version(self, snapshot: Any, run_id: str):
        return None

    def begin_run(self, snapshot: Any, run_id: str, plan_mode: bool):
        return None

    def end_run(self, token) -> None:
        return None

    # --- 对话/历史 ---
    def thread_load(self) -> Dict[str, Any]:
        return {"messages": [], "recent": []}

    def thread_history(self, thread: Dict[str, Any]) -> List[Dict[str, Any]]:
        return []

    def thread_append(self, records: List[Any], touched: List[str]) -> None:
        return None

    def run_start_extra(self) -> Dict[str, Any]:
        return {}

    # --- 工具 ---
    def tools(self) -> Dict[str, Any]:
        return {}

    def tool_catalog(self) -> List[Dict[str, Any]]:
        return []

    # --- 提示词 ---
    def build_system_prompt(self, snapshot: Any, tools_json_text: str, history_text: str,
                            vision_text: str = "") -> str:
        return ""

    # --- 策略闸门 ---
    def steps_are_free(self, steps: Any) -> bool:
        return False

    def confirmation_needed(self, steps: Any, confirmed: bool = False) -> Dict[str, Any]:
        return {"needed": False, "tools": []}

    def confirm_reason(self, tool: str, args: Dict[str, Any]) -> str:
        return ""

    def step_units(self, tool: str, args: Dict[str, Any]) -> int:
        return 0

    def apply_step_defaults(self, tool: str, args: Dict[str, Any],
                            image_provider: str = "", image_model: str = "") -> None:
        return None

    # --- 执行 ---
    def execution_scope(self):
        return contextlib.nullcontext()

    def record_step(self, index: int, tool: str, description: str, ok: bool,
                    error: str = "", result: Any = None) -> None:
        return None

    def after_step(self, tool: str, args: Dict[str, Any], result: Dict[str, Any], units: int,
                   before: Any, after: Any, undo_log: Dict[str, Any]) -> Dict[str, Any]:
        return {"ops": {}, "mutated": False, "task_ids": [], "units": 0}

    def decorate_step_payload(self, payload: Dict[str, Any], ops: Dict[str, Any]) -> Dict[str, Any]:
        return payload

    # --- 会话/持久化 ---
    def new_session(self, instruction: str, focus: Dict[str, Any], mode: str) -> Dict[str, Any]:
        return {"session_id": store.new_session_id(), "created_at": time.time()}

    def save_session(self, session: Dict[str, Any]) -> None:
        return None

    def persist(self, session: Dict[str, Any], status: str, message: str, history: List[Any],
                rounds: int, steps_executed: int, mutated: bool, run_id: str, intent: str,
                instruction: str, focus: Dict[str, Any], plan: Any = None,
                used_units: int = 0) -> None:
        return None

    # --- 收尾 ---
    async def broadcast_if_mutated(self, mutated: bool, run_id: str = "") -> None:
        return None

    def cancel_pending(self, undo_log: Dict[str, Any]) -> None:
        return None

    def action_lines(self, history: List[Any], snapshot: Any) -> Tuple[List[str], List[str]]:
        return [], []

    def touched_refs(self, undo_log: Dict[str, Any], snapshot: Any) -> List[str]:
        return []

    def done_changes(self, undo_log: Dict[str, Any], used_units: int) -> Dict[str, Any]:
        return {"nodes_created": 0, "nodes_modified": 0, "nodes_deleted": 0,
                "connections": 0, "generations": 0}

    def done_extra(self, session: Dict[str, Any], undo_log: Dict[str, Any],
                   plan_payload: Any = None) -> Dict[str, Any]:
        return {}

    def artifacts(self) -> List[Dict[str, Any]]:
        return []


def _files_text(files: List[Dict[str, Any]]) -> str:
    if not files:
        return "本次没有上传文件。"
    lines = ["本次上传的文件（用 read_table 读取，name 可省略）："]
    for item in files:
        lines.append("- %s（大小 %s 字节）" % (item.get("name"), item.get("size")))
    return "\n".join(lines)


def _params_text(params: Dict[str, Any]) -> str:
    clean = {k: v for k, v in (params or {}).items() if v not in ("", None, [], {})}
    if not clean:
        return ""
    return "用户补充参数（JSON）：" + json.dumps(clean, ensure_ascii=False)


def _deliverables_text(agent: Dict[str, Any]) -> str:
    items = agent.get("deliverables") or []
    if not items:
        return "按技能要求生成交付文件。"
    return "必须生成的交付物：" + "；".join(
        "%s（%s）" % (i.get("label") or i.get("name"), i.get("kind")) for i in items)


class FilesRunContext(AgentRunContext):
    """上传文件上下文：跑「上传表格 → read_table 分析 → write_html_report/write_xlsx 出报告」。"""

    kind = "files"
    max_rounds = 10

    def __init__(self, run: Dict[str, Any], agent: Dict[str, Any],
                 files: List[Dict[str, Any]], params: Dict[str, Any]):
        super().__init__(run.get("run_id") or "")
        self.run_id = run.get("run_id") or ""
        self.run = run
        self.agent = agent
        self.files = files or []
        self.params = params or {}
        self.use_thread = False

    # --- 载入 ---
    def load(self) -> Dict[str, Any]:
        return {"files": self.files, "params": self.params, "agent_id": self.agent.get("id")}

    def reload(self) -> Dict[str, Any]:
        return self.load()

    def is_available(self, snapshot: Any) -> bool:
        return True

    # --- 工具 ---
    def tools(self) -> Dict[str, Any]:
        return tools.AGENT_FILE_TOOLS

    def tool_catalog(self) -> List[Dict[str, Any]]:
        return [{"name": name, "description": entry["description"], "schema": entry["schema"]}
                for name, entry in tools.AGENT_FILE_TOOLS.items()]

    # --- 提示词 ---
    def build_system_prompt(self, snapshot: Any, tools_json_text: str, history_text: str,
                            vision_text: str = "") -> str:
        parts = [
            "你是一个在服务端自主执行的 AI 智能体：%s。" % (self.agent.get("name") or self.agent.get("id")),
            "工作方式：每一轮你只决定「接下来做哪几步」，系统会真实执行这些步骤并把结果回灌给你；"
            "你据此决定下一轮，直到交付完成或需要收尾。",
            "可用工具清单（JSON Schema）：\n%s" % tools_json_text,
            "本次运行的输入：\n%s" % _files_text(self.files),
        ]
        params_text = _params_text(self.params)
        if params_text:
            parts.append(params_text)
        if history_text:
            parts.append(history_text)
        parts.append("下面是你必须遵循的技能说明（工作流 / 必要工具调用约定 / 输出格式）：\n"
                     "-------\n%s\n-------" % (self.agent.get("skill_prompt") or ""))
        parts.append(
            "输出要求：只返回 JSON，不要 Markdown 代码围栏，不要任何解释文字。\n"
            "1) 还要继续操作：{\"thought\": \"你的判断\", \"steps\": [{\"tool\": \"工具名\", \"args\": {...}, "
            "\"description\": \"这一步做什么（给用户看的中文短句）\"}], \"done\": false, \"message\": \"\"}\n"
            "2) 已完成或无需再操作：{\"done\": true, \"message\": \"给用户的总结（中文，说明做了什么、交付了什么文件）\"}\n"
            "3) 每轮 1-2 步。read_table 一次就会返回列名、数据行与总行数（表格很小，一次通常就是全部数据）；"
            "整个运行最多读 3 次，拿到数据后必须立刻写交付文件，不要反复读同一张表。\n"
            "4) 写 HTML 报告一律用 sections（不要用 html 直拼）：每个模块是 {title, subtitle?, body?, items?, table?}，"
            "title 必填，且必须有 body（结论文字）或 table（{columns, rows} 数据表）；模块要覆盖技能里点名的分析模块，真实数据放进 table。\n"
            "5) Excel 用 write_xlsx 的 sheets 写多张工作表（汇总统计、标签/分布统计、明细等按技能要求写全），不要只写一张汇总表。\n"
            "6) 不要把同一个 tool+args 重复提交；内容必须来自表格真实数据，不得编造；字段不足时写「数据不足」。\n"
            "7) 交付物写完后，本轮直接返回 done=true，并在 message 里说明交付了哪些文件。\n"
            "8) %s" % _deliverables_text(self.agent))
        return "\n".join(parts)

    # --- 策略闸门 ---
    def steps_are_free(self, steps: Any) -> bool:
        # 文件工具没有「花钱生成」，写产物是本次任务的正常动作，不进确认闸门
        return False

    def confirmation_needed(self, steps: Any, confirmed: bool = False) -> Dict[str, Any]:
        return {"needed": False, "tools": []}

    # --- 执行 ---
    def execution_scope(self):
        return _Scope(self.run)

    def record_step(self, index: int, tool: str, description: str, ok: bool,
                    error: str = "", result: Any = None) -> None:
        step = {"index": index, "tool": tool, "description": description, "ok": bool(ok)}
        if error:
            step["error"] = str(error)[:500]
        if isinstance(result, dict):
            for key in ("kind", "name", "url", "row_count", "columns", "sheets", "bytes"):
                if result.get(key) is not None:
                    step[key] = result[key]
        store.append_step(self.context_id, step)

    def after_step(self, tool: str, args: Dict[str, Any], result: Dict[str, Any], units: int,
                   before: Any, after: Any, undo_log: Dict[str, Any]) -> Dict[str, Any]:
        return {"ops": {}, "mutated": False, "task_ids": [], "units": 0}

    # --- 会话/持久化 ---
    def new_session(self, instruction: str, focus: Dict[str, Any], mode: str) -> Dict[str, Any]:
        return {"session_id": self.run.get("session_id") or store.new_session_id(),
                "run_id": self.context_id, "created_at": self.run.get("created_at") or time.time()}

    def save_session(self, session: Dict[str, Any]) -> None:
        if isinstance(session, dict) and session.get("session_id"):
            store.update_run(self.context_id, session_id=session["session_id"])

    def persist(self, session: Dict[str, Any], status: str, message: str, history: List[Any],
                rounds: int, steps_executed: int, mutated: bool, run_id: str, intent: str,
                instruction: str, focus: Dict[str, Any], plan: Any = None,
                used_units: int = 0) -> None:
        record = store.load_run(self.context_id) or {}
        record.update({
            "status": status,
            "message": message,
            "rounds": rounds,
            "steps_executed": steps_executed,
            "error": message if status == "failed" else "",
        })
        store.save_run(record)

    def artifacts(self) -> List[Dict[str, Any]]:
        record = store.load_run(self.context_id) or {}
        return record.get("artifacts") or []

    def done_extra(self, session: Dict[str, Any], undo_log: Dict[str, Any],
                   plan_payload: Any = None) -> Dict[str, Any]:
        return {"session_id": (session or {}).get("session_id") or "",
                "undoable": False, "artifacts": self.artifacts()}


class _Scope:
    """把「当前 run」放进 contextvar，供文件工具解析上传/产物目录。"""

    def __init__(self, run: Dict[str, Any]):
        self.run = run
        self.token = None

    def __enter__(self):
        self.token = tools.set_current_run({
            "run_id": self.run.get("run_id"),
            "uploads_dir": store.run_uploads_dir(self.run.get("run_id") or ""),
            "output_dir": store.run_output_dir(self.run.get("run_id") or ""),
            "files": self.run.get("files") or [],
        })
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.token is not None:
            tools.reset_current_run(self.token)
        return False
