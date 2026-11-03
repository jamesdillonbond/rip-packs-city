# scripts/panini-keep-awake.ps1 - hold the PC awake while a residential Panini run is in progress.
#
# WHY (2026-10-02): panini-schedule-harden.ps1 makes the Panini tasks WAKE the PC, but a scheduled
# task does not keep it awake. After an unattended (timer) wake Windows goes back to sleep after the
# "system unattended sleep timeout" (default 2 min) unless a process holds an execution-state
# request, so a woken walk (75-100 min) would be cut off minutes in. Measured on the box 10-02:
# asleep 9:32 PM -> 7:07 AM PT, and the 10 PM / 2 AM / 6 AM runs never happened.
#
# HOW: calls SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) and holds it while the
# -Flag file exists. The launcher .bat creates the flag before its work and deletes it on every exit
# path. -MaxMinutes bounds the hold if the launcher is killed (task time limit) and never deletes it.
# The request dies with this process.
#
# 2026-11-03: SYSTEM_REQUIRED alone was NOT enough. The box slept ~7 min during the 10:00 AM PT run's
# enumeration (runner log: WATCHDOG slept ... clock jumped 7m; CDP reconnect timed out, rc=1), the 4th
# such sleep in panini-run.log, with this script holding its request. On a Modern Standby laptop the
# system can enter standby once the DISPLAY times out whatever ES_SYSTEM_REQUIRED says, so the hold
# now also sets ES_DISPLAY_REQUIRED: the screen stays on for the run (Trevor chose this 11-03). A
# closed lid still sleeps the box - nothing here can prevent that. Opt out: -AllowDisplayOff.
#
# Check it while a run is going: powercfg /requests  (lists powershell.exe under SYSTEM).
param(
  [Parameter(Mandatory = $true)][string]$Flag,
  [int]$MaxMinutes = 130,
  [switch]$AllowDisplayOff
)

Add-Type -Namespace RpcPanini -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
$ES_DISPLAY_REQUIRED = [uint32]2
$hold = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED
if (-not $AllowDisplayOff) { $hold = $hold -bor $ES_DISPLAY_REQUIRED }
$deadline = (Get-Date).AddMinutes($MaxMinutes)

$prev = [RpcPanini.Power]::SetThreadExecutionState($hold)
if ($prev -eq 0) { Write-Error "SetThreadExecutionState failed"; exit 1 }

while ((Test-Path -LiteralPath $Flag) -and ((Get-Date) -lt $deadline)) {
  Start-Sleep -Seconds 20
}

[RpcPanini.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
