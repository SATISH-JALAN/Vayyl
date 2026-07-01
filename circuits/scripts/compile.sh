#!/bin/bash
# ============================================================
# Circom Circuit Compilation Script
# ============================================================
# Compiles individual circuit library components for testing.
# Requires: circom (v2.1.x), snarkjs, node
# Run from the circuits/ directory.

set -e

CIRCUITS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$CIRCUITS_DIR/build"
LIB_DIR="$CIRCUITS_DIR/lib"
TEST_DIR="$CIRCUITS_DIR/test"

mkdir -p "$BUILD_DIR"

echo "=== Vayyl Circuit Compilation ==="
echo "Circuits dir: $CIRCUITS_DIR"
echo "Build dir: $BUILD_DIR"
echo ""

# Compile a single circuit
compile_circuit() {
    local name="$1"
    local input="$2"
    echo "── Compiling: $name ──"
    circom "$input" \
        --r1cs \
        --wasm \
        --sym \
        -o "$BUILD_DIR" \
        -l "$CIRCUITS_DIR/node_modules"
    echo "   R1CS: $BUILD_DIR/${name}.r1cs"
    echo "   WASM: $BUILD_DIR/${name}_js/"
    echo "   Constraints: $(snarkjs r1cs info "$BUILD_DIR/${name}.r1cs" 2>&1 | grep -o '[0-9]* constraints' || echo 'unknown')"
    echo ""
}

# Compile test wrapper circuits
if [ -f "$TEST_DIR/test_poseidon2_wrapper.circom" ]; then
    compile_circuit "test_poseidon2_wrapper" "$TEST_DIR/test_poseidon2_wrapper.circom"
fi

if [ -f "$TEST_DIR/test_note_wrapper.circom" ]; then
    compile_circuit "test_note_wrapper" "$TEST_DIR/test_note_wrapper.circom"
fi

if [ -f "$TEST_DIR/test_merkle_wrapper.circom" ]; then
    compile_circuit "test_merkle_wrapper" "$TEST_DIR/test_merkle_wrapper.circom"
fi

if [ -f "$TEST_DIR/test_range_check_wrapper.circom" ]; then
    compile_circuit "test_range_check_wrapper" "$TEST_DIR/test_range_check_wrapper.circom"
fi

echo "=== Compilation Complete ==="
