#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次运行的完整转录：模型每轮的决策、每个工具步骤的结果原文、插话 / 反思 / 摘要。

和原来的 history 列表（每条结果压成 1500 字摘要）不同，这里保留原文并逐条落盘：
- 上下文紧张时可以把旧结果「折叠」成一行存根，原文还在，模型用 recall_step 取回；
- 更紧张时把最早的一段总结成摘要（summary 条目），被覆盖的条目不再进提示词，但文件里一条不删；
- 进程重启后可以从 jsonl 恢复（阶段四的挂起 / 唤醒要用）。

文件格式：{dir}/{run_id}.jsonl，一行一个 JSON。条目行带 seq；折叠是追加一行 {"op": "fold", "seq": N}。
Python 3.9 约束：注解用 Optional/Dict/List。
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict, List, Optional

# 单条结果落盘的上限：再大的工具输出也不该整份进转录（原始产物在画布 / 文件里）
RESULT_TEXT_MAX = 200000
_RUN_ID_RE = re.compile(r"[^a-zA-Z0-9_-]")


def result_text(value: Any, limit: int = RESULT_TEXT_MAX) -> str:
    """工具返回值 → 文本（dict / list 按 JSON，其它按 str）。"""
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = str(value)
    return text if len(text) <= limit else text[:limit] + "…（已截断）"


class Transcript:
    """运行转录。base_dir 为空时只在内存里（单测 / 不需要恢复的场景）。"""

    def __init__(self, run_id: str = "", base_dir: Optional[str] = None):
        self.run_id = _RUN_ID_RE.sub("", str(run_id or ""))
        self.base_dir = base_dir if (base_dir and self.run_id) else None
        self.entries: List[Dict[str, Any]] = []
        self._seq = 0
        self._step = 0

    # --- 落盘 ---
    @property
    def path(self) -> Optional[str]:
        return os.path.join(self.base_dir, self.run_id + ".jsonl") if self.base_dir else None

    def _write(self, line: Dict[str, Any]) -> None:
        path = self.path
        if not path:
            return
        try:
            os.makedirs(self.base_dir, exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False, default=str) + "\n")
        except Exception as exc:      # 转录写不进去不能让运行失败
            print(f"[AgentCore] 转录落盘失败 {self.run_id}: {exc}")

    def _add(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        self._seq += 1
        entry = dict(entry, seq=self._seq, at=entry.get("at") or time.time())
        self.entries.append(entry)
        self._write(entry)
        return entry

    @classmethod
    def load(cls, run_id: str, base_dir: str) -> "Transcript":
        """从 jsonl 恢复；坏行跳过（半行写入不该让整次恢复失败）。"""
        tr = cls(run_id, base_dir)
        path = tr.path
        if not path or not os.path.exists(path):
            return tr
        by_seq: Dict[int, Dict[str, Any]] = {}
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    line = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(line, dict):
                    continue
                if line.get("op") == "fold":
                    hit = by_seq.get(int(line.get("seq") or 0))
                    if hit is not None:
                        hit["folded"] = True
                    continue
                seq = int(line.get("seq") or 0)
                if seq <= 0:
                    continue
                by_seq[seq] = line
                tr.entries.append(line)
                tr._seq = max(tr._seq, seq)
                if line.get("type") == "result":
                    tr._step = max(tr._step, int(line.get("index") or 0))
        return tr

    # --- 追加 ---
    def add_decision(self, round_no: int, decision: Dict[str, Any]) -> Dict[str, Any]:
        """模型这一轮的决策（只留给模型自己回看有用的字段，不存原生推理）。"""
        decision = decision if isinstance(decision, dict) else {}
        steps = []
        for step in decision.get("steps") or []:
            if isinstance(step, dict) and step.get("tool"):
                steps.append({"tool": str(step.get("tool")), "args": step.get("args") or {},
                              "description": str(step.get("description") or "")[:300]})
        entry = {"type": "decision", "round": int(round_no or 0), "steps": steps}
        for key in ("thought", "intent", "reason", "message"):
            text = str(decision.get(key) or "").strip()
            if text:
                entry[key] = text[:2000]
        if decision.get("done"):
            entry["done"] = True
        return self._add(entry)

    def add_result(self, round_no: int, tool: str, args: Any, ok: bool, result: Any = None,
                   error: str = "", code: str = "", description: str = "") -> Dict[str, Any]:
        """一个工具步骤的结果。index 是运行内的步骤编号（从 1 起），recall_step 用它取回原文。"""
        self._step += 1
        entry = {"type": "result", "round": int(round_no or 0), "index": self._step, "tool": str(tool or ""),
                 "args": args if isinstance(args, dict) else {}, "ok": bool(ok),
                 "text": result_text(result) if ok else "", "description": str(description or "")[:300]}
        if not ok:
            entry["error"] = str(error or "")[:2000]
            entry["code"] = str(code or "")
        return self._add(entry)

    def add_note(self, kind: str, text: str, round_no: int = 0) -> Optional[Dict[str, Any]]:
        """循环注入的话：steer（用户插话）/ reflect（反思提示）/ review（审查结论）/ system（刹车、自检打回）。"""
        text = str(text or "").strip()
        if not text:
            return None
        return self._add({"type": "note", "kind": str(kind or "system"), "round": int(round_no or 0), "text": text[:8000]})

    def add_summary(self, upto_seq: int, text: str) -> Optional[Dict[str, Any]]:
        """把 seq ≤ upto_seq 的条目总结成一段摘要：之后渲染时这些条目不再出现，只出现摘要。"""
        text = str(text or "").strip()
        upto_seq = int(upto_seq or 0)
        if not text or upto_seq <= 0:
            return None
        return self._add({"type": "summary", "upto": upto_seq, "text": text[:12000]})

    # --- 折叠 / 取回 ---
    def fold(self, seq: int) -> bool:
        for entry in self.entries:
            if entry.get("seq") == seq and entry.get("type") == "result" and not entry.get("folded"):
                entry["folded"] = True
                self._write({"op": "fold", "seq": seq})
                return True
        return False

    def step(self, index: int) -> Optional[Dict[str, Any]]:
        """按步骤编号取结果原文（折叠 / 被摘要覆盖的也取得到）。"""
        try:
            index = int(index)
        except (TypeError, ValueError):
            return None
        for entry in self.entries:
            if entry.get("type") == "result" and entry.get("index") == index:
                return entry
        return None

    # --- 视图 ---
    def last_summary(self) -> Optional[Dict[str, Any]]:
        for entry in reversed(self.entries):
            if entry.get("type") == "summary":
                return entry
        return None

    def visible(self) -> List[Dict[str, Any]]:
        """进提示词的条目：最后一条摘要之后的内容（摘要本身由渲染方单独放在最前）。"""
        summary = self.last_summary()
        if not summary:
            return [e for e in self.entries if e.get("type") != "summary"]
        upto = int(summary.get("upto") or 0)
        return [e for e in self.entries if e.get("type") != "summary" and int(e.get("seq") or 0) > upto]

    def results(self) -> List[Dict[str, Any]]:
        return [e for e in self.entries if e.get("type") == "result"]

    @property
    def steps_executed(self) -> int:
        return self._step
