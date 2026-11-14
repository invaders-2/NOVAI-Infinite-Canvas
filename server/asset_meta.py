"""素材「用途」与「产品档案」：纯函数，只读写传进来的资产库 dict，不碰磁盘。

用途（item["use"]）回答「这张素材在工作流里拿来干什么」，技能和画布助手按它取素材：
    product 产品 / model 模特 / scene 场景 / source 源视频 / depth 深度视频 / style 风格参考 / sound 音效
item["use_source"] = "manual" 表示用户或助手明确指定过，AI 分类回来后不再覆盖；
否则是 "auto"，每次分类完成按 infer_use 重新推断。

产品档案存在资产库顶层 lib["products"]：
    {"id", "name", "selling_points", "angles": [{"item_id", "label"}], "created_at", "updated_at"}
角度只引用素材条目 id，不复制文件；条目被删后读取时自动跳过。
"""
from __future__ import annotations

import re
import time
import uuid
from typing import Any, Dict, Iterable, List, Optional, Tuple

ASSET_USES: Dict[str, str] = {
    "product": "产品",
    "model": "模特",
    "scene": "场景",
    "source": "源视频",
    "depth": "深度视频",
    "style": "风格参考",
    "sound": "音效",
}
# 中文名 / 常见写法 → 用途 id（助手和接口都可能传中文）
_USE_ALIASES = {
    **{v: k for k, v in ASSET_USES.items()},
    "商品": "product", "产品图": "product", "人物": "model", "角色": "model", "模特图": "model",
    "背景": "scene", "环境": "scene", "视频": "source", "原视频": "source", "原片": "source",
    "深度": "depth", "深度图": "depth", "风格": "style", "参考": "style", "音频": "sound", "音乐": "sound",
}

_CATEGORY_HINTS: List[Tuple[str, Tuple[str, ...]]] = [
    ("depth", ("深度", "depth")),
    ("product", ("产品", "商品", "product", "goods", "道具", "prop")),
    ("model", ("模特", "人物", "角色", "model", "character", "people")),
    ("scene", ("场景", "背景", "scene", "background")),
    ("style", ("风格", "style", "参考")),
    ("sound", ("音效", "音乐", "sound", "audio", "music")),
]


def normalize_use(value: Any) -> str:
    """把各种写法归一成用途 id；认不出返回空串。"""
    text = str(value or "").strip()
    if not text:
        return ""
    low = text.lower()
    if low in ASSET_USES:
        return low
    return _USE_ALIASES.get(text, _USE_ALIASES.get(low, ""))


def _classification_values(classification: Any, *dims: str) -> List[str]:
    if not isinstance(classification, dict):
        return []
    cats = classification.get("categories") if isinstance(classification.get("categories"), dict) else {}
    out: List[str] = []
    for dim in dims:
        values = cats.get(dim)
        if isinstance(values, list):
            out.extend(str(v) for v in values if v)
    for entry in classification.get("flat") or []:
        if isinstance(entry, dict) and entry.get("dimension") in dims and entry.get("tag"):
            out.append(str(entry["tag"]))
    return out


def infer_use(item: Dict[str, Any], category_name: str = "") -> str:
    """按媒体类型 → 名称 / 文件夹名 → AI 分类推断用途；推不出返回空串。"""
    kind = str(item.get("kind") or "image").lower()
    name = str(item.get("name") or "")
    hay = (name + " " + str(category_name or "")).lower()
    if kind == "audio":
        return "sound"
    if kind == "video":
        return "depth" if ("深度" in hay or "depth" in hay or item.get("derived_from")) else "source"
    for use, needles in _CATEGORY_HINTS:
        if use in ("sound", "depth"):
            continue
        if any(n in hay for n in needles):
            return use
    cls = item.get("classification")
    model_tags = " ".join(_classification_values(cls, "model", "people"))
    subject_tags = " ".join(_classification_values(cls, "subject", "objects"))
    style_tags = " ".join(_classification_values(cls, "use_case"))
    has_person = bool(re.search(r"模特|单人|多人|男性|女性|儿童|半身|全身|手部", model_tags)) and "无人" not in model_tags
    if has_person:
        return "model"
    if re.search(r"产品|商品|鞋|包|服装|饰品|化妆品|食物|电器|家具", subject_tags):
        return "product"
    if re.search(r"风格参考|情绪板|moodboard", style_tags, re.I):
        return "style"
    if _classification_values(cls, "scene", "space", "environment"):
        return "scene"
    return ""


def apply_auto_use(item: Dict[str, Any], category_name: str = "") -> bool:
    """未手动指定过用途时按 infer_use 刷新；返回是否有变化。"""
    if item.get("use_source") == "manual" and normalize_use(item.get("use")):
        return False
    use = infer_use(item, category_name)
    changed = (item.get("use") or "") != use or item.get("use_source") != "auto"
    if use:
        item["use"] = use
        item["use_source"] = "auto"
    else:
        item.pop("use", None)
        item.pop("use_source", None)
    return changed


def set_manual_use(item: Dict[str, Any], use: Any) -> str:
    """明确指定用途（空 / 认不出 = 清掉手动标记，回到自动推断）。返回最终的用途。"""
    norm = normalize_use(use)
    if norm:
        item["use"] = norm
        item["use_source"] = "manual"
        return norm
    item.pop("use_source", None)
    item.pop("use", None)
    return ""


def iter_items(lib: Dict[str, Any]) -> Iterable[Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]]:
    """遍历所有库的所有条目：(library, category, item)。"""
    for library in lib.get("libraries") or []:
        if not isinstance(library, dict):
            continue
        for cat in library.get("categories") or []:
            if not isinstance(cat, dict):
                continue
            for item in cat.get("items") or []:
                if isinstance(item, dict):
                    yield library, cat, item


