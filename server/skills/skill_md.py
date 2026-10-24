#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SKILL.md 解析 / 序列化（Agent Skills 开放规范的最小实现，零依赖）。

格式：
    ---
    name: my-skill            # ≤64，只能 [a-z0-9-_]，必须等于文件/目录名
    description: 一句话说明      # ≤1024，必填
    license: MIT              # 可选
    compatibility: ...        # 可选
    metadata:                 # 可选，字典（值可以是字符串、数字、布尔或字符串数组）
      key: value
    allowed-tools:            # 可选，字符串数组
      - read_table
    ---
    正文（技能的完整说明，导入后作为 skill_prompt）

这里只实现 YAML 的一个安全子集：顶层 key: value、一层嵌套 map、字符串数组、| / > 块标量。
不引 PyYAML（零新依赖），也不执行任何代码。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")
MAX_DESCRIPTION = 1024
MAX_BODY_BYTES = 200 * 1024
MAX_MARKDOWN_BYTES = 1024 * 1024
FRONTMATTER_RE = re.compile(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?(.*)$", re.S)

_DESCRIPTION_KEY = "description"
_ALLOWED_KEYS = ("name", "description", "license", "compatibility", "metadata", "allowed-tools")


class SkillMdError(ValueError):
    """SKILL.md 不合法（消息直接给用户看）。"""


def _strip_scalar(value: str) -> str:
    text = str(value).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        inner = text[1:-1]
        if text[0] == '"':
            try:
                return json.loads(text)
            except Exception:
                return inner
        return inner.replace("''", "'")
    return text


def _looks_like_list(lines: List[str]) -> bool:
    items = [line for line in lines if line.strip()]
    return bool(items) and all(line.lstrip().startswith("- ") for line in items)


def _parse_nested_map(lines: List[str]) -> Dict[str, Any]:
    """metadata 这种一层嵌套：子 key: value，或子 key: + 缩进字符串数组。"""
    result: Dict[str, Any] = {}
    index = 0
    while index < len(lines):
        raw = lines[index]
        index += 1
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        stripped = raw.strip()
        key, sep, rest = stripped.partition(":")
        key = key.strip()
        rest = rest.strip()
        if not sep or not KEY_RE.match(key):
            raise SkillMdError("frontmatter 的 metadata 子项格式不对：%s" % stripped[:60])
        if rest.startswith("[") and rest.endswith("]"):
            result[key] = [_strip_scalar(item) for item in rest[1:-1].split(",") if item.strip()]
            continue
        if rest:
            result[key] = _strip_scalar(rest)
            continue
        # 子 key 后面跟缩进的数组
        items: List[str] = []
        while index < len(lines) and (not lines[index].strip() or lines[index][:1] in " \t"):
            candidate = lines[index].strip()
            index += 1
            if not candidate:
                continue
            if candidate.startswith("- "):
                items.append(_strip_scalar(candidate[2:]))
            else:
                raise SkillMdError("frontmatter 的 metadata.%s 下面应该是字符串数组" % key)
        result[key] = items
    return result


def _parse_yaml_subset(text: str) -> Dict[str, Any]:
    """解析 frontmatter 的 YAML 子集；语法不对抛 SkillMdError（带行号）。"""
    lines = text.replace("\r\n", "\n").split("\n")
    result: Dict[str, Any] = {}
    index = 0
    while index < len(lines):
        raw = lines[index]
        if not raw.strip() or raw.lstrip().startswith("#"):
            index += 1
            continue
        if raw[0] in " \t":
            raise SkillMdError("frontmatter 第 %d 行缩进错误（顶层字段不能缩进）" % (index + 1))
        key, sep, rest = raw.partition(":")
        key = key.strip()
        rest = rest.strip()
        if not sep or not KEY_RE.match(key):
            raise SkillMdError("frontmatter 第 %d 行不是 key: value：%s" % (index + 1, raw.strip()[:60]))
        if key not in _ALLOWED_KEYS:
            raise SkillMdError("frontmatter 不支持字段 %r（可用：%s）" % (key, "、".join(_ALLOWED_KEYS)))
        index += 1
        if rest in ("|", ">", "|-", ">-", "|+", ">+"):
            block: List[str] = []
            while index < len(lines) and (not lines[index].strip() or lines[index][:1] in " \t"):
                block.append(lines[index])
                index += 1
            content_lines = [line[2:] if line.startswith("  ") else line.lstrip() for line in block]
            joiner = "\n" if rest.startswith("|") else " "
            value = joiner.join(content_lines).strip("\n")
            result[key] = value
            continue
        if rest == "":
            block = []
            while index < len(lines) and (not lines[index].strip() or lines[index][:1] in " \t"):
                block.append(lines[index])
                index += 1
            cleaned = [line[2:] if line.startswith("  ") else line for line in block if line.strip()]
            if not cleaned:
                result[key] = ""
            elif _looks_like_list(cleaned):
                result[key] = [_strip_scalar(line.lstrip()[2:]) for line in cleaned]
            else:
                result[key] = _parse_nested_map(cleaned)
            continue
        if rest.startswith("[") and rest.endswith("]"):
            result[key] = [_strip_scalar(item) for item in rest[1:-1].split(",") if item.strip()]
            continue
        result[key] = _strip_scalar(rest)
    return result


def _validate(parsed: Dict[str, Any], body: str) -> Dict[str, Any]:
    name = str(parsed.get("name") or "").strip()
    if not name:
        raise SkillMdError("frontmatter 缺少 name")
    if not NAME_RE.match(name):
        raise SkillMdError("name 只能用 [a-z0-9-_]，以字母或数字开头，最长 64 位（当前：%r）" % name)
    description = str(parsed.get("description") or "").strip()
    if not description:
        raise SkillMdError("frontmatter 缺少 description")
    if len(description) > MAX_DESCRIPTION:
        raise SkillMdError("description 最长 %d 字（当前 %d 字）" % (MAX_DESCRIPTION, len(description)))
    license_value = parsed.get("license")
    if license_value is not None and not isinstance(license_value, str):
        raise SkillMdError("license 必须是字符串")
    compatibility = parsed.get("compatibility")
    if compatibility is not None and not isinstance(compatibility, str):
        raise SkillMdError("compatibility 必须是字符串")
    metadata = parsed.get("metadata")
    if metadata is None:
        metadata = {}
    if not isinstance(metadata, dict):
        raise SkillMdError("metadata 必须是字典")
    allowed = parsed.get("allowed-tools")
    if allowed is None:
        allowed = []
    if not isinstance(allowed, list) or not all(isinstance(item, str) for item in allowed):
        raise SkillMdError("allowed-tools 必须是字符串数组")
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise SkillMdError("正文超过 200KB 上限（当前 %.1f KB）" % (len(body.encode("utf-8")) / 1024.0))
    return {
        "name": name,
        "description": description,
        "license": str(license_value or ""),
        "compatibility": str(compatibility or ""),
        "metadata": metadata,
        "allowed_tools": [item.strip() for item in allowed if item.strip()],
        "body": body,
    }


def parse_skill_md(markdown: str) -> Dict[str, Any]:
    """解析 SKILL.md 文本，返回 {name, description, license, compatibility, metadata, allowed_tools, body}。"""
    text = str(markdown or "")
    if not text.strip():
        raise SkillMdError("内容为空")
    if len(text.encode("utf-8")) > MAX_MARKDOWN_BYTES:
        raise SkillMdError("markdown 超过 1MB 上限")
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise SkillMdError("缺少 frontmatter：文件必须以 --- 开头，第二行开始是 YAML，再用 --- 结束")
    try:
        parsed = _parse_yaml_subset(match.group(1))
    except SkillMdError:
        raise
    except Exception as exc:
        raise SkillMdError("frontmatter 解析失败：%s" % exc)
    body = match.group(2) or ""
    body = body.lstrip("\n")
    return _validate(parsed, body)


# ---------------------------------------------------------------------------
# 序列化（导出）
# ---------------------------------------------------------------------------

def _scalar(value: Any) -> str:
    text = str(value)
    if text == "":
        return '""'
    if re.search(r'[\n\r]', text) or text != text.strip():
        return json.dumps(text, ensure_ascii=False)
    if re.search(r'[:#\[\]{}&*!|>\'"%@`]', text) or text.startswith("- "):
        return json.dumps(text, ensure_ascii=False)
    return text


def _emit_block(value: str, indent: str = "") -> List[str]:
    lines = value.replace("\r\n", "\n").split("\n")
    return ["%s  %s" % (indent, line) if line else "" for line in lines]


def serialize_skill_md(skill: Dict[str, Any], body: Optional[str] = None) -> str:
    """把一个技能定义写成 SKILL.md（name 用 id；正文缺省用 skill_prompt）。"""
    skill = skill or {}
    name = str(skill.get("id") or skill.get("name") or "").strip()
    description = str(skill.get("description") or "").strip()
    lines = ["---", "name: %s" % _scalar(name)]
    if "\n" in description:
        lines.append("description: |")
        lines.extend(_emit_block(description))
    else:
        lines.append("description: %s" % _scalar(description))
    license_value = str(skill.get("license") or "").strip()
    if license_value:
        lines.append("license: %s" % _scalar(license_value))
    compatibility = str(skill.get("compatibility") or "").strip()
    if compatibility:
        lines.append("compatibility: %s" % _scalar(compatibility))
    metadata = {}
    if isinstance(skill.get("metadata"), dict):
        metadata.update(skill["metadata"])
    if metadata:
        lines.append("metadata:")
        for key in sorted(metadata.keys()):
            if not KEY_RE.match(str(key)):
                continue
            value = metadata[key]
            if isinstance(value, (list, tuple)):
                lines.append("  %s:" % key)
                for item in value:
                    if isinstance(item, (dict, list)):
                        continue
                    lines.append("    - %s" % _scalar(item))
            elif isinstance(value, dict):
                lines.append("  %s: %s" % (key, _scalar(json.dumps(value, ensure_ascii=False))))
            else:
                lines.append("  %s: %s" % (key, _scalar(value)))
    allowed = skill.get("allowed_tools") or []
    if isinstance(allowed, (list, tuple)) and allowed:
        lines.append("allowed-tools:")
        for item in allowed:
            lines.append("  - %s" % _scalar(item))
    lines.append("---")
    lines.append("")
    text_body = body if body is not None else str(skill.get("skill_prompt") or "")
    return "\n".join(lines) + "\n" + text_body
