#!/usr/bin/env python3
"""校验三处版本号一致：根 VERSION、desktop/.version（显示串）、desktop/package.json（归一化 semver）。

更新说明（根 update-notes.json 最新一版）与 VERSION 不一致时只警告，不影响退出码。

用法：python3 tools/check_version_consistency.py
退出码：0 一致 / 1 不一致
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION_FILE = os.path.join(ROOT, "VERSION")
DOT_VERSION_FILE = os.path.join(ROOT, "desktop", ".version")
PKG_FILE = os.path.join(ROOT, "desktop", "package.json")
NOTES_FILE = os.path.join(ROOT, "update-notes.json")

SEMVER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?$")


def read_first_line(path):
    with open(path, "r", encoding="utf-8") as f:
        return (f.read().strip().splitlines() or [""])[0].strip()


def to_semver(display):
    match = SEMVER_RE.match(display)
    if not match:
        return None
    core = ".".join(str(int(part)) for part in match.group(1, 2, 3))
    return core + (match.group(4) or "")


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def latest_notes_version():
    data = read_json(NOTES_FILE)
    versions = data.get("versions") or []
    if not versions or not isinstance(versions[0], dict):
        return ""
    return str(versions[0].get("version") or "").strip()


def main():
    try:
        display = read_first_line(VERSION_FILE)
    except OSError as exc:
        print("✗ 读不到根 VERSION：%s" % exc)
        return 1
    if not display:
        print("✗ 根 VERSION 是空的")
        return 1

    problems = []
    warnings = []

    semver = to_semver(display)
    if not semver:
        problems.append("根 VERSION 不是合法的三段式版本号：%r" % display)

    try:
        dot = read_first_line(DOT_VERSION_FILE)
    except OSError as exc:
        dot = ""
        problems.append("读不到 desktop/.version：%s" % exc)
    if dot and dot != display:
        problems.append("desktop/.version 是 %r，根 VERSION 是 %r（显示串必须完全一致）" % (dot, display))
    if not dot and not any("desktop/.version" in item for item in problems):
        problems.append("desktop/.version 是空的")

    try:
        pkg_version = str(read_json(PKG_FILE).get("version") or "").strip()
    except Exception as exc:
        pkg_version = ""
        problems.append("读不到 desktop/package.json 的 version：%s" % exc)
    if semver and pkg_version and pkg_version != semver:
        problems.append("desktop/package.json version 是 %r，应当是 %r（根 VERSION 归一化后的 semver）" % (pkg_version, semver))
    if semver and not pkg_version:
        problems.append("desktop/package.json 的 version 是空的")

    try:
        notes_version = latest_notes_version()
    except Exception as exc:
        notes_version = ""
        warnings.append("读不到根 update-notes.json 的最新版本：%s" % exc)
    if notes_version and notes_version != display:
        warnings.append("更新说明写的是 %s，VERSION 是 %s（发版前二选一对齐）" % (notes_version, display))

    for warning in warnings:
        print("警告：" + warning)

    if problems:
        for problem in problems:
            print("✗ " + problem)
        print("版本号不一致：%d 处需要先对齐" % len(problems))
        return 1

    print("OK：VERSION %s = desktop/.version %s = desktop/package.json %s（更新说明 %s）" % (display, dot, pkg_version, notes_version or "—"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
