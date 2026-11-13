#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跨会话记忆第一层：线程摘要 + 画布项目档案 + 新对话开场注入。

三块内容：
  1) 线程摘要：自上次摘要后新增够 6 条消息才值得再摘要，按固定六段结构请模型填；
     摘要只追加在对话线程文档里（summary / summary_upto），原始消息一条不删，旧文件缺字段按空处理。
  2) 画布项目档案：把各线程摘要合并进 data/agent_memory/{画布}.profile.json，
     正文（给模型看的那几段）控制在 800 字以内。
  3) 开场注入 + 相关性：新对话第一轮注入「档案 + 上次整体方案进度 + 本对话摘要」；
     长期记忆按本次指令用关键词（中文按字符二元组）挑最相关的几条，再补最近用过的几条。

全部是纯函数 + 小读写助手，不 import main：目录、模型调用都由调用方传进来。
Python 3.9 约束：注解用 Optional/Dict/List。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional, Sequence

from server.agent_core.context_engine import Budget, estimate_tokens

# 自上次摘要后新增这么多条消息才值得再调一次模型。
# 默认 2：一次正常问答结束刚好写 2 条线程消息（用户 + 助手），6 条的话普通用户永远等不到
# 摘要 / 记忆候选卡（真机验收踩过，只能手工补历史才触发）。可用 NOVAI_AGENT_V2_SUMMARY_MIN 调。
SUMMARY_MIN_NEW_MESSAGES = 2
# 两次摘要之间至少隔这么久：摘要是一次真实模型调用，短时间连发几次运行不该把它刷爆。
# 可用 NOVAI_AGENT_V2_SUMMARY_COOLDOWN（秒，0 = 关掉冷却）调。
SUMMARY_COOLDOWN_SECONDS = 60.0
SUMMARY_MIN_ENV = "NOVAI_AGENT_V2_SUMMARY_MIN"
SUMMARY_COOLDOWN_ENV = "NOVAI_AGENT_V2_SUMMARY_COOLDOWN"
SUMMARY_MESSAGE_MAX_CHARS = 1200      # 送进摘要的单条消息截断
SUMMARY_TOTAL_MAX_CHARS = 12000       # 送进摘要的原文总量上限
PROFILE_BODY_MAX = 800                # 档案正文（给模型看的那几段）字数上限
PROFILE_INTRO_MAX = 160
PROFILE_STYLE_MAX = 240
PROFILE_PROGRESS_MAX = 120
PROFILE_NODES_MAX = 12
PROFILE_THREADS_MAX = 8
PROFILE_THREAD_LINE_MAX = 60
PROFILE_PREFS_MAX = 20               # 档案里「长期偏好」最多几条（remember 写进来的）
PROFILE_PREF_MAX = 120               # 单条偏好字数上限
NODE_SECTION_ITEM_MAX = 60           # 档案「关键素材节点」单条上限（标题 + 节点 id）
# 档案正文里各段的字数上限（「整体方案进度」也是正文的一部分）
_PROFILE_TEXT_MAX = {"intro": PROFILE_INTRO_MAX, "style": PROFILE_STYLE_MAX, "progress": PROFILE_PROGRESS_MAX}
OPENING_MAX_CHARS = 1200              # 开场注入总量上限（档案本身已压到 800 以内）
INDEX_FILENAME = "index.jsonl"       # data/agent_memory/index.jsonl：增量索引，一行一条
INDEX_TEXT_MAX = 2000                 # 单条索引正文上限（消息太长就截断，片段本来只要 200 字）
SNIPPET_MAX = 200                     # recall 返回的片段长度上限
RECALL_LIMIT_DEFAULT = 8
RECALL_LIMIT_MAX = 30
RECALL_SCOPES = ("thread", "canvas", "all")
# 出处里给用户看的来源名
SOURCE_LABEL = {"message": "对话记录", "thread_summary": "对话摘要",
                "canvas_profile": "画布档案", "long_term_memory": "长期记忆"}
_DATA_URL_RE = re.compile(r"data:[\w.+-]+/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+", re.I)
RELATED_LIMIT = 5                     # 相关性检索：命中最多取几条
RELATED_RECENT = 3                    # 再补最近用过的几条
MEMORY_LAYER = "memory"               # 记忆层在上下文引擎里的层名（8% 预算）

# 固定结构摘要：小标题顺序即提示词里的顺序，缺哪个就写「无」
SUMMARY_SECTIONS = (
    ("goal", "目标"),
    ("decisions", "已定决策"),
    ("done", "已完成"),
    ("nodes", "涉及节点"),
    ("pending", "未决事项"),
    ("corrections", "用户纠正"),
    ("candidates", "记忆候选"),
)
_SUMMARY_KEYS = tuple(key for key, _label in SUMMARY_SECTIONS)
# 模型偶尔会换个说法写标题：按关键词认
_SECTION_ALIASES = (
    ("goal", ("目标", "要做什么", "意图")),
    ("decisions", ("决策", "已定", "定了")),
    ("done", ("完成", "已做")),
    ("nodes", ("节点", "素材")),
    ("pending", ("未决", "待办", "待确认", "未完成")),
    ("corrections", ("纠正", "改过", "修改要求", "用户改")),
    ("candidates", ("记忆候选", "候选", "值得记住")),
)
SUMMARY_SYSTEM = (
    "你在给一段画布助手对话写交接摘要，供以后新开的对话接着做。只写记录里的事实，不评价，不加记录里没有的内容。"
    "必须按下面七个小标题逐条输出（没有就写「无」）：\n"
    "【目标】用户这次要做成什么\n"
    "【已定决策】比例 / 模型 / 风格 / 数量等已经定下的事\n"
    "【已完成】已经做成的阶段和产物（写节点标题，有节点 id 就带上）\n"
    "【涉及节点】这件事用到的节点，每条一行、写成「标题（节点 id）」；id 只用下面给出的真实 id，不要编\n"
    "【未决事项】还没做完、等用户确认或等结果的事\n"
    "【用户纠正】用户中途改过的要求（以最后一次为准）\n"
    "【记忆候选】这段对话里值得长期记住的偏好或规范（例如「视频一律 9:16 竖版」「口播每秒 4 个字」），"
    "每条一行，格式写成 文本｜scope｜依据（scope 只能是 canvas=只对这张画布 / global=所有画布；依据写用户哪句话或哪次纠正）；"
    "只写长期有效的偏好和规范，不写这次任务的具体内容（比如某个节点 id、某次的比例）；没有就写「无」\n"
    "节点 id、URL、数字原样保留。不超过 800 字。"
)

# 开场注入的第一条硬约束：模型会拿「画布上已经有几张图」反推「某阶段已完成」，必须明确禁止
PROGRESS_RULE = (
    "【进度判定（必须遵守）】进度只以这份档案里写的为准：档案没写完成的阶段，一律当作还没完成。"
    "画布上已有的图片 / 视频可能来自别的对话，也可能是用户自己手动做的，"
    "不要因为「画布上有 N 张图」就反推某个阶段已完成。"
)

# 「无 / 暂无 / N/A」这类占位值不是节点名：摘要写「无」时不能当成真实节点存进档案
_PLACEHOLDER_NODES = frozenset((
    "无", "暂无", "没有", "无节点", "暂无节点", "空", "无内容", "未定", "待定",
    "-", "—", "–", "/", "…", "none", "null", "n/a", "na",
))

def summary_min_messages(default: Any = None) -> int:
    """摘要阈值（新增消息数）：NOVAI_AGENT_V2_SUMMARY_MIN；没配 / 非法 / <1 用默认值。"""
    fallback = int(SUMMARY_MIN_NEW_MESSAGES if default is None else default)
    raw = os.environ.get(SUMMARY_MIN_ENV)
    if raw is None or not str(raw).strip():
        return fallback
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return fallback
    return value if value >= 1 else fallback


