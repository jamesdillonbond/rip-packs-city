# atlas-pool-harvest.ps1 - Rip Packs City: harvest REAL per-edition remaining counts for
# historical Top Shot packs from Dapper Atlas (GetDistributionEditions) and post them to
# the ingest-topshot-atlas-pool edge fn, which rebuilds pack_drop_pool (pool_source='atlas')
# so Pack EV can price depleted packs honestly.
#
# WHY THIS RUNS ON THE HOME MACHINE: Atlas 403s all datacenter egress AND requires a Top
# Shot user JWT - only the operator's residential IP + session can call it.
#
# ONE-TIME SETUP (~2 min):
#   1. Log into nbatopshot.com in Chrome. Open DevTools > Network. Click around a pack page.
#   2. Find any request to api.production.atlas.dapperlabs.com (or another authed TS API
#      call). Copy the value of the `authorization` header (starts "Bearer ...") and, if
#      present, the `x-id-token` header.
#   3. Create %USERPROFILE%\.rpc\atlas-auth.json :
#        { "authorization": "Bearer eyJ...", "x_id_token": "eyJ..." }
#      (x_id_token optional if the request you copied didn't have one.)
#   4. Run this script (it exits cleanly when there are no targets):
#        powershell -ExecutionPolicy Bypass -File scripts\atlas-pool-harvest.ps1
#   Optional: register in Task Scheduler weekly. The JWT expires; re-paste when the script
#   reports 401s. Targets list shrinks to zero as pools heal - most value is in the first run.
#
# The script sends RAW Atlas responses; all mapping/validation happens server-side in the
# edge fn (unmappable shapes are rejected + logged with sample keys, never written).
#
# "SKIP dist N: atlas_empty" lines are NORMAL, not failures: Atlas returns an empty
# editions list for bundle (Box/Case) distributions on both id forms, and for the numeric
# dist_id form of dists whose uuid form then succeeds. The edge fn records empty dists in
# topshot_atlas_no_pool_dists so they leave the targets list automatically (re-checked
# after 30 days; the marker clears itself if a later run finds real pool data).

$ErrorActionPreference = "Stop"
$IngestKey  = $env:ATLAS_POOL_INGEST_KEY
if (-not $IngestKey) { throw "ATLAS_POOL_INGEST_KEY env var not set. Set it to the rotated edge secret before harvesting (see the atlas-pool key-rotation runbook)." }
$IngestBase = "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/ingest-topshot-atlas-pool?key=$IngestKey"
$AtlasUrl   = "https://api.production.atlas.dapperlabs.com/atlas.v1.DistributionService/GetDistributionEditions"
$AuthFile   = Join-Path $env:USERPROFILE ".rpc\atlas-auth.json"

if (-not (Test-Path $AuthFile)) { Write-Host "Missing $AuthFile - see setup comment at top of script."; exit 1 }
$auth = Get-Content $AuthFile -Raw | ConvertFrom-Json
$headers = @{ "authorization" = $auth.authorization; "content-type" = "application/json" }
if ($auth.x_id_token) { $headers["x-id-token"] = $auth.x_id_token }

Write-Host "Fetching targets..."
$targets = (Invoke-RestMethod -Uri "$IngestBase&mode=targets" -Method GET).targets
if (-not $targets -or $targets.Count -eq 0) { Write-Host "No targets - all pools honest. Done."; exit 0 }
Write-Host ("{0} target dists" -f $targets.Count)

$ok = 0; $fail = 0
foreach ($t in $targets) {
  foreach ($distKey in @($t.dist_id, $t.pack_listing_uuid)) {
    try {
      $body = @{ distributionId = "$distKey"; hideOpened = $false; product = "nba" } | ConvertTo-Json
      $atlas = Invoke-RestMethod -Uri $AtlasUrl -Method POST -Headers $headers -Body $body
      $post = @{ dist_id = "$($t.dist_id)"; atlas = $atlas } | ConvertTo-Json -Depth 12
      $res = Invoke-RestMethod -Uri $IngestBase -Method POST -ContentType "application/json" -Body $post
      if ($res.ok) { Write-Host ("OK   dist {0} ({1}): {2} pool rows" -f $t.dist_id, $t.title, $res.rows); $ok++; break }
      else { Write-Host ("SKIP dist {0}: {1}" -f $t.dist_id, $res.reason) }
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($status -eq 401) { Write-Host "Atlas 401 - JWT expired. Re-paste headers into $AuthFile."; exit 1 }
      Write-Host ("ERR  dist {0} via {1}: HTTP {2}" -f $t.dist_id, $distKey, $status)
    }
  }
  if (-not $?) { $fail++ }
  Start-Sleep -Milliseconds 800
}
Write-Host ("Done. ok={0}" -f $ok)
