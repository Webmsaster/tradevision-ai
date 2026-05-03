<#
.SYNOPSIS
    FTMO Bot — One-script installer for Windows.

.DESCRIPTION
    Interactive setup that:
    1. Checks / installs prerequisites (Git, Node.js, Python, MT5)
    2. Clones the repo if missing
    3. Installs npm + pip dependencies
    4. Prompts for FTMO symbol names, Telegram credentials, etc.
    5. Writes .env.ftmo + creates state directory
    6. Outputs ready-to-run launch commands

.EXAMPLE
    # Run in PowerShell as Administrator:
    Set-ExecutionPolicy -Scope Process Bypass
    .\tools\install-windows.ps1
#>

param(
    [string]$RepoUrl = "",
    [string]$InstallDir = "C:\tradevision-ai"
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$msg) Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$msg) Write-Host "  ✗ $msg" -ForegroundColor Red }

function Prompt-Default {
    param([string]$question, [string]$default)
    $response = Read-Host "$question [$default]"
    if ([string]::IsNullOrWhiteSpace($response)) { return $default }
    return $response
}

function Prompt-Required {
    param([string]$question)
    while ($true) {
        $response = Read-Host $question
        if (-not [string]::IsNullOrWhiteSpace($response)) { return $response }
        Write-Warn "Required — please enter a value."
    }
}

function Test-Command {
    param([string]$cmd)
    return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

Write-Host @"
╔═══════════════════════════════════════════════════════╗
║  FTMO Auto-Trading Bot — Windows Installer            ║
║  Strategy: iter231 (~62% pass rate, 6d median)        ║
╚═══════════════════════════════════════════════════════╝
"@ -ForegroundColor Magenta

# ----------------------------------------------------------------------------
Write-Step "1 / 7   Checking prerequisites"
# ----------------------------------------------------------------------------
$missing = @()
if (-not (Test-Command git))     { $missing += "Git (https://git-scm.com/download/win)" }         else { Write-Ok "Git found" }
if (-not (Test-Command node))    { $missing += "Node.js 20+ (https://nodejs.org)" }                 else { Write-Ok "Node.js found: $(node --version)" }
if (-not (Test-Command python)) {
    if (Test-Command py)         { Write-Ok "Python found (via py launcher)" }
    else                         { $missing += "Python 3.10+ (https://python.org)" }
} else                           { Write-Ok "Python found: $(python --version)" }

if ($missing.Count -gt 0) {
    Write-Err "Missing prerequisites:"
    $missing | ForEach-Object { Write-Host "    - $_" }
    Write-Warn "Install them and re-run this script."
    exit 1
}

if (-not (Test-Path "C:\Program Files\MetaTrader 5\terminal64.exe") -and
    -not (Test-Path "C:\Program Files (x86)\MetaTrader 5\terminal64.exe")) {
    Write-Warn "MetaTrader 5 terminal not detected in standard locations."
    Write-Warn "Download from FTMO's portal → install → log in to your FTMO account."
    Write-Warn "The bot will retry connection on startup."
}

# ----------------------------------------------------------------------------
Write-Step "2 / 7   Project directory"
# ----------------------------------------------------------------------------
$InstallDir = Prompt-Default "Install directory" $InstallDir
if (-not (Test-Path $InstallDir)) {
    Write-Host "Directory doesn't exist. Will clone repo into it."
    if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
        $RepoUrl = Prompt-Required "Git repo URL (e.g. https://github.com/you/tradevision-ai.git)"
    }
    & git clone $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { Write-Err "git clone failed"; exit 1 }
    Write-Ok "Repo cloned"
} else {
    Write-Ok "Using existing directory"
}
Set-Location $InstallDir

# ----------------------------------------------------------------------------
Write-Step "3 / 7   npm install"
# ----------------------------------------------------------------------------
& npm install
if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed"; exit 1 }
Write-Ok "Node dependencies installed"

# ----------------------------------------------------------------------------
Write-Step "4 / 7   pip install MetaTrader5 + pytest"
# ----------------------------------------------------------------------------
$pyCmd = if (Test-Command python) { "python" } else { "py" }
& $pyCmd -m pip install --user MetaTrader5 pytest
if ($LASTEXITCODE -ne 0) { Write-Warn "pip install had issues — check manually"; }
else { Write-Ok "Python dependencies installed" }

# ----------------------------------------------------------------------------
Write-Step "5 / 7   Configuration"
# ----------------------------------------------------------------------------
Write-Host "Open MT5 → Market Watch → right-click → Symbols → search for ETH/BTC/SOL."
Write-Host "Note the EXACT symbol names (FTMO may use ETHUSD, ETH/USD, ETH.USD, etc.)`n"

$ethSymbol = Prompt-Default "FTMO ETH symbol name" "ETHUSD"
$btcSymbol = Prompt-Default "FTMO BTC symbol name" "BTCUSD"
$solSymbol = Prompt-Default "FTMO SOL symbol name" "SOLUSD"

