#!/bin/bash
# Compile the position circuits to R1CS + witness WASM.
#
# Split from the Phase-2 setup on purpose: circom runs under WSL (it is a Rust
# binary and Smart App Control blocks locally-built unsigned exes on the
# Windows side), while snarkjs runs on the Windows node install. See
# scripts/setup_positions.ps1 for the second half.
set -e
CIRCOM=${CIRCOM:-$HOME/.cargo/bin/circom}
cd "$(dirname "$0")/.."
mkdir -p build/r1cs build/wasm build/zkey build/vkey

for c in position_open position_close position_health; do
  echo "=== compiling $c ==="
  "$CIRCOM" "$c.circom" --r1cs --wasm -o build/
  mv "build/$c.r1cs" build/r1cs/
  mv "build/${c}_js/$c.wasm" build/wasm/
  rm -rf "build/${c}_js"
done
echo "done"
