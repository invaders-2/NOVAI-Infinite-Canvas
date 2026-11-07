#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOVAI 思考强度（think_level）真值源 + 上游参数映射（厂商文档 + APIMart 实测）。

证据来源
--------
1. docs/apimart-docs/VENDOR-REASONING.md（task-11，各厂商官方文档原文）；
2. docs/apimart-docs/REPORT.md（task-1，APIMart 自身文档）；
3. /tmp/novai-apimart-probe/（task-12 实测：APIMart 网关对 reasoning_effort / thinking 的真实响应）。

核心原则
--------
* **UI 显示几档 = 上游真能区分的几档**：能映射但落回同一档的，不显示成两个选项。
  完整 5 档只有 OpenAI gpt-5.6+/gpt-6+ 与 GLM-5.2；其余族 2~4 档。
* 同一 canonical 键（low/mid/high/xhigh/max）在不同族发不同 wire 值（见 *_EFFORT_WIRE）。
* 请求档位若不在该模型支持集合里（历史数据/前端旧值），先收敛到最接近的支持档再发，避免无谓 400。
* Claude：Anthropic 兼容层把 reasoning_effort 标 Ignored，APIMart 实测透传后 400；thinking 对象在
  /chat/completions 上无生效证据（实测无 thinking 内容块）。所以 **Claude 继续不显示入口**，
  只在将来的 /v1/messages 分支里走 thinking budget（think_request_fields(body_style="anthropic")）。
* DeepSeek-R1 / GLM-4.x / Kimi-K2.x / Qwen3.6~3.7 等只有思考开关、没有强度档位 -> 不下发。
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

# 档位键与前端 web/src/pages/chat/thought.js、main.py THINK_LEVELS_FULL 保持一致，不要改名。
THINK_LEVELS: Tuple[str, ...] = ("low", "mid", "high", "xhigh", "max")
THINK_LEVEL_RANK: Dict[str, int] = {level: index for index, level in enumerate(THINK_LEVELS)}
THINK_LEVEL_LABELS: Dict[str, str] = {
    "low": "低", "mid": "中", "high": "高", "xhigh": "极高", "max": "Max",
}

EVIDENCE_DOCUMENTED = "documented"
EVIDENCE_INFERRED = "inferred"
EVIDENCE_FIXED = "fixed"


def _levels(*values: str) -> Tuple[str, ...]:
    return tuple(values)


# ── 各族 wire 映射（canonical 键 -> 上游实际取值）────────────────────────────────
# OpenAI：文档枚举 none/minimal/low/medium/high/xhigh/max，我们不用 none/minimal，5 档直映。
OPENAI_EFFORT_WIRE: Dict[str, str] = {
    "low": "low", "mid": "medium", "high": "high", "xhigh": "xhigh", "max": "max",
}
# OpenAI 老 ID（官方已无模型页）：沿用 task-2 的保守映射，四档
# low→minimal、mid→low、high→medium、xhigh→high（max 收敛到 high）。
OPENAI_LEGACY_EFFORT_WIRE: Dict[str, str] = {
    "low": "minimal", "mid": "low", "high": "medium", "xhigh": "high", "max": "high",
}
# Gemini OpenAI 兼容层：只有 minimal/low/medium/high -> xhigh/max 收敛到 high（历史数据兜底）。
GEMINI_EFFORT_WIRE: Dict[str, str] = {
    "low": "low", "mid": "medium", "high": "high", "xhigh": "high", "max": "high",
}
# DeepSeek V4：low/high/max；mid/xhigh 没有独立档 -> 收敛（medium->high、xhigh->high）。
DEEPSEEK_EFFORT_WIRE: Dict[str, str] = {
    "low": "low", "mid": "high", "high": "high", "xhigh": "high", "max": "max",
}
# Qwen3.8：low/medium/xhigh；canonical high 与 max 都落 xhigh。
QWEN_EFFORT_WIRE: Dict[str, str] = {
    "low": "low", "mid": "medium", "high": "xhigh", "xhigh": "xhigh", "max": "xhigh",
}
# Kimi K3：low/high/max；mid/xhigh 收敛到 high。
KIMI_EFFORT_WIRE: Dict[str, str] = {
    "low": "low", "mid": "high", "high": "high", "xhigh": "high", "max": "max",
}
# GLM-5.3：只有 low/high/max；mid/xhigh 收敛到 high。
GLM53_EFFORT_WIRE: Dict[str, str] = {
    "low": "low", "mid": "high", "high": "high", "xhigh": "high", "max": "max",
}
# GLM-5.2：max/xhigh/high/medium/low/minimal/none -> 5 档直映。
GLM52_EFFORT_WIRE: Dict[str, str] = dict(OPENAI_EFFORT_WIRE)

