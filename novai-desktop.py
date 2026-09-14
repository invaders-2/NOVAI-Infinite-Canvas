#!/usr/bin/env python3
"""NOVAI Desktop — 原生独立窗口"""
import webview
import subprocess
import sys
import time
import os

PORT = 3000
URL = f"http://127.0.0.1:{PORT}"

# 启动后端服务
exe = os.path.join(os.path.dirname(__file__), "NOVAI.exe")
if os.path.exists(exe):
    subprocess.Popen([exe], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"启动服务: {exe}")
else:
    print("NOVAI.exe 未找到，请先运行 build.py 打包")
    sys.exit(1)

# 等待服务就绪
import urllib.request
for _ in range(20):
    try:
        urllib.request.urlopen(URL, timeout=1)
        break
    except:
        time.sleep(0.5)

# 创建原生窗口
window = webview.create_window(
    title="NOVAI 智能画布",
    url=URL,
    width=1400,
    height=900,
    min_size=(800, 600),
    resizable=True,
    fullscreen=False
)

webview.start()
