#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把商店条目的封面图下载 / 压缩成 WebP 到 static/store/covers/，并把数据里的 URL 改成本地路径。

范围（只碰图片，不碰视频）：
- 任意对象里的 `cover_url` / `poster` / `poster_url`；
- `{kind: "image", src: "..."}` 形式的图片（preset 封面 hero、intro_showcase 面板、collection 封面等）；
- 视频（`cover_video_url` / `{kind: "video", src}` / .mp4）**只保留原 URL 不下载**，另外给带封面的
  catalog 条目补一个 `cover_poster_url`（把 variant_name 换成 thumbnail，前端视频挂了回退它）。

压缩：Pillow 重新编码成 WebP，最长边 ≤ --resize（默认 1280），quality 默认 80；总大小超过
--target-mb（默认 12）时自动降 quality（每次 -5，最低 50）直到达标。文件名保持「原主干 + .webp」，
URL 同步改写；原始 jpg/png 在写出成功后删除。

幂等：已是 .webp 且文件存在就跳过（仍会改写 URL）；单张失败只记一笔，URL 保持原样，不中断。

用法：
    python3 tools/fetch_store_assets.py                    # 下载 + 压缩 + 改写
    python3 tools/fetch_store_assets.py --dry-run          # 只统计
    python3 tools/fetch_store_assets.py --resize 1024 --quality 75 --target-mb 10
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import urllib.request
from typing import Any, Dict, Iterator, List, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE_DIR = os.path.join(REPO_ROOT, "server", "store_data")
DETAILS_DIR = os.path.join(STORE_DIR, "details")
COVERS_DIR = os.path.join(REPO_ROOT, "static", "store", "covers")
LOCAL_PREFIX = "/static/store/covers/"
TIMEOUT_SECONDS = 20
USER_AGENT = "Mozilla/5.0 (compatible; NOVAI-store-assets/2.0)"
WEBP_EXT = ".webp"
# 需要本地化的图片字段：封面 / 海报 / 图标 / 营销位 / 达人形象三视图 / 视频兜底封面
IMAGE_KEYS = ("cover_url", "poster", "poster_url", "icon_url", "url",
              "base", "caricature", "turnaround", "cover_poster_url")
MEDIA_SKIP_KINDS = ("video", "audio")


def _sniff_ext(head: bytes) -> str:
    if head.startswith(b"\x89PNG"):
        return ".png"
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head.startswith(b"GIF8"):
        return ".gif"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return ".webp"
    if head[4:12] in (b"ftypavif", b"ftypavis"):
        return ".avif"
    if head.startswith(b"<?xml") or head.startswith(b"<svg"):
        return ".svg"
    return ""


def _ext_from_url(url: str) -> str:
    path = url.split("?", 1)[0].split("#", 1)[0]
    ext = os.path.splitext(path)[1].lower()
    return ext if ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".svg") else ""


def _stem_for(url: str) -> str:
    """本地文件沿用原主干名；远程 URL 用 sha1 前 16 位。都保证可追溯。"""
    if url.startswith(LOCAL_PREFIX):
        return os.path.splitext(os.path.basename(url))[0]
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]


def _local_path(url: str) -> str:
    return os.path.join(COVERS_DIR, os.path.basename(url))


def _atomic_write_json(path: str, data: Any) -> None:
    """先写同目录临时文件再 os.replace：脚本中断也不会留下半个 JSON。"""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".partial", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _is_image_slot(node: Dict[str, Any], key: str) -> bool:
    value = node.get(key)
    if not isinstance(value, str) or not (value.startswith("http") or value.startswith(LOCAL_PREFIX)):
        return False
    if str(node.get("kind") or "").lower() in MEDIA_SKIP_KINDS:
        return False                      # 视频 / 音频不下载
    if key == "src":
        return str(node.get("kind") or "").lower() == "image"
    return key in IMAGE_KEYS


def _iter_image_slots(node: Any) -> Iterator[Tuple[Dict[str, Any], str]]:
    """深度优先找出所有「图片 URL 字段」；只产出可改写的 (dict, key)，不改结构。"""
    if isinstance(node, dict):
        for key in list(node.keys()):
            value = node.get(key)
            if _is_image_slot(node, key):
                yield node, key
            elif isinstance(value, (dict, list)):
                for pair in _iter_image_slots(value):
                    yield pair
    elif isinstance(node, list):
        for item in node:
            for pair in _iter_image_slots(item):
                yield pair


def _poster_from_video(url: str) -> str:
    """上游的封面视频与 poster 是同一份上传的不同 variant（?variant_name=）。"""
    if "variant_name=" not in url:
        return ""
    return re.sub(r"variant_name=[^&]+", "variant_name=thumbnail", url, count=1)


def _attach_video_posters(catalog: Dict[str, Any]) -> int:
    added = 0
    for item in catalog.get("items") or []:
        if not isinstance(item, dict) or item.get("cover_poster_url"):
            continue
        poster = _poster_from_video(str(item.get("cover_video_url") or ""))
        if poster:
            item["cover_poster_url"] = poster
            added += 1
    return added


