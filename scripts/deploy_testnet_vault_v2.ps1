$ErrorActionPreference = "Stop"

$network = "testnet"
$source = if ($env:STELLAR_SOURCE) { $env:STELLAR_SOURCE } else { "vayyl-testnet-v2" }
$contractsRoot = Join-Path $PSScriptRoot "..\contracts"
$artifactsRoot = Join-Path $PSScriptRoot "..\circuits\build\v2"
$deploymentPath = Join-Path $PSScriptRoot "..\deployments\testnet-vault-v2.json"

function Invoke-Stellar {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $output = & stellar @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
    return ($output | Out-String).Trim()
}

function Deploy-Contract {
    param([Parameter(Mandatory = $true)][string]$Wasm)
    $output = Invoke-Stellar contract deploy --wasm $Wasm --network $network --source $source
    $id = ($output -split "`r?`n" | Where-Object { $_ -match '^C[A-Z0-9]{55}$' } | Select-Object -Last 1)
    if (-not $id) { throw "Could not parse contract id from deploy output: $output" }
    return $id.Trim()
}

try {
    $admin = Invoke-Stellar keys address $source
}
catch {
    Invoke-Stellar keys generate $source --fund --network $network | Out-Null
    $admin = Invoke-Stellar keys address $source
}

$asset = Invoke-Stellar contract id asset --asset native --network $network
$verifier = if ($env:V2_VERIFIER_ID) { $env:V2_VERIFIER_ID } else {
    Deploy-Contract (Join-Path $contractsRoot "target\wasm32v1-none\release\groth16_verifier.wasm")
}
$membership = if ($env:V2_MEMBERSHIP_ID) { $env:V2_MEMBERSHIP_ID } else {
    Deploy-Contract (Join-Path $contractsRoot "target\wasm32v1-none\release\asp_membership.wasm")
}
$nonMembership = if ($env:V2_NON_MEMBERSHIP_ID) { $env:V2_NON_MEMBERSHIP_ID } else {
    Deploy-Contract (Join-Path $contractsRoot "target\wasm32v1-none\release\asp_non_membership.wasm")
}
$pool = if ($env:V2_POOL_ID) { $env:V2_POOL_ID } else {
    Deploy-Contract (Join-Path $contractsRoot "target\wasm32v1-none\release\vayyl_pool.wasm")
}

if ($env:V2_SKIP_INIT -ne "1") {
    Invoke-Stellar contract invoke --id $verifier --network $network --source $source '--' initialize --admin $admin | Out-Null
    Invoke-Stellar contract invoke --id $membership --network $network --source $source '--' initialize --admin $admin | Out-Null
    Invoke-Stellar contract invoke --id $nonMembership --network $network --source $source '--' initialize --admin $admin | Out-Null
    Invoke-Stellar contract invoke --id $pool --network $network --source $source '--' initialize_v2 `
        --admin $admin --asset $asset --verifier $verifier --membership $membership `
        --non_membership $nonMembership | Out-Null

    $depositVk = Get-Content -Raw (Join-Path $artifactsRoot "vkey\deposit_v2_stellar_vkey.json")
    $withdrawVk = Get-Content -Raw (Join-Path $artifactsRoot "vkey\withdraw_v2_stellar_vkey.json")
    Invoke-Stellar contract invoke --id $verifier --network $network --source $source '--' set_vk `
        --circuit_id '{"Deposit":[]}' --vk $depositVk | Out-Null
    Invoke-Stellar contract invoke --id $verifier --network $network --source $source '--' set_vk `
        --circuit_id '{"Withdraw":[]}' --vk $withdrawVk | Out-Null
}

$depositInputs = Invoke-Stellar contract invoke --id $verifier --network $network --source $source `
    --send no '--' get_public_input_count --circuit_id '{"Deposit":[]}'
$withdrawInputs = Invoke-Stellar contract invoke --id $verifier --network $network --source $source `
    --send no '--' get_public_input_count --circuit_id '{"Withdraw":[]}'
$denomination = Invoke-Stellar contract invoke --id $pool --network $network --source $source `
    --send no '--' get_denomination

$deployment = [ordered]@{
    network = $network
    deployed_at = [DateTime]::UtcNow.ToString("o")
    source_account = $admin
    asset = $asset
    verifier = $verifier
    asp_membership = $membership
    asp_non_membership = $nonMembership
    pool = $pool
    denomination_stroops = [int64]$denomination.Trim('"')
    verification_keys = [ordered]@{
        deposit_public_inputs = [int]$depositInputs.Trim('"')
        withdraw_public_inputs = [int]$withdrawInputs.Trim('"')
    }
    wasm_sha256 = [ordered]@{
        pool = (Get-FileHash (Join-Path $contractsRoot "target\wasm32v1-none\release\vayyl_pool.wasm") -Algorithm SHA256).Hash.ToLower()
        verifier = (Get-FileHash (Join-Path $contractsRoot "target\wasm32v1-none\release\groth16_verifier.wasm") -Algorithm SHA256).Hash.ToLower()
    }
    setup = "single-machine testnet proving setup; not a production ceremony"
}
[IO.File]::WriteAllText($deploymentPath, ($deployment | ConvertTo-Json -Depth 4))

Write-Host "Vault V2 testnet deployment complete."
Write-Host "Pool: $pool"
Write-Host "Verifier: $verifier"
Write-Host "ASP membership: $membership"
Write-Host "ASP non-membership: $nonMembership"
