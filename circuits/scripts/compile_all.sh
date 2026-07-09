#!/bin/bash
set -e

# Compile all Vayyl circuits
# Note: Position circuits require a higher power of tau (e.g. 15 or 16) due to range checks and poseidon hashes.

# Full registrable circuit set = every circuit that gets a VK registered on-chain
# (matches the CIRCUITS map in scripts/register_vks.js, 9 entries). The Sprint E
# order circuits (hidden_order_trigger, sealed_order) MUST be here or a "regenerate
# all" run silently skips them and their registered VK goes stale vs the deployed
# proving key.
#   NOTE: asp_membership.circom is deliberately NOT here — it's a library template
#   (its `component main` is commented out) that is proven INSIDE deposit/withdraw
#   via include, never as a standalone proof. Listing it aborted this whole script
#   at "No main specified" under `set -e`, which is why circuits used to be compiled
#   one-by-one by hand.
CIRCUITS=("deposit" "transfer" "withdraw" "position_open" "position_health" "position_close" "liquidation_heartbeat" "hidden_order_trigger" "sealed_order")

mkdir -p build/r1cs build/wasm build/zkey build/vkey

# Any valid 2^16 phase-1 ptau works for these per-circuit Groth16 setups. Prefer a
# ptau already on disk (pot16_final.ptau from earlier runs) over re-downloading the
# ~75 MB hez file. All listed circuits fit under 2^16 constraints.
echo "Checking for Powers of Tau file..."
if [ -f ptau/pot16_final.ptau ]; then
    PTAU="ptau/pot16_final.ptau"
elif [ -f ptau/powersOfTau28_hez_final_16.ptau ]; then
    PTAU="ptau/powersOfTau28_hez_final_16.ptau"
else
    echo "Downloading Powers of Tau 16..."
    mkdir -p ptau
    curl -o ptau/powersOfTau28_hez_final_16.ptau https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_16.ptau
    PTAU="ptau/powersOfTau28_hez_final_16.ptau"
fi
echo "Using ptau: $PTAU"

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
    snarkjs groth16 setup "build/r1cs/$circuit.r1cs" "$PTAU" "build/zkey/${circuit}_0000.zkey"
    
    # 3. Contribute (Dummy for local testnet)
    echo "Contributing to phase 2..."
    snarkjs zkey contribute "build/zkey/${circuit}_0000.zkey" "build/zkey/${circuit}_final.zkey" --name="1st Contributor Name" -v -e="some random text"
    
    # 4. Export Verification Key
    echo "Exporting vkey..."
    snarkjs zkey export verificationkey "build/zkey/${circuit}_final.zkey" "build/vkey/${circuit}_vkey.json"

    # 5. Format vkey for Soroban contract
    # NOTE: use format_stellar_vk.js (emits the {alpha_g1,beta_g2,gamma_g2,delta_g2,ic}
    # JSON that register_vks.js consumes). format_stellar_args.js is a different,
    # 3-arg tool that prints CLI invoke commands — do NOT use it here.
    echo "Formatting vkey for Soroban..."
    node scripts/format_stellar_vk.js "build/vkey/${circuit}_vkey.json" > "build/vkey/${circuit}_stellar_vkey.json"

    echo "$circuit successfully compiled and formatted!"
done

echo "All circuits compiled."
