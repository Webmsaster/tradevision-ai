# FTMO Bot — Restart Helper Script
# Usage:
#   .\tools\restart-bot.ps1                                    # restart with current settings
#   .\tools\restart-bot.ps1 -Tf "2h-trend-v5" -Balance 100000  # full reset + start
#   .\tools\restart-bot.ps1 -Reset                             # reset state for fresh challenge
#
# Defaults: TF=2h-trend-v5, Balance=100000

param(
  [string]$Tf = "2h-trend-v5",
  [int]$Balance = 100000,
  [switch]$Reset = $false,
  [switch]$Logs = $false
)

$ErrorActionPreference = "Continue"
$RepoRoot = "C:\tradevision-ai"
$StateDir = Join-Path $RepoRoot "ftmo-state-$Tf"

Write-Host ""
Write-Host "FTMO Bot Restart" -ForegroundColor Cyan
Write-Host "  TF:      $Tf" -ForegroundColor Gray
Write-Host "  Balance: `$$Balance" -ForegroundColor Gray
Write-Host "  Reset:   $Reset" -ForegroundColor Gray
Write-Host ""

Set-Location $RepoRoot

# Stop everything
Write-Host "[1/4] Stopping PM2..." -ForegroundColor Yellow
pm2 delete all 2>$null

# Optional state reset (use when switching to a fresh challenge)
if ($Reset) {
  Write-Host "[2/4] Resetting state at $StateDir..." -ForegroundColor Yellow
  if (Test-Path $StateDir) {
    Remove-Item -Recurse -Force $StateDir
    Write-Host "      State directory deleted." -ForegroundColor Green
  } else {
    Write-Host "      No existing state to reset." -ForegroundColor Gray
  }
} else {
  Write-Host "[2/4] Keeping existing state (use -Reset to wipe)." -ForegroundColor Gray
}

# Set env vars
Write-Host "[3/4] Setting env vars..." -ForegroundColor Yellow
$env:FTMO_TF = $Tf
$env:FTMO_START_BALANCE = "$Balance"

# Start via ecosystem
Write-Host "[4/4] Starting bot..." -ForegroundColor Yellow
pm2 start tools/ecosystem.config.js
pm2 save

Write-Host ""
Write-Host "Bot restarted." -ForegroundColor Green
Write-Host ""
pm2 ls

if ($Logs) {
  Write-Host ""
  Write-Host "Tailing executor logs (Ctrl+C to exit)..." -ForegroundColor Cyan
  pm2 logs ftmo-executor --lines 30
}
