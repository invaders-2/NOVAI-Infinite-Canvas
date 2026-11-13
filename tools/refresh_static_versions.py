#!/usr/bin/env python3
"""把 static/*.html 里 /static/**/*.{js,css,html} 引用的 ?v= 重写成 <VERSION>.<被引用文件 mtime>。

跟 main.py 的 sync_static_html_versions() 同口径（后端启动时会自己重写一遍静态页）：发版 bump 版本号后
先把工作树里的值刷新掉，否则断言 ?v=旧版本 的测试会集体变红。

用法：
  python3 tools/refresh_static_versions.py          # dry-run，只打印将改哪些文件
  python3 tools/refresh_static_versions.py --write  # 落盘
"""
import os
import re
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(ROOT, "static")
VERSION_FILE = os.path.join(ROOT, "VERSION")

# 两条正则与 main.py 的 versioned_static_html / sync_static_html_versions 保持一字不差
STATIC_REF_RE = re.compile(r'(?P<prefix>(?:src|href)=["\']|@import\s+url\(["\'])(?P<url>/static/[^"\')?#]+(?:\.(?:js|css|html)))(?:\?v=[^"\')#]*)?', re.I)
QUERY_V_RE = re.compile(r'([?&]v=)[^"\'\x60\s<>)]*')


def read_version():
    with open(VERSION_FILE, "r", encoding="utf-8") as f:
        return (f.read().strip().splitlines() or [""])[0].strip()


def cache_version(url, safe_version):
    try:
        rel = urllib.parse.unquote(url[len("/static/"):]).replace("/", os.sep)
        path = os.path.abspath(os.path.join(STATIC_DIR, rel))
        static_root = os.path.abspath(STATIC_DIR)
        if path.startswith(static_root + os.sep) and os.path.isfile(path):
            return "%s.%d" % (safe_version, int(os.path.getmtime(path)))
    except Exception:
        pass
    return safe_version


def rewrite(html, safe_version):
    normalized = QUERY_V_RE.sub(lambda match: match.group(1) + safe_version, html)

    def replace(match):
        url = match.group("url")
        return match.group("prefix") + url + "?v=" + cache_version(url, safe_version)

    updated = STATIC_REF_RE.sub(replace, normalized)
    before = [match.group(0) for match in QUERY_V_RE.finditer(html)]
    after = [match.group(0) for match in QUERY_V_RE.finditer(updated)]
    changed = abs(len(before) - len(after)) + sum(1 for old, new in zip(before, after) if old != new)
    return updated, changed


def scan(safe_version):
    targets = []
    for name in sorted(os.listdir(STATIC_DIR)):
        # 跳过 macOS 在外置硬盘上生成的 ._ AppleDouble 二进制元数据文件
        if name.startswith("._") or not name.lower().endswith(".html"):
            continue
        path = os.path.join(STATIC_DIR, name)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                old = f.read()
        except Exception as exc:
            print("跳过 static/%s：%s" % (name, exc))
            continue
        new, changed = rewrite(old, safe_version)
        if new != old:
            targets.append((name, path, new, changed))
    return targets


def refresh(write=False, verbose=True):
    version = read_version()
    if not version:
        raise SystemExit("根 VERSION 是空的，先跑 tools/bump_version.py")
    safe_version = urllib.parse.quote(version, safe="._-")

    first_pass = scan(safe_version)
    total_changes = sum(item[3] for item in first_pass)
    touched = {item[0]: item[3] for item in first_pass}

    if not write:
        if verbose:
            for name, _path, _new, changed in first_pass:
                print("  将刷新 static/%s（%d 处）" % (name, changed))
            print("dry-run：%d 个静态页、共 %d 处待刷新（VERSION %s，加 --write 才落盘）" % (len(first_pass), total_changes, version))
        return len(first_pass), total_changes

    # 为什么不止刷一遍：html 之间也会互相引用，本轮写盘会刷新被引用 html 的 mtime，
    # 引用它的 index.html 就还得再刷一轮；轮数有上限，稳定即停。
    for round_index in range(4):
        if round_index > 0:
            targets = scan(safe_version)
            if not targets:
                break
            total_changes += sum(item[3] for item in targets)
            for name, _path, _new, changed in targets:
                touched[name] = changed
        else:
            targets = first_pass
        for name, path, new, _changed in targets:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(new)

    if verbose:
        for name in sorted(touched):
            print("  已刷新 static/%s（%d 处）" % (name, touched[name]))
        print("已刷新 %d 个静态页的缓存版本号（共 %d 处，VERSION %s）" % (len(touched), total_changes, version))
    return len(touched), total_changes


def main():
    refresh(write="--write" in sys.argv[1:])


if __name__ == "__main__":
    main()
