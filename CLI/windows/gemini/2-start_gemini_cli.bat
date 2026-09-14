@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0..\..\.."

powershell -NoExit -ExecutionPolicy Bypass -Command "$agy=(Get-Command agy -ErrorAction SilentlyContinue).Source; if(-not $agy){$pattern=Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Google.AntigravityCLI_*\agy.exe'; $item=Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1; if($item){$agy=$item.FullName}}; if(-not $agy){Write-Host 'Antigravity CLI was not found. Please run CLI\windows\gemini\1-install_gemini_cli.bat first, then open a new terminal.'; Read-Host 'Press Enter to close'; exit 1}; & $agy"