def summary_cooldown_seconds(default: Any = None) -> float:
    """两次摘要的最小间隔：NOVAI_AGENT_V2_SUMMARY_COOLDOWN（秒）；0 = 关掉冷却，非法 / <0 用默认值。"""
    fallback = float(SUMMARY_COOLDOWN_SECONDS if default is None else default)
    raw = os.environ.get(SUMMARY_COOLDOWN_ENV)
    if raw is None or not str(raw).strip():
        return fallback
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return fallback
    return value if value >= 0 else fallback


def summary_at(thread: Any) -> float:
    """上次写摘要的时间；旧文档没有这个字段 → 0（不设冷却门槛，免得升级后永久不摘要）。"""
    data = thread if isinstance(thread, dict) else {}
    try:
        return max(0.0, float(data.get("summary_at") or 0))
    except (TypeError, ValueError):
        return 0.0


# 记忆候选（第七段【记忆候选】）：模型只负责提，勾选后才写进长期记忆
CANDIDATE_TEXT_MAX = 200
CANDIDATE_REASON_MAX = 200
CANDIDATE_MAX = 50
CANDIDATE_SCOPE_DEFAULT = "canvas"
CANDIDATE_SCOPES = ("canvas", "global")
CANDIDATE_STATUSES = ("pending", "confirmed", "dismissed")
_CANDIDATE_PLACEHOLDER_RE = re.compile(r"^(无|暂无|没有|空|无候选|暂无候选|没有候选|none|null|n/?a|-|—|/)$", re.I)

# 真实生成工具：用来推算整体方案走到第几段（估算，不是模型自报）
GENERATION_TOOLS = ("generate_image", "generate_video", "run_generation", "batch_generate",
                    "run_batch", "lipsync_video", "generate_audio")

_CANVAS_ID_RE = re.compile(r"[^a-zA-Z0-9_-]")
PROFILE_SUFFIX = ".profile.json"
_WORD_RE = re.compile(r"[a-zA-Z0-9_]{2,}")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_SECTION_MARK_RE = re.compile(r"^\s*【\s*([^】]{1,16})\s*】")
_BULLET_RE = re.compile(r"^\s*(?:[-*•]|\d+[.、)])\s+")
# 高频虚词构成的二元组没有检索价值，滤掉免得「这个 / 我们」把无关条目排上来
_STOP_BIGRAMS = frozenset((
    "这个", "那个", "我们", "你们", "他们", "什么", "怎么", "可以", "一下", "已经",
    "就是", "还是", "然后", "需要", "不是", "没有", "这些", "那些", "现在", "如果",
))


# ---------------------------------------------------------------------------
# 关键词与相关性（纯 Python，不引依赖、不联网）
# ---------------------------------------------------------------------------

def keywords(text: Any) -> set:
    """中文按连续汉字的字符二元组、英文数字按词，返回小写集合。"""
    raw = str(text or "")
    out = set()
    for word in _WORD_RE.findall(raw):
        out.add(word.lower())
    chars = [ch for ch in raw if _CJK_RE.match(ch)]
    if len(chars) == 1:
        out.add(chars[0])
    for index in range(len(chars) - 1):
        bigram = chars[index] + chars[index + 1]
        if bigram not in _STOP_BIGRAMS:
            out.add(bigram)
    return out


def relevance(query: Any, text: Any) -> int:
    """命中数：query 的关键词里有多少个也出现在 text 里。"""
    query_tokens = query if isinstance(query, (set, frozenset)) else keywords(query)
    if not query_tokens:
        return 0
    return len(query_tokens & keywords(text))


def memory_budget(context_max: int = 0) -> int:
    """记忆层能占多少 token（与上下文引擎同一口径：窗口的 8%）。"""
    return Budget(context_max).cap(MEMORY_LAYER)


def _entry_text(entry: Any) -> str:
    if isinstance(entry, str):
        return entry.strip()
    if isinstance(entry, dict):
        for key in ("text", "summary", "one_line", "title"):
            value = entry.get(key)
            if str(value or "").strip():
                return str(value).strip()
    return ""


def select_related(query: Any, entries: Sequence[Any], budget_tokens: int,
                   limit: int = RELATED_LIMIT, recent: int = RELATED_RECENT) -> List[Dict[str, Any]]:
    """按本次指令在长期记忆里挑：命中最多的几条 + 最近用过的几条（去重），受预算约束。

    entries 顺序 = 从旧到新（最近的在后面）。返回 [{"index", "text", "score", "hit"}]，
    非空输入至少返回最新的一条（预算再紧也要让模型看到最近的记忆）。"""
    rows: List[Dict[str, Any]] = []
    for index, entry in enumerate(entries or []):
        text = _entry_text(entry)
        if text:
            rows.append({"index": index, "text": text})
    if not rows or int(budget_tokens or 0) <= 0:
        return []
    query_tokens = keywords(query)
    for row in rows:
        row["score"] = relevance(query_tokens, row["text"]) if query_tokens else 0
        row["hit"] = row["score"] > 0
    picked: List[Dict[str, Any]] = []
    seen = set()
    spent = 0

    def take(row: Dict[str, Any], force: bool = False) -> None:
        nonlocal spent
        if row["index"] in seen:
            return
        cost = estimate_tokens(row["text"]) + 1
        if not force and picked and spent + cost > budget_tokens:
            return
        seen.add(row["index"])
        picked.append({"index": row["index"], "text": row["text"],
                       "score": int(row["score"]), "hit": bool(row["hit"])})
        spent += cost

    hits = sorted([row for row in rows if row["hit"]], key=lambda row: (-row["score"], -row["index"]))
    for row in hits[:max(0, int(limit or 0))]:
        take(row)
    for row in reversed(rows[-max(0, int(recent or 0)):] if recent else []):
        take(row)
    if not picked:
        take(rows[-1], force=True)
    return picked


# ---------------------------------------------------------------------------
# 线程摘要：触发条件 / 请求 / 解析 / 写回
# ---------------------------------------------------------------------------

def _normalize_messages(messages: Sequence[Any]) -> List[Optional[Dict[str, str]]]:
    """对齐原始下标：不是「有正文的 user / assistant」就放 None 占位，summary_upto 才不会错位。"""
    out: List[Optional[Dict[str, str]]] = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            out.append(None)
            continue
        role = str(msg.get("role") or "").strip().lower()
        text = str(msg.get("text") or "").strip()
        out.append({"role": role, "text": text} if role in ("user", "assistant") and text else None)
    return out


def _upto(value: Any, upper: int) -> int:
    try:
        number = int(value or 0)
    except (TypeError, ValueError):
        number = 0
    return max(0, min(number, max(0, upper)))


def summary_state(thread: Any) -> tuple:
    """线程里的摘要状态 → (摘要文本, 覆盖到第几条)。旧文件没有这两个字段就是 ("", 0)。"""
    data = thread if isinstance(thread, dict) else {}
    return str(data.get("summary") or "").strip(), _upto(data.get("summary_upto"), 10 ** 9)


def apply_summary(thread: Any, summary: Any, upto: Any, at: Any = None) -> Any:
    """把摘要写回线程（就地，返回同一个 dict）。原文 messages 一条不动；
    空摘要不覆盖已有的，覆盖进度只增不减（避免并发写回把摘要退回旧版本）；
    同时记 summary_at，摘要冷却（NOVAI_AGENT_V2_SUMMARY_COOLDOWN）靠它算间隔。"""
    if not isinstance(thread, dict):
        return thread
    text = str(summary or "").strip()
    old_text, old_upto = summary_state(thread)
    new_upto = _upto(upto, 10 ** 9)
    if text and new_upto >= old_upto:
        thread["summary"] = text
        thread["summary_upto"] = new_upto
        try:
            thread["summary_at"] = float(at if at is not None else time.time())
        except (TypeError, ValueError):
            thread["summary_at"] = time.time()
    return thread