def find_item(lib: Dict[str, Any], item_id: str = "", url: str = ""):
    """按 id 或 url 找条目，返回 (library, category, item) 或 (None, None, None)。"""
    item_id = str(item_id or "").strip()
    url = str(url or "").strip()
    for library, cat, item in iter_items(lib):
        if (item_id and str(item.get("id") or "") == item_id) or (url and str(item.get("url") or "") == url):
            return library, cat, item
    return None, None, None


def effective_use(item: Dict[str, Any], category_name: str = "") -> str:
    return normalize_use(item.get("use")) or infer_use(item, category_name)


# ---------------------------------------------------------------------------
# 产品档案
# ---------------------------------------------------------------------------

def _now_ms() -> int:
    return int(time.time() * 1000)


def products(lib: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = lib.get("products")
    if not isinstance(rows, list):
        rows = []
        lib["products"] = rows
    return rows


def find_product(lib: Dict[str, Any], product_id: str = "", name: str = "") -> Optional[Dict[str, Any]]:
    product_id = str(product_id or "").strip()
    name = str(name or "").strip()
    for p in products(lib):
        if not isinstance(p, dict):
            continue
        if (product_id and p.get("id") == product_id) or (name and str(p.get("name") or "").strip() == name):
            return p
    return None


def _clean_angles(lib: Dict[str, Any], angles: Any) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    seen = set()
    for raw in angles or []:
        if isinstance(raw, str):
            raw = {"item_id": raw}
        if not isinstance(raw, dict):
            continue
        item_id = str(raw.get("item_id") or "").strip()
        if not item_id and raw.get("url"):
            _, _, found = find_item(lib, url=str(raw.get("url")))
            item_id = str((found or {}).get("id") or "")
        if not item_id or item_id in seen:
            continue
        _, _, item = find_item(lib, item_id=item_id)
        if not item:
            continue
        seen.add(item_id)
        out.append({"item_id": item_id, "label": str(raw.get("label") or "").strip()[:24]})
    return out[:24]


def upsert_product(lib: Dict[str, Any], *, product_id: str = "", name: str = "", selling_points: Optional[str] = None,
                   angles: Any = None, append: bool = False) -> Dict[str, Any]:
    """新建或更新产品档案。同名产品视为同一个（助手说「存成白色运动鞋档案」要能累加角度）。

    angles=None 不动角度；append=True 把新角度追加到已有角度后面（去重），否则整体替换。
    角度里的素材会被标成「产品」用途（手动标记）。
    """
    name = re.sub(r"\s+", " ", str(name or "").strip())[:60]
    product = find_product(lib, product_id=product_id) or (find_product(lib, name=name) if name else None)
    if product is None:
        if not name:
            raise ValueError("产品名称不能为空")
        product = {"id": f"prod_{uuid.uuid4().hex[:10]}", "name": name, "selling_points": "", "angles": [],
                   "created_at": _now_ms()}
        products(lib).append(product)
    elif name:
        product["name"] = name
    if selling_points is not None:
        product["selling_points"] = str(selling_points or "").strip()[:300]
    if angles is not None:
        fresh = _clean_angles(lib, angles)
        if append:
            have = {a.get("item_id") for a in product.get("angles") or []}
            product["angles"] = (product.get("angles") or []) + [a for a in fresh if a["item_id"] not in have]
            product["angles"] = product["angles"][:24]
        else:
            product["angles"] = fresh
        for angle in product["angles"]:
            _, _, item = find_item(lib, item_id=angle["item_id"])
            if item is not None:
                if not (item.get("use_source") == "manual" and normalize_use(item.get("use")) not in ("", "product")):
                    set_manual_use(item, "product")
                item["product_id"] = product["id"]
    product["updated_at"] = _now_ms()
    return product


def delete_product(lib: Dict[str, Any], product_id: str) -> bool:
    rows = products(lib)
    for i, p in enumerate(rows):
        if isinstance(p, dict) and p.get("id") == product_id:
            rows.pop(i)
            for _, _, item in iter_items(lib):
                if item.get("product_id") == product_id:
                    item.pop("product_id", None)
            return True
    return False


def product_view(lib: Dict[str, Any], product: Dict[str, Any]) -> Dict[str, Any]:
    """给接口 / 助手看的产品档案：角度展开成 url，已删除的素材跳过。"""
    angles = []
    for angle in product.get("angles") or []:
        _, _, item = find_item(lib, item_id=angle.get("item_id") or "")
        if not item:
            continue
        angles.append({"item_id": item.get("id"), "label": angle.get("label") or "", "url": item.get("url") or "",
                       "name": item.get("name") or "", "kind": item.get("kind") or "image"})
    return {"id": product.get("id"), "name": product.get("name") or "", "selling_points": product.get("selling_points") or "",
            "angles": angles, "angle_count": len(angles), "created_at": product.get("created_at"),
            "updated_at": product.get("updated_at")}


def link_derived(lib: Dict[str, Any], item: Dict[str, Any], source: str) -> Optional[str]:
    """记下「这个素材由哪个素材生成」（深度视频 → 原视频）。source 可以是条目 id 或 url；返回原条目 id。"""
    source = str(source or "").strip()
    if not source:
        return None
    _, _, origin = find_item(lib, item_id=source, url=source)
    if not origin or origin is item:
        return None
    item["derived_from"] = origin.get("id")
    return str(origin.get("id"))
