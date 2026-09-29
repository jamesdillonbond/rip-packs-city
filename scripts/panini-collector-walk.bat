@echo off
REM ============================================================================
REM Panini COLLECTOR WALK launcher (2026-09-27). Reads the PUBLIC Panini profile of
REM each linked username (plus PANINI_COLLECTOR_TARGETS below) and posts the cards
REM to /api/cron/panini-collector-walk, which feeds the Panini Collection tab.
REM
REM Runs daily at the end of scripts\panini-team-walk.bat (same debug Chrome, same
REM INGEST_SECRET_TOKEN). Run this file by hand for an on-demand walk; set
REM DRY_RUN=1 first to see what it would post without writing anything.
REM ============================================================================
setlocal

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
set "PROFILE=%USERPROFILE%\panini-cdp-profile"
set "PANINI_CDP_URL=http://localhost:9222"
set "RPC_PANINI_COLLECTOR_WALK_URL=https://www.rippackscity.com/api/cron/panini-collector-walk"
REM Always-walked usernames, whether or not they are linked on rippackscity.com:
REM the box owner's own, plus collectors Trevor tracks (added 2026-09-28; each is also a
REM seeded_wallets row on Flow). Their Panini names are ASSUMED to match their Top Shot ones -
REM a name Panini does not know logs as not_found in the walk log; fix the spelling here.
if not defined PANINI_COLLECTOR_TARGETS set "PANINI_COLLECTOR_TARGETS=Jamesdillonbond,spinotronpc,Rigged,MikeG503,Scottyj111,Alexthedon,PDX_Blazer,Sdb,Philthy503,Juiceshack,Cazsreyem,YWRR,TimDunkin,mbl267,PDXBLAZER"
REM Rotation (2026-09-28): each run also walks a few Panini owners who are also Top Shot usernames
REM RPC knows (panini_collector_rotation_targets - never walked first, biggest first, then oldest walk).
REM The budget stops STARTING walks after 40 min; the watchdog (55) leaves room for the one in progress.
if not defined PANINI_COLLECTOR_ROTATION set "PANINI_COLLECTOR_ROTATION=6"
if not defined PANINI_COLLECTOR_BUDGET_MIN set "PANINI_COLLECTOR_BUDGET_MIN=40"
REM Per-username cap (2026-09-29): a profile too big for one night stops at 10 min and posts a
REM partial read, so one big collection cannot run the whole walk into the watchdog.
REM Worst case: last start at 40 + 10 = 50, inside the 55-min watchdog.
if not defined PANINI_COLLECTOR_WALK_MAX_MIN set "PANINI_COLLECTOR_WALK_MAX_MIN=10"
if not defined PANINI_COLLECTOR_HARD_MIN set "PANINI_COLLECTOR_HARD_MIN=55"
set "PANINI_LOG=%USERPROFILE%\panini-collector-walk.log"

cd /d "%USERPROFILE%\rip-packs-city"

echo. >> "%PANINI_LOG%"
echo ==== %DATE% %TIME% collector walk start ==== >> "%PANINI_LOG%"

node scripts\panini-cdp-preflight.mjs >> "%PANINI_LOG%" 2>&1
if %ERRORLEVEL% EQU 0 goto :run

echo [panini-collector-walk] preflight failed - restarting the panini debug Chrome >> "%PANINI_LOG%"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'panini-cdp-profile' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%PANINI_LOG%" 2>&1
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "Start-Process '%CHROME%' -ArgumentList '--remote-debugging-port=9222','--user-data-dir=%PROFILE%','https://nft.paniniamerica.net/marketplace/nfts.html?sport=Basketball'" >> "%PANINI_LOG%" 2>&1
timeout /t 16 /nobreak >nul
node scripts\panini-cdp-preflight.mjs >> "%PANINI_LOG%" 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [panini-collector-walk] ABORT: Chrome still not drivable after restart >> "%PANINI_LOG%"
  endlocal
  exit /b 2
)

:run
node scripts\panini-collector-walk.mjs >> "%PANINI_LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% collector walk end rc=%RC% ==== >> "%PANINI_LOG%"
endlocal & exit /b %RC%
