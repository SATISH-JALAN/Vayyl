# Vayyl

## Confidential settlement infrastructure for Stellar

Vayyl is a privacy-focused settlement application for Stellar Soroban. It uses shielded pools, commitments, nullifiers, Circom/Groth16 proofs, Poseidon2 hashing, and Soroban's native BN254 host functions so users and protocols can prove a settlement is valid without publishing the underlying amount, identity, or strategy.


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

The current `/app` interface targets the isolated Vault V2 Testnet deployment. V2 uses one fixed 1 XLM denomination, binds the recipient into the withdrawal proof, and submits withdrawals through a separate relayer account. The proof hides which eligible commitment authorizes a withdrawal; the pool interaction, fixed amount, recipient, relayer, and timing remain public on Stellar's ledger.

| Component | Contract / endpoint |
| --- | --- |
| Fixed-note XLM pool | [`CBUNTVFHCNN5CYNA3TLTSWPVYX5ED5V6W6X3Y5EAHUOZYJRUPYNAX33A`](https://stellar.expert/explorer/testnet/contract/CBUNTVFHCNN5CYNA3TLTSWPVYX5ED5V6W6X3Y5EAHUOZYJRUPYNAX33A) |
| Groth16 verifier | [`CA7VKFZRWSYIZTW34QXQCQJGON5R4PQSJGTUKJQIHLCCUILVGRI55PEP`](https://stellar.expert/explorer/testnet/contract/CA7VKFZRWSYIZTW34QXQCQJGON5R4PQSJGTUKJQIHLCCUILVGRI55PEP) |
| ASP membership | `CCGQLQS5JZQWXG72FFPLM3PKPBPBAP636C7YSVTJY5VYA5UXGLR4Q4WZ` |
| ASP non-membership | `CD3HTYBLAQVGQQSTONHPS5PQ4G4Y7T7ZRHH7FJ776W46MS7HYP6YAANY` |
| Indexer | [`vault-v2-indexer-production.up.railway.app`](https://vault-v2-indexer-production.up.railway.app/health) |
| Relayer | [`vault-v2-relayer-production.up.railway.app`](https://vault-v2-relayer-production.up.railway.app/health) |

The browser keeps proof generation in a Web Worker and supports encrypted, wallet-bound note backup/import. Testnet proving keys were produced with a single-machine setup and are not a production trusted ceremony.

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
