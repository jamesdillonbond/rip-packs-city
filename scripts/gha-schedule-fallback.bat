@echo off
REM Runner for the "RPC GHA schedule fallback" task (scripts/gha-schedule-fallback.mjs, 2026-11-17).
REM Dispatches GitHub's scheduled workflows from this machine while GitHub delivers no `schedule` events;
REM stands down by itself once it does. Log: %LOCALAPPDATA%\rpc-gha-fallback\task.log
set "PATH=C:\Program Files\GitHub CLI;C:\Program Files\nodejs;%PATH%"
if not exist "%LOCALAPPDATA%\rpc-gha-fallback" mkdir "%LOCALAPPDATA%\rpc-gha-fallback"
cd /d "%USERPROFILE%\rip-packs-city"
node scripts\gha-schedule-fallback.mjs >> "%LOCALAPPDATA%\rpc-gha-fallback\task.log" 2>&1
