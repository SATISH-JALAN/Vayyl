# Vayyl

## Confidential settlement infrastructure for Stellar

Vayyl is a privacy-focused settlement application for Stellar Soroban. It uses shielded pools, commitments, nullifiers, Circom/Groth16 proofs, Poseidon2 hashing, and Soroban's native BN254 host functions so users and protocols can prove a settlement is valid without publishing the underlying amount, identity, or strategy.


## Traction & Empirical Verification

Vayyl is deployed and executing on Stellar Mainnet and Testnet today. All figures below are stated as of **14 August 2026** and are independently verifiable from on-chain contract addresses and the transaction ledger.

Across both networks, Vayyl has executed **153 verified contract invocations across 18 deployed contracts**. Every single invocation maps directly to a named protocol capability rather than generic infrastructure activity or filler.

| Metric | Mainnet (Live since 11 July 2026) | Testnet (3 Deployment Generations) | Combined Total |
| --- | --- | --- | --- |
| **Deployed Contracts** | 4 contracts | 14 contracts | **18 contracts** |
| **Verified Invocations** | 19 contract calls | 134 contract calls | **153 invocations** |
| **Active Wallets** | 1 wallet (bounded demo) | 9 wallets (team test accounts) | **10 wallets** |
| **Proving Mechanism** | Native Soroban BN254 Groth16 | Native Soroban BN254 Groth16 | **End-to-End ZK** |
| **Steady-State Deposit Fee** | `~0.0144 XLM` (143,769 - 143,894 stroops) | Sub-cent testnet execution | **Empirically measured** |
| **Steady-State Withdraw Fee** | `0.0274 XLM` (274,053 stroops) | Sub-cent testnet execution | **Deterministic cost** |

### Mainnet Execution & Empirical Proving Costs

