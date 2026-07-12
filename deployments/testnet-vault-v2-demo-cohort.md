# Vault V2 Testnet cohort protocol

Vault V2 demonstrates cryptographic unlinkability: the withdrawal proof proves that an approved, unspent note exists without exposing which eligible commitment was used. It does not make Stellar's ledger private. The pool interaction, fixed 1 XLM denomination, recipient, relayer, and timing are public.

## Current boundary

The deployed Testnet pool includes deterministic scripted fixture commitments used during development. Do not present their count as a privacy or anonymity set. The browser-tested deposit and relayed withdrawal are recorded in `testnet-vault-v2-evidence.json`.

The current browser flow is configured for the approved Testnet identity at membership position 5. A multi-wallet cohort requires a later dynamic ASP-path integration; do not imply that arbitrary wallets can self-enrol today.

## Clean cohort procedure

1. Prepare at least eight independently controlled, funded Testnet wallets and obtain approval for each public enrollment handle.
2. Create one fresh 1 XLM V2 note per wallet, at naturally separated times. Preserve at least six unspent notes before recording any withdrawal.
3. Export encrypted note backups only to each wallet owner's local device. Never commit note files, shielded keys, signatures, witnesses, or wallet credentials.
4. For the recording wallet, withdraw its note after a time gap to a separately funded recipient through the relayer.
5. Record only public evidence: contract IDs, transaction hashes, commitment/nullifier counts, relayer address, and Explorer links. Add those to the deployment evidence JSON.

## Recording language

Say that the proof prevents the contract from learning *which eligible commitment* is redeemed. Do not claim hidden amounts, hidden recipients, hidden relayer activity, or a production anonymity set. This is an isolated Testnet validation deployment with a single-machine proving setup.
