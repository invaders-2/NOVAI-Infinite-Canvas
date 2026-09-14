@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0jimeng_cli_install.ps1"
