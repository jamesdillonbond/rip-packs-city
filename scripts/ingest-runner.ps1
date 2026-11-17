param(
    [string]$BaseUrl = "http://localhost:3000",
    [int]$BatchSize = 50,
    [int]$MaxBatches = 200,
    [int]$DelayMs = 500,
    [string]$Token = ""
)

if (-not $Token) {
    $envFile = Join-Path $PSScriptRoot ".." ".env.local"
    if (Test-Path $envFile) {
        foreach ($line in (Get-Content $envFile)) {
            if ($line -match "^INGEST_SECRET_TOKEN=(.+)$") {
                $Token = $Matches[1].Trim('"').Trim("'")
                break
            }
        }
    }
}

if (-not $Token) {
    Write-Host "ERROR: INGEST_SECRET_TOKEN not found in .env.local" -ForegroundColor Red
    exit 1
}

Write-Host "RPC Ingest Runner" -ForegroundColor Cyan
Write-Host "Target : $BaseUrl" -ForegroundColor Cyan
Write-Host "Batches: up to $MaxBatches x $BatchSize transactions" -ForegroundColor Cyan
Write-Host ""

$cursor = $null
$batch = 0
$totalSales = 0
$totalEditions = 0
$totalFmv = 0
$startTime = Get-Date

while ($batch -lt $MaxBatches) {
    $batch++

    $bodyObj = @{ batchSize = $BatchSize; cursor = $cursor }
    $bodyJson = $bodyObj | ConvertTo-Json

    $headers = @{
        "Authorization" = "Bearer $Token"
        "Content-Type"  = "application/json"
    }

    try {
        $r = Invoke-RestMethod `
            -Uri "$BaseUrl/api/ingest" `
            -Method POST `
            -Headers $headers `
            -Body $bodyJson `
            -TimeoutSec 60

        if (-not $r.ok) {
            Write-Host "Batch $batch error: $($r.error)" -ForegroundColor Red
            break
        }

        $totalSales    += [int]$r.salesIngested
        $totalEditions += [int]$r.editionsUpdated
        $totalFmv      += [int]$r.fmvUpdated
        $elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)

        $color = if ($r.errors -gt 0) { "Yellow" } else { "Green" }
        Write-Host ("Batch {0,3}  sales={1,4}  editions={2,4}  fmv={3,4}  total={4,6}  {5}s" -f `
            $batch, $r.salesIngested, $r.editionsUpdated, $r.fmvUpdated, $totalSales, $elapsed) `
            -ForegroundColor $color

        if (-not $r.hasMore -or -not $r.nextCursor) {
            Write-Host ""
            Write-Host "Cursor exhausted. All transactions ingested." -ForegroundColor Cyan
            break
        }

        $cursor = $r.nextCursor

        if ($DelayMs -gt 0) {
            Start-Sleep -Milliseconds $DelayMs
        }

    } catch {
        $code = $_.Exception.Response.StatusCode.Value__
        Write-Host "Batch $batch failed (HTTP $code): $($_.Exception.Message)" -ForegroundColor Red

        if ($code -eq 401) {
            Write-Host "Check INGEST_SECRET_TOKEN in .env.local" -ForegroundColor Red
            break
        }
        if ($code -eq 429) {
            Write-Host "Rate limited. Waiting 10s..." -ForegroundColor Yellow
            Start-Sleep -Seconds 10
            $batch--
            continue
        }
        Start-Sleep -Seconds 5
    }
}

$elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
Write-Host ""
Write-Host "DONE  batches=$batch  sales=$totalSales  editions=$totalEditions  fmv=$totalFmv  time=${elapsed}s" -ForegroundColor Cyan