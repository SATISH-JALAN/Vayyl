#!/bin/bash
set -e

# Compile all Vayyl circuits
# Note: Position circuits require a higher power of tau (e.g. 15 or 16) due to range checks and poseidon hashes.

CIRCUITS=("deposit" "transfer" "withdraw" "asp_membership" "position_open" "position_health" "position_close")

mkdir -p build/r1cs build/wasm build/zkey build/vkey

echo "Checking for Powers of Tau file..."
if [ ! -f ptau/powersOfTau28_hez_final_16.ptau ]; then
    echo "Downloading Powers of Tau 16..."
    mkdir -p ptau
    curl -o ptau/powersOfTau28_hez_final_16.ptau https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_16.ptau
fi

for circuit in "${CIRCUITS[@]}"; do
    echo "======================================"
    echo "Compiling $circuit.circom..."
    echo "======================================"

    # 1. Compile to R1CS and WASM
    circom "$circuit.circom" --r1cs --wasm -o build/
    
    # Move R1CS and WASM to designated folders
    mv "build/$circuit.r1cs" build/r1cs/
    mv "build/${circuit}_js/$circuit.wasm" build/wasm/
    rm -rf "build/${circuit}_js"

    # 2. Setup (ZKey and VKey)
    echo "Generating zkey for $circuit..."
    snarkjs groth16 setup "build/r1cs/$circuit.r1cs" ptau/powersOfTau28_hez_final_16.ptau "build/zkey/${circuit}_0000.zkey"
    
    # 3. Contribute (Dummy for local testnet)
    echo "Contributing to phase 2..."
    snarkjs zkey contribute "build/zkey/${circuit}_0000.zkey" "build/zkey/${circuit}_final.zkey" --name="1st Contributor Name" -v -e="some random text"
    
    # 4. Export Verification Key
    echo "Exporting vkey..."
    snarkjs zkey export verificationkey "build/zkey/${circuit}_final.zkey" "build/vkey/${circuit}_vkey.json"

    # 5. Format vkey for Soroban contract
    echo "Formatting vkey for Soroban..."
    node scripts/format_stellar_args.js "build/vkey/${circuit}_vkey.json" > "build/vkey/${circuit}_stellar_vkey.json"

    echo "$circuit successfully compiled and formatted!"
done

echo "All circuits compiled."
