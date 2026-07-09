$ErrorActionPreference = "Stop"

# Full registrable circuit set — must match scripts/register_vks.js (9 entries).
$CIRCUITS = @(
    "deposit", "transfer", "withdraw",
    "position_open", "position_health", "position_close",
    "liquidation_heartbeat", "hidden_order_trigger", "sealed_order"
)

New-Item -ItemType Directory -Force -Path "build\r1cs" | Out-Null
New-Item -ItemType Directory -Force -Path "build\wasm" | Out-Null
New-Item -ItemType Directory -Force -Path "build\zkey" | Out-Null
New-Item -ItemType Directory -Force -Path "build\vkey" | Out-Null
New-Item -ItemType Directory -Force -Path "ptau" | Out-Null

Write-Host "Checking for Powers of Tau file..."
if (Test-Path "ptau\pot16_final.ptau") {
    $PTAU = "ptau\pot16_final.ptau"
} elseif (Test-Path "ptau\powersOfTau28_hez_final_16.ptau") {
    $PTAU = "ptau\powersOfTau28_hez_final_16.ptau"
} else {
    Write-Host "Generating Powers of Tau 16 locally... (This will take a minute)"
    snarkjs powersoftau new bn128 16 ptau\pot16_0000.ptau -v
    snarkjs powersoftau contribute ptau\pot16_0000.ptau ptau\pot16_0001.ptau --name="First contribution" -v -e="some random text"
    snarkjs powersoftau prepare phase2 ptau\pot16_0001.ptau ptau\pot16_final.ptau -v
    Remove-Item "ptau\pot16_0000.ptau" -ErrorAction SilentlyContinue
    Remove-Item "ptau\pot16_0001.ptau" -ErrorAction SilentlyContinue
    $PTAU = "ptau\pot16_final.ptau"
}
Write-Host "Using ptau: $PTAU"

foreach ($circuit in $CIRCUITS) {
    Write-Host "======================================"
    Write-Host "Compiling $circuit.circom..."
    Write-Host "======================================"

    circom "$circuit.circom" --r1cs --wasm -o build\

    Move-Item -Force "build\$circuit.r1cs" "build\r1cs\"
    Move-Item -Force "build\${circuit}_js\$circuit.wasm" "build\wasm\"
    Remove-Item -Recurse -Force "build\${circuit}_js"

    Write-Host "Generating zkey for $circuit..."
    snarkjs groth16 setup "build\r1cs\$circuit.r1cs" $PTAU "build\zkey\${circuit}_0000.zkey"

    Write-Host "Contributing to phase 2..."
    snarkjs zkey contribute "build\zkey\${circuit}_0000.zkey" "build\zkey\${circuit}_final.zkey" --name="1st Contributor Name" -v -e="some random text"

    Write-Host "Exporting vkey..."
    snarkjs zkey export verificationkey "build\zkey\${circuit}_final.zkey" "build\vkey\${circuit}_vkey.json"

    Write-Host "Formatting vkey for Soroban..."
    pnpm exec node scripts\format_stellar_vk.js "build\vkey\${circuit}_vkey.json" > "build\vkey\${circuit}_stellar_vkey.json"

    Write-Host "$circuit successfully compiled and formatted!"
}

Write-Host "All circuits compiled."
