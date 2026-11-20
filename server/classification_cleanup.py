"""历史智能分类数据的一次性清理。

智能分类（AI 图片打标）已下线，这里只处理升级前已经落盘的历史数据：

- <数据根>/assets/uploads/**/*.classification.json → <数据根>/_migrated/classification-<时间戳>/
  （按原相对路径归档，子目录结构保留）
- <数据根>/data/asset_library.json 里所有 classification 键（按条目级删除；改前原样备份为
  asset_library.json.bak-<时间戳>）
- <数据根>/data/asset_classification_prompt.txt → 同一个 _migrated 目录

幂等：完成写 <数据根>/.classification-cleanup-v1.done（含计数与时间），下次直接跳过；
有失败时不写 stamp，下次启动重试。调用方负责兜异常（启动迁移绝不允许阻断启动）。

CLI 见 tools/cleanup_asset_classification.py；启动迁移见 main.py 的 startup_event。
"""
from __future__ import annotations

import json
import os
import shutil
import time
from typing import Any, Dict, List

STAMP_NAME = ".classification-cleanup-v1.done"
MIGRATED_DIRNAME = "_migrated"
SIDECAR_SUFFIX = ".classification.json"
LIBRARY_NAME = "asset_library.json"
PROMPT_NAME = "asset_classification_prompt.txt"


def _timestamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def _write_json_atomic(path: str, payload: Any) -> None:
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _resolve_paths(root: str, uploads_dir: str = "", library_path: str = "", prompt_path: str = ""):
    """按真实数据布局解析三个清理目标；也兼容把 --data-dir 直接指到内层 data/ 的情况。"""
    inner = os.path.join(root, "data")
    data_dir = inner if os.path.isdir(inner) else root
    if not uploads_dir:
        candidate = os.path.join(root, "assets", "uploads")
        if not os.path.isdir(candidate):
            candidate = os.path.join(root, "uploads")
        uploads_dir = candidate
    return {
        "uploads_dir": uploads_dir,
        "library_path": library_path or os.path.join(data_dir, LIBRARY_NAME),
        "prompt_path": prompt_path or os.path.join(data_dir, PROMPT_NAME),
    }


def _scan_sidecars(uploads_dir: str) -> List[str]:
    found: List[str] = []
    if not os.path.isdir(uploads_dir):
        return found
    for current, dirs, files in os.walk(uploads_dir):
        dirs.sort()
        for name in sorted(files):
            if name.lower().endswith(SIDECAR_SUFFIX):
                found.append(os.path.join(current, name))
    return found


def _count_classification_keys(node: Any) -> int:
    if isinstance(node, dict):
        count = 1 if "classification" in node else 0
        for value in node.values():
            count += _count_classification_keys(value)
        return count
    if isinstance(node, list):
        return sum(_count_classification_keys(value) for value in node)
    return 0


def _drop_classification_keys(node: Any) -> int:
    if isinstance(node, dict):
        removed = 0
        if "classification" in node:
            node.pop("classification", None)
            removed = 1
        for value in node.values():
            removed += _drop_classification_keys(value)
        return removed
    if isinstance(node, list):
        return sum(_drop_classification_keys(value) for value in node)
    return 0


def _migrated_rel(path: str, root: str, uploads_dir: str) -> str:
    """归档时的相对路径：数据根内的保留原路径，根外的（自定义存储盘）放到 uploads/ 下。"""
    try:
        rel = os.path.relpath(path, root)
        if rel and not rel.startswith(".." + os.sep) and rel != "..":
            return rel.replace(os.sep, "/")
    except ValueError:
        pass
    try:
        rel = os.path.relpath(path, uploads_dir)
    except ValueError:
        rel = os.path.basename(path)
    if not rel or rel.startswith(".."):
        rel = os.path.basename(path)
    return ("uploads/" + rel).replace(os.sep, "/")


def _move_into(src: str, dest: str) -> str:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    target = dest
    index = 2
    base, ext = os.path.splitext(dest)
    while os.path.exists(target):
        target = "%s-%d%s" % (base, index, ext)
        index += 1
    shutil.move(src, target)
    return target


def _clean_library(library_path: str, root: str, stamp: str, apply: bool,
                   summary: Dict[str, Any]) -> None:
    if not os.path.isfile(library_path):
        return
    try:
        with open(library_path, "r", encoding="utf-8") as f:
            lib = json.load(f)
    except Exception as exc:
        summary["errors"].append("读取资产库失败 %s: %s" % (os.path.basename(library_path), exc))
        return
    if not apply:
        summary["library_items_cleaned"] = _count_classification_keys(lib)
        return
    removed = _drop_classification_keys(lib)
    summary["library_items_cleaned"] = removed
    if not removed:
        return
    backup_path = "%s.bak-%s" % (library_path, stamp)
    try:
        shutil.copy2(library_path, backup_path)
    except Exception as exc:
        summary["errors"].append("备份资产库失败: %s" % exc)
        return
    try:
        _write_json_atomic(library_path, lib)
    except Exception as exc:
        summary["errors"].append("写回资产库失败: %s" % exc)
        return
    summary["library_backup"] = os.path.relpath(backup_path, root).replace(os.sep, "/")


