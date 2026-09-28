@echo off
REM ============================================================================
REM One-time setup: registers the Panini TEAM WALK as its own Windows scheduled
REM task — daily at 3:35 AM. Double-click this file ONCE.
REM No admin needed; runs in your own session (same pattern as panini-schedule.bat).
REM Needs nothing new: it reuses INGEST_SECRET_TOKEN and the panini debug Chrome.
REM ============================================================================
set "TASK=RPC Panini Team Walk"
set "RUN=%USERPROFILE%\rip-packs-city\scripts\panini-team-walk.bat"

if not exist "%RUN%" (
  echo ERROR: %RUN% not found. Pull the latest rip-packs-city first.
  pause & exit /b 1
)

schtasks /create /f /tn "%TASK%" /tr "\"%RUN%\"" /sc daily /st 03:35
if %errorlevel%==0 (
  REM 3.5 h limit, not the 72 h default: a hung 09-25 run held the task "Running" and
  REM MultipleInstances=IgnoreNew skipped the next two days (2026-09-28). The scripts' own
  REM watchdogs exit first (team 160 + collector 30 = 190 min); this is the backstop.
  powershell -NoProfile -Command "$t = Get-ScheduledTask -TaskName '%TASK%'; $t.Settings.ExecutionTimeLimit = 'PT3H30M'; $null = Set-ScheduledTask -InputObject $t"
  echo.
  echo Scheduled "%TASK%" daily at 3:35 AM.
  echo Run it now to test:   schtasks /run /tn "%TASK%"
  echo Log:                  %USERPROFILE%\panini-team-walk.log
  echo Remove it later with: schtasks /delete /tn "%TASK%" /f
) else (
  echo Failed to create the task ^(errorlevel %errorlevel%^).
)
echo.
pause
