@echo off
REM Schedules panini-collector-walk-linked.bat (beside this file) every 2 hours on odd
REM hours at :20 - 21:20, 23:20, 01:20 ... - off the ingest runner's even-hour slots.
REM Double-click to install or refresh. The result is written beside this file to
REM panini-linked-walk-schedule.out so it can be checked without a console.
setlocal
set "TASK=RPC Panini Linked Walk"
set "RUN=%~dp0panini-collector-walk-linked.bat"
set "OUT=%~dp0panini-linked-walk-schedule.out"
schtasks /create /f /tn "%TASK%" /tr "\"%RUN%\"" /sc hourly /mo 2 /st 21:20 > "%OUT%" 2>&1
if %ERRORLEVEL% EQU 0 (
  powershell -NoProfile -Command "$t = Get-ScheduledTask -TaskName '%TASK%'; $t.Settings.ExecutionTimeLimit = 'PT45M'; $t.Settings.StartWhenAvailable = $true; $null = Set-ScheduledTask -InputObject $t" >> "%OUT%" 2>&1
)
schtasks /query /tn "%TASK%" /fo list /v >> "%OUT%" 2>&1
endlocal
