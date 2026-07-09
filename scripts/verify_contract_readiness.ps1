# Pre-testnet contract readiness gate - run from repo root.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== Vayyl contract readiness ==" -ForegroundColor Cyan

Push-Location (Join-Path $root "contracts")
try {
    Write-Host "`n[cargo test]" -ForegroundColor Yellow
    cargo test
    if ($LASTEXITCODE -ne 0) { throw "cargo test failed" }
} finally {
    Pop-Location
}

Push-Location (Join-Path $root "circuits")
try {
    Write-Host "`n[pnpm circuit tests]" -ForegroundColor Yellow
    pnpm test
    if ($LASTEXITCODE -ne 0) { throw "pnpm circuit tests failed" }
} finally {
    Pop-Location
}

$vkeyDir = Join-Path $root "circuits\build\vkey"
$expected = @(
    "deposit_stellar_vkey.json",
    "transfer_stellar_vkey.json",
    "withdraw_stellar_vkey.json",
    "position_open_stellar_vkey.json",
    "position_health_stellar_vkey.json",
    "position_close_stellar_vkey.json",
    "liquidation_heartbeat_stellar_vkey.json",
    "hidden_order_trigger_stellar_vkey.json",
    "sealed_order_stellar_vkey.json"
)

Write-Host "`n[VK files]" -ForegroundColor Yellow
$missing = @()
foreach ($vk in $expected) {
    $path = Join-Path $vkeyDir $vk
    if (-not (Test-Path $path)) { $missing += $vk }
}
if ($missing.Count -gt 0) {
    Write-Host "Missing VKs (run circuits/scripts/compile_all.ps1):" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" }
    exit 1
}
Write-Host "All 9 VK files present." -ForegroundColor Green

Write-Host "`n[VK dry-run registration]" -ForegroundColor Yellow
$env:DRY_RUN = "1"
pnpm exec node (Join-Path $root "scripts\register_vks.js")
if ($LASTEXITCODE -ne 0) { throw "register_vks dry-run failed" }
Remove-Item Env:DRY_RUN -ErrorAction SilentlyContinue

Write-Host "`nPASS - contracts ready for testnet deploy." -ForegroundColor Green
