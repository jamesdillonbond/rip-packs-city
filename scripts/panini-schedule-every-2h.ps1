# scripts/panini-schedule-every-2h.ps1 - run "RPC Panini Ingest" every 2 hours instead of every 4.
#
# WHY (2026-10-03, Trevor chose "more runs"): a run refreshes ~290-370 Panini editions against ~15.7k in
# the catalogue, an ~8-day rotation. The route now alternates FULL runs (grids + packs + cards) at the
# old 2/6/10 AM-PM PT slots with WALK-only runs (cards for the whole run) at 12/4/8 AM-PM PT - see
# lib/chains/panini/run-mode.ts. The box only has to start a run every 2 hours.
#
# WHAT IT DOES: changes ONLY the repetition interval of the task's trigger(s) to 2 hours (PT2H). The
# start time, the action, the 2 h time limit and the hardened settings (WakeToRun, StartWhenAvailable,
# MultipleInstances=IgnoreNew from panini-schedule-harden.ps1) are kept. A run that is still going when
# the next one is due is not overlapped (IgnoreNew); the runner itself stops its card walk at 110 min.
#
# RUN ONCE, in a normal PowerShell, from the repo checkout:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\panini-schedule-every-2h.ps1
# Undo: same script with -Hours 4.
param([int]$Hours = 2)

$name = "RPC Panini Ingest"
$t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if (-not $t) { Write-Error "Scheduled task '$name' not found. Register it first (scripts\panini-schedule.bat)."; exit 1 }

$n = 0
foreach ($tr in $t.Triggers) {
  if ($tr.Repetition) { $tr.Repetition.Interval = "PT$($Hours)H"; $n++ }
}
if ($n -eq 0) { Write-Error "'$name' has no repeating trigger to change."; exit 1 }

try {
  Set-ScheduledTask -InputObject $t -ErrorAction Stop | Out-Null
} catch {
  Write-Error ("Could not update '{0}': {1}" -f $name, $_.Exception.Message); exit 1
}

# Read it back: report what the scheduler now holds, not what we asked for.
$after = Get-ScheduledTask -TaskName $name
$info = Get-ScheduledTaskInfo -TaskName $name
$ok = $true
foreach ($tr in $after.Triggers) {
  Write-Host ("{0}: repeat every {1}, starting {2}" -f $name, $tr.Repetition.Interval, $tr.StartBoundary)
  if ($tr.Repetition.Interval -ne "PT$($Hours)H") { $ok = $false }
}
$s = $after.Settings
Write-Host ("Settings kept: WakeToRun={0} StartWhenAvailable={1} MultipleInstances={2} TimeLimit={3}" -f $s.WakeToRun, $s.StartWhenAvailable, $s.MultipleInstances, $s.ExecutionTimeLimit)
Write-Host ("Next run: {0}" -f $info.NextRunTime)
if (-not $ok) { Write-Error "The interval did not take."; exit 1 }
