#!/usr/bin/env python3
"""NOVAI Desktop 桌面版打包"""
import os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DESKTOP_SCRIPT = os.path.join(ROOT, 'novai-desktop.py')

# 确保依赖安装了
import subprocess
subprocess.run([sys.executable, '-m', 'pip', 'install', 'pywebview', 'pyinstaller'], 
               check=True, capture_output=True)

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
    f'pyinstaller --onefile --windowed '
    f'--name=NOVAI-Desktop '
    f'--hidden-import=webview '
    f'--hidden-import=webview.platforms.winforms '
    f'--hidden-import=clr '
    f'--hidden-import=pythonnet '
    f'{" ".join(add_data)} '
    f'"{DESKTOP_SCRIPT}"'
)

print(f'$ {cmd}')
os.chdir(ROOT)
subprocess.run(cmd, shell=True, check=True)

DIST = os.path.join(ROOT, 'dist-desktop')
os.makedirs(DIST, exist_ok=True)
src = os.path.join(ROOT, 'dist', 'NOVAI-Desktop.exe')
dst = os.path.join(DIST, 'NOVAI-Desktop.exe')
if os.path.exists(src):
    import shutil
    shutil.copy(src, dst)
    print(f'✅ 桌面版: {dst}')
    # 复制数据目录
    for d in ['data', 'output', 'assets/output']:
        os.makedirs(os.path.join(DIST, d), exist_ok=True)
else:
    print('❌ 打包失败，检查 dist/NOVAI-Desktop.exe')
