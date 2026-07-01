#!/bin/bash
# End-to-end setup and proof generation for a given circuit
set -e

CIRCUIT=$1

if [ -z "$CIRCUIT" ]; then
    echo "Usage: ./scripts/generate_test_proof.sh <circuit_name>"
    exit 1
fi

./scripts/setup.sh $CIRCUIT

echo "── Generating Witness ──"
node build/${CIRCUIT}_js/generate_witness.js build/${CIRCUIT}_js/${CIRCUIT}.wasm test/input_${CIRCUIT}.json build/${CIRCUIT}.wtns

echo "── Generating Proof ──"
snarkjs groth16 prove build/${CIRCUIT}_final.zkey build/${CIRCUIT}.wtns build/${CIRCUIT}_proof.json build/${CIRCUIT}_public.json

echo "── Verifying locally ──"
snarkjs groth16 verify build/${CIRCUIT}_vk.json build/${CIRCUIT}_public.json build/${CIRCUIT}_proof.json

echo "Done! Proof is in build/${CIRCUIT}_proof.json"
