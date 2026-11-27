#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""APIMart 价目页解析器（构建期跑一次，产物落 server/credits/apimart_pricing.json）。

为什么离线：
    运行时绝不爬 APIMart。价格是计费事实，必须可复现、可审阅、随仓库走。
    页面结构一变，重新抓页面后本脚本会大声报错，而不是静默把价格算错。

输入：
    --html  /tmp/apimart-pricing.html   https://apimart.ai/zh/pricing 的原始 HTML
    --pages /tmp/apimart_pages          （可选）各模型详情页缓存；用于补齐视频/音频的
                                        分辨率/时长档位与官方价。文件按详情页 URL 的
                                        sha1 前 16 位命名，见 fetch_apimart_pages.py。

数据来源分三层（优先级从高到低）：
    1) 页面内嵌 initialCatalog（图像模型：全部规格档 + 黄金/铂金/钻石/官方价）
    2) 模型详情页价格表（视频/音频：分辨率/时长/动作档位 + 四档价格）
    3) 起步价索引（全部 239 个模型：h2 总表 + 4 个 h3 分组 + ul>li 行；兜底，也用于未抓详情的模型）

视频/LLM/音频页面上没有逐档详表：逐档价用 --api-model 逐个打
GET https://apimart.ai/api/pricing/model?model=<id>（免鉴权）补，配 --merge-into 只增量改这些模型。
域名必须是 apimart.ai，api.apimart.ai 的同路径会间歇性返回 000。

输出结构见 server/credits/apimart_pricing.json：
    source / credit_usd / coverage / models{id:{...tiers}} / alias_map / fallback

用法：
    python3 tools/apimart_pricing.py \
        --html /tmp/apimart-pricing.html \
        --pages /tmp/apimart_pages \
        --out server/credits/apimart_pricing.json