def should_summarize(messages: Sequence[Any], summary_upto: Any = 0,
                     min_new: int = SUMMARY_MIN_NEW_MESSAGES) -> bool:
    """自上次摘要覆盖的位置之后，新增的对话消息够不够多（默认 ≥ 6 条）。"""
    rows = _normalize_messages(messages)
    start = _upto(summary_upto, len(rows))
    fresh = len([row for row in rows[start:] if row is not None])
    return fresh >= max(1, int(min_new or 1))


def thread_should_summarize(thread: Any, min_new: Any = None, cooldown: Any = None,
                            now: Any = None) -> bool:
    """线程文档版：够条数、且距上次摘要超过冷却时间，才值得再调一次模型。

    阈值 / 冷却默认从环境变量读（NOVAI_AGENT_V2_SUMMARY_MIN / _SUMMARY_COOLDOWN），
    显式传参优先（单测用）。旧线程文档没有 summary_at → 不设冷却门槛。"""
    data = thread if isinstance(thread, dict) else {}
    limit = summary_min_messages(min_new)
    gap = summary_cooldown_seconds(cooldown)
    _summary, upto = summary_state(data)
    if not should_summarize(data.get("messages") or [], upto, limit):
        return False
    last = summary_at(data)
    if last <= 0:
        return True
    moment = float(now) if now is not None else time.time()
    return (moment - last) >= max(0.0, gap)


def summary_request(messages: Sequence[Any], summary_upto: Any = 0, previous: str = "",
                    instruction: str = "", node_hint: str = "") -> Dict[str, Any]:
    """给模型的线程摘要请求（调用方负责真的去调）。只带 summary_upto 之后的新消息；
    上一次的摘要一起带上，新摘要可以接着写而不是从零重来。

    返回 {"messages", "upto", "remaining"}：upto 是**实际送进模型的最后一条消息下标 + 1**，
    调用方写回摘要时用这个值，不要用 len(messages)——一次装不下时（SUMMARY_TOTAL_MAX_CHARS）
    后面的消息没进提示词，标成已覆盖就再也补不回来了，留给下一次。
    remaining = 这次没送进去、留到下一次的条数（不含没正文的脏行）。"""
    rows = _normalize_messages(messages)
    start = _upto(summary_upto, len(rows))
    lines: List[str] = []
    total = 0
    upto = start
    for index in range(start, len(rows)):
        row = rows[index]
        if row is None:
            continue
        line = ("用户：" if row["role"] == "user" else "助手：") + row["text"][:SUMMARY_MESSAGE_MAX_CHARS]
        if lines and total + len(line) + 1 > SUMMARY_TOTAL_MAX_CHARS:
            break
        lines.append(line)
        total += len(line) + 1
        upto = index + 1
    remaining = len([row for row in rows[upto:] if row is not None])
    parts: List[str] = []
    if str(previous or "").strip():
        parts.append("上一次的摘要（新的摘要在它基础上更新，覆盖比它更早的内容）：\n" + str(previous).strip())
    if str(instruction or "").strip():
        parts.append("用户最近一次指令：" + str(instruction).strip()[:400])
    hint = str(node_hint or "").strip()
    if hint:
        # 真实节点 id 由服务端给出（K5）：模型不许自己编，档案里每条关键节点才能带真 id
        parts.append("这段对话在画布上真实涉及过的节点（写【涉及节点】时原样用这些标题和 id）：\n"
                     + hint[:3000])
    parts.append("这段对话的内容：\n" + ("\n".join(lines) if lines else "（没有新内容）"))
    return {"messages": [{"role": "system", "content": SUMMARY_SYSTEM},
                         {"role": "user", "content": "\n\n".join(parts)}],
            "upto": upto, "remaining": remaining}


def _one_line(value: Any) -> str:
    """多行正文压成一行（档案里每条一行才好读）。"""
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _section_key(label: str) -> str:
    label = re.sub(r"[\s：:【】]", "", str(label or ""))
    for key, aliases in _SECTION_ALIASES:
        if any(alias in label for alias in aliases):
            return key
    return ""


def has_structure(text: Any) -> bool:
    """模型是不是按固定小标题返回的。不定结构的回复不写回档案（免得把一句闲聊当成项目简介）。"""
    for line in str(text or "").splitlines():
        matched = _SECTION_MARK_RE.match(_BULLET_RE.sub("", line.strip()))
        if matched and _section_key(matched.group(1)):
            return True
    return False


def parse_summary(text: Any) -> Dict[str, str]:
    """【目标】… 这种固定结构 → 各段文本（含【记忆候选】）。

    【记忆候选】是「一行一条」，行边界不能压平（压平后多条会粘成一条，候选就丢了），
    所以这一段保留换行；其余各段压成一行。标题缺失 / 顺序乱掉 / 多写一句开场白都尽量取到：
    标题之前的内容算目标；一个标题都没有时整段落到 goal，绝不丢内容。"""
    out = {key: "" for key in _SUMMARY_KEYS}
    raw = str(text or "").strip()
    if not raw:
        return out
    buckets: Dict[str, List[str]] = {}
    current = ""
    for line in raw.splitlines():
        stripped = _BULLET_RE.sub("", line.strip())
        if not stripped:
            continue
        matched = _SECTION_MARK_RE.match(stripped)
        if matched:
            key = _section_key(matched.group(1))
            rest = _BULLET_RE.sub("", stripped[matched.end():].strip(" ：:")).strip()
            if key:
                current = key
            if rest:
                buckets.setdefault(current or "goal", []).append(rest)
            continue
        buckets.setdefault(current or "goal", []).append(stripped)
    for key in out:
        rows = buckets.get(key) or []
        # 【记忆候选】【涉及节点】是一行一条：保留行边界，压平后多条会粘成一条（切出来就是碎片）
        out[key] = "\n".join(rows).strip() if key in ("candidates", "nodes") else _one_line(" ".join(rows))
    return out




def render_summary(parsed: Any) -> str:
    """parse_summary 的逆操作：按固定七段渲染回去（【涉及节点】【记忆候选】可多行）。"""
    data = parsed if isinstance(parsed, dict) else {}
    lines: List[str] = []
    for key, label in SUMMARY_SECTIONS:
        body = str(data.get(key) or "").strip() or "无"
        if key in ("candidates", "nodes") and "\n" in body:
            lines.append("【%s】" % label)
            lines.extend(line for line in body.splitlines() if line.strip())
        else:
            lines.append("【%s】%s" % (label, body))
    return "\n".join(lines)


def summary_nodes_text(nodes: Sequence[Any]) -> str:
    """真实节点清单 → 摘要【涉及节点】的正文：一行一个「标题（节点 id）」。"""
    out: List[str] = []
    for node in nodes or []:
        if isinstance(node, str):
            node = {"id": node}
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "").strip()
        if not node_id:
            continue
        title = _one_line(node.get("title"))[:60] or node_id
        line = "%s（%s）" % (title, node_id)
        if line not in out:
            out.append(line)
    return "\n".join(out)


def set_summary_nodes(summary: Any, nodes: Sequence[Any]) -> str:
    """把摘要的【涉及节点】换成真实节点（标题（节点 id）），其余各段原样保留。

    M1：节点 id 以本轮工具执行结果为准，不信模型在摘要里自己写的（它会写「无」「无节点 id」）；
    没有真实节点时原样返回，不要凭空编。"""
    text = str(summary or "")
    rows = summary_nodes_text(nodes)
    if not rows or not text.strip():
        return text
    parsed = parse_summary(text)
    parsed["nodes"] = rows
    return render_summary(parsed)


