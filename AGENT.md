# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What Vayyl is

A shielded-pool privacy protocol on Stellar/Soroban with ZK proofs. It supports private payments (deposit/transfer/withdraw), private *directional* derivative positions (open/health-attest/close), private liquidations, and hidden orders. The proving system is **Groth16 over BN254**, hashing is **Poseidon2 only**, and key-agreement uses **BabyJubjub**. Everything in the stack is locked to BN254/Circom compatibility end-to-end — do not introduce a second curve, hash, or proving system "just for one feature."

The authoritative spec is `docs/vayyl-system-design-COMPLETE (1).md` (read it before touching circuits or contracts) and progress is tracked in `docs/vayyl-build-checklist.md`. The two most load-bearing invariants:

- **Poseidon2 parameters must match exactly** between the Circom circuits and Soroban's native `poseidon2_hash` host function. A mismatch produces proofs that are internally valid but never verify on-chain — it fails silently, not loudly. The Rust side gets Poseidon2 from the local `rs-soroban-poseidon` crate.
- **Poseidon V1 is banned** (CVE-2026-32129). Never import `circomlib/circuits/poseidon.circom`. `circomlib` is used *only* for BabyJubjub point ops (`EscalarMul`, `BabyAdd`) and `Num2Bits` range checks.

## Repository layout

Monorepo, four independent toolchains — there is no single top-level build:

- `contracts/` — Cargo workspace, one crate per Soroban contract (`#![no_std]`). Nine core contracts plus `vayyl-types` (shared `CircuitId`/`VerificationKey`/`Groth16Proof`/`PositionState` structs) and mock token/oracle crates.
- `circuits/` — Circom source (`*.circom` at the top level) + `scripts/` for compile/setup/proof generation. Build artifacts land in `circuits/build/`.
- `backend/` — TypeScript services (`indexer`, `relayer`, `oracle-adapter`, `keeper`) plus the Rust `proof-bridge`. Each TS service is its own package.
- `frontend/` — Vite app. Two surfaces in one project: a GSAP marketing site (`src/main.ts`, `src/animations/`) and the DApp (`src/dapp/`, entry `src/dapp/main.tsx`, React + Zustand + Freighter).
- `rs-soroban-poseidon/` — vendored Poseidon2 crate, path-depended by the contracts.
- `scripts/` — testnet deploy + VK registration (mostly PowerShell; this project develops on Windows/WSL2).

## Contracts (Soroban / Rust)

Build and test from `contracts/`:

```bash
cargo test                              # all contract unit tests (native, uses soroban-sdk test env)
cargo test -p vayyl-pool                # single crate
cargo test -p groth16-verifier test_initialize   # single test
stellar contract build                  # produces wasm32v1-none release artifacts under contracts/target/
```

Tests use the `soroban-sdk` test environment and record `test_snapshots/` JSON — regenerated snapshots showing up in a diff are expected when contract behavior changes.

Architecture (see §3 of the system design for the full diagram):

- `VayylPoolFactory` deploys **one `VayylPool` per asset** (never a shared multi-asset pool — that would collapse all nullifiers/commitments into one storage namespace).
- `VayylPool` holds the Merkle tree (`TREE_DEPTH = 20`), nullifier set, and calls out to `Groth16Verifier`, `ASPMembership`, `ASPNonMembership`, and the asset's SAC. Merkle inserts touch only a **frontier array** (one sub-root per level), not every sibling — keeps per-tx storage cost flat.
- `Groth16Verifier` maps `CircuitId → VerificationKey` and calls native `bn254_*` host functions. It **must reject any VK where `gamma == delta`** (`Error::GammaEqualsDelta`) — this is the Veil Cash / FoomCash bug and the check is already wired; keep it.
- Positions use the **directional model** (`position_size`/`direction`/`entry_price`, PnL-aware health), *not* a CDP/collateral-debt model. `PositionManager` registers heartbeats with `LiquidationEngine`; a missed grace window lets a keeper `reveal_and_seize`.
- `CircuitId` variants in `vayyl-types` are the canonical circuit registry. Their enum order is the source of truth for the numeric IDs used when registering VKs on-chain (`scripts/register_vks.js`) — keep circuit names, `CircuitId`, and VK registration in sync.

Release profile is aggressive (`opt-level = "z"`, `lto`, `panic = "abort"`, `overflow-checks = true`) — don't rely on unwinding or loosen overflow checks.

