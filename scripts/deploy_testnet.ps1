$ErrorActionPreference = "Stop"

$NETWORK = "testnet"
$SOURCE = "deployer"

Write-Host "Deploying Groth16 Verifier..."
$VERIFIER_ID = stellar contract deploy --wasm contracts/target/wasm32v1-none/release/groth16_verifier.wasm --network $NETWORK --source $SOURCE
Write-Host "Groth16 Verifier ID: $VERIFIER_ID"

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
stellar contract invoke --id $POOL_ID --network $NETWORK --source $SOURCE -- initialize --asset $TOKEN_ID --verifier $VERIFIER_ID --membership $VERIFIER_ID --non_membership $VERIFIER_ID

Write-Host "Initializing Position Manager..."
# Assuming manager needs to be initialized with Verifier, Oracle
stellar contract invoke --id $MANAGER_ID --network $NETWORK --source $SOURCE -- initialize --verifier $VERIFIER_ID --oracle $ORACLE_ID

Write-Host "Deployment completed successfully!"
