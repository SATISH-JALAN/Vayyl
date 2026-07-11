# Vayyl Mainnet Readiness Plan

Last reviewed: 2026-07-11

## Current verdict

**Mainnet demo status (2026-07-11):** the constrained `vayyl-vault-v1` XLM
deposit/whole-note-withdraw stack is deployed and recorded in
`deployments/mainnet-vault-v1.json`. Only the Deposit and Withdraw verification
keys are registered, and no settlement authorities are configured. This is a
self-funded hackathon demo deployment with single-party handover proving
artifacts; it is not approved for third-party funds.

**No-go for the full protocol on mainnet.** The recovered project builds and its current local test
suites pass, but it still contains testnet-only infrastructure, mock/fallback
price paths, incomplete keeper behavior, unproven deployment custody, and a
critical liquidation amount that is not bound to a proof.

The current `circuits/build` proving artifacts are suitable only for recovering
and testing the handed-over project. They must not become mainnet artifacts
without a documented production ceremony and independent review.

## Recovered baseline

- `circuits/build`: recovered compiler outputs and proving artifacts.
- `frontend/public/circuits`: 20 required WASM/zkey assets; all match the
  corresponding recovered build artifacts by SHA-256.
- `backend/.env.testnet`: recovered testnet configuration. It is not a mainnet
  configuration and must never be committed.
- `rs-soroban-poseidon`: recovered upstream checkout at Stellar commit
  `b4bf706b7d0d602f9389280d259c0fb9f19983bf` (`v26.0.0`), with only a local
  Soroban SDK manifest change.
- Rust contracts now use the official Git repository pinned to that exact
  commit; Cargo no longer depends on the ignored local checkout.
- The circuit constant-parity test uses a tracked, licensed snapshot of the
  exact upstream `params.rs`, so the full recovered checkout is no longer a
  build or test prerequisite.

## Confirmed baseline checks

- Circuits: Poseidon2 constants/differential tests and payment, order, position,
  health, close, and heartbeat constraint tests pass.
- Contracts: 77 unit/integration tests pass with the pinned Git dependency.
- Backend: indexer, relayer, oracle adapter, and keeper compile; existing
  indexer tests pass; keeper now has a strict stale-response parser test.
- Proof bridge: compiles and runs zero tests.
- Frontend: Next.js production build passes and exposes `/` and `/app`.
- Verification-key registration: all nine recovered keys load in dry-run mode.

Passing these checks establishes a recoverable test baseline, not production
security or mainnet readiness.

## Release-blocking findings

### P0: protocol and fund safety

1. **Liquidation payout is not proof-bound.**
   `liquidation-engine::reveal_and_seize` accepts `seize_amount` from the caller.
   The code explicitly states that this value is keeper-asserted. The only hard
   cap is the pool balance. A new liquidation/seizure circuit and public-input
   binding must constrain the exact payout before any public deployment.
2. **Production trusted setup is absent.**
   The handover contains zkeys but no acceptable Powers of Tau provenance,
   participant records, contribution transcripts, final beacon record, or
   reproducible artifact manifest. Run a new ceremony after circuits are frozen.
3. **The price path is test-only and fails open.**
   Deployment scripts install a mock oracle. The adapter can return a fabricated
   price when the oracle call fails, and the frontend also falls back to fixed
   prices. Mainnet must use an approved oracle with explicit freshness, decimal,
   asset, network, and failure semantics; every failure must be fail-closed.
4. **Position metadata is neither private nor event-integrity-bound.**
   `direction` and `size` are private circuit inputs inside the position
   commitment, but `open_position` also accepts separate caller values and emits
   them publicly. A caller can publish values different from those proved, and
   the indexer/UI trust the event. This both corrupts indexed state and conflicts
   with the confidential-position claim. Freeze the privacy model and either
   remove these event fields or bind any intended public fields into the proof.
5. **Close versus modify state is ambiguous.**
   The contract always writes a new position commitment, while the indexer marks
   every `PositionClose` event closed. Define and proof-bind an explicit terminal
   state, then make contract storage, events, indexer, and UI agree.
