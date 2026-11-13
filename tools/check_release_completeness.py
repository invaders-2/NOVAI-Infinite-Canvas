#!/usr/bin/env python3
"""校验某个发版 tag 的 GitHub Release 资产与国内镜像（ModelScope / Gitee）是否齐全。

用法：
    python3 tools/check_release_completeness.py v2.0.06
    python3 tools/check_release_completeness.py v2.0.06 --write-summary /tmp/mirror-summary.md

token 从环境变量读：
    GH_TOKEN / GITHUB_TOKEN   GitHub API（不设则匿名，限流 60 次/小时）
    MODELSCOPE_TOKEN          ModelScope 仓库文件 API（公开仓库可匿名只读）

退出码：
    0  必需项全部齐全
    1  有缺失或不一致（逐条列出缺失文件与受影响的客户端）
    2  参数 / 网络错误，无法完成检查

检查范围（客户端真正会去拉的东西，见 main.py 397-413 与 desktop/main.js 3287-3290）：
    1) GitHub Release 存在，latest*.yml 与它们引用的安装包都在；
    2) ModelScope 根目录有 VERSION、static/update-notes.json，且版本与 tag 一致；
    3) ModelScope electron-release/ 有 latest*.yml，且清单引用的安装包/增量包都在；
    4) Gitee Release 有安装包（超过 95MB 的按 .partNN 分卷）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

GITHUB_API = "https://api.github.com"
MODELSCOPE_API = "https://modelscope.cn/api/v1/models"
GITEE_API = "https://gitee.com/api/v5/repos"

DEFAULT_GITHUB_REPO = "invaders-2/NOVAI-Infinite-Canvas"
DEFAULT_MODELSCOPE_REPO = "bllack/NOVAI-releases"
DEFAULT_GITEE_REPO = "invaders/novai"
DEFAULT_BRANCH = "master"
GITEE_SPLIT_LIMIT = 95 * 1024 * 1024

ELECTRON_ASSET_SUFFIXES = (".exe", ".dmg", ".zip", ".AppImage", ".deb", ".blockmap")
YML_RE = re.compile(r"^latest(?:-mac|-linux)?\.yml$")
ASSET_URL_RE = re.compile(r"^\s*-?\s*url:\s*(.+?)\s*$")

RESULTS = []


class HttpError(Exception):
    def __init__(self, code, url, body=""):
        super().__init__(f"HTTP {code} {url}")
        self.code = code
        self.url = url
        self.body = body


def request(url, headers=None, timeout=30, method="GET"):
    req = urllib.request.Request(url, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:400]
        except Exception:
            pass
        raise HttpError(exc.code, url, body) from exc
    except Exception as exc:  # URLError / timeout / 证书等
        raise HttpError(0, url, str(exc)) from exc


def request_json(url, headers=None, timeout=30):
    _, body = request(url, headers=headers, timeout=timeout)
    return json.loads(body.decode("utf-8", "replace"))


def add(area, name, ok, detail="", impact="", target="", level="required"):
    RESULTS.append({
        "area": area,
        "name": name,
        "ok": bool(ok),
        "detail": detail,
        "impact": impact,
        "target": target,
        "level": level,
    })


def version_key(value):
    """v2.0.06 / 2.0.6 / 2.0.6-beta.1 → ((2, 0, 6), 'beta.1')；无法解析返回 None。"""
    text = str(value or "").strip()
    if not text:
        return None
    text = text.lstrip("vV")
    match = re.match(r"^(\d+(?:\.\d+)*)(.*)$", text)
    if not match:
        return None
    nums = [int(part) for part in match.group(1).split(".")]
    while len(nums) > 1 and nums[-1] == 0:
        nums.pop()
    return (tuple(nums), match.group(2).strip().lower())


def same_version(left, right):
    key_left, key_right = version_key(left), version_key(right)
    if key_left is None or key_right is None:
        return False
    return key_left == key_right


def human_size(size):
    try:
        size = int(size)
    except (TypeError, ValueError):
        return "未知大小"
    if size >= 1024 ** 3:
        return f"{size / 1024 ** 3:.2f} GB"
    if size >= 1024 ** 2:
        return f"{size / 1024 ** 2:.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size} B"


def is_electron_asset(name):
    """GitHub Release 里由 build-electron 产出的更新产物（不含传统 NOVAI-Setup-* 安装包）。"""
    if not name or name.startswith("NOVAI-Setup-"):
        return False
    return name.endswith(ELECTRON_ASSET_SUFFIXES)


def gitee_impact_of(name):
    if name.startswith("NOVAI-Electron-Setup-"):
        return "Gitee 网页人工下载缺 Electron 安装包（自动更新走 ModelScope，不受影响）"
    return impact_of(name)


def is_installer_asset(name):
    """Gitee 人工下载镜像需要的安装包：传统安装版 + Electron 安装版。"""
    return bool(name.endswith((".exe", ".dmg")) and (
        name.startswith("NOVAI-Setup-") or name.startswith("NOVAI-Electron-Setup-")
    ))


def platform_of(name):
    if "Electron-Setup" in name or name.endswith((".exe", ".exe.blockmap")):
        return "Windows"
    if "-mac.zip" in name or name.endswith((".dmg", ".dmg.blockmap")):
        return "macOS"
    if name.endswith((".AppImage", ".deb")):
        return "Linux"
    return "客户端"


def impact_of(name):
    if name == "VERSION":
        return "国内一键更新（Python 版 / 网页版 / 桌面端源码更新）检测不到新版本"
    if name == "static/update-notes.json":
        return "国内网络下「升级后更新说明」弹窗拿不到内容或显示旧内容"
    if name == "electron-release/latest.yml":
        return "Windows 客户端国内自动更新检查失败"
    if name == "electron-release/latest-mac.yml":
        return "macOS 客户端国内自动更新检查失败"
    if name == "electron-release/latest-linux.yml":
        return "Linux 客户端国内自动更新检查失败"
    if name.endswith(".blockmap"):
        return f"{platform_of(name)} 增量下载退化为全量下载（仍可更新，流量和耗时变大）"
    if is_electron_asset(name):
        return f"{platform_of(name)} 客户端国内自动更新下载 404"
    if name.startswith("NOVAI-Setup-") or name.startswith("NOVAI-Electron-Setup-"):
        return "Gitee 网页人工下载缺安装包（自动更新不受影响）"
    return "客户端更新链路"


def parse_manifest(text):
    """解析 electron-builder 的 latest*.yml（只取 version 与 files[].url，避免依赖 PyYAML）。"""
    version = ""
    urls = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if not version and line.startswith("version:"):
            version = line.split(":", 1)[1].strip().strip("'\"")
            continue
        match = ASSET_URL_RE.match(raw)
        if match and not line.startswith("path:"):
            url = match.group(1).strip().strip("'\"")
            if url:
                urls.append(url)
    return version, urls


def github_headers(token):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "novai-release-completeness-check",
    }
    if token:
        headers["Authorization"] = f"token {token}"
    return headers


def fetch_github_release(repo, tag, headers, timeout):
    url = f"{GITHUB_API}/repos/{repo}/releases/tags/{urllib.parse.quote(tag, safe='')}"
    return request_json(url, headers=headers, timeout=timeout)


def download_release_asset(asset, headers, timeout):
    octet = dict(headers)
    octet["Accept"] = "application/octet-stream"
    _, body = request(asset.get("url") or "", headers=octet, timeout=timeout)
    return body


def modelscope_file_list(repo, branch, token, timeout):
    url = f"{MODELSCOPE_API}/{repo}/repo/files?Revision={urllib.parse.quote(branch)}&Recursive=true"
    headers = {"User-Agent": "novai-release-completeness-check"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = request_json(url, headers=headers, timeout=timeout)
    files = ((payload.get("Data") or {}).get("Files")) or []
    out = {}
    for entry in files:
        if not isinstance(entry, dict) or entry.get("Type") != "blob":
            continue
        path = str(entry.get("Path") or "").replace("\\", "/")
        if path:
            try:
                out[path] = int(entry.get("Size") or 0)
            except (TypeError, ValueError):
                out[path] = 0
    return out


def modelscope_file_bytes(repo, branch, path, token, timeout):
    url = (
        f"{MODELSCOPE_API}/{repo}/repo?Revision={urllib.parse.quote(branch)}"
        f"&FilePath={urllib.parse.quote(path, safe='/')}"
    )
    headers = {"User-Agent": "novai-release-completeness-check"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    _, body = request(url, headers=headers, timeout=timeout)
    return body


def modelscope_target_url(repo, branch, path):
    return f"https://modelscope.cn/models/{repo}/resolve/{branch}/{path}"


def gitee_release(repo, tag, timeout):
    url = f"{GITEE_API}/{repo}/releases/tags/{urllib.parse.quote(tag, safe='')}"
    return request_json(url, headers={"User-Agent": "novai-release-completeness-check"}, timeout=timeout)


def check_github_release(args, headers):
    """返回 (release_assets, electron_assets, expected_yml)。拿不到时返回空集合继续查镜像。"""
    try:
        release = fetch_github_release(args.github_repo, args.tag, headers, args.timeout)
    except HttpError as exc:
        if exc.code == 404:
            add("GitHub Release", f"tag {args.tag}", False,
                "Release 不存在（tag 还没发布或拼错）",
                "所有客户端的自动更新全部不可用")
        else:
            hint = "" if (os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN")) else "（匿名限流，请设置 GH_TOKEN）"
            add("GitHub Release", f"tag {args.tag}", False,
                f"查询失败：{exc}{hint}",
                "无法确认 GitHub Release 是否完整")
        return {}, set(), set()

    assets = {}
    for asset in release.get("assets") or []:
        name = str(asset.get("name") or "")
        if name:
            assets[name] = int(asset.get("size") or 0)
    add("GitHub Release", f"tag {args.tag}", True,
        f"{len(assets)} 个资产，草稿={bool(release.get('draft'))} 预发布={bool(release.get('prerelease'))}")

    electron_assets = {name for name in assets if is_electron_asset(name)}
    expected_yml = {name for name in assets if YML_RE.match(name)}

    has_win = any(name.endswith(".exe") and not name.endswith(".blockmap") for name in electron_assets)
    has_mac = any(name.endswith(("-mac.zip", ".dmg")) for name in electron_assets)
    has_linux = any(name.endswith((".AppImage", ".deb")) for name in electron_assets)
    for name, needed in (("latest.yml", has_win), ("latest-mac.yml", has_mac), ("latest-linux.yml", has_linux)):
        if not needed:
            continue
        if name in assets:
            add("GitHub Release", name, True, "更新清单存在")
        else:
            platform = {"latest.yml": "Windows", "latest-mac.yml": "macOS", "latest-linux.yml": "Linux"}[name]
            add("GitHub Release", name, False, "Release 里有该平台安装包，但没有更新清单",
                f"{platform} 客户端自动更新无法检查更新")

    for name in sorted(expected_yml):
        try:
            asset = next(a for a in release.get("assets") or [] if a.get("name") == name)
            text = download_release_asset(asset, headers, args.timeout).decode("utf-8", "replace")
        except Exception as exc:
            add("GitHub Release", name, False, f"下载清单失败：{exc}", "无法校验更新清单内容")
            continue
        manifest_version, urls = parse_manifest(text)
        if same_version(manifest_version, args.tag):
            add("GitHub Release", f"{name} 版本", True, f"version={manifest_version}")
        else:
            add("GitHub Release", f"{name} 版本", False,
                f"清单 version={manifest_version or '空'}，tag={args.tag}",
                "客户端会认为没有新版本或提示错误版本")
        for url in urls:
            target_name = os.path.basename(url.split("?")[0])
            if target_name in assets:
                continue
            add("GitHub Release", f"{name} → {target_name}", False,
                "清单引用的安装包不在 Release 资产里",
                impact_of(target_name))
    return assets, electron_assets, expected_yml


def check_modelscope(args, github_assets, electron_assets, expected_yml, token):
    try:
        listing = modelscope_file_list(args.modelscope_repo, args.branch, token, args.timeout)
    except HttpError as exc:
        add("ModelScope", "仓库文件列表", False, f"读取失败：{exc}",
            "国内自动更新源不可用（可能是仓库私有或接口不可达）")
        return
    add("ModelScope", "仓库文件列表", True, f"{len(listing)} 个文件",
        target=modelscope_target_url(args.modelscope_repo, args.branch, ""))

    if "VERSION" in listing:
        try:
            remote_version = modelscope_file_bytes(
                args.modelscope_repo, args.branch, "VERSION", token, args.timeout
            ).decode("utf-8", "replace").strip()
        except HttpError as exc:
            add("ModelScope", "VERSION", False, f"读取失败：{exc}", impact_of("VERSION"))
        else:
            if same_version(remote_version, args.tag):
                add("ModelScope", "VERSION", True, f"版本 {remote_version}",
                    target=modelscope_target_url(args.modelscope_repo, args.branch, "VERSION"))
            else:
                add("ModelScope", "VERSION", False,
                    f"镜像版本 {remote_version or '空'}，tag={args.tag}（没同步）",
                    impact_of("VERSION"))
    else:
        add("ModelScope", "VERSION", False, "文件不存在", impact_of("VERSION"))

    notes_path = "static/update-notes.json"
    if notes_path in listing:
        try:
            notes = json.loads(modelscope_file_bytes(
                args.modelscope_repo, args.branch, notes_path, token, args.timeout
            ).decode("utf-8", "replace"))
        except Exception as exc:
            add("ModelScope", notes_path, False, f"读取/解析失败：{exc}", impact_of(notes_path))
        else:
            notes_version = str(notes.get("version") or "")
            if same_version(notes_version, args.tag):
                count = len(notes.get("items") or [])
                add("ModelScope", notes_path, True, f"版本 {notes_version}，{count} 条更新说明",
                    target=modelscope_target_url(args.modelscope_repo, args.branch, notes_path))
            else:
                add("ModelScope", notes_path, False,
                    f"镜像版本 {notes_version or '空'}，tag={args.tag}（没同步）",
                    impact_of(notes_path))
    else:
        add("ModelScope", notes_path, False, "文件不存在", impact_of(notes_path))

    mirror_yml = {name for name in listing
                  if name.startswith("electron-release/") and YML_RE.match(name.split("/", 1)[1])}
    for name in sorted(expected_yml):
        target = f"electron-release/{name}"
        if target not in listing:
            add("ModelScope", target, False, "文件不存在", impact_of(target))
    if not mirror_yml and not expected_yml:
        add("ModelScope", "electron-release/latest*.yml", False,
            "镜像里没有任何 electron 更新清单", "所有平台国内自动更新检查失败")

    referenced = set()
    for target in sorted(mirror_yml):
        try:
            text = modelscope_file_bytes(
                args.modelscope_repo, args.branch, target, token, args.timeout
            ).decode("utf-8", "replace")
        except HttpError as exc:
            add("ModelScope", target, False, f"读取失败：{exc}", impact_of(target))
            continue
        manifest_version, urls = parse_manifest(text)
        if same_version(manifest_version, args.tag):
            add("ModelScope", target, True, f"version={manifest_version}",
                target=modelscope_target_url(args.modelscope_repo, args.branch, target))
        else:
            add("ModelScope", target, False,
                f"清单 version={manifest_version or '空'}，tag={args.tag}（旧版本清单没被覆盖）",
                impact_of(target))

        base_name = target.split("/", 1)[1]
        for url in urls:
            file_name = os.path.basename(url.split("?")[0])
            referenced.add(file_name)
            mirror_path = f"electron-release/{file_name}"
            release_size = github_assets.get(file_name, 0)
            if mirror_path not in listing:
                add("ModelScope", mirror_path, False,
                    f"{base_name} 引用了它，但镜像里没有",
                    impact_of(mirror_path))
                continue
            mirror_size = listing.get(mirror_path) or 0
            if release_size and mirror_size and mirror_size != release_size:
                add("ModelScope", mirror_path, False,
                    f"大小不符：镜像 {human_size(mirror_size)}，Release {human_size(release_size)}",
                    impact_of(mirror_path))
            else:
                add("ModelScope", mirror_path, True,
                    f"{human_size(mirror_size)}（{base_name} 引用）",
                    target=modelscope_target_url(args.modelscope_repo, args.branch, mirror_path))

    for name in sorted(electron_assets):
        if name in referenced:
            continue
        mirror_path = f"electron-release/{name}"
        if mirror_path in listing:
            continue
        add("ModelScope", mirror_path, False,
            "Release 里有、镜像里没有（清单没引用，但增量更新要用）",
            impact_of(name))


def check_gitee(args, github_assets, timeout):
    try:
        release = gitee_release(args.gitee_repo, args.tag, timeout)
    except HttpError as exc:
        if exc.code == 404:
            add("Gitee", f"Release {args.tag}", False, "Release 不存在",
                "国内网页人工下载没有安装包（自动更新不受影响）")
        else:
            add("Gitee", f"Release {args.tag}", False, f"查询失败：{exc}",
                "未能校验 Gitee 分卷（不影响自动更新）", level="warn")
        return

    if not isinstance(release, dict):
        add("Gitee", f"Release {args.tag}", False, "Release 不存在",
            "国内网页人工下载没有安装包（自动更新不受影响）")
        return
    names = {str(asset.get("name") or "") for asset in (release.get("assets") or [])}
    add("Gitee", f"Release {args.tag}", True, f"{len(names)} 个附件")

    for name in sorted(github_assets):
        if not is_installer_asset(name):
            continue
        size = github_assets.get(name) or 0
        if size > GITEE_SPLIT_LIMIT:
            parts = (size + GITEE_SPLIT_LIMIT - 1) // GITEE_SPLIT_LIMIT
            expected = [f"{name}.part{index:02d}" for index in range(parts)]
            missing = [part for part in expected if part not in names]
            if missing:
                add("Gitee", name, False,
                    f"缺少分卷：{', '.join(missing)}（应为 {parts} 卷）",
                    gitee_impact_of(name))
            else:
                add("Gitee", name, True, f"{parts} 个分卷齐全")
        elif name in names:
            add("Gitee", name, True, human_size(size))
        else:
            add("Gitee", name, False, "附件不存在", gitee_impact_of(name))

    for name in ("latest.yml", "latest-mac.yml", "latest-linux.yml"):
        if name in names:
            add("Gitee", name, True, "人工下载参考清单")
        elif name in github_assets:
            add("Gitee", name, False, "Release 有、Gitee 没有（不影响客户端自动更新）",
                "人工下载时看不到更新清单", level="warn")

    # Gitee 仓库 main 分支是客户端「Gitee 源码更新源」，不归镜像脚本管；缺了只提醒，不判失败
    raw_url = f"https://gitee.com/{args.gitee_repo}/raw/main/VERSION"
    try:
        _, body = request(raw_url, headers={"User-Agent": "novai-release-completeness-check"}, timeout=timeout)
        raw_version = body.decode("utf-8", "replace").strip()
    except HttpError as exc:
        add("Gitee", "main 分支 VERSION", False, f"读取失败：{exc}",
            "无法确认 Gitee 源码更新源（不影响 GitHub / ModelScope 自动更新）", level="warn")
    else:
        if same_version(raw_version, args.tag):
            add("Gitee", "main 分支 VERSION", True, raw_version, level="warn")
        else:
            add("Gitee", "main 分支 VERSION", False,
                f"main 分支 VERSION={raw_version or '空'}，tag={args.tag}（源码更新源没同步）",
                "Gitee 源的一键更新不可用（客户端会自动跳过，不影响 GitHub / ModelScope）",
                level="warn")


def print_results():
    for item in RESULTS:
        mark = "✅" if item["ok"] else ("⚠️ " if item["level"] == "warn" else "❌")
        print(f"{mark} [{item['area']}] {item['name']}"
              + (f" — {item['detail']}" if item["detail"] else ""))
        if not item["ok"] and item.get("impact"):
            print(f"     影响：{item['impact']}")
    failures = [item for item in RESULTS if not item["ok"] and item["level"] == "required"]
    warnings = [item for item in RESULTS if not item["ok"] and item["level"] == "warn"]
    print()
    if failures:
        print(f"结论：❌ {len(failures)} 项必需内容缺失/不一致（共 {len(RESULTS)} 项检查）")
    else:
        print(f"结论：✅ 必需内容齐全（共 {len(RESULTS)} 项检查）")
    if warnings:
        print(f"      另有 {len(warnings)} 项提醒")
    return failures


def build_summary(args, failures, warnings):
    lines = [
        f"## 发版完整性校验 {args.tag}",
        "",
        f"- GitHub 仓库：{args.github_repo}",
        f"- ModelScope 镜像：{args.modelscope_repo}（分支 {args.branch}）",
        f"- Gitee 镜像：{args.gitee_repo}",
        f"- 结论：{'❌ **未通过**（下面列出的文件没同步）' if failures else '✅ **通过**'}",
        "",
    ]
    if failures:
        lines += [
            "### ❌ 缺失 / 不一致（会影响这些端）",
            "",
            "| 位置 | 文件 | 问题 | 影响 |",
            "| --- | --- | --- | --- |",
        ]
        for item in failures:
            lines.append(
                f"| {item['area']} | {item['name']} | {item['detail'] or '缺失'} | {item['impact']} |"
            )
        lines += [
            "",
            "> GitHub Release 已经发布成功，不需要回滚；按 docs/release-checklist.md 跑一次",
            "> sync-mirrors 补传后重新执行本检查即可。",
            "",
        ]
    if warnings:
        lines += ["### ⚠️ 提醒（不影响客户端自动更新）", ""]
        for item in warnings:
            lines.append(f"- {item['area']} {item['name']}：{item['detail']}")
        lines.append("")
    passed = [item for item in RESULTS if item["ok"]]
    if passed:
        lines += [
            f"### ✅ 已通过（{len(passed)} 项）",
            "",
            "| 位置 | 文件 | 结果 |",
            "| --- | --- | --- |",
        ]
        for item in passed:
            target = f"（{item['target']}）" if item.get("target") else ""
            lines.append(f"| {item['area']} | {item['name']} | {item['detail']}{target} |")
        lines.append("")
    lines += [
        "### 检查限制",
        "",
        f"- {'已' if os.getenv('MODELSCOPE_TOKEN') else '未'}提供 MODELSCOPE_TOKEN："
        "公开仓库可匿名只读；私有仓库或限流场景需要 token。",
        f"- {'已' if (os.getenv('GH_TOKEN') or os.getenv('GITHUB_TOKEN')) else '未'}提供 GH_TOKEN："
        "匿名调用 GitHub API 限流 60 次/小时，CI 里请设置。",
        "- Gitee 只做只读校验；分卷按 95MB/卷推算，实际以 Gitee 附件名为准。",
        "",
    ]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="校验某个 tag 的 GitHub Release 与 ModelScope / Gitee 镜像是否齐全（只读，不会写任何远端数据）",
    )
    parser.add_argument("tag", help="发版 tag，例如 v2.0.06")
    parser.add_argument("--github-repo", default=DEFAULT_GITHUB_REPO, help=f"GitHub 仓库（默认 {DEFAULT_GITHUB_REPO}）")
    parser.add_argument("--modelscope-repo", default=DEFAULT_MODELSCOPE_REPO, help=f"ModelScope 仓库（默认 {DEFAULT_MODELSCOPE_REPO}）")
    parser.add_argument("--gitee-repo", default=DEFAULT_GITEE_REPO, help=f"Gitee 仓库（默认 {DEFAULT_GITEE_REPO}）")
    parser.add_argument("--branch", default=DEFAULT_BRANCH, help=f"ModelScope 分支（默认 {DEFAULT_BRANCH}）")
    parser.add_argument("--timeout", type=float, default=30.0, help="单次请求超时秒数（默认 30）")
    parser.add_argument("--write-summary", metavar="PATH", help="把 Markdown 结论追加到这个文件（CI 里传 $GITHUB_STEP_SUMMARY）")
    parser.add_argument("--json", action="store_true", help="只输出 JSON（便于其他脚本消费）")
    parser.add_argument("--skip-gitee", action="store_true", help="跳过 Gitee 校验")
    args = parser.parse_args(argv)

    args.tag = str(args.tag or "").strip()
    if not args.tag:
        print("tag 不能为空", file=sys.stderr)
        return 2

    github_token = os.getenv("GH_TOKEN") or os.getenv("GITHUB_TOKEN") or ""
    modelscope_token = os.getenv("MODELSCOPE_TOKEN") or ""
    headers = github_headers(github_token)

    github_assets, electron_assets, expected_yml = check_github_release(args, headers)
    if not github_assets:
        expected_yml = set()
    check_modelscope(args, github_assets, electron_assets, expected_yml, modelscope_token)
    if not args.skip_gitee:
        check_gitee(args, github_assets, args.timeout)
    else:
        add("Gitee", "校验", True, "已按 --skip-gitee 跳过")

    failures = [item for item in RESULTS if not item["ok"] and item["level"] == "required"]
    warnings = [item for item in RESULTS if not item["ok"] and item["level"] == "warn"]

    if args.json:
        print(json.dumps({
            "tag": args.tag,
            "ok": not failures,
            "results": RESULTS,
            "failures": failures,
            "warnings": warnings,
        }, ensure_ascii=False, indent=1))
    else:
        print(f"== 发版完整性校验 {args.tag} ==")
        if not github_token:
            print("- 未设置 GH_TOKEN：GitHub API 在匿名限流下查询（60 次/小时）")
        if not modelscope_token:
            print("- 未设置 MODELSCOPE_TOKEN：ModelScope 公开仓库可匿名只读；私有仓库无法校验")
        print_results()

    if args.write_summary:
        summary = build_summary(args, failures, warnings)
        try:
            with open(args.write_summary, "a", encoding="utf-8") as handle:
                handle.write(summary + "\n")
            if not args.json:
                print(f"\n已追加 Markdown 结论到 {args.write_summary}")
        except OSError as exc:
            print(f"写 summary 失败：{exc}", file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
