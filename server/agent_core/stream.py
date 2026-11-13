#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenAI 兼容 SSE 流式增量解析（阶段三·1，纯函数，不 import main）。

只做解析：调用方把上游 SSE 的文本片段喂进来（切在半行 / 多行都行），拿到结构化的增量，
自己决定怎么下发。三类增量：

  reasoning   推理内容（delta.reasoning_content，兼容 delta.reasoning）
  content     正文（delta.content）
  tool_call   工具调用：名字先到（一条 tool_call）；参数随后分片到达，本类负责跨 chunk 拼接，
              收齐后补一条 tool_done（带解析好的 args，调用方据此取 description）
  tool_done   某个工具调用的参数已经收齐（finish_reason 出现 / finish() 时各补一次，幂等）

用法：
    parser = StreamParser()
    for text in chunks:                     # 上游原样文本，切在哪都行
        for delta in parser.feed(text):
            handle(delta)
    for delta in parser.finish():
        handle(delta)
    raw = parser.raw()                      # 与非流式 /chat/completions 返回同形，可直接复用决策解析

Python 3.9 约束：注解用 Optional/Dict/List。
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

# 结构化增量的类型
DELTA_REASONING = "reasoning"
DELTA_CONTENT = "content"
DELTA_TOOL_CALL = "tool_call"
DELTA_TOOL_DONE = "tool_done"

# C6：模型写在正文里的思考段落（兼容 <thinking>）
_THINK_OPEN_TAGS = ("<think>", "<thinking>")
_THINK_CLOSE_TAGS = ("</think>", "</thinking>")


