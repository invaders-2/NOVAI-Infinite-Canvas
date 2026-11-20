#!/usr/bin/env python3
"""历史智能分类数据清理工具（与后端启动迁移同一实现）。

分类功能已下线，这个工具把升级前落盘的历史分类数据归档：

  - assets/uploads 下所有 *.classification.json → _migrated/classification-<时间戳>/
  - data/asset_library.json 里的 classification 键（改前备份为 asset_library.json.bak-<时间戳>）
  - data/asset_classification_prompt.txt → 同一个 _migrated 目录

默认只统计（dry-run），加 --apply 才真的移动 / 改文件；完成后写 .classification-cleanup-v1.done，
再跑直接跳过。后端下次启动也会自动跑一次（apply），所以正常升级不需要手动执行。

用法：
  python3 tools/cleanup_asset_classification.py --data-dir ~/.NOVAI            # dry-run
  python3 tools/cleanup_asset_classification.py --data-dir ~/.NOVAI --apply    # 执行
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server.classification_cleanup import run, summary_line  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="cleanup_asset_classification.py",
        description="归档历史智能分类数据（旁车 / 资产库字段 / 分类提示词）",
    )
    parser.add_argument("--data-dir", required=True,
                        help="NOVAI 数据目录（就是 NOVAI_DATA_DIR 指向的目录，例如 ~/.NOVAI）")
    parser.add_argument("--apply", action="store_true",
                        help="真的执行移动 / 改写；不加只做 dry-run 统计")
    parser.add_argument("--json", action="store_true", help="额外打印完整摘要 JSON")
    args = parser.parse_args(argv)

    data_dir = os.path.abspath(os.path.expanduser(args.data_dir))
    if not os.path.isdir(data_dir):
        print("数据目录不存在：%s" % data_dir, file=sys.stderr)
        return 2
    result = run(data_dir, apply=bool(args.apply))
    print(summary_line(result), flush=True)
    if args.json or result.get("errors"):
        print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result.get("ok"):
        return 2
    if result.get("errors"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