# ---------------------------------------------------------------------------
# 记忆候选：摘要第七段【记忆候选】→ [{text, scope, reason}]；只提候选，不写长期记忆
# ---------------------------------------------------------------------------

def _candidate_placeholder(value: Any) -> bool:
    """「无 / 暂无 / 没有候选」这类占位算没有候选。"""
    text = re.sub(r"\s+", "", str(value or "")).strip("。.、,，;；:：")
    return (not text) or bool(_CANDIDATE_PLACEHOLDER_RE.match(text))


def _candidate_scope(value: Any) -> str:
    """建议范围：认 global / 全局 / 所有画布 / 通用，其余一律按只对这张画布（canvas）。"""
    text = _one_line(value).lower()
    if any(word in text for word in ("global", "全局", "所有画布", "通用", "跨画布")):
        return "global"
    return CANDIDATE_SCOPE_DEFAULT


ALREADY_REMEMBERED_NOTE = "已在长期记忆里"


def _memory_key(value: Any) -> str:
    """长期记忆比对用的归一化：去掉空白与标点、英文小写（「9:16 竖版」和「9：16竖版」算同一条）。"""
    return re.sub(r"[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff]+", "", str(value or "").lower())


def already_remembered(text: Any, existing: Any) -> bool:
    """候选是否已经写进长期记忆：归一化后完全相同，或一方包含另一方（不区分标点 / 空格）。

    existing 可以是字符串列表，也可以是 memory 条目 dict 列表（取 text 字段）。"""
    key = _memory_key(text)
    if not key:
        return False
    for item in existing or []:
        other = _memory_key(item.get("text") if isinstance(item, dict) else item)
        if not other:
            continue
        if other == key or key in other or other in key:
            return True
    return False


def candidate_id(thread_id: Any, text: Any, scope: Any = CANDIDATE_SCOPE_DEFAULT) -> str:
    """候选 id：内容 + 线程的稳定 hash（重复提同一条候选不会堆第二条）。"""
    raw = "|".join([str(thread_id or ""), _one_line(text), str(scope or CANDIDATE_SCOPE_DEFAULT)])
    return "cand_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def parse_candidates(section_text: Any) -> List[Dict[str, str]]:
    """【记忆候选】段 → [{text, scope, reason}]。

    容错：缺 scope 默认 canvas、缺依据留空、超长截断、写「无」/占位 → 空列表；
    格式乱掉时整行当文本（scope 走默认），绝不抛错——候选只是顺带的，不能拖垮摘要。"""
    rows: List[Dict[str, str]] = []
    seen = set()
    for line in str(section_text or "").splitlines():
        line = _BULLET_RE.sub("", line.strip()).strip()
        if not line or _candidate_placeholder(line):
            continue
        parts = re.split(r"[｜|]", line)
        text = _one_line(parts[0])
        if _candidate_placeholder(text):
            continue
        scope = _candidate_scope(parts[1]) if len(parts) > 1 else CANDIDATE_SCOPE_DEFAULT
        reason = _one_line(parts[2])[:CANDIDATE_REASON_MAX] if len(parts) > 2 else ""
        body = text[:CANDIDATE_TEXT_MAX]
        key = (body, scope)
        if key in seen:
            continue
        seen.add(key)
        rows.append({"text": body, "scope": scope, "reason": reason})
        if len(rows) >= CANDIDATE_MAX:
            break
    return rows


def _normalize_candidate(item: Any, thread_id: Any = "", ts: Any = None) -> Dict[str, Any]:
    """单条候选收敛成线程文档里的结构；脏值返回 {}。旧文档缺字段一律按 pending 补齐。"""
    if isinstance(item, str):
        item = {"text": item}
    if not isinstance(item, dict):
        return {}
    text = _one_line(item.get("text"))[:CANDIDATE_TEXT_MAX]
    if not text:
        return {}
    scope = _candidate_scope(item.get("scope")) if str(item.get("scope") or "").strip() else CANDIDATE_SCOPE_DEFAULT
    status = str(item.get("status") or "pending").strip().lower()
    if status not in CANDIDATE_STATUSES:
        status = "pending"
    cid = str(item.get("id") or "").strip() or candidate_id(thread_id, text, scope)
    try:
        at = float(item.get("at") or ts or time.time())
    except (TypeError, ValueError):
        at = time.time()
    row = {"id": cid, "text": text, "scope": scope,
           "reason": _one_line(item.get("reason"))[:CANDIDATE_REASON_MAX],
           "status": status, "at": at}
    note = _one_line(item.get("note"))[:60]
    if note:
        row["note"] = note
    if status == "confirmed":
        try:
            row["confirmed_at"] = float(item.get("confirmed_at") or at)
        except (TypeError, ValueError):
            row["confirmed_at"] = at
    return row


def thread_candidates(thread: Any) -> List[Dict[str, Any]]:
    """线程文档里的候选（旧文档没有这个字段 → []；脏条目跳过）。"""
    rows = []
    seen = set()
    data = thread if isinstance(thread, dict) else {}
    thread_id = str(data.get("id") or "")
    for item in data.get("memory_candidates") or []:
        row = _normalize_candidate(item, thread_id)
        if row and row["id"] not in seen:
            seen.add(row["id"])
            rows.append(row)
    return rows[:CANDIDATE_MAX]


def merge_candidates(existing: Any, incoming: Any, thread_id: Any = "", ts: Any = None) -> List[Dict[str, Any]]:
    """把新解析出的候选并进已有候选：按稳定 id 去重；已有条目保留原状态（已确认 / 已忽略不会被重置成待处理）。"""
    rows: List[Dict[str, Any]] = []
    by_id: Dict[str, Dict[str, Any]] = {}
    for item in existing or []:
        row = _normalize_candidate(item, thread_id)
        if row and row["id"] not in by_id:
            by_id[row["id"]] = row
            rows.append(row)
    for item in incoming or []:
        row = _normalize_candidate(item, thread_id, ts=ts)
        if not row:
            continue
        kept = by_id.get(row["id"])
        if kept is not None:
            if row["reason"] and not kept.get("reason"):
                kept["reason"] = row["reason"]      # 同一个候选再提一次：只补依据，不动状态
            continue
        by_id[row["id"]] = row
        rows.append(row)
    rows.sort(key=lambda row: float(row.get("at") or 0))
    return rows[-CANDIDATE_MAX:]


# ---------------------------------------------------------------------------
# 整体方案进度（估算：按各阶段的生成预算扣掉真实生成次数）
# ---------------------------------------------------------------------------

def count_generations(messages: Sequence[Any]) -> int:
    """线程里成功执行过的真实生成次数（含批量 / 重跑），用来推算整体方案走到第几段。"""
    total = 0
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        steps = msg.get("steps")
        for step in steps if isinstance(steps, list) else []:
            if not isinstance(step, dict) or not step.get("ok"):
                continue
            if str(step.get("tool") or "") in GENERATION_TOOLS:
                total += 1
    return total


def _stage_row(item: Any) -> Dict[str, Any]:
    if isinstance(item, str):
        item = {"stage": item}
    if not isinstance(item, dict):
        return {}
    stage = _one_line(item.get("stage") or item.get("title") or item.get("name"))[:60]
    if not stage:
        return {}
    try:
        generations = max(0, int(float(item.get("generations") or item.get("count") or 0)))
    except (TypeError, ValueError):
        generations = 0
    return {"stage": stage, "generations": generations}


