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
# Only SYSTEM_REQUIRED: the display may still turn off. The request dies with this process.
#
# Check it while a run is going: powercfg /requests  (lists powershell.exe under SYSTEM).
param(
  [Parameter(Mandatory = $true)][string]$Flag,
  [int]$MaxMinutes = 130
)

Add-Type -Namespace RpcPanini -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
$deadline = (Get-Date).AddMinutes($MaxMinutes)

$prev = [RpcPanini.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
if ($prev -eq 0) { Write-Error "SetThreadExecutionState failed"; exit 1 }

while ((Test-Path -LiteralPath $Flag) -and ((Get-Date) -lt $deadline)) {
  Start-Sleep -Seconds 20
}

[RpcPanini.Power]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
