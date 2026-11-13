#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上下文引擎：把「每轮重拼一段大提示词」换成「稳定前缀 + 持续增长的消息转录 + 分层预算 + 两级压缩」。

一次模型调用的消息顺序（前面的整次运行不变，利于平台的前缀缓存）：
  1. system            角色 / 规则 / 工具定义
  2. 对话历史          本对话的摘要 + 摘要之后的原文（按预算从新往旧取）
  3. 本次指令          用户这一条消息（带记忆段：项目档案、长期记忆）
  4. 运行转录          每轮「助手决策 → 执行结果」，只追加不重拼
  5. 环境状态          画布地图 / 当前注意力 / 进度——永远并在最后一条 user 消息里，每轮只换这一段

分层预算见 LAYER_CAPS；超限时先「折叠」旧的工具结果（不调模型，原文留在转录里），
还不够再请调用方用模型把最早的一段「摘要」掉。引擎本身不调模型、不读盘，全部是纯函数。
Python 3.9 约束：注解用 Optional/Dict/List。
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional, Tuple

from server.agent_core.transcript import Transcript

# 拿不到模型上下文窗口时预算按这个保守值算（只用于预算，不拿去给用户显示百分比）
DEFAULT_CONTEXT_MAX = 32000
# 各层占窗口的上限；用不完的额度不浪费——转录层可以借用前面各层没用掉的部分
LAYER_CAPS = {"memory": 0.08, "canvas": 0.15, "history": 0.25, "transcript": 0.40}
OUTPUT_RESERVE = 0.12
FOLD_AT = 0.70          # 总占用到这个比例：折叠旧工具结果（不调模型）
SUMMARY_AT = 0.85       # 折叠后仍到这个比例：需要把最早的一段转录摘要掉（调一次模型）
KEEP_RECENT_RESULTS = 4     # 最近这么多条结果默认不折叠（模型正要用）；预算压不下来时照样折
FOLD_MIN_CHARS = 240        # 比存根还短的结果折叠没意义
RESULT_RENDER_MAX_CHARS = 6000  # 单条工具结果进提示词的上限：再长的原文用 recall_step index=N 取回
HISTORY_ITEM_MAX_CHARS = 4000
STUB_PREVIEW_CHARS = 80

_CJK_RANGES = ((0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0x3000, 0x303F), (0xFF00, 0xFFEF),
               (0x3040, 0x30FF), (0xAC00, 0xD7AF), (0x20000, 0x2A6DF))


def estimate_tokens(text: Any) -> int:
    """粗估 token（与 main._agent_estimate_tokens 同口径）：CJK 1 字 1 token，其它可见字符 4 个 1 token。"""
    if text is None:
        return 0
    text = text if isinstance(text, str) else str(text)
    cjk = other = 0
    for ch in text:
        if ch.isspace():
            continue
        code = ord(ch)
        if any(low <= code <= high for low, high in _CJK_RANGES):
            cjk += 1
        else:
            other += 1
    return cjk + (other + 3) // 4


class Budget:
    """分层预算。context_max ≤ 0 = 不知道窗口大小：按保守默认算，known=False。"""

    def __init__(self, context_max: int = 0):
        try:
            value = int(context_max or 0)
        except (TypeError, ValueError):
            value = 0
        self.known = value > 0
        self.total = value if value > 0 else DEFAULT_CONTEXT_MAX

    def cap(self, layer: str) -> int:
        return int(self.total * LAYER_CAPS.get(layer, 0))

    @property
    def usable(self) -> int:
        """留出输出空间后，输入最多能用多少。"""
        return int(self.total * (1 - OUTPUT_RESERVE))


# ---------------------------------------------------------------------------
# 对话历史：摘要 + 摘要之后的原文（取代「最近 20 条」硬截断）
# ---------------------------------------------------------------------------

