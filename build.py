#!/usr/bin/env python3
"""NOVAI Desktop 打包脚本 — Windows + Mac 双平台"""
import os, sys, shutil, subprocess, platform

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, 'dist-desktop')
APP_NAME = 'NOVAI'

def run(cmd, cwd=ROOT):
    print(f'  $ {cmd}')
    subprocess.run(cmd, shell=True, cwd=cwd, check=True)

def build_windows():
    """Windows: PyInstaller -> exe"""
    print('=== Windows 打包 ===')
    spec = os.path.join(ROOT, 'novai.spec')
    if os.path.exists(spec):
        os.remove(spec)
    # 收集数据文件
    add_data = []
    for folder in ['static', 'tools', 'packages']:
        p = os.path.join(ROOT, folder)
        if os.path.isdir(p):
            add_data.append(f'--add-data="{p}{os.pathsep}{folder}"')
    for f in ['VERSION', 'requirements.txt', 'app.py']:
        p = os.path.join(ROOT, f)
        if os.path.isfile(p):
            add_data.append(f'--add-data="{p}{os.pathsep}."')
    
    cmd = (
        f'pyinstaller --onefile --console -y '
        f'--name={APP_NAME} '
        f'--hidden-import=uvicorn.logging '
        f'--hidden-import=uvicorn.loops.auto '
        f'--hidden-import=uvicorn.protocols.http.auto '
        f'--hidden-import=fastapi '
        f'--hidden-import=aiofiles '
        f'--hidden-import=pydantic '
        f'{" ".join(add_data)} '
        f'{os.path.join(ROOT, "main.py")}'
    )
    run(cmd)
    
    # 复制到 dist-desktop
    os.makedirs(DIST, exist_ok=True)
    exe = os.path.join(ROOT, 'dist', f'{APP_NAME}.exe')
    shutil.copy(exe, os.path.join(DIST, f'{APP_NAME}.exe'))
    
    # 数据目录（运行时需要写入）
    for d in ['data', 'output', 'assets/output']:
        os.makedirs(os.path.join(DIST, d), exist_ok=True)
    
    print(f'✅ Windows 打包完成: {DIST}/{APP_NAME}.exe')

def build_mac():
    """Mac: PyInstaller -> 可执行文件"""
    print('=== Mac 打包 ===')
    is_mac = platform.system() == 'Darwin'
    if not is_mac:
        print('⚠️  当前不是 Mac，跳过 Mac 打包。请在 Mac 上运行：python3 build.py')
        return
    
    add_data = []
    for folder in ['static', 'tools', 'packages']:
        p = os.path.join(ROOT, folder)
        if os.path.isdir(p):
            add_data.append(f'--add-data "{p}:{folder}"')
    for f in ['VERSION', 'requirements.txt', 'app.py']:
        p = os.path.join(ROOT, f)
        if os.path.isfile(p):
            add_data.append(f'--add-data "{p}:."')
    
    cmd = (
        f'pyinstaller --onefile --console -y '
        f'--name={APP_NAME} '
        f'--hidden-import=uvicorn.logging '
        f'--hidden-import=uvicorn.loops.auto '
        f'--hidden-import=uvicorn.protocols.http.auto '
        f'{" ".join(add_data)} '
        f'{os.path.join(ROOT, "main.py")}'
    )
    run(cmd)
    
    shutil.rmtree(DIST, ignore_errors=True)
    os.makedirs(DIST, exist_ok=True)
    shutil.copy(os.path.join(ROOT, 'dist', APP_NAME), 
                os.path.join(DIST, APP_NAME))
    for d in ['data', 'output', 'assets/output']:
        os.makedirs(os.path.join(DIST, d), exist_ok=True)
    
    print(f'✅ Mac 打包完成: {DIST}/{APP_NAME}')

if __name__ == '__main__':
    os.chdir(ROOT)
    if platform.system() == 'Windows':
        build_windows()
    else:
        build_mac()
