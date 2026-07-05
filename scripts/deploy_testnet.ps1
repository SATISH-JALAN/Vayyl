$ErrorActionPreference = "Stop"

$NETWORK = "testnet"
$SOURCE = "deployer"

Write-Host "Deploying Groth16 Verifier..."
$VERIFIER_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/groth16_verifier.wasm --network $NETWORK --source $SOURCE
Write-Host "Groth16 Verifier ID: $VERIFIER_ID"

# The verifier's set_vk is admin-gated (require_auth). It MUST be initialized with
# an admin before register_vks runs, or every VK registration fails Unauthorized.
Write-Host "Initializing verifier admin ($SOURCE)..."
$ADMIN = stellar keys address $SOURCE
stellar contract invoke --id $VERIFIER_ID --network $NETWORK --source $SOURCE -- initialize --admin $ADMIN

Write-Host "Deploying Mock Oracle..."
$ORACLE_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/vayyl_mock_oracle.wasm --network $NETWORK --source $SOURCE
Write-Host "Mock Oracle ID: $ORACLE_ID"

Write-Host "Setting Mock Oracle initial price ($2500 per ETH = 25000000000)..."
$TIMESTAMP = [int][double]::Parse((Get-Date (Get-Date).ToUniversalTime() -UFormat %s))
stellar contract invoke --id $ORACLE_ID --network $NETWORK --source $SOURCE -- set_price --price 25000000000 --timestamp $TIMESTAMP

Write-Host "Deploying Vayyl Pool..."
$POOL_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/vayyl_pool.wasm --network $NETWORK --source $SOURCE
Write-Host "Vayyl Pool ID: $POOL_ID"

Write-Host "Deploying Position Manager..."
$MANAGER_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/position_manager.wasm --network $NETWORK --source $SOURCE
Write-Host "Position Manager ID: $MANAGER_ID"

Write-Host "Registering native Testnet XLM token SAC..."
# For testnet XLM:
$TOKEN_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
Write-Host "Token ID (XLM): $TOKEN_ID"

Write-Host "Initializing Vayyl Pool..."
# NOTE (V1): the pool stores membership/non_membership addresses but never calls
# them in deposit/transfer/withdraw (verified against contracts/vayyl-pool/src/lib.rs) —
# the ASP root is a caller-supplied public input. So passing $VERIFIER_ID here is an
# inert placeholder for V1; wire the real ASPMembership/ASPNonMembership contracts
# before enabling ASP-gated flows.
# $ADMIN (the deployer) is now also the pool's upgrade admin — it can `upgrade()`
# the pool in place later to add ASP enforcement / execute_settlement without a
# new address or state migration.
stellar contract invoke --id $POOL_ID --network $NETWORK --source $SOURCE -- initialize --admin $ADMIN --asset $TOKEN_ID --verifier $VERIFIER_ID --membership $VERIFIER_ID --non_membership $VERIFIER_ID

Write-Host "Initializing Position Manager..."
# Manager init now takes: admin, verifier, oracle, liquidation_engine.
# No LiquidationEngine is deployed in this payment-vertical script yet, so its
# address is an inert placeholder ($VERIFIER_ID), mirroring the pool's ASP
# placeholders above. Wire the real LiquidationEngine before enabling positions.
stellar contract invoke --id $MANAGER_ID --network $NETWORK --source $SOURCE -- initialize --admin $ADMIN --verifier $VERIFIER_ID --oracle $ORACLE_ID --liquidation_engine $VERIFIER_ID

# Persist the freshly-minted contract IDs so register_vks.js (and the frontend/
# indexer) target THIS deploy's verifier instead of a stale hardcoded id.
Write-Host "Writing deployments/$NETWORK.json..."
New-Item -ItemType Directory -Force -Path "deployments" | Out-Null
$deployment = [ordered]@{
    network  = $NETWORK
    verifier = "$VERIFIER_ID".Trim()
    oracle   = "$ORACLE_ID".Trim()
    pool     = "$POOL_ID".Trim()
    manager  = "$MANAGER_ID".Trim()
    token    = "$TOKEN_ID".Trim()
}
$deployment | ConvertTo-Json | Set-Content -Path "deployments/$NETWORK.json" -Encoding utf8

# Register the V1 payment-core verification keys against the new verifier.
Write-Host "Registering V1 verification keys..."
$env:VERIFIER_ID = "$VERIFIER_ID".Trim()
$env:STELLAR_NETWORK = $NETWORK
$env:STELLAR_SOURCE = $SOURCE
node scripts/register_vks.js

Write-Host "Deployment completed successfully!"