def select_history(messages: List[Dict[str, Any]], cap_tokens: int, summary: str = "",
                   summary_upto: int = 0) -> Dict[str, Any]:
    """从新往旧取，直到用完预算。返回 {"summary", "recent", "dropped", "tokens"}。

    summary_upto = 摘要已经覆盖到第几条消息（按 messages 下标，不含）；这些不再取原文。
    dropped = 既没被摘要覆盖、又没取进来的条数：> 0 说明该更新对话摘要了（由调用方在运行结束后做）。"""
    clean = []
    for item in messages or []:
        if not isinstance(item, dict):
            clean.append(None)       # 脏数据也占位：summary_upto 是按线程消息下标记的，不能错位
            continue
        role = str(item.get("role") or "").strip().lower()
        text = str(item.get("text") or "").strip()
        if role in ("user", "assistant") and text:
            clean.append({"role": role, "text": text[:HISTORY_ITEM_MAX_CHARS]})
        else:
            clean.append(None)       # 占位：下标要和线程里的消息对得上
    start = max(0, min(int(summary_upto or 0), len(clean)))
    summary = str(summary or "").strip() if start > 0 else ""
    used = estimate_tokens(summary)
    recent: List[Dict[str, Any]] = []
    index = len(clean) - 1
    while index >= start:
        item = clean[index]
        if item is not None:
            cost = estimate_tokens(item["text"]) + 2
            if recent and used + cost > cap_tokens:
                break
            if not recent and used + cost > cap_tokens:
                # 连最近一条都放不下：截短它，至少让模型看到上一句话
                keep = max(200, (cap_tokens - used) * 2)
                item = {"role": item["role"], "text": item["text"][:keep] + "…"}
                cost = estimate_tokens(item["text"]) + 2
            recent.append(item)
            used += cost
        index -= 1
    recent.reverse()
    dropped = len([x for x in clean[start:index + 1] if x is not None])
    return {"summary": summary, "recent": recent, "dropped": dropped, "tokens": used}


# ---------------------------------------------------------------------------
# 运行转录 → 消息
# ---------------------------------------------------------------------------

def _stub(entry: Dict[str, Any]) -> str:
    preview = " ".join(str(entry.get("text") or "").split())[:STUB_PREVIEW_CHARS]
    return "（已折叠，原文用 recall_step 取回，index=%s）%s…" % (entry.get("index"), preview)


def _result_body(text: str, index: Any) -> str:
    """单条结果的渲染上限：超出部分不进提示词，只留一句「用 recall_step 按编号取回」。
    一条 2 万字的结果整份塞进来就顶掉整个窗口，模型反而看不到后面几轮。"""
    if len(text) <= RESULT_RENDER_MAX_CHARS:
        return text
    tail = "\n…（后面还有 %d 字没显示，完整内容用 recall_step index=%s 取回）" % (
        len(text) - RESULT_RENDER_MAX_CHARS, index)
    return text[:RESULT_RENDER_MAX_CHARS] + tail


def _result_line(entry: Dict[str, Any]) -> str:
    head = "- #%s %s" % (entry.get("index"), entry.get("tool"))
    if not entry.get("ok"):
        return _result_body("%s 失败（code=%s）：%s" % (head, entry.get("code") or "", entry.get("error") or ""),
                            entry.get("index"))
    body = _stub(entry) if entry.get("folded") else str(entry.get("text") or "")
    return "%s 成功，返回：%s" % (head, _result_body(body, entry.get("index")))


def _decision_text(entry: Dict[str, Any]) -> str:
    payload: Dict[str, Any] = {}
    for key in ("thought", "intent", "reason"):
        if entry.get(key):
            payload[key] = entry[key]
    if entry.get("steps"):
        payload["steps"] = entry["steps"]
    if entry.get("done"):
        payload["done"] = True
        if entry.get("message"):
            payload["message"] = entry["message"]
    return json.dumps(payload, ensure_ascii=False)


_NOTE_LABEL = {"steer": "用户在运行中补充", "reflect": "请先反思再继续", "review": "生成结果审查",
               "system": "系统提示", "generation": "生成结果"}


def _native_call_id(seq: Any, position: int) -> str:
    """原生工具调用的 call id：由「决策序号 + 第几步」确定性生成，只要 tool 消息与它一一对应，
    OpenAI 兼容平台就接受这份历史（不需要和上游返回的 id 一致）。"""
    return "call_%s_%s" % (int(seq or 0), int(position))