def text_from_fragment(value: Any) -> str:
    """思考 / 正文片段：字符串直接返回；数组按元素拼；dict 取 text/content。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: List[str] = []
        for item in value:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            elif isinstance(item, str):
                parts.append(item)
        return "".join(parts)
    if isinstance(value, dict):
        return str(value.get("text") or value.get("content") or "")
    return str(value)


def arguments_text(value: Any) -> str:
    """工具参数片段：字符串原样；dict / 其它按 JSON 序列化（个别平台直接给对象）。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def parse_arguments(text: Any) -> Dict[str, Any]:
    """工具参数原文 → dict；空 / 坏 JSON / 不是对象一律返回 {}（调用方只看能不能取到字段）。"""
    if isinstance(text, dict):
        return text
    raw = str(text or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _call_id(index: int, given: Any = "") -> str:
    """工具调用 id：上游给了就用，没给就按序号确定性生成（同一次流里稳定）。"""
    text = str(given or "").strip()
    return text or "call_stream_%d" % int(index or 0)


class StreamParser:
    """把上游 SSE 文本片段解析成结构化增量。finish() 幂等，流结束调用一次即可。"""

    def __init__(self) -> None:
        self._buffer = ""
        self._done = False
        self._finish_reason = ""
        self._content: List[str] = []
        self._reasoning: List[str] = []
        self._calls: Dict[int, Dict[str, Any]] = {}
        self._order: List[int] = []
        self._finalized: Dict[int, bool] = {}
        # C6：<think>/<thinking> 段落跨分片也要处理对——用状态机把正文拆成「正文 / 推理」两路
        self._think_open = False
        self._think_buffer = ""

    # --- 状态（只读） -----------------------------------------------------
    @property
    def content(self) -> str:
        return "".join(self._content)

    @property
    def reasoning(self) -> str:
        return "".join(self._reasoning)

    @property
    def done(self) -> bool:
        return self._done

    @property
    def finish_reason(self) -> str:
        return self._finish_reason

    @property
    def tool_calls(self) -> List[Dict[str, Any]]:
        return [self._calls[index] for index in self._order]

    # --- 喂数据 -----------------------------------------------------------
    def feed(self, text: Any) -> List[Dict[str, Any]]:
        """喂一段文本（可以半行），返回这次能确定解析出来的增量列表。"""
        out: List[Dict[str, Any]] = []
        if text is None:
            return out
        self._buffer += str(text)
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            out.extend(self._handle_line(line))
        return out

    def finish(self) -> List[Dict[str, Any]]:
        """流结束：把最后半行 / 未闭合的 think 段处理掉，并给还没收尾的工具调用补 tool_done。"""
        out: List[Dict[str, Any]] = []
        if self._buffer.strip():
            out.extend(self._handle_line(self._buffer))
        self._buffer = ""
        if self._think_buffer:
            if self._think_open:
                self._append_reasoning(self._think_buffer, out)
            else:
                self._append_content(self._think_buffer, out)
            self._think_buffer = ""
        out.extend(self._finalize_calls())
        return out

    # --- 组装 -------------------------------------------------------------
    def message(self) -> Dict[str, Any]:
        """拼成非流式 choices[0].message 的形状（content / reasoning_content / tool_calls）。"""
        message: Dict[str, Any] = {"role": "assistant", "content": self.content}
        if self._reasoning:
            message["reasoning_content"] = self.reasoning
        calls: List[Dict[str, Any]] = []
        for index in self._order:
            slot = self._calls[index]
            if not slot.get("name"):
                continue
            calls.append({"id": _call_id(index, slot.get("id")),
                          "type": "function",
                          "function": {"name": slot["name"],
                                       "arguments": slot.get("arguments") or "{}"}})
        if calls:
            message["tool_calls"] = calls
        return message

    def raw(self) -> Dict[str, Any]:
        """与非流式 /chat/completions 返回同形的 raw，直接喂给现有的决策解析。"""
        return {"choices": [{"index": 0, "message": self.message(),
                             "finish_reason": self._finish_reason or "stop"}]}

    # --- 内部 -------------------------------------------------------------
    def _handle_line(self, line: Any) -> List[Dict[str, Any]]:
        text = str(line or "").rstrip("\r")
        stripped = text.strip()
        if not stripped or stripped.startswith(":") or stripped.startswith("event:") or stripped.startswith("id:"):
            return []
        if stripped.startswith("data:"):
            stripped = stripped[len("data:"):].strip()
        if not stripped:
            return []
        if stripped == "[DONE]":
            self._done = True
            return []
        try:
            chunk = json.loads(stripped)
        except Exception:
            return []
        return self._handle_chunk(chunk)

    def _handle_chunk(self, chunk: Any) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        if not isinstance(chunk, dict):
            return out
        choices = chunk.get("choices")
        if not isinstance(choices, list) or not choices:
            return out
        choice = choices[0] if isinstance(choices[0], dict) else {}
        delta = choice.get("delta")
        delta = delta if isinstance(delta, dict) else {}

        reasoning = ""
        for field in ("reasoning_content", "reasoning"):
            if field in delta:
                reasoning = text_from_fragment(delta.get(field))
                if reasoning:
                    break
        if reasoning:
            self._reasoning.append(reasoning)
            out.append({"type": DELTA_REASONING, "text": reasoning})

        if "content" in delta:
            content = text_from_fragment(delta.get("content"))
            if content:
                # C6：正文里的 <think>…</think> 转成 reasoning，绝不进 message_delta；
                # 标签可能被拆在多个分片里，所以这里走增量状态机。
                out.extend(self._consume_content(content))

        for call in delta.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            try:
                index = int(call.get("index") or 0)
            except (TypeError, ValueError):
                index = 0
            slot = self._calls.get(index)
            if slot is None:
                slot = {"id": "", "name": "", "arguments": ""}
                self._calls[index] = slot
                self._order.append(index)
            if call.get("id") and not slot["id"]:
                slot["id"] = str(call.get("id"))
            function = call.get("function")
            function = function if isinstance(function, dict) else {}
            name = str(function.get("name") or "")
            if name and not slot["name"]:
                slot["name"] = name
                out.append({"type": DELTA_TOOL_CALL, "index": index,
                            "id": _call_id(index, slot["id"]), "name": name})
            arguments = arguments_text(function.get("arguments"))
            if arguments:
                slot["arguments"] += arguments

        finish_reason = choice.get("finish_reason")
        if finish_reason:
            self._finish_reason = str(finish_reason)
            out.extend(self._finalize_calls())
        return out

    # --- C6：正文 / 推理分流 -------------------------------------------------
    def _append_content(self, text: Any, out: List[Dict[str, Any]]) -> None:
        text = str(text or "")
        if not text:
            return
        self._content.append(text)
        out.append({"type": DELTA_CONTENT, "text": text})

    def _append_reasoning(self, text: Any, out: List[Dict[str, Any]]) -> None:
        text = str(text or "")
        if not text:
            return
        self._reasoning.append(text)
        out.append({"type": DELTA_REASONING, "text": text})

    @staticmethod
    def _partial_tag_tail(text: str, tags: Any) -> str:
        """text 末尾可能是某个标签的前缀（如 "<thi"）时返回这段尾巴，先别当正文吐出去。"""
        best = ""
        for tag in tags:
            for size in range(1, len(tag)):
                if text.endswith(tag[:size]) and size > len(best):
                    best = tag[:size]
        return best

    def _consume_content(self, text: Any) -> List[Dict[str, Any]]:
        """把一段正文按 <think> / <thinking> 状态机切成 content / reasoning 增量。"""
        self._think_buffer += str(text or "")
        out: List[Dict[str, Any]] = []
        while self._think_buffer:
            buffer = self._think_buffer
            if self._think_open:
                hits = [(buffer.find(tag), tag) for tag in _THINK_CLOSE_TAGS if buffer.find(tag) >= 0]
                if hits:
                    index, tag = min(hits, key=lambda item: item[0])
                    self._append_reasoning(buffer[:index], out)
                    self._think_buffer = buffer[index + len(tag):]
                    self._think_open = False
                    continue
                tail = self._partial_tag_tail(buffer, _THINK_CLOSE_TAGS)
                self._append_reasoning(buffer[:len(buffer) - len(tail)] if tail else buffer, out)
                self._think_buffer = tail
                break
            hits = [(buffer.find(tag), tag) for tag in _THINK_OPEN_TAGS if buffer.find(tag) >= 0]
            if hits:
                index, tag = min(hits, key=lambda item: item[0])
                self._append_content(buffer[:index], out)
                self._think_buffer = buffer[index + len(tag):]
                self._think_open = True
                continue
            tail = self._partial_tag_tail(buffer, _THINK_OPEN_TAGS)
            self._append_content(buffer[:len(buffer) - len(tail)] if tail else buffer, out)
            self._think_buffer = tail
            break
        return out

    def _finalize_calls(self) -> List[Dict[str, Any]]:
        """给还没收尾的工具调用补 tool_done（每个调用只补一次）。"""
        out: List[Dict[str, Any]] = []
        for index in self._order:
            if self._finalized.get(index):
                continue
            slot = self._calls[index]
            if not slot.get("name"):
                continue
            self._finalized[index] = True
            arguments = slot.get("arguments") or ""
            out.append({"type": DELTA_TOOL_DONE, "index": index,
                        "id": _call_id(index, slot.get("id")), "name": slot["name"],
                        "arguments": arguments, "args": parse_arguments(arguments)})
        return out


def parse_stream_text(text: Any) -> Dict[str, Any]:
    """一次性解析整段 SSE 文本 → {"deltas": [...], "raw": {...}}（单测 / 调试方便）。"""
    parser = StreamParser()
    deltas = parser.feed(text)
    deltas.extend(parser.finish())
    return {"deltas": deltas, "raw": parser.raw()}