6. **Derivative profits have no funded counterparty.**
   `position_close` can create a withdrawal note for collateral plus positive
   PnL, but the protocol has no LP, matched counter-position, debt accounting, or
   loss waterfall funding that gain. A profitable position can therefore create
   an unbacked claim on the shared pool. The market and insolvency model must be
   specified before positions can hold real funds.
7. **Escrow proof recipients are not proof-bound.**
   Hidden-order execution accepts `meta_hash` and `recipient` independently, and
   quest claims reuse a commitment-opening proof that does not bind recipient or
   agent nullifier. Authentication alone does not stop a copied proof being
   submitted with the copier's own authenticated address. Bind every payout
   destination and nullifier to the proof or immutable pre-claim state.
8. **Position key ownership is explicitly deferred.**
   `position_open.circom` states that BabyJubJub public-key binding is deferred.
   This is unfinished cryptographic protocol work, not a deployment setting.

### P0: operational safety

9. **The keeper does not execute liquidation.**
   It checks `is_stale` and writes a local `seize_trigger_*.json` file. It does
   not perform commit/reveal, construct the liquidation proof, submit a seizure,
   handle retries/finality, or reconcile results.
10. **Mainnet deployment and custody do not exist.**
   Scripts are hardcoded to `testnet` and the `deployer` identity. There is no
   reviewed mainnet manifest, deterministic release process, multisig custody,
   role-transfer checklist, rollback/upgrade policy, or independently verified
   deployment record.
11. **Production artifact distribution is undefined.**
   The large zkeys/WASM build directory is ignored by Git. Publish immutable
   release artifacts with a signed SHA-256 manifest and verify those hashes in
   the frontend build and deployment gate.

### P1: service and client hardening

12. The proof bridge has no tests and currently panics on malformed shapes and
   field values. Add strict BN254 field validation and known proof byte-vector
   round trips shared with the frontend and Soroban verifier.
13. The relayer needs complete host-function rejection, fee policy, size and
    timeout limits, rate limiting, idempotency, abuse controls, metrics, and
    integration tests. It must never subsidize arbitrary operations.
14. The indexer starts within RPC retention and explicitly has no archive
    backfill. Add durable ingestion/backfill, reorg/duplicate handling,
    transactional cursor updates, health/lag metrics, and restore drills.
15. The frontend still reconstructs important position facts from localStorage,
    uses fixed blindings/fallback values in position flows, and assumes localhost
    services in places. Replace these with versioned encrypted state and explicit
    network configuration; add end-to-end recovery tests.
16. Audit TTL renewal for every persistent and instance entry. Some pool/ASP/
    position entries are extended, but coverage is not uniform across the
    verifier, liquidation, order, agentic, factory, authorization, and nullifier
    state.
17. Remove testnet defaults from every production process. A production binary
    must refuse to start if its network, contract IDs, oracle policy, database,
    or signing configuration is missing or inconsistent.

### P1: assurance and governance

18. Add CI for locked dependency installation, circuit tests, contract tests,
    WASM builds, backend tests/builds, frontend typecheck/build, artifact hashes,
    dependency/license review, and secret scanning.
19. Commission independent circuit and Soroban contract audits after the
    protocol freeze. Resolve all critical/high findings and rerun the audit on
    the final release commit and artifacts.
20. Define incident response, monitoring, alerting, relayer/keeper budgets,
    database backups, key rotation, emergency pause/upgrade procedure, and named
    owners with a tested escalation path.

## Execution phases

### Phase 0 — Reproducible repository and honest baseline

Status: **in progress**

- [x] Restore handover build artifacts and browser proving assets.
- [x] Verify all 20 browser assets against recovered build outputs.
- [x] Pin `soroban-poseidon` to the recovered official Git commit.
- [x] Remove the ignored checkout as a Cargo/test prerequisite.
- [x] Restore and run current contract, circuit, backend, proof-bridge, and
  frontend checks.
- [x] Fix the keeper stale-response false-positive and add a regression test.
- [x] Consume position collateral nullifiers in the pool's canonical nullifier
  set so a collateral note cannot also be withdrawn.
- [ ] Add a single repository verification command and CI workflow.
- [ ] Add proof-bridge validation tests and cross-language byte vectors.
- [ ] Replace all mock/fallback production behavior with explicit fail-closed
  configuration.
