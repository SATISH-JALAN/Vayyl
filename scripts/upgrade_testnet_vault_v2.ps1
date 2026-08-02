# Upgrade the LIVE testnet V2 vault in place.
#
# Use this, not deploy_testnet_vault_v2.ps1, against a stack that already exists:
# the deploy script calls initialize* on every contract and fails with
# AlreadyInitialized. This script only uploads new pool wasm, calls upgrade(),
# and (re)registers verification keys.
#
# Upgrading in place keeps the contract IDs, the Merkle tree, the nullifier set,
# and therefore every user's existing notes. Redeploying would strand them.
#
# TESTNET ONLY. Never point this at the public network.
#
#     $env:STELLAR_SOURCE = "deployer"; .\scripts\upgrade_testnet_vault_v2.ps1

param(
    # Circuit VKs to (re)register: CircuitId symbol -> artifact basename.
    [hashtable]$VerificationKeys = @{ Transfer = "transfer_v2" },
    [switch]$SkipPoolUpgrade
)

$ErrorActionPreference = "Stop"

$network = "testnet"
$source = if ($env:STELLAR_SOURCE) { $env:STELLAR_SOURCE } else { "deployer" }
$contractsRoot = Join-Path $PSScriptRoot "..\contracts"
$artifactsRoot = Join-Path $PSScriptRoot "..\circuits\build\v2"
$deploymentPath = Join-Path $PSScriptRoot "..\deployments\testnet-vault-v2.json"

if (-not (Test-Path $deploymentPath)) {
    throw "No deployment record at $deploymentPath. Deploy first with deploy_testnet_vault_v2.ps1."
}
$deployment = Get-Content -Raw $deploymentPath | ConvertFrom-Json

function Invoke-Stellar {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    # Windows PowerShell 5.1 wraps a native exe's stderr in ErrorRecords, which
    # $ErrorActionPreference='Stop' escalates into a failure even on success --
    # and the stellar CLI writes progress to stderr. Exit code is the real signal.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $errFile = [IO.Path]::GetTempFileName()
    try {
        $output = & stellar @Arguments 2>$errFile
        if ($LASTEXITCODE -ne 0) {
            throw ((Get-Content -Raw -LiteralPath $errFile) + ($output | Out-String))
        }
        return ($output | Out-String).Trim()
    }
    finally {
        $ErrorActionPreference = $prev
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-CliVkArgument {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $obj = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    # A VK with gamma == delta lets a forged proof verify (Veil Cash / FoomCash).
    # The contract rejects it too, but failing here costs no transaction.
    if ($obj.gamma_g2 -eq $obj.delta_g2) {
        throw "$Label verification key has gamma == delta; refusing to register. Re-run the phase-2 setup."
    }
    return ($obj | ConvertTo-Json -Depth 10 -Compress) -replace '"', '\"'
}

Write-Host "Target stack (testnet):"
Write-Host "  pool     $($deployment.pool)"
Write-Host "  verifier $($deployment.verifier)"
Write-Host "  source   $source"

# ---- verification keys -----------------------------------------------------
# Register BEFORE the pool upgrade: a new entrypoint whose VK is missing fails
# every call with InvalidProof, and registering is the reversible half.
foreach ($circuit in $VerificationKeys.Keys) {
    $basename = $VerificationKeys[$circuit]
    $vkPath = Join-Path $artifactsRoot "vkey\${basename}_stellar_vkey.json"
    if (-not (Test-Path $vkPath)) {
        throw "Missing verification key $vkPath. Build it with circuits/scripts/build_vault_v2.ps1 -Circuits $basename"
    }
    Write-Host "Registering $circuit VK from $basename ..."
    $vk = Get-CliVkArgument $vkPath $basename
    Invoke-Stellar contract invoke --id $deployment.verifier --network $network --source $source `
        '--' set_vk --circuit_id "{\`"$circuit\`":[]}" --vk $vk | Out-Null

    $inputs = Invoke-Stellar contract invoke --id $deployment.verifier --network $network --source $source `
        --send no '--' get_public_input_count --circuit_id "{\`"$circuit\`":[]}"
    Write-Host "  $circuit registered with $($inputs.Trim('"')) public inputs"
}

# ---- pool wasm -------------------------------------------------------------
if (-not $SkipPoolUpgrade) {
    $wasm = Join-Path $contractsRoot "target\wasm32v1-none\release\vayyl_pool.wasm"
    if (-not (Test-Path $wasm)) { throw "Missing $wasm. Run 'stellar contract build' in contracts/ first." }

    Write-Host "Uploading pool wasm ..."
    $wasmHash = Invoke-Stellar contract upload --wasm $wasm --network $network --source $source
    $wasmHash = ($wasmHash -split "`r?`n" | Where-Object { $_ -match '^[0-9a-f]{64}$' } | Select-Object -Last 1)
    if (-not $wasmHash) { throw "Could not parse wasm hash from upload output." }
    Write-Host "  wasm hash $wasmHash"

    Write-Host "Upgrading pool in place (contract id unchanged) ..."
    Invoke-Stellar contract invoke --id $deployment.pool --network $network --source $source `
        '--' upgrade --new_wasm_hash $wasmHash | Out-Null

    $deployment | Add-Member -NotePropertyName wasm_sha256_pool_upgraded -NotePropertyValue $wasmHash -Force
}

# ---- record ----------------------------------------------------------------
$deployment | Add-Member -NotePropertyName upgraded_at -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
$transferInputs = Invoke-Stellar contract invoke --id $deployment.verifier --network $network --source $source `
    --send no '--' get_public_input_count --circuit_id '{\"Transfer\":[]}'
$deployment.verification_keys | Add-Member -NotePropertyName transfer_public_inputs `
    -NotePropertyValue ([int]$transferInputs.Trim('"')) -Force
[IO.File]::WriteAllText($deploymentPath, ($deployment | ConvertTo-Json -Depth 6))

Write-Host "Vault V2 upgrade complete."
