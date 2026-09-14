@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

powershell -NoExit -ExecutionPolicy Bypass -File "%~dp0install_openai_codex_cli.ps1"