def _render_native(transcript: Transcript) -> List[Dict[str, Any]]:
    """转录 → 原生工具调用的多轮消息：助手消息带 tool_calls，每条工具结果是一条 tool 消息。

    没有结果配对的步骤（步数上限打断 / 被跳过）不放进 tool_calls，改写成正文里的一句话，
    避免出现「没有人应答的 tool_call」——那会让严格校验的平台直接 400。"""
    out: List[Dict[str, Any]] = []
    summary = transcript.last_summary()
    if summary:
        out.append({"role": "user", "content": "本次运行较早的过程已整理成摘要（原始步骤结果仍可用 recall_step "
                                               "按编号取回）：\n" + str(summary.get("text") or "")})
    pending: Optional[Dict[str, Any]] = None

    def flush() -> None:
        nonlocal pending
        if pending is None:
            return
        entry, steps, results = pending["entry"], pending["steps"], pending["results"]
        matched = [False] * len(results)
        calls: List[Dict[str, Any]] = []
        responses: List[Dict[str, Any]] = []
        unrun: List[str] = []
        for position, step in enumerate(steps):
            hit = None
            for index, item in enumerate(results):
                if matched[index] or str(item.get("tool") or "") != str(step.get("tool") or ""):
                    continue
                hit = index
                break
            if hit is None:
                unrun.append(str(step.get("tool") or ""))
                continue
            matched[hit] = True
            call_id = _native_call_id(entry.get("seq"), position)
            calls.append({"id": call_id, "type": "function",
                          "function": {"name": str(step.get("tool") or ""),
                                       "arguments": json.dumps(step.get("args") or {}, ensure_ascii=False)}})
            responses.append({"role": "tool", "tool_call_id": call_id,
                              "content": _result_line(results[hit])})
        # 没有对上任何步骤的结果：不能当 tool 消息（没有配对的 tool_call），也不能丢
        orphaned = [item for index, item in enumerate(results) if not matched[index]]
        text = str(entry.get("thought") or entry.get("intent") or "").strip()
        if unrun:
            text = (text + "\n" if text else "") + "（这些步骤没有执行出结果，不要当作已完成：%s）" % "、".join(unrun[:6])
        if calls:
            out.append({"role": "assistant", "content": text, "tool_calls": calls})
            out.extend(responses)
        elif text:
            out.append({"role": "assistant", "content": text})
        if orphaned:
            out.append({"role": "user",
                        "content": "执行结果（这几步没有登记在计划里，结果照样有效）：\n"
                                   + "\n".join(_result_line(item) for item in orphaned)})
        pending = None

    for entry in transcript.visible():
        kind = entry.get("type")
        if kind == "decision":
            flush()
            steps = [s for s in (entry.get("steps") or []) if isinstance(s, dict) and s.get("tool")]
            pending = {"entry": entry, "steps": steps, "results": []}
        elif kind == "result":
            if pending is None:
                out.append({"role": "user", "content": "执行结果：\n" + _result_line(entry)})
            else:
                pending["results"].append(entry)
        elif kind == "note":
            flush()
            out.append({"role": "user",
                        "content": "%s：%s" % (_NOTE_LABEL.get(str(entry.get("kind")), "系统提示"),
                                               entry.get("text"))})
    flush()
    return out


def render_transcript(transcript: Optional[Transcript], native: bool = False) -> List[Dict[str, Any]]:
    """转录 → 这一轮要追加的消息。native=False 是交替的 assistant / user 纯文本轮次（JSON 模式）；
    native=True 用 tool 角色回传工具结果（支持原生工具调用的模型）。"""
    if transcript is None:
        return []
    if native:
        return _render_native(transcript)
    out: List[Dict[str, str]] = []

    def push(role: str, text: str) -> None:
        if not text:
            return
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n" + text      # 同角色连着出现就并成一条，保证严格交替
        else:
            out.append({"role": role, "content": text})

    summary = transcript.last_summary()
    if summary:
        push("user", "本次运行较早的过程已整理成摘要（原始步骤结果仍可用 recall_step 按编号取回）：\n"
             + str(summary.get("text") or ""))
    in_results = False          # 上一条 user 内容是不是正在列「执行结果」（是就接着列，不重复写标题）
    for entry in transcript.visible():
        kind = entry.get("type")
        if kind == "decision":
            push("assistant", _decision_text(entry))
            in_results = False
        elif kind == "result":
            push("user", _result_line(entry) if in_results else "执行结果：\n" + _result_line(entry))
            in_results = True
        elif kind == "note":
            push("user", "%s：%s" % (_NOTE_LABEL.get(str(entry.get("kind")), "系统提示"), entry.get("text")))
            in_results = False
    return out


