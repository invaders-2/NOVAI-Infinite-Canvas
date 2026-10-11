#!/usr/bin/env python3
"""把自动化测试 / 调试留下的临时画布移进回收站（可在画布列表的回收站里恢复）。

    python tools/cleanup_test_canvases.py            # 只列出会被处理的画布，不改动
    python tools/cleanup_test_canvases.py --apply    # 真正移入回收站

判断依据是标题：TEMP- / VERIFY / verify / probe / TMP / vfN / 临时 / 自测 / 验证 / test。
以后跑自动化测试请设置环境变量 NOVAI_DATA_DIR 指向独立目录，不要写进日常使用的数据目录。
"""
import argparse
import json
import os
import re
import sys
import time

TEST_TITLE = re.compile(r"TEMP|VERIFY|verify|probe|PROBE|TMP|^vf\d|临时|自测|验证|\btest\b", re.I)


def canvases_dir():
    root = os.environ.get("NOVAI_DATA_DIR")
    base = root if root else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "data", "canvases")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="实际移入回收站（默认只预览）")
    args = parser.parse_args()
    folder = canvases_dir()
    if not os.path.isdir(folder):
        print(f"找不到画布目录：{folder}")
        return 1
    hits = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(folder, name)
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        if data.get("deleted_at"):
            continue
        title = str(data.get("title") or "")
        if TEST_TITLE.search(title):
            hits.append((path, data, title))
    for _, data, title in hits:
        print(f"  {title}  ({len(data.get('nodes') or [])} 个节点)")
    print(f"共 {len(hits)} 个测试画布" + ("，已移入回收站" if args.apply else "（预览，未改动；加 --apply 执行）"))
    if not args.apply:
        return 0
    now = int(time.time() * 1000)
    for path, data, _ in hits:
        data["deleted_at"] = now
        tmp = path + ".partial"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
