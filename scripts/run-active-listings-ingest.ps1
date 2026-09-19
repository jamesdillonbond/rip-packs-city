# scripts/run-active-listings-ingest.ps1
#
# Home-machine runner for the underpriced-#1s deal-board ingest.
#
# WHY THIS EXISTS: the Dapper Atlas API (the per-serial TS ask feed) WAF-blocks
# DATACENTER IPs regardless of client — Vercel (undici) AND the GitHub-Actions
# runner (curl) both get the block page (verified 2026-06-17). Only a
# residential IP passes. So the ingest runs here, on a home machine, on a
# schedule (Windows Task Scheduler, ~every 3h). The GH workflow is disabled.
#
# It loads the bearer token from .env.local (prefers INGEST_SECRET_TOKEN, falls
# back to CRON_SECRET — the route accepts either), then runs the Node runner,
# which fetches Atlas (browser page since 2026-09-19; curl before) for each candidate's #1/perfect serial and POSTs the rows to
# /api/cron/topshot-active-listings-ingest (all DB I/O stays on Vercel).
#
# Manual run:        powershell -ExecutionPolicy Bypass -File scripts\run-active-listings-ingest.ps1
# Smoke (no writes): ... -DryRun -MaxTargets 5
#
# Register the schedule (run once, as the logged-in user):
#   see docs/overnight/ledger.md (2026-06-16 underpriced-serials) for the
#   Register-ScheduledTask one-liner, or scripts\register-active-listings-task.ps1

# 2026-09-19: ATLAS TRANSPORT IS NOW A REAL BROWSER PAGE, NOT CURL. The night of
# 09-18 Cloudflare bot management on Atlas began answering curl from THIS machine's
# residential IP with a JavaScript challenge (403 "Just a moment...") - the same
# block the GitHub runner gets - and this arm went silent for 19 h with no error
# (known-issues #125). A headless Chromium launched without the automation flags,
# with a desktop Chrome UA, parked on dapper.market, gets the API 200 (measured
# on the laptop VM 2026-09-19; a full 897-target sweep ran that way, 0 skipped).
# So this runner sets ATLAS_FETCH_MODE=browser. No install is required: when
# Playwright's bundled Chromium is absent it drives the installed Google Chrome
# (channel "chrome"). `npx playwright install chromium` (repo root) switches it to the
# bundled build; -BrowserChannel overrides either way.
# If a run logs "dapper.market landing was challenged", re-run with -Headful
# (Cloudflare tolerates a visible window more than a headless one) and note it.

param(
  [string]$Floor = "100",
  [string]$MaxTargets = "",
  [switch]$DryRun,
  [string]$AtlasFetchMode = "browser",   # browser | curl (curl is challenged since 2026-09-19)
  [string]$BrowserChannel = "",          # "" = Playwright's bundled Chromium; "chrome" = installed Google Chrome
  [switch]$Headful
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# ── token from .env.local (INGEST_SECRET_TOKEN preferred, CRON_SECRET fallback) ──
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
$env:FLOOR               = $Floor
$env:MAX_TARGETS         = $MaxTargets
$env:DRY_RUN             = if ($DryRun) { "1" } else { "" }
$env:ATLAS_FETCH_MODE    = $AtlasFetchMode
# No install step by default: if Playwright's bundled Chromium is not present under
# %LOCALAPPDATA%\ms-playwright, drive the machine's installed Google Chrome instead
# (Playwright channel "chrome"; it launches its own profile, so an open Chrome is
# untouched). An explicit -BrowserChannel always wins.
if (-not $BrowserChannel -and $AtlasFetchMode -eq "browser") {
  $pwBundled = Join-Path $env:LOCALAPPDATA "ms-playwright"
  $hasBundled = (Test-Path $pwBundled) -and ((Get-ChildItem -Path $pwBundled -Directory -Filter "chromium-*" -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
  if (-not $hasBundled) { $BrowserChannel = "chrome" }
}
$env:ATLAS_BROWSER_CHANNEL  = $BrowserChannel
$env:ATLAS_BROWSER_HEADLESS = if ($Headful) { "0" } else { "1" }

# ── run + log (single rolling log under LOCALAPPDATA) ────────────────────────
$stamp  = Get-Date -Format "yyyy-MM-ddTHH-mm-ssK"
$logDir = Join-Path $env:LOCALAPPDATA "rpc-deal-board-ingest"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "ingest.log"
"=== $stamp floor=$Floor dryRun=$($DryRun.IsPresent) ===" | Out-File -FilePath $log -Append -Encoding utf8

node scripts/ingest-topshot-active-listings.mjs *>&1 | Tee-Object -FilePath $log -Append
exit $LASTEXITCODE
