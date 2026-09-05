#!/bin/bash
# Run the position-circuit soundness suite under WSL, where both circom and
# node live. `circom` is a Rust binary built locally (Smart App Control blocks
# unsigned locally-built exes on the Windows side), so the test harness -- which
# shells out to circom -- has to run here rather than against the Windows node.
set -e
export PATH="$HOME/.cargo/bin:/opt/node/bin:$PATH"
cd "$(dirname "$0")/.."
node scripts/position_circuits_test.mjs
