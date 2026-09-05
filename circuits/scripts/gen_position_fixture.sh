#!/bin/bash
# Generate the on-chain position proof fixtures. Runs under WSL, where circom
# and node are both available.
set -e
export PATH="$HOME/.cargo/bin:/opt/node/bin:$PATH"
cd "$(dirname "$0")/.."
node scripts/gen_position_fixture.mjs