def roadmap_progress(roadmap: Sequence[Any], generations_used: int = 0) -> Dict[str, Any]:
    """整体方案停在哪一段：{"index", "total", "stage", "all_done", "text"}（没有方案 index=0）。

    每段至少算 1 次生成额度（写策划 / 分镜这种阶段不产生生成，但同样占一段），
    用已发生的生成次数从第一段开始依次扣，第一段没扣完的就是「上次停在这里」。"""
    stages = [row for row in (_stage_row(item) for item in (roadmap or [])) if row]
    total = len(stages)
    if not total:
        return {"index": 0, "total": 0, "stage": "", "all_done": False, "text": ""}
    try:
        remaining = max(0, int(generations_used or 0))
    except (TypeError, ValueError):
        remaining = 0
    for position, stage in enumerate(stages, start=1):
        cost = max(1, int(stage["generations"] or 0))
        if remaining >= cost:
            remaining -= cost
            continue
        return {"index": position, "total": total, "stage": stage["stage"], "all_done": False,
                "text": "上次停在第 %d 阶段，共 %d 阶段：%s" % (position, total, stage["stage"])}
    return {"index": total, "total": total, "stage": stages[-1]["stage"], "all_done": True,
            "text": "整体方案 %d 个阶段都已完成，最后一段：%s" % (total, stages[-1]["stage"])}


# ---------------------------------------------------------------------------
# 画布项目档案
# ---------------------------------------------------------------------------

def empty_profile(canvas_id: str = "") -> Dict[str, Any]:
    return {"canvas_id": str(canvas_id or ""), "intro": "", "style": "", "key_nodes": [],
            "prefs": [], "progress": "", "threads": [], "updated_at": 0}


def _normalize_profile(data: Any, canvas_id: str = "") -> Dict[str, Any]:
    """脏档案 / 旧档案收敛成完整结构：缺字段补空，类型不对的一律丢掉。"""
    data = data if isinstance(data, dict) else {}
    profile = empty_profile(data.get("canvas_id") or canvas_id)
    for key, limit in _PROFILE_TEXT_MAX.items():
        profile[key] = _one_line(data.get(key))[:limit]
    # 关键节点一律收敛成「标题（节点 id）」：旧档案里的「id」「（无节点」这类碎片在这里清掉
    nodes = data.get("key_nodes")
    cleaned_nodes: List[str] = []
    for item in (nodes if isinstance(nodes, (list, tuple)) else []):
        entry = node_entry(item)
        if entry and entry not in cleaned_nodes:
            cleaned_nodes.append(entry)
    profile["key_nodes"] = cleaned_nodes[:PROFILE_NODES_MAX]
    prefs = data.get("prefs")
    cleaned_prefs: List[str] = []
    for item in (prefs if isinstance(prefs, (list, tuple)) else []):
        text = _one_line(item)[:PROFILE_PREF_MAX]
        if text and text not in cleaned_prefs:
            cleaned_prefs.append(text)
    profile["prefs"] = cleaned_prefs[-PROFILE_PREFS_MAX:]
    threads = []
    for row in data.get("threads") or []:
        if not isinstance(row, dict):
            continue
        one_line = _one_line(row.get("one_line"))[:PROFILE_THREAD_LINE_MAX]
        if not one_line:
            continue
        threads.append({"id": str(row.get("id") or ""), "title": _one_line(row.get("title"))[:40],
                        "one_line": one_line, "summary": str(row.get("summary") or "")[:400],
                        "updated_at": float(row.get("updated_at") or 0)})
    profile["threads"] = threads[:PROFILE_THREADS_MAX]
    try:
        profile["updated_at"] = float(data.get("updated_at") or 0)
    except (TypeError, ValueError):
        profile["updated_at"] = 0
    return profile


def _placeholder_node(value: Any) -> bool:
    """是不是「无 / 暂无 / N/A」这类占位值（摘要里没节点时模型会这么写）。"""
    text = re.sub(r"\s+", "", str(value or "")).strip("。.、,，;；:：-—–/\\…")
    return (not text) or text.lower() in _PLACEHOLDER_NODES


# 节点条目里的噪声词：模型把表头 / 字段名 / 括号残留写进来时不能当节点。
# 「（无节点」「id」这类碎片就是这么来的（旧实现按空格和括号切，一条被切成了几段）。
_NODE_NOISE = frozenset((
    "id", "ids", "node", "nodeid", "节点", "节点id", "节点编号", "节点名称", "标题",
    "无节点", "无节点id", "（无节点", "(无节点", "（无节点id", "(无节点id", "n/a",
))
_NODE_PAREN_RE = re.compile(r"^(.*?)[（(]\s*([^（()）]{1,60})\s*[）)]$")
_NODE_ID_ATTR_RE = re.compile(r"^(?:id|节点\s*id|节点编号|node_?id)(?:\s*[=:：]\s*|\s+)(.+)$", re.I)


def _strip_entry(value: Any) -> str:
    """一条节点条目：去掉项目符号、多余空白和句末标点。"""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = _BULLET_RE.sub("", text).strip()
    return text.strip(" 。.、,，;；:：")


def _clip_entry(text: str) -> str:
    return _strip_entry(text)[:NODE_SECTION_ITEM_MAX]


def _split_outside_parens(text: Any) -> List[str]:
    """按顿号 / 逗号 / 分号分条，但括号里的分隔符不算（「海报图（i1、i2）」是一条）。"""
    out: List[str] = []
    buffer: List[str] = []
    depth = 0
    for char in str(text or ""):
        if char in "（(":
            depth += 1
        elif char in "）)":
            depth = max(0, depth - 1)
        elif char in "、，,;；" and depth == 0:
            out.append("".join(buffer))
            buffer = []
            continue
        buffer.append(char)
    out.append("".join(buffer))
    return out


def node_entry(value: Any, titles: Any = None) -> str:
    """「涉及节点」里的一条 → 「标题（节点 id）」；占位值和碎片返回空串（K5 / L4）。

    标题和节点 id 必须连成一条：不再按空格 / 括号切，所以不会再出现
    「海报图」「id」「（无节点」这种碎片。
    titles = {节点 id: 标题}（画布真实节点）：
      - 给了 titles 就只收真实画布节点（id 必须在里面），标题以画布为准；
      - 只写了 id，或只写了标题（标题能唯一对上画布节点）时补成「标题（id）」；
      - 对不上的（方案阶段名、别的对话里的旧节点）一律丢掉，不算关键节点。"""
    text = _strip_entry(value)
    if not text or _placeholder_node(text):
        return ""
    if text.lower().strip("（）()") in _NODE_NOISE:
        return ""
    matched = _NODE_PAREN_RE.match(text)
    if matched:
        title = _strip_entry(matched.group(1))
        inner = _strip_entry(matched.group(2))
        attr = _NODE_ID_ATTR_RE.match(inner)
        node_id = _strip_entry(attr.group(1) if attr else inner).strip("‘’\"' ")
        if not node_id or node_id.lower() in _NODE_NOISE or _placeholder_node(node_id):
            return _clip_entry(title) if title else ""
        if isinstance(titles, dict):
            if node_id not in titles:
                return ""       # 不是真实画布节点：方案阶段名 / 旧 id 都不收
            real = _one_line(titles.get(node_id))
            return _clip_entry("%s（%s）" % (real or title, node_id)) if (real or title) else ""
        if not title:
            return _clip_entry(node_id)
        return _clip_entry("%s（%s）" % (title, node_id))
    if isinstance(titles, dict):
        if str(text) in titles:                 # 只写了 id
            title = _one_line(titles.get(text))
            return _clip_entry("%s（%s）" % (title, text)) if title else ""
        # 只写了标题：标题唯一对上一个画布节点才算，否则不是节点
        same = [node_id for node_id, name in titles.items() if _one_line(name) == text]
        if len(same) == 1:
            return _clip_entry("%s（%s）" % (text, same[0]))
        return ""
    return _clip_entry(text)


