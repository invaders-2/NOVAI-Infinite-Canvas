#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""技能注册表：内置默认（server/skills/builtin_skills.json）+ 用户可改的 data/skills/*.json。

契约字段（与智能体一致，前端按 kind='skill' 渲染）：
    id / kind='skill' / name / category / icon / description / tags /
    input_schema / deliverables / skill_prompt / enabled / available

规则与 server/agents/registry.py 保持一致：
- 内置默认来自 sealseek 导出的 16 个技能原文（tools/build_builtin_skills.py 生成），
  只把「读取 / 交付」动作适配成 read_table / write_html_report / write_xlsx；
- data/skills/ 不存在时把内置默认写盘，用户可以直接改这些 JSON；
- data/skills/*.json 里同 id 的条目覆盖内置，多出来的条目追加。

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y 联合写法。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from typing import Any, Dict, List, Optional

from server.skills import skill_md

SKILL_FIELDS = ("id", "name", "category", "icon", "description", "tags", "input_schema",
                "deliverables", "skill_prompt", "enabled", "available", "usage_instruction",
                "platforms", "scenarios", "source_skill_code", "skill_type",
                "builtin_pack", "pack_version")

SKILL_TYPES = ("system", "mine", "subscribe")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# 2026-11 按用户要求下线的 17 个内置技能（找钱模型系列、买家秀、提示词助手、原声改台词）。
# builtin_skills.json 已清空；老安装的数据目录里还留着当年 _seed_builtin 写进去的种子副本（data/skills/<id>.json），
# 读用户注册表时按这份名单跳过，避免它们以「我的技能」的身份回来。
RETIRED_SKILL_IDS = frozenset(("advantage-money", "sales-rank-money", "style-money", "shop-tier-money", "demand-money", "cost-ratio-money", "price-band-money", "scene-money", "keyword-money", "cross-category-money", "blue-ocean-money", "trend-money", "buyer-show-graphic", "blue-ocean-report-interpret", "selling-point-image-prompt", "buyer-show-fission-prompt", "voice-lipsync"))

_BUILTIN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "builtin_skills.json")
# 随安装包分发的技能包（每个子目录是一个完整技能目录 + novai-pack.json 边车），
# 首次启动复制到 <data_dir>/skills/<id>/，不需要联网也不需要 GitHub
_BUILTIN_PACKS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "builtin_packs")
_PACK_MANIFEST = "novai-pack.json"
_USER_CONFIG_NAME = "config.json"

_DATA_DIR = ""
_BUILTIN_CACHE = None


def set_data_dir(path: str) -> None:
    global _DATA_DIR
    _DATA_DIR = str(path or "")


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def data_dir() -> str:
    if _DATA_DIR:
        return _DATA_DIR
    root = os.environ.get("NOVAI_DATA_DIR") or _project_root()
    return os.path.join(root, "data")


def skills_dir() -> str:
    return os.path.join(data_dir(), "skills")


def load_builtin() -> List[Dict[str, Any]]:
    global _BUILTIN_CACHE
    if _BUILTIN_CACHE is not None:
        return _BUILTIN_CACHE
    try:
        with open(_BUILTIN_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        print("[Skills] 读取内置技能失败 %s: %s" % (_BUILTIN_FILE, exc))
        data = []
    _BUILTIN_CACHE = [d for d in data if isinstance(d, dict)]
    return _BUILTIN_CACHE


def _normalize_skill(raw):
    if not isinstance(raw, dict):
        return None
    sid = str(raw.get("id") or "").strip()
    if not sid:
        return None
    tags = raw.get("tags")
    tags = [str(t) for t in tags if str(t or "").strip()] if isinstance(tags, list) else []
    deliverables = raw.get("deliverables")
    deliverables = [d for d in deliverables if isinstance(d, dict)] if isinstance(deliverables, list) else []
    schema = raw.get("input_schema")
    schema = schema if isinstance(schema, dict) else {"files": [], "params": []}
    platforms = raw.get("platforms")
    platforms = [str(p) for p in platforms] if isinstance(platforms, list) else []
    scenarios = raw.get("scenarios")
    scenarios = [str(s) for s in scenarios] if isinstance(scenarios, list) else []
    return {
        "id": sid,
        "name": str(raw.get("name") or sid).strip(),
        "category": str(raw.get("category") or "未分类").strip(),
        "icon": str(raw.get("icon") or "").strip(),
        "description": str(raw.get("description") or "").strip(),
        "tags": tags,
        "platforms": platforms,
        "scenarios": scenarios,
        "usage_instruction": str(raw.get("usage_instruction") or "").strip(),
        "source_skill_code": str(raw.get("source_skill_code") or "").strip(),
        "input_schema": schema,
        "deliverables": deliverables,
        "skill_prompt": str(raw.get("skill_prompt") or ""),
        "enabled": bool(raw.get("enabled", True)),
        "available": bool(raw.get("available", True)),
        "skill_type": str(raw.get("skill_type") or "").strip().lower(),
        "builtin_pack": str(raw.get("builtin_pack") or "").strip(),
        "pack_version": str(raw.get("pack_version") or "").strip(),
    }


def _builtin_ids():
    """内置技能 id 集合：不在里面的 = 用户自己加进来的（技能面板的「我的技能」）。"""
    return {str(d.get("id") or "") for d in load_builtin()}


def _read_user_skills():
    out = []
    folder = skills_dir()
    if not os.path.isdir(folder):
        return out
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".json"))
    except OSError:
        return out
    for name in names:
        path = os.path.join(folder, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as exc:
            print("[Skills] 读取注册表条目失败 %s: %s" % (path, exc))
            continue
        items = data if isinstance(data, list) else ([data] if isinstance(data, dict) else [])
        for item in items:
            norm = _normalize_skill(item)
            if norm and norm["id"] not in RETIRED_SKILL_IDS:
                out.append(norm)
    return out


def _seed_builtin():
    folder = skills_dir()
    if os.path.isdir(folder):
        return
    try:
        os.makedirs(folder, exist_ok=True)
        for skill in load_builtin():
            path = os.path.join(folder, "%s.json" % skill.get("id"))
            with open(path, "w", encoding="utf-8") as f:
                json.dump(skill, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("[Skills] 写入默认注册表失败（不影响使用）: %s" % exc)


# ---------------------------------------------------------------------------
# 内置技能包（随安装包分发）：首次启动复制到数据目录，不需要联网 / GitHub
# ---------------------------------------------------------------------------

def builtin_packs_dir():
    return _BUILTIN_PACKS_DIR


def _pack_manifest(pack_dir):
    path = os.path.join(pack_dir, _PACK_MANIFEST)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        print("[Skills] 内置技能包缺少可读的 %s（%s），用默认值" % (_PACK_MANIFEST, exc))
        return {}
    return data if isinstance(data, dict) else {}


def _pack_version(pack_dir):
    """包内容哈希（相对路径 + 字节）：用来判断已装版本是否需要更新。"""
    digest = hashlib.sha256()
    for root, dirs, files in os.walk(pack_dir):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, pack_dir).replace(os.sep, "/")
            digest.update(rel.encode("utf-8"))
            digest.update(b"\0")
            try:
                with open(path, "rb") as fh:
                    for chunk in iter(lambda: fh.read(65536), b""):
                        digest.update(chunk)
            except OSError:
                digest.update(b"<unreadable>")
            digest.update(b"\0")
    return digest.hexdigest()[:16]


def _read_definition(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_definition(path, definition):
    tmp = "%s.tmp" % path
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(definition, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _sync_pack_files(pack_dir, target_dir):
    """把包内文件同步进安装目录：copy2 保留权限位，用户填过的 config.json 不覆盖。"""
    for root, dirs, files in os.walk(pack_dir):
        dirs.sort()
        rel = os.path.relpath(root, pack_dir)
        dest = target_dir if rel == "." else os.path.join(target_dir, rel)
        os.makedirs(dest, exist_ok=True)
        for name in sorted(files):
            if name == _USER_CONFIG_NAME:
                continue
            shutil.copy2(os.path.join(root, name), os.path.join(dest, name))


def _build_pack_definition(pack_dir, skill_id, parsed, target_dir, version):
    manifest = _pack_manifest(pack_dir)
    root = os.path.abspath(target_dir)
    body = str(parsed.get("body") or "")
    header = "技能根目录：%s（脚本用 python3 直接运行；需要风格/镜头库细节时先读 references/ 下对应文件）" % root
    tags = manifest.get("tags")
    tags = tags if isinstance(tags, list) else []
    return {
        "id": skill_id,
        "name": str(manifest.get("display_name") or skill_id).strip(),
        "category": str(manifest.get("category") or "内置技能").strip(),
        "icon": str(manifest.get("icon") or "").strip(),
        # 清单可覆盖 SKILL.md 的英文 description：市场卡片要显示中文，又不想改上游正文
        "description": str(manifest.get("description") or parsed.get("description") or "").strip(),
        "tags": [str(item) for item in tags if str(item or "").strip()],
        "platforms": [],
        "scenarios": [],
        "usage_instruction": "",
        "source_skill_code": "",
        "input_schema": {"files": [], "params": []},
        "deliverables": [],
        "skill_prompt": "%s\n\n%s" % (header, body.replace("<skill-root>", root)),
        # 新装的官方技能包默认不启用：跟「官方技能需在应用市场添加」一致，
        # 否则老用户升级后市场显示未添加、助手却已经能用（2026-11 用户要求固定上架）
        "enabled": False,
        "available": True,
        "skill_type": "system",
        "builtin_pack": os.path.basename(os.path.normpath(pack_dir)),
        "pack_version": version,
        "license": str(parsed.get("license") or ""),
        "compatibility": str(parsed.get("compatibility") or ""),
        "metadata": parsed.get("metadata") if isinstance(parsed.get("metadata"), dict) else {},
        "allowed_tools": list(parsed.get("allowed_tools") or []),
    }


def _install_builtin_pack(pack_dir):
    """装一个内置技能包；返回技能 id（跳过/失败返回 ""）。"""
    name = os.path.basename(os.path.normpath(pack_dir))
    try:
        with open(os.path.join(pack_dir, "SKILL.md"), "r", encoding="utf-8") as fh:
            parsed = skill_md.parse_skill_md(fh.read())
    except Exception as exc:
        print("[Skills] 内置技能包 %s 的 SKILL.md 解析失败，已跳过: %s" % (name, exc))
        return ""
    skill_id = str(parsed.get("name") or "").strip()
    if not skill_id or not _ID_RE.match(skill_id):
        print("[Skills] 内置技能包 %s 的 name 不合法（%s），已跳过" % (name, skill_id or "<空>"))
        return ""
    folder = skills_dir()
    target_dir = os.path.join(folder, skill_id)
    definition_path = os.path.join(folder, "%s.json" % skill_id)
    version = _pack_version(pack_dir)
    existing = _read_definition(definition_path)
    if os.path.isdir(target_dir) and existing and str(existing.get("pack_version") or "") == version:
        return skill_id           # 同一版本：JSON、目录、用户的 config.json 全都不动
    try:
        os.makedirs(folder, exist_ok=True)
        _sync_pack_files(pack_dir, target_dir)
        definition = _build_pack_definition(pack_dir, skill_id, parsed, target_dir, version)
        if existing:
            # 版本更新：只换定义与 skill_prompt，用户改过的启停状态保留
            definition["enabled"] = bool(existing.get("enabled", True))
            definition["available"] = bool(existing.get("available", True))
        _write_definition(definition_path, definition)
    except OSError as exc:
        print("[Skills] 内置技能包 %s 安装失败，已跳过: %s" % (name, exc))
        return ""
    print("[Skills] 已安装内置技能包 %s（%s）" % (skill_id, version))
    return skill_id


def _install_builtin_packs():
    """扫描内置技能包并安装；目录不存在或某个包坏掉都只打日志，不让接口 500。"""
    root = _BUILTIN_PACKS_DIR
    if not os.path.isdir(root):
        return
    try:
        names = sorted(item for item in os.listdir(root)
                       if os.path.isdir(os.path.join(root, item)))
    except OSError as exc:
        print("[Skills] 读取内置技能包目录失败（%s），已跳过: %s" % (root, exc))
        return
    for name in names:
        pack_dir = os.path.join(root, name)
        if not os.path.isfile(os.path.join(pack_dir, "SKILL.md")):
            continue
        try:
            _install_builtin_pack(pack_dir)
        except Exception as exc:
            print("[Skills] 内置技能包 %s 安装异常，已跳过: %s" % (name, exc))


def load_skills():
    """合并「内置默认 + 内置技能包 + 用户注册表」：同 id 用户覆盖内置，用户独有条目追加。"""
    _seed_builtin()
    _install_builtin_packs()
    user = _read_user_skills()
    user_by_id = {}
    for item in user:
        user_by_id[item["id"]] = item
    merged = []
    seen = set()
    for builtin in load_builtin():
        norm = _normalize_skill(builtin)
        if not norm:
            continue
        merged.append(user_by_id.get(norm["id"], norm))
        seen.add(norm["id"])
    for item in user:
        if item["id"] not in seen:
            merged.append(item)
            seen.add(item["id"])
    return merged


def skill_ids() -> List[str]:
    return [s["id"] for s in load_builtin()]


def get_skill(skill_id):
    sid = str(skill_id or "").strip()
    if not sid:
        return None
    for skill in load_skills():
        if skill["id"] == sid:
            return skill
    return None


def public_skill(skill, kind: str = "skill", usage_count=None):
    """列表 / 详情字段（契约冻结；source_skill_code / skill_type / usage_count 为可选新增字段）。

    skill_type：条目自己声明了 system/mine/subscribe 就用它；没声明时，不在内置清单里的
    就是用户导入的，记「mine」，其余是「system」。没有订阅数据源，这个字段不会凭空造
    「subscribe」。
    usage_count：调用方传入的真实运行次数（server/agents/store.usage_counts），没给就是 0。
    """
    sid = str(skill.get("id") or "")
    declared = str(skill.get("skill_type") or "").strip().lower()
    if declared in SKILL_TYPES:
        skill_type = declared
    else:
        skill_type = "system" if sid in _builtin_ids() else "mine"
    return {
        "id": skill.get("id"),
        "kind": kind,
        "name": skill.get("name"),
        "category": skill.get("category"),
        "icon": skill.get("icon"),
        "description": skill.get("description"),
        "tags": skill.get("tags") or [],
        "deliverables": skill.get("deliverables") or [],
        "enabled": bool(skill.get("enabled", True)),
        "available": bool(skill.get("available", True)),
        "source_skill_code": str(skill.get("source_skill_code") or ""),
        "skill_type": skill_type,
        "builtin_pack": str(skill.get("builtin_pack") or ""),
        "usage_count": int(usage_count or 0),
    }


def import_skill(raw):
    """把一份技能定义写进 data/skills/{id}.json，返回 (定义, 是否新建)。

    校验不通过抛 ValueError。只收用户自己的技能：内置技能的 id 不允许被导入覆盖
    （内置同名条目在 data/skills 里有种子文件，写进去会顶掉系统技能）。
    """
    if not isinstance(raw, dict):
        raise ValueError("技能定义必须是 JSON 对象")
    if not str(raw.get("name") or "").strip():
        raise ValueError("技能定义缺少 name")
    skill = _normalize_skill(raw)
    if not skill:
        raise ValueError("技能定义缺少 id")
    if not _ID_RE.match(skill["id"]):
        raise ValueError("技能 id 只能由字母、数字、点、下划线和连字符组成，最长 64 位")
    if skill["id"] in _builtin_ids():
        raise ValueError("「%s」是内置技能的 id，导入不能覆盖系统技能" % skill["id"])
    if skill["id"] in RETIRED_SKILL_IDS:
        raise ValueError("「%s」是已下线的内置技能 id，请换一个 id" % skill["id"])
    folder = skills_dir()
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "%s.json" % skill["id"])
    created = not os.path.isfile(path)
    tmp = "%s.tmp" % path
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(skill, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return skill, created