$startBalance = Prompt-Default "Challenge start balance (USD)" "100000"
$today = Get-Date -Format "yyyy-MM-dd"
$startDate = Prompt-Default "Challenge start date (YYYY-MM-DD)" $today

Write-Host "`nTelegram bot setup (optional, press Enter to skip):"
Write-Host "  1. @BotFather on Telegram → /newbot → copy TOKEN"
Write-Host "  2. Write your bot any message"
Write-Host "  3. https://api.telegram.org/bot<TOKEN>/getUpdates → find 'chat':{'id': NNN}`n"
$tgToken = Prompt-Default "Telegram bot TOKEN" ""
$tgChatId = Prompt-Default "Telegram CHAT_ID" ""

$stateDir = "$InstallDir\ftmo-state"
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }
Write-Ok "State directory: $stateDir"

# ----------------------------------------------------------------------------
Write-Step "6 / 7   Writing .env.ftmo"
# ----------------------------------------------------------------------------
$envPath = "$InstallDir\.env.ftmo"
$envContent = @"
# FTMO Bot Configuration — generated $(Get-Date -Format 'yyyy-MM-dd HH:mm')

# Core
FTMO_STATE_DIR=$stateDir
FTMO_START_BALANCE=$startBalance
FTMO_START_DATE=$startDate
FTMO_MONITOR_ENABLED=1

# FTMO MT5 symbol mapping (verified in MT5 Market Watch)
FTMO_ETH_SYMBOL=$ethSymbol
FTMO_BTC_SYMBOL=$btcSymbol
FTMO_SOL_SYMBOL=$solSymbol

# Telegram
TELEGRAM_BOT_TOKEN=$tgToken
TELEGRAM_CHAT_ID=$tgChatId

# Safety tuning (optional overrides)
FTMO_CB_LOSS_STREAK=3
FTMO_CB_DAILY_DD_WARN=0.03
FTMO_CONSISTENCY_WARN_RATIO=0.35
FTMO_CONSISTENCY_HARD_RATIO=0.42
FTMO_NEWS_CLOSE_MINUTES=30
"@
Set-Content -Path $envPath -Value $envContent -Encoding UTF8

# Phase 71 (R45-CFG-8): restrict ACL on .env.ftmo so the Telegram bot
# token + other secrets are readable only by the installing user.
# Without this, on a multi-user VPS any logged-in account with read
# access to the install directory could cat the token.
try {
    icacls $envPath /inheritance:r /grant:r "${env:USERNAME}:F" /grant:r "SYSTEM:F" /grant:r "Administrators:F" 2>&1 | Out-Null
    Write-Ok "Wrote $envPath (ACL: $($env:USERNAME) + SYSTEM + Admins only)"
} catch {
    Write-Warning "Could not restrict ACL on $envPath — verify multi-user safety manually"
    Write-Ok "Wrote $envPath"
}

# Bootstrap launch scripts
$launchNode = @"
# FTMO Signal Service launcher
Get-Content '$envPath' | ForEach-Object {
    if (`$_ -match '^([^#=]+)=(.*)$') { `$env:`$(`$matches[1].Trim()) = `$matches[2].Trim() }
}
Set-Location '$InstallDir'
node ./node_modules/tsx/dist/cli.mjs scripts/ftmoLiveService.ts
"@
Set-Content -Path "$InstallDir\start-signal-service.ps1" -Value $launchNode

$launchPython = @"
# FTMO MT5 Executor launcher
Get-Content '$envPath' | ForEach-Object {
    if (`$_ -match '^([^#=]+)=(.*)$') { `$env:`$(`$matches[1].Trim()) = `$matches[2].Trim() }
}
Set-Location '$InstallDir'
python tools\ftmo_executor.py
"@
Set-Content -Path "$InstallDir\start-executor.ps1" -Value $launchPython

Write-Ok "Wrote start-signal-service.ps1 + start-executor.ps1"

# ----------------------------------------------------------------------------
Write-Step "7 / 7   Setup complete"
# ----------------------------------------------------------------------------
Write-Host @"

✓ Installation finished.

To start the bot:

  Terminal 1 (Node signal service):
    cd $InstallDir
    .\start-signal-service.ps1

  Terminal 2 (Python MT5 executor):
    cd $InstallDir
    .\start-executor.ps1

  Dashboard:
    cd $InstallDir
    `$env:FTMO_MONITOR_ENABLED="1"
    npm run dev
    # Open http://localhost:3000/ftmo-monitor

  Kill switch (close all bot positions):
    python tools\ftmo_kill.py

IMPORTANT: start on FTMO DEMO first. 1-2 weeks of demo trading BEFORE
buying a real challenge. Measure actual commission / slippage / swap
rates and report back.

Telegram commands (if configured):
  /status, /positions, /pnl, /pause, /resume, /kill, /config, /help

"@ -ForegroundColor Green
