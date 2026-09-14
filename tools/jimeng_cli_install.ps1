$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("jimeng-cli-install-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Start-Transcript -Path $logPath -Force | Out-Null

function Pause-End {
    Write-Host ""
    Write-Host "Log: $logPath"
    Read-Host "Press Enter to close"
    Stop-Transcript | Out-Null
}

function Show-Ubuntu-Help {
    Write-Host "WSL is installed, but no usable Ubuntu/bash environment was found."
    Write-Host "Run install_wsl_ubuntu.bat first, or run this in Administrator PowerShell:"
    Write-Host "  wsl --install -d Ubuntu"
    Write-Host "After Ubuntu opens, create the Linux username/password, then run this installer again."
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

function Invoke-WslScriptCapture {
    param(
        [string[]]$BaseArgs,
        [string]$Script,
        [string]$Shell = "sh"
    )
    $scriptPath = New-WslScriptFile -Script $Script
    $wslScriptPath = Convert-ToWslPath $scriptPath
    $stderrPath = Join-Path $logDir ("jimeng-wsl-stderr-{0}.log" -f [Guid]::NewGuid().ToString("N"))
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & wsl.exe @BaseArgs -e $Shell $wslScriptPath 2>$stderrPath
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 0 }
        $stderr = @()
        if (Test-Path $stderrPath) {
            $stderr = @(Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue)
        }
        return [pscustomobject]@{ ExitCode = [int]$exitCode; Output = @($output + $stderr) }
    } finally {
        $ErrorActionPreference = $oldPreference
        Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

try {
    Write-Host "=== Jimeng CLI install/update via WSL ==="
    Write-Host "Workspace: $root"
    Write-Host ""

    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wsl) {
        Write-Host "WSL is not installed."
        Write-Host "Open an Administrator PowerShell and run: wsl --install"
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
        Show-Ubuntu-Help
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

    $probe = @'
echo "WSL sh OK"
printf "bash="
command -v bash || true
printf "curl="
command -v curl || true
printf "apt_get="
command -v apt-get || true
'@

    $probeResult = Invoke-WslScriptCapture -BaseArgs $wslBaseArgs -Script $probe -Shell "sh"
    if ($probeResult.ExitCode -ne 0) {
        Write-Host ($probeResult.Output | Out-String)
        Write-Host "The selected WSL distro cannot run /bin/sh, or it is not initialized."
        Show-Ubuntu-Help
        Pause-End
        exit 1
    }
    $probeText = ($probeResult.Output | Out-String)
    Write-Host $probeText

    $hasBash = $probeText -match '(?m)^bash=/.+'
    $hasCurl = $probeText -match '(?m)^curl=/.+'
    $hasApt = $probeText -match '(?m)^apt_get=/.+'

    if ((-not $hasBash) -or (-not $hasCurl)) {
        if ($hasApt) {
            Write-Host "This WSL distro is missing required package(s): bash/curl."
            $answer = Read-Host "Install bash and curl now with apt? Type Y and press Enter"
            if ($answer -match '^(Y|y)$') {
                $deps = @'
set -e
if [ "$(id -u)" = "0" ]; then
  apt-get update
  apt-get install -y bash curl
else
  sudo apt-get update
  sudo apt-get install -y bash curl
fi
'@
                $depsExitCode = Invoke-WslScript -BaseArgs $wslBaseArgs -Script $deps -Shell "sh"
                if ($depsExitCode -ne 0) {
                    Write-Host "Failed to install bash/curl with apt. Please open Ubuntu and run:"
                    Write-Host "  sudo apt-get update"
                    Write-Host "  sudo apt-get install -y bash curl"
                    Pause-End
                    exit $depsExitCode
                }
            } else {
                Write-Host "Please install bash/curl inside WSL, then run this installer again:"
                Write-Host "  sudo apt-get update"
                Write-Host "  sudo apt-get install -y bash curl"
                Pause-End
                exit 1
            }
        } else {
            Write-Host "The selected WSL distro does not provide bash/curl and apt-get was not found."
            Show-Ubuntu-Help
            Pause-End
            exit 1
        }

        $checkExitCode = Invoke-WslScript -BaseArgs $wslBaseArgs -Script "command -v bash >/dev/null 2>&1 && command -v curl >/dev/null 2>&1" -Shell "sh"
        if ($checkExitCode -ne 0) {
            Write-Host "bash/curl are still unavailable after dependency installation."
            Pause-End
            exit 1
        }
    }

    $bash = @'
set -e
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is missing in WSL. Run: sudo apt update && sudo apt install -y curl"
  exit 2
fi
curl -fsSL https://jimeng.jianying.com/cli | bash
. ~/.profile >/dev/null 2>&1 || true
. ~/.bashrc >/dev/null 2>&1 || true
DREAMINA_BIN=$(command -v dreamina || find ~ -maxdepth 4 -type f -name dreamina 2>/dev/null | head -n 1)
if [ x$DREAMINA_BIN = x ]; then
  echo "dreamina was not found after install"
  exit 3
fi
$DREAMINA_BIN -h >/dev/null 2>&1 || true
echo dreamina=$DREAMINA_BIN
'@

    Write-Host "Installing/updating dreamina..."
    $installExitCode = Invoke-WslScript -BaseArgs $wslBaseArgs -Script $bash -Shell "bash"
    if ($installExitCode -ne 0) {
        Write-Host "Install failed with exit code $installExitCode"
        Pause-End
        exit $installExitCode
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

    Write-Host ""
    $answer = Read-Host "Login now? Type Y and press Enter"
    if ($answer -match '^(Y|y)$') {
        & powershell -NoExit -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "jimeng_cli_login.ps1")
        Stop-Transcript | Out-Null
        exit 0
    }

    Write-Host "Done. Run login_jimeng_cli.bat when you are ready to login."
    Pause-End
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    Pause-End
    exit 1
}
