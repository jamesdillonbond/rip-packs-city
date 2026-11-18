@echo off
REM ============================================================================
REM One-time setup: registers the GitHub schedule FALLBACK as a Windows scheduled
REM task, every 5 minutes. No admin needed; runs in your own session, using the
REM gh CLI you are already signed in to (no new credential is stored anywhere).
REM It does nothing while GitHub delivers scheduled runs (stands down when any
REM `schedule` run is < 90 min old), so it is safe to leave registered.
REM Remove it once GitHub schedules are healthy again:
REM   schtasks /delete /tn "RPC GHA schedule fallback" /f
REM ============================================================================
set "TASK=RPC GHA schedule fallback"
set "RUN=%USERPROFILE%\rip-packs-city\scripts\gha-schedule-fallback.bat"

if not exist "%RUN%" (
  echo ERROR: %RUN% not found. Pull the latest rip-packs-city first.
  exit /b 1
)

schtasks /create /f /tn "%TASK%" /tr "\"%RUN%\"" /sc minute /mo 5
if %errorlevel%==0 (
  REM 10 min limit: a run is ~1 min of gh calls; a hung one must not block the next ticks.
  powershell -NoProfile -Command "$t = Get-ScheduledTask -TaskName '%TASK%'; $t.Settings.ExecutionTimeLimit = 'PT10M'; $null = Set-ScheduledTask -InputObject $t"
  echo Scheduled "%TASK%" every 5 minutes.
  echo Log: %LOCALAPPDATA%\rpc-gha-fallback\log.jsonl
) else (
  echo Failed to create the task ^(errorlevel %errorlevel%^).
)
