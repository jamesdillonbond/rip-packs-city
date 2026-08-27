@echo off
REM ============================================================================
REM Panini runner launcher for Windows Task Scheduler (the "home-machine" pattern).
REM ONE-TIME SETUP:
REM   1. setx INGEST_SECRET_TOKEN "your-exact-token"     (persistent user env var)
REM   2. First run: launch the debug Chrome yourself and log into Panini once so
REM      the dedicated profile keeps the session:
REM        "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\panini-cdp-profile"
REM   3. Point a Task Scheduler task at this .bat (e.g. every 4 hours).
REM Re-login in that profile whenever a run reports "enumerated 0" (session expired).
REM ============================================================================
REM
REM 2026-08-27 — CHROME LIVENESS IS NOW CHECKED BY CONNECTING, NOT BY PORT.
REM
REM This task had been exiting 1 for ~22h (four missed bursts) while
REM `panini-ingest` sat 1,343 min silent against a 360 min ceiling and the PUBLIC
REM /insights/panini-squeeze board drifted. Chrome was HUNG, and the reason it
REM never self-healed was this file: it relaunched Chrome only when port 9222 was
REM not listening, and A HUNG BROWSER STILL ACCEPTS TCP. The guard passed forever
REM and every run died on `connectOverCDP: Timeout 30000ms exceeded`.
REM
REM The obvious upgrade — probe the CDP HTTP endpoint instead — was MEASURED
REM against the hung browser and ALSO PASSED: `GET /json/version` returned HTTP
REM 200 with a full version payload while no CDP session could be established.
REM So the check below runs the SAME call the runner makes (connectOverCDP), per
REM this repo's rule that a control must use the production caller.
REM
REM Output is also captured now: Task Scheduler discards a task's stdout, so the
REM fatal error above was invisible on the box and only ever surfaced as
REM "LastTaskResult 1". The log makes the next failure attributable.
REM ============================================================================
setlocal

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
set "PROFILE=%USERPROFILE%\panini-cdp-profile"
set "RPC_PANINI_INGEST_URL=https://www.rippackscity.com/api/cron/panini-ingest"
set "PANINI_CDP_URL=http://localhost:9222"
set "PANINI_LOG=%USERPROFILE%\panini-run.log"

cd /d "%USERPROFILE%\rip-packs-city"

echo. >> "%PANINI_LOG%"
echo ==== %DATE% %TIME% run start ==== >> "%PANINI_LOG%"

REM 1) Is the debug Chrome actually DRIVABLE? (not merely listening)
node scripts\panini-cdp-preflight.mjs >> "%PANINI_LOG%" 2>&1
if %ERRORLEVEL% EQU 0 goto :run

echo [panini-run] preflight failed - restarting the panini debug Chrome >> "%PANINI_LOG%"

REM 2) Kill ONLY the panini-profile Chrome. Never touch the user's own browser:
REM    the WMI filter matches this profile's --user-data-dir and nothing else.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'panini-cdp-profile' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }" >> "%PANINI_LOG%" 2>&1
timeout /t 3 /nobreak >nul

REM 3) Relaunch it and give the debug port time to come up.
powershell -NoProfile -Command "Start-Process '%CHROME%' -ArgumentList '--remote-debugging-port=9222','--user-data-dir=%PROFILE%','https://nft.paniniamerica.net/marketplace/nfts.html?sport=Soccer'" >> "%PANINI_LOG%" 2>&1
timeout /t 16 /nobreak >nul

REM 4) Re-check. If it is STILL not drivable the profile likely needs a manual
REM    re-login — bail loudly rather than walking cards against a dead session.
node scripts\panini-cdp-preflight.mjs >> "%PANINI_LOG%" 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [panini-run] ABORT: Chrome still not drivable after restart - re-login may be required >> "%PANINI_LOG%"
  endlocal
  exit /b 2
)

:run
node scripts\ingest-panini-runner.mjs >> "%PANINI_LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo ==== %DATE% %TIME% run end rc=%RC% ==== >> "%PANINI_LOG%"
endlocal & exit /b %RC%
