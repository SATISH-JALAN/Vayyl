<div align="center">

# 🛡️ Vayyl

### Confidential settlement layer for Stellar — private payments & private positions, verified on-chain with zero-knowledge proofs.

[![Network](https://img.shields.io/badge/network-Stellar%20Soroban-black)](https://stellar.org)
[![Proving System](https://img.shields.io/badge/ZK-Groth16%20%2F%20BN254-6f42c1)](https://docs.circom.io)
[![Hash](https://img.shields.io/badge/hash-Poseidon2-blue)](#)
[![Stellar CLI](https://img.shields.io/badge/stellar--cli-26.1.0-brightgreen)](#)
[![Status](https://img.shields.io/badge/status-testnet-orange)](#-project-status)

*Stellar's ledger is fully public — every amount, counterparty, and position is exposed.*
*Vayyl fixes that.*

</div>

---

## ✨ What is Vayyl?

**Vayyl** is a shielded-pool privacy protocol on **Stellar / Soroban**. It lets people, companies, and other protocols move value and hold positions **without exposing the amount, identity, or strategy** on Stellar's otherwise transparent public ledger — using zero-knowledge proofs verified **natively on-chain**.

The core insight driving the design: **payment privacy hides a transaction; position privacy hides a *decision*** — the output of research, timing, and conviction. Protecting that information asymmetry is why *private directional positions* are the headline product, with *private payments* as the proven foundation underneath.

**Why this is possible now:** Stellar's Protocol 25 (*X-Ray*) and Protocol 26 (*Yardstick*) moved **BN254 elliptic-curve operations** and **Poseidon2 hashing** into Soroban's native host layer. Vayyl's on-chain Groth16 verifier calls these `bn254_*` host functions directly — **no off-chain verifier, no bridge, no trusted operator.**

---

## 🔐 Features

| Category | Feature | Description |
|---|---|---|
| **Payments** | Private deposit / transfer / withdraw | Amount, sender, and receiver all hidden |
| **Positions** | Private directional positions | Size, direction, and entry hidden — provably solvent vs. a public oracle |
| **Positions** | Health attestation & liquidation | Periodic ZK health re-proof; keeper seizure on a missed grace window |
| **Orders** | Hidden conditional orders | Stop-loss / take-profit that fire without ever revealing the trigger price |
| **Compliance** | ASP membership layer | Prove "approved / not blocklisted" without revealing identity |
| **Compliance** | Viewing keys / selective disclosure | Reveal specific details to an auditor on demand — not to the public |
| **Integration** | Callable verifier + SDK | A ZK primitive other Soroban protocols build on directly |

> See [**Project Status**](#-project-status) for exactly what is live today vs. on the roadmap — no overclaiming.

---

## 🏗️ Architecture

Vayyl is **BN254 / Circom-compatible end to end** — one curve, one hash, one proving system across the whole stack.

```
                          ┌─────────────────────────────────────────────┐
                          │                 USER (browser)               │
                          │   Freighter wallet · Web-Worker ZK proving   │
                          └───────────────────────┬─────────────────────┘
                                                  │ signed proof
                    ┌─────────────────────────────┼──────────────────────────────┐
                    │                              │                              │
            ┌───────▼────────┐          ┌──────────▼─────────┐          ┌─────────▼────────┐
            │    RELAYER     │          │      INDEXER       │          │  ORACLE ADAPTER  │
            │ fee-bump submit│          │ events → Postgres  │          │  SEP-40 prices   │
            └───────┬────────┘          └──────────┬─────────┘          └─────────┬────────┘
                    │                              │                              │
                    │  invoke                      │ read                         │ price
        ┌───────────▼──────────────────────────────────────────────────────────────────────┐
        │                              STELLAR / SOROBAN                                     │
        │                                                                                    │
        │   ┌───────────────┐   ┌──────────────────┐   ┌────────────────┐   ┌────────────┐  │
        │   │ Groth16       │◄──│  VayylPool       │──►│ ASP Membership  │   │  Position  │  │
        │   │ Verifier      │   │  Merkle tree +   │   │ Non-Membership  │   │  Manager   │  │
        │   │ (bn254 hosts) │   │  nullifiers      │   └────────────────┘   └─────┬──────┘  │
        │   └───────────────┘   └────────┬─────────┘                              │         │
        │                                │  custody via                    ┌──────▼──────┐  │
        │                        ┌───────▼────────┐  Stellar Asset Contract │ Liquidation │  │
        │                        │   XLM / SAC    │                         │   Engine    │  │
        │                        └────────────────┘                         └─────────────┘  │
        └────────────────────────────────────────────────────────────────────────────────────┘
```

### The proving pipeline

```
Circom circuit  →  snarkjs (Groth16 witness + proof)  →  proof-bridge (Rust)  →  on-chain bn254 verify
   *.circom            proof.json (A,B,C)                  raw binary format         Groth16Verifier
```

Every stage must be byte-consistent. The **Poseidon2 parameters** in the Circom circuits match Soroban's native `poseidon2_hash` **exactly** — a mismatch produces proofs that are internally valid but never verify on-chain (it fails silently). This parity is differentially tested against the host's own vectors.

### The four toolchains

| Layer | Path | Stack | Role |
|---|---|---|---|
| **Contracts** | `contracts/` | Rust · Soroban SDK 26 (`#![no_std]`) | 9 core contracts: verifier, per-asset pool, ASP, positions, liquidation, orders |
| **Circuits** | `circuits/` | Circom · snarkjs | ZK circuits + Groth16 setup + proof generation |
| **Backend** | `backend/` | TypeScript · Rust | Indexer, relayer, oracle-adapter, keeper + proof-bridge |
| **Frontend** | `frontend/` | Next.js App Router · React · Zustand · GSAP | Marketing site + DApp (Freighter, Web-Worker proving) |

---

## 📁 Repository layout

```
vayyl/
├── contracts/            # Cargo workspace — one crate per Soroban contract (#![no_std])
│   ├── groth16-verifier/     #   BN254 Groth16 verifier (gamma ≠ delta guard)
│   ├── vayyl-pool/           #   Shielded pool: Merkle tree (depth 20) + nullifiers
│   ├── vayyl-pool-factory/   #   Deploys one pool per asset
│   ├── asp-membership/       #   Compliance: prove approved
│   ├── asp-non-membership/   #   Compliance: prove not blocklisted
│   ├── position-manager/     #   Directional positions (open / attest / close)
│   ├── liquidation-engine/   #   Heartbeat + forced-reveal liquidation
│   ├── hidden-order-registry/#   Sealed conditional orders
│   ├── agentic-settlement-hub/#  Confidential agent-payment settlement
│   └── vayyl-types/          #   Shared structs (CircuitId, VerificationKey, ...)
├── circuits/             # Circom sources (*.circom) + scripts/ + build/
├── backend/
│   ├── indexer/              # Polls RPC → decodes events → Postgres
│   ├── relayer/              # Wraps signed proofs in FeeBumpTransactionEnvelope
│   ├── oracle-adapter/       # Validates SEP-40 (Reflector) prices
│   ├── keeper/               # Liquidation / order keeper
│   └── proof-bridge/         # Rust: snarkjs JSON → raw binary for bn254 hosts
├── frontend/             # Next.js app — marketing route + DApp route
├── rs-soroban-poseidon/  # Vendored Poseidon2 crate (path dep of contracts)
├── scripts/              # Testnet deploy + VK registration (PowerShell / JS)
└── docs/                 # System design, build checklist, audits, plans
```

---

## ⚙️ Prerequisites

Install these once before cloning:

| Tool | Version | Used by | Install |
|---|---|---|---|
| **Rust** + `wasm32v1-none` | stable | contracts, proof-bridge | [rustup.rs](https://rustup.rs) → `rustup target add wasm32v1-none` |
| **Stellar CLI** | `26.1.0` | contracts build/deploy | `cargo install --locked stellar-cli@26.1.0` |
| **Node.js** | ≥ 20 | frontend, backend, circuit scripts | [nodejs.org](https://nodejs.org) |
| **pnpm** | ≥ 9 | frontend, backend | `npm install -g pnpm` *(the only npm command you need)* |
| **PostgreSQL** | ≥ 14 | indexer | [postgresql.org](https://postgresql.org) |
| **Circom** | ≥ 2.1 | circuits (only if rebuilding) | [docs.circom.io](https://docs.circom.io/getting-started/installation/) |
| **Freighter** | latest | DApp wallet | [freighter.app](https://www.freighter.app) (browser extension) |

> 💡 **This project targets Windows 11 + WSL2.** Some scripts are PowerShell (`.ps1`), some are Bash (`.sh`). Use the shell that matches the script you're running.

---

## 🚀 Clone & run locally

```bash
git clone https://github.com/<your-org>/vayyl.git
cd vayyl
```

> There is **no single top-level build** — this is a monorepo of four independent toolchains. Set up only the parts you need. **We use `pnpm`, never `npm`, for all JS/TS packages.**

### 1️⃣ Frontend (marketing site + DApp) — start here

The fastest way to see Vayyl. The DApp is pre-configured against the live testnet deployment.

```bash
cd frontend
pnpm install
cp .env.testnet .env.local    # use the live testnet contract IDs
pnpm dev                      # → http://localhost:3000
```

- **Marketing site:** `http://localhost:3000/`
- **DApp:** `http://localhost:3000/app` — connect Freighter (set it to **Testnet**), then try a deposit.

```bash
pnpm build        # production build
pnpm start        # serve the production build locally
```

> ⚠️ Proof generation runs in a **Web Worker** (never the main thread) — required so mobile Safari doesn't kill it. Keep it that way if you modify proving.

### 2️⃣ Contracts (Soroban / Rust)

```bash
cd contracts
cargo test                                  # all contract unit tests (native)
cargo test -p vayyl-pool                    # a single crate
cargo test -p groth16-verifier test_initialize   # a single test

stellar contract build                      # produces wasm32v1-none artifacts in target/
```

Built WASM lands in `contracts/target/wasm32v1-none/release/*.wasm`.

### 3️⃣ Circuits (Circom + snarkjs)

Only needed if you're changing circuits or regenerating proofs.

```bash
cd circuits
./scripts/compile_all.sh                    # compile + Phase-2 setup + export VKs (Bash/WSL2)
./scripts/setup.sh <circuit_name>           # Phase-2 setup for one already-compiled circuit

# Verify Poseidon2 circuit ↔ on-chain host parity (the most important test):
node scripts/poseidon2_diff.mjs
node scripts/payment_circuits_test.mjs      # deposit/withdraw witness cross-check
```

> `compile_all.sh` downloads `powersOfTau28_hez_final_16.ptau` on first run (needed for the larger position circuits).

### 4️⃣ Backend services

Each service is a standalone package. Copy its `.env.example` → `.env` and fill in the values.

**Indexer** (needs PostgreSQL):

```bash
# One-time: create the database and load the schema
createdb vayyl_indexer
psql vayyl_indexer -f backend/indexer/src/schema.sql

cd backend/indexer
pnpm install
cp .env.example .env           # set DATABASE_URL, RPC_URL, POOL_ADDRESS
pnpm dev                       # tsx watch → API on http://localhost:3001
pnpm test                      # vitest
```

**Relayer** (pays fees, never holds funds):

```bash
cd backend/relayer
pnpm install
cp .env.example .env           # set RELAYER_SECRET, ALLOWED_POOLS, RPC_URL
pnpm dev                       # → http://localhost:3002
```

**Oracle adapter** (SEP-40 / Reflector prices):

```bash
cd backend/oracle-adapter
pnpm install
cp .env.example .env           # set ORACLE_CONTRACT, RPC_URL
pnpm dev                       # → http://localhost:3003
```

**Proof bridge** (Rust — snarkjs JSON → raw binary):

```bash
cd backend/proof-bridge
cargo build
cargo run -- <proof.json> <output.bin>
```

#### Backend environment variables

| Service | Variable | Meaning |
|---|---|---|
| indexer | `DATABASE_URL` | Postgres connection string |
| indexer | `RPC_URL` | Soroban RPC endpoint |
| indexer | `POOL_ADDRESS` | Pool contract ID to index |
| indexer | `PORT` | API port (default `3001`) |
| relayer | `RELAYER_SECRET` | Relayer keypair secret (**never commit**) |
| relayer | `ALLOWED_POOLS` | Comma-separated allowed contract IDs |
| relayer | `NETWORK_PASSPHRASE` | e.g. `Test SDF Network ; September 2015` |
| relayer | `PORT` | API port (default `3002`) |
| oracle-adapter | `ORACLE_CONTRACT` | Reflector oracle contract ID |
| oracle-adapter | `PORT` | API port (default `3003`) |

---

## 🌐 Full local stack (DApp end-to-end)

To exercise a real deposit → withdraw locally against testnet:

```bash
# terminal 1 — indexer (with Postgres running)
cd backend/indexer && pnpm dev

# terminal 2 — relayer
cd backend/relayer && pnpm dev

# terminal 3 — frontend
cd frontend && pnpm dev
```

Then open `http://localhost:3000/app`, connect Freighter (Testnet), and deposit. The DApp proves in a Web Worker, submits via Soroban, and the indexer captures the commitment.

---

## 📦 Deployment (testnet)

```powershell
# From repo root (PowerShell), source account alias "deployer" must exist in Stellar CLI
./scripts/deploy_testnet.ps1        # deploys verifier + pool, writes deployments/testnet.json
node scripts/register_vks.js        # registers each circuit's VK with the on-chain verifier
```

Deployed contract IDs are written to `deployments/testnet.json` and mirrored into `frontend/.env.testnet`.

> 🔎 Every verification key **must** satisfy `gamma ≠ delta` before registration — the guard is wired in the verifier and the registration script. Confirm it stays green.

---

## 📊 Project status

Vayyl is **testnet-first**. Being honest about what works today:

| Area | State |
|---|---|
| ✅ **Private payments (deposit → withdraw)** | Working end-to-end — real ZK proof, Freighter sign, on-chain verify, indexed |
| ✅ **Poseidon2 circuit ↔ on-chain parity** | Differentially verified against the host's own test vectors |
| ✅ **Groth16 / BN254 verifier** | Sound, tested, `gamma ≠ delta` guard wired |
| 🟡 **Private positions & liquidation** | Contracts + circuits exist; fund-movement and a circuit hardening pass in progress |
| 🟡 **Compliance (ASP)** | Membership layer present; enforcement wiring in progress |
| 🔵 **Hidden orders · agentic settlement · SDK** | Roadmap |

Detailed audits and the build plan live in [`docs/`](docs/):
- `docs/vayyl-current-state-2026-07-05.md` — full done / partial / left audit
- `docs/vayyl-mainnet-deploy-plan.md` — deployment scope, cost, upgrade strategy
- `docs/vayyl-system-design-COMPLETE (1).md` — the authoritative technical spec
- `docs/vayyl-product-description (1).md` — what / why / for whom

---

## 🔒 Security notes

- **Poseidon V1 is banned** (CVE-2026-32129) — circuits use **Poseidon2 only**. `circomlib` is used solely for BabyJubjub point ops and range checks.
- The verifier **rejects any VK where `gamma == delta`** (the Veil Cash / FoomCash bug).
- `fee` / `relayer` / `recipient` are bound into every circuit with external consequences — the front-running defense.
- The relayer is **stateless w.r.t. funds** — it pays fees, never holds note secrets or custody.

This is early-stage, unaudited software. **Do not use with real funds on mainnet yet.**

---

## 📚 Further reading

- **Stellar Soroban** — https://developers.stellar.org/docs/build/smart-contracts
- **Circom** — https://docs.circom.io
- **Groth16 (snarkjs)** — https://github.com/iden3/snarkjs
- **Reflector (SEP-40 oracle)** — https://reflector.network

---

<div align="center">

**Built on Stellar. Locked to BN254 / Poseidon2 / BabyJubjub, end to end.**

</div>
