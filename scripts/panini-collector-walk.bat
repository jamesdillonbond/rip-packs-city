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
REM The box owner's own username, walked whether or not it is linked on rippackscity.com.
if not defined PANINI_COLLECTOR_TARGETS set "PANINI_COLLECTOR_TARGETS=Jamesdillonbond"
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