## Circuits (Circom + snarkjs)

Run from `circuits/`. `compile_all.sh` compiles the current circuit set, runs a **single-party local Phase-2** (disclosed, not a real ceremony), exports each VK, and formats it for Soroban via `scripts/format_stellar_args.js`:

```bash
./scripts/compile_all.sh                # compile + setup + vkey export for all circuits
./scripts/setup.sh <circuit_name>       # Phase-2 setup for one already-compiled circuit
```

`compile_all.sh` downloads `powersOfTau28_hez_final_16.ptau` on first run; position circuits need this larger ptau (range checks + Poseidon hashes push constraint count up). Proof/witness generation helpers live in `scripts/` (`generate_inputs*.js`, `generate_position_inputs.js`, `test_sprint4_proofs.js`).

Circuit correctness rules that are non-negotiable (system design §2, checklist §6):
- Use `<==`/`===` (constraints), never `=` (assignment), on every hash and Merkle step — the Tornado Cash bug was exactly this.
- Range-check every signal before it enters a multiplication, sized to its real max width — not a circomlib default.
- Pin boolean selectors via a range check on the *selected value*, not just `D*(D-1)===0`. See `position_health.circom` for the selector-via-range-check pattern.
- Bind `fee`/`relayer`/`recipient` (or the position/order equivalent) into every circuit with external consequences — this is the front-running defense.

## Backend services

Each TS service (`backend/indexer`, `relayer`, `oracle-adapter`, `keeper`) is a standalone package:

```bash
pnpm install       # indexer/relayer/oracle-adapter use pnpm (pnpm-lock.yaml present)
pnpm dev           # tsx watch on src/index.ts
pnpm build         # tsc
pnpm test          # vitest (indexer, keeper)
```

- **indexer** — polls Stellar RPC for commitment/nullifier events and persists to Postgres (`src/schema.sql`), because RPC only retains events 7 days and shielded notes sit untouched far longer. This is required infrastructure, not optional.
- **relayer** — wraps a user's signed proof in a `FeeBumpTransactionEnvelope` and submits. **Stateless w.r.t. funds** — it pays fees, never holds note secrets or custody.
- **oracle-adapter** — validates SEP-40 (Reflector) prices with a staleness check. Note that staleness is only *one* of three required price defenses (circuit binding + staleness + liquid-asset-only policy); don't treat it as sufficient alone.
- **proof-bridge** (Rust) — converts snarkjs JSON proofs (`A∈G1, B∈G2, C∈G1`) into the raw binary format Soroban's native pairing functions expect. `cargo build` / `cargo run` from `backend/proof-bridge`.

## Frontend

```bash
cd frontend && pnpm install
pnpm dev          # vite dev server (marketing site + DApp)
pnpm build        # vite build
```

The DApp lives under `src/dapp/`: `store/` is Zustand state (wallet/pool/positions/toast), `lib/` holds crypto, Stellar interaction, storage, and `proof-worker.ts`. **Proof generation must stay in the Web Worker, never on the main thread** — iOS Safari kills workers over ~1–2GB, and desktop-fast circuits can fail to run at all on mobile. Wallet connection is Freighter (`@stellar/freighter-api`).

## Deployment

`scripts/deploy_testnet.ps1` deploys via `stellar contract deploy` against testnet (source account alias `deployer`), then `scripts/register_vks.js` registers each circuit's `*_stellar_vkey.json` with the on-chain `Groth16Verifier`. Confirm `gamma ≠ delta` in every VK before registering. Testnet → mainnet, in that order.

## Cross-cutting gotchas

- The proving pipeline (Circom → snarkjs → proof-bridge → on-chain verify) must be consistent end-to-end; a mismatch anywhere (wrong Poseidon2 params, wrong serialization) fails silently rather than erroring.
- Soroban persistent storage archives on TTL expiry — call `extend_contract_data_ttl_v2` on every persistent read/write, and handle the "note storage archived" case client-side with a restore step rather than failing.
- Don't hardcode a per-transaction footprint-entry limit or a Merkle depth derived from one — confirm current network limits (see `docs/network-limits.md`) before changing `TREE_DEPTH`.
- Some scripts are PowerShell (`.ps1`) and some `.sh` — this project targets Windows 11 host + WSL2. Prefer the shell that matches what you're driving.