# 档位 -> Anthropic thinking.budget_tokens（VENDOR-REASONING §4.3 的推断值；
# 硬约束 1024 <= budget < max_tokens，超了上游 400，由调用方的 400 降级兜底）。
ANTHROPIC_THINKING_BUDGET_BY_LEVEL: Dict[str, int] = {
    "low": 1024, "mid": 4096, "high": 8192, "xhigh": 16384, "max": 32768,
}

# ── 真值源：显式「模型名（小写） -> 档位数组」+ 证据标注 ───────────────────────
# capability = 文档是否确证支持思考；levels = 档位集合是否有文档依据。
_FIVE = THINK_LEVELS
_FOUR = _levels("low", "mid", "high", "xhigh")
_THREE = _levels("low", "mid", "high")
_THREE_LHM = _levels("low", "high", "max")
_PRO_THREE = _levels("mid", "high", "xhigh")

THINK_MODEL_LEVELS: Dict[str, Tuple[str, ...]] = {
    # OpenAI（VENDOR-REASONING §2.1 / §4.1，Lead task-12 指令）
    "gpt-5.6-luna": _FIVE, "gpt-5.6-sol": _FIVE, "gpt-5.6-terra": _FIVE,
    "gpt-6-astra": _FIVE, "gpt-6-luna": _FIVE, "gpt-6-sol": _FIVE,
    "gpt-6.1-sol": _FIVE, "gpt-6.1-terra": _FIVE,
    "gpt-5.2": _FOUR, "gpt-5.4": _FOUR, "gpt-5.4-mini": _FOUR, "gpt-5.5": _FOUR,
    "gpt-5.4-pro": _PRO_THREE, "gpt-5.5-pro": _PRO_THREE, "gpt-5.2-codex": _PRO_THREE,
    # 老 ID：保守 4 档 + 老 wire 映射（官方已无模型页）
    "gpt-5": _FOUR, "gpt-5.1": _FOUR, "gpt-5-mini": _FOUR, "gpt-5-chat-latest": _FOUR,
    "gpt-5.1-codex": _FOUR, "gpt-5.1-codex-max": _FOUR, "gpt-5.1-codex-mini": _FOUR,
    "gpt-5.3-codex": _FOUR,
    # Gemini（VENDOR-REASONING §2.2；-thinking 别名沿用基础模型的档位）
    "gemini-3-pro-preview": _levels("low", "high"),
    "gemini-3-pro-preview-thinking": _levels("low", "high"),
    "gemini-3.1-pro-preview": _THREE, "gemini-3.1-pro-preview-thinking": _THREE,
    "gemini-3-flash-preview": _THREE, "gemini-3-flash-preview-thinking": _THREE,
    "gemini-3.6-flash": _THREE, "gemini-3.5-flash": _THREE, "gemini-3.5-flash-lite": _THREE,
    "gemini-3.1-flash-lite-preview": _THREE, "gemini-4-argon": _THREE,
    "gemini-2.5-pro": _THREE, "gemini-2.5-flash": _THREE, "gemini-2.5-flash-lite": _THREE,
    # DeepSeek V4（§4.4；旧 R1/V3 只有开关/不可用，不进表）
    "deepseek-v4-pro": _THREE_LHM, "deepseek-v4-flash": _THREE_LHM, "deepseek-flash": _THREE_LHM,
    # Qwen3.8（§4.5；canonical high wire 到 xhigh，所以 UI 三档是 低/中/高）
    "qwen3.8-max": _THREE, "qwen3.8-max-0902": _THREE, "qwen3.8-flash": _THREE,
    "qwen3.8-2.4t-a95b": _THREE, "qwen3.8-27b": _THREE,
    # Kimi K3（§4.6）
    "kimi-k3": _THREE_LHM, "kimi-k3.1-pro": _THREE_LHM,
    # GLM（§4.7）
    "glm-5.2": _FIVE, "glm-5.3": _THREE_LHM, "glm-5.3-flash": _THREE_LHM,
    "glm-5.3-flashx": _THREE_LHM,
}

