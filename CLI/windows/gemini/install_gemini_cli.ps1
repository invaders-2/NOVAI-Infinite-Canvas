param(
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("antigravity-cli-install-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Start-Transcript -Path $logPath -Force | Out-Null

function Pause-End {
    Write-Host ""
    Write-Host "Log: $logPath"
    if (-not $NonInteractive) {
        Read-Host "Press Enter to close"
    }
    Stop-Transcript | Out-Null
}

function Find-Agy {
    $cmd = Get-Command agy -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $pattern = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Google.AntigravityCLI_*\agy.exe"
    $match = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($match) { return $match.FullName }

    return $null
}

try {
    Write-Host "=== Antigravity CLI install/update ==="
    Write-Host "Workspace: $root"
    Write-Host ""

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $winget) {
        throw "winget was not found. Please install App Installer from Microsoft Store, then rerun this installer."
    }

    Write-Host "Installing/updating Antigravity CLI with winget: winget install --id Google.AntigravityCLI"
    & $winget.Source install --id Google.AntigravityCLI -e --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "winget install returned exit code $LASTEXITCODE. Checking whether agy is already available..."
    }

    $agy = Find-Agy
    if (-not $agy) {
        Write-Host "Antigravity CLI may be installed, but 'agy' was not found in this PowerShell PATH yet."
        Write-Host "Close this window, open a new PowerShell, then run: agy --version"
        Pause-End
        exit 2
    }

    Write-Host "Antigravity CLI found: $agy"
    try {
        & $agy --version
    } catch {
        Write-Host "Could not read Antigravity version in this session. Open a new PowerShell and run: agy --version"
    }

    Write-Host ""
    Write-Host "Done. Run 'agy' in PowerShell to sign in and start using Antigravity CLI."
    Write-Host "You can also double-click CLI\windows\gemini\2-start_gemini_cli.bat."
    Pause-End
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    Pause-End
    exit 1
}
