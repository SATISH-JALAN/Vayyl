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

Write-Host "Deploying ASP Membership..."
# Real ASPMembership so the pool can enforce deposit compliance (root-binding).
$ASP_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/asp_membership.wasm --network $NETWORK --source $SOURCE
Write-Host "ASP Membership ID: $ASP_ID"
Write-Host "Initializing ASP Membership admin ($SOURCE)..."
stellar contract invoke --id $ASP_ID --network $NETWORK --source $SOURCE -- initialize --admin $ADMIN

Write-Host "Deploying Vayyl Pool..."
$POOL_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/vayyl_pool.wasm --network $NETWORK --source $SOURCE
Write-Host "Vayyl Pool ID: $POOL_ID"

Write-Host "Deploying Position Manager..."
$MANAGER_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/position_manager.wasm --network $NETWORK --source $SOURCE
Write-Host "Position Manager ID: $MANAGER_ID"

Write-Host "Deploying Liquidation Engine..."
# Sprint D wired real fund movement: position close inserts the settled note into
# the pool tree, and reveal_and_seize pays seized collateral out of the pool — both
# via VayylPool.execute_settlement. PositionManager <-> LiquidationEngine reference
# each other, so deploy BOTH first (below), then initialize each with the other's id.
$LIQUIDATION_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/liquidation_engine.wasm --network $NETWORK --source $SOURCE
Write-Host "Liquidation Engine ID: $LIQUIDATION_ID"

Write-Host "Deploying Hidden Order Registry..."
# Sprint E wired real fund movement: a fired hidden order (HiddenOrderTrigger proof)
# releases the escrowed collateral out of the pool via VayylPool.execute_settlement.
$ORDER_REGISTRY_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/hidden_order_registry.wasm --network $NETWORK --source $SOURCE
Write-Host "Hidden Order Registry ID: $ORDER_REGISTRY_ID"

Write-Host "Deploying Agentic Settlement Hub..."
# Sprint E: an agent claims a quest reward (SealedOrder proof + fresh agent_nullifier),
# paid out of the pool via VayylPool.execute_settlement.
$AGENTIC_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/agentic_settlement_hub.wasm --network $NETWORK --source $SOURCE
Write-Host "Agentic Settlement Hub ID: $AGENTIC_ID"

Write-Host "Registering native Testnet XLM token SAC..."
# For testnet XLM:
$TOKEN_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
Write-Host "Token ID (XLM): $TOKEN_ID"

Write-Host "Initializing Vayyl Pool..."
# ASP membership is now ENFORCED: deposit() calls $ASP_ID.is_known_root(asp_root)
# and rejects any deposit whose asp_root isn't the trusted ASP root. So --membership
# must be the REAL ASPMembership ($ASP_ID), not a placeholder.
#   PREREQUISITE before live deposits work: (1) the admin must approve members via
#   `asp_membership insert_leaf` so the ASP tree is populated, and (2) the DApp
#   deposit flow must fetch the live ASP root + build a real membership path. Until
#   both are done, deposits against this pool will (correctly) fail compliance.
# --non_membership stays a placeholder ($VERIFIER_ID): non-membership is NOT enforced
# in V1 (needs a real sparse-tree circuit — see mainnet-plan §7 descope).
# $ADMIN (the deployer) is also the pool's upgrade admin — it can `upgrade()` the pool
# in place later (e.g. to add execute_settlement) without a new address or migration.
stellar contract invoke --id $POOL_ID --network $NETWORK --source $SOURCE -- initialize --admin $ADMIN --asset $TOKEN_ID --verifier $VERIFIER_ID --membership $ASP_ID --non_membership $VERIFIER_ID

Write-Host "Initializing Position Manager..."
# Manager init (Sprint D ABI): admin, verifier, oracle, liquidation_engine, pool.
# The real LiquidationEngine and Pool are now wired (positions settle through the
# pool's execute_settlement).
stellar contract invoke --id $MANAGER_ID --network $NETWORK --source $SOURCE -- initialize --admin $ADMIN --verifier $VERIFIER_ID --oracle $ORACLE_ID --liquidation_engine $LIQUIDATION_ID --pool $POOL_ID

Write-Host "Initializing Liquidation Engine..."
# Engine init (Sprint D ABI): admin, position_manager, verifier, pool, grace_period.
# grace_period 3600s = a position with no health attestation for an hour is stale.
stellar contract invoke --id $LIQUIDATION_ID --network $NETWORK --source $SOURCE -- initialize --admin $ADMIN --position_manager $MANAGER_ID --verifier $VERIFIER_ID --pool $POOL_ID --grace_period 3600

Write-Host "Initializing Hidden Order Registry..."
# Registry init (Sprint E ABI): admin, verifier. The pool is supplied per-order
# at commit time, so it isn't wired at init.
stellar contract invoke --id $ORDER_REGISTRY_ID --network $NETWORK --source $SOURCE -- initialize --admin $ADMIN --verifier $VERIFIER_ID

Write-Host "Initializing Agentic Settlement Hub..."
# Hub init (Sprint E ABI): admin, verifier. Pool supplied per-quest at create time.
stellar contract invoke --id $AGENTIC_ID --network $NETWORK --source $SOURCE -- initialize --admin $ADMIN --verifier $VERIFIER_ID

Write-Host "Allowlisting settlement authorities on the pool..."
# D1 security boundary: only admin-approved contracts may call execute_settlement
# (move funds / insert notes). Authorize the manager (position close), the engine
# (liquidation seizure), the order registry (hidden-order execution), and the
# agentic hub (quest reward payout).
stellar contract invoke --id $POOL_ID --network $NETWORK --source $SOURCE -- add_settlement_authority --authority $MANAGER_ID
stellar contract invoke --id $POOL_ID --network $NETWORK --source $SOURCE -- add_settlement_authority --authority $LIQUIDATION_ID
stellar contract invoke --id $POOL_ID --network $NETWORK --source $SOURCE -- add_settlement_authority --authority $ORDER_REGISTRY_ID
stellar contract invoke --id $POOL_ID --network $NETWORK --source $SOURCE -- add_settlement_authority --authority $AGENTIC_ID

# Persist the freshly-minted contract IDs so register_vks.js (and the frontend/
# indexer) target THIS deploy's verifier instead of a stale hardcoded id.
Write-Host "Writing deployments/$NETWORK.json..."
New-Item -ItemType Directory -Force -Path "deployments" | Out-Null
$deployment = [ordered]@{
    network        = $NETWORK
    verifier       = "$VERIFIER_ID".Trim()
    oracle         = "$ORACLE_ID".Trim()
    pool           = "$POOL_ID".Trim()
    manager        = "$MANAGER_ID".Trim()
    liquidation    = "$LIQUIDATION_ID".Trim()
    order_registry = "$ORDER_REGISTRY_ID".Trim()
    agentic_hub    = "$AGENTIC_ID".Trim()
    asp_membership = "$ASP_ID".Trim()
    token          = "$TOKEN_ID".Trim()
}
$deployment | ConvertTo-Json | Set-Content -Path "deployments/$NETWORK.json" -Encoding utf8

# Register the V1 payment-core verification keys against the new verifier.
Write-Host "Registering V1 verification keys..."
$env:VERIFIER_ID = "$VERIFIER_ID".Trim()
$env:STELLAR_NETWORK = $NETWORK
$env:STELLAR_SOURCE = $SOURCE
node scripts/register_vks.js

Write-Host "Deployment completed successfully!"
