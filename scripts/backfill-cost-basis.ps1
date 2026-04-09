# Run from project root: .\scripts\backfill-cost-basis.ps1
# Processes all owned moments in chunks of 50, looping until done.

$wallet = "0xbd94cade097e50ac"
$baseUrl = "https://rip-packs-city.vercel.app/api/cost-basis-gql-backfill"
$token = "rippackscity2026"

$offset = 0
$limit = 50
$totalInserted = 0

Write-Host "Starting cost basis GQL backfill for $wallet"

while ($true) {
    Write-Host ""
    Write-Host "--- Processing offset=$offset limit=$limit ---"

    $body = @{ wallet = $wallet; offset = $offset; limit = $limit } | ConvertTo-Json

    $response = Invoke-WebRequest -Uri $baseUrl -Method POST -Headers @{
        "Content-Type"  = "application/json"
        "Authorization" = "Bearer $token"
    } -Body $body -UseBasicParsing | Select-Object -ExpandProperty Content

    $data = $response | ConvertFrom-Json

    Write-Host ("Processed: {0} | Inserted: {1} | NoPrice: {2} | Skipped: {3} | Remaining: {4}" -f `
        $data.processed, $data.inserted, $data.noPrice, $data.skippedExisting, $data.remaining)

    $totalInserted += [int]$data.inserted

    if ($data.done -eq $true) {
        Write-Host ""
        Write-Host "=== COMPLETE ==="
        Write-Host "Total inserted: $totalInserted"
        break
    }

    $offset = [int]$data.nextOffset
    Start-Sleep -Seconds 2
}