# 显式证据：capability / levels 分开标（默认 documented；老 ID 与别名标 inferred）。
THINK_MODEL_EVIDENCE: Dict[str, Dict[str, str]] = {
    model: {"capability": EVIDENCE_DOCUMENTED, "levels": EVIDENCE_DOCUMENTED}
    for model in THINK_MODEL_LEVELS
}
for _old in ("gpt-5", "gpt-5.1", "gpt-5-mini", "gpt-5-chat-latest",
             "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.3-codex",
             "gpt-5.2-codex"):
    # OpenAI 已无这些老 ID 的模型页；按同族保守裁剪（文档没写 -> inferred）
    THINK_MODEL_EVIDENCE[_old] = {"capability": EVIDENCE_INFERRED, "levels": EVIDENCE_INFERRED}
for _alias in ("gemini-3-pro-preview-thinking", "gemini-3.1-pro-preview-thinking",
               "gemini-3-flash-preview-thinking"):
    # 别名模型沿用基础模型档位，别名本身文档没写 -> 档位 inferred
    THINK_MODEL_EVIDENCE[_alias] = {"capability": EVIDENCE_INFERRED, "levels": EVIDENCE_INFERRED}
for _inferred in ("deepseek-v4-flash", "glm-5.3-flash", "glm-5.3-flashx"):
    THINK_MODEL_EVIDENCE[_inferred] = {"capability": EVIDENCE_INFERRED, "levels": EVIDENCE_INFERRED}

# 明确「没有强度档位」的模型（只有开关或完全不支持）。命中优先于族规则，避免伪造档位。
THINK_MODEL_NO_THINK: Tuple[str, ...] = (
    # OpenAI：5.2-pro 仅 Responses API；非推理模型
    "gpt-5.2-pro", "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    # Gemini：明确关闭思考的别名
    "gemini-3-flash-preview-nothinking",
    # DeepSeek：R1/V3 系列只有开关 / 当前 APIMart 账号不可用
    "deepseek-ocr",
    # Kimi：K2.x 只有 thinking 开关
    "kimi-k2-thinking",
)

# 族规则（只在显式表之后兜底；证据：capability / levels）
THINK_MODEL_PATTERNS: Tuple[Tuple["re.Pattern[str]", Tuple[str, ...], str, str], ...] = (
    # OpenAI o 系列：官方支持 reasoning_effort，但本轮调研文档没逐档写 -> 3 档 inferred
    (re.compile(r"^o[1-9](?:[.\-]|$)"), _THREE, EVIDENCE_INFERRED, EVIDENCE_INFERRED),
    # OpenAI gpt-5.2/5.4/5.5（显式表没覆盖的变体，如 -chat-latest）：4 档
    (re.compile(r"^gpt-5\.[245](?:[.\-]|$)(?!.*codex)"), _FOUR,
     EVIDENCE_DOCUMENTED, EVIDENCE_INFERRED),
    # OpenAI gpt-5.6 / gpt-6 / gpt-6.1（含 -pro 变体）：5 档
    (re.compile(r"^gpt-(?:5\.6|6)(?:[.\-]|$)"), _FIVE, EVIDENCE_DOCUMENTED, EVIDENCE_INFERRED),
    # Gemini 通用兜底：3 档（3-pro-preview 两档显式表已覆盖；-nothinking 走 no-think）
    (re.compile(r"^gemini[-_.]"), _THREE, EVIDENCE_DOCUMENTED, EVIDENCE_INFERRED),
    # DeepSeek V4 变体（v4.1-flash 等）：3 档
    (re.compile(r"^deepseek[-_]v4(?:[.\-]|$)"), _THREE_LHM, EVIDENCE_DOCUMENTED, EVIDENCE_INFERRED),
    # Qwen3.8 变体：3 档
    (re.compile(r"^qwen3\.8(?:[.\-]|$)"), _THREE, EVIDENCE_DOCUMENTED, EVIDENCE_INFERRED),
    # Kimi K3 变体：3 档
    (re.compile(r"^kimi[-_]k3(?:[.\-]|$)"), _THREE_LHM, EVIDENCE_DOCUMENTED, EVIDENCE_INFERRED),
    # GLM-5.2 / 5.3 变体
    (re.compile(r"^glm[-_]5\.2(?:[.\-]|$)"), _FIVE, EVIDENCE_DOCUMENTED, EVIDENCE_INFERRED),
    (re.compile(r"^glm[-_]5\.3(?:[.\-]|$)"), _THREE_LHM, EVIDENCE_DOCUMENTED, EVIDENCE_INFERRED),
)

