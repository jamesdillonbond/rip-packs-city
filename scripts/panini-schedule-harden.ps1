# scripts/panini-schedule-harden.ps1 — make the residential Panini tasks survive a sleeping PC.
#
# WHY (2026-10-02): panini-schedule.bat / panini-team-walk-schedule.bat register their tasks with
# plain `schtasks /create`, which cannot set "wake the computer to run this task" or "run the task
# as soon as possible after a scheduled start is missed". Measured: the 2026-10-01 ~7:49 PM PT walk
# stopped mid-run with no error, and the 10 PM / 2 AM / 6 AM PT runs left no trace at all — every
# residential Panini lane went silent together while the cloud lanes kept running. That is the
# machine asleep, and with neither setting a missed run never catches up.
#
# WHAT IT DOES: for every existing scheduled task named "RPC Panini*", turns on WakeToRun and
# StartWhenAvailable and sets MultipleInstances=IgnoreNew (a catch-up start never overlaps a run
# still in progress). It changes nothing else (trigger, action and time limit stay as registered).
#
# RUN ONCE, in a normal (non-admin) PowerShell, from the repo checkout:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\panini-schedule-harden.ps1
# Safe to re-run. Undo per task: (Get-ScheduledTask "<name>").Settings.WakeToRun = $false, then Set-ScheduledTask.
#
# ⚠ Windows only honours WakeToRun if wake timers are allowed in the power plan
#   (Control Panel > Power Options > Change plan settings > Advanced > Sleep > Allow wake timers = Enable).
#   It wakes the PC to START a run; it does not stop the PC from sleeping again mid-run.

$tasks = @(Get-ScheduledTask -TaskName "RPC Panini*" -ErrorAction SilentlyContinue)
if ($tasks.Count -eq 0) {
  Write-Error "No scheduled task named 'RPC Panini*' found. Register them first (scripts\panini-schedule.bat)."
  exit 1
}

$failed = 0
foreach ($t in $tasks) {
  try {
    $t.Settings.WakeToRun = $true
    $t.Settings.StartWhenAvailable = $true
    $t.Settings.MultipleInstances = "IgnoreNew"
    Set-ScheduledTask -InputObject $t -ErrorAction Stop | Out-Null
    # Read it back: report what the scheduler now holds, not what we asked for.
    $s = (Get-ScheduledTask -TaskName $t.TaskName).Settings
    Write-Host ("{0}: WakeToRun={1} StartWhenAvailable={2} MultipleInstances={3}" -f $t.TaskName, $s.WakeToRun, $s.StartWhenAvailable, $s.MultipleInstances)
    if (-not ($s.WakeToRun -and $s.StartWhenAvailable)) { $failed++ }
  } catch {
    Write-Warning ("{0}: not updated — {1}" -f $t.TaskName, $_.Exception.Message)
    $failed++
  }
}

Write-Host ("Hardened {0} of {1} task(s)." -f ($tasks.Count - $failed), $tasks.Count)
if ($failed -gt 0) { exit 1 }
