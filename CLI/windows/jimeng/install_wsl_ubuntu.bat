@echo off
cd /d "%~dp0"
start "Install WSL Ubuntu" powershell -NoExit -ExecutionPolicy Bypass -Command "Write-Host 'This will ask for Administrator permission if required.'; Write-Host 'Installing Ubuntu for WSL...'; Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-Command','wsl --install -d Ubuntu; Write-Host \"\"; Write-Host \"If Ubuntu opens, finish username/password setup. If Windows asks for reboot, reboot first.\"; Read-Host \"Press Enter to close\"'"

