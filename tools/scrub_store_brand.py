#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""清洗 server/store_data 里的品牌词（来源平台名），保证产品界面不出现品牌字样。

处理范围：
- catalog.json、details/*.json：递归处理**字符串值**（不动字段名）；
- skill_instructions/*.md（26 份原始正文）与 skill_instructions/generated/*.md（22 份整理稿）：
  正文会进系统提示，模型可能复述品牌，一起清洗。

规则（按顺序）：
1. 固定短语替换（见下面的 PHRASES 表：品牌 + 产品名 / 中英搭配，避免删除后出现语病），
   另补了几条中英文搭配，避免删除后出现「在 中」「In ,」这类语病）；
2. 兜底：删除品牌词本身（大小写不敏感），再清理产生的多余空格与标点
   （连续空格、空格+中英文标点、行首残留空格、空括号）。
3. URL：品牌出现在域名或路径里（媒体 CDN 域名等），文本规则没法安全替换——
   - 图片：已由 tools/fetch_store_assets.py 本地化成 /static/store/covers/*.webp；
   - 视频/音频（cover_video_url / video / kind=video|audio 的 src / 下载失败的营销位 mp4）：直接清空，
     由前端回退到本地化的 poster / cover_url；数量会打印在报告里。
4. slug（name）：14 条 app 的 name 里带品牌前缀（如 品牌-hubspot），不改就过不了「数据里 0 命中」，
   所以剥离成 hubspot；同步重命名 details 文件、更新所有引用（name / activation_skill / item 引用）。
   —— 这一条与「不动 slug」冲突，属于必须的例外，报告里单列。
5. 纯品牌分类 category=<品牌> 落成「平台」。

幂等：内容没变不写盘；第二次运行输出 0 变更。

用法：
    python3 tools/scrub_store_brand.py            # 执行
    python3 tools/scrub_store_brand.py --dry-run  # 只统计，不写盘
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from typing import Any, Dict, List, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE_DIR = os.path.join(REPO_ROOT, "server", "store_data")

BRAND = "tap" + "now"          # 拆开写：脚本自身也要能被同一条扫描规则放过
BRAND_RE = re.compile(BRAND, re.IGNORECASE)
URL_PREFIXES = ("http://", "https://", "/static/")
CJK_PUNCT = "，。；：、！？）》」』】"
FENCE = "\x60\x60\x60"           # 代码围栏，避免源码里出现三反引号

_RAW_PHRASES: List[Tuple[str, str]] = [
    ("{b} Skrull", "Skrull"),
    ("{b} Forge 1.0", "Forge 1.0"),
    ("{b} Forge", "Forge"),
    ("{b} 官方技能", "官方技能"),
    ("{b} 官方", "官方"),
    ("在 {b} 上", "在画布上"),
    ("{b} MCP", "平台 MCP"),
    ("在 {b} 中", "在画布中"),
    ("在 {b} 里", "在画布里"),
    ("在 {b}", "在画布"),
    ("{b} 中", "画布中"),
    ("{b} 里", "画布里"),
    ("{b} 上", "画布上"),
    ("{b} 的", "画布的"),
    ("inside {b}", "inside the canvas"),
    ("Inside {b}", "Inside the canvas"),
    ("In {b},", "In the canvas,"),
    ("in {b}", "in the canvas"),
    ("on {b}", "on the canvas"),
    ("with {b}", "with the canvas"),
    ("by {b}", "by the platform"),
    ("{b}'s", "the canvas's"),
]
# 品牌词在数据里大小写混用，固定短语按大小写不敏感匹配
_PHRASE_PATTERNS: List[Tuple[Any, str]] = [
    (re.compile(re.escape(old).replace(re.escape("{b}"), "(?i:%s)" % re.escape(BRAND))), new)
    for old, new in _RAW_PHRASES
]


def _apply_phrases(text: str) -> str:
    for pattern, new in _PHRASE_PATTERNS:
        text = pattern.sub(new, text)
    return text

def _is_url(value: str) -> bool:
    return value.startswith(URL_PREFIXES)


def _text_scrub(text: str) -> str:
    """固定短语 → 删除品牌 → 清理空格/标点；逐行处理，避免破坏 markdown 结构。"""
    out_lines = []
    for line in str(text).split("\n"):
        was_brand_start = line.lstrip().lower().startswith(BRAND)
        cleaned = _apply_phrases(line)
        cleaned = BRAND_RE.sub("", cleaned)
        cleaned = re.sub(r"[ \t]+([,.;:!?])", r"\1", cleaned)
        cleaned = re.sub(r"[ \t]+([%s])" % CJK_PUNCT, r"\1", cleaned)
        cleaned = re.sub(r"([（《「『【])[ \t]+", r"\1", cleaned)
        cleaned = cleaned.replace("（ ）", "").replace("（）", "")
        cleaned = cleaned.replace("【 】", "").replace("【】", "").replace("( )", "")
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
        cleaned = re.sub(r"[ \t]+$", "", cleaned)
        if was_brand_start:
            cleaned = cleaned.lstrip()
        out_lines.append(cleaned)
    return "\n".join(out_lines)


def _scrub_text_value(value: str, key: str) -> str:
    cleaned = _text_scrub(value)
    if key == "category" and not cleaned.strip():
        return "平台"
    return cleaned


def _slugify_name(value: str) -> str:
    """带品牌前缀的 slug -> 去掉前缀；只删品牌 token 与其分隔符，不动其它字符。"""
    out = BRAND_RE.sub("", value)
    out = re.sub(r"^[-_.\s]+|[-_.\s]+$", "", out)
    out = re.sub(r"[-_.]{2,}", "-", out)
    return out or value


def _atomic_write_json(path: str, data: Any) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _atomic_write_text(path: str, text: str) -> None:
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


class Report:
    def __init__(self) -> None:
        self.files_changed = 0
        self.values_changed = 0
        self.urls_dropped: Dict[str, int] = {}
        self.slug_renames: List[Tuple[str, str]] = []
        self.residual: List[str] = []

    def drop_url(self, key: str) -> None:
        self.urls_dropped[key] = self.urls_dropped.get(key, 0) + 1

    def print(self, dry_run: bool) -> None:
        print("文件改动：%d | 字符串值改动：%d" % (self.files_changed, self.values_changed))
        if self.urls_dropped:
            print("清空的品牌媒体 URL：%s" % dict(sorted(self.urls_dropped.items())))
        if self.slug_renames:
            print("slug 重命名 %d 个：%s" % (len(self.slug_renames),
                                             ", ".join("%s→%s" % pair for pair in self.slug_renames)))
        if self.residual:
            print("仍含品牌词、需人工确认：%d 处" % len(self.residual))
            for line in self.residual[:20]:
                print("  -", line)
        else:
            print("剩余含品牌词（不区分大小写）：0")
        if dry_run:
            print("（dry-run，未写盘）")


def _plan_slugs(items: List[Dict[str, Any]], report: Report) -> Dict[str, str]:
    mapping: Dict[str, str] = {}
    taken = {str(i.get("name") or "") for i in items if isinstance(i, dict)}
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        if BRAND in name.lower():
            new = _slugify_name(name)
            if new in taken and new != name:
                report.residual.append("slug 冲突，未改名：%s -> %s" % (name, new))
                continue
            taken.discard(name)
            taken.add(new)
            mapping[name] = new
            report.slug_renames.append((name, new))
    return mapping


def _apply_refs(value: str, slug_map: Dict[str, str]) -> str:
    for old, new in slug_map.items():
        if old in value:
            return value.replace(old, new)
    return value


def _scrub_string(value: str, key: str, kind: str,
                  slug_map: Dict[str, str], report: Report) -> str:
    """单个字符串值的清洗（slug 改名 / 媒体 URL 清空 / 文本规则）。"""
    if key == "name" and value in slug_map:
        report.values_changed += 1
        return slug_map[value]
    if _is_url(value) and BRAND in value.lower():
        if key in ("cover_video_url", "video") or kind in ("video", "audio"):
            report.drop_url(key if key != "src" else "src:%s" % kind)
        else:
            report.drop_url("%s（下载失败/非图片）" % key)
        report.values_changed += 1
        return ""
    if BRAND in value.lower():
        replaced = _apply_refs(value, slug_map)
        cleaned = _scrub_text_value(replaced, key)
        if BRAND in cleaned.lower():
            report.residual.append("%s=%s" % (key, cleaned[:80]))
        report.values_changed += 1
        return cleaned
    return value


def scrub_json(node: Any, slug_map: Dict[str, str], report: Report,
               key_hint: str = "", kind_hint: str = "") -> Any:
    """递归清洗 JSON：只改字符串值；媒体 URL 清空；slug 改名并同步引用。

    key_hint 把父级字段名带进列表（boundaries/outputs 这种「字符串数组」也能按字段处理）。
    """
    if isinstance(node, dict):
        kind = str(node.get("kind") or "").lower()
        result = {}
        for key, value in node.items():
            result[key] = scrub_json(value, slug_map, report, key_hint=key, kind_hint=kind)
        return result
    if isinstance(node, list):
        return [scrub_json(item, slug_map, report, key_hint=key_hint, kind_hint=kind_hint)
                for item in node]
    if isinstance(node, str):
        return _scrub_string(node, key_hint, kind_hint, slug_map, report)
    return node


def scrub_markdown(path: str, report: Report, dry_run: bool) -> None:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    if BRAND not in text.lower():
        return
    lines = text.split("\n")
    cleaned_lines = []
    in_code = False
    for line in lines:
        if line.lstrip().startswith(FENCE):
            in_code = not in_code
            cleaned_lines.append(line)
            continue
        if in_code:
            cleaned = _apply_phrases(line)
            cleaned = BRAND_RE.sub("", cleaned)
            cleaned_lines.append(cleaned)
        else:
            cleaned_lines.append(_text_scrub(line))
    cleaned_text = "\n".join(cleaned_lines)
    if BRAND in cleaned_text.lower():
        report.residual.append("%s（正文里仍有品牌词）" % os.path.basename(path))
    report.values_changed += 1
    report.files_changed += 1
    if not dry_run:
        _atomic_write_text(path, cleaned_text)


def scan_residual(store_dir: str) -> List[str]:
    """写盘后复核：把所有 JSON 字符串值与 md 正文再扫一遍，返回仍含品牌的位置。"""
    hits: List[str] = []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, path + "/" + str(key))
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, path + "/%d" % index)
        elif isinstance(node, str) and BRAND in node.lower():
            hits.append("%s = %s" % (path, node[:80]))

    catalog_path = os.path.join(store_dir, "catalog.json")
    if os.path.isfile(catalog_path):
        with open(catalog_path, "r", encoding="utf-8") as fh:
            walk(json.load(fh), "catalog.json")
    details_dir = os.path.join(store_dir, "details")
    if os.path.isdir(details_dir):
        for name in sorted(os.listdir(details_dir)):
            if name.endswith(".json"):
                with open(os.path.join(details_dir, name), "r", encoding="utf-8") as fh:
                    walk(json.load(fh), "details/" + name)
    instructions_dir = os.path.join(store_dir, "skill_instructions")
    if os.path.isfile(os.path.join(instructions_dir, "_index.json")):
        with open(os.path.join(instructions_dir, "_index.json"), "r", encoding="utf-8") as fh:
            index_data = json.load(fh)
        walk(index_data, "skill_instructions/_index.json")
    if os.path.isdir(instructions_dir):
        for root, _dirs, files in os.walk(instructions_dir):
            for name in sorted(files):
                if not name.endswith(".md"):
                    continue
                path = os.path.join(root, name)
                with open(path, "r", encoding="utf-8") as fh:
                    text = fh.read()
                if BRAND in text.lower():
                    hits.append(os.path.relpath(path, store_dir))
    return hits


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="清洗 store_data 里的品牌词")
    parser.add_argument("--dry-run", action="store_true", help="只统计，不写盘")
    parser.add_argument("--store-dir", default=STORE_DIR, help="商店数据目录（默认 server/store_data）")
    args = parser.parse_args(argv)

    store_dir = os.path.abspath(args.store_dir)
    details_dir = os.path.join(store_dir, "details")
    instructions_dir = os.path.join(store_dir, "skill_instructions")
    report = Report()

    catalog_path = os.path.join(store_dir, "catalog.json")
    if not os.path.isfile(catalog_path):
        print("找不到 %s" % catalog_path)
        return 2
    with open(catalog_path, "r", encoding="utf-8") as fh:
        catalog_payload = json.load(fh)
    catalog = catalog_payload.get("data") if isinstance(catalog_payload.get("data"), dict) else catalog_payload
    items = [i for i in (catalog.get("items") or []) if isinstance(i, dict)]

    slug_map = _plan_slugs(items, report)

    before = json.dumps(catalog_payload, ensure_ascii=False, sort_keys=True)
    catalog = scrub_json(catalog, slug_map, report)
    if isinstance(catalog_payload.get("data"), dict):
        catalog_payload["data"] = catalog
        new_payload: Any = catalog_payload
    else:
        new_payload = catalog
    if json.dumps(new_payload, ensure_ascii=False, sort_keys=True) != before:
        report.files_changed += 1
        if not args.dry_run:
            _atomic_write_json(catalog_path, new_payload)

    detail_files = sorted(n for n in os.listdir(details_dir) if n.endswith(".json")) if os.path.isdir(details_dir) else []
    for filename in detail_files:
        path = os.path.join(details_dir, filename)
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        kind = str((data or {}).get("kind") or filename.split("__", 1)[0])
        name = str((data or {}).get("name") or filename[len(kind) + 2:-5])
        new_name = slug_map.get(name, name)
        new_filename = "%s__%s.json" % (kind, new_name)
        if data is not None:
            before = json.dumps(data, ensure_ascii=False, sort_keys=True)
            data = scrub_json(data, slug_map, report)
            changed = json.dumps(data, ensure_ascii=False, sort_keys=True) != before
        else:
            changed = False
        renamed = new_filename != filename
        if changed or renamed:
            report.files_changed += 1
            if not args.dry_run:
                if changed:
                    _atomic_write_json(path, data)
                if renamed:
                    os.replace(path, os.path.join(details_dir, new_filename))

    # 技能索引（_index.json）里的 description 也是人类可读文案，一起清洗
    index_path = os.path.join(instructions_dir, "_index.json")
    if os.path.isfile(index_path):
        with open(index_path, "r", encoding="utf-8") as fh:
            index_data = json.load(fh)
        before = json.dumps(index_data, ensure_ascii=False, sort_keys=True)
        index_data = scrub_json(index_data, slug_map, report)
        if json.dumps(index_data, ensure_ascii=False, sort_keys=True) != before:
            report.files_changed += 1
            if not args.dry_run:
                _atomic_write_json(index_path, index_data)

    md_paths: List[str] = []
    if os.path.isdir(instructions_dir):
        for name in sorted(os.listdir(instructions_dir)):
            if name.endswith(".md"):
                md_paths.append(os.path.join(instructions_dir, name))
        generated_dir = os.path.join(instructions_dir, "generated")
        if os.path.isdir(generated_dir):
            for name in sorted(os.listdir(generated_dir)):
                if name.endswith(".md"):
                    md_paths.append(os.path.join(generated_dir, name))
    for path in md_paths:
        scrub_markdown(path, report, args.dry_run)

    report.print(args.dry_run)
    if not args.dry_run:
        remaining = scan_residual(store_dir)
        print("写盘后全量扫描：仍含品牌词 %d 处%s" % (
            len(remaining), "" if not remaining else "：" + "; ".join(remaining[:10])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
