# Finish a partial testnet deploy - fills missing oracle / ASP, inits pool + PM, wires authorities.
$ErrorActionPreference = "Stop"

$NETWORK = "testnet"
$SOURCE = "deployer"
$DEPLOY_FILE = Join-Path (Get-Location) "deployments/$NETWORK.json"

if (-not (Test-Path $DEPLOY_FILE)) {
    throw "Missing $DEPLOY_FILE - run deploy_testnet.ps1 first."
}

$d = Get-Content $DEPLOY_FILE -Raw | ConvertFrom-Json
$ADMIN = (stellar keys address $SOURCE).Trim()
$TOKEN_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

function Wait-AfterTx { Start-Sleep -Seconds 3 }

function Invoke-Contract {
    param([string]$Id, [Parameter(ValueFromRemainingArguments = $true)][string[]]$InvokeArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & stellar contract invoke --id $Id --network $NETWORK --source $SOURCE -- @InvokeArgs 2>&1 | Out-Null
    $ErrorActionPreference = $prev
    if ($LASTEXITCODE -ne 0) { throw "invoke failed ($Id): $($InvokeArgs -join ' ')" }
    Wait-AfterTx
}

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

function Deploy-IfMissing {
    param([string]$Name, [string]$Wasm, [string]$Current)
    if ($Current -and $Current.Trim().Length -gt 0) {
        Write-Host "$Name already set: $Current" -ForegroundColor Green
        return $Current.Trim()
    }
    Write-Host "Deploying $Name..." -ForegroundColor Yellow
    $id = Deploy-Contract $Wasm
    Write-Host "$Name ID: $id" -ForegroundColor Green
    return $id
}

$VERIFIER_ID = $d.verifier.Trim()
$POOL_ID = $d.pool.Trim()
$MANAGER_ID = $d.manager.Trim()
$LIQUIDATION_ID = $d.liquidation.Trim()
$ORDER_REGISTRY_ID = $d.order_registry.Trim()
$AGENTIC_ID = $d.agentic_hub.Trim()

if (-not $VERIFIER_ID -or -not $POOL_ID) {
    throw "deployments/$NETWORK.json missing verifier or pool."
}

$ORACLE_ID = Deploy-IfMissing "Mock Oracle" `
    "contracts/target/wasm32v1-none/release/vayyl_mock_oracle.wasm" $d.oracle

Write-Host "Setting oracle price..."
$TIMESTAMP = [int][double]::Parse((Get-Date (Get-Date).ToUniversalTime() -UFormat %s))
try {
    Invoke-Contract $ORACLE_ID set_price --price 25000000000 --timestamp $TIMESTAMP
} catch {
    Write-Host "Oracle set_price skipped: $_" -ForegroundColor DarkYellow
}

$ASP_ID = Deploy-IfMissing "ASP Membership" `
    "contracts/target/wasm32v1-none/release/asp_membership.wasm" $d.asp_membership

$ASP_NM_ID = Deploy-IfMissing "ASP Non-Membership" `
    "contracts/target/wasm32v1-none/release/asp_non_membership.wasm" $d.asp_non_membership

Write-Host "Initializing ASP Membership..."
try {
    Invoke-Contract $ASP_ID initialize --admin $ADMIN
} catch {
    Write-Host "ASP initialize skipped: $_" -ForegroundColor DarkYellow
}

Write-Host "Initializing ASP Non-Membership..."
try {
    Invoke-Contract $ASP_NM_ID initialize --admin $ADMIN
} catch {
    Write-Host "ASP non-membership initialize skipped: $_" -ForegroundColor DarkYellow
}

Write-Host "Initializing Vayyl Pool..."
try {
    Invoke-Contract $POOL_ID initialize --admin $ADMIN --asset $TOKEN_ID --verifier $VERIFIER_ID --membership $ASP_ID --non_membership $ASP_NM_ID
} catch {
    Write-Host "Pool initialize skipped: $_" -ForegroundColor DarkYellow
}

Write-Host "Initializing Position Manager..."
try {
    Invoke-Contract $MANAGER_ID initialize --admin $ADMIN --verifier $VERIFIER_ID --oracle $ORACLE_ID --liquidation_engine $LIQUIDATION_ID --pool $POOL_ID
} catch {
    Write-Host "Position Manager initialize skipped: $_" -ForegroundColor DarkYellow
}

Write-Host "Initializing Liquidation Engine..."
try {
    Invoke-Contract $LIQUIDATION_ID initialize --admin $ADMIN --position_manager $MANAGER_ID --verifier $VERIFIER_ID --pool $POOL_ID --grace_period 3600
} catch {
    Write-Host "Liquidation Engine initialize skipped: $_" -ForegroundColor DarkYellow
}

Write-Host "Wiring settlement authorities..."
foreach ($auth in @($MANAGER_ID, $LIQUIDATION_ID, $ORDER_REGISTRY_ID, $AGENTIC_ID)) {
    try {
        Invoke-Contract $POOL_ID add_settlement_authority --authority $auth
        Write-Host "  allowlisted $auth" -ForegroundColor Green
    } catch {
        Write-Host "  skip $auth : $_" -ForegroundColor DarkYellow
    }
}

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
[System.IO.File]::WriteAllText($DEPLOY_FILE, ($deployment | ConvertTo-Json))
Write-Host "Updated deployments/$NETWORK.json" -ForegroundColor Green

$envFile = Join-Path (Get-Location) "frontend/.env.testnet"
$envLines = @(
    "# Vayyl DApp - testnet (synced from deployments/testnet.json)",
    'VITE_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"',
    "VITE_RPC_URL=https://soroban-testnet.stellar.org",
    "",
    "VITE_POOL_XLM=$POOL_ID",
    "VITE_VERIFIER=$VERIFIER_ID",
    "VITE_TOKEN_XLM=$TOKEN_ID",
    "VITE_POSITION_MANAGER=$MANAGER_ID",
    "VITE_LIQUIDATION_ENGINE=$LIQUIDATION_ID",
    "VITE_ORDER_REGISTRY=$ORDER_REGISTRY_ID",
    "VITE_AGENTIC_HUB=$AGENTIC_ID",
    "VITE_ORACLE=$ORACLE_ID",
    "VITE_ASP_MEMBERSHIP=$ASP_ID",
    "VITE_ASP_NON_MEMBERSHIP=$ASP_NM_ID"
)
[System.IO.File]::WriteAllText($envFile, ($envLines -join "`n") + "`n")
Write-Host "Updated frontend/.env.testnet" -ForegroundColor Green
Write-Host "Done. Next: pnpm exec node scripts/asp_insert.js" -ForegroundColor Cyan