def _download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.read()


def _encode_webp(content: bytes, resize: int, quality: int) -> bytes:
    """最长边缩到 resize 内、转 WebP。带透明通道的图先铺白底，避免变黑。"""
    from PIL import Image

    with Image.open(io.BytesIO(content)) as img:
        img.load()
        if img.mode in ("RGBA", "LA", "P"):
            rgba = img.convert("RGBA")
            canvas = Image.new("RGB", rgba.size, (255, 255, 255))
            canvas.paste(rgba, mask=rgba.split()[-1])
            img = canvas
        elif img.mode != "RGB":
            img = img.convert("RGB")
        if resize and max(img.size) > resize:
            img.thumbnail((resize, resize), Image.LANCZOS)
        buffer = io.BytesIO()
        img.save(buffer, "WEBP", quality=int(quality), method=6)
        return buffer.getvalue()


def _dir_bytes(folder: str) -> int:
    if not os.path.isdir(folder):
        return 0
    return sum(os.path.getsize(os.path.join(folder, name)) for name in os.listdir(folder))


def _max_file(folder: str) -> Tuple[str, int]:
    if not os.path.isdir(folder):
        return "", 0
    best = ("", 0)
    for name in os.listdir(folder):
        size = os.path.getsize(os.path.join(folder, name))
        if size > best[1]:
            best = (name, size)
    return best


def load_store(store_dir: str) -> Tuple[Any, Dict[str, Any], Dict[str, Any]]:
    catalog_path = os.path.join(store_dir, "catalog.json")
    with open(catalog_path, "r", encoding="utf-8") as fh:
        catalog_payload = json.load(fh)
    catalog = catalog_payload.get("data") if isinstance(catalog_payload.get("data"), dict) else catalog_payload
    details_dir = os.path.join(store_dir, "details")
    details = {}
    if os.path.isdir(details_dir):
        for name in sorted(n for n in os.listdir(details_dir) if n.endswith(".json")):
            with open(os.path.join(details_dir, name), "r", encoding="utf-8") as fh:
                details[name] = json.load(fh)
    return catalog_payload, catalog, details


