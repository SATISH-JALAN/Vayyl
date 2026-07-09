$ErrorActionPreference = "Stop"

$NETWORK = "testnet"
$SOURCE = "deployer"
$TX_DELAY_SEC = 3

function Wait-AfterTx { Start-Sleep -Seconds $TX_DELAY_SEC }

function Deploy-Contract {
    param([string]$WasmPath)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = & stellar contract deploy --wasm $WasmPath --network $NETWORK --source $SOURCE 2>&1
    $ErrorActionPreference = $prev
    if ($LASTEXITCODE -ne 0) { throw ($out | Out-String) }
    $id = ($out | Out-String).Trim() -split "`n" | Where-Object { $_ -match "^C[A-Z0-9]{55}$" } | Select-Object -Last 1
    if (-not $id) { throw "Unexpected deploy output: $($out | Out-String)" }
    Wait-AfterTx
    return $id.Trim()
}

function Invoke-Contract {
    param([string]$Id, [Parameter(ValueFromRemainingArguments = $true)][string[]]$InvokeArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & stellar contract invoke --id $Id --network $NETWORK --source $SOURCE -- @InvokeArgs 2>&1 | Out-Null
    $ErrorActionPreference = $prev
    if ($LASTEXITCODE -ne 0) { throw "invoke failed ($Id): $($InvokeArgs -join ' ')" }
    Wait-AfterTx
}

Write-Host "Deploying Groth16 Verifier..."
$VERIFIER_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/groth16_verifier.wasm"
Write-Host "Groth16 Verifier ID: $VERIFIER_ID"

Write-Host "Initializing verifier admin ($SOURCE)..."
$ADMIN = (stellar keys address $SOURCE).Trim()
Invoke-Contract $VERIFIER_ID initialize --admin $ADMIN

Write-Host "Deploying Mock Oracle..."
$ORACLE_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/vayyl_mock_oracle.wasm"
Write-Host "Mock Oracle ID: $ORACLE_ID"

Write-Host "Setting Mock Oracle initial price..."
$TIMESTAMP = [int][double]::Parse((Get-Date (Get-Date).ToUniversalTime() -UFormat %s))
Invoke-Contract $ORACLE_ID set_price --price 25000000000 --timestamp $TIMESTAMP

Write-Host "Deploying ASP Membership..."
$ASP_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/asp_membership.wasm"
Write-Host "ASP Membership ID: $ASP_ID"
Write-Host "Initializing ASP Membership admin ($SOURCE)..."
Invoke-Contract $ASP_ID initialize --admin $ADMIN

Write-Host "Deploying ASP Non-Membership..."
$ASP_NM_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/asp_non_membership.wasm"
Write-Host "ASP Non-Membership ID: $ASP_NM_ID"
Write-Host "Initializing ASP Non-Membership admin ($SOURCE)..."
Invoke-Contract $ASP_NM_ID initialize --admin $ADMIN

Write-Host "Deploying Vayyl Pool..."
$POOL_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/vayyl_pool.wasm"
Write-Host "Vayyl Pool ID: $POOL_ID"

Write-Host "Deploying Position Manager..."
$MANAGER_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/position_manager.wasm"
Write-Host "Position Manager ID: $MANAGER_ID"

Write-Host "Deploying Liquidation Engine..."
$LIQUIDATION_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/liquidation_engine.wasm"
Write-Host "Liquidation Engine ID: $LIQUIDATION_ID"

Write-Host "Deploying Hidden Order Registry..."
$ORDER_REGISTRY_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/hidden_order_registry.wasm"
Write-Host "Hidden Order Registry ID: $ORDER_REGISTRY_ID"

Write-Host "Deploying Agentic Settlement Hub..."
$AGENTIC_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/agentic_settlement_hub.wasm"
Write-Host "Agentic Settlement Hub ID: $AGENTIC_ID"

$TOKEN_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
Write-Host "Token ID (XLM): $TOKEN_ID"

Write-Host "Initializing Vayyl Pool..."
Invoke-Contract $POOL_ID initialize --admin $ADMIN --asset $TOKEN_ID --verifier $VERIFIER_ID --membership $ASP_ID --non_membership $ASP_NM_ID

Write-Host "Initializing Position Manager..."
Invoke-Contract $MANAGER_ID initialize --admin $ADMIN --verifier $VERIFIER_ID --oracle $ORACLE_ID --liquidation_engine $LIQUIDATION_ID --pool $POOL_ID

Write-Host "Initializing Liquidation Engine..."
Invoke-Contract $LIQUIDATION_ID initialize --admin $ADMIN --position_manager $MANAGER_ID --verifier $VERIFIER_ID --pool $POOL_ID --grace_period 3600

Write-Host "Initializing Hidden Order Registry..."
Invoke-Contract $ORDER_REGISTRY_ID initialize --admin $ADMIN --verifier $VERIFIER_ID

Write-Host "Initializing Agentic Settlement Hub..."
Invoke-Contract $AGENTIC_ID initialize --admin $ADMIN --verifier $VERIFIER_ID

Write-Host "Allowlisting settlement authorities on the pool..."
foreach ($auth in @($MANAGER_ID, $LIQUIDATION_ID, $ORDER_REGISTRY_ID, $AGENTIC_ID)) {
    Invoke-Contract $POOL_ID add_settlement_authority --authority $auth
}

Write-Host "Writing deployments/$NETWORK.json..."
New-Item -ItemType Directory -Force -Path "deployments" | Out-Null
$deployment = [ordered]@{
    network        = $NETWORK
    verifier       = $VERIFIER_ID
    oracle         = $ORACLE_ID
    pool           = $POOL_ID
    manager        = $MANAGER_ID
    liquidation    = $LIQUIDATION_ID
    order_registry = $ORDER_REGISTRY_ID
    agentic_hub    = $AGENTIC_ID
    asp_membership = $ASP_ID
    asp_non_membership = $ASP_NM_ID
    token          = $TOKEN_ID
}
[System.IO.File]::WriteAllText((Join-Path (Get-Location) "deployments/$NETWORK.json"), ($deployment | ConvertTo-Json))

Write-Host "Registering verification keys..."
$env:VERIFIER_ID = $VERIFIER_ID
$env:STELLAR_NETWORK = $NETWORK
$env:STELLAR_SOURCE = $SOURCE
pnpm exec node scripts/register_vks.js

Write-Host "Deployment completed successfully!"
