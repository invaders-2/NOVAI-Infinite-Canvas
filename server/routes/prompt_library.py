#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""prompt_library.py —— 在线提示词库代理（aishort 社区提示词）。

数据源：GET https://api.newzone.top/api/cards?pagination[page]=N&pagination[pageSize]=25
返回 Strapi 格式（data[].attributes.zh/en.{title,prompt,remark,description}、tags、count）。
上游 filters[...] 参数会 500，所以这里**一次抓全 12 页再本地搜索/分页**（279 条）。

缓存：
- 进程内 + 磁盘 <DATA_DIR>/prompt-library-cache.json，TTL 12 小时；
- 首次请求时拉取；上游失败但磁盘缓存未过期时返回缓存并带 stale:true；
- refresh=true 强制重新抓取。

Python 3.9 约束：注解只用 Optional/List/Dict，禁止 X | Y。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/api/prompt-library")

SOURCE = "aishort"
UPSTREAM_URL = "https://api.newzone.top/api/cards"
UPSTREAM_PAGE_SIZE = 25          # 上游固定每页 25 条
DEFAULT_UPSTREAM_PAGES = 12      # 279 条 / 12 页
MAX_UPSTREAM_PAGES_CAP = 40      # 防上游 pageCount 异常导致无限抓取
PAGE_TIMEOUT_SECONDS = 15.0      # 每页超时
CACHE_TTL_SECONDS = 3600         # 缓存 1 小时（想调新鲜度改这一处）
MAX_FAILED_PAGES = 2             # 失败页数 > 2 → 502
DEFAULT_PAGE_SIZE = 30
MAX_PAGE_SIZE = 100
CACHE_FILE_NAME = "prompt-library-cache.json"
COMMUNITY_URL = "https://www.aishort.top/community-prompt/%s"
# 电商：aishort 279 条里没有中文电商内容（关键词只误命中英文 listing），改成内置精选内容
LOCAL_ECOMMERCE_PROMPTS: List[Dict[str, Any]] = [
    {
        "id": "local-ecom-1",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "商品主图构图方案",
            "remark": "白底、场景、细节三类主图怎么拍、怎么摆",
            "description": "",
            "prompt": "你是电商视觉指导。商品是[商品名]，卖点是[卖点]。请给出 3 组主图方案：①白底主图（构图、占比、留白、灯光）②场景主图（场景、道具、情绪）③细节主图（拍摄部位、放大倍率、质感表现）。每组写清 9 个要点，并标注适合的平台（淘宝/京东/亚马逊/独立站）。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
    {
        "id": "local-ecom-2",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "详情页文案结构",
            "remark": "首屏到转化的完整文案骨架",
            "description": "",
            "prompt": "你是电商文案策划。为[商品]写详情页文案，按结构输出：①首屏一句话利益点（≤15字）②三个痛点场景③三个卖点+证据④使用步骤⑤信任背书⑥规格参数表⑦促单行动号召。语气[专业/亲切/高级]，每个模块给 1 个主文案 + 1 个备选。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
    {
        "id": "local-ecom-3",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "差异化卖点提炼",
            "remark": "从参数表里挑出真正能打的 3 个卖点",
            "description": "",
            "prompt": "你是产品营销顾问。这是[商品]的参数与竞品信息：[粘贴参数表]。请提炼 3 个差异化卖点，每个卖点说明：①用户能感知的好处 ②支撑证据（参数/材质/实验） ③一句话表达（≤12字） ④适合放在哪里（主图/标题/详情页）。排除同质化参数。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
    {
        "id": "local-ecom-4",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "小红书种草笔记",
            "remark": "笔记标题、正文、话题标签一条龙",
            "description": "",
            "prompt": "你是小红书种草博主。产品[商品]，人群[人群]，核心卖点[卖点]。写一篇笔记：①3 个标题（含数字/对比/情绪钩子）②正文 300-500 字（第一人称、场景开头、痛点、体验、前后对比、结尾轻推）③8 个话题标签 ④首图文案建议。避免绝对化用语和医疗功效表述。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
    {
        "id": "local-ecom-5",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "亚马逊 Listing 优化",
            "remark": "标题、五点、搜索词",
            "description": "",
            "prompt": "你是亚马逊运营。产品[产品]，目标站点[站点]，核心关键词[关键词]。输出：①标题（≤200 字符，品牌+核心词+属性+场景）②五点描述（每点首字母大写、突出 benefit）③后台搜索词 249 字节内 ④A+ 页面结构建议。不要堆砌关键词。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
    {
        "id": "local-ecom-6",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "淘宝京东标题优化",
            "remark": "30 字标题的组合规则",
            "description": "",
            "prompt": "你是电商运营。商品[商品]，核心词[核心词]，属性[属性]，人群[人群]。给我 5 个 30 字以内的标题，规则：核心词前置、属性词补充、人群/场景词收尾，避免违禁词与极限词；并说明每个标题适合的搜索意图。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
    {
        "id": "local-ecom-7",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "直播带货口播脚本",
            "remark": "30 秒和 3 分钟两版",
            "description": "",
            "prompt": "你是直播运营。产品[商品]，价格[价格]，卖点[卖点]，赠品[赠品]。写两版口播：①30 秒极速版（钩子-痛点-产品-价格-逼单）②3 分钟完整版（场景-痛点-演示-对比-信任-价格-行动）。标注语速、停顿、动作提示。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
    {
        "id": "local-ecom-8",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "竞品差评分析",
            "remark": "从差评里提炼改进点与文案机会",
            "description": "",
            "prompt": "你是产品经理。以下是竞品[竞品名]的差评：[粘贴差评]。请归纳 Top5 问题类型、每条的用户原话、背后真实需求、我们能做的产品/文案改进，以及一条可写进详情页的「反向承诺」。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
    {
        "id": "local-ecom-9",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "价格锚定与促销文案",
            "remark": "让价格显得值的表达",
            "description": "",
            "prompt": "你是定价与促销文案顾问。产品[商品]日常价[原价]，活动价[活动价]，赠品[赠品]。给出：①价格锚定组合（对比对象、分期、日均价）②3 条促单文案 ③组合装/加价购建议 ④避免价格欺诈的合规提醒。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
    {
        "id": "local-ecom-10",
        "source": "local",
        "url": "",
        "count": 0,
        "tags": ["ecommerce"],
        "zh": {
            "title": "商品图 A/B 测试脚本",
            "remark": "用两组素材验证哪个卖点更能打",
            "description": "",
            "prompt": "你是增长运营。为[商品]设计一次主图 A/B 测试：①两个版本各自突出的卖点 ②变量控制（只改一处）③样本量与投放时长建议 ④观察指标（点击率/转化率/停留）⑤判定标准与后续动作。",
        },
        "en": {"title": "", "remark": "", "description": "", "prompt": ""},
    },
]

# q 命中这些词时走「电商精选」特殊搜索（结果必含本地 10 条）
ECOMMERCE_SEARCH_WORDS = [
    "电商", "电商运营", "网店", "店铺", "淘宝", "京东", "亚马逊", "带货", "详情页", "主图", "卖点",
]

# 虚拟 key 与真实 tag 的别名合并：categories 里只保留虚拟 key，count = 并集（避免同名中文分类出现两个）
VIRTUAL_TAG_ALIASES: Dict[str, List[str]] = {
    "writing": ["write"],
    "coding": ["code"],
    "translation": ["interpreter"],
    "education": ["pedagogy"],
}

# categories 里隐藏的 tag（没有语义价值；tag=contribute 请求本身仍可用）
HIDDEN_CATEGORY_KEYS = {"contribute"}

# 其它虚拟分类：aishort 没有这些 tag，用关键词匹配 zh/en 的 title/remark/prompt
VIRTUAL_CATEGORIES: Dict[str, List[str]] = {
    "video": ["视频", "video", "短视频", "剪辑"],
    "writing": ["写作", "write", "文案", "文章"],
    "coding": ["编程", "code", "代码", "程序"],
    "translation": ["翻译", "translate"],
    "education": ["教育", "edu", "教学", "学习", "课程"],
    "marketing": ["营销", "marketing", "推广", "广告", "品牌"],
}

# 同义词 key → 虚拟分类：q 搜「电商」时把 ecommerce 关键词也纳入扩展词
SYNONYM_VIRTUAL_ALIASES: Dict[str, str] = {
    "视频": "video",
    "写作": "writing",
    "编程": "coding",
    "翻译": "translation",
    "教育": "education",
    "营销": "marketing",
}

# 搜索同义词：q 精确命中为 0 时用扩展词 OR 匹配（命中 key 或 key 包含 q）
SEARCH_SYNONYMS: Dict[str, List[str]] = {
    "电商": ["商品", "网店", "店铺", "淘宝", "京东", "营销", "带货", "详情页"],
    "视频": ["video", "短视频", "剪辑"],
    "写作": ["write", "文案", "文章"],
    "编程": ["code", "代码", "程序"],
    "翻译": ["translate", "翻译"],
    "设计": ["design", "海报", "排版"],
    "简历": ["resume", "求职"],
    "论文": ["paper", "学术"],
    "小红书": ["种草", "笔记"],
    "ppt": ["演示", "幻灯片"],
    "表格": ["excel", "数据"],
}

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


class PromptLibraryUpstreamError(Exception):
    """上游提示词接口不可用（失败页数超限 / 首屏抓取失败）。"""


_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_memory_cache: Dict[str, Any] = {"items": None, "fetched_at": 0.0, "stale": False}
_refresh_lock: Optional[asyncio.Lock] = None


# ---------------------------------------------------------------- 路径 / 时间

def data_dir() -> str:
    """与 main.py 的 DATA_DIR 一致：NOVAI_DATA_DIR/data，否则 <repo>/data。"""
    root = os.environ.get("NOVAI_DATA_DIR") or _REPO_ROOT
    return os.path.join(root, "data")


def cache_file_path() -> str:
    return os.path.join(data_dir(), CACHE_FILE_NAME)


def _now() -> float:
    return time.time()


def _cache_fresh(fetched_at: float) -> bool:
    try:
        ts = float(fetched_at or 0)
    except (TypeError, ValueError):
        return False
    return ts > 0 and (_now() - ts) <= CACHE_TTL_SECONDS


def _get_lock() -> asyncio.Lock:
    global _refresh_lock
    if _refresh_lock is None:
        _refresh_lock = asyncio.Lock()
    return _refresh_lock


def _cache_meta(fetched_at: Any, stale: bool) -> Dict[str, Any]:
    """响应里的缓存元信息：updatedAt / stale / ageSeconds（缺失给 null）。"""
    try:
        ts = float(fetched_at) if fetched_at else 0.0
    except (TypeError, ValueError):
        ts = 0.0
    if ts <= 0:
        return {"updatedAt": None, "stale": bool(stale), "ageSeconds": None}
    return {
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)),
        "stale": bool(stale),
        "ageSeconds": int(max(0, _now() - ts)),
    }


def reset_memory_cache() -> None:
    """清空进程内缓存（测试 / 维护用）。"""
    _memory_cache["items"] = None
    _memory_cache["fetched_at"] = 0.0
    _memory_cache["stale"] = False


# ---------------------------------------------------------------- 抓取

async def fetch_page(page: int) -> Dict[str, Any]:
    """抓上游单页（每页 25 条，超时 15s）。测试里 monkeypatch 这个函数即可不联网。"""
    params = {
        "pagination[page]": int(page),
        "pagination[pageSize]": UPSTREAM_PAGE_SIZE,
    }
    async with httpx.AsyncClient(
        timeout=PAGE_TIMEOUT_SECONDS,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        follow_redirects=True,
    ) as client:
        resp = await client.get(UPSTREAM_URL, params=params)
        resp.raise_for_status()
        payload = resp.json()
    if not isinstance(payload, dict):
        raise ValueError("上游返回格式异常")
    return payload


async def fetch_all_upstream() -> List[Dict[str, Any]]:
    """一次抓全量：先拿第 1 页得到 pageCount，再抓其余页；失败页数 > 2 直接报错。"""
    failed = 0
    first: Optional[Dict[str, Any]] = None
    for _attempt in range(2):
        try:
            first = await fetch_page(1)
            break
        except Exception:
            failed += 1
    if first is None:
        raise PromptLibraryUpstreamError("上游第 1 页抓取失败")

    meta = first.get("meta") if isinstance(first.get("meta"), dict) else {}
    pagination = meta.get("pagination") if isinstance(meta.get("pagination"), dict) else {}
    page_count = pagination.get("pageCount") or pagination.get("page_count") or DEFAULT_UPSTREAM_PAGES
    try:
        page_count = int(page_count)
    except (TypeError, ValueError):
        page_count = DEFAULT_UPSTREAM_PAGES
    page_count = max(1, min(page_count, MAX_UPSTREAM_PAGES_CAP))

    pages: List[Dict[str, Any]] = [first]
    for page in range(2, page_count + 1):
        try:
            pages.append(await fetch_page(page))
        except Exception:
            failed += 1
    if failed > MAX_FAILED_PAGES:
        raise PromptLibraryUpstreamError("上游失败页数 %d > %d" % (failed, MAX_FAILED_PAGES))
    return pages


# ---------------------------------------------------------------- 清洗

def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        for key in ("text", "value", "name", "title", "prompt"):
            if isinstance(value.get(key), str):
                return value[key].strip()
    return ""


def _lang_block(attributes: Dict[str, Any], lang: str) -> Dict[str, str]:
    raw = attributes.get(lang) if isinstance(attributes.get(lang), dict) else {}
    return {
        "title": _as_text(raw.get("title")),
        "remark": _as_text(raw.get("remark")),
        "description": _as_text(raw.get("description")),
        "prompt": _as_text(raw.get("prompt")),
    }


def _norm_tags(value: Any) -> List[str]:
    out: List[str] = []

    def add(item: Any) -> None:
        if isinstance(item, str):
            for part in re.split(r"[,，]+", item):
                text = part.strip()
                if text and text not in out:
                    out.append(text)
        elif isinstance(item, dict):
            for key in ("name", "title", "text", "value"):
                if isinstance(item.get(key), str):
                    add(item[key])
                    break

    if isinstance(value, list):
        for item in value:
            add(item)
    elif value is not None:
        add(value)
    return out


def normalize_card(card: Any) -> Optional[Dict[str, Any]]:
    try:
        if not isinstance(card, dict):
            return None
        attributes = card.get("attributes") if isinstance(card.get("attributes"), dict) else {}
        zh = _lang_block(attributes, "zh")
        en = _lang_block(attributes, "en")
        if not zh["title"] and not en["title"]:
            return None  # 丢弃无 title 条目
        card_id = card.get("id")
        id_text = "" if card_id is None else str(card_id)
        try:
            count = int(attributes.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        return {
            "id": id_text,
            "source": SOURCE,
            "zh": zh,
            "en": en,
            "tags": _norm_tags(attributes.get("tags")),
            "count": max(0, count),
            "url": COMMUNITY_URL % id_text,
        }
    except Exception:
        return None


def normalize_pages(pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    seen = set()
    for page in pages or []:
        if not isinstance(page, dict):
            continue
        data = page.get("data")
        if not isinstance(data, list):
            continue
        for card in data:
            item = normalize_card(card)
            if not item:
                continue
            key = item.get("id") or item.get("url")
            if key in seen:
                continue
            seen.add(key)
            items.append(item)
    return items


def project_item(item: Dict[str, Any], lang: str) -> Dict[str, Any]:
    primary = item.get(lang) if isinstance(item.get(lang), dict) else {}
    other_key = "en" if lang == "zh" else "zh"
    fallback = item.get(other_key) if isinstance(item.get(other_key), dict) else {}

    def pick(key: str) -> str:
        return _as_text(primary.get(key)) or _as_text(fallback.get(key))

    return {
        "id": item.get("id") or "",
        "source": item.get("source") or SOURCE,
        "title": pick("title"),
        "remark": pick("remark"),
        "description": pick("description"),
        "prompt": pick("prompt"),
        "tags": item.get("tags") or [],
        "count": item.get("count") or 0,
        "url": item.get("url") or "",
    }


# ---------------------------------------------------------------- 搜索 / 虚拟分类

def _text_blob(item: Dict[str, Any]) -> str:
    """zh/en 的 title/remark/prompt 拼成小写串（虚拟分类只按这些字段匹配，不含 tags）。"""
    parts: List[str] = []
    for lang in ("zh", "en"):
        block = item.get(lang) if isinstance(item.get(lang), dict) else {}
        for field in ("title", "remark", "prompt"):
            parts.append(str(block.get(field) or ""))
    return " ".join(parts).lower()


def _search_blob(item: Dict[str, Any]) -> str:
    """搜索用：_text_blob + tags。"""
    parts = [_text_blob(item)]
    for tag in (item.get("tags") or []):
        parts.append(str(tag))
    return " ".join(parts).lower()


def _filter_items_by_terms(items: List[Dict[str, Any]], terms: List[str]) -> List[Dict[str, Any]]:
    lowered = [str(term).strip().lower() for term in terms if str(term).strip()]
    if not lowered:
        return []
    selected: List[Dict[str, Any]] = []
    for item in items:
        blob = _search_blob(item)
        if any(term in blob for term in lowered):
            selected.append(item)
    return selected


def _matches_virtual_keywords(item: Dict[str, Any], keywords: List[str]) -> bool:
    blob = _text_blob(item)
    return any(str(keyword).strip().lower() in blob for keyword in keywords if str(keyword).strip())


def matches_virtual_category(item: Dict[str, Any], keywords: List[str]) -> bool:
    return _matches_virtual_keywords(item, keywords)


def _filter_by_virtual_keywords(items: List[Dict[str, Any]], keywords: List[str]) -> List[Dict[str, Any]]:
    return [item for item in items if _matches_virtual_keywords(item, keywords)]


def _merge_virtual_tag_aliases(items: List[Dict[str, Any]], counts: Dict[str, int]) -> Dict[str, int]:
    """把与虚拟 key 同义的别真实 tags 合并进虚拟 key：count = 虚拟命中 ∪ 这些 tag 命中。"""
    for virtual_key, alias_tags in VIRTUAL_TAG_ALIASES.items():
        if virtual_key not in VIRTUAL_CATEGORIES:
            continue
        target_lower = set(str(tag).strip().lower() for tag in alias_tags)
        target_lower.add(virtual_key.lower())
        matched_real = [key for key in list(counts.keys()) if key.lower() in target_lower]
        if not matched_real:
            continue
        union_ids = set()
        for item in items:
            item_id = str(item.get("id"))
            if _matches_virtual_keywords(item, VIRTUAL_CATEGORIES[virtual_key]):
                union_ids.add(item_id)
                continue
            tag_values = set(str(value).strip().lower() for value in (item.get("tags") or []))
            if tag_values & target_lower:
                union_ids.add(item_id)
        for key in matched_real:
            counts.pop(key, None)
        counts[virtual_key] = len(union_ids)
    return counts


def _virtual_category_counts(items: List[Dict[str, Any]], real_keys: List[str]) -> Dict[str, int]:
    """真实 tag 优先：同名（不区分大小写）不重复追加。"""
    existing = set(str(key).lower() for key in real_keys)
    counts: Dict[str, int] = {}
    for key, keywords in VIRTUAL_CATEGORIES.items():
        if key.lower() in existing:
            continue
        matched = len(_filter_by_virtual_keywords(items, keywords))
        if matched > 0:
            counts[key] = matched
    return counts


def _synonym_expansion(query: str) -> List[str]:
    lowered = str(query or "").strip().lower()
    if not lowered:
        return []
    terms: List[str] = []
    seen = set()

    def add(term: Any) -> None:
        text = str(term).strip()
        if not text:
            return
        key = text.lower()
        if key in seen:
            return
        seen.add(key)
        terms.append(text)

    matched_keys: List[str] = []
    for key in SEARCH_SYNONYMS:
        key_lower = key.lower()
        if lowered in key_lower or key_lower in lowered:
            matched_keys.append(key)
            for term in SEARCH_SYNONYMS[key]:
                add(term)
    # 虚拟分类关键词也纳入扩展词：搜「电商」不应空结果（listing/商品/主图…）
    for key in matched_keys:
        alias = SYNONYM_VIRTUAL_ALIASES.get(key)
        if alias and alias in VIRTUAL_CATEGORIES:
            for term in VIRTUAL_CATEGORIES[alias]:
                add(term)
    return terms


def _fuzzy_fragments(query: str) -> List[str]:
    """把 q 拆成 2 字 / 2 字母片段（'电商'→['电商']；'ecom'→['ec','co','om']）。"""
    fragments: List[str] = []
    for chunk in re.split(r"[^0-9a-zA-Z\u4e00-\u9fff]+", str(query or "").lower()):
        if not chunk:
            continue
        if len(chunk) <= 2:
            pieces = [chunk]
        else:
            pieces = [chunk[index:index + 2] for index in range(len(chunk) - 1)]
        for piece in pieces:
            if piece and piece not in fragments:
                fragments.append(piece)
    return fragments


def _fuzzy_search(items: List[Dict[str, Any]], query: str) -> List[Dict[str, Any]]:
    fragments = _fuzzy_fragments(query)
    if not fragments:
        return []
    scored: List[Tuple[int, int, Dict[str, Any]]] = []
    for index, item in enumerate(items):
        blob = _search_blob(item)
        score = sum(1 for fragment in fragments if fragment in blob)
        if score > 0:
            scored.append((score, index, item))
    scored.sort(key=lambda entry: (-entry[0], entry[1]))
    return [entry[2] for entry in scored]


def _is_ecommerce_query(query: str) -> bool:
    lowered = str(query or "").strip().lower()
    if not lowered:
        return False
    return any(word.lower() in lowered or lowered in word.lower() for word in ECOMMERCE_SEARCH_WORDS)


def _ecommerce_expanded_terms() -> List[str]:
    """本地精选中实际出现的电商词 + 电商同义词（作为 expandedTerms）。"""
    terms: List[str] = []
    seen = set()

    def add(term: Any) -> None:
        text = str(term).strip()
        if not text or text.lower() in seen:
            return
        seen.add(text.lower())
        terms.append(text)

    blob = " ".join(_text_blob(prompt) for prompt in LOCAL_ECOMMERCE_PROMPTS).lower()
    for word in ECOMMERCE_SEARCH_WORDS:
        if word.lower() in blob:
            add(word)
    for word in SEARCH_SYNONYMS.get("电商", []):
        add(word)
    return terms


def _ecommerce_search(items: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], str, List[str]]:
    """电商意图搜索：结果必含本地精选 10 条（排最前），再补关键词命中的上游条目。"""
    terms = _ecommerce_expanded_terms()
    local_ids = set(str(prompt.get("id")) for prompt in LOCAL_ECOMMERCE_PROMPTS)
    locals_ = [item for item in items if str(item.get("id")) in local_ids]
    matched = _filter_items_by_terms(items, terms)
    others = [item for item in matched if str(item.get("id")) not in local_ids]
    return locals_ + others, "expanded", terms


def apply_search(items: List[Dict[str, Any]], query: str) -> Tuple[List[Dict[str, Any]], str, List[str]]:
    """三段式搜索：exact → expanded → fuzzy；电商意图优先走本地精选。"""
    text = str(query or "").strip()
    if not text:
        return items, "none", []
    if _is_ecommerce_query(text):
        return _ecommerce_search(items)
    lowered = text.lower()

    exact = _filter_items_by_terms(items, [lowered])
    if exact:
        return exact, "exact", []

    expanded_terms = _synonym_expansion(lowered)
    if expanded_terms:
        expanded = _filter_items_by_terms(items, expanded_terms)
        if expanded:
            return expanded, "expanded", expanded_terms

    fuzzy = _fuzzy_search(items, text)
    if fuzzy:
        return fuzzy, "fuzzy", []
    return [], "none", []


# ---------------------------------------------------------------- 磁盘缓存

def _read_disk_cache() -> Optional[Dict[str, Any]]:
    path = cache_file_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return None
    try:
        fetched_at = float(data.get("fetched_at") or 0)
    except (TypeError, ValueError):
        return None
    if fetched_at <= 0:
        return None
    return {"fetched_at": fetched_at, "items": data["items"]}


def _write_disk_cache(items: List[Dict[str, Any]], fetched_at: float) -> None:
    path = cache_file_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"source": SOURCE, "fetched_at": fetched_at, "items": items}, fh, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        pass  # 写盘失败不影响本次返回


def _with_local_prompts(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """合并内置电商精选（按 id 去重）；缓存里只存上游数据，避免重复写盘。"""
    try:
        merged = list(items or [])
        existing = set(str(item.get("id")) for item in merged)
        for prompt in LOCAL_ECOMMERCE_PROMPTS:
            if str(prompt.get("id")) not in existing:
                merged.append(prompt)
        return merged
    except Exception:
        return items


def _fresh_memory_cache() -> Optional[Tuple[List[Dict[str, Any]], bool, float]]:
    items = _memory_cache.get("items")
    fetched_at = float(_memory_cache.get("fetched_at") or 0)
    if isinstance(items, list) and _cache_fresh(fetched_at):
        return items, bool(_memory_cache.get("stale")), fetched_at
    return None


# ---------------------------------------------------------------- 对外取数

async def get_items(refresh: bool = False) -> Tuple[List[Dict[str, Any]], bool, float]:
    """返回 (items, stale, fetched_at)。

    - 进程内缓存新鲜 → 直接返回（refresh=True 时强制重新抓取）；
    - 新进程 / 冷缓存 → 拉上游；磁盘缓存只在「上游失败且未过期」时兜底，带 stale:true。
    """
    if not refresh:
        cached = _fresh_memory_cache()
        if cached is not None:
            return _with_local_prompts(cached[0]), cached[1], cached[2]
    try:
        async with _get_lock():
            if not refresh:
                cached = _fresh_memory_cache()
                if cached is not None:
                    return _with_local_prompts(cached[0]), cached[1], cached[2]
            pages = await fetch_all_upstream()
            items = normalize_pages(pages)
            fetched_at = _now()
            _memory_cache["items"] = items
            _memory_cache["fetched_at"] = fetched_at
            _memory_cache["stale"] = False
            _write_disk_cache(items, fetched_at)
            return _with_local_prompts(items), False, fetched_at
    except Exception as exc:
        disk = _read_disk_cache()
        if disk and _cache_fresh(disk["fetched_at"]):
            # 上游失败但磁盘缓存未过期：返回缓存并标记 stale
            _memory_cache["items"] = disk["items"]
            _memory_cache["fetched_at"] = disk["fetched_at"]
            _memory_cache["stale"] = True
            return _with_local_prompts(disk["items"]), True, disk["fetched_at"]
        if isinstance(exc, PromptLibraryUpstreamError):
            raise
        raise PromptLibraryUpstreamError("%s: %s" % (type(exc).__name__, exc))


# ---------------------------------------------------------------- 路由

@router.get("/online")
async def online_prompt_library(
    q: Optional[str] = None,
    tag: Optional[str] = None,
    page: int = 1,
    pageSize: int = DEFAULT_PAGE_SIZE,
    lang: str = "zh",
    refresh: bool = False,
) -> Any:
    try:
        page_no = max(1, int(page or 1))
    except (TypeError, ValueError):
        page_no = 1
    try:
        size = int(pageSize or DEFAULT_PAGE_SIZE)
    except (TypeError, ValueError):
        size = DEFAULT_PAGE_SIZE
    size = max(1, min(size, MAX_PAGE_SIZE))
    language = "en" if str(lang or "").strip().lower() == "en" else "zh"

    try:
        items, stale, fetched_at = await get_items(refresh=bool(refresh))
    except PromptLibraryUpstreamError as exc:
        return JSONResponse(
            status_code=502,
            content={"ok": False, "error": "上游提示词接口不可用: " + str(exc)[:300]},
        )

    # tag：真实 tag 优先；否则按虚拟分类关键词过滤（ecommerce/video/writing/...）
    tag_query = str(tag or "").strip().lower()
    if tag_query:
        real_keys = set()
        for item in items:
            for value in (item.get("tags") or []):
                real_keys.add(str(value).strip().lower())
        if tag_query in real_keys:
            items = [
                item for item in items
                if any(tag_query == str(value).strip().lower() for value in (item.get("tags") or []))
            ]
        elif tag_query in VIRTUAL_CATEGORIES:
            items = _filter_by_virtual_keywords(items, VIRTUAL_CATEGORIES[tag_query])
        else:
            items = []

    # q：三段式智能搜索（exact → 同义词扩展 → 字词模糊），与 tag 可组合
    items, match_mode, expanded_terms = apply_search(items, str(q or "").strip())
    projected = [project_item(item, language) for item in items]

    total = len(projected)
    page_count = max(1, (total + size - 1) // size) if total else 1
    start = (page_no - 1) * size
    page_items = projected[start:start + size] if start < total else []

    payload: Dict[str, Any] = {
        "ok": True,
        "source": SOURCE,
        "total": total,
        "page": page_no,
        "pageSize": size,
        "pageCount": page_count,
        "items": page_items,
        "matchMode": match_mode,
        "expandedTerms": expanded_terms,
    }
    payload.update(_cache_meta(fetched_at, stale))
    return payload


@router.get("/online/categories")
async def online_prompt_library_categories(refresh: bool = False) -> Any:
    """标签分类统计：{ok, total, items:[{key, count}]}，count 降序、key 升序兜底。"""
    try:
        items, stale, fetched_at = await get_items(refresh=bool(refresh))
    except PromptLibraryUpstreamError as exc:
        return JSONResponse(
            status_code=502,
            content={"ok": False, "error": "上游提示词接口不可用: " + str(exc)[:300]},
        )
    if not items:
        return JSONResponse(status_code=502, content={"ok": False, "error": "提示词缓存为空"})
    counts: Dict[str, int] = {}
    for item in items:
        for value in (item.get("tags") or []):
            key = str(value).strip()
            if not key:
                continue
            counts[key] = counts.get(key, 0) + 1
    # 别名合并：writing←write / coding←code / translation←interpreter / education←pedagogy
    counts = _merge_virtual_tag_aliases(items, counts)
    # 其余虚拟分类（ecommerce/video/marketing 等）：真实 tag 同名优先，不重复追加
    for key, count in _virtual_category_counts(items, list(counts.keys())).items():
        counts[key] = count
    # 隐藏无语义价值的 tag（tag=contribute 请求仍可用）
    for key in [k for k in list(counts.keys()) if k.lower() in HIDDEN_CATEGORY_KEYS]:
        counts.pop(key, None)
    entries = [{"key": key, "count": count} for key, count in counts.items()]
    entries.sort(key=lambda entry: (-entry["count"], entry["key"]))
    payload: Dict[str, Any] = {"ok": True, "total": len(items), "items": entries}
    payload.update(_cache_meta(fetched_at, stale))
    return payload
