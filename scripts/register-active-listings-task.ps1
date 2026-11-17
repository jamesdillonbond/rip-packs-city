# scripts/register-active-listings-task.ps1
#
# Registers the Windows Task Scheduler job that runs the underpriced-#1s
# deal-board ingest from this (residential-IP) machine every ~3h. Idempotent:
# re-running replaces the task. Run once, as the logged-in user (no admin needed).
#
# Remove the schedule:
#   Unregister-ScheduledTask -TaskName "RPC Deal Board Ingest" -Confirm:$false
#
# Background: Dapper Atlas WAF-blocks datacenter IPs (Vercel + GitHub runner),
# so the ingest must run from a residential IP. The GH workflow is disabled.

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$runner   = Join-Path $RepoRoot "scripts\run-active-listings-ingest.ps1"
$taskName = "RPC Deal Board Ingest"

if (-not (Test-Path $runner)) { Write-Error "missing $runner"; exit 1 }

$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""

# Every 3h at :13 (matches the disabled GH workflow's cron), indefinitely.
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(13)) `
  -RepetitionInterval (New-TimeSpan -Hours 3)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 40)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "Underpriced #1s deal-board ingest. Residential-egress Atlas listings sweep every ~3h (Atlas WAF-blocks datacenter IPs, so this cannot run on Vercel/GitHub). Runs only while the user is logged on. Remove: Unregister-ScheduledTask -TaskName 'RPC Deal Board Ingest' -Confirm:`$false" | Out-Null

Write-Host "Registered scheduled task '$taskName' (every 3h at :13)."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
