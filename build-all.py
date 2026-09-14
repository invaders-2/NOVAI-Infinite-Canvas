#!/usr/bin/env python3
"""NOVAI 一键构建脚本 — PyInstaller 打包 + NSIS 安装包"""

import os
import sys
import shutil
import fnmatch
import subprocess
import platform

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST_DESKTOP = os.path.join(ROOT, "dist-desktop")
APP_NAME = "NOVAI"


def run(cmd, cwd=None, shell=True):
    cwd = cwd or ROOT
    print(f"  $ {cmd}")
    subprocess.run(cmd, shell=shell, cwd=cwd, check=True)


def clean():
    """清理旧的构建产物"""
    print("=== 清理旧产物 ===")
    for d in ["build", "dist", "dist-desktop", "__pycache__"]:
        p = os.path.join(ROOT, d)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
            print(f"  已删除 {d}")
    for f in os.listdir(ROOT):
        if f.endswith(".spec") and f != "NOVAI.spec" and f != "NOVAI-Setup.spec":
            os.remove(os.path.join(ROOT, f))
            print(f"  已删除 {f}")


def install_deps():
    """安装打包依赖"""
    print("=== 安装依赖 ===")
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "pyinstaller", "pywebview", "pystray", "qrcode"],
        check=True, capture_output=False
    )


def build_exe():
    """PyInstaller 打包 launcher.py → NOVAI.exe"""
    print("=== PyInstaller 打包 ===")
    launcher = os.path.join(ROOT, "launcher.py")

    # 收集 hidden imports
    hidden = [
        "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
        "fastapi", "aiofiles", "pydantic", "python_multipart", "httpx", "PIL",
        "webview", "webview.platforms.winforms",
        "clr", "pythonnet",  # pywebview WinForms 后端依赖
        "requests",
        "pystray", "pystray._win32", "pystray._util", "six",  # 系统托盘
        "qrcode", "qrcode.main", "qrcode.constants", "qrcode.util",  # 局域网二维码
    ]

    cmd_parts = [
        "pyinstaller",
        "--onefile",
        "--console",
        "--noconfirm",
        f"--name={APP_NAME}",
        f"--icon=static/images/icon.ico",
    ]
    for h in hidden:
        cmd_parts.append(f"--hidden-import={h}")
    cmd_parts.append(f'"{launcher}"')

    cmd = " ".join(cmd_parts)
    run(cmd)

    # 复制到 dist-desktop
    os.makedirs(DIST_DESKTOP, exist_ok=True)
    src_exe = os.path.join(ROOT, "dist", f"{APP_NAME}.exe")
    if not os.path.exists(src_exe):
        print("❌ PyInstaller 打包失败，未找到 dist/NOVAI.exe")
        sys.exit(1)
    shutil.copy(src_exe, os.path.join(DIST_DESKTOP, f"{APP_NAME}.exe"))
    print(f"✅ NOVAI.exe → {DIST_DESKTOP}")


def copy_assets():
    """复制业务文件到 dist-desktop"""
    print("=== 复制业务文件 ===")

    # 可更新文件
    for f in ["main.py", "app.py", "VERSION", "requirements.txt",
              "安装即梦CLI.bat", "登录即梦CLI.bat"]:
        src = os.path.join(ROOT, f)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(DIST_DESKTOP, f))

    # 目录（排除测试图片、API 配置、日志等敏感/临时文件）
    COPY_IGNORE = shutil.ignore_patterns(
        "*.pyc", "__pycache__",
        "test-*.png", "tmp_*.png", "*.log", ".env",
    )
    for folder in ["static", "tools", "packages"]:
        src = os.path.join(ROOT, folder)
        dst = os.path.join(DIST_DESKTOP, folder)
        if os.path.isdir(dst):
            shutil.rmtree(dst, ignore_errors=True)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=COPY_IGNORE)

    # assets（排除 input/output/uploads + 测试图片/日志，安装后运行时创建）
    ASSET_SKIP_ITEMS = {"input", "output", "uploads"}
    ASSET_IGNORE = shutil.ignore_patterns("*.pyc", "__pycache__", "test-*.png", "tmp_*.png", "*.log")
    dst_assets = os.path.join(DIST_DESKTOP, "assets")
    os.makedirs(dst_assets, exist_ok=True)
    for item in os.listdir(os.path.join(ROOT, "assets")):
        if item in ASSET_SKIP_ITEMS:
            continue
        # 跳过测试图片和日志等临时文件
        if any(fnmatch.fnmatch(item, pat) for pat in ("test-*.png", "tmp_*.png", "*.log")):
            continue
        src_p = os.path.join(ROOT, "assets", item)
        dst_p = os.path.join(dst_assets, item)
        if os.path.isfile(src_p):
            shutil.copy2(src_p, dst_p)
        elif os.path.isdir(src_p):
            if os.path.isdir(dst_p):
                shutil.rmtree(dst_p, ignore_errors=True)
            shutil.copytree(src_p, dst_p, ignore=ASSET_IGNORE)

    print(f"✅ 业务文件已复制到 {DIST_DESKTOP}")


def build_installer():
    """NSIS 编译安装包"""
    print("=== NSIS 编译安装包 ===")
    nsi_path = os.path.join(ROOT, "installer.nsi")

    # 查找 makensis
    makensis_paths = [
        r"C:\Program Files (x86)\NSIS\makensis.exe",
        r"C:\Program Files\NSIS\makensis.exe",
    ]
    makensis = None
    for p in makensis_paths:
        if os.path.isfile(p):
            makensis = p
            break

    if not makensis:
        # 尝试从 PATH 找
        try:
            result = subprocess.run(["where", "makensis"], capture_output=True, text=True, check=False)
            if result.returncode == 0:
                makensis = result.stdout.strip().split("\n")[0]
        except Exception:
            pass

    if not makensis:
        print("⚠️  未找到 NSIS，跳过安装包编译")
        print("   请安装 NSIS: https://nsis.sourceforge.io/Download")
        return

    # 从 VERSION 文件读取版本号，传给 NSIS（installer.nsi 用 !ifndef 兜底）
    version = ""
    version_file = os.path.join(ROOT, "VERSION")
    if os.path.isfile(version_file):
        try:
            with open(version_file, encoding="utf-8") as f:
                version = f.read().strip().splitlines()[0].strip()
        except Exception:
            pass
    if not version:
        version = "1.0.84"
    print(f"  版本号: {version}")

    run(f'"{makensis}" /DPRODUCT_VERSION="{version}" "{nsi_path}"')
    print(f"✅ 安装包已生成到 {DIST_DESKTOP}")


def main():
    os.chdir(ROOT)

    print(f"=== NOVAI 桌面版构建 ===")
    print(f"平台: {platform.system()}")
    print(f"目录: {ROOT}")
    print()

    try:
        install_deps()
        clean()
        build_exe()
        copy_assets()
        build_installer()

        print()
        print("=" * 50)
        print("✅ 构建完成！")
        print(f"   EXE: {os.path.join(DIST_DESKTOP, APP_NAME + '.exe')}")
        print(f"   安装包: {DIST_DESKTOP}")
        print("=" * 50)
    except subprocess.CalledProcessError as e:
        print(f"\n❌ 构建失败: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