# 明确「只有开关、没有强度」的族规则（在族规则之后判定，防止被上面宽泛 pattern 命中）。
THINK_MODEL_NO_THINK_PATTERNS: Tuple["re.Pattern[str]", ...] = (
    re.compile(r"^deepseek[-_]?(?:r1|v3)"),          # R1/V3 只有开关
    re.compile(r"^kimi[-_]k2"),                       # K2.x 只有 thinking 开关
    re.compile(r"^glm[-_]4(?:[.\-]|$)"),            # GLM-4.x 只有 thinking 开关
    re.compile(r"^glm[-_]5(?:[.\-]|$)"),            # GLM-5 / 5.1：无 reasoning_effort
    re.compile(r"^qwen(?:3\.[67]|-turbo)"),          # 只有 qwen3.8 有文档依据
    re.compile(r"^gemini[-_.].*nothinking$"),         # 明确关闭思考的别名
    re.compile(r"^gpt-5\.2-pro$"),                   # Responses API only
)

# OpenAI 老 ID 使用保守 wire（low→minimal 等）；分族 wire 之外的单模型覆盖。
_OPENAI_LEGACY_WIRE_KEYS: Tuple[str, ...] = (
    "gpt-5", "gpt-5.1", "gpt-5-mini", "gpt-5-chat-latest",
    "gpt-5.1-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.3-codex",
)

# Anthropic：兼容层 reasoning_effort = Ignored（实测 APIMart 透传后 400），/chat/completions 的
# thinking 对象也无生效证据 -> 本仓库继续不给 Claude 入口；只在 body_style="anthropic"
# （将来的 /v1/messages 分支）用 thinking budget。
THINK_ANTHROPIC_MODEL_PATTERNS: Tuple["re.Pattern[str]", ...] = (re.compile(r"^claude[-_.]"),)


def _model_key(name: Any) -> str:
    return str(name or "").strip().lower()


def normalize_think_level(value: Any) -> str:
    """请求里的 think_level 归一：空 / 非法值一律返回空串（= 不发上游字段）。"""
    text = _model_key(value)
    return text if text in THINK_LEVELS else ""


def think_model_family(model: Any) -> str:
    """模型族判定：决定用哪套 wire 映射。"""
    key = _model_key(model)
    if key.startswith("claude"):
        return "anthropic"
    if key.startswith("gemini") or "gemini" in key:
        return "gemini"
    if key.startswith("deepseek"):
        return "deepseek"
    if key.startswith("qwen"):
        return "qwen"
    if key.startswith("kimi"):
        return "kimi"
    if key.startswith("glm"):
        return "glm"
    if key.startswith("gpt-") or re.match(r"^o[1-9](?:[.\-]|$)", key):
        return "openai"
    return ""


def is_anthropic_think_model(model: Any) -> bool:
    return any(pattern.search(_model_key(model)) for pattern in THINK_ANTHROPIC_MODEL_PATTERNS)


def _explicitly_no_think(key: str) -> bool:
    if key in THINK_MODEL_NO_THINK:
        return True
    return any(pattern.search(key) for pattern in THINK_MODEL_NO_THINK_PATTERNS)


def _resolve_levels(key: str) -> Tuple[Tuple[str, ...], str, str]:
    """按「显式表 > 显式否定 > 族规则」解析；(levels, capability_evidence, levels_evidence)。"""
    levels = THINK_MODEL_LEVELS.get(key)
    if levels:
        evidence = THINK_MODEL_EVIDENCE.get(key) or {"capability": EVIDENCE_DOCUMENTED,
                                                     "levels": EVIDENCE_DOCUMENTED}
        return levels, evidence.get("capability", EVIDENCE_DOCUMENTED), evidence.get("levels", EVIDENCE_DOCUMENTED)
    if _explicitly_no_think(key):
        return (), "", ""
    for pattern, pattern_levels, capability, level_evidence in THINK_MODEL_PATTERNS:
        if pattern.search(key):
            return pattern_levels, capability, level_evidence
    return (), "", ""


def think_levels_for_model(name: Any) -> Optional[List[str]]:
    """模型在 OpenAI 兼容 / APIMart 链路上能展示的档位；不支持返回 None。

    Claude 返回 None：兼容层 reasoning_effort 被忽略、thinking 无生效证据（见模块头）。
    """
    key = _model_key(name)
    if not key:
        return None
    levels, _capability, _levels_evidence = _resolve_levels(key)
    return list(levels) if levels else None


def think_model_evidence(name: Any) -> Dict[str, str]:
    """真值源证据：{"capability": documented/inferred/"", "levels": documented/inferred/fixed/""}。"""
    key = _model_key(name)
    if not key:
        return {"capability": "", "levels": ""}
    if is_anthropic_think_model(key):
        # 能力文档确证（thinking budget），但 chat 兼容层不可用 -> 不给入口
        return {"capability": EVIDENCE_DOCUMENTED, "levels": ""}
    _levels_value, capability, levels_evidence = _resolve_levels(key)
    return {"capability": capability, "levels": levels_evidence}