- [ ] Produce a machine-readable inventory of source versions and recovered
  artifact hashes.

Exit gate: a clean checkout can reproduce every non-ceremony build/test without
the handover directory, and no service silently enters test/mock behavior.

### Phase 1 — Protocol freeze and adversarial specification

- Specify assets, decimals, fee/PnL arithmetic, privacy guarantees, oracle
  semantics, position lifecycle, liquidation payout, and all public inputs.
- Redesign liquidation so payout and receiver authorization are proof/contract
  bound; add drain, replay, frontrun, stale/future price, and double-seize tests.
- Resolve public `direction`/`size` leakage and event mismatch.
- Resolve close/modify state semantics and indexer representation.
- Produce a repository-grounded threat model and test matrix.

Exit gate: reviewed protocol spec maps every value from private witness to
public input, contract argument, state transition, event, and payout.

### Phase 2 — Circuit freeze and production ceremony

- Implement the frozen circuits and differential/adversarial tests.
- Pin Circom/snarkjs/toolchain versions and make compilation reproducible.
- Obtain/verify an acceptable Powers of Tau source.
- Run a documented multi-party phase-2 ceremony with independent contributors
  and final beacon.
- Publish zkeys, WASM, vkeys, transcripts, tool versions, and signed hashes.
- Register the final verification keys on a fresh staging deployment and prove
  positive/negative round trips.

Exit gate: audited frozen circuits and independently verifiable ceremony record.

### Phase 3 — Contract and backend productionization

- Implement the safe settlement/liquidation design and complete TTL coverage.
- Replace mock token/oracle deployment paths with approved mainnet assets and
  oracle contracts.
- Complete keeper, relayer, indexer, and oracle services with durable retries,
  reconciliation, metrics, limits, and tests.
- Add upgrade compatibility tests and a controlled multisig governance path.

Exit gate: full end-to-end staging flows survive service restarts, RPC failures,
duplicate submissions, stale prices, and database restore.

### Phase 4 — Staging, audits, and operations

- Deploy a fresh testnet/staging stack from the release process.
- Run deposit, transfer, withdraw, position open/health/close, hidden order,
  agentic settlement, and liquidation with real receipts and balance checks.
- Run load, failure-injection, key-rotation, backup/restore, upgrade, and incident
  drills.
- Complete independent audits and remediate findings.

Exit gate: signed go/no-go review with no unresolved critical/high findings.

### Phase 5 — Mainnet deployment

- Create and verify the mainnet network/asset/contract manifest.
- Build release WASM and frontend from the audited commit; verify signed hashes.
- Deploy with the approved custody identity, initialize once, register final VKs,
  wire only reviewed settlement authorities, transfer roles to multisig, and
  remove deployer privileges where supported.
- Independently verify every contract ID, admin, code hash, VK hash, asset,
  oracle, authority, and frontend environment before enabling user flows.
- Start with conservative limits and monitored rollout gates.

Exit gate: on-chain verification checklist and live monitoring confirm the
audited configuration. Deployment alone is not evidence of readiness.

## Information still required from the previous developer

Ask for these if they exist; `circuits/build` and the Poseidon checkout do not
replace them:

1. Original ceremony transcripts, Powers of Tau filename/source/hash,
   contribution commands, participant attestations, and final beacon details.
2. Exact toolchain/container versions and commands used to compile every circuit
   and generate every zkey/WASM/vkey.
3. Deployment command logs/receipts and the final mapping of contract IDs, WASM
   hashes, administrators, settlement authorities, VK hashes, and network.
4. Source repository/commit history, CI configuration, audit reports, unresolved
   findings, and test evidence that were not included in this checkout.
5. Infrastructure definitions and ownership transfer for database, relayer,
   keeper, oracle, indexer, frontend hosting, domains, monitoring, and backups.
6. Key-custody and role-rotation records. Do not request private keys or seed
   phrases in the ZIP; request transfer/rotation through a secure channel.
7. Product/protocol specification for privacy guarantees, oracle choice,
   liquidation payout, fee/PnL units, supported assets, and emergency governance.

If the ceremony provenance in item 1 does not exist, treat the recovered zkeys
as test artifacts and plan a new ceremony rather than trying to reconstruct one.