def _node_tokens(text: Any, titles: Any = None) -> List[str]:
    """「涉及节点」→ 一条一个节点（先按行分条，行内按顿号 / 逗号 / 分号分，占位与碎片扔掉）。"""
    out: List[str] = []
    for line in str(text or "").splitlines():
        line = _strip_entry(line)
        if not line:
            continue
        for part in _split_outside_parens(line):
            entry = node_entry(part, titles)
            if entry and entry not in out:
                out.append(entry)
    return out


def merge_profile(profile: Any, thread: Any, progress_text: str = "",
                  node_titles: Any = None) -> Dict[str, Any]:
    """把一条线程的摘要并进画布档案，返回新的 profile（纯函数，不改入参）。

    node_titles = {节点 id: 标题}（画布真实节点）：摘要【涉及节点】只写了 id 时补出标题，
    最终每条关键节点都是「标题（节点 id）」，不会再出现「id」「（无节点」碎片。

    旧文件 / 旧线程都兼容：缺字段按空处理。同一条线程再次合并会覆盖它自己那一条，不会重复堆。
    项目简介、风格定调、整体方案进度都以「最近一次有内容的对话」为准，对话列表保留最近 8 条。"""
    canvas_id = (profile or {}).get("canvas_id") if isinstance(profile, dict) else ""
    data = _normalize_profile(profile or {}, canvas_id or "")
    data["canvas_id"] = str(canvas_id or "")
    summary, _upto_value = summary_state(thread or {})
    parsed = parse_summary(summary)
    if parsed["goal"]:
        data["intro"] = parsed["goal"][:PROFILE_INTRO_MAX]
    if parsed["decisions"]:
        data["style"] = parsed["decisions"][:PROFILE_STYLE_MAX]
    for token in _node_tokens(parsed["nodes"], node_titles):
        if token not in data["key_nodes"]:
            data["key_nodes"].append(token)
    data["key_nodes"] = data["key_nodes"][-PROFILE_NODES_MAX:]
    progress = _one_line(progress_text)[:PROFILE_PROGRESS_MAX]
    if progress:
        data["progress"] = progress
    if summary:
        thread_id = str((thread or {}).get("id") or "")
        row = {"id": thread_id,
               "title": _one_line((thread or {}).get("title"))[:40],
               "one_line": (parsed["goal"] or parsed["done"] or parsed["pending"] or summary)[:PROFILE_THREAD_LINE_MAX],
               "summary": summary[:400],
               "updated_at": float((thread or {}).get("updated_at") or 0)}
        data["threads"] = [item for item in data["threads"] if not thread_id or item.get("id") != thread_id]
        data["threads"].insert(0, row)
        data["threads"] = data["threads"][:PROFILE_THREADS_MAX]
        data["updated_at"] = max(float(data.get("updated_at") or 0), row["updated_at"])
    return data


def add_profile_memory(profile: Any, texts: Sequence[Any]) -> Dict[str, Any]:
    """用户说「记住 …」（remember 工具）写下的画布记忆也要进项目档案（K1）。

    按归一化文本去重（同一句发两次只留一条），保留最近 PROFILE_PREFS_MAX 条；
    返回新 profile，不改入参。"""
    data = _normalize_profile(profile or {},
                              (profile or {}).get("canvas_id") if isinstance(profile, dict) else "")
    known = [_memory_key(item) for item in data["prefs"]]
    for raw in texts or []:
        body = _one_line(raw)[:PROFILE_PREF_MAX]
        key = _memory_key(body)
        if not key or key in known:
            continue
        data["prefs"].append(body)
        known.append(key)
    data["prefs"] = data["prefs"][-PROFILE_PREFS_MAX:]
    return data


def thread_lines(profile: Any) -> List[str]:
    """档案里的「各对话一句话摘要」→ 展示行（最新的在前）。"""
    out = []
    for row in ((profile or {}).get("threads") or []):
        if not isinstance(row, dict):
            continue
        one_line = _one_line(row.get("one_line"))
        if not one_line:
            continue
        title = _one_line(row.get("title")) or "对话"
        out.append("%s：%s" % (title, one_line))
    return out


def render_profile(profile: Any, lines: Optional[Sequence[str]] = None, max_chars: int = 0) -> str:
    """档案正文（给模型看的那几段）。lines 可传入按相关性挑好的对话摘要行（缺省用全部）。"""
    data = _normalize_profile(profile or {}, (profile or {}).get("canvas_id") if isinstance(profile, dict) else "")
    text_lines: List[str] = []
    if data["intro"]:
        text_lines.append("项目简介：" + data["intro"])
    if data["style"]:
        text_lines.append("风格定调：" + data["style"])
    if data["prefs"]:
        text_lines.append("画布长期偏好（用户说过「记住」的）：" + "；".join(data["prefs"]))
    if data["key_nodes"]:
        text_lines.append("关键素材节点：" + "、".join(data["key_nodes"]))
    if data["progress"]:
        text_lines.append("整体方案进度：" + data["progress"])
    rows = [str(line) for line in (lines if lines is not None else thread_lines(data)) if str(line or "").strip()]
    if rows:
        text_lines.append("各对话做过什么：")
        text_lines.extend("- " + line for line in rows)
    text = "\n".join(text_lines)
    return text[:max_chars] if max_chars and max_chars > 0 else text


def fit_profile(profile: Any, max_chars: int = PROFILE_BODY_MAX) -> Dict[str, Any]:
    """档案正文压到 max_chars 以内：先砍最旧的对话摘要，再砍关键节点，最后缩风格 / 简介。

    只影响给模型看的那几段，不删任何对话原文（原文一直在线程文件里）。"""
    data = _normalize_profile(profile or {}, (profile or {}).get("canvas_id") if isinstance(profile, dict) else "")

    def over() -> bool:
        return len(render_profile(data)) > max_chars

    while data["threads"] and over():
        data["threads"].pop()
    while data["prefs"] and over():
        data["prefs"].pop(0)
    while data["key_nodes"] and over():
        data["key_nodes"].pop(0)
    while over() and data["style"]:
        data["style"] = data["style"][:max(0, int(len(data["style"]) * 0.7))]
    while over() and data["intro"]:
        data["intro"] = data["intro"][:max(0, int(len(data["intro"]) * 0.7))]
    while over() and data["progress"]:
        data["progress"] = data["progress"][:max(0, int(len(data["progress"]) * 0.7))]
    return data


def opening_text(profile: Any, progress_text: str = "", thread_summary: str = "",
                 lines: Optional[Sequence[str]] = None, max_chars: int = OPENING_MAX_CHARS) -> str:
    """新对话第一轮的记忆段：项目档案 + 上次整体方案进度 + 本对话摘要（都为空就返回空串）。"""
    parts: List[str] = []
    body = render_profile(profile or {}, lines=lines, max_chars=PROFILE_BODY_MAX)
    if body.strip():
        parts.append("【这张画布的项目档案】（之前对话积累下来的，接着做时用；细节以当前画布和这次指令为准）\n" + body)
    progress = _one_line(progress_text)
    if progress and progress not in body:
        parts.append(progress)      # 档案里已经写了同一条进度就不再重复
    summary = str(thread_summary or "").strip()
    if summary:
        parts.append("【本对话早先的内容摘要】\n" + summary)
    if not parts:
        return ""
    # 硬约束放最前面：这段是给模型的明确指令，不是可选提示
    return (PROGRESS_RULE + "\n\n" + "\n\n".join(parts))[:max_chars]


# ---------------------------------------------------------------------------
# 落盘：data/agent_memory/{画布}.profile.json（目录由调用方传）
# ---------------------------------------------------------------------------

