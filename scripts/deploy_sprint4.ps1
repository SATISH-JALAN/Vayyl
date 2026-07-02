$ErrorActionPreference = "Stop"

# ═══════════════════════════════════════════════════════════════
# Sprint 4 — Deploy & Test Position Lifecycle on Testnet
# ═══════════════════════════════════════════════════════════════
#
# Deploys: MockOracle, Groth16Verifier, PositionManager, LiquidationEngine
# Initializes all contracts with cross-references
# Registers VKs for Sprint 4 circuits (if available)
# Tests: open_position → attest_health → close_or_modify
#
# Prerequisites:
#   - `stellar` CLI installed and configured for testnet
#   - Contracts built (run `stellar contract build` in contracts/)
#   - Circuit VKs generated (run compile_all.ps1 in circuits/)
#
# Usage: Run from project root
#   powershell -File scripts/deploy_sprint4.ps1
# ═══════════════════════════════════════════════════════════════

$NETWORK = "testnet"
$SOURCE = "default"

Write-Host "=== Sprint 4 Deploy & Test ===" -ForegroundColor Cyan
Write-Host ""

# ─────────────────────────────────────────────────
# 1. Deploy Contracts
# ─────────────────────────────────────────────────
Write-Host "1. Deploying contracts to $NETWORK..." -ForegroundColor Yellow

$WASM_DIR = "contracts/target/wasm32-unknown-unknown/release"

# Deploy MockOracle
Write-Host "  Deploying MockOracle..."
$MOCK_ORACLE_ID = stellar contract deploy `
    --wasm "$WASM_DIR/vayyl_mock_oracle.wasm" `
    --source $SOURCE `
    --network $NETWORK 2>&1
Write-Host "  MockOracle: $MOCK_ORACLE_ID" -ForegroundColor Green

# Deploy Groth16Verifier
Write-Host "  Deploying Groth16Verifier..."
$VERIFIER_ID = stellar contract deploy `
    --wasm "$WASM_DIR/groth16_verifier.wasm" `
    --source $SOURCE `
    --network $NETWORK 2>&1
Write-Host "  Groth16Verifier: $VERIFIER_ID" -ForegroundColor Green

# Deploy LiquidationEngine
Write-Host "  Deploying LiquidationEngine..."
$LIQUIDATION_ID = stellar contract deploy `
    --wasm "$WASM_DIR/liquidation_engine.wasm" `
    --source $SOURCE `
    --network $NETWORK 2>&1
Write-Host "  LiquidationEngine: $LIQUIDATION_ID" -ForegroundColor Green

# Deploy PositionManager
Write-Host "  Deploying PositionManager..."
$POSITION_MGR_ID = stellar contract deploy `
    --wasm "$WASM_DIR/position_manager.wasm" `
    --source $SOURCE `
    --network $NETWORK 2>&1
Write-Host "  PositionManager: $POSITION_MGR_ID" -ForegroundColor Green

Write-Host ""

# ─────────────────────────────────────────────────
# 2. Initialize Contracts
# ─────────────────────────────────────────────────
Write-Host "2. Initializing contracts..." -ForegroundColor Yellow

# Get source address
$SOURCE_ADDR = stellar keys address $SOURCE 2>&1

# Initialize Groth16Verifier
Write-Host "  Initializing Groth16Verifier..."
stellar contract invoke `
    --id $VERIFIER_ID `
    --source $SOURCE `
    --network $NETWORK `
    -- initialize `
    --admin $SOURCE_ADDR 2>&1 | Out-Null
Write-Host "  Groth16Verifier initialized" -ForegroundColor Green

# Initialize MockOracle with test price
Write-Host "  Setting MockOracle price..."
stellar contract invoke `
    --id $MOCK_ORACLE_ID `
    --source $SOURCE `
    --network $NETWORK `
    -- set_price `
    --price 2000 `
    --timestamp 1720000000 2>&1 | Out-Null
Write-Host "  MockOracle price set to 2000" -ForegroundColor Green

# Initialize LiquidationEngine
Write-Host "  Initializing LiquidationEngine..."
stellar contract invoke `
    --id $LIQUIDATION_ID `
    --source $SOURCE `
    --network $NETWORK `
    -- initialize `
    --position_manager $POSITION_MGR_ID `
    --verifier $VERIFIER_ID `
    --grace_period 3600 2>&1 | Out-Null
Write-Host "  LiquidationEngine initialized (grace: 3600s)" -ForegroundColor Green

# Initialize PositionManager
Write-Host "  Initializing PositionManager..."
stellar contract invoke `
    --id $POSITION_MGR_ID `
    --source $SOURCE `
    --network $NETWORK `
    -- initialize `
    --verifier $VERIFIER_ID `
    --oracle $MOCK_ORACLE_ID `
    --liquidation_engine $LIQUIDATION_ID 2>&1 | Out-Null
Write-Host "  PositionManager initialized" -ForegroundColor Green

Write-Host ""

# ─────────────────────────────────────────────────
# 3. Register Verification Keys (if available)
# ─────────────────────────────────────────────────
Write-Host "3. Registering verification keys..." -ForegroundColor Yellow

$VK_DIR = "circuits/build/vkey"
$circuits = @(
    @{ name = "position_open"; id = "PositionOpen" },
    @{ name = "position_health"; id = "PositionHealth" },
    @{ name = "position_close"; id = "PositionClose" },
    @{ name = "liquidation_heartbeat"; id = "LiquidationHeartbeat" }
)

foreach ($circuit in $circuits) {
    $vkFile = "$VK_DIR/$($circuit.name)_stellar_vkey.json"
    if (Test-Path $vkFile) {
        Write-Host "  Registering VK for $($circuit.id)..."
        $vkJson = Get-Content $vkFile -Raw | ConvertFrom-Json
        # TODO: Parse VK JSON and call set_vk with proper arguments
        # This requires the format_stellar_args.js output format
        Write-Host "    VK file found — manual registration needed" -ForegroundColor DarkYellow
    } else {
        Write-Host "  [SKIP] $($circuit.name) VK not found — compile circuits first" -ForegroundColor DarkGray
    }
}

Write-Host ""

# ─────────────────────────────────────────────────
# 4. Output Summary
# ─────────────────────────────────────────────────
Write-Host "=== Deployment Summary ===" -ForegroundColor Cyan
Write-Host "  MockOracle:        $MOCK_ORACLE_ID"
Write-Host "  Groth16Verifier:   $VERIFIER_ID"
Write-Host "  LiquidationEngine: $LIQUIDATION_ID"
Write-Host "  PositionManager:   $POSITION_MGR_ID"
Write-Host ""
Write-Host "All contracts deployed and initialized!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Compile circuits: cd circuits && powershell scripts/compile_all.ps1"
Write-Host "  2. Register VKs with the Groth16Verifier"
Write-Host "  3. Test full position lifecycle: open -> attest -> close"
