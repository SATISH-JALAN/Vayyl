pragma circom 2.1.0;

include "lib/note.circom";

// Vault V2 rage-quit: the public, unconditional exit.
// =====================================================
// A depositor whose nullifier lands on the ASP blocklist can no longer spend
// through `withdraw_v2` or `transfer_v2` — both reject blocked nullifiers before
// any state change. Without an escape hatch that is a permanent confiscation:
// the pool holds funds that nobody, including the pool's own admin, can ever
// release. This circuit is the escape hatch.
//
// The trade is privacy for liquidity, and it is deliberate. `commitment` is a
// PUBLIC input here, so exiting publicly names the exact deposit being spent and
// links it to the payout address. That is what keeps the blocklist meaningful:
// it can still deny an *anonymous* exit, it just cannot deny an exit outright.
// Anyone who rage-quits leaves a fully traceable trail — which is precisely the
// property a compliance story needs, and the opposite of a silent bypass.
//
// No Merkle proof is needed, unlike WithdrawV2. There is nothing to hide, and
// the pool already stores every deposited commitment under DataKey::Commitment,
// so it checks inclusion directly by key lookup — cheaper and simpler than
// re-proving a path the verifier could just look up.
//
// What this proves: the caller knows a (privKey, blindness) opening of a
// specific published commitment, and the nullifier is the one bound to it. It
// does NOT reveal privKey, which matters — a spend key is shared across all of a
// wallet's notes, so revealing it to exit one note would expose every other.
template RageQuitV2() {
    signal input commitment;
    signal input nullifier;
    signal input exit_binding;

    signal input privKey;
    signal input blindness;

    // Keep the recipient binding in the public Groth16 statement. Without a
    // constraint referencing it, circom drops the unused signal and the
    // verification key stops binding it — the payout address would then be
    // free for anyone relaying the proof to rewrite. Same pattern as WithdrawV2.
    signal exit_binding_sq <== exit_binding * exit_binding;

    // Note() re-derives the public key on BabyJubjub and recomputes both the
    // commitment and the nullifier from privKey, so the two === below are what
    // tie this proof to one specific on-chain deposit.
    component note = Note();
    note.privKey <== privKey;
    note.amount <== 10000000;
    note.blindness <== blindness;
    note.commitment === commitment;
    note.nullifier === nullifier;
}

component main { public [commitment, nullifier, exit_binding] } = RageQuitV2();
