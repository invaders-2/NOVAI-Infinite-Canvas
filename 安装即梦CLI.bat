@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "tools\jimeng_cli_install.ps1"
pause
