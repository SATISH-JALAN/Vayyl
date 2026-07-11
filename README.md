# Vayyl Vault v1

Private XLM deposits and whole-note withdrawals on Stellar Soroban, using client-side Groth16 proofs and native BN254 verification.

## Status

**Mainnet demo release.** Vault v1 is deployed and demonstrated end-to-end with a self-funded wallet. It is not audited and must not accept third-party or production funds.

The only active Mainnet feature is:

- Shield native XLM into one private note.
- Withdraw that exact unspent note to a public Stellar address.

Private positions, liquidations, hidden orders, relayer settlement, and agentic settlement are visible in the interface as roadmap/audit surfaces only. They are not live product flows.

## Mainnet evidence

| Component | Contract / endpoint |
| --- | --- |
| XLM pool | [`CB2NWPFWW5YLD6UYWR4RFERECSMBF6SB62P7RRP2LF2P2EMDSDLAZ3OW`](https://stellar.expert/explorer/public/contract/CB2NWPFWW5YLD6UYWR4RFERECSMBF6SB62P7RRP2LF2P2EMDSDLAZ3OW) |
| Groth16 verifier | [`CATKJ2WBLQXGNVMGZ6E4JEZVTRMVJO2SKA3H7VH53TVD2HJPSBQ46MRD`](https://stellar.expert/explorer/public/contract/CATKJ2WBLQXGNVMGZ6E4JEZVTRMVJO2SKA3H7VH53TVD2HJPSBQ46MRD) |
| ASP membership | [`CBJWADSNYX52I6GEASN5P7MS6NWQ4O5WWQJOPTNSKCRHYTK2BYET6YB3`](https://stellar.expert/explorer/public/contract/CBJWADSNYX52I6GEASN5P7MS6NWQ4O5WWQJOPTNSKCRHYTK2BYET6YB3) |
| ASP non-membership | [`CBJSFSZOEOEBSBTUZPTFZNAMP37PU7GKVFRERYSBTMYY7KPG6QKMAAQE`](https://stellar.expert/explorer/public/contract/CBJSFSZOEOEBSBTUZPTFZNAMP37PU7GKVFRERYSBTMYY7KPG6QKMAAQE) |
| Native XLM SAC | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |
| Public indexer | [`/health`](https://vault-indexer-production.up.railway.app/health) |

The deployed artifact hashes, verification-key registration transactions, and demo-only constraints are recorded in [`deployments/mainnet-vault-v1.json`](deployments/mainnet-vault-v1.json).

## How it works

1. Freighter signs a fixed local message to derive the user's shielded identity.
2. The browser Web Worker generates the deposit or withdrawal Groth16 proof; secret inputs never leave the browser.
3. Soroban verifies the proof and updates the XLM pool's Merkle tree/nullifier set.
4. The Railway indexer exposes public commitments and spent nullifiers for withdrawal-path reconstruction.

## Repository layout

| Path | Purpose |
| --- | --- |
| `frontend/` | Next.js marketing site and `/app` Vault v1 DApp |
| `contracts/` | Soroban contracts |
| `circuits/` | Circom circuits and proving scripts |
| `backend/indexer/` | Mainnet event indexer and read-only HTTP API |
| `deployments/` | Public deployment manifests and artifact hashes |
| `scripts/` | Contract deployment and verification-key registration helpers |

## Run locally

Requirements: Node.js 20+, pnpm 9+, and Freighter configured for Stellar Mainnet.

```powershell
cd frontend
pnpm install
Copy-Item .env.mainnet.example .env.local
pnpm dev
```

Open `http://localhost:3000` for the site or `http://localhost:3000/app?view=pool` for Vault v1.

The Mainnet example uses the hosted indexer. Do not put recovery phrases, secret keys, private witness values, or `wallet.env` files in `frontend/.env.local`.

Useful checks:

```powershell
cd frontend
pnpm typecheck
pnpm build

cd ../backend/indexer
pnpm test
```

## Deploy the frontend to Vercel

1. Push this repository and import it in Vercel.
2. Set the Vercel **Root Directory** to `frontend`.
3. Use `pnpm install` as the install command and `pnpm build` as the build command.
4. Copy the public values from [`frontend/.env.mainnet.example`](frontend/.env.mainnet.example) into Vercel's Production environment variables.
5. Deploy. Vercel hosts only the frontend; the indexer remains on Railway.

`NEXT_PUBLIC_*` values are public application configuration, not secrets. Do not configure wallet seeds, relayer secrets, database URLs, or provider API keys in Vercel.

## Deploy the indexer to Railway

The repository includes [`backend/indexer/railway.toml`](backend/indexer/railway.toml).

1. Create a Railway Postgres service and an empty `vault-indexer` service.
2. Set the indexer variables:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
RPC_URL=https://stellar.api.onfinality.io/public
POOL_ADDRESS=CB2NWPFWW5YLD6UYWR4RFERECSMBF6SB62P7RRP2EMDSDLAZ3OW
RAILPACK_NODE_VERSION=22
```

3. From `backend/indexer`, run:

```powershell
railway up . --path-as-root --service vault-indexer --environment production
```

4. Generate a Railway domain on port `8080`, verify `/health`, then set that URL as `NEXT_PUBLIC_INDEXER_URL` in Vercel.

The current demo indexer is hosted at `https://vault-indexer-production.up.railway.app`.

## Security and release boundaries

- Proof generation stays in a Web Worker; never move proving to the main thread.
- The current proving artifacts came from a single-party handover. They are suitable only for a hackathon demo, not a public custody product.
- Mainnet deployment used a self-funded wallet and a single enrolled ASP leaf. Do not enroll users or accept deposits without an independent review, multi-party trusted setup, circuit audit, and operational monitoring.
- Local secrets, build output, proving artifacts, handover material, CLI binaries, and runtime logs are ignored by Git.

## Demo

See [`DEMO_GUIDE.md`](DEMO_GUIDE.md) for the local recording flow. A completed transaction should be shown in Stellar Expert; only public transaction/contract data belongs in a recording.
