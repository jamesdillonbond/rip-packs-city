@echo off
REM ============================================================================
REM Panini NBA/MLB TEAM WALK launcher — its own daily Windows task (2026-09-24).
REM Registered by scripts\panini-team-walk-schedule.bat (daily 3:35 AM, between the
REM soccer runner's 2 AM and 6 AM slots, which each run ~80-90 min).
REM
REM Walks the 5 STALEST teams on the roster (panini_team_walk_targets: 30 NBA +
REM Detroit) through Panini's team-filtered grid and posts to
REM /api/cron/panini-team-walk. Staging only — nothing on the site reads it yet.
REM Shares the soccer runner's debug Chrome and INGEST_SECRET_TOKEN; needs nothing new.
REM Detail: docs/features/franchise-hubs.md.
REM
REM Chrome liveness is checked the same way panini-run.bat does it (by CONNECTING,
REM not by port — a hung Chrome still accepts TCP), and it restarts only the
REM panini-profile Chrome, never your own browser.
REM ============================================================================
setlocal

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
set "PROFILE=%USERPROFILE%\panini-cdp-profile"
set "PANINI_CDP_URL=http://localhost:9222"
set "RPC_PANINI_TEAM_WALK_URL=https://www.rippackscity.com/api/cron/panini-team-walk"
set "PANINI_TEAM_ROTATION=5"
set "PANINI_WALK_BUDGET_MIN=100"
set "PANINI_TEAM_WALK_STAMP=%USERPROFILE%\panini-team-walk.stamp"
set "PANINI_LOG=%USERPROFILE%\panini-team-walk.log"

cd /d "%USERPROFILE%\rip-packs-city"

echo. >> "%PANINI_LOG%"
echo ==== %DATE% %TIME% team walk start ==== >> "%PANINI_LOG%"

node scripts\panini-cdp-preflight.mjs >> "%PANINI_LOG%" 2>&1
if %ERRORLEVEL% EQU 0 goto :run

echo [panini-team-walk] preflight failed - restarting the panini debug Chrome >> "%PANINI_LOG%"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'panini-cdp-profile' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%PANINI_LOG%" 2>&1
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "Start-Process '%CHROME%' -ArgumentList '--remote-debugging-port=9222','--user-data-dir=%PROFILE%','https://nft.paniniamerica.net/marketplace/nfts.html?sport=Basketball'" >> "%PANINI_LOG%" 2>&1
timeout /t 16 /nobreak >nul
node scripts\panini-cdp-preflight.mjs >> "%PANINI_LOG%" 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [panini-team-walk] ABORT: Chrome still not drivable after restart >> "%PANINI_LOG%"
  endlocal
  exit /b 2
)

:run
node scripts\panini-team-walk.mjs >> "%PANINI_LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% team walk end rc=%RC% ==== >> "%PANINI_LOG%"
endlocal & exit /b %RC%
