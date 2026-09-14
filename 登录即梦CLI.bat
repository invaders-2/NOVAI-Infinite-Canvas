@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0tools\jimeng_cli_login.ps1"
