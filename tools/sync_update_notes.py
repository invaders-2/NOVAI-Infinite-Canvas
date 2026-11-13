#!/usr/bin/env python3
"""把根 update-notes.json 同步成后端 /api/changelog 读的 static/update-notes.json。

根文件是新格式 {versions: [{version, date, changes: []}]}（按最新在前排序），changes 每项可以
是一句话，也可以是 {text, type?, media?}；type 取 feature / fix / improve（缺省 feature），
media（{type, src, caption?}）原样透传给用户端播放动态演示。
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

NOTE_TYPES = ("feature", "fix", "improve")
MEDIA_TYPES = ("image", "gif", "video")
MEDIA_SRC_PREFIXES = ("http://", "https://", "/static/", "/assets/")


def fail(version, index, reason):
    raise SystemExit("update-notes.json 的 %s 第 %d 条%s" % (version, index + 1, reason))


def note_item(entry, version, index):
    if isinstance(entry, str):
        text = entry.strip()
        if not text:
            fail(version, index, "是空字符串")
        return {"type": "feature", "text": text}
    if not isinstance(entry, dict):
        fail(version, index, "既不是字符串也不是对象")
    text = str(entry.get("text") or "").strip()
    if not text:
        fail(version, index, "缺少 text")
    note_type = str(entry.get("type") or "feature").strip().lower()
    if note_type not in NOTE_TYPES:
        fail(version, index, "的 type 只能是 feature / fix / improve")
    item = {"type": note_type, "text": text}
    media = entry.get("media")
    if media is None:
        return item
    # 为什么在发版时就校验：不合法的话用户端会整条丢掉媒体，只剩文字，而且没人会发现
    if not isinstance(media, dict):
        fail(version, index, "的 media 不是对象")
    kind = str(media.get("type") or "").strip().lower()
    src = str(media.get("src") or "").strip()
    if kind not in MEDIA_TYPES:
        fail(version, index, "的 media.type 只能是 image / gif / video")
    if not src.startswith(MEDIA_SRC_PREFIXES) or len(src) > 300:
        fail(version, index, "的 media.src 必须以 http:// https:// /static/ /assets/ 开头，且不超过 300 字符")
    caption = str(media.get("caption") or "").strip()
    if len(caption) > 100:
        fail(version, index, "的 media.caption 超过 100 字符")
    item["media"] = {"type": kind, "src": src}
    if caption:
        item["media"]["caption"] = caption
    return item


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
    items = [note_item(entry, version, i) for i, entry in enumerate(latest.get("changes") or [])]
    if not items:
        raise SystemExit("update-notes.json 的 %s 没有 changes" % version)
    payload = {
        "version": version,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "items": items,
    }
    with open(TARGET, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("static/update-notes.json <- %s (%d items)" % (version, len(items)))


if __name__ == "__main__":
    main()
