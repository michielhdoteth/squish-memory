$ErrorActionPreference = "Stop"

$mode = if ($args[0]) { $args[0] } else { "retrieval-only" }
$tag = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = "benchmark\RESULTS_$($mode)_$tag.log"

Write-Host "Mode: $mode"
Write-Host "Log: $logFile"

$env:BENCH_SKIP_INGEST = "true"
$env:BENCH_MODE = $mode
$env:BENCH_NVIDIA_API_KEY = $env:NVIDIA_API_KEY
$env:SQUISH_SKIP_CONTRADICTION = "true"
$env:SQUISH_QUERY_EXPANSION = "true"
$env:SQUISH_ENTITY_RETRIEVAL = "true"
$env:SQUISH_TEMPORAL_VALIDITY = "true"

Write-Host "Starting benchmark..."
& bun benchmark/locomo-benchmark.ts 2>&1 | Tee-Object -FilePath $logFile
Write-Host "`nDone. Log saved to $logFile"
