# scripts/run-allday-badge-ingest.ps1
#
# Home-machine runner for the NFL All Day per-moment badge ingest.
#
# WHY THIS EXISTS: the Dapper Atlas API (atlas.v1.EditionService/SearchEditions,
# the source of real per-moment NFL badges) WAF-blocks DATACENTER IPs regardless
# of client — Vercel (undici) AND GitHub-Actions runners (curl) both get the
# block page. Only a residential IP passes. So the ingest runs here, on a home
# machine, on a schedule (Windows Task Scheduler, ~daily).
#
# It loads the bearer token from .env.local (prefers INGEST_SECRET_TOKEN, falls
# back to CRON_SECRET — the route accepts either), then runs the Node runner,
# which curls Atlas for every NFL edition's badges and POSTs the rows to
# /api/cron/allday-badge-ingest (all DB I/O stays on Vercel).
#
# Manual run:        powershell -ExecutionPolicy Bypass -File scripts\run-allday-badge-ingest.ps1
# Smoke (no writes): ... -DryRun -MaxPages 2
#
# Register the schedule: scripts\register-allday-badge-ingest-task.ps1

param(
  [string]$MaxPages = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# -- token from .env.local (INGEST_SECRET_TOKEN preferred, CRON_SECRET fallback) --
$envFile = Join-Path $RepoRoot ".env.local"
if (-not (Test-Path $envFile)) { Write-Error "missing $envFile"; exit 1 }
$ingest = ""; $cron = ""
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*INGEST_SECRET_TOKEN\s*=\s*(.+)$')   { $ingest = $matches[1].Trim().Trim('"').Trim("'") }
  elseif ($line -match '^\s*CRON_SECRET\s*=\s*(.+)$')        { $cron   = $matches[1].Trim().Trim('"').Trim("'") }
}
$token = if ($ingest) { $ingest } else { $cron }
if (-not $token) { Write-Error "no INGEST_SECRET_TOKEN or CRON_SECRET in .env.local"; exit 1 }

$env:INGEST_SECRET_TOKEN = $token
$env:BASE_URL            = "https://www.rippackscity.com"
$env:MAX_PAGES           = $MaxPages
$env:DRY_RUN             = if ($DryRun) { "1" } else { "" }

# -- run + log (single rolling log under LOCALAPPDATA) ------------------------
$stamp  = Get-Date -Format "yyyy-MM-ddTHH-mm-ssK"
$logDir = Join-Path $env:LOCALAPPDATA "rpc-allday-badge-ingest"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "ingest.log"
"=== $stamp dryRun=$($DryRun.IsPresent) maxPages=$MaxPages ===" | Out-File -FilePath $log -Append -Encoding utf8

node scripts/ingest-allday-badges.mjs *>&1 | Tee-Object -FilePath $log -Append
exit $LASTEXITCODE
