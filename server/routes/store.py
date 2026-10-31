#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""应用市场（App Store）目录 API —— 数据源是上游应用市场的 83 条（server/store_data/）。

契约：
    GET    /api/store/catalog                      -> {items, categories, counts, visible_counts, featured, trending_use_cases, content_version}
    GET    /api/store/items/{kind}/{name}          -> {item}（该条详情 + installed）
    POST   /api/store/items/{kind}/{name}/install  -> {installed: true}
    DELETE /api/store/items/{kind}/{name}/install  -> {installed: false}
    POST   /api/store/items/{kind}/{name}/launch   -> {canvas_id, prompt, auto_send}

数据与落盘：
- 目录/详情只读 data/store/（catalog.json + details/<kind>__<name>.json），**不再读**
  server/skills/registry 与 server/agents/registry —— 应用市场里只有上游这 83 条；
- 安装态落 <DATA_DIR>/store_installed.json（数组，元素 "kind:name"）；
- launch 只做「编译提示词 + 新建画布并返回」，不在这里跑模型、不调用上游。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from server.routes.deps import deps

router = APIRouter(prefix="/api/store")

STORE_KINDS = ("skill", "app")
STORE_INSTALLED_FILE = "store_installed.json"
CATALOG_FILE = "catalog.json"
CURATION_FILE = "curation.json"
DETAILS_DIRNAME = "details"
# skill_ref 的内部引用前缀（不显示在界面上）：新数据一律 store:<技能id>，
# 解析端仍兼容历史前缀（见 main.py 的 _agent_store_skill_manual）
SKILL_REF_PREFIX = "store:"
SKILL_INSTRUCTIONS_DIRNAME = "skill_instructions"
SKILL_GENERATED_DIRNAME = "generated"      # 没有原始正文的条目：由公开元数据整理的等价手册
SKILL_INDEX_FILE = "_index.json"
SKILL_BODY_MAX_CHARS = 30000          # 正文超过 3 万字截断（原始最大 61627 字）
SKILL_BODY_TRUNCATED_NOTE = "（已截断）"


# ---------------------------------------------------------------- 路径

def _repo_root() -> str:
    # server/routes/store.py -> server/routes -> server -> 仓库根
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def data_dir() -> str:
    """运行时数据目录：main 启动时把 DATA_DIR 绑进 deps；测试/独立运行用 NOVAI_DATA_DIR 兜底。"""
    bound = deps.get("DATA_DIR")
    if bound:
        return str(bound)
    root = os.environ.get("NOVAI_DATA_DIR") or _repo_root()
    return os.path.join(root, "data")


def store_dir() -> str:
    """商店数据目录：优先运行时 DATA_DIR/store，其次仓库自带的 server/store_data。

    data/ 整个目录在 .gitignore 里（防止误提交用户数据），所以可提交的数据副本放在
    server/store_data/；运行时若数据目录下已有 store/（部署时拷进去），以它为准。
    """
    runtime = os.path.join(data_dir(), "store")
    if os.path.isdir(runtime):
        return runtime
    return os.path.join(_repo_root(), "server", "store_data")


def installed_path() -> str:
    return os.path.join(data_dir(), STORE_INSTALLED_FILE)