def transcript_tokens(transcript: Optional[Transcript]) -> int:
    return sum(estimate_tokens(m["content"]) + 2 for m in render_transcript(transcript))


def _fold_until(transcript: Transcript, entries: List[Dict[str, Any]],
                target_tokens: int, current: int) -> Tuple[int, int]:
    """把 entries 里能折的从旧到新折掉，直到 current ≤ target_tokens。返回 (折了几条, 剩余 token)。"""
    folded = 0
    for entry in entries:
        if current <= target_tokens:
            break
        if entry.get("folded") or len(str(entry.get("text") or "")) < FOLD_MIN_CHARS:
            continue
        saved = estimate_tokens(entry.get("text")) - estimate_tokens(_stub(entry))
        if saved <= 0:
            continue
        if transcript.fold(int(entry.get("seq") or 0)):
            folded += 1
            current -= saved
    return folded, current


def fold_old_results(transcript: Transcript, target_tokens: int,
                     keep_recent: int = KEEP_RECENT_RESULTS) -> int:
    """从最旧的开始把工具结果折叠成存根，直到转录降到 target_tokens 以内。返回折叠了几条。不调模型。

    keep_recent 只是默认保护（模型正要用最近几条结果），不是硬保护：旧结果折完仍超预算时，
    把最近这几条从旧到新也折掉。否则「最近 4 条正好是 4 条 2 万字结果」时预算永远降不下来。"""
    visible_results = [e for e in transcript.visible() if e.get("type") == "result" and e.get("ok")]
    if keep_recent > 0:
        recent = visible_results[-keep_recent:]
        candidates = visible_results[:-keep_recent]
    else:
        recent, candidates = [], visible_results
    current = transcript_tokens(transcript)
    folded, current = _fold_until(transcript, candidates, target_tokens, current)
    if current > target_tokens:
        again, current = _fold_until(transcript, recent, target_tokens, current)
        folded += again
    return folded


