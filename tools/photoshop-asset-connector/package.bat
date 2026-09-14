@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

:: ============================================================
:: NOVAI CanvasTools — Windows 一键打包脚本
:: 将插件文件打包为 .ccx 安装包
:: ============================================================

cd /d "%~dp0"

:: 从 manifest.json 提取版本号
for /f "tokens=2 delims=:" %%a in ('findstr /c:"\"version\"" manifest.json') do (
    set "ver=%%a"
    set "ver=!ver:"=!"
    set "ver=!ver:,=!"
    set "ver=!ver: =!"
)

if "%ver%"=="" set "ver=0.0.0"

set "OUT=NOVAI-CanvasTools-v%ver%.ccx"

echo ========================================
echo   NOVAI CanvasTools 打包工具
echo   版本: v%ver%
echo   输出: %OUT%
echo ========================================
echo.

:: 删除旧包
if exist "%OUT%" del /q "%OUT%"

:: 使用 PowerShell Compress-Archive 打包（Win 10 1803+ 内置）
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "Compress-Archive -Path manifest.json,index.html,style.css,js -DestinationPath '%OUT%' -Force; ^
     Write-Host '打包完成：' (Get-Item '%OUT%').Length ' 字节'"

if errorlevel 1 (
    echo [错误] 打包失败，请确认当前目录下 manifest.json / index.html / style.css / js/ 均存在。
    pause
    exit /b 1
)

echo.
echo ========================================
echo   打包成功！
echo   文件: %OUT%
echo.
echo   Windows 安装方式：
echo   1. 打开 Photoshop
echo   2. 双击 %OUT% （或拖入 PS 窗口）
echo   3. 在 PS 菜单 增效工具 → NOVAI画布工具 打开
echo ========================================
pause