def canvas_key(canvas_id: Any) -> str:
    """画布 ID → 文件名安全的形式；空 / 全是非法字符时抛 ValueError（调用方转 400）。"""
    cleaned = _CANVAS_ID_RE.sub("", str(canvas_id or ""))
    if not cleaned:
        raise ValueError("无效的画布 ID")
    return cleaned


def profile_path(base_dir: Any, canvas_id: Any) -> str:
    return os.path.join(str(base_dir or ""), canvas_key(canvas_id) + PROFILE_SUFFIX)


def load_profile(base_dir: Any, canvas_id: Any) -> Dict[str, Any]:
    """读档案；文件不存在 / 坏掉都返回空档案（旧版本没有这个文件，不能报错）。"""
    try:
        path = profile_path(base_dir, canvas_id)
    except ValueError:
        return empty_profile(canvas_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return empty_profile(canvas_id)
    except Exception as exc:
        print(f"[AgentCore] 读取画布档案失败 {canvas_id}: {exc}")
        return empty_profile(canvas_id)
    return _normalize_profile(data, canvas_id)


def save_profile(base_dir: Any, canvas_id: Any, profile: Any) -> Dict[str, Any]:
    """原子写档案（先写临时文件再替换）；写不进去抛给调用方打日志。返回真正写下的内容。"""
    path = profile_path(base_dir, canvas_id)
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    data = _normalize_profile(profile or {}, canvas_id)
    data["updated_at"] = time.time()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return data


def delete_profile(base_dir: Any, canvas_id: Any) -> bool:
    """清空档案；本来就没有返回 False。"""
    try:
        path = profile_path(base_dir, canvas_id)
    except ValueError:
        return False
    try:
        os.remove(path)
        return True
    except FileNotFoundError:
        return False

# ---------------------------------------------------------------------------
# 按画布的记忆开关（方案 §5.5「你的控制权」）
#   为什么按画布而不是全局：这三件事说的是「这张画布怎么用记忆」——长项目画布可能想关掉
#   自动摘要省模型调用，随手试的画布想全开；放全局会把一张画布的偏好强加给所有画布，
#   也没法跟「删这张画布」一起清理。文件和档案同目录：data/agent_memory/{画布}.settings.json。
#   缺省全开；读不到 / 坏文件一律按缺省（记忆功能不该因为一份设置坏了就失灵）。
# ---------------------------------------------------------------------------
SETTINGS_SUFFIX = ".settings.json"
DEFAULT_SETTINGS = {"auto_summary": True, "candidate_cards": True, "cross_canvas_recall": True}
SETTINGS_KEYS = ("auto_summary", "candidate_cards", "cross_canvas_recall")
_TRUE_WORDS = ("1", "true", "on", "yes", "开")
_FALSE_WORDS = ("0", "false", "off", "no", "关")


def normalize_settings(data: Any) -> Dict[str, bool]:
    """只认三把开关；缺字段补缺省，脏值（不认识的字符串 / 类型）按缺省处理。"""
    out = dict(DEFAULT_SETTINGS)
    if not isinstance(data, dict):
        return out
    for key in SETTINGS_KEYS:
        if key not in data:
            continue
        value = data.get(key)
        if isinstance(value, bool):
            out[key] = value
        elif isinstance(value, (int, float)):
            out[key] = bool(value)
        elif isinstance(value, str):
            word = value.strip().lower()
            if word in _TRUE_WORDS:
                out[key] = True
            elif word in _FALSE_WORDS:
                out[key] = False
    return out


def settings_path(base_dir: Any, canvas_id: Any) -> str:
    return os.path.join(str(base_dir or ""), canvas_key(canvas_id) + SETTINGS_SUFFIX)


def load_settings(base_dir: Any, canvas_id: Any) -> Dict[str, bool]:
    """读这张画布的记忆开关；文件不存在 / 坏掉都返回缺省（全开）。"""
    try:
        path = settings_path(base_dir, canvas_id)
    except ValueError:
        return dict(DEFAULT_SETTINGS)
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return dict(DEFAULT_SETTINGS)
    except Exception as exc:
        print(f"[AgentCore] 读取记忆开关失败 {canvas_id}: {exc}")
        return dict(DEFAULT_SETTINGS)
    return normalize_settings(data)


def save_settings(base_dir: Any, canvas_id: Any, settings: Any) -> Dict[str, bool]:
    """原子写这张画布的记忆开关；返回真正写下的值（脏值已被收敛成缺省）。"""
    path = settings_path(base_dir, canvas_id)
    data = normalize_settings(settings)
    data["canvas_id"] = str(canvas_id or "")
    data["updated_at"] = time.time()
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return normalize_settings(data)


def delete_settings(base_dir: Any, canvas_id: Any) -> bool:
    """删掉这张画布的记忆开关；本来就没有返回 False。"""
    try:
        path = settings_path(base_dir, canvas_id)
    except ValueError:
        return False
    try:
        os.remove(path)
        return True
    except FileNotFoundError:
        return False


# ---------------------------------------------------------------------------
# 增量检索索引：data/agent_memory/index.jsonl（一行一条，同内容按稳定 key 去重）
#   索引的是「可读文本」：线程摘要 / 画布档案 / 长期记忆 / 对话消息；
#   消息里的图片 data URL 一律换成「［图片］」，绝不把 base64 塞进索引。
# ---------------------------------------------------------------------------

def readable_text(value: Any, limit: int = INDEX_TEXT_MAX) -> str:
    """索引 / 检索用的纯文本：去掉 data URL（图片 base64）、压平空白、截断。"""
    text = str(value or "")
    text = _DATA_URL_RE.sub("［图片］", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max(0, int(limit or 0))] if limit else text


def entry_key(source: Any, canvas_id: Any = "", thread_id: Any = "", scope: Any = "", text: Any = "") -> str:
    """稳定 key = 来源 + 画布 + 线程 + 范围 + 正文的哈希：同一条内容写多少次都只留一条。"""
    raw = "|".join([str(source or ""), str(canvas_id or ""), str(thread_id or ""),
                    str(scope or ""), readable_text(text)])
    return "%s:%s" % (str(source or "memo"), hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16])


def make_entry(source: Any, text: Any, canvas_id: Any = "", canvas_title: Any = "",
               thread_id: Any = "", thread_title: Any = "", scope: Any = "",
               ts: Any = None) -> Dict[str, Any]:
    """一条索引记录。正文为空返回 {}（调用方直接跳过）。"""
    body = readable_text(text)
    if not body:
        return {}
    try:
        stamp = float(ts if ts is not None else time.time())
    except (TypeError, ValueError):
        stamp = time.time()
    source = str(source or "message").strip() or "message"
    return {
        "key": entry_key(source, canvas_id, thread_id, scope, body),
        "source": source,
        "canvas_id": str(canvas_id or ""),
        "canvas_title": _one_line(canvas_title)[:60],
        "thread_id": str(thread_id or ""),
        "thread_title": _one_line(thread_title)[:60],
        "scope": str(scope or ""),
        "ts": stamp,
        "text": body,
    }


def format_date(ts: Any) -> str:
    try:
        return time.strftime("%Y-%m-%d", time.localtime(float(ts or 0)))
    except (TypeError, ValueError, OSError):
        return ""


def format_origin(canvas_title: Any, canvas_id: Any, thread_title: Any, ts: Any) -> str:
    """出处：画布名 · 对话名 · 日期（缺哪段就跳哪段，不写空占位）。"""
    parts = [_one_line(canvas_title) or str(canvas_id or ""), _one_line(thread_title), format_date(ts)]
    return " · ".join(part for part in parts if part)