def run(data_dir: str, apply: bool = False, uploads_dir: str = "", library_path: str = "",
        prompt_path: str = "") -> Dict[str, Any]:
    """清理历史分类数据。apply=False 只统计；返回摘要 dict（含 errors）。"""
    root = os.path.abspath(os.path.expanduser(str(data_dir or "")))
    summary: Dict[str, Any] = {
        "ok": True,
        "applied": bool(apply),
        "data_dir": root,
        "skipped": False,
        "timestamp": "",
        "sidecars_found": 0,
        "sidecars_moved": 0,
        "library_items_cleaned": 0,
        "library_backup": "",
        "prompt_found": False,
        "prompt_moved": False,
        "migrated_dir": "",
        "stamp": "",
        "errors": [],
    }
    if not os.path.isdir(root):
        summary["ok"] = False
        summary["error"] = "数据目录不存在"
        return summary
    if os.path.isfile(os.path.join(root, STAMP_NAME)):
        summary["skipped"] = True
        summary["stamp"] = STAMP_NAME
        return summary

    paths = _resolve_paths(root, uploads_dir, library_path, prompt_path)
    stamp = _timestamp()
    migrated_dir = os.path.join(root, MIGRATED_DIRNAME, "classification-" + stamp)
    summary["timestamp"] = stamp

    try:
        sidecars = _scan_sidecars(paths["uploads_dir"])
    except Exception as exc:
        sidecars = []
        summary["errors"].append("扫描分类旁车失败: %s" % exc)
    summary["sidecars_found"] = len(sidecars)
    summary["prompt_found"] = os.path.isfile(paths["prompt_path"])

    if not apply:
        _clean_library(paths["library_path"], root, stamp, apply=False, summary=summary)
        return summary

    for path in sidecars:
        dest = os.path.join(migrated_dir, _migrated_rel(path, root, paths["uploads_dir"]))
        try:
            _move_into(path, dest)
            summary["sidecars_moved"] += 1
        except Exception as exc:
            summary["errors"].append("迁移旁车失败 %s: %s" % (os.path.basename(path), exc))
    if paths["prompt_path"] and os.path.isfile(paths["prompt_path"]):
        dest = os.path.join(migrated_dir, _migrated_rel(paths["prompt_path"], root, paths["uploads_dir"]))
        try:
            _move_into(paths["prompt_path"], dest)
            summary["prompt_moved"] = True
        except Exception as exc:
            summary["errors"].append("迁移分类提示词失败: %s" % exc)
    _clean_library(paths["library_path"], root, stamp, apply=True, summary=summary)

    if summary["sidecars_moved"] or summary["prompt_moved"]:
        summary["migrated_dir"] = os.path.relpath(migrated_dir, root).replace(os.sep, "/")
    if summary["errors"]:
        return summary
    stamp_path = os.path.join(root, STAMP_NAME)
    stamp_payload = {
        "done_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "timestamp": stamp,
        "migrated_dir": summary["migrated_dir"],
        "sidecars_moved": summary["sidecars_moved"],
        "library_items_cleaned": summary["library_items_cleaned"],
        "library_backup": summary["library_backup"],
        "prompt_moved": summary["prompt_moved"],
    }
    try:
        _write_json_atomic(stamp_path, stamp_payload)
        summary["stamp"] = STAMP_NAME
    except Exception as exc:
        summary["errors"].append("写完成标记失败: %s" % exc)
    return summary


def summary_line(summary: Dict[str, Any]) -> str:
    """给启动日志 / CLI 用的一行摘要。"""
    if not summary.get("ok"):
        return "[分类清理] 跳过：%s" % (summary.get("error") or summary.get("data_dir") or "数据目录不可用")
    if summary.get("skipped"):
        return "[分类清理] 已清理过（%s），跳过" % (summary.get("stamp") or STAMP_NAME)
    counts = "旁车 %d 个、资产库条目 %d 个、分类提示词 %s" % (
        summary.get("sidecars_found", 0),
        summary.get("library_items_cleaned", 0),
        "有" if summary.get("prompt_found") else "无",
    )
    if not summary.get("applied"):
        return "[分类清理] dry-run：%s（加 --apply 才执行）" % counts
    line = "[分类清理] 已清理：旁车 %d/%d 个、资产库条目 %d 个" % (
        summary.get("sidecars_moved", 0),
        summary.get("sidecars_found", 0),
        summary.get("library_items_cleaned", 0),
    )
    if summary.get("library_backup"):
        line += "，备份 %s" % summary["library_backup"]
    if summary.get("prompt_moved"):
        line += "，分类提示词已归档"
    if summary.get("migrated_dir"):
        line += "，归档到 %s" % summary["migrated_dir"]
    if summary.get("errors"):
        line += "，%d 个失败" % len(summary["errors"])
    return line
