#!/usr/bin/env python3
"""把根 update-notes.json 同步成后端 /api/changelog 读的 static/update-notes.json。

根文件是新格式 {versions: [{version, date, changes: []}]}（按最新在前排序），
static 里的旧格式是 {version, updated_at, items: [{type, text}]}。之前两边各写各的，
static 一直停在 1.0.142，更新完弹窗仍显示旧版本内容。发版 / 打包前跑一次，CI 已接。

用法：python3 tools/sync_update_notes.py
"""
import json
import os
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "update-notes.json")
TARGET = os.path.join(ROOT, "static", "update-notes.json")


def main():
    with open(SOURCE, "r", encoding="utf-8") as f:
        data = json.load(f)
    versions = data.get("versions") or []
    if not versions:
        raise SystemExit("update-notes.json 里没有 versions")
    latest = versions[0]
    version = str(latest.get("version") or "").strip()
    if not version:
        raise SystemExit("update-notes.json 的第一条没有 version")
    changes = [str(x).strip() for x in (latest.get("changes") or []) if str(x).strip()]
    if not changes:
        raise SystemExit("update-notes.json 的 %s 没有 changes" % version)
    payload = {
        "version": version,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "items": [{"type": "feature", "text": text} for text in changes],
    }
    with open(TARGET, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("static/update-notes.json <- %s (%d items)" % (version, len(changes)))


if __name__ == "__main__":
    main()
