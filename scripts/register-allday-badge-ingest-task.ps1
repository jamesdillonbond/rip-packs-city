# scripts/register-allday-badge-ingest-task.ps1
#
# Registers the Windows Task Scheduler job that runs the NFL All Day per-moment
# badge ingest from this (residential-IP) machine, daily. Idempotent: re-running
# replaces the task. Run once, as the logged-in user (no admin needed).
#
# Remove the schedule:
#   Unregister-ScheduledTask -TaskName "RPC AllDay Badge Ingest" -Confirm:$false
#
# Background: Dapper Atlas WAF-blocks datacenter IPs (Vercel + GitHub runner),
# so the ingest must run from a residential IP. Badges change slowly (only when
# new editions mint), so daily is ample.

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$runner   = Join-Path $RepoRoot "scripts\run-allday-badge-ingest.ps1"
$taskName = "RPC AllDay Badge Ingest"

if (-not (Test-Path $runner)) { Write-Error "missing $runner"; exit 1 }

$action  = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""

# Daily at 05:37 local, indefinitely (off the 06:00Z cron rush; badges are slow-moving).
$trigger = New-ScheduledTaskTrigger -Daily -At "5:37AM"

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 60)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "NFL All Day per-moment badge ingest. Residential-egress Atlas EditionService sweep, daily (Atlas WAF-blocks datacenter IPs, so this cannot run on Vercel/GitHub). Runs only while the user is logged on. Remove: Unregister-ScheduledTask -TaskName 'RPC AllDay Badge Ingest' -Confirm:`$false" | Out-Null

Write-Host "Registered scheduled task '$taskName' (daily 05:37)."
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