Mainnet has been live since **11 July 2026** with 4 contracts deployed and operating:
* **Shielded Pool:** [`CB2NWPFWW5YLD6UYWR4RFERECSMBF6SB62P7RRP2LF2P2EMDSDLAZ3OW`](https://stellar.expert/explorer/public/contract/CB2NWPFWW5YLD6UYWR4RFERECSMBF6SB62P7RRP2LF2P2EMDSDLAZ3OW)
* **Groth16 / BN254 Verifier:** [`CATKJ2WBLQXGNVMGZ6E4JEZVTRMVJO2SKA3H7VH53TVD2HJPSBQ46MRD`](https://stellar.expert/explorer/public/contract/CATKJ2WBLQXGNVMGZ6E4JEZVTRMVJO2SKA3H7VH53TVD2HJPSBQ46MRD)
* **ASP Membership:** [`CBJWADSNYX52I6GEASN5P7MS6NWQ4O5WWQJOPTNSKCRHYTK2BYET6YB3`](https://stellar.expert/explorer/public/contract/CBJWADSNYX52I6GEASN5P7MS6NWQ4O5WWQJOPTNSKCRHYTK2BYET6YB3)
* **ASP Non-Membership:** [`CBJSFSZOEOEBSBTUZPTFZNAMP37PU7GKVFRERYSBTMYY7KPG6QKMAAQE`](https://stellar.expert/explorer/public/contract/CBJSFSZOEOEBSBTUZPTFZNAMP37PU7GKVFRERYSBTMYY7KPG6QKMAAQE)

**Execution & Cost Findings:**
* **19 verified contract invocations** covering the full shield and unshield cycle: 7 deposits and 5 withdrawals, each one a Groth16 proof verified on-chain through Stellar's native BN254 host functions.
* **Honesty Boundary:** This Mainnet deployment is a capped demonstration with a single active wallet under a single-party Phase-2 setup, deployed to prove that zero-knowledge verification executes on Stellar Mainnet inside the real resource budget at a real, measured cost.
* **Measured Fee Metrics:**
  * **First deposit:** `2,020,008 stroops` (~0.202 XLM) due to persistent storage initialization.
  * **Steady-state shielded deposit:** `143,769` to `143,894 stroops` (`~0.0144 XLM`).
  * **Steady-state withdrawal:** Exactly `274,053 stroops` (`0.0274 XLM`), identical across all five withdrawals (deterministic proof-verification cost).
* **Ecosystem Cost Benchmark:** These are the first published empirical costs of Groth16 verification on Stellar Mainnet. Compared to Nethermind's optimized Noir UltraHonk verification on Soroban at `0.09 XLM`, Vayyl's BN254 Groth16 verification costs are **3x to 6x lower**.

### Testnet Generations & 8 Live Protocol Capabilities

Testnet spans 3 deployment generations (9 July to 2 August 2026), with 14 contracts and 134 verified contract invocations from 9 distinct team-controlled test wallets.
* **Current Stack Pool:** [`CB6XFHGN4DMVEQRESJHPOUNYLUCGMOZTAIKTWH3I7KT3NVW2XY4NIOLC`](https://stellar.expert/explorer/testnet/contract/CB6XFHGN4DMVEQRESJHPOUNYLUCGMOZTAIKTWH3I7KT3NVW2XY4NIOLC) *(and Vault V2 fixed-note pool [`CBUNTVFHCNN5CYNA3TLTSWPVYX5ED5V6W6X3Y5EAHUOZYJRUPYNAX33A`](https://stellar.expert/explorer/testnet/contract/CBUNTVFHCNN5CYNA3TLTSWPVYX5ED5V6W6X3Y5EAHUOZYJRUPYNAX33A))*
* **Current Stack Verifier:** [`CBRMDGEMQERFTG3MCBHYPHMZPKVMDYFGHJAMREQW23ZDKVAMAFDRJ2J5`](https://stellar.expert/explorer/testnet/contract/CBRMDGEMQERFTG3MCBHYPHMZPKVMDYFGHJAMREQW23ZDKVAMAFDRJ2J5)

**Eight Distinct Capabilities Executed End-to-End On-Chain (Not in Simulation):**
1. **Shielded Deposit:** 15 testnet executions + 7 mainnet executions (22 total).
2. **Private Shielded-to-Shielded Transfer:** With ephemeral-key recipient discovery.
3. **Unshield to Arbitrary Recipient:** Relayer-submitted, with zero user address on-chain.
4. **ASP Compliance Enrollment:** 9 membership insertions.
5. **Private Position Open:** 5 executions.
6. **Private Health Attestation:** 4 executions against oracle price feeds.
7. **Completed Liquidation:** Two-phase settlement (`initiate_liquidation` followed by `reveal_and_seize`, with collateral moved).
8. **Hidden Conditional Order & Agentic Settlement:** Hidden conditional order committed, revealed, and executed; agentic settlement quest created and paid out.

### Engineering Validation & Security

* **106 Contract Unit Tests Pass:** Includes real-proof verification against registered on-chain verification keys.
* **Adversarial Security Suites:** Explicit tests against mutated public inputs, substituted nullifiers, tampered proofs, cross-circuit proof substitution, double-spend attempts, and the `gamma != delta` verification-key check (which prevents vulnerabilities that drained Veil Cash and FoomCash).
* **Soundness Audit & Continuous CI:** Internal architecture audit identified two soundness defects in the position circuits. Both are documented publicly and costed as funded work in Tranche 2, with Deliverable 2.4 wiring automated circuit analysis directly into continuous integration.

### Ecosystem Partnerships & Integrations

* **Tael Protocol & Trustline (SCF #44 Winner):** Partnered to launch an SDK widget integration, enabling native confidential settlement flows directly within partner DApps on Stellar.

### Independent Verification & Evidence

All figures are snapshots of an actively developed protocol regenerated directly from Stellar Horizon and [stellar.expert](https://stellar.expert).

* **Complete Transaction Evidence Ledger:** [Google Drive Evidence Folder](https://drive.google.com/drive/folders/1FnvSYiqEZ97zV_dEbVh4H1qMtTKeHpE7?usp=drive_link) — Contains all 153 transactions with transaction hashes, contract addresses, function names, timestamps, ledger sequences, fee breakdowns, and direct explorer links.
* **Updates & Community:** Follow protocol progress on X at [@Vayylstellar](https://x.com/Vayylstellar).


## Product surface

| Product area | User goal | Current release state |
| --- | --- | --- |
| **Shielded Vault** | Shield XLM into a private note and withdraw that exact note to a public Stellar address. | Mainnet V1 deployed; fixed-note V2 active on Testnet |
| **Private Positions** | Open, attest, and close positions without broadcasting collateral, size, or direction. | Contract/circuit implementation track; not deployed |
| **Conditional Settlement** | Commit hidden orders and execute them once a proved condition is met. | Contract/circuit implementation track; not deployed |
| **Liquidation protection** | Require health attestations and settle a position when a valid liquidation condition is proved. | Requires security redesign before deployment |
| **Agentic settlement** | Enable authorized reward and settlement claims for agent-driven workflows. | Contract implementation track; not deployed |
| **Compliance controls** | Prove membership or non-membership in an approval set without exposing identity. | Membership is live for the Vault release; broader flow is not deployed |

## System architecture

```text
Freighter + browser DApp
  ├─ derives a shielded identity locally
  ├─ generates Groth16 proofs in a Web Worker
  └─ submits signed Soroban transactions

Soroban contracts
  ├─ Groth16 verifier
  ├─ per-asset shielded pools and pool factory
  ├─ ASP membership / non-membership
  ├─ position manager and liquidation engine
  ├─ hidden order registry
  └─ agentic settlement hub

Supporting services
  ├─ indexer: public events, commitments, nullifiers → Postgres
  ├─ relayer: submits Vault V2 withdrawals from a separate Testnet account
  ├─ keeper: future liquidation / order automation
  ├─ oracle adapter: future price inputs
  └─ proof bridge: proof-format interoperability tooling
```

## Testnet Vault V2

The current `/app` interface targets the isolated Vault V2 Testnet deployment. V2 uses one fixed 1 XLM denomination, binds the recipient into every spend proof, and submits through a separate relayer account. The proof hides which eligible commitment authorizes a spend; the pool interaction, fixed amount, recipient, relayer, and timing remain public on Stellar's ledger.

Source of truth for these addresses is [`deployments/testnet-vault-v2.json`](deployments/testnet-vault-v2.json).

| Component | Contract / endpoint |
| --- | --- |
| Fixed-note XLM pool | [`CB6XFHGN4DMVEQRESJHPOUNYLUCGMOZTAIKTWH3I7KT3NVW2XY4NIOLC`](https://stellar.expert/explorer/testnet/contract/CB6XFHGN4DMVEQRESJHPOUNYLUCGMOZTAIKTWH3I7KT3NVW2XY4NIOLC) |
| Groth16 verifier | [`CBRMDGEMQERFTG3MCBHYPHMZPKVMDYFGHJAMREQW23ZDKVAMAFDRJ2J5`](https://stellar.expert/explorer/testnet/contract/CBRMDGEMQERFTG3MCBHYPHMZPKVMDYFGHJAMREQW23ZDKVAMAFDRJ2J5) |
| ASP membership | `CD5DLTOIEAYA6CATHKELFAYRBOEFQN5TMADCEAURVZMMTYVD6Y5POCMO` |
| ASP non-membership | `CAYNUQUPVQF7K35LG4VKNBFUHVULAKN27CDBP4N7EVXXEAGICWVYB4WD` |
| Indexer | not currently hosted — run locally (`backend/indexer`, port 3001) |
| Relayer | not currently hosted — run locally (`backend/relayer`, port 3002) |

Registered verification keys: `Deposit` (2 public inputs), `Withdraw` (3), `Transfer` (5), `RageQuit` (3).

The browser keeps proof generation in a Web Worker and supports encrypted, wallet-bound note backup/import.

### What this deployment does not claim

Stated plainly, because each of these is the kind of thing a reader would otherwise assume works:

- **The proving keys are not from a trusted ceremony.** They were produced by a single-machine Phase-2 setup, so whoever ran it could forge proofs. Fine for a testnet demo; not a basis for holding real value.
- **The approval set is an open allowlist, not a compliance control.** Anyone may enrol, subject to a rate limit and a leaf cap. It demonstrates the mechanism; it does not screen anyone. The relayer reports what it actually enforces at `/health` (`enrollmentAccess`).
- **There is no hosted indexer or relayer.** Both must be run locally. The wallet does not depend on the indexer for leaf ordering — see below.
- **The anonymity set is small.** With single-digit deposits, timing and amount correlation identify most spends regardless of the cryptography. `docs/vayyl-privacy-model.md` covers what is and is not hidden.

### Durability of the leaf set

Soroban RPC retains contract events for about 7 days, and this pool's deposits are already older than that. Leaf ORDERING is therefore shipped as a committed artifact, [`deployments/testnet-vault-v2-tree.json`](deployments/testnet-vault-v2-tree.json), rather than living only in an indexer database — losing it would make every note in the pool unspendable, not just a missing one.

The snapshot is verifiable without trusting us. Each leaf carries the hash of the transaction that created it, and the commitment is a call *argument* to `deposit_v2`/`transfer_v2`, so it can be re-read from Horizon's permanent history long after the events are gone. The ordered set must also reproduce the pool's own `get_root()`:

```bash
cd circuits && pnpm snapshot:verify
```

## Mainnet deployment

Vault v1 is the deployed foundation of the wider Vayyl application. It currently supports private XLM deposit and whole-note withdrawal while the broader application continues through staged Mainnet development.

| Component | Contract / endpoint |
| --- | --- |
| XLM shielded pool | [`CB2NWPFWW5YLD6UYWR4RFERECSMBF6SB62P7RRP2LF2P2EMDSDLAZ3OW`](https://stellar.expert/explorer/public/contract/CB2NWPFWW5YLD6UYWR4RFERECSMBF6SB62P7RRP2LF2P2EMDSDLAZ3OW) |
| Groth16 verifier | [`CATKJ2WBLQXGNVMGZ6E4JEZVTRMVJO2SKA3H7VH53TVD2HJPSBQ46MRD`](https://stellar.expert/explorer/public/contract/CATKJ2WBLQXGNVMGZ6E4JEZVTRMVJO2SKA3H7VH53TVD2HJPSBQ46MRD) |
| ASP membership | [`CBJWADSNYX52I6GEASN5P7MS6NWQ4O5WWQJOPTNSKCRHYTK2BYET6YB3`](https://stellar.expert/explorer/public/contract/CBJWADSNYX52I6GEASN5P7MS6NWQ4O5WWQJOPTNSKCRHYTK2BYET6YB3) |
| ASP non-membership | [`CBJSFSZOEOEBSBTUZPTFZNAMP37PU7GKVFRERYSBTMYY7KPG6QKMAAQE`](https://stellar.expert/explorer/public/contract/CBJSFSZOEOEBSBTUZPTFZNAMP37PU7GKVFRERYSBTMYY7KPG6QKMAAQE) |
| Native XLM SAC | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |
| Public indexer | [`vault-indexer-production.up.railway.app`](https://vault-indexer-production.up.railway.app/health) |

Deposit and Withdraw verification keys are registered in the deployed verifier. Artifact hashes and registration transactions are recorded in [`deployments/mainnet-vault-v1.json`](deployments/mainnet-vault-v1.json).

## Planned contract suite

The wider application is backed by the following in-repository modules. They are planned deployment candidates, not claims of live production availability.

| Contract | Role | Deployment prerequisite |
| --- | --- | --- |
| `vayyl-pool-factory` | Creates a dedicated shielded pool for each supported asset. | Asset policy, initialization review, staged deployment. |
| `position-manager` | Coordinates private position open, health-attestation, and close proofs. | End-to-end proof/balance testing and public-input review. |
| `liquidation-engine` | Handles settlement when a required position health attestation is missed. | Proof-bound payout redesign and adversarial tests. |
| `hidden-order-registry` | Stores commitments for sealed conditional orders. | Trigger-proof validation, keeper integration, execution tests. |
| `agentic-settlement-hub` | Supports authorized agent reward and settlement claims. | Claim authorization, economic rules, settlement tests. |
| `asp-non-membership` | Proves absence from a restricted compliance set. | Integration into a complete policy and circuit flow. |
| `vayyl-mock-token` | Development-only token support for local/test flows. | Replace with approved Mainnet assets. |

Before deployment, the future suite needs trusted-setup provenance, complete oracle/keeper behavior, liquidation payout binding, and full Mainnet integration testing.

## Repository layout

| Path | Contents |
| --- | --- |
| `frontend/` | Next.js and client-side React DApp (`/app`) |
| `contracts/` | Soroban contracts for the full Vayyl protocol surface |
| `circuits/` | Circom circuits, proving utilities, and verification-key tooling |
| `backend/indexer/` | Mainnet event indexer and read-only HTTP API |
| `backend/relayer/` | Optional fee-bump transaction submission service |
| `backend/keeper/` | Future order/liquidation automation service |
| `backend/oracle-adapter/` | Future external price-input adapter |
| `backend/proof-bridge/` | Rust proof-format interoperability tooling |
| `deployments/` | Public deployment manifests and artifact hashes |

## Run locally

Requirements: Node.js 20+, pnpm 9+, and Freighter configured for Stellar Testnet.

```powershell
cd frontend
pnpm install
Copy-Item .env.testnet .env.local
pnpm dev
```

Open `http://localhost:3000` for the product site and `http://localhost:3000/app?view=pool` for the live Vault flow.

The DApp keeps proof generation in a Web Worker. Do not put wallet seeds, recovery phrases, relayer secrets, database URLs, or private witness values in `.env.local`.

```powershell
cd frontend
pnpm typecheck
pnpm build

cd ../backend/indexer
pnpm test
```

## Deploy

### Frontend: Vercel

1. Import this repository in Vercel.
2. Set **Root Directory** to `frontend`.
3. Use `pnpm install` and `pnpm build`.
4. Copy public variables from [`frontend/.env.testnet`](frontend/.env.testnet) into Vercel's Production environment. Remove any older Mainnet overrides first.
5. Deploy from `main`.



### Indexer: Railway

[`backend/indexer/railway.toml`](backend/indexer/railway.toml) configures the current indexer service. Create a Railway Postgres service and `vault-indexer` service, then set:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
RPC_URL=https://stellar.api.onfinality.io/public
POOL_ADDRESS=CB2NWPFWW5YLD6UYWR4RFERECSMBF6SB62P7RRP2EMDSDLAZ3OW
RAILPACK_NODE_VERSION=22
```

Deploy from `backend/indexer`:

```powershell
railway up . --path-as-root --service vault-indexer --environment production
```

Set the generated Railway domain as `NEXT_PUBLIC_INDEXER_URL` in Vercel.

## Security and release boundary

- Vayyl is a Mainnet application under active development. Vault v1 is unaudited and must not be used as third-party custody infrastructure.
- Vault V2 is a separate Testnet validation deployment; its single-machine proving setup is not production-ready.
