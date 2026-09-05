# Phase-2 setup + verification-key export for the position circuits.
#
# The second half of the pipeline. compile_positions.sh produces the R1CS under
# WSL; this runs snarkjs on the Windows node install and produces the proving
# keys and the Soroban-shaped verification keys.
#
# THIS IS NOT A CEREMONY. It is a single-party, disclosed Phase-2 with a fixed
# entropy string, so the toxic waste is known to whoever runs it and every proof
# it produces is forgeable by them. Fine for testnet, disqualifying for mainnet.
# Audit C5 tracks the real ceremony, which needs at least three independent
# contributors and a public beacon.

$ErrorActionPreference = 'Stop'
$circuits = @('position_open', 'position_close', 'position_health')

# Expected public-input counts, asserted against the exported key below.
# A verification key whose ic length does not match the contract's public input
# vector registers perfectly cleanly and then fails every real proof with an
# opaque PublicInputMismatch, long after anyone is looking at this step
# (audit D13).
$expectedInputs = @{
    'position_open'   = 8
    'position_close'  = 9
    'position_health' = 4
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$ptau = Join-Path $root 'ptau\pot16_final.ptau'
if (-not (Test-Path $ptau)) {
    throw 'Powers of Tau not found. See scripts/compile_all.sh for the download.'
}

foreach ($c in $circuits) {
    Write-Host "=== $c ===" -ForegroundColor Cyan
    $r1cs = "build\r1cs\$c.r1cs"
    if (-not (Test-Path $r1cs)) {
        throw "$r1cs missing. Run scripts/compile_positions.sh under WSL first."
    }

    $zkey0 = "build\zkey\" + $c + "_0000.zkey"
    $zkeyF = "build\zkey\" + $c + "_final.zkey"
    $vkey = "build\vkey\" + $c + "_vkey.json"
    $svkey = "build\vkey\" + $c + "_stellar_vkey.json"

    snarkjs groth16 setup $r1cs $ptau $zkey0
    snarkjs zkey contribute $zkey0 $zkeyF --name=vayyl-testnet-positions -v -e=vayyl-positions-testnet-2026-09-05
    snarkjs zkey export verificationkey $zkeyF $vkey

    node scripts\format_stellar_vk.js $vkey | Out-File -Encoding utf8 $svkey

    # D13: the key must describe the statement the contract actually builds.
    $vk = Get-Content $svkey -Raw | ConvertFrom-Json
    $actual = $vk.ic.Count - 1
    if ($actual -ne $expectedInputs[$c]) {
        throw "$c exported a VK for $actual public inputs; the contract sends $($expectedInputs[$c])."
    }

    # The Veil Cash / FoomCash bug. The verifier rejects such a key on
    # registration, but finding out here costs a second instead of a deploy.
    if ($vk.gamma_g2.bytes -eq $vk.delta_g2.bytes) {
        throw "$c produced a verification key with gamma == delta. Do not register it."
    }

    Write-Host "$c OK - $actual public inputs, gamma != delta" -ForegroundColor Green
}

Write-Host 'Copying witness WASM and proving keys into the frontend...' -ForegroundColor Cyan
$public = Join-Path (Split-Path -Parent $root) 'frontend\public\circuits'
foreach ($c in $circuits) {
    Copy-Item ("build\wasm\" + $c + ".wasm") (Join-Path $public ($c + ".wasm")) -Force
    Copy-Item ("build\zkey\" + $c + "_final.zkey") (Join-Path $public ($c + "_final.zkey")) -Force
}
Write-Host 'Done. Register the keys with scripts/register_vks.js, per circuit, never broadly.'
