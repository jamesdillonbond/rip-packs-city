@echo off
REM ============================================================================
REM One-time setup: registers the Panini ingest runner as a Windows scheduled
REM task (every 4 hours). Double-click this file ONCE. No admin needed — it runs
REM in your own user session (the home-machine pattern; needs you logged in).
REM
REM PREREQUISITES (do these first, once):
REM   1. Set your ingest token as a persistent user env var:
REM        setx INGEST_SECRET_TOKEN "your-exact-token"
REM      (open a NEW terminal after, so it takes effect)
REM   2. First Panini login — launch the dedicated debug Chrome and sign in once:
REM        "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\panini-cdp-profile"
REM      Log into nft.paniniamerica.net, then leave that profile (it persists the session).
REM ============================================================================
set "TASK=RPC Panini Ingest"
set "RUN=%USERPROFILE%\rip-packs-city\scripts\panini-run.bat"

if not exist "%RUN%" (
  echo ERROR: %RUN% not found. Run this from your rip-packs-city checkout.
  pause & exit /b 1
)

schtasks /create /f /tn "%TASK%" /tr "\"%RUN%\"" /sc hourly /mo 4 /st 06:00
if %errorlevel%==0 (
  echo.
  echo Scheduled "%TASK%" to run every 4 hours starting 06:00.
  echo Run it now to test:   schtasks /run /tn "%TASK%"
  echo Remove it later with: schtasks /delete /tn "%TASK%" /f
) else (
  echo Failed to create the task ^(errorlevel %errorlevel%^).
)
echo.
pause