def snippet(text: Any, query: Any, limit: int = SNIPPET_MAX) -> str:
    """取命中位置前后的片段（≤ limit 字）；没有命中关键词就从开头截。"""
    body = readable_text(text, 0)
    limit = max(20, int(limit or SNIPPET_MAX))
    if len(body) <= limit:
        return body
    tokens = keywords(query)
    position = -1
    for token in tokens:
        index = body.find(token)
        if index >= 0 and (position < 0 or index < position):
            position = index
    start = 0 if position < 0 else max(0, min(position - limit // 3, len(body) - limit))
    head = "…" if start > 0 else ""
    tail = "…" if start + limit < len(body) else ""
    piece = head + body[start:start + limit] + tail
    return piece[:limit] if len(piece) > limit else piece


def search_entries(entries: Sequence[Any], query: Any, scope: str = "all", canvas_id: Any = "",
                   thread_id: Any = "", limit: int = RECALL_LIMIT_DEFAULT,
                   allowed_canvases: Optional[Sequence[Any]] = None) -> List[Dict[str, Any]]:
    """纯函数版检索：纯关键词打分（中文二元组 + 英文词），命中才返回，没有命中就是空列表。

    scope：thread=这条对话 / canvas=这张画布 / all=所有画布（受 allowed_canvases 约束）。
    allowed_canvases 给了就只保留这些画布的条目（空画布 id 的全局长期记忆始终保留）。"""
    query_text = str(query or "").strip()
    tokens = keywords(query_text)
    if not query_text or not tokens:
        return []
    scope = scope if scope in RECALL_SCOPES else "all"
    try:
        limit = max(1, min(int(limit or RECALL_LIMIT_DEFAULT), RECALL_LIMIT_MAX))
    except (TypeError, ValueError):
        limit = RECALL_LIMIT_DEFAULT
    allowed = {str(item) for item in allowed_canvases} if allowed_canvases is not None else None
    canvas_id, thread_id = str(canvas_id or ""), str(thread_id or "")
    hits: List[Dict[str, Any]] = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        text = str(entry.get("text") or "")
        if not text:
            continue
        entry_canvas, entry_thread = str(entry.get("canvas_id") or ""), str(entry.get("thread_id") or "")
        if allowed is not None and entry_canvas and entry_canvas not in allowed:
            continue
        if scope == "thread":
            if not thread_id or entry_thread != thread_id:
                continue
            if canvas_id and entry_canvas and entry_canvas != canvas_id:
                continue
        elif scope == "canvas":
            if not canvas_id or entry_canvas != canvas_id:
                continue
        score = len(tokens & keywords(text))
        if score <= 0:
            continue
        try:
            stamp = float(entry.get("ts") or 0)
        except (TypeError, ValueError):
            stamp = 0.0
        source = str(entry.get("source") or "")
        hits.append({
            "key": str(entry.get("key") or ""),
            "source": source,
            "source_label": SOURCE_LABEL.get(source, source or "记录"),
            "score": score,
            "snippet": snippet(text, query_text),
            "origin": format_origin(entry.get("canvas_title"), entry_canvas,
                                    entry.get("thread_title"), stamp),
            "canvas_id": entry_canvas,
            "canvas_title": str(entry.get("canvas_title") or ""),
            "thread_id": entry_thread,
            "thread_title": str(entry.get("thread_title") or ""),
            "date": format_date(stamp),
            "ts": stamp,
        })
    hits.sort(key=lambda item: (-item["score"], -item["ts"]))
    return hits[:limit]


_INDEX_LOCK = threading.Lock()
_INDEX_CACHE: Dict[str, Any] = {}


class MemoryIndex:
    """data/agent_memory/index.jsonl 的增量读写：追加去重 + 关键词检索。

    文件是旁路数据：读坏了跳坏行，写失败让调用方打日志，绝不拖垮对话。"""

    def __init__(self, base_dir: Any):
        self.base_dir = str(base_dir or "")
        self.path = os.path.join(self.base_dir, INDEX_FILENAME)

    def _stat_key(self) -> Any:
        try:
            stat = os.stat(self.path)
            return (int(stat.st_size), int(stat.st_mtime_ns))
        except OSError:
            return None

    def _read(self) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        if not self.path or not os.path.exists(self.path):
            return rows
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                for raw in handle:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        row = json.loads(raw)
                    except Exception:
                        continue
                    if isinstance(row, dict) and str(row.get("text") or "").strip():
                        rows.append(row)
        except OSError as exc:
            print(f"[AgentCore] 读取记忆索引失败 {self.path}: {exc}")
        return rows

    def entries(self, fresh: bool = False) -> List[Dict[str, Any]]:
        """全部条目（按文件大小 / mtime 缓存，文件变了自动重读）。"""
        stat_key = self._stat_key()
        if not fresh:
            with _INDEX_LOCK:
                cached = _INDEX_CACHE.get(self.path)
                if cached and cached[0] == stat_key:
                    return cached[1]
        rows = self._read()
        with _INDEX_LOCK:
            _INDEX_CACHE[self.path] = (stat_key, rows)
        return rows

    def add(self, entries: Sequence[Any]) -> int:
        """追加入口：同一 key 只留一条（同批内重复也算），返回真正写进去的条数。"""
        cleaned: List[Dict[str, Any]] = []
        for entry in entries or []:
            if isinstance(entry, dict) and entry.get("key") and str(entry.get("text") or "").strip():
                cleaned.append(entry)
        if not cleaned:
            return 0
        with _INDEX_LOCK:
            known = {str(row.get("key") or "") for row in self._read()}
            fresh_rows = []
            for entry in cleaned:
                key = str(entry.get("key") or "")
                if not key or key in known:
                    continue
                known.add(key)
                fresh_rows.append(entry)
            if not fresh_rows:
                return 0
            directory = os.path.dirname(self.path)
            if directory:
                os.makedirs(directory, exist_ok=True)
            with open(self.path, "a", encoding="utf-8") as handle:
                for entry in fresh_rows:
                    handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
            _INDEX_CACHE.pop(self.path, None)
            return len(fresh_rows)

    def _remove_locked(self, predicate: Any) -> int:
        """按条件删条目并重写文件（调用方已持有 _INDEX_LOCK）；返回删掉的条数。"""
        rows = self._read()
        kept = [row for row in rows if not predicate(row)]
        removed = len(rows) - len(kept)
        if not removed:
            return 0
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            for row in kept:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
        os.replace(tmp, self.path)
        _INDEX_CACHE.pop(self.path, None)
        return removed

    def remove_keys(self, keys: Sequence[Any]) -> int:
        """按 key 删条目（用户点「忘掉」时用，索引也要跟着忘）；返回删掉的条数。"""
        drop = {str(key) for key in (keys or []) if str(key or "").strip()}
        if not drop:
            return 0
        with _INDEX_LOCK:
            return self._remove_locked(lambda row: str(row.get("key") or "") in drop)

    def remove_canvas(self, canvas_id: Any) -> int:
        """删掉某张画布的全部索引条目（删画布时用，recall 不能再搜出已删画布的内容）。

        全局长期记忆条目的 canvas_id 为空串，不受影响。"""
        target = str(canvas_id or "")
        if not target:
            return 0
        with _INDEX_LOCK:
            return self._remove_locked(lambda row: str(row.get("canvas_id") or "") == target)

    def search(self, query: Any, scope: str = "all", canvas_id: Any = "", thread_id: Any = "",
               limit: int = RECALL_LIMIT_DEFAULT,
               allowed_canvases: Optional[Sequence[Any]] = None) -> List[Dict[str, Any]]:
        return search_entries(self.entries(), query, scope=scope, canvas_id=canvas_id,
                              thread_id=thread_id, limit=limit, allowed_canvases=allowed_canvases)

