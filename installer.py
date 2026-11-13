#!/usr/bin/env python3
"""NOVAI 安装程序 — 独立安装包"""
import os, sys, shutil, pythoncom
from win32com.client import Dispatch

APP_NAME = "NOVAI 智能画布"
INSTALL_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "NOVAI")
# 安装目录同时是默认数据根：覆盖安装 / 卸载都不能碰这几项（详见 README「数据目录与卸载」）
PRESERVE_DIRS = ('data', 'output', 'assets', 'API')
PRESERVE_FILES = ('history.json',)

def is_admin():
    try: return os.getuid() == 0
    except: return False

def request_admin():
    """重新以管理员身份运行"""
    import ctypes
    if ctypes.windll.shell32.IsUserAnAdmin(): return True
    ctypes.windll.shell32.ShellExecuteW(
        None, "runas", sys.executable, " ".join(sys.argv), None, 1
    )
    sys.exit(0)

def install():
    # 尝试管理员安装到 Program Files
    try_admin = False
    try:
        import ctypes
        if not ctypes.windll.shell32.IsUserAnAdmin():
            request_admin()
            return
        global INSTALL_DIR
        INSTALL_DIR = os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), "NOVAI")
    except:
        pass
    
    print(f"安装 {APP_NAME} 到 {INSTALL_DIR}")
    
    def create_shortcut(target, shortcut_path, desc="", work_dir=""):
        shell = Dispatch('WScript.Shell')
        s = shell.CreateShortCut(shortcut_path)
        s.TargetPath = target
        s.WorkingDirectory = work_dir or os.path.dirname(target)
        s.Description = desc
        s.IconLocation = target if target.endswith('.exe') else (sys.executable + ',0')
        s.Save()
    
    # 创建安装目录
    os.makedirs(INSTALL_DIR, exist_ok=True)
    
    # 复制文件
    src_dir = os.path.dirname(os.path.abspath(__file__))
    for item in os.listdir(src_dir):
        if item in ('installer.exe', '__pycache__', 'build', 'dist'):
            continue
        src = os.path.join(src_dir, item)
        dst = os.path.join(INSTALL_DIR, item)
        if os.path.isfile(src):
            if item in PRESERVE_FILES and os.path.exists(dst):
                continue
            shutil.copy2(src, dst)
        elif os.path.isdir(src) and item not in PRESERVE_DIRS:
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
    
    # 创建数据目录
    for d in ['data', 'output', 'assets/output']:
        os.makedirs(os.path.join(INSTALL_DIR, d), exist_ok=True)
    
    # 桌面快捷方式
    desktop = os.path.join(os.environ["USERPROFILE"], "Desktop")
    bat_path = os.path.join(INSTALL_DIR, "NOVAI-桌面版.bat")
    create_shortcut(bat_path, os.path.join(desktop, f"{APP_NAME}.lnk"),
                    f"{APP_NAME} 桌面版启动器", INSTALL_DIR)
    
    # 开始菜单
    start_menu = os.path.join(os.environ["APPDATA"], "Microsoft", "Windows", "Start Menu", "Programs")
    novai_menu = os.path.join(start_menu, APP_NAME)
    os.makedirs(novai_menu, exist_ok=True)
    create_shortcut(bat_path, os.path.join(novai_menu, f"{APP_NAME}.lnk"),
                    f"{APP_NAME} 桌面版", INSTALL_DIR)
    
    # 卸载脚本：只删程序文件，用户数据先挪到旁边再挪回来（和 Electron 版一致）
    uninstall = os.path.join(INSTALL_DIR, "卸载.bat")
    keep_root = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "NOVAI-data-keep")
    with open(uninstall, 'w', encoding='utf-8') as f:
        f.write(f'''@echo off
chcp 65001 >nul
echo 正在卸载 {APP_NAME}...
set "ANSWER="
set "DELDATA=0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show('是否一并删除 NOVAI 的用户数据？$([char]10)$([char]10)是 = 一并删除：安装目录里的 data assets output API history.json，以及 %APPDATA%\\NOVAI$([char]10)否 = 保留数据（推荐，默认）：只删程序文件，数据留在安装目录$([char]10)取消 = 退出卸载，不删任何东西','NOVAI 卸载',[System.Windows.Forms.MessageBoxButtons]::YesNoCancel,[System.Windows.Forms.MessageBoxIcon]::Warning,[System.Windows.Forms.MessageBoxDefaultButton]::Button2); Write-Output ([int]$r)" > "%TEMP%\\novai-uninstall-answer.txt" 2>nul
if exist "%TEMP%\\novai-uninstall-answer.txt" (
  set /p ANSWER=<"%TEMP%\\novai-uninstall-answer.txt"
)
del "%TEMP%\\novai-uninstall-answer.txt" 2>nul
if "%ANSWER%"=="2" (
  echo 已取消卸载，未删除任何东西。
  pause
  exit /b
)
if "%ANSWER%"=="6" set "DELDATA=1"
taskkill /F /IM NOVAI.exe 2>nul
timeout /t 2 /nobreak >nul
if "%DELDATA%"=="1" goto novai_delete_all
set "KEEP={keep_root}-%RANDOM%"
mkdir "%KEEP%" 2>nul
for %%D in (data assets output API) do if exist "{INSTALL_DIR}\\%%D" move /y "{INSTALL_DIR}\\%%D" "%KEEP%\\%%D" >nul
if exist "{INSTALL_DIR}\\history.json" move /y "{INSTALL_DIR}\\history.json" "%KEEP%\\history.json" >nul
rmdir /s /q "{INSTALL_DIR}"
mkdir "{INSTALL_DIR}" 2>nul
for %%D in (data assets output API) do if exist "%KEEP%\\%%D" move /y "%KEEP%\\%%D" "{INSTALL_DIR}\\%%D" >nul
if exist "%KEEP%\\history.json" move /y "%KEEP%\\history.json" "{INSTALL_DIR}\\history.json" >nul
rd "%KEEP%" 2>nul
echo 程序已卸载，用户数据保留在 {INSTALL_DIR}
echo （data、assets、output、API 文件夹和 history.json；确认不需要时手动删掉这个目录即可）
goto novai_finish
:novai_delete_all
rmdir /s /q "{INSTALL_DIR}"
rmdir /s /q "%APPDATA%\\NOVAI"
echo 程序和用户数据已删除。
:novai_finish
del "%USERPROFILE%\\Desktop\\{APP_NAME}.lnk" 2>nul
rmdir /s /q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\{APP_NAME}" 2>nul
pause
''')
    
    print(f"✅ 安装完成！")
    print(f"   安装位置: {INSTALL_DIR}")
    print(f"   桌面快捷方式已创建")
    
    # 询问是否启动
    try:
        os.startfile(bat_path)
    except:
        pass

if __name__ == '__main__':
    install()
    input("按回车退出...")