def effort_wire_value(model: Any, level: str) -> str:
    """canonical 键 -> 该族实际下发的 reasoning_effort 取值。"""
    text = normalize_think_level(level)
    if not text:
        return ""
    family = think_model_family(model)
    key = _model_key(model)
    if family == "gemini":
        return GEMINI_EFFORT_WIRE[text]
    if family == "deepseek":
        return DEEPSEEK_EFFORT_WIRE[text]
    if family == "qwen":
        return QWEN_EFFORT_WIRE[text]
    if family == "kimi":
        return KIMI_EFFORT_WIRE[text]
    if family == "glm":
        wire = GLM53_EFFORT_WIRE if ("glm-5.3" in key or "glm-5-3" in key) else GLM52_EFFORT_WIRE
        return wire[text]
    if family == "openai" and key in _OPENAI_LEGACY_WIRE_KEYS:
        return OPENAI_LEGACY_EFFORT_WIRE[text]
    return OPENAI_EFFORT_WIRE[text]


def _clamp_level_to_model(model: Any, level: str) -> str:
    """请求档位不在该模型支持集合里时，收敛到最接近的支持档（优先向下，避免偷偷加价）。"""
    levels = think_levels_for_model(model) or []
    if not levels or level in levels:
        return level
    target = THINK_LEVEL_RANK.get(level)
    if target is None:
        return ""
    best = None
    for candidate in levels:
        rank = THINK_LEVEL_RANK.get(candidate)
        if rank is None:
            continue
        score = (abs(rank - target), 0 if rank <= target else 1)
        if best is None or score < best[0]:
            best = (score, candidate)
    return best[1] if best else ""


def think_transport(protocol: Any, model: Any, body_style: str = "openai") -> str:
    """返回该协议 + 模型应该用哪套推理参数；空串 = 不发字段。"""
    proto = _model_key(protocol)
    style = _model_key(body_style) or "openai"
    if proto in {"codex", "gemini-cli", "lovart", "runninghub", "jimeng"}:
        return ""
    if style == "anthropic":
        return "anthropic_thinking" if is_anthropic_think_model(model) else ""
    if style != "openai":
        return ""
    key = _model_key(model)
    levels, _capability, _levels_evidence = _resolve_levels(key)
    if not levels:
        return ""
    if is_anthropic_think_model(key):
        return ""      # Claude 在 OpenAI 兼容体里没有可生效字段（继续不给入口）
    return "reasoning_effort"


def think_request_fields(protocol: Any, model: Any, think_level: Any,
                         body_style: str = "openai") -> Dict[str, Any]:
    """集中映射：返回要并进上游请求体的字段；空 dict 表示什么都不发。"""
    level = normalize_think_level(think_level)
    if not level:
        return {}
    transport = think_transport(protocol, model, body_style)
    if transport == "reasoning_effort":
        clamped = _clamp_level_to_model(model, level)
        wire = effort_wire_value(model, clamped)
        return {"reasoning_effort": wire} if wire else {}
    if transport == "anthropic_thinking":
        return {"thinking": {"type": "enabled",
                             "budget_tokens": ANTHROPIC_THINKING_BUDGET_BY_LEVEL[level]}}
    return {}


# 上游 400 时用来判断「是不是这几个推理字段被拒」的关键词；命中才不带参重试，
# 其它 400（模型名错、余额不足）必须原样报错，不能被吞成「重试一次」。
_THINK_REJECT_HINTS = (
    "reasoning_effort", "reasoning effort", "reasoning", "thinking", "budget_tokens",
    "budget tokens", "thinkingbudget", "thinking budget", "unknown field",
    "unsupported parameter", "unsupported_parameter", "extra fields", "unrecognized",
)


def think_fields_rejected(status_code: Any, body_text: Any) -> bool:
    """上游 400 且报错文本指向推理参数 -> True（调用方应去掉这些字段重试一次）。"""
    try:
        code = int(status_code)
    except (TypeError, ValueError):
        return False
    if code != 400:
        return False
    text = str(body_text or "").lower()
    if not text:
        return False
    return any(hint in text for hint in _THINK_REJECT_HINTS)


def strip_think_fields(body: Dict[str, Any], think_fields: Dict[str, Any]) -> Dict[str, Any]:
    """复制一份去掉推理字段的请求体（重试用）。"""
    clean = dict(body or {})
    for key in (think_fields or {}):
        clean.pop(key, None)
    return clean