def summary_cut(transcript: Transcript, keep_recent: int = KEEP_RECENT_RESULTS) -> int:
    """摘要压缩切在哪：覆盖可见条目里较早的一半，但最近 keep_recent 条结果所在的轮次必须留着。
    返回 upto_seq；0 = 没有可摘要的内容（太短，或全是最近的）。"""
    visible = transcript.visible()
    if len(visible) < 6:
        return 0
    results = [e for e in visible if e.get("type") == "result"]
    protect_from = results[-keep_recent]["seq"] if len(results) > keep_recent else None
    if protect_from is None:
        return 0
    half = visible[len(visible) // 2]["seq"]
    cut = min(int(half), int(protect_from) - 1)
    # 切点落在一轮中间会把「决策」和它的「结果」拆开：往前退到上一条结果为止
    while cut > 0:
        entry = next((e for e in visible if e.get("seq") == cut), None)
        if entry is None or entry.get("type") in ("result", "note"):
            break
        cut -= 1
    first = int(visible[0]["seq"])
    return cut if cut >= first else 0


SUMMARY_SYSTEM = (
    "你在整理一个画布助手 Agent 的运行记录，供它自己接着往下做。把下面的过程压缩成一份交接摘要，"
    "只写事实，不评价，不加记录里没有的内容。必须按这六个小标题输出（没有就写「无」）：\n"
    "【目标】用户要什么，整体方案到了哪个阶段\n"
    "【已定决策】比例 / 模型 / 风格 / 数量等已经定下的事\n"
    "【已完成】做成了什么（写节点标题和节点 id）\n"
    "【失败与原因】哪一步失败过、为什么、后来怎么处理的\n"
    "【未决事项】还没做完或等用户确认的事\n"
    "【用户纠正】用户中途改过的要求（以最后一次为准）\n"
    "节点 id、URL、数字原样保留。不超过 800 字。")


def summary_request(transcript: Transcript, upto_seq: int, instruction: str = "") -> List[Dict[str, str]]:
    """给模型的摘要请求（调用方负责真的去调）。只带 seq ≤ upto_seq 的可见条目；折叠过的结果这里用原文。"""
    lines: List[str] = []
    previous = transcript.last_summary()
    if previous:
        lines.append("更早的摘要：\n" + str(previous.get("text") or ""))
    for entry in transcript.visible():
        if int(entry.get("seq") or 0) > upto_seq:
            break
        kind = entry.get("type")
        if kind == "decision":
            lines.append("助手决策：" + _decision_text(entry)[:2000])
        elif kind == "result":
            text = str(entry.get("text") or "")[:3000] if entry.get("ok") else "失败：%s" % entry.get("error")
            lines.append("步骤 #%s %s → %s" % (entry.get("index"), entry.get("tool"), text))
        elif kind == "note":
            lines.append("%s：%s" % (_NOTE_LABEL.get(str(entry.get("kind")), "系统提示"), str(entry.get("text"))[:1000]))
    user = ("用户指令：%s\n\n" % instruction if instruction else "") + "运行记录：\n" + "\n".join(lines)
    return [{"role": "system", "content": SUMMARY_SYSTEM}, {"role": "user", "content": user}]


# ---------------------------------------------------------------------------
# 画布地图：每个节点一行；细节让模型用 read_node / search_canvas 自己读
# ---------------------------------------------------------------------------

def canvas_map(canvas: Dict[str, Any], access: Any, cap_tokens: int, focus_ids: Optional[List[str]] = None,
               recent_ids: Optional[List[str]] = None, max_nodes: int = 300,
               detail: Optional[Callable[[Dict[str, Any]], Any]] = None, max_detail: int = 12) -> str:
    """画布地图文本。focus（选中 / 引用）和 recent（最近改动）的节点给完整摘要，其余一行一个。

    access：read_tools.CanvasAccess（或接口相同的对象）。detail：节点 → 完整摘要（缺省用 access.detail）。
    超出 cap_tokens / max_nodes：先把分组的成员收进分组那一行，再截掉最远的，并写明还有多少没列。"""
    nodes = [n for n in (canvas.get("nodes") or []) if isinstance(n, dict) and n.get("id")]
    by_id = {str(n.get("id")): n for n in nodes}
    edges = access.edges(canvas)
    wanted: List[str] = []
    for nid in list(focus_ids or []) + list(recent_ids or []):
        nid = str(nid)
        if nid in by_id and nid not in wanted:
            wanted.append(nid)
    wanted = wanted[:max_detail]
    detail = detail or (lambda node: access.detail(canvas, node))
    # 首行必须带真实画布 ID：模型会把画布标题当成 canvas_id 提交（真实验收踩过，2/2 次首调都报「画布不存在」）
    head = ("画布 ID：%s｜画布「%s」：%d 个节点，%d 条连线。地图只有每个节点的一行概要；"
            "要看全文 / 提示词 / 参数用 read_node，按内容找节点用 search_canvas；"
            "工具参数里的 canvas_id 就填上面这个画布 ID，不要填标题。") % (
        canvas.get("id") or "", canvas.get("title") or canvas.get("id") or "", len(nodes), len(edges))
    parts = [head]
    used = estimate_tokens(head)
    if wanted:
        block = "重点节点（选中 / 引用 / 最近改动，完整信息）：\n" + "\n".join(
            json.dumps(detail(by_id[nid]), ensure_ascii=False) for nid in wanted)
        parts.append(block)
        used += estimate_tokens(block)
    ordered = sorted(nodes, key=lambda n: (float(n.get("y") or 0) // 200, float(n.get("x") or 0)))
    upstream_count: Dict[str, int] = {}
    for edge in edges:
        upstream_count[str(edge.get("to"))] = upstream_count.get(str(edge.get("to")), 0) + 1

    def line(node: Dict[str, Any]) -> str:
        return access.map_line(node, upstream_count.get(str(node.get("id")), 0))

    lines = [(str(n.get("id")), line(n)) for n in ordered]
    budget_left = max(0, cap_tokens - used)
    total = sum(estimate_tokens(text) + 1 for _, text in lines)
    hidden_in_groups = 0
    if total > budget_left or len(lines) > max_nodes:
        # 第一步：分组成员收进分组行（分组行本身写了成员数和种类）
        member_ids = set()
        for node in nodes:
            if str(node.get("kind") or "") == "group":
                member_ids.update(str(c) for c in (node.get("children") or []) if str(c) in by_id)
        keep = [(nid, text) for nid, text in lines if nid not in member_ids or nid in wanted]
        hidden_in_groups = len(lines) - len(keep)
        lines = keep
    shown: List[str] = []
    spent = 0
    for nid, text in lines:
        cost = estimate_tokens(text) + 1
        if len(shown) >= max_nodes or spent + cost > budget_left:
            break
        shown.append(text)
        spent += cost
    if shown:
        parts.append("节点地图（id | 种类 | 标题 | 状态 | 上游数 | 正文开头）：\n" + "\n".join(shown))
    omitted = len(lines) - len(shown)
    notes = []
    if hidden_in_groups:
        notes.append("%d 个分组成员没有单独列出（见各分组行，用 read_node 读分组可看成员）" % hidden_in_groups)
    if omitted > 0:
        notes.append("另有 %d 个节点没列出，用 search_canvas 按标题 / 内容查找" % omitted)
    if notes:
        parts.append("；".join(notes) + "。")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------

class ContextBuild:
    """一次组装的结果：messages 直接发给模型；layers / used / max 给 context_usage 事件；actions 是这次做过的压缩。"""

    def __init__(self) -> None:
        self.messages: List[Dict[str, Any]] = []
        self.layers: Dict[str, int] = {}
        self.used = 0
        self.max = 0
        self.max_known = False
        self.actions: List[Dict[str, Any]] = []
        self.needs_summary = 0      # > 0：请调用方把转录 seq ≤ 该值的部分摘要掉，再重新 assemble
        self.history_dropped = 0    # > 0：有对话原文没进上下文也没被摘要覆盖，运行结束后该更新对话摘要

    @property
    def percentage(self) -> Optional[float]:
        return round(self.used * 100.0 / self.max, 1) if (self.max_known and self.max) else None

    def usage_event(self) -> Dict[str, Any]:
        return {"used_tokens": self.used, "max_tokens": self.max if self.max_known else 0,
                "percentage": self.percentage, "source": "estimate", "layers": dict(self.layers)}


def _merge_roles(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for msg in messages:
        has_calls = bool(msg.get("tool_calls"))
        if not msg.get("content") and not has_calls:
            continue
        # tool 消息和带 tool_calls 的助手消息必须一条对一条：绝不合并
        if out and out[-1]["role"] == msg["role"] and isinstance(out[-1].get("content"), str) \
                and isinstance(msg.get("content"), str) and msg["role"] not in ("system", "tool") \
                and not has_calls and not out[-1].get("tool_calls"):
            out[-1] = {"role": msg["role"], "content": out[-1]["content"] + "\n\n" + msg["content"]}
        else:
            out.append({key: value for key, value in msg.items()})
    return out


def _message_tokens(message: Dict[str, Any]) -> int:
    """一条消息的估算开销：正文 + 原生工具调用的 JSON 参数 + 结构开销（tool_calls 参数也算 token）。"""
    total = estimate_tokens(message.get("content")) + 2
    if message.get("tool_calls"):
        total += estimate_tokens(json.dumps(message.get("tool_calls"), ensure_ascii=False))
    return total


def _trim_oldest_turns(rendered: List[Dict[str, Any]], overflow: int) -> Tuple[List[Dict[str, Any]], int]:
    """从最旧的整轮开始丢转录消息（助手带 tool_calls 的连同它的 tool 应答一起丢，不留悬空调用）。
    返回 (剩下的消息, 丢掉几轮)。被丢的原文都还在转录里，模型用 recall_step 按编号取回。"""
    out = list(rendered)
    dropped = 0
    while overflow > 0 and len(out) > 1:
        count = 1
        if out[0].get("tool_calls"):
            while count < len(out) and out[count].get("role") == "tool":
                count += 1
        overflow -= sum(_message_tokens(m) for m in out[:count])
        out = out[count:]
        dropped += 1
    return out, dropped


def assemble(system_text: str, instruction: str, transcript: Optional[Transcript] = None,
             history: Optional[List[Dict[str, Any]]] = None, thread_summary: str = "", summary_upto: int = 0,
             memory_text: str = "", canvas_text: str = "", state_text: str = "",
             context_max: int = 0, allow_fold: bool = True, native_tools: bool = False) -> ContextBuild:
    """组装这一轮发给模型的消息，并在需要时压缩旧内容。

    canvas_text 由调用方先用 canvas_map(cap_tokens=Budget.cap("canvas")) 生成；state_text 是进度 / 注意力 / 模式等每轮会变的话。
    对话历史只带 thread_summary 覆盖不到的部分（summary_upto = 线程消息下标），
    没进上下文又没被摘要覆盖的条数如实放在 history_dropped。
    返回的 needs_summary > 0 时，调用方用 summary_request → 模型 → transcript.add_summary 后再 assemble 一次。
    返回前保证 used ≤ Budget(context_max).usable：先把旧结果折叠（KEEP_RECENT_RESULTS 只是默认保护，
    压不下来时最近几条也折），再按超出量缩对话历史，最后整轮丢最旧的转录消息（原文都在转录里，
    用 recall_step 取回）。只有 system / 记忆 / 画布地图 / 指令这些固定层本身加起来已超额度时，
    才会压不进 usable（此时没有可丢的对话内容了）。"""
    budget = Budget(context_max)
    build = ContextBuild()
    build.max, build.max_known = budget.total, budget.known

    system_tokens = estimate_tokens(system_text)
    memory_text = str(memory_text or "").strip()
    memory_cap = budget.cap("memory")
    if memory_text and estimate_tokens(memory_text) > memory_cap:
        # 记忆段超限：按行从前往后保留（调用方按相关性排好序，最相关的在前）
        kept: List[str] = []
        spent = 0
        for row in memory_text.splitlines():
            cost = estimate_tokens(row) + 1
            if spent + cost > memory_cap:
                break
            kept.append(row)
            spent += cost
        memory_text = "\n".join(kept)
    memory_tokens = estimate_tokens(memory_text)

    env_parts = [p for p in (str(canvas_text or "").strip(), str(state_text or "").strip()) if p]
    env_text = ("当前环境状态（每轮更新，以这里为准）：\n" + "\n".join(env_parts)) if env_parts else ""
    instruction_text = "用户指令：" + str(instruction or "")
    if memory_text:
        instruction_text = "背景（项目档案与记忆）：\n" + memory_text + "\n\n" + instruction_text
    instruction_tokens = estimate_tokens(instruction) + estimate_tokens(state_text)
    canvas_tokens = estimate_tokens(canvas_text)
    env_tokens = estimate_tokens(env_text)

    history_cap = budget.cap("history")
    picked = select_history(history or [], history_cap, thread_summary, summary_upto)
    build.history_dropped = int(picked["dropped"])

    def build_now(rendered_now: List[Dict[str, Any]], picked_now: Dict[str, Any]):
        messages: List[Dict[str, Any]] = [{"role": "system", "content": system_text}]
        if picked_now["summary"]:
            messages.append({"role": "user", "content": "这条对话较早的内容摘要：\n" + picked_now["summary"]})
        for item in picked_now["recent"]:
            messages.append({"role": item["role"], "content": item["text"]})
        messages.append({"role": "user", "content": instruction_text})
        messages.extend(rendered_now)
        if env_text:
            messages.append({"role": "user", "content": env_text})
        merged = _merge_roles(messages)
        # 有些平台要求 system 之后第一条是 user：历史从 assistant 开头时垫一句
        if len(merged) > 1 and merged[1]["role"] == "assistant":
            merged.insert(1, {"role": "user", "content": "（接着之前的对话）"})
        layers = {
            "system": system_tokens,
            "memory": memory_tokens,
            "history": int(picked_now["tokens"]),
            "canvas": canvas_tokens,
            "transcript": sum(_message_tokens(m) for m in rendered_now),
            "instruction": instruction_tokens,
        }
        return merged, layers

    fixed = system_tokens + memory_tokens + int(picked["tokens"]) + instruction_tokens + env_tokens
    # 转录层的额度 = 自己的 40% + 前面各层没用完的部分，但总输入不超过 usable
    transcript_room = max(budget.cap("transcript"), budget.usable - fixed)
    if transcript is not None and allow_fold:
        current = transcript_tokens(transcript)
        if fixed + current > budget.total * FOLD_AT or current > transcript_room:
            target = max(0, min(transcript_room, int(budget.total * FOLD_AT) - fixed))
            folded = fold_old_results(transcript, target)
            if folded:
                after = transcript_tokens(transcript)
                build.actions.append({"level": "fold", "folded": folded, "before_tokens": fixed + current,
                                      "after_tokens": fixed + after})
                current = after
        if fixed + current > budget.total * SUMMARY_AT:
            build.needs_summary = summary_cut(transcript)

    rendered = render_transcript(transcript, native=native_tools)
    messages, layers = build_now(rendered, picked)
    used = sum(layers.values())

    # 收口 1：预算仍超 —— 连默认保护的最近几条结果也折叠（KEEP_RECENT_RESULTS 不是硬保护）
    if used > budget.usable and transcript is not None and allow_fold:
        before_tokens = used
        folded_total = 0
        for _ in range(3):
            if used <= budget.usable:
                break
            target = max(0, transcript_tokens(transcript) - (used - budget.usable))
            folded = fold_old_results(transcript, target, keep_recent=0)
            if not folded:
                break
            folded_total += folded
            rendered = render_transcript(transcript, native=native_tools)
            messages, layers = build_now(rendered, picked)
            used = sum(layers.values())
        if folded_total:
            build.actions.append({"level": "fold", "folded": folded_total, "before_tokens": before_tokens,
                                  "after_tokens": used})
        if used > budget.usable and not build.needs_summary and transcript is not None:
            build.needs_summary = summary_cut(transcript)

    # 收口 2：还超就把对话历史额度往下调（挤掉的条数如实记进 history_dropped）
    cap_try = history_cap
    for _ in range(8):
        if used <= budget.usable or not (history or []):
            break
        cap_try = max(0, cap_try - max(256, used - budget.usable + 16))
        picked = select_history(history, cap_try, thread_summary, summary_upto)
        build.history_dropped = int(picked["dropped"])
        messages, layers = build_now(rendered, picked)
        used = sum(layers.values())
        if cap_try <= 0:
            break

    # 收口 3：还超就整轮丢最旧的转录消息（原文都在转录里，用 recall_step 取回；不产生悬空 tool_call）
    if used > budget.usable and transcript is not None and allow_fold and len(rendered) > 1:
        kept_rendered, dropped_turns = _trim_oldest_turns(rendered, used - budget.usable)
        if dropped_turns:
            rendered = kept_rendered
            messages, layers = build_now(rendered, picked)
            build.actions.append({"level": "fold", "folded": 0, "dropped_turns": dropped_turns,
                                  "before_tokens": used, "after_tokens": sum(layers.values())})
            used = sum(layers.values())
            if not build.needs_summary:
                build.needs_summary = summary_cut(transcript)

    build.messages = messages
    build.layers = layers
    build.used = sum(layers.values())
    return build


def attach_images(messages: List[Dict[str, Any]], images: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把图片挂到最后一条 user 消息上（OpenAI 兼容的 content 数组）。images: [{"label", "url"}]。
    view_image 工具让模型「再看一张图」时用：图只进这一轮，不进转录（转录里只留「已查看 xx」）。"""
    images = [i for i in (images or []) if isinstance(i, dict) and i.get("url")]
    if not images:
        return messages
    out = [dict(m) for m in messages]
    for index in range(len(out) - 1, -1, -1):
        if out[index]["role"] == "user":
            parts: List[Dict[str, Any]] = [{"type": "text", "text": str(out[index]["content"])}]
            for image in images:
                parts.append({"type": "text", "text": "图片「%s」：" % (image.get("label") or "")})
                parts.append({"type": "image_url", "image_url": {"url": image["url"]}})
            out[index] = {"role": "user", "content": parts}
            break
    return out
