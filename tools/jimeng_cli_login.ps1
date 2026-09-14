$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("jimeng-cli-login-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Start-Transcript -Path $logPath -Force | Out-Null

function Pause-End {
    Write-Host ""
    Write-Host "Log: $logPath"
    Read-Host "Press Enter to close"
    Stop-Transcript | Out-Null
}

function Convert-ToWslPath {
    param([string]$Path)
    $fullPath = (Resolve-Path -LiteralPath $Path).Path
    if ($fullPath -match '^([A-Za-z]):\\(.*)$') {
        $drive = $matches[1].ToLowerInvariant()
        $tail = $matches[2] -replace '\\', '/'
        return "/mnt/$drive/$tail"
    }
    return $fullPath -replace '\\', '/'
}

function New-WslScriptFile {
    param([string]$Script)
    $cleanScript = ($Script -replace "^\uFEFF", "") -replace "`r`n", "`n"
    $path = Join-Path $logDir ("jimeng-wsl-{0}.sh" -f [Guid]::NewGuid().ToString("N"))
    [System.IO.File]::WriteAllText($path, $cleanScript, [System.Text.UTF8Encoding]::new($false))
    return $path
}

function Invoke-WslScript {
    param(
        [string[]]$BaseArgs,
        [string]$Script,
        [string]$Shell = "sh"
    )
    $scriptPath = New-WslScriptFile -Script $Script
    $wslScriptPath = Convert-ToWslPath $scriptPath
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & wsl.exe @BaseArgs -e $Shell $wslScriptPath 2>&1 | ForEach-Object { Write-Host $_ }
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        return [int]$exitCode
    } finally {
        $ErrorActionPreference = $oldPreference
        Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
    }
}

try {
    Write-Host "=== Jimeng CLI login/check via WSL ==="
    Write-Host "Workspace: $root"
    Write-Host ""

    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wsl) {
        Write-Host "WSL is not installed. Run install_jimeng_cli.bat first."
        Pause-End
        exit 1
    }

    $distros = @()
    try {
        $distros = @(& wsl.exe -l -q 2>$null | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ })
    } catch {
        $distros = @()
    }
    if (-not $distros -or $distros.Count -eq 0) {
        Write-Host "WSL is installed, but no Linux distro is installed or initialized."
        Write-Host "Run install_wsl_ubuntu.bat first, or open an Administrator PowerShell and run:"
        Write-Host "  wsl --install -d Ubuntu"
        Write-Host "After Ubuntu opens, create the Linux username/password, then run this login check again."
        Pause-End
        exit 1
    }

    Write-Host "Detected WSL distros:"
    foreach ($distro in $distros) { Write-Host "  $distro" }

    $preferredDistro = @($distros | Where-Object { $_ -match '^Ubuntu($|-)' } | Select-Object -First 1)
    $wslBaseArgs = @()
    if ($preferredDistro -and $preferredDistro.Count -gt 0) {
        $wslBaseArgs = @("-d", [string]$preferredDistro[0])
        Write-Host "Using WSL distro: $($preferredDistro[0])"
    } else {
        Write-Host "Using the default WSL distro."
    }

    & wsl.exe @wslBaseArgs -e sh -lc "echo WSL sh OK" | Write-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "The selected WSL distro cannot run /bin/sh, or it is not initialized."
        Write-Host "Open the distro once to finish setup, or install Ubuntu and set it as default:"
        Write-Host "  wsl --install -d Ubuntu"
        Write-Host "  wsl --set-default Ubuntu"
        Pause-End
        exit 1
    }

    $script = @'
. ~/.profile >/dev/null 2>&1 || true
. ~/.bashrc >/dev/null 2>&1 || true
DREAMINA_BIN=$(command -v dreamina || find ~ -maxdepth 4 -type f -name dreamina 2>/dev/null | head -n 1)
if [ x$DREAMINA_BIN = x ]; then
  echo "dreamina not found. Run install_jimeng_cli.bat first."
  exit 2
fi
$DREAMINA_BIN login
echo
echo "Checking user_credit..."
$DREAMINA_BIN user_credit
'@

    $loginExitCode = Invoke-WslScript -BaseArgs $wslBaseArgs -Script $script -Shell "sh"
    if ($loginExitCode -ne 0) {
        Write-Host "Login/check failed with exit code $loginExitCode"
        Pause-End
        exit $loginExitCode
    }

    $apiDir = Join-Path $root "API"
    $envPath = Join-Path $apiDir ".env"
    New-Item -ItemType Directory -Force -Path $apiDir | Out-Null
    $lines = @()
    if (Test-Path $envPath) { $lines = Get-Content -LiteralPath $envPath }
    $lines = @($lines | Where-Object { $_ -notmatch '^\s*JIMENG_USE_WSL\s*=' })
    $lines += "JIMENG_USE_WSL=1"
    [System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Host "Updated API\.env: JIMENG_USE_WSL=1"
    Write-Host "Done."
    Pause-End
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    Pause-End
    exit 1
}