def main(argv=None) -> int:
    global REPO_ROOT, STORE_DIR, DETAILS_DIR, COVERS_DIR

    parser = argparse.ArgumentParser(description="下载/压缩商店封面并改写成本地 WebP 路径")
    parser.add_argument("--root", default=REPO_ROOT, help="仓库根目录（默认脚本所在仓库）")
    parser.add_argument("--store-dir", default="", help="商店数据目录（默认 <root>/server/store_data）")
    parser.add_argument("--covers-dir", default="", help="封面输出目录（默认 <root>/static/store/covers）")
    parser.add_argument("--resize", type=int, default=1280, help="最长边上限，默认 1280")
    parser.add_argument("--quality", type=int, default=80, help="WebP quality，默认 80")
    parser.add_argument("--target-mb", type=float, default=12.0, help="封面总大小目标（MB），默认 12")
    parser.add_argument("--dry-run", action="store_true", help="只统计目标数量，不下载不压缩不改写")
    parser.add_argument("--force", action="store_true", help="已是 webp 也重新编码（统一尺寸/质量时用）")
    parser.add_argument("--limit", type=int, default=0, help="最多处理 N 张（0 = 全部）")
    args = parser.parse_args(argv)

    REPO_ROOT = os.path.abspath(args.root)
    STORE_DIR = os.path.abspath(args.store_dir) if args.store_dir else os.path.join(REPO_ROOT, "server", "store_data")
    DETAILS_DIR = os.path.join(STORE_DIR, "details")
    COVERS_DIR = os.path.abspath(args.covers_dir) if args.covers_dir else os.path.join(REPO_ROOT, "static", "store", "covers")

    if not os.path.isfile(os.path.join(STORE_DIR, "catalog.json")):
        print("找不到 %s：先把商店数据放到 server/store_data" % os.path.join(STORE_DIR, "catalog.json"))
        return 2

    catalog_payload, catalog, details = load_store(STORE_DIR)
    posters_added = _attach_video_posters(catalog)

    values: List[str] = []
    seen = set()
    for root in [catalog] + list(details.values()):
        for node, key in _iter_image_slots(root):
            value = str(node.get(key) or "")
            if value and value not in seen:
                seen.add(value)
                values.append(value)

    todo = []
    for value in values:
        stem = _stem_for(value)
        target = os.path.join(COVERS_DIR, stem + WEBP_EXT)
        if value.startswith(LOCAL_PREFIX) and os.path.isfile(target) and not args.force:
            continue                      # 已经是本地 webp（--force 时重新编码）
        if value.startswith(LOCAL_PREFIX) and not os.path.isfile(_local_path(value)):
            print("  [缺失] %s（本地文件不存在，跳过）" % value)
            continue
        todo.append(value)
    if args.limit and args.limit > 0:
        todo = todo[:args.limit]

    before_bytes = _dir_bytes(COVERS_DIR)
    print("图片条目：%d | 待处理：%d | 补 cover_poster_url：%d | 现有封面：%.1f MB（%d 个文件）" % (
        len(values), len(todo), posters_added, before_bytes / 1024.0 / 1024.0,
        len(os.listdir(COVERS_DIR)) if os.path.isdir(COVERS_DIR) else 0))
    if args.dry_run:
        for value in todo[:5]:
            print("  dry-run:", value[:120])
        return 0

    # 阶段一：把源图片读进内存（远程下载 / 本地读文件），并记下要删的旧文件
    prepared: List[Dict[str, Any]] = []
    failed: List[str] = []
    source_bytes = 0
    for value in todo:
        stem = _stem_for(value)
        try:
            if value.startswith(LOCAL_PREFIX):
                old_path = _local_path(value)
                with open(old_path, "rb") as fh:
                    content = fh.read()
                # 源文件和目标同名（.webp）时不能删源：old 留空，写完覆盖即可
                prepared.append({"value": value, "stem": stem, "content": content,
                                 "old": "" if old_path.lower().endswith(WEBP_EXT) else old_path})
            else:
                content = _download(value)
                if not content:
                    raise ValueError("空响应")
                prepared.append({"value": value, "stem": stem, "content": content, "old": ""})
            source_bytes += len(content)
        except Exception as exc:
            failed.append("%s -> %s" % (value[:90], exc))
            print("  [失败] %s -> %s" % (value[:90], exc))

    if not prepared:
        print("没有可处理的图片（全部已是本地 WebP 或全部失败）")
        return 0

    # 阶段二：编码；总大小超过目标就逐级降 quality（最低 50）
    target_bytes = max(1, int(args.target_mb * 1024 * 1024))
    quality = max(1, min(100, int(args.quality)))
    untouched = before_bytes - sum(
        os.path.getsize(item["old"]) for item in prepared if item["old"] and os.path.isfile(item["old"]))
    encoded: Dict[str, bytes] = {}
    while True:
        encoded = {}
        for item in prepared:
            try:
                encoded[item["value"]] = _encode_webp(item["content"], args.resize, quality)
            except Exception as exc:
                failed.append("%s -> 编码失败：%s" % (item["value"][:90], exc))
                print("  [失败] %s -> 编码失败：%s" % (item["value"][:90], exc))
        total_after = untouched + sum(len(blob) for blob in encoded.values())
        if total_after <= target_bytes or quality <= 50:
            break
        quality -= 5
        print("  总大小 %.1f MB 超过目标 %.1f MB，降到 quality=%d 重来" % (
            total_after / 1024.0 / 1024.0, args.target_mb, quality))

    # 阶段三：落盘（写 webp、删旧文件、生成 URL 映射）
    os.makedirs(COVERS_DIR, exist_ok=True)
    mapping: Dict[str, str] = {}
    for item in prepared:
        blob = encoded.get(item["value"])
        if blob is None:
            continue
        target = os.path.join(COVERS_DIR, item["stem"] + WEBP_EXT)
        with open(target, "wb") as fh:
            fh.write(blob)
        mapping[item["value"]] = LOCAL_PREFIX + item["stem"] + WEBP_EXT
        old = item["old"]
        if old and os.path.isfile(old) and os.path.abspath(old) != os.path.abspath(target):
            try:
                os.remove(old)
            except OSError as exc:
                print("  [提示] 旧文件删除失败 %s: %s" % (old, exc))

    if not mapping:
        print("没有可改写的 URL")
        return 0

    def rewrite(node):
        if isinstance(node, dict):
            for key in list(node.keys()):
                value = node.get(key)
                if isinstance(value, str) and value in mapping:
                    node[key] = mapping[value]
                elif isinstance(value, (dict, list)):
                    rewrite(value)
        elif isinstance(node, list):
            for item in node:
                rewrite(item)

    rewrite(catalog)
    if isinstance(catalog_payload.get("data"), dict):
        _atomic_write_json(os.path.join(STORE_DIR, "catalog.json"), catalog_payload)
    else:
        _atomic_write_json(os.path.join(STORE_DIR, "catalog.json"), catalog)

    changed = 0
    for name, data in details.items():
        before = json.dumps(data, ensure_ascii=False, sort_keys=True)
        rewrite(data)
        if json.dumps(data, ensure_ascii=False, sort_keys=True) != before:
            _atomic_write_json(os.path.join(DETAILS_DIR, name), data)
            changed += 1

    after_bytes = _dir_bytes(COVERS_DIR)
    max_name, max_size = _max_file(COVERS_DIR)
    ratio = (1 - (after_bytes / float(before_bytes))) * 100 if before_bytes else 0.0
    print("源图 %.1f MB -> 封面目录 %.1f MB（减少 %.1f%%），最大单张 %s %.0f KB，quality=%d，resize≤%d" % (
        source_bytes / 1024.0 / 1024.0, after_bytes / 1024.0 / 1024.0, ratio,
        max_name, max_size / 1024.0, quality, args.resize))
    print("改写 catalog.json 与 %d 个详情文件；失败 %d 张" % (changed, len(failed)))
    if failed:
        for line in failed[:10]:
            print("  -", line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