"""
from __future__ import annotations

import argparse
import hashlib
import html as html_lib
import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

CREDIT_USD = 0.1          # 1 APIMart Credit = $0.1（价目页口径）
GOLD_FACTOR = 0.8         # 黄金价 = 官方价 × 0.8（页面「为你节省 20%」）
PLATINUM_FACTOR = 0.76
DIAMOND_FACTOR = 0.72
UNIT_PER_IMAGE = "per_image"
UNIT_PER_CALL = "per_call"
UNIT_PER_SECOND = "per_second"
UNIT_PER_1M_TOKENS = "per_1m_tokens"
RAW_UNITS = {
    UNIT_PER_IMAGE: "张",
    UNIT_PER_CALL: "次",
    UNIT_PER_SECOND: "秒",
    UNIT_PER_1M_TOKENS: "1M tokens",
}


def _clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", str(text or ""))
    text = html_lib.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _num(value: Any) -> Optional[float]:
    if value in (None, "", "$undefined"):
        return None
    try:
        number = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def _credits(usd: Optional[float]) -> Optional[float]:
    return None if usd is None else round(usd / CREDIT_USD, 6)


def _price_block(usd: Optional[float], derived: bool = False) -> Dict[str, Any]:
    data: Dict[str, Any] = {"usd": usd, "credits": _credits(usd)}
    if derived:
        data["derived"] = True
    return data


def _token_rate_block(gold: float, official: Optional[float]) -> Dict[str, Any]:
    """报价接口的一档 token 单价：gold=effective、official=rates；铂金/钻石按会员 0.95/0.9 推。"""
    return {
        "gold": _price_block(gold),
        "platinum": _price_block(round(gold * MEMBER_PLATINUM_FACTOR, 8)),
        "diamond": _price_block(round(gold * MEMBER_DIAMOND_FACTOR, 8)),
        "official": _price_block(official),
    }


def _tier(spec: str, unit: str, gold: Optional[float], platinum: Optional[float],
          diamond: Optional[float], official: Optional[float], source: str,
          derived: Optional[List[str]] = None, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """gold/platinum/diamond/official 统一用 USD/计费单位存；缺的按页面固定折扣比推导并标记。"""
    derived = list(derived or [])
    if gold is None:
        return {}
    if platinum is None:
        platinum = round(gold * PLATINUM_FACTOR / GOLD_FACTOR, 8)
        derived.append("platinum")
    if diamond is None:
        diamond = round(gold * DIAMOND_FACTOR / GOLD_FACTOR, 8)
        derived.append("diamond")
    if official is None:
        official = round(gold / GOLD_FACTOR, 8)
        derived.append("official")
    tier = {
        "spec": str(spec or "default"),
        "unit": unit,
        "raw_unit": RAW_UNITS.get(unit, ""),
        "gold": _price_block(gold),
        "platinum": _price_block(platinum),
        "diamond": _price_block(diamond),
        "official": _price_block(official),
        "source": source,
    }
    if derived:
        tier["derived"] = sorted(set(derived))
    if extra:
        tier.update(extra)
    return tier


# ---------------------------------------------------------------- RSC 解码

def decode_rsc(html: str) -> str:
    """Next.js 把 RSC payload 塞进 self.__next_f.push([1,"<json string>"])；逐段反转义后拼接。"""
    parts: List[str] = []
    pattern = re.compile(r'self\.__next_f\.push\(\[1,(".*?")\]\)</script>', re.S)
    for match in pattern.finditer(html):
        literal = match.group(1)
        try:
            parts.append(json.loads(literal))
        except Exception:
            continue
    return "\n".join(parts)


def _extract_json_object(text: str, start: int) -> Optional[str]:
    """从 start 处（必须是 {）做括号配对，返回完整 JSON 文本。"""
    if start < 0 or text[start:start + 1] != "{":
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


def extract_initial_catalog(blob: str) -> Dict[str, Any]:
    key = '"initialCatalog":'
    index = blob.find(key)
    if index < 0:
        raise SystemExit("[pricing] 页面里找不到 initialCatalog：页面结构变了，先重新抓页面再改解析器")
    start = blob.find("{", index)
    raw = _extract_json_object(blob, start)
    if not raw:
        raise SystemExit("[pricing] initialCatalog 不是合法 JSON 对象")
    return json.loads(raw)


# ---------------------------------------------------------------- 起步价索引

INDEX_BLOCKS = ("图像", "视频", "LLM", "音频")
CATEGORY_BY_BLOCK = {"图像": "image", "视频": "video", "LLM": "chat", "音频": "audio"}
CATEGORY_BY_DETAIL = {"image": "image", "video": "video", "chat": "chat", "audio": "audio"}


def _index_group_headers(html: str, start: int) -> List[Tuple[str, int, int, Optional[int]]]:
    """h3 分组头（图像/视频/LLM/音频 + 可选 <span>计数</span>）→ [(组名, 段起, 段终, 声明条数)]。"""
    pattern = re.compile(
        r"<h3[^>]*>\s*(图像|视频|LLM|音频)\s*(?:<span[^>]*>\s*(\d+)\s*</span>)?\s*</h3>", re.S)
    marks = [(m.start(), m.end(), m.group(1), int(m.group(2)) if m.group(2) else None)
             for m in pattern.finditer(html, start)]
    blocks: List[Tuple[str, int, int, Optional[int]]] = []
    for idx, (pos, end, name, declared) in enumerate(marks):
        end_pos = marks[idx + 1][0] if idx + 1 < len(marks) else len(html)
        blocks.append((name, end, end_pos, declared))
    return blocks


def parse_index(html: str) -> List[Dict[str, Any]]:
    """解析「全部 N 个 AI 模型起步价」索引：h2 总表 + 4 个 h3 分组 + 每组一个 ul>li 行。

    2026-11-25 页面结构（旧版是 h3 带「·」的表 + <tr>）：总表标题在 <h2>，
    分组是 <h3>图像<span>59</span></h3> 这种（图像/视频/LLM/音频，共 239 行），
    每行是 <li> 里的两个 span：第一个是模型名（可包 <a href>），最后一个是起步价文本。
    """
    heading = re.search(r"<h2[^>]*>(.*?)</h2>", html, re.S)
    if not heading or "个 AI 模型起步价" not in _clean(heading.group(1)):
        raise SystemExit("[pricing] 找不到「全部 N 个 AI 模型起步价」总表标题：页面结构变了")
    rows: List[Dict[str, Any]] = []
    for block_name, start, end, declared in _index_group_headers(html, heading.end()):
        category = CATEGORY_BY_BLOCK.get(block_name)
        if not category:
            continue
        segment = html[start:end]
        group_rows = 0
        for row_html in re.findall(r"<li[^>]*>(.*?)</li>", segment, re.S):
            spans = re.findall(r"<span[^>]*>(.*?)</span>", row_html, re.S)
            if not spans:
                continue
            name_html = spans[0]
            name = _clean(name_html)
            price_text = _clean(spans[-1]) if len(spans) > 1 else ""
            if not name:
                continue
            href_match = re.search(r'href="([^"]+)"', name_html)
            rows.append({
                "category": category,
                "name": name,
                "price_text": price_text,
                "href": href_match.group(1) if href_match else "",
                "tiers": parse_index_price(price_text),
            })
            group_rows += 1
        if declared is not None and declared != group_rows:
            raise SystemExit("[pricing] %s 分组声明 %d 行、实际解析到 %d 行：页面结构变了"
                             % (block_name, declared, group_rows))
    if len(rows) < 200:
        raise SystemExit("[pricing] 起步价索引只解析到 %d 行（预期 ~239）：页面结构变了" % len(rows))
    return rows


def parse_index_price(text: str) -> List[Dict[str, Any]]:
    """'$0.012/张' / '$0.048/秒' / '$0.04/次' / '输入 $4 / 输出 $8 · 每 100 万 token'。"""
    value = _clean(text)
    if not value:
        return []
    token_match = re.search(r"输入\s*\$([0-9.]+)\s*(?:/\s*输出\s*\$([0-9.]+))?", value)
    if token_match or "每 100 万 token" in value or "每 100 万" in value:
        tiers = []
        if token_match:
            tiers.append(_tier("input", UNIT_PER_1M_TOKENS, _num(token_match.group(1)),
                               None, None, None, "index"))
            if token_match.group(2) is not None:
                tiers.append(_tier("output", UNIT_PER_1M_TOKENS, _num(token_match.group(2)),
                                   None, None, None, "index"))
        return [tier for tier in tiers if tier]
    match = re.search(r"\$([0-9.]+)\s*/\s*(秒|次|张|1M tokens|百万 token)", value)
    if not match:
        return []
    unit_text = match.group(2)
    unit = {UNIT_PER_SECOND: UNIT_PER_SECOND, "秒": UNIT_PER_SECOND,
            "次": UNIT_PER_CALL, "张": UNIT_PER_IMAGE,
            "1M tokens": UNIT_PER_1M_TOKENS, "百万 token": UNIT_PER_1M_TOKENS}.get(unit_text, UNIT_PER_CALL)
    return [_tier("default", unit, _num(match.group(1)), None, None, None, "index")]


# ---------------------------------------------------------------- 详情页价格表

def _uint(unit_text: str, fallback: str = UNIT_PER_CALL) -> str:
    text = str(unit_text or "")
    if "1M tokens" in text or "百万" in text:
        return UNIT_PER_1M_TOKENS
    if "秒" in text:
        return UNIT_PER_SECOND
    if "次" in text:
        return UNIT_PER_CALL
    if "张" in text:
        return UNIT_PER_IMAGE
    return fallback


def parse_detail_price_cell(text: str, fallback_unit: str) -> Optional[Dict[str, Any]]:
    """'0.576 Credits ( ~$0.0576 ) /秒' 或 '0.8 ~$ 0.08'（LLM 表）。返回 USD。"""
    value = _clean(text)
    if not value or value in ("—", "-"):
        return None
    credits_match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*Credits", value)
    usd_match = re.search(r"~\s*\$\s*([0-9]+(?:\.[0-9]+)?)", value)
    if credits_match:
        credits = _num(credits_match.group(1))
        usd = _num(usd_match.group(1)) if usd_match else (round(credits * CREDIT_USD, 8) if credits is not None else None)
    else:
        bare = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)\s*~?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)?", value)
        if not bare:
            return None
        credits = _num(bare.group(1))
        usd = _num(bare.group(2)) if bare.group(2) else (round(credits * CREDIT_USD, 8) if credits is not None else None)
    if usd is None:
        return None
    unit_match = re.search(r"/\s*(1M tokens|百万 token|秒|次|张)", value)
    unit = _uint(unit_match.group(1), fallback_unit) if unit_match else fallback_unit
    return {"usd": usd, "credits": credits, "unit": unit}


def parse_detail_page(html: str, category: str) -> List[Dict[str, Any]]:
    """详情页价格表 → [{model_id, spec, unit, gold, platinum, diamond, official}]。"""
    fallback_unit = {"video": UNIT_PER_SECOND, "audio": UNIT_PER_CALL,
                     "image": UNIT_PER_IMAGE, "chat": UNIT_PER_1M_TOKENS}.get(category, UNIT_PER_CALL)
    rows: List[Dict[str, Any]] = []
    for table_match in re.finditer(r"<table[^>]*>(.*?)</table>", html, re.S):
        table = table_match.group(1)
        if "Credits" not in table and "~$" not in table:
            continue
        raw_rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S)
        if not raw_rows:
            continue
        header_cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", raw_rows[0], re.S)
        if len(header_cells) < 3:
            continue
        header_text = " ".join(_clean(cell) for cell in header_cells)
        if "黄金" not in header_text:
            continue
        current_model = ""
        for raw_row in raw_rows[1:]:
            cell_matches = list(re.finditer(r"<t([dh])([^>]*)>(.*?)</t\1>", raw_row, re.S))
            cells = [match.group(3) for match in cell_matches]
            if len(cells) < 3:
                continue
            first_text = _clean(cells[0])
            first_attr = cell_matches[0].group(2)
            # 7 列：型号 + 规格 + 4 档价 + 节省
            if len(cells) >= 7:
                current_model = first_text
                spec = _clean(cells[1])
                price_cells = cells[2:6]
            # 6 列：续行（rowSpan 的型号列被省略）→ 规格 + 4 档价 + 节省
            elif len(cells) == 6:
                spec = first_text
                price_cells = cells[1:5]
            # 5 列：LLM 计费项（输入/输出/缓存）+ 4 档价
            elif len(cells) == 5:
                spec = first_text
                price_cells = cells[1:5]
                if not current_model:
                    current_model = ""
            else:
                continue
            parsed = [parse_detail_price_cell(cell, fallback_unit) for cell in price_cells]
            parsed = [item for item in parsed if item]
            if len(parsed) < 1:
                continue
            # 四档价可能少于 4 个（个别页面官方价为空），按顺序认列：黄金/铂金/钻石/官方
            prices = [item["usd"] for item in parsed]
            while len(prices) < 4:
                prices.append(None)
            unit = parsed[0]["unit"]
            rows.append({
                "model_id": current_model,
                "spec": spec,
                "unit": unit,
                "gold": prices[0],
                "platinum": prices[1],
                "diamond": prices[2],
                "official": prices[3],
            })
    return rows


# ---------------------------------------------------------------- 图像目录

CATALOG_UNIT_MAP = {
    "usd_per_image": UNIT_PER_IMAGE,
    "usd_per_call": UNIT_PER_CALL,
    "usd_per_second": UNIT_PER_SECOND,
    "usd_per_million_tokens": UNIT_PER_1M_TOKENS,
}


def _catalog_member_price(item: Dict[str, Any], tier_name: str) -> Optional[float]:
    members = item.get("member_prices") or {}
    value = _num(members.get(tier_name))
    if value is not None:
        return value
    return None


def build_image_models(catalog: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    models: Dict[str, Dict[str, Any]] = {}
    for item in (catalog.get("modelsByCategory") or {}).get("image") or []:
        model_id = str(item.get("id") or "").strip()
        if not model_id:
            continue
        record: Dict[str, Any] = {
            "id": model_id,
            "name": str(item.get("name") or model_id),
            "category": "image",
            "billing": "",
            "spec_dimension": "",
            "aliases": [],
            "tiers": [],
            "token_rates": {},
        }
        alias = str(item.get("alias") or "").strip()
        if alias and alias != "$undefined" and alias != model_id:
            record["aliases"].append(alias)
        fixed = item.get("fixed_prices") or {}
        unit = CATALOG_UNIT_MAP.get(str(fixed.get("unit") or ""), "")
        if fixed.get("items"):
            record["billing"] = unit or UNIT_PER_IMAGE
            record["spec_dimension"] = str(fixed.get("dimension") or "default")
            tiers = []
            for tier_item in fixed.get("items") or []:
                gold = _catalog_member_price(tier_item, "gold")
                if gold is None:
                    gold = _num(tier_item.get("after_discount"))
                if gold is None:
                    continue
                tier = _tier(
                    str(tier_item.get("key") or "default"),
                    record["billing"] if record["billing"] != UNIT_PER_1M_TOKENS else UNIT_PER_1M_TOKENS,
                    gold,
                    _catalog_member_price(tier_item, "platinum"),
                    _catalog_member_price(tier_item, "diamond"),
                    _num(tier_item.get("original_price")),
                    "page:fixed_prices",
                )
                if tier:
                    tiers.append(tier)
            record["tiers"] = tiers
        pricing = item.get("pricing") or {}
        rates = pricing.get("effective_rates") or pricing.get("rates") or {}
        if rates:
            member = pricing.get("member") or {}
            token_rates: Dict[str, Any] = {}
            gold_rates = rates
            platinum_rates = (member.get("platinum") or {}).get("effective_rates") or {}
            diamond_rates = (member.get("diamond") or {}).get("effective_rates") or {}
            official_rates = pricing.get("rates") or {}
            for key in ("text_input", "image_input", "cached_text_input", "cached_image_input",
                        "text_output", "image_output"):
                gold = _num(gold_rates.get(key))
                if gold is None:
                    continue
                token_rates[key] = {
                    "gold": _price_block(gold),
                    "platinum": _price_block(_num(platinum_rates.get(key))),
                    "diamond": _price_block(_num(diamond_rates.get(key))),
                    "official": _price_block(_num(official_rates.get(key))),
                }
            if token_rates:
                record["token_rates"] = token_rates
        # 有些 token 计价模型仍给出每张图的参考价（size 数组）：作为图像估价档位
        size_entries = item.get("size") or []
        if size_entries and not record["tiers"]:
            tiers = []
            for entry in size_entries:
                gold = _num(entry.get("after_discount"))
                if gold is None:
                    continue
                tiers.append(_tier(str(entry.get("size_name") or "default"), UNIT_PER_IMAGE, gold,
                                   None, None, _num(entry.get("original_price")), "page:size"))
            record["tiers"] = [tier for tier in tiers if tier]
        if not record["billing"]:
            record["billing"] = UNIT_PER_1M_TOKENS if record["token_rates"] else UNIT_PER_IMAGE
        if not record["spec_dimension"]:
            record["spec_dimension"] = "token" if record["token_rates"] else "resolution"
        record["specification"] = str(item.get("specification") or "")
        models[model_id] = record
    return models


# ---------------------------------------------------------------- 合并 / 别名

def _compact(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _find_existing(models: Dict[str, Dict[str, Any]], name: str) -> str:
    """按 id / name / 别名 找已存在的模型（大小写、空格、中划线不敏感）。"""
    wanted = str(name or "").strip().lower()
    compact = _compact(name)
    for model_id, record in models.items():
        candidates = [model_id, record.get("name") or "", *(record.get("aliases") or [])]
        if any(str(item or "").strip().lower() == wanted for item in candidates):
            return model_id
        if compact and compact in {_compact(item) for item in candidates}:
            return model_id
    return ""


def _add_model(models: Dict[str, Dict[str, Any]], record: Dict[str, Any]) -> Dict[str, Any]:
    existing = models.get(record["id"])
    if not existing:
        models[record["id"]] = record
        return record
    # 同 id 多来源：档位取并集（以 spec+unit 去重，后到的详情页覆盖索引）
    seen = {(tier["spec"], tier["unit"]): tier for tier in existing.get("tiers") or []}
    for tier in record.get("tiers") or []:
        if not tier:
            continue
        key = (tier["spec"], tier["unit"])
        previous = seen.get(key)
        if previous is not None and previous.get("source") == "page:detail":
            continue
        seen[key] = tier
    existing["tiers"] = list(seen.values())
    for alias in record.get("aliases") or []:
        if alias not in existing.setdefault("aliases", []):
            existing["aliases"].append(alias)
    for key in ("name", "category", "billing", "spec_dimension", "token_rates", "specification", "limits"):
        if not existing.get(key) and record.get(key):
            existing[key] = record[key]
    return existing


def _detail_models(rows: List[Dict[str, Any]], category: str) -> Dict[str, Dict[str, Any]]:
    models: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        model_id = str(row.get("model_id") or "").strip()
        if not model_id:
            continue
        record = models.get(model_id)
        if not record:
            record = {
                "id": model_id,
                "name": model_id,
                "category": category,
                "billing": row["unit"],
                "spec_dimension": "spec",
                "aliases": [],
                "tiers": [],
                "token_rates": {},
            }
            models[model_id] = record
        tier = _tier(row["spec"], row["unit"], row["gold"], row["platinum"], row["diamond"],
                     row["official"], "page:detail")
        if tier:
            record["tiers"].append(tier)
    # 计算 spec_dimension / billing：视频优先按秒、音频优先按次（同一页可能混着参考图按张的档位）
    for record in models.values():
        specs = " ".join(str(tier.get("spec") or "") for tier in record.get("tiers") or [])
        units = [tier.get("unit") for tier in record.get("tiers") or []]
        if record["category"] == "video":
            record["billing"] = UNIT_PER_SECOND if UNIT_PER_SECOND in units else (units[0] if units else UNIT_PER_CALL)
        elif record["category"] == "audio":
            record["billing"] = UNIT_PER_CALL if UNIT_PER_CALL in units else (units[0] if units else UNIT_PER_CALL)
        if record["billing"] == UNIT_PER_SECOND:
            record["spec_dimension"] = "resolution_duration"
        elif record["billing"] == UNIT_PER_1M_TOKENS:
            record["spec_dimension"] = "input_output"
        elif re.search(r"\d{3,4}P", specs, re.I):
            record["spec_dimension"] = "resolution"
        elif "token" in specs.lower():
            record["spec_dimension"] = "token"
        else:
            record["spec_dimension"] = "spec"
    return models


def _index_model(row: Dict[str, Any]) -> Dict[str, Any]:
    tiers = [tier for tier in row.get("tiers") or [] if tier]
    billing = tiers[0]["unit"] if tiers else UNIT_PER_CALL
    record = {
        "id": row["name"],
        "name": row["name"],
        "category": row["category"],
        "billing": billing,
        "spec_dimension": "input_output" if billing == UNIT_PER_1M_TOKENS else "spec",
        "aliases": [],
        "tiers": tiers,
        "token_rates": {},
    }
    if billing == UNIT_PER_1M_TOKENS:
        record["token_rates"] = {
            tier["spec"]: {"gold": tier["gold"], "platinum": tier["platinum"],
                           "diamond": tier["diamond"], "official": tier["official"]}
            for tier in tiers if tier["spec"] in ("input", "output")
        }
    return record


def _match_detail_ids(name: str, detail_ids: List[str]) -> List[str]:
    wanted = name.strip().lower()
    exact = [model_id for model_id in detail_ids if model_id.lower() == wanted]
    if exact:
        return exact
    base = [model_id for model_id in detail_ids if model_id.lower() == wanted + "@music"]
    if base:
        return base
    prefixed = [model_id for model_id in detail_ids
                if model_id.lower().startswith(wanted + "@") or model_id.lower().startswith(wanted + "-")]
    return prefixed[:1]


# ---------------------------------------------------------------- 模型报价 API

# 视频/LLM/音频没有页面详表：逐档价只能逐个打 GET /api/pricing/model?model=<id>（免鉴权）。
# 域名必须是 apimart.ai：api.apimart.ai 的同路径会间歇性返回 000（2026-11-25 实测多次）。
API_PRICING_BASE = "https://apimart.ai"
API_SOURCE_PREFIX = "api:pricing/model"
API_TOKEN_KEYS = ("text_input", "image_input", "cached_text_input", "cached_image_input",
                  "text_output", "image_output")
MEMBER_PLATINUM_FACTOR = 0.95
MEMBER_DIAMOND_FACTOR = 0.90


def fetch_api_model_pricing(model: str, base: str = API_PRICING_BASE, timeout: float = 20.0) -> Dict[str, Any]:
    """GET {base}/api/pricing/model?model=<id> → data 段（调用方负责 --api-model 显式指定）。"""
    import urllib.parse
    import urllib.request

    url = "%s/api/pricing/model?model=%s" % (base.rstrip("/"), urllib.parse.quote(str(model), safe=""))
    # 不带 User-Agent 会被站点 403（curl 默认带 UA 所以手测是通的）
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; novai-pricing-parser/1)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise SystemExit("[pricing] %s 的报价接口没有 data 段：%s" % (model, str(payload)[:200]))
    return data


def api_pricing_model_record(model: str, data: Dict[str, Any], source: str,
                            spec_label: str = "") -> Dict[str, Any]:
    """报价接口 data → 价目 record。

    口径（D12）：rates=标价、effective_rates=实付；分辨率的标价是 resolution_prices，
    实付是 resolution_paid_prices（gold）；platinum/diamond 按会员 factor 0.95/0.9 推。
    tiered_token 模型（image_modalities）另外给 1K/2K 的预扣 per_image 档，估价走预扣价。
    """
    model_id = str(data.get("model_name") or model).strip()
    list_prices = data.get("resolution_prices") or {}
    paid_prices = data.get("resolution_paid_prices") or list_prices
    billing_type = str(data.get("billing_type") or "").strip().lower()
    default_spec = str(data.get("default_resolution") or data.get("default_spec") or "").strip()
    token_pricing = data.get("pricing") if isinstance(data.get("pricing"), dict) else {}
    pricing_mode = str(token_pricing.get("pricing_mode") or "").strip().lower()
    token_rates: Dict[str, Any] = {}
    if token_pricing:
        effective = token_pricing.get("effective_rates") or {}
        list_rates = token_pricing.get("rates") or {}
        for key in API_TOKEN_KEYS:
            gold = _num(effective.get(key))
            if gold is None:
                continue
            token_rates[key] = _token_rate_block(gold, _num(list_rates.get(key)))
        # 标准 chat 口径：接口的 rates 用 input/output（不是 text_input/text_output），旧逻辑只认后者
        # → claude/gemini/gpt 这些 chat 模型会被落成空记录。只在 token 计费时兜底：per_second 视频模型
        # 即使带 input/output 也不能当 chat 价（否则视频被按文本计价）。
        if not token_rates and pricing_mode == "standard" and billing_type not in (UNIT_PER_SECOND, UNIT_PER_IMAGE):
            for key in ("input", "output"):
                gold = _num(effective.get(key))
                if gold is None:
                    continue
                token_rates[key] = _token_rate_block(gold, _num(list_rates.get(key)))
    tiers: List[Dict[str, Any]] = []
    unit = UNIT_PER_SECOND if "per_second" in billing_type else UNIT_PER_IMAGE
    # tiered_token 图像模型（gpt-image-2.6 家族）的 resolution_prices 是「比例@档位」预扣价（45 档）；
    # 当前估价维度只有分辨率/质量、比例维度没进 schema → 这些档不落，估价按 token_rates 走。
    ratio_keyed = bool(list_prices) and all(":" in str(spec) for spec in list_prices)
    skip_ratio_tiers = pricing_mode == "image_modalities" and ratio_keyed
    if not skip_ratio_tiers:
        for spec, list_usd in list_prices.items():
            gold = _num((paid_prices or {}).get(spec))
            if gold is None:
                gold = _num(list_usd)
            tier = _tier(str(spec), unit, gold, None, None, _num(list_usd), source)
            if tier:
                tiers.append(tier)
    # version_resolution（gpt-image-2.6-ext：flare/sunburst × 1K/2K/4K）：接口的 version_resolution_prices
    # 是另一套 token 标价口径（与页面 fixed price 的 official 不同）→ official 按 gold/0.8 推导并标记。
    version_prices = data.get("version_resolution_prices") or {}
    version_paid = data.get("version_resolution_paid_prices") or version_prices
    if isinstance(version_prices, dict) and version_prices:
        for version, specs in version_prices.items():
            if not isinstance(specs, dict):
                continue
            for res_spec, list_usd in specs.items():
                gold = _num((version_paid.get(version) or {}).get(res_spec))
                if gold is None:
                    gold = _num(list_usd)
                tier = _tier("%s@%s" % (version, res_spec), UNIT_PER_IMAGE, gold, None, None, None, source)
                if tier:
                    tiers.append(tier)
    input_gold = _num(data.get("input_image_paid_price"))
    if input_gold is None:
        input_gold = _num(data.get("input_image_price"))
    input_list = _num(data.get("input_image_price"))
    if input_gold is not None and input_gold > 0:
        tier = _tier("input", UNIT_PER_IMAGE, input_gold, None, None, input_list, source)
        if tier:
            tiers.append(tier)
    # 预扣档（tiered_token 图像）：没传尺寸时估价的落点，顺序把默认档放前面
    precharge = (data.get("precharge_prices") or {}).get("resolution_prices") if isinstance(
        data.get("precharge_prices"), dict) else None
    if isinstance(precharge, dict) and precharge and not skip_ratio_tiers:
        for spec, list_usd in precharge.items():
            gold = _num((list_prices or {}).get(spec))
            if gold is None:
                gold = _num(list_usd)
            tier = _tier(str(spec), UNIT_PER_IMAGE, gold, None, None, _num(list_usd), source)
            if tier and not any(item.get("spec") == tier["spec"] and item.get("unit") == UNIT_PER_IMAGE
                                for item in tiers):
                tiers.append(tier)
    # 标准 chat：接口只给 input/output 两档 token 价 → 落成 input/output 两条 1M token 档（与页面口径同形）
    if token_rates and not tiers and "input" in token_rates:
        for key in ("input", "output"):
            block = token_rates.get(key) or {}
            gold = _num((block.get("gold") or {}).get("usd"))
            if gold is None:
                continue
            tier = _tier(key, UNIT_PER_1M_TOKENS, gold,
                         _num((block.get("platinum") or {}).get("usd")),
                         _num((block.get("diamond") or {}).get("usd")),
                         _num((block.get("official") or {}).get("usd")), source)
            if tier:
                tiers.append(tier)
    # 单档模型（magi-2：只有 model_price/paid_price，没有分档价）：用实付价落一档，
    # spec 由 --api-spec 指定（magi-2 文档固定 1080p），没给就用接口的 default_spec。
    if not tiers and not token_rates and billing_type in (UNIT_PER_SECOND, UNIT_PER_IMAGE):
        gold = _num(data.get("paid_price"))
        if gold is None:
            gold = _num(data.get("model_price"))
        if gold is not None:
            tier = _tier(spec_label or default_spec or "default", unit, gold, None, None,
                         _num(data.get("model_price")), source)
            if tier:
                tiers.append(tier)
    if default_spec and tiers:
        tiers.sort(key=lambda tier: (0 if str(tier.get("spec")) == default_spec else 1,
                                     str(tier.get("spec"))))
    if token_rates:
        billing = UNIT_PER_1M_TOKENS
        category = "image" if pricing_mode == "image_modalities" else "chat"
        dimension = "token" if category == "image" else "input_output"
    elif unit == UNIT_PER_SECOND:
        billing = UNIT_PER_SECOND
        dimension = "resolution_duration"
        category = "video"
    else:
        billing = UNIT_PER_IMAGE
        dimension = "resolution"
        category = "image"
    return {
        "id": model_id,
        "name": model_id,
        "category": category,
        "billing": billing,
        "spec_dimension": dimension,
        "aliases": [],
        "tiers": tiers,
        "token_rates": token_rates,
    }


def apply_api_pricing(payload: Dict[str, Any], model: str, data: Dict[str, Any], source: str,
                      spec_label: str = "") -> Optional[Dict[str, Any]]:
    """把单个模型的实时报价合并进 payload（新模型直接加，已有模型整条替换档位）。

    报价结构不是价目 schema 能表达时（比如没有 billing_type 的 muse-image-ext）返回 None，
    调用方只打印缺口、不写空记录（空档位会在估价时被当 0，等于编价）。
    """
    models = payload.setdefault("models", {})
    record = api_pricing_model_record(model, data, source, spec_label)
    if not record.get("tiers") and not record.get("token_rates"):
        return None
    existing = models.get(model) or {}
    for key in ("aliases", "specification", "limits"):
        if existing.get(key) and not record.get(key):
            record[key] = existing[key]
    models[model] = record
    alias_map = payload.setdefault("alias_map", {})
    alias_map.setdefault(model.lower(), model)
    alias_map.setdefault(_compact(model), model)
    if record["id"] != model:
        alias_map.setdefault(record["id"].lower(), model)
    return record


def _refresh_coverage(payload: Dict[str, Any], note: str = "") -> None:
    """增量合并后重算 coverage（模型数/分类数），并把这次的口径写进 source.note。"""
    models = payload.get("models") or {}
    by_category: Dict[str, int] = {}
    for record in models.values():
        category = str(record.get("category") or "")
        by_category[category] = by_category.get(category, 0) + 1
    coverage = payload.setdefault("coverage", {})
    coverage["models_total"] = len(models)
    coverage["by_category"] = by_category
    if note:
        source = payload.setdefault("source", {})
        current = str(source.get("note") or "")
        if note not in current:
            source["note"] = (current + "；" + note) if current else note


def build(html: str, pages_dir: str = "") -> Dict[str, Any]:
    blob = decode_rsc(html)
    catalog = extract_initial_catalog(blob)
    index_rows = parse_index(html)

    models: Dict[str, Dict[str, Any]] = {}
    for model_id, record in build_image_models(catalog).items():
        models[model_id] = record

    alias_map: Dict[str, str] = {}
    detail_cache: Dict[str, List[Dict[str, Any]]] = {}
    fetched = 0
    for row in index_rows:
        category = row["category"]
        href = row.get("href") or ""
        detail_rows: List[Dict[str, Any]] = []
        if pages_dir and href and category in ("video", "audio"):
            cache_name = hashlib.sha1(href.encode("utf-8")).hexdigest()[:16] + ".html"
            cache_path = os.path.join(pages_dir, cache_name)
            if os.path.isfile(cache_path):
                if cache_path not in detail_cache:
                    with open(cache_path, "r", encoding="utf-8", errors="replace") as handle:
                        detail_cache[cache_path] = parse_detail_page(handle.read(), category)
                    fetched += 1
                detail_rows = detail_cache[cache_path]
        if detail_rows:
            page_models = _detail_models(detail_rows, category)
            detail_ids = list(page_models.keys())
            matched = _match_detail_ids(row["name"], detail_ids)
            for model_id, record in page_models.items():
                _add_model(models, record)
            target_id = matched[0] if matched else row["name"]
        else:
            target_id = _find_existing(models, row["name"]) or row["name"]
            if target_id not in models:
                _add_model(models, _index_model(row))
        # 索引里的显示名 → 实际模型 id（大小写不敏感）
        alias_map.setdefault(row["name"].lower(), target_id)
        alias_map.setdefault(_compact(row["name"]), target_id)
        if row["name"] != target_id:
            alias_map.setdefault(target_id.lower(), target_id)
        # 未抓到详情的模型：给索引里的起步价档位（标 source=index，运行时知道这是最低价）
        if not detail_rows and row.get("tiers"):
            existing = models.get(target_id)
            if existing is not None and not existing.get("tiers"):
                existing["tiers"] = row["tiers"]
                existing["billing"] = row["tiers"][0]["unit"]

    # 别名：id / name / @ 前的基础名
    for model_id, record in models.items():
        for alias in (model_id, record.get("name") or "", *(record.get("aliases") or [])):
            text = str(alias or "").strip().lower()
            if text:
                alias_map.setdefault(text, model_id)
        if "@" in model_id:
            alias_map.setdefault(model_id.split("@", 1)[0].lower(), model_id)
        # 页面上有的模型名可能带空格/大小写差异：再补一个去空格版本
        compact = re.sub(r"[\s_-]+", "", model_id.lower())
        if compact:
            alias_map.setdefault(compact, model_id)

    coverage = {"image": 0, "video": 0, "audio": 0, "chat": 0}
    for record in models.values():
        coverage[record["category"]] = coverage.get(record["category"], 0) + 1
    with_detail = sum(1 for record in models.values()
                      if any(tier.get("source") == "page:detail" for tier in record.get("tiers") or []))

    fallback = _fallback_models(models, alias_map)
    return {
        "schema_version": 1,
        "source": {
            "page": "https://apimart.ai/zh/pricing",
            "detail_pages": "https://apimart.ai/zh/model/<slug>",
            "captured_html_sha256": hashlib.sha256(html.encode("utf-8")).hexdigest(),
            "parsed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "credit_usd": CREDIT_USD,
            "note": "构建期解析产物，运行时不联网；价格单位 USD/计费单位，credits = usd / 0.1",
        },
        "coverage": {
            "models_total": len(models),
            "by_category": coverage,
            "index_total": len(index_rows),
            "detail_pages_used": fetched,
            "models_with_detail_tiers": with_detail,
        },
        "models": models,
        "alias_map": alias_map,
        "fallback": fallback,
    }


def _fallback_models(models: Dict[str, Dict[str, Any]], alias_map: Dict[str, str]) -> Dict[str, str]:
    """每类挑一个中位价模型做「未匹配价格」的兜底；不硬编码具体模型名。

    兜底模型必须能代表该类的主计费方式（视频按秒、音频按次、文本按 token），
    避免挑到「参考图按张」或「歌词生成」这类旁支档位。
    """
    preferred_unit = {
        "image": UNIT_PER_IMAGE,
        "video": UNIT_PER_SECOND,
        "audio": UNIT_PER_CALL,
        "chat": UNIT_PER_1M_TOKENS,
    }
    fallback: Dict[str, str] = {}
    for category, unit in preferred_unit.items():
        candidates: List[Tuple[float, str]] = []
        for model_id, record in models.items():
            if record.get("category") != category:
                continue
            if category == "audio" and "@" in model_id:
                # 音频详情页把每个动作拆成 suno@music / suno@lyrics：兜底只取主动作
                base = model_id.split("@", 1)[0].lower()
                if alias_map.get(base) != model_id:
                    continue
            unit_price = None
            for tier in record.get("tiers") or []:
                if tier.get("unit") != unit:
                    continue
                gold = (tier.get("gold") or {}).get("usd")
                if gold is not None:
                    unit_price = float(gold)
                    break
            if unit_price is None:
                continue
            candidates.append((unit_price, model_id))
        if not candidates:
            continue
        candidates.sort()
        fallback[category] = candidates[len(candidates) // 2][1]
    return fallback


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="解析 APIMart 价目页为结构化 JSON")
    parser.add_argument("--html", required=True, help="apimart.ai/zh/pricing 的 HTML")
    parser.add_argument("--pages", default="", help="模型详情页缓存目录（可选）")
    parser.add_argument("--out", default="", help="输出路径；--merge-into 时默认回写该文件")
    parser.add_argument("--merge-into", default="",
                        help="在已有价目 JSON 上做增量（只改 --api-model 给出的模型），不整表重建")
    parser.add_argument("--api-model", action="append", default=[],
                        help="从 https://apimart.ai/api/pricing/model 拉单个模型的逐档价（可重复）")
    parser.add_argument("--api-base", default=API_PRICING_BASE,
                        help="报价接口域名，默认 https://apimart.ai（不要用 api.apimart.ai）")
    parser.add_argument("--api-date", default="", help="source 里的日期，默认今天")
    parser.add_argument("--api-spec", action="append", default=[],
                        help="模型=规格名（只影响没有分档价的单档模型，如 magi-2=1080P；可重复）")
    args = parser.parse_args(argv)
    if args.merge_into and not args.api_model:
        parser.error("--merge-into 需要同时给 --api-model（增量只按模型合并）")
    spec_labels: Dict[str, str] = {}
    for item in args.api_spec:
        model_key, _sep, spec_value = str(item).partition("=")
        if model_key.strip() and spec_value.strip():
            spec_labels[model_key.strip().lower()] = spec_value.strip()
    with open(args.html, "r", encoding="utf-8", errors="replace") as handle:
        html = handle.read()
    if args.merge_into:
        with open(args.merge_into, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        # 页面结构仍要校验一遍：抓下来的 HTML 和新解析器不匹配就直接报错，不静默写脏数据
        parse_index(html)
    else:
        payload = build(html, args.pages)
    merged: List[Tuple[str, str, int]] = []
    skipped: List[str] = []
    if args.api_model:
        source = "%s@%s" % (API_SOURCE_PREFIX, args.api_date or time.strftime("%Y-%m-%d"))
        for model in args.api_model:
            data = fetch_api_model_pricing(model, args.api_base)
            record = apply_api_pricing(payload, model, data, source,
                                       spec_labels.get(model.strip().lower(), ""))
            if record is None:
                skipped.append(model)
                print("[pricing] 缺口 %s：报价结构不是价目 schema 能表达（无分档/无 token 价）" % model)
                continue
            merged.append((model, str(record.get("category") or ""), len(record.get("tiers") or [])))
        note = ("增量条目（%s）的 source 标为 %s，数值取自 Model Pricing API"
                "（GET /api/pricing/model，免鉴权实测），gold=会员实付价、"
                "official=标价、platinum/diamond 按 0.95/0.9 推导"
                % (", ".join(item[0] for item in merged), source))
        if skipped:
            note += "；结构不支持的缺口（未落价）：%s" % "、".join(skipped)
        _refresh_coverage(payload, note)
    out_path = os.path.abspath(args.out or args.merge_into
                               or os.path.join("server", "credits", "apimart_pricing.json"))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1, sort_keys=False)
        handle.write("\n")
    coverage = payload["coverage"]
    print("[pricing] 写出 %s" % out_path)
    print("[pricing] 模型 %d（%s）；索引 %d；详情页 %d；详情档位模型 %d" % (
        coverage["models_total"], coverage["by_category"], coverage["index_total"],
        coverage["detail_pages_used"], coverage["models_with_detail_tiers"]))
    print("[pricing] 兜底：%s" % payload["fallback"])
    for model, category, tier_count in merged:
        print("[pricing] 增量 %s（%s，%d 档）" % (model, category, tier_count))
    return 0


if __name__ == "__main__":
    sys.exit(main())
