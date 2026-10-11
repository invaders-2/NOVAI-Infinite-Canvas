#!/usr/bin/env python3
"""生成在线更新用的 update-manifest.json（每个文件的 SHA-256）。

发版前在仓库根目录运行：
    python tools/make_update_manifest.py
把生成的 update-manifest.json 和代码一起提交/上传到各更新源（GitHub / Gitee / ModelScope）。
客户端下载更新后会逐文件校验，任一文件不符就取消更新；清单缺失时放行（兼容旧版本）。
清单范围与 main.py 的 update_allowed_file 一致（根目录白名单 + static/ server/ tools/ assets/models/）。
"""
import hashlib
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT_FILES = {"main.py", "VERSION", "prompt_intelligence.py", "安装即梦CLI.bat", "安装即梦CLI.command", "登录即梦CLI.bat",
              "登录即梦CLI.command", "launcher.py", "novai-desktop.py", "app.py", "build.py", "build-all.py",
              "build-desktop.py", "build-mac.py", "installer.py"}
PREFIXES = ("static/", "server/", "tools/", "assets/models/")


def update_allowed(rel):
    """与 main.py 的 update_allowed_file 保持同一范围：在线更新只会下载这些文件。"""
    return rel in ROOT_FILES or rel.startswith(PREFIXES)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    files = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in {".git", "__pycache__", "venv", "node_modules"}]
        for name in filenames:
            if name in ("update-manifest.json", ".DS_Store") or name.endswith(".pyc"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            if update_allowed(rel):
                files[rel] = sha256_of(full)
    version = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip().splitlines()[0]
    out = os.path.join(ROOT, "update-manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"version": version, "files": dict(sorted(files.items()))}, f, ensure_ascii=False, indent=1)
    print(f"写入 {out}：{len(files)} 个文件，版本 {version}")


if __name__ == "__main__":
    sys.exit(main())
