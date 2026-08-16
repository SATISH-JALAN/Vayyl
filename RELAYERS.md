# Running a Vayyl relayer

A relayer pays transaction fees so a shielded spend does not need a funded Stellar account of its own. **It never holds note secrets and never takes custody.** That is what makes this worth opening up: more operators means more privacy for users, and no additional trust for anyone.

You do not need our permission to run one, and we cannot stop you. Registration below is a directory, not a gate.

## What the relayer does and does not know

It sees, because it must:

- the proof, the nullifier, the destination address, and the amount of a withdrawal
- the proof and both output commitments of a transfer, but **not the amounts** — those are encrypted to their owners and never appear in the call
- the IP address the request arrived from

It never sees:

- which note a spend consumes (that is what the proof hides)
- any note's blindness or spend key
- a user's balance

It cannot:

- redirect a payout. The recipient is bound into the proof, so altering it invalidates the proof.
- steal funds. It signs a transaction, it is not a party to it.
- forge a spend. It has no note secrets.

The honest residual risk is **correlation**: an operator sees which IP asked for which withdrawal. Run more than one relayer and let clients pick at random, which is exactly what the DApp does.

## Why a set exists at all

With a single relayer, every withdrawal in the system shares one fee-paying account. An observer clusters the entire user base by fee payer without touching the cryptography — the linkability the circuits remove at the protocol layer comes straight back at the network layer.

Three defences, all live:

| Weakness | Defence | Where |
|---|---|---|
| Shared fee payer | Client picks an operator uniformly at random per request | `frontend/src/dapp/lib/relayer-set.ts` |
| Fixed deposit-to-withdrawal gap | Randomised hold before submission | same |
| One transaction per withdrawal | Several withdrawals settled in one transaction | `withdraw_v3_batch` |

Selection is **uniform, not round-robin**. Any stateful policy is itself a pattern an observer can learn and undo; uniform selection has no state to learn.

## Batching, and why it lives in the contract

Soroban permits exactly **one** `InvokeHostFunction` operation per transaction. A two-operation transaction is rejected outright:

```
Transaction contains more than one operation
```

So the usual approach of bundling operations client-side is unavailable, and batching has to happen inside a contract call. `withdraw_v3_batch` takes up to 8 withdrawals and settles them in a single transaction, so an observer counting ledger entries can no longer count withdrawals.

**The batch is all-or-nothing on chain.** One bad proof reverts everyone else's withdrawal in it, which is a cheap way to grief the service. The relayer therefore simulates every request individually and drops the failures before assembling the batch. If you fork this, keep that.

## Setup

```bash
git clone https://github.com/SATISH-JALAN/Vayyl.git
cd Vayyl/backend/relayer
pnpm install
cp .env.example .env    # then edit
pnpm build && pnpm start
```

Minimum configuration:

```bash
RELAYER_SECRET=S...            # your own key, funded from Friendbot on testnet
ALLOWED_POOLS=CB6XFHGN4DMVEQRESJHPOUNYLUCGMOZTAIKTWH3I7KT3NVW2XY4NIOLC
RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
PORT=3002
```

Batching is **off by default**:

```bash
WITHDRAW_BATCH_WINDOW_MS=0     # 0 disables; try 15000-60000 once you have traffic
WITHDRAW_BATCH_MAX=8           # contract cap is 8
```

Off is the right default for a quiet service. Batching on a relayer handling one user at a time adds latency and mixes nothing. Turn it on when you can see traffic to mix with, and pick the window from that traffic rather than from this document.

**Do not run enrollment unless you intend to.** `ASP_ADMIN_SECRET` grants the power to add members to the approval set. Leave it unset and `/v2/enroll` returns 503 while relaying works normally. If you do set it, use a key whose *only* authority is `insert_leaf` — never a key that is also a contract admin.

## Verifying your instance

```bash
curl -s https://your-relayer.example/health
```

```json
{
  "status": "ok",
  "address": "G...",
  "nativeBalance": "9999.5",
  "enrollment": "disabled",
  "enrollmentAccess": "disabled",
  "batching": { "enabled": true, "windowMs": 30000, "maxPerBatch": 8 }
}
```

`/health` reports what your instance actually enforces, so clients and users can check rather than infer. Then confirm end to end: a withdrawal through your URL should land on chain and the recipient balance should change.

Keep the account funded. A relayer at zero balance fails every request, and clients treat a low balance as unhealthy and route elsewhere.

## The set

| Operator | URL | Contact | Batching |
|---|---|---|---|
| _(none yet — the first hosted instance goes here)_ | | | |

Clients configure their own set; this table is a convenience, not the source of
truth. `NEXT_PUBLIC_RELAYER_SET` accepts any comma-separated list, including one
that omits every entry above.

## Joining the set

1. Run an instance and confirm `/health`.
2. Open a pull request adding a row to the table above with your URL, operator name or handle, and a contact.
3. That is the whole process. There is nothing to approve.

There is no approval step, no key we issue, and no allowlist we hold. A set we alone controlled would not be decentralised in any sense that matters, so we deliberately have no mechanism to remove you. The corollary is that users choose their own set, and a relayer that behaves badly gets dropped from the lists people actually use.

## What a bad operator can and cannot do

Worth being concrete, since "trustless" gets asserted more often than it gets explained.

- **Refuse to submit.** Yes. The client picks another operator. This is why the set exists.
- **Log and correlate requests.** Yes, for requests it sees. Random selection limits any one operator to a fraction, and the randomised delay decorrelates timing.
- **Delay a submission to widen its own correlation window.** Yes. Clients should treat a slow operator as unhealthy.
- **Redirect a payout.** No. The recipient is bound into the proof.
- **Alter an amount.** No. Bound into the proof.
- **Steal a note.** No. It never sees note secrets.
- **Censor a specific user.** Only within its own share of traffic, and only for as long as that user keeps selecting it.

## Costs

Testnet XLM is free from Friendbot. Measured mainnet fees for comparison: a steady-state withdrawal is about `0.0274` XLM. A batch pays one transaction fee plus per-withdrawal execution, so batching lowers cost per withdrawal as well as improving privacy — but privacy is the reason it exists.
