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
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
set "PROFILE=%USERPROFILE%\panini-cdp-profile"
set "RPC_PANINI_INGEST_URL=https://www.rippackscity.com/api/cron/panini-ingest"
set "PANINI_CDP_URL=http://localhost:9222"

REM Launch the dedicated debug Chrome only if port 9222 isn't already listening.
powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1',9222); $c.Close() } catch { Start-Process '%CHROME%' -ArgumentList '--remote-debugging-port=9222','--user-data-dir=%PROFILE%','https://nft.paniniamerica.net/marketplace/nfts.html?sport=Soccer'; Start-Sleep -Seconds 14 }"

cd /d "%USERPROFILE%\rip-packs-city"
node scripts\ingest-panini-runner.mjs
