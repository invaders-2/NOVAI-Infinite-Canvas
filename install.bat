@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title NOVAI 安装

echo ============================================
echo   NOVAI - 一键安装（开箱即用）
echo ============================================
echo.

:: ---- 检测 Python ----
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Python！
    echo 请先安装 Python 3.10+：https://www.python.org/downloads/
    echo 安装时务必勾选 "Add Python to PATH"
    echo.
    pause
    exit /b 1
)

echo [1/5] 检测 Python...
python --version
echo.

:: ---- 创建虚拟环境 ----
echo [2/5] 创建虚拟环境...
if not exist "venv" (
    python -m venv venv
    if %errorlevel% neq 0 (
        echo [错误] 虚拟环境创建失败
        pause
        exit /b 1
    )
    echo       虚拟环境创建完成
) else (
    echo       虚拟环境已存在，跳过
)
echo.

:: ---- 安装基础依赖 ----
echo [3/5] 安装基础依赖（首次可能较慢）...
venv\Scripts\python -m pip install --upgrade pip -q --disable-pip-version-check
venv\Scripts\python -m pip install -r requirements.txt --disable-pip-version-check
if %errorlevel% neq 0 (
    echo.
    echo [错误] 基础依赖安装失败，请检查网络连接
    echo 可尝试国内镜像：
    echo   venv\Scripts\python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
    echo.
    pause
    exit /b 1
)
echo       基础依赖安装完成
echo.

:: ---- 安装桌面窗口依赖 ----
echo [4/5] 安装桌面窗口组件...
venv\Scripts\python -m pip install pywebview pystray --disable-pip-version-check
if %errorlevel% neq 0 (
    echo [WARN] 桌面窗口组件安装失败（不影响浏览器模式使用）
    echo        如需原生桌面窗口，请手动执行：
    echo        venv\Scripts\python -m pip install pywebview pystray
)
echo.

:: ---- 补全 uvicorn WebSocket 支持 ----
echo [5/5] 安装 WebSocket 支持...
venv\Scripts\python -m pip install "uvicorn[standard]" --disable-pip-version-check 2>nul
if %errorlevel% neq 0 (
    echo [WARN] WebSocket 支持安装失败（不影响基本功能）
)

echo.
echo ============================================
echo   全部安装完成！开箱即用 ~
echo ============================================
echo.
echo   双击「启动.bat」即可一键启动！
echo.
pause
