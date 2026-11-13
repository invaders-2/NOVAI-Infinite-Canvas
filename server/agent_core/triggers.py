# -*- coding: utf-8 -*-
"""阶段四·2/4：画布事件策略与主动消息（纯模块，不 import main）。

四类事件：
    generation_completed  生成完成
    generation_failed     生成失败
    asset_added           拖入新素材
    canvas_opened         回到有未完成方案的画布

策略（按自治档位）：
- 生成完成：挂起的运行就唤醒（collab 唤醒后照旧出审查卡；auto / managed 审查后继续），否则不打扰；
- 生成失败：挂起的运行唤醒（进反思轮）；没有挂起运行时发一条主动消息（失败原因 + 建议的改法）；
- 拖入素材：一条主动消息 + 2-3 条建议芯片；
- 回到有未完成方案的画布：一条主动消息（上次停在哪、是否继续）。

主动消息不改画布、不花钱；节流：同一画布 5 分钟内最多 1 条（只节流主动消息，唤醒不受影响）。
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

EVENT_GENERATION_COMPLETED = "generation_completed"
EVENT_GENERATION_FAILED = "generation_failed"
EVENT_ASSET_ADDED = "asset_added"
EVENT_CANVAS_OPENED = "canvas_opened"

EVENT_TYPES = (EVENT_GENERATION_COMPLETED, EVENT_GENERATION_FAILED,
               EVENT_ASSET_ADDED, EVENT_CANVAS_OPENED)
EVENT_ALIASES = {
    "generation.completed": EVENT_GENERATION_COMPLETED,
    "generation_complete": EVENT_GENERATION_COMPLETED,
    "generation.completed_batch": EVENT_GENERATION_COMPLETED,
    "generation.failed": EVENT_GENERATION_FAILED,
    "generation_error": EVENT_GENERATION_FAILED,
    "asset.added": EVENT_ASSET_ADDED,
    "asset_dropped": EVENT_ASSET_ADDED,
    "canvas.opened": EVENT_CANVAS_OPENED,
    "canvas_returned": EVENT_CANVAS_OPENED,
}
ACTION_WAKE = "wake"
ACTION_MESSAGE = "message"
ACTION_NONE = "none"

THROTTLE_SECONDS = 300          # 同一画布 5 分钟内最多 1 条主动消息
DEFAULT_SETTINGS_KEY = "proactive_messages"

_FAILURE_FIX = ("先检查提示词里的主体 / 产品描述是否完整，再重试一次；"
                "连续失败就换个模型或降低分辨率，别用同一组参数硬重试。")
_FAILURE_WORDS = ("失败", "错误", "超时", "拒绝", "error", "failed", "timeout")


def normalize_event_type(value: Any) -> str:
    """事件类型收敛：接受下划线 / 点号 / 中文别名；不认识返回空串（路由按 noop 处理）。"""
    text = str(value or "").strip().lower().replace("-", "_")
    if text in EVENT_TYPES:
        return text
    if text in EVENT_ALIASES:
        return EVENT_ALIASES[text]
    chinese = {"生成完成": EVENT_GENERATION_COMPLETED, "生成失败": EVENT_GENERATION_FAILED,
               "拖入素材": EVENT_ASSET_ADDED, "回到画布": EVENT_CANVAS_OPENED}
    return chinese.get(text, "")


def event_node_ids(event: Any) -> List[str]:
    """事件里的 node / task id（唤醒挂起运行要用）。"""
    event = event if isinstance(event, dict) else {}
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    ids: List[str] = []

    def _add(value: Any) -> None:
        text = str(value or "").strip()
        if text and text not in ids:
            ids.append(text)

    for source in (event, payload):
        for key in ("waiting_on", "node_ids", "task_ids"):
            value = source.get(key)
            if isinstance(value, (list, tuple)):
                for item in value:
                    _add(item)
        for key in ("node_id", "task_id", "id"):
            _add(source.get(key))
    return ids


def is_throttled(last_at: Any, now: Optional[float] = None, window: float = THROTTLE_SECONDS) -> bool:
    """距上一条主动消息不足 window 秒 → 该吞掉（同画布）。last_at 为空表示没发过。"""
    try:
        last = float(last_at or 0)
    except (TypeError, ValueError):
        return False
    if last <= 0:
        return False
    current = float(now if now is not None else time.time())
    return (current - last) < float(window)


def _payload(event: Any) -> Dict[str, Any]:
    event = event if isinstance(event, dict) else {}
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    return payload


def failure_message(event: Any) -> str:
    """生成失败：失败原因 + 建议的改法（原因取自载荷，没有就写「未知原因」）。"""
    payload = _payload(event)
    reason = str(payload.get("reason") or payload.get("error") or payload.get("message") or "").strip()
    label = str(payload.get("title") or payload.get("label") or "这一步").strip()
    fix = str(payload.get("suggestion") or payload.get("fix") or "").strip() or _FAILURE_FIX
    text = f"{label}生成失败"
    if reason:
        text += f"：{reason[:300]}"
    return text + f"。建议：{fix}"


def asset_suggestions(event: Any) -> List[str]:
    """拖入素材：2-3 条可点的下一步方向。"""
    payload = _payload(event)
    assets = payload.get("assets") if isinstance(payload.get("assets"), list) else []
    names = [str((item.get("name") if isinstance(item, dict) else item) or "").strip()
             for item in assets]
    names = [name for name in names if name]
    if not names and payload.get("name"):
        names = [str(payload.get("name"))]
    lead = "「%s」" % names[0] if names else "这张素材"
    return [f"用{lead}出 2 张场景图", f"把{lead}做成 3:4 竖版海报", f"给{lead}试一版同风格变体"]


def asset_message(event: Any) -> str:
    count = len(_payload(event).get("assets") or []) or 1
    return f"收到 {count} 个新素材。要我基于它出几个方向吗？下面几条可以直接点，也可以直接说你的想法。"


def canvas_opened_message(event: Any) -> str:
    """回到有未完成方案的画布：上次停在哪 + 是否继续。"""
    payload = _payload(event)
    stage = str(payload.get("stage") or payload.get("current_stage") or "").strip()
    progress = str(payload.get("progress") or "").strip()
    text = "上次的方案还没做完"
    if stage:
        text = f"上次停在「{stage}」这一阶段"
    if progress:
        text += f"（{progress}）"
    return text + "。要继续吗？"


def canvas_opened_suggestions(event: Any) -> List[str]:
    payload = _payload(event)
    stage = str(payload.get("stage") or "").strip()
    items = ["继续上次的方案", "先看看当前画布"]
    if stage:
        items.insert(1, f"先把「{stage}」这一步做完")
    return items[:3]


class TriggerPolicy:
    """一次事件的策略判定（小类；纯逻辑，不碰画布 / 模型）。"""

    def __init__(self, autonomy: str = "collab", has_suspended_run: bool = False,
                 has_unfinished_plan: bool = False):
        self.autonomy = autonomy if autonomy in ("collab", "auto", "managed") else "collab"
        self.has_suspended_run = bool(has_suspended_run)
        self.has_unfinished_plan = bool(has_unfinished_plan)

    def decide(self, event: Any) -> Dict[str, Any]:
        event = event if isinstance(event, dict) else {}
        event_type = normalize_event_type(event.get("type"))
        decision: Dict[str, Any] = {"event": event_type, "action": ACTION_NONE,
                                    "wake": False, "notify": False, "review": False,
                                    "message": "", "suggestions": [],
                                    "throttle": False}
        if not event_type:
            return decision
        if event_type == EVENT_GENERATION_COMPLETED:
            decision["review"] = True
            if self.has_suspended_run:
                decision.update({"action": ACTION_WAKE, "wake": True})
            return decision
        if event_type == EVENT_GENERATION_FAILED:
            if self.has_suspended_run:
                decision.update({"action": ACTION_WAKE, "wake": True})
            else:
                decision.update({"action": ACTION_MESSAGE, "notify": True,
                                 "message": failure_message(event)})
            return decision
        if event_type == EVENT_ASSET_ADDED:
            decision.update({"action": ACTION_MESSAGE, "notify": True,
                             "message": asset_message(event),
                             "suggestions": asset_suggestions(event)})
            return decision
        if event_type == EVENT_CANVAS_OPENED:
            if self.has_unfinished_plan:
                decision.update({"action": ACTION_MESSAGE, "notify": True,
                                 "message": canvas_opened_message(event),
                                 "suggestions": canvas_opened_suggestions(event),
                                 "throttle": True})
            return decision
        return decision


def build_message(decision: Dict[str, Any], canvas_id: str, now: Optional[float] = None) -> Dict[str, Any]:
    """策略结果 → 主动消息对象（写线程 / 发 SSE / HTTP 返回共用这一种形状）。"""
    decision = decision if isinstance(decision, dict) else {}
    stamp = float(now if now is not None else time.time())
    return {
        "role": "assistant",
        "origin": "agent",
        "canvas_id": str(canvas_id or ""),
        "event": str(decision.get("event") or ""),
        "text": str(decision.get("message") or ""),
        "suggestions": list(decision.get("suggestions") or []),
        "at": stamp,
    }
