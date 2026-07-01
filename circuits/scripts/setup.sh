#!/bin/bash
# ============================================================
# Circom Circuit Setup Script (Groth16)
# ============================================================
# Generates a trusted setup (Phase 1 & Phase 2) for a given circuit
# and exports the Verification Key (VK) and Solidity Verifier.
# 
# Usage: ./setup.sh <circuit_name>
# Example: ./setup.sh test_note
#
# Requires: snarkjs (v0.7.x)
# Run from the circuits/ directory.

set -e

if [ -z "$1" ]; then
    echo "Usage: ./setup.sh <circuit_name>"
    exit 1
fi

CIRCUIT_NAME="$1"
CIRCUITS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build"
PTAU_DIR="$CIRCUITS_DIR/ptau"

mkdir -p "$PTAU_DIR"
cd "$BUILD_DIR"

echo "=== Vayyl Circuit Setup: $CIRCUIT_NAME ==="

if [ ! -f "${CIRCUIT_NAME}.r1cs" ]; then
    echo "Error: ${CIRCUIT_NAME}.r1cs not found in $BUILD_DIR"
    echo "Did you run ./scripts/compile.sh first?"
    exit 1
fi

# 1. Phase 1: Powers of Tau (Generic setup)
# Only do this if we haven't generated a large enough ptau yet.
# For test circuits, depth 14 (16K constraints) is usually enough.
PTAU_FILE="$PTAU_DIR/powersOfTau28_hez_final_14.ptau"

if [ ! -f "$PTAU_FILE" ]; then
    echo "── Downloading pre-computed Powers of Tau (14) ──"
    # Download the official Hermez trusted setup file
    curl -o "$PTAU_FILE" https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_14.ptau
fi

# 2. Phase 2: Circuit-specific setup
echo "── Groth16 Setup (Phase 2) ──"
snarkjs groth16 setup "${CIRCUIT_NAME}.r1cs" "$PTAU_FILE" "${CIRCUIT_NAME}_0000.zkey"

# 3. Contribute to Phase 2 (simulate random entropy)
echo "── Groth16 Contribution ──"
echo "vayyl_entropy" | snarkjs zkey contribute "${CIRCUIT_NAME}_0000.zkey" "${CIRCUIT_NAME}_final.zkey" --name="1st Contributor Name" -v -e="random_text"

# 4. Export Verification Key
echo "── Exporting Verification Key ──"
snarkjs zkey export verificationkey "${CIRCUIT_NAME}_final.zkey" "${CIRCUIT_NAME}_vk.json"

echo "=== Setup Complete for $CIRCUIT_NAME ==="
echo "VK: $BUILD_DIR/${CIRCUIT_NAME}_vk.json"
