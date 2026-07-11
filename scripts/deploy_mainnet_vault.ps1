param([switch]$DryRun)

$ErrorActionPreference = "Stop"

$NETWORK = "vayyl-mainnet-onfinality"
$SOURCE = "vayyl-mainnet-1"
$DEPLOY_FILE = Join-Path (Get-Location) "deployments/mainnet-vault-v1.json"
$XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"
$WASM_DIR = "contracts/target/wasm32v1-none/release"
$env:STELLAR_INCLUSION_FEE = "10000" # 0.001 XLM ceiling; avoids Mainnet minimum-fee timeouts

$required = @(
    "$WASM_DIR/groth16_verifier.wasm",
    "$WASM_DIR/asp_membership.wasm",
    "$WASM_DIR/asp_non_membership.wasm",
    "$WASM_DIR/vayyl_pool.wasm",
    "circuits/build/vkey/deposit_stellar_vkey.json",
    "circuits/build/vkey/withdraw_stellar_vkey.json"
)
foreach ($path in $required) {
    if (-not (Test-Path $path)) { throw "Missing required release artifact: $path" }
}
if ((Test-Path $DEPLOY_FILE) -and -not $DryRun) {
    throw "$DEPLOY_FILE already exists. Refusing to create a second Vault v1 deployment."
}

$ADMIN = (stellar keys address $SOURCE).Trim()

if ($DryRun) {
    Write-Host "Vault v1 deployment preflight passed."
    Write-Host "Network: $NETWORK"
    Write-Host "Source : $SOURCE ($ADMIN)"
    Write-Host "Asset  : native XLM SAC $XLM_SAC"
    Write-Host "Scope  : verifier + Deposit/Withdraw VKs + ASP membership/non-membership + one XLM pool"
    exit 0
}

$deployment = [ordered]@{
    schema_version = 1
    release = "vayyl-vault-v1"
    demo_only = $true
    network = "mainnet"
    network_profile = $NETWORK
    network_passphrase = "Public Global Stellar Network ; September 2015"
    source_account = $ADMIN
    asset = $XLM_SAC
    verifier = $null
    asp_membership = $null
    asp_non_membership = $null
    pool = $null
    registered_circuits = @()
    settlement_authorities = @()
    trusted_setup = "single-party handover artifacts; hackathon demo only"
    deployed_at = (Get-Date).ToUniversalTime().ToString("o")
    artifacts = [ordered]@{}
}

foreach ($path in $required) {
    $deployment.artifacts[$path.Replace('\\', '/')] = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()
}

function Save-Deployment {
    New-Item -ItemType Directory -Force -Path (Split-Path $DEPLOY_FILE) | Out-Null
    [System.IO.File]::WriteAllText($DEPLOY_FILE, ($deployment | ConvertTo-Json -Depth 6))
}

function Deploy-Contract([string]$Name, [string]$WasmPath) {
    Write-Host "Deploying $Name..."
    $output = & stellar contract deploy --wasm $WasmPath --network $NETWORK --source $SOURCE 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
    $id = (($output | Out-String).Trim() -split "`n" | Where-Object { $_ -match '^C[A-Z0-9]{55}$' } | Select-Object -Last 1).Trim()
    if (-not $id) { throw "Could not parse $Name contract id from deployment output." }
    Write-Host "${Name}: $id"
    return $id
}

function Invoke-Contract([string]$Id, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Args) {
    $output = & stellar contract invoke --id $Id --network $NETWORK --source $SOURCE -- @Args 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output | Out-String) }
    return ($output | Out-String).Trim()
}

$deployment.verifier = Deploy-Contract "Groth16 verifier" "$WASM_DIR/groth16_verifier.wasm"
Save-Deployment
Invoke-Contract $deployment.verifier initialize --admin $ADMIN | Out-Null

$deployment.asp_membership = Deploy-Contract "ASP membership" "$WASM_DIR/asp_membership.wasm"
Save-Deployment
Invoke-Contract $deployment.asp_membership initialize --admin $ADMIN | Out-Null

$deployment.asp_non_membership = Deploy-Contract "ASP non-membership" "$WASM_DIR/asp_non_membership.wasm"
Save-Deployment
Invoke-Contract $deployment.asp_non_membership initialize --admin $ADMIN | Out-Null

$deployment.pool = Deploy-Contract "XLM pool" "$WASM_DIR/vayyl_pool.wasm"
Save-Deployment
Invoke-Contract $deployment.pool initialize `
    --admin $ADMIN `
    --asset $XLM_SAC `
    --verifier $deployment.verifier `
    --membership $deployment.asp_membership `
    --non_membership $deployment.asp_non_membership | Out-Null

$env:VERIFIER_ID = $deployment.verifier
$env:STELLAR_NETWORK = $NETWORK
$env:STELLAR_SOURCE = $SOURCE
$env:REGISTER_VAULT_ONLY = "1"
pnpm exec node scripts/register_vks.js
if ($LASTEXITCODE -ne 0) { throw "Vault verification-key registration failed." }
$deployment.registered_circuits = @("Deposit", "Withdraw")

$depositVk = (Invoke-Contract $deployment.verifier has_vk --circuit_id '{"Deposit":[]}').ToString().Trim().Trim('"')
$withdrawVk = (Invoke-Contract $deployment.verifier has_vk --circuit_id '{"Withdraw":[]}').ToString().Trim().Trim('"')
$leafCount = (Invoke-Contract $deployment.pool get_leaf_count).ToString().Trim().Trim('"')
if ($depositVk -ne 'true' -or $withdrawVk -ne 'true') { throw "Verifier read-back failed." }
if ($leafCount -ne '0') { throw "Fresh pool leaf count is not zero: $leafCount" }

$deployment.verified_at = (Get-Date).ToUniversalTime().ToString("o")
Save-Deployment
Write-Host "Vault v1 deployment complete: $DEPLOY_FILE"
