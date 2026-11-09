@echo off
REM ============================================================================
REM Panini LINKED-USERNAME walk (2026-11-08, Dame Time). The daily collector walk
REM reads 10 fixed names + a rotation before any username a user LINKED on
REM rippackscity.com, so a collector who linked tonight waited up to a day (6 of 11
REM linked usernames had never been read). This walks ONLY the linked usernames,
REM capped per profile, and is scheduled every 2 hours by
REM panini-collector-walk-linked-schedule.bat (odd hours, off the ingest runner's
REM even-hour slots). Same Chrome, same receiver, same log as the daily walk.
REM Budget (2026-11-09): 11 linked profiles at up to 4 min each. The first cut
REM (25 / 5 / 35) never reached webz80 or wizwit, last alphabetically. Last start
REM at 36 + a 4 min cap = 40, inside HARD 42 and the scheduled task's 45 min kill.
REM ============================================================================
setlocal
REM A defined-but-blank list keeps the daily walk's fixed names out of this run.
set "PANINI_COLLECTOR_TARGETS= "
set "PANINI_COLLECTOR_ROTATION=0"
set "PANINI_COLLECTOR_PLAN=25"
set "PANINI_COLLECTOR_BUDGET_MIN=36"
set "PANINI_COLLECTOR_WALK_MAX_MIN=4"
set "PANINI_COLLECTOR_HARD_MIN=42"
call "%USERPROFILE%\rip-packs-city\scripts\panini-collector-walk.bat"
endlocal & exit /b %ERRORLEVEL%