def _read_json(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _atomic_writer():
    """复用 main.py 的 write_json_atomic（临时文件 + fsync + os.replace），不另造一份。

    不能顶层 import main（会循环/二次加载）；运行时按实际模块名取：
    python main.py 时是 __main__，uvicorn main:app 或单测 import main 时是 main。
    """
    for name in ("main", "__main__"):
        module = sys.modules.get(name)
        writer = getattr(module, "write_json_atomic", None) if module is not None else None
        if callable(writer):
            return writer
    raise HTTPException(status_code=500, detail="write_json_atomic 未初始化：store 路由必须在 main.py 进程内运行")


# ---------------------------------------------------------------- 安装态

def load_installed() -> List[str]:
    """读取安装态；文件缺失/损坏一律当空（不能因为一个坏文件让商店页打不开）。"""
    data = _read_json(installed_path(), [])
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        key = str(item or "").strip()
        if key and key not in out:
            out.append(key)
    return out


def save_installed(keys: List[str]) -> None:
    _atomic_writer()(installed_path(), [str(k) for k in keys], indent=2)


# ---------------------------------------------------------------- 目录与详情

def load_catalog_payload() -> Dict[str, Any]:
    """catalog.json 原样保存了抓取响应（含 {"code","data"} 外壳）；这里取出 data 段。"""
    payload = _read_json(os.path.join(store_dir(), CATALOG_FILE), {})
    data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else payload
    return data if isinstance(data, dict) else {}


def load_curation() -> Dict[str, Any]:
    data = _read_json(os.path.join(store_dir(), CURATION_FILE), {})
    return data if isinstance(data, dict) else {}


def _curate_item(item: Dict[str, Any], curation: Dict[str, Any]) -> Dict[str, Any]:
    key = "%s:%s" % (item.get("kind") or "", item.get("name") or "")
    roots = set(curation.get("root_items") or [])
    unavailable = set(curation.get("unavailable_items") or [])
    available = key not in unavailable
    item["store_visible"] = (key in roots) if roots else available
    item["store_available"] = available
    if not available:
        item["enabled"] = False
    return item


def _catalog_index() -> Dict[Tuple[str, str], Dict[str, Any]]:
    index = {}
    for item in (load_catalog_payload().get("items") or []):
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip().lower()
        name = str(item.get("name") or "").strip()
        if kind in STORE_KINDS and name:
            index[(kind, name)] = item
    return index


def _safe_name(value: str) -> str:
    """详情文件名直接用条目 name；只允许安全字符，避免 ../ 之类的路径穿越。"""
    text = str(value or "").strip()
    if not text or not all(ch.isalnum() or ch in "._-" for ch in text):
        return ""
    return text


def _detail_path(kind: str, name: str) -> str:
    return os.path.join(store_dir(), DETAILS_DIRNAME, "%s__%s.json" % (kind, name))


def load_detail(kind: str, name: str) -> Optional[Dict[str, Any]]:
    """读取该条详情（文件内容就是上游响应的 ["data"]）；缺失或 null 返回 None 由调用方降级。"""
    safe = _safe_name(name)
    if not safe:
        return None
    data = _read_json(_detail_path(kind, safe), None)
    return data if isinstance(data, dict) else None


def _resolve(kind: str, name: str) -> Dict[str, Any]:
    """按 (kind, name) 取目录条目；非法 kind / 不存在的 name 一律 404。"""
    clean_kind = str(kind or "").strip().lower()
    clean_name = str(name or "").strip()
    if clean_kind not in STORE_KINDS or not clean_name:
        raise HTTPException(status_code=404,
                            detail="商店条目不存在：%s/%s" % (clean_kind or "<空>", clean_name or "<空>"))
    entry = _catalog_index().get((clean_kind, clean_name))
    if not entry:
        raise HTTPException(status_code=404, detail="商店条目不存在：%s/%s" % (clean_kind, clean_name))
    return entry


def _installed_flag(kind: str, name: str, installed: List[str]) -> bool:
    return ("%s:%s" % (kind, name)) in installed


def build_catalog() -> Dict[str, Any]:
    """商店首页：目录条目（每条补 installed）+ 分类 + 计数 + featured / trending。"""
    data = load_catalog_payload()
    curation = load_curation()
    installed = load_installed()
    items = []
    for raw in (data.get("items") or []):
        if not isinstance(raw, dict):
            continue
        item = _curate_item(dict(raw), curation)
        item["installed"] = _installed_flag(str(item.get("kind") or ""), str(item.get("name") or ""), installed)
        items.append(item)
    visible = [item for item in items if item["store_visible"]]
    return {
        "items": items,
        "categories": data.get("categories") or [],
        "counts": {"all": len(items),
                   "skill": sum(1 for item in items if item.get("kind") == "skill"),
                   "app": sum(1 for item in items if item.get("kind") == "app")},
        "visible_counts": {"all": len(visible),
                           "skill": sum(1 for item in visible if item.get("kind") == "skill"),
                           "app": sum(1 for item in visible if item.get("kind") == "app")},
        "featured": data.get("featured") or [],
        "trending_use_cases": data.get("trending_use_cases") or [],
        "content_version": data.get("content_version") or "",
    }


def _skill_instructions_dir() -> str:
    return os.path.join(store_dir(), SKILL_INSTRUCTIONS_DIRNAME)


def _skill_index() -> Dict[str, Any]:
    data = _read_json(os.path.join(_skill_instructions_dir(), SKILL_INDEX_FILE), {})
    return data if isinstance(data, dict) else {}


def _original_body_path(key: str) -> str:
    return os.path.join(_skill_instructions_dir(), key + ".md")


def _generated_body_path(key: str) -> str:
    return os.path.join(_skill_instructions_dir(), SKILL_GENERATED_DIRNAME, key + ".md")


def skill_body_source_for_key(key: str) -> str:
    """该 key 的正文来源："original"（上游原始手册）/ "generated"（公开元数据整理稿）/ ""。"""
    key = str(key or "").strip()
    if not key:
        return ""
    if os.path.isfile(_original_body_path(key)):
        return "original"
    if os.path.isfile(_generated_body_path(key)):
        return "generated"
    return ""


def skill_body_key(item: Dict[str, Any]) -> str:
    """该条目能挂哪份技能正文：优先 name，其次 activation_skill（原始或 generated 有文件即可）。"""
    index = _skill_index()
    for candidate in (str(item.get("name") or "").strip(), str(item.get("activation_skill") or "").strip()):
        if not candidate:
            continue
        if candidate in index or skill_body_source_for_key(candidate):
            return candidate
    return ""


def skill_body_source(item: Dict[str, Any]) -> str:
    """条目的正文来源（三态）；没有正文返回空串。"""
    return skill_body_source_for_key(skill_body_key(item))


def load_skill_body(item: Dict[str, Any]) -> Optional[str]:
    """读取技能正文：原始正文优先，其次 generated 整理稿；都没有返回 None。"""
    key = skill_body_key(item)
    if not key:
        return None
    source = skill_body_source_for_key(key)
    if not source:
        return None
    path = _original_body_path(key) if source == "original" else _generated_body_path(key)
    text = _read_md(path)
    return text or None


def skill_body_by_id(skill_id: str) -> str:
    """按技能 id 读正文（给 /api/agent/run 的 skill_ref 用）。读不到返回空串。

    查找顺序：直接 <id>.md（原始 → generated）→ 目录里 name == id 的条目 →
    activation_skill == id 的条目（后两种用来兼容前端拿条目名而不是激活技能名当 ref 的情况）。
    """
    key = str(skill_id or "").strip()
    if not key:
        return ""
    source = skill_body_source_for_key(key)
    if source:
        path = _original_body_path(key) if source == "original" else _generated_body_path(key)
        return _read_md(path)
    items = (load_catalog_payload().get("items") or [])
    for field in ("name", "activation_skill"):
        for item in items:
            if isinstance(item, dict) and str(item.get(field) or "").strip() == key:
                body = load_skill_body(item)
                if body:
                    return body
    return ""


def _read_md(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except Exception:
        return ""


def truncate_skill_body(body: Any) -> str:
    """正文统一按 30000 字截断并标注（系统提示与详情展示共用同一口径）。"""
    text = str(body or "")
    if len(text) > SKILL_BODY_MAX_CHARS:
        return text[:SKILL_BODY_MAX_CHARS] + SKILL_BODY_TRUNCATED_NOTE
    return text


def skill_manual_text(body: Any) -> str:
    """系统提示里的技能手册段落（【技能执行手册】+ 正文，不含【用户输入】包装）。"""
    return "【技能执行手册】\n" + truncate_skill_body(body).strip()


DETAIL_UNAVAILABLE_REASON = "该应用详情由上游暂不提供"


def build_detail(kind: str, name: str) -> Dict[str, Any]:
    """详情：上游 detail 优先；上游 404（本地 null）时回退成 catalog 条目 + 明确的降级标记。"""
    entry = _resolve(kind, name)
    detail = load_detail(kind, name)
    unavailable = not isinstance(detail, dict)
    item = dict(detail if not unavailable else entry)
    item.setdefault("kind", entry.get("kind"))
    item.setdefault("name", entry.get("name"))
    item = _curate_item(item, load_curation())
    item["installed"] = _installed_flag(kind, name, load_installed())
    if unavailable:
        # 上游没给详情：不假装有，前端据此渲染「暂无详情」降级页
        item["detail_unavailable"] = True
        item["detail_unavailable_reason"] = DETAIL_UNAVAILABLE_REASON
    body = load_skill_body(item)
    item["has_skill_body"] = bool(body)
    item["skill_body_chars"] = len(body or "")
    item["skill_body_source"] = skill_body_source(item) if body else ""
    return item


# ---------------------------------------------------------------- launch（编译提示词）

class StoreLaunchRequest(BaseModel):
    preset_id: str = ""
    inputs: Dict[str, Any] = {}
    references: List[Dict[str, Any]] = []
    # 已废弃（deprecated）：技能正文不再塞进 instruction（会超 4000 字上限），
    # 改成 launch 返回 skill_ref、由 /api/agent/run 注入系统提示。传 true 也只保留兼容，不再改变 prompt。
    include_skill_body: bool = False


def _text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "、".join(_text(item) for item in value if _text(item))
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def _find_preset(detail: Dict[str, Any], preset_id: str) -> Optional[Dict[str, Any]]:
    gallery = detail.get("preset_gallery") if isinstance(detail.get("preset_gallery"), dict) else {}
    for preset in (gallery.get("presets") or []):
        if isinstance(preset, dict) and str(preset.get("id") or "") == preset_id:
            return preset
    return None


def _field_labels(detail: Dict[str, Any], preset: Optional[Dict[str, Any]]) -> Dict[str, str]:
    """字段 id -> 展示名：优先 preset.inputs.fields，其次详情级的 try_form.fields。"""
    table: Dict[str, str] = {}

    def eat(form: Any) -> None:
        if not isinstance(form, dict):
            return
        for field in (form.get("fields") or []):
            if isinstance(field, dict) and str(field.get("id") or "").strip():
                fid = str(field["id"]).strip()
                table[fid] = str(field.get("label") or fid).strip()

    if isinstance(preset, dict):
        eat(preset.get("inputs"))
    eat(detail.get("try_form"))
    return table


def _input_lines(detail: Dict[str, Any], preset: Optional[Dict[str, Any]],
                 inputs: Optional[Dict[str, Any]]) -> List[str]:
    labels = _field_labels(detail, preset)
    lines = []
    for key, value in (inputs or {}).items():
        text = _text(value)
        if not text:                     # 空值跳过：不留「字段名：」这种空行
            continue
        lines.append("- %s：%s" % (labels.get(str(key), str(key)), text))
    return lines


def _reference_lines(references: Optional[List[Dict[str, Any]]]) -> List[str]:
    lines = []
    for item in (references or []):
        if not isinstance(item, dict):
            continue
        url = _text(item.get("url"))
        if not url:
            continue
        lines.append("- %s：%s" % (_text(item.get("name")) or "参考素材", url))
    return lines


def compile_launch_prompt(detail: Dict[str, Any], preset_id: str = "",
                          inputs: Optional[Dict[str, Any]] = None,
                          references: Optional[List[Dict[str, Any]]] = None
                          ) -> Tuple[str, Optional[Dict[str, Any]]]:
    """把「条目 / 预设 + 表单输入 + 参考素材」编成一段可直接发给画布助手的提示词。

    带 preset_id：模板名 + skill_mention（原样保留）+ preset.agent.prompt；
    不带：detail.starter_prompt（为空退 description）；最后追加输入与参考素材。
    """
    preset = None
    if preset_id:
        preset = _find_preset(detail, preset_id)
        if preset is None:
            raise HTTPException(status_code=400, detail="预设不存在：%s" % preset_id)
    parts: List[str] = []
    if preset is not None:
        title = _text(preset.get("title")) or preset_id
        parts.append("模板：%s" % title)
        agent = preset.get("agent") if isinstance(preset.get("agent"), dict) else {}
        mention = _text(agent.get("skill_mention"))
        if mention:
            parts.append(mention)      # 原样保留（{{skill:xxx:xxx}} 这种形态）
        body = _text(agent.get("prompt")) or _text(preset.get("description"))
        if body:
            parts.append(body)
    else:
        body = _text(detail.get("starter_prompt")) or _text(detail.get("description"))
        if body:
            parts.append(body)
    input_lines = _input_lines(detail, preset, inputs)
    if input_lines:
        parts.append("输入：")
        parts.extend(input_lines)
    reference_lines = _reference_lines(references)
    if reference_lines:
        parts.append("参考素材：")
        parts.extend(reference_lines)
    return "\n".join(parts).strip(), preset


def _canvas_owner_id(request: Request) -> Optional[int]:
    """登录态下的画布归属；auth 关闭时 request.state 上没有 auth_user，返回 None。"""
    user = getattr(getattr(request, "state", None), "auth_user", None)
    if not user:
        return None
    try:
        value = user.get("id") if isinstance(user, dict) else None
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _new_canvas(title: str, request: Request) -> Dict[str, Any]:
    fn = deps.get("NEW_CANVAS")
    if not callable(fn):
        raise HTTPException(status_code=500, detail="画布创建接口未初始化（NEW_CANVAS）")
    return fn(title, _canvas_owner_id(request))


# ---------------------------------------------------------------- 路由

@router.get("/catalog")
def store_catalog():
    """商店首页：83 条目录（每条带 installed）+ 分类/计数 + featured / trending。"""
    return build_catalog()


@router.get("/items/{kind}/{item_id}")
def store_item_detail(kind: str, item_id: str):
    """详情：该条上游详情 + installed（上游 404 的条目回退成目录条目，不 500）。"""
    return {"item": build_detail(kind, item_id)}


@router.post("/items/{kind}/{item_id}/install")
def store_install(kind: str, item_id: str):
    """安装（幂等）：只把 "kind:name" 记进 data/store_installed.json。"""
    entry = _curate_item(_resolve(kind, item_id), load_curation())
    if not entry["store_available"]:
        raise HTTPException(status_code=409, detail="该条目当前未开放")
    key = "%s:%s" % (kind, entry.get("name"))
    keys = load_installed()
    if key not in keys:
        keys.append(key)
        save_installed(keys)
    return {"installed": True}


@router.delete("/items/{kind}/{item_id}/install")
def store_uninstall(kind: str, item_id: str):
    """卸载（幂等）：条目不存在同样 404，避免把拼错的 id 当成「已卸载」。"""
    entry = _resolve(kind, item_id)
    key = "%s:%s" % (kind, entry.get("name"))
    keys = load_installed()
    if key in keys:
        keys = [item for item in keys if item != key]
        save_installed(keys)
    return {"installed": False}


@router.post("/items/{kind}/{item_id}/launch")
def store_launch(kind: str, item_id: str, payload: StoreLaunchRequest, request: Request):
    """启动：编译提示词 + 新建一张画布并返回（不跑模型；前端拿到后跳画布助手自动发送）。"""
    entry = _curate_item(_resolve(kind, item_id), load_curation())
    if not entry["store_available"]:
        raise HTTPException(status_code=409, detail="该条目当前未开放")
    detail = load_detail(kind, item_id) or dict(entry)
    prompt, _preset = compile_launch_prompt(detail, payload.preset_id, payload.inputs, payload.references)
    lookup = dict(detail)
    for key, value in entry.items():
        lookup.setdefault(key, value)
    body = load_skill_body(lookup)
    skill_ref = (SKILL_REF_PREFIX + skill_body_key(lookup)) if body else ""
    canvas = _new_canvas(_text(entry.get("display_name")) or str(entry.get("name") or item_id), request)
    # 正文不进 instruction：前端把 skill_ref 原样传给 /api/agent/run，由后端注入系统提示
    return {"canvas_id": str(canvas.get("id") or ""), "prompt": prompt, "auto_send": True,
            "skill_ref": skill_ref}
