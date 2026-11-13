#!/usr/bin/env python3
"""把版本号一次改到三处：根 VERSION、desktop/.version、desktop/package.json 的 semver。

默认只打印将要改什么（dry-run），加 --write 才落盘。

用法：python3 tools/bump_version.py 2.0.08 [--write]
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION_FILE = os.path.join(ROOT, "VERSION")
DOT_VERSION_FILE = os.path.join(ROOT, "desktop", ".version")
PKG_FILE = os.path.join(ROOT, "desktop", "package.json")

SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?$")
PKG_VERSION_RE = re.compile(r'("version"\s*:\s*")([^"]*)(")')


def read_first_line(path):
    with open(path, "r", encoding="utf-8") as f:
        return (f.read().strip().splitlines() or [""])[0].strip()


def to_semver(display):
    match = SEMVER_RE.match(display)
    if not match:
        raise SystemExit("版本号不是合法的三段式（例：2.0.08）：%r" % display)
    core = ".".join(str(int(part)) for part in match.group(1, 2, 3))
    return core + (match.group(4) or "")


def write_text(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def main():
    parser = argparse.ArgumentParser(description="改版本号：根 VERSION / desktop/.version / desktop/package.json")
    parser.add_argument("version", help="新的显示版本号，例：2.0.08")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="真正落盘（默认只打印将要改什么）")
    mode.add_argument("--dry-run", action="store_true", help="只打印将要改什么（默认行为，写出来更明确）")
    parser.add_argument("--no-static", action="store_true", help="不刷新 static/*.html 里的 ?v= 缓存版本号")
    args = parser.parse_args()

    display = args.version.strip()
    semver = to_semver(display)
    old_display = read_first_line(VERSION_FILE)
    old_dot = read_first_line(DOT_VERSION_FILE) if os.path.exists(DOT_VERSION_FILE) else ""

    with open(PKG_FILE, "r", encoding="utf-8") as f:
        pkg_raw = f.read()
    match = PKG_VERSION_RE.search(pkg_raw)
    if not match:
        raise SystemExit("desktop/package.json 里没找到 version 字段")
    old_pkg = match.group(2)
    pkg_new = pkg_raw[:match.start(2)] + semver + pkg_raw[match.end(2):]

    targets = [
        ("VERSION", VERSION_FILE, old_display, display),
        ("desktop/.version", DOT_VERSION_FILE, old_dot, display),
        ("desktop/package.json", PKG_FILE, old_pkg, semver),
    ]

    print("目标版本：%s（desktop/package.json 写 %s）" % (display, semver))
    for label, _path, old, new in targets:
        print("  %-22s %s → %s%s" % (label, old or "（空）", new, "" if old != new else "（未变）"))

    if not args.write:
        print("（dry-run：没有写任何文件，加 --write 才落盘）")
        if not args.no_static:
            print("（--write 时会顺带刷新 static/*.html 里的 ?v= 缓存版本号）")
    else:
        written = 0
        for label, path, old, new in targets:
            if old == new:
                continue
            if path == PKG_FILE:
                write_text(path, pkg_new)
            else:
                write_text(path, new)
            written += 1
        print("已写入 %d 处：%s → %s" % (written, old_display or "（空）", display))

        if args.no_static:
            print("（已跳过 static/*.html 的 ?v= 缓存版本号刷新：--no-static）")
        else:
            # 为什么自动刷新：缓存版本号是 main.py 启动时按 VERSION 重写的，发版不跑会让断言 ?v=旧版本 的测试变红
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import refresh_static_versions
            files, total = refresh_static_versions.refresh(write=True, verbose=False)
            print("已刷新 %d 个静态页的缓存版本号（共 %d 处）" % (files, total))

    print("提示：记得在根 update-notes.json 顶部补一条 %s 的更新说明，再跑 python3 tools/sync_update_notes.py" % display)


if __name__ == "__main__":
    main()
