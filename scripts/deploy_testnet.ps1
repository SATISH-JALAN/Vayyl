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
    # Capture rather than discard. Piping to Out-Null threw away the CLI's own
    # explanation, so every failure arrived as "invoke failed" with no cause --
    # which is the difference between a one-line fix and an afternoon.
    $out = & stellar contract invoke --id $Id --network $NETWORK --source $SOURCE -- @InvokeArgs 2>&1
    $ErrorActionPreference = $prev
    if ($LASTEXITCODE -ne 0) {
        throw "invoke failed ($Id): $($InvokeArgs -join ' ')`n$($out | Out-String)"
    }
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

# SEP-40. `decimals` and `resolution` are advisory metadata; the price itself is
# in stroops of collateral per contract unit, which is what makes size * price
# come out in stroops and lets the settlement arithmetic stay integer.
Write-Host "Initializing Mock Oracle (SEP-40)..."
Invoke-Contract $ORACLE_ID initialize --admin $ADMIN --decimals 7 --resolution 60

# The asset key must match what PositionManager was initialized with, byte for
# byte. A mismatch is not an error anywhere: the manager looks up a slot that
# was never written and reads it as "no price published".
# PowerShell 5.1 strips the quotes when handing a JSON string to a native exe,
# so `--asset {"Other":"XLM"}` reaches the CLI as `{Other:XLM}` and is rejected
# with "Unknown case ... for Asset". Every argument has a `--<name>-file-path`
# variant that reads the JSON from disk instead, which no shell can mangle.
$ORACLE_ASSET_FILE = Join-Path $env:TEMP "vayyl_oracle_asset.json"
[System.IO.File]::WriteAllText($ORACLE_ASSET_FILE, '{"Other":"XLM"}')

Write-Host "Publishing an initial price (1 XLM per contract unit)..."
# The timestamp comes from the LEDGER, not from here -- see MockOracle::set_price.
Invoke-Contract $ORACLE_ID set_price --asset-file-path $ORACLE_ASSET_FILE --price 10000000

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

# The vault and the manager reference each other, so both are DEPLOYED before
# either is INITIALIZED. Deploying yields an address without running any
# constructor, which is what breaks the cycle.
Write-Host "Deploying Counterparty Vault..."
$VAULT_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/vayyl_counterparty_vault.wasm"
Write-Host "Counterparty Vault ID: $VAULT_ID"

Write-Host "Deploying Hidden Order Registry..."
$ORDER_REGISTRY_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/hidden_order_registry.wasm"
Write-Host "Hidden Order Registry ID: $ORDER_REGISTRY_ID"

Write-Host "Deploying Agentic Settlement Hub..."
$AGENTIC_ID = Deploy-Contract "contracts/target/wasm32v1-none/release/agentic_settlement_hub.wasm"
Write-Host "Agentic Settlement Hub ID: $AGENTIC_ID"

$TOKEN_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
Write-Host "Token ID (XLM): $TOKEN_ID"

# initialize_v2, NOT initialize. `initialize` leaves the pool in V1 mode, which
# sets no Denomination key -- and every user-facing money path checks for it:
# deposit_v2/v3, transfer_v2/v3, withdraw_v2/v3 and ragequit_v2 all fail with
# WrongPoolMode without it. A V1 pool can still receive settlement notes from
# the position manager, so a deploy would look successful and then strand every
# note it minted: provably owned, permanently unspendable. This is the M3
# blocker at the deployment layer, and `initialize` was how it got in.
Write-Host "Initializing Vayyl Pool (V2 mode)..."
Invoke-Contract $POOL_ID initialize_v2 --admin $ADMIN --asset $TOKEN_ID --verifier $VERIFIER_ID --membership $ASP_ID --non_membership $ASP_NM_ID

Write-Host "Initializing Counterparty Vault..."
Invoke-Contract $VAULT_ID initialize --admin $ADMIN --asset $TOKEN_ID --position_manager $MANAGER_ID

Write-Host "Initializing Position Manager..."
Invoke-Contract $MANAGER_ID initialize --admin $ADMIN --verifier $VERIFIER_ID --oracle $ORACLE_ID --oracle_asset-file-path $ORACLE_ASSET_FILE --liquidation_engine $LIQUIDATION_ID --pool $POOL_ID --vault $VAULT_ID

Write-Host "Initializing Liquidation Engine..."
Invoke-Contract $LIQUIDATION_ID initialize --admin $ADMIN --position_manager $MANAGER_ID --verifier $VERIFIER_ID --pool $POOL_ID --vault $VAULT_ID --grace_period 3600

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
    vault          = $VAULT_ID
    order_registry = $ORDER_REGISTRY_ID
    agentic_hub    = $AGENTIC_ID
    asp_membership = $ASP_ID
    asp_non_membership = $ASP_NM_ID
    token          = $TOKEN_ID
}
[System.IO.File]::WriteAllText((Join-Path (Get-Location) "deployments/$NETWORK.json"), ($deployment | ConvertTo-Json))

Write-Host ""
Write-Host "Deployed. Before positions can be opened, TWO things must still happen:" -ForegroundColor Yellow
Write-Host "  1. Fund the counterparty vault:" -ForegroundColor Yellow
Write-Host "     stellar contract invoke --id $VAULT_ID --network $NETWORK --source $SOURCE -- \" -ForegroundColor Yellow
Write-Host "       deposit_liquidity --lp <ADDRESS> --amount <STROOPS>" -ForegroundColor Yellow
Write-Host "     Until it holds capital, every open fails with InsufficientLiquidity --" -ForegroundColor Yellow
Write-Host "     which is correct: a position must not open unless its best case is funded." -ForegroundColor Yellow
Write-Host "  2. Keep the oracle fresh. Prices older than 300s are refused on-chain," -ForegroundColor Yellow
Write-Host "     so a one-off set_price stops working five minutes after this run." -ForegroundColor Yellow
Write-Host ""

Write-Host "Registering verification keys..."
$env:VERIFIER_ID = $VERIFIER_ID
$env:STELLAR_NETWORK = $NETWORK
$env:STELLAR_SOURCE = $SOURCE
pnpm exec node scripts/register_vks.js

Write-Host "Deployment completed successfully!"
