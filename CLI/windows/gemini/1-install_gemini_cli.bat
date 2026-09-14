@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo Installing Antigravity CLI...
powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0install_gemini_cli.ps1"
