#!/usr/bin/env bash
# Build the Soroban contracts from WSL.
#
# Windows Smart App Control blocks cargo build-script executables under
# contracts/target (os error 4551), so `stellar contract build` cannot run on
# the Windows side at all. Same root cause as circom. The WSL toolchain has
# rust 1.98 with the wasm32v1-none target and the stellar CLI, so the build
# lives here.
set -euo pipefail
source "$HOME/.cargo/env" 2>/dev/null || true
cd /mnt/c/projects/Vaayyl/Vayyl/contracts
stellar contract build
echo "--- built artifacts ---"
ls -1 target/wasm32v1-none/release/*.wasm | xargs -n1 basename
