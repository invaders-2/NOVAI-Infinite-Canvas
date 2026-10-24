#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给「没有原始执行手册」的官方技能补一份等价手册（公开元数据整理稿，非原文）。

背景：server/store_data/skill_instructions/ 里只有 26 份上游原始正文；其余 skill 条目的
skill_ref 为空。本脚本用 catalog + details 里**已公开**的字段（description / marketing_line /
guide.scenarios / guide.steps / guide.outputs / guide.boundaries / guide.required_context /
starter_prompt）拼一份固定结构的手册，写到 skill_instructions/generated/<name>.md。

原则：
- 只整理公开元数据，不编造步骤；上游没给的 section 写「（上游未公开）」；
- 文件头必须写明「非原文」，详情接口的 skill_body_source 会返回 "generated"；
- 幂等：内容没变不写盘；条目后来有了原始正文（或不在 catalog 里）会删掉对应的 generated 文件；
- 可重复执行：第二次运行输出 0 变更。

用法：
    python3 tools/build_store_manuals.py            # 生成/更新
    python3 tools/build_store_manuals.py --dry-run  # 只统计
    python3 tools/build_store_manuals.py --prune    # 额外删除目录里多余的 generated 文件（默认就删）
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
from typing import Any, Dict, List, Optional

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from server.routes import store  # noqa: E402

# 说明行不能带品牌词（产品界面/系统提示里都不允许出现来源品牌；scrub 脚本也会兜底清掉）
NOTE_LINE = "> 说明：本技能为官方技能，原始执行手册未随客户端下发，以下内容由公开元数据整理，非原文。"
EMPTY = "（上游未公开）"


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "、".join(_text(item) for item in value if _text(item))
    return str(value).strip()


def _bullets(items: Any) -> str:
    lines = [("- " + _text(item)) if not isinstance(item, dict) else ("- " + _text(item.get("title")) + ("：" + _text(item.get("description")) if _text(item.get("description")) else ""))
             for item in (items or []) if _text(item if not isinstance(item, dict) else item.get("title"))]
    return "\n".join(lines) if lines else EMPTY


def build_manual(item: Dict[str, Any], detail: Dict[str, Any]) -> str:
    """按固定结构拼一份手册（只用公开字段，不碰原始 prompt）。"""
    guide = detail.get("guide") if isinstance(detail.get("guide"), dict) else {}
    display_name = _text(item.get("display_name")) or _text(item.get("name"))
    positioning = []
    for part in (_text(detail.get("description")) or _text(item.get("description")),
                 _text(detail.get("marketing_line")) or _text(item.get("marketing_line"))):
        if part and part not in positioning:      # 两段常常是同一句，去重
            positioning.append(part)
    scenarios = _bullets(guide.get("scenarios"))
    steps = guide.get("steps") or []
    step_lines = []
    for index, step in enumerate(steps, 1):
        if isinstance(step, dict):
            title = _text(step.get("title"))
            desc = _text(step.get("description"))
            if title or desc:
                step_lines.append("%d. %s" % (index, title + ("：" + desc if desc else "") if title else desc))
        else:
            text = _text(step)
            if text:
                step_lines.append("%d. %s" % (index, text))
    outputs = _bullets(guide.get("outputs"))
    boundaries = _bullets(guide.get("boundaries"))
    required = _bullets(guide.get("required_context"))
    starter = _text(detail.get("starter_prompt")) or _text(item.get("starter_prompt")) or EMPTY
    parts = [
        "# %s" % display_name,
        "",
        NOTE_LINE,
        "",
        "## 定位",
        "\n".join(positioning) if positioning else EMPTY,
        "",
        "## 适用场景",
        scenarios,
        "",
        "## 工作步骤",
        "\n".join(step_lines) if step_lines else EMPTY,
        "",
        "## 交付物",
        outputs,
        "",
        "## 边界",
        boundaries,
        "",
        "## 需要准备",
        required,
        "",
        "## 起手提示",
        starter,
        "",
    ]
    return "\n".join(parts)


def _atomic_write(path: str, content: str) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="用公开元数据给官方技能补等价执行手册")
    parser.add_argument("--dry-run", action="store_true", help="只统计要生成/更新/删除多少，不写盘")
    parser.add_argument("--prune", action="store_true", default=True, help="删除多余的 generated 文件（默认开启）")
    parser.add_argument("--no-prune", dest="prune", action="store_false", help="保留多余文件")
    args = parser.parse_args(argv)

    catalog = store.load_catalog_payload()
    items = [item for item in (catalog.get("items") or []) if isinstance(item, dict)]
    generated_dir = os.path.join(store._skill_instructions_dir(), store.SKILL_GENERATED_DIRNAME)

    planned: Dict[str, str] = {}
    skipped_original = 0
    for item in items:
        if str(item.get("kind") or "") != "skill":
            continue
        if store.skill_body_source(item) == "original":
            skipped_original += 1          # 有上游原始正文，不补整理稿
            continue
        name = _text(item.get("name"))
        if not name:
            continue
        detail = store.load_detail("skill", name) or {}
        planned[name] = build_manual(item, detail)

    created = updated = unchanged = 0
    for name, content in sorted(planned.items()):
        path = os.path.join(generated_dir, name + ".md")
        previous = ""
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fh:
                previous = fh.read()
        if previous == content:
            unchanged += 1
            continue
        if previous:
            updated += 1
        else:
            created += 1
        if not args.dry_run:
            _atomic_write(path, content)

    removed = 0
    if args.prune and os.path.isdir(generated_dir):
        keep = set(planned)
        for filename in sorted(os.listdir(generated_dir)):
            if not filename.endswith(".md"):
                continue
            name = filename[:-3]
            if name in keep:
                continue
            removed += 1
            if not args.dry_run:
                os.remove(os.path.join(generated_dir, filename))

    total_skills = len([i for i in items if str(i.get("kind") or "") == "skill"])
    print("skill 条目：%d | 已有原始正文跳过：%d | 应生成整理稿：%d" % (total_skills, skipped_original, len(planned)))
    print("新建 %d / 更新 %d / 无变化 %d / 删除多余 %d%s" % (
        created, updated, unchanged, removed, "（dry-run，未写盘）" if args.dry_run else ""))
    if args.dry_run:
        for name in sorted(planned)[:5]:
            print("  dry-run:", name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
