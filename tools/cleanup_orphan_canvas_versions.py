#!/usr/bin/env python3
"""清理 data/canvas_versions 下属于「已彻底删除画布」的孤儿版本快照目录。

为什么存在：版本快照只在「该画布下次保存」时才裁剪，画布被彻底删除（purge / 回收站 30 天到期自动清理）
后不会再保存，历史快照就永久冻结。main.py 已改成删画布时同步清版本目录，历史遗留的孤儿用本脚本一次清掉。

    python3 tools/cleanup_orphan_canvas_versions.py            # dry-run：只统计 + 列出要删的目录
    python3 tools/cleanup_orphan_canvas_versions.py --apply    # 真正删除

孤儿判定：canvas_versions 下的目录名 与 data/canvases/*.json 里的画布 id 按同一套清洗规则
（re.sub(r"[^a-zA-Z0-9_-]", "", id)，与 main.py 的 canvas_versions_dir 一致）映射后的集合取差集。
data/canvases 里带 deleted_at 的回收站画布算存活（30 天内可恢复），绝不删。
防风：读不出 / 缺 id 的画布文件、符号链接、目录名不合法、多个 id 清洗后同名 → 一律不删并打印原因。
数据目录：NOVAI_DATA_DIR（与 main.py 同口径，数据在 <该目录>/data 下），未设置时用仓库根目录。
"""
import argparse
import json
import os
import re
import shutil
import sys

CLEAN_RE = re.compile(r"[^a-zA-Z0-9_-]")


def data_root():
    root = os.environ.get("NOVAI_DATA_DIR")
    base = root if root else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "data")


def clean_id(value):
    return CLEAN_RE.sub("", str(value or ""))


def scan_canvases(folder):
    """返回 (清洗后 id -> 原始 id 列表, 存活数, 回收站数, 无法判断的文件列表)。"""
    owners = {}
    alive = 0
    trashed = 0
    unknown = []
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return owners, alive, trashed, unknown
    for name in names:
        if not name.endswith(".json"):
            continue
        path = os.path.join(folder, name)
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        except Exception as exc:
            unknown.append("%s（读取失败：%s）" % (name, exc))
            continue
        if not isinstance(doc, dict) or not str(doc.get("id") or "").strip():
            unknown.append("%s（缺 id）" % name)
            continue
        raw_id = str(doc["id"]).strip()
        cleaned = clean_id(raw_id)
        if not cleaned:
            unknown.append("%s（id 清洗后为空：%r）" % (name, raw_id))
            continue
        owners.setdefault(cleaned, []).append(raw_id)
        if doc.get("deleted_at"):
            trashed += 1
        else:
            alive += 1
    return owners, alive, trashed, unknown


def dir_stats(path):
    files = 0
    size = 0
    for root, _dirs, filenames in os.walk(path):
        for filename in filenames:
            try:
                size += os.path.getsize(os.path.join(root, filename))
            except OSError:
                pass
            files += 1
    return files, size


def human_mb(size):
    return "%.2f MB" % (size / (1024 * 1024))


def within_dir(path, root):
    """与 main.is_within_dir 同口径：规范化（含符号链接）后严格位于 root 之内。"""
    try:
        real_root = os.path.realpath(root)
        real_path = os.path.realpath(path)
    except OSError:
        return False
    if real_path == real_root:
        return False
    try:
        return os.path.commonpath([real_root, real_path]) == real_root
    except ValueError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="真正删除孤儿版本目录（默认只预览）")
    args = parser.parse_args()

    data_dir = data_root()
    canvases_dir = os.path.join(data_dir, "canvases")
    versions_dir = os.path.join(data_dir, "canvas_versions")
    if not os.path.isdir(canvases_dir) and not os.path.isdir(versions_dir):
        print("找不到画布数据目录：%s" % data_dir)
        return 1

    owners, alive, trashed, unknown = scan_canvases(canvases_dir)
    ambiguous = {name: ids for name, ids in owners.items() if len(ids) > 1}
    live_names = set(owners)

    try:
        entries = sorted(os.listdir(versions_dir))
    except OSError:
        entries = []
    total_dirs = 0
    orphan_rows = []
    skipped = []
    for name in entries:
        path = os.path.join(versions_dir, name)
        if os.path.islink(path) or not os.path.isdir(path):
            skipped.append((name, "不是普通目录（符号链接 / 文件），无法判断归属"))
            continue
        total_dirs += 1
        if name in ambiguous:
            skipped.append((name, "多个画布 id 清洗后同名（%s），无法判断归属" % "、".join(ambiguous[name])))
            continue
        if clean_id(name) != name:
            skipped.append((name, "目录名不是合法的清洗后画布 id，无法判断归属"))
            continue
        if name in live_names:
            continue
        files, size = dir_stats(path)
        orphan_rows.append((name, path, files, size))

    if unknown:
        print("发现无法判断归属的画布文件，为防误删，本次不做任何删除：")
        for item in unknown:
            print("  " + item)
    for name, reason in skipped:
        print("  跳过 canvas_versions/%s：%s" % (name, reason))
    for name, _path, files, size in orphan_rows:
        print("  待清理 canvas_versions/%s（%d 个快照，%s）" % (name, files, human_mb(size)))

    print("存活画布：%d" % alive)
    print("回收站画布：%d（可恢复，按存活处理，不删）" % trashed)
    print("版本目录总数：%d" % total_dirs)
    print("孤儿目录：%d" % len(orphan_rows))
    print("孤儿快照文件：%d" % sum(row[2] for row in orphan_rows))
    print("可释放空间：%s" % human_mb(sum(row[3] for row in orphan_rows)))

    if not args.apply:
        print("预览模式，未改动任何文件；加 --apply 执行删除")
        return 0
    if unknown:
        print("存在无法判断归属的画布文件，已跳过全部删除")
        return 0

    removed_dirs = 0
    removed_files = 0
    removed_bytes = 0
    for name, path, files, size in orphan_rows:
        if not within_dir(path, versions_dir):
            print("  拒绝删除 canvas_versions/%s：不在版本目录之内的路径" % name)
            continue
        try:
            shutil.rmtree(path)
        except OSError as exc:
            print("  删除失败 canvas_versions/%s：%s" % (name, exc))
            continue
        removed_dirs += 1
        removed_files += files
        removed_bytes += size
        print("  已删除 canvas_versions/%s（%d 个快照，%s）" % (name, files, human_mb(size)))
    print("已清理 %d 个孤儿目录 / %d 个快照 / %s" % (removed_dirs, removed_files, human_mb(removed_bytes)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
