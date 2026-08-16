pragma circom 2.1.0;

include "lib/note.circom";
include "asp_membership.circom";

// Vault V3 deposit: arbitrary amount.
// ===================================
// DepositV2 hard-coded `note.amount <== 10000000`, so a pool could only ever
// hold 1 XLM notes. That is what confined the whole vertical to a single
// denomination: no matter how flexible a transfer circuit is, it can only move
// value that was shielded in the first place.
//
// `amount` is PUBLIC here, and deliberately so. A deposit moves tokens from a
// named Stellar account into the pool, and that transfer is visible on the
// ledger whatever the circuit does; pretending the amount is secret would buy
// nothing and cost the pool its ability to check that the note it records
// matches the tokens it received. Privacy begins at the transfer, where amounts
// are genuinely hidden. See docs/vayyl-privacy-model.md.
//
// Note() range-checks `amount` to 64 bits, which is what keeps a deposit from
// minting a note whose value wraps the field in a later balance equation.
//
// Public: [commitment, asp_root, amount]
template DepositV3(depth) {
    signal input commitment;
    signal input asp_root;
    signal input amount;

    signal input privKey;
    signal input blindness;
    signal input asp_pathElements[depth];
    signal input asp_pathIndices[depth];

    // Binds the recorded commitment to the amount the pool actually pulled: the
    // contract passes the same value to the token transfer and to this proof.
    component note = Note();
    note.privKey <== privKey;
    note.amount <== amount;
    note.blindness <== blindness;
    note.commitment === commitment;

    component asp = ASPMembership(depth);
    asp.pubX <== note.pubX;
    asp.pubY <== note.pubY;
    for (var i = 0; i < depth; i++) {
        asp.pathElements[i] <== asp_pathElements[i];
        asp.pathIndices[i] <== asp_pathIndices[i];
    }
    asp.root === asp_root;
}

component main { public [commitment, asp_root, amount] } = DepositV3(20);
