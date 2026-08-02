pragma circom 2.1.0;

include "lib/note.circom";
include "lib/merkle.circom";

// Vault V2 shielded transfer: 1-in / 1-out.
// ==========================================
// Spends one 1-XLM note and creates one 1-XLM note owned by the recipient.
// No value leaves the pool, so unlike WithdrawV2 there is no recipient/amount
// binding to compute — the output commitment IS the binding, and it sits in the
// public statement where a relayer cannot alter it without invalidating the
// proof.
//
// Value conservation is structural rather than arithmetic: both amounts are the
// constant 10,000,000 stroops, so there is no balance equation that can be
// unbalanced and no change note to construct.
//
// The relayer pays the transaction fee out of its own balance (exactly as it
// already does for WithdrawV2, which likewise takes no fee parameter), so no fee
// travels inside the note.
//
// Recipient discovery
// -------------------
// The sender draws a one-time scalar r, publishes R = r·G, and derives the
// output blindness from the ECDH shared secret S = r·PK_recipient:
//
//     blindness_out = Poseidon2(S.x, 0)
//
// The recipient recomputes S = spendKey·R and finds the note by trial-matching
// the commitment. That agreement is NOT proved here — doing so would require an
// in-circuit variable-base scalar multiplication for no soundness gain, since a
// sender who derives it wrongly only makes their own note undiscoverable.
//
// R is public regardless, because it must be bound. A relayer who could swap R
// in flight would leave the recipient unable to ever locate the note, destroying
// the 1 XLM permanently. Naming it as a public input makes any substitution
// invalidate the proof.
//
// Public: [root, nullifier, commitment_out, ephemeral_x, ephemeral_y]
template TransferV2(depth) {
    // ── public ────────────────────────────────────────────────
    signal input root;
    signal input nullifier;
    signal input commitment_out;
    signal input ephemeral_x;
    signal input ephemeral_y;

    // ── private ───────────────────────────────────────────────
    signal input privKey;                 // sender's spend key
    signal input blindness_in;            // blindness of the note being spent
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input out_pubX;                // recipient's public key
    signal input out_pubY;
    signal input blindness_out;           // = Poseidon2(S.x, 0), see above

    // ── spend side ────────────────────────────────────────────
    // Note() derives the public key from privKey (constraining it to [1, l), so
    // one note yields exactly one nullifier) and range-checks the amount.
    component note = Note();
    note.privKey <== privKey;
    note.amount <== 10000000;
    note.blindness <== blindness_in;
    note.nullifier === nullifier;

    component tree = MerkleProof(depth);
    tree.leaf <== note.commitment;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    tree.root === root;

    // ── create side ───────────────────────────────────────────
    // The recipient's key is a free witness: the sender does not hold its
    // private half. BabyCheck rejects a point that is not on the curve, which
    // would otherwise produce a commitment nobody can ever open — a silent burn
    // of 1 XLM. It does not prove subgroup membership; an on-curve,
    // off-subgroup key would still only burn the sender's own funds, and
    // checking it costs a scalar multiplication.
    component outKeyOnCurve = BabyCheck();
    outKeyOnCurve.x <== out_pubX;
    outKeyOnCurve.y <== out_pubY;

    component outNote = NoteCommitment();
    outNote.amount <== 10000000;
    outNote.pubX <== out_pubX;
    outNote.pubY <== out_pubY;
    outNote.blindness <== blindness_out;
    outNote.commitment === commitment_out;

    // ── ephemeral point ───────────────────────────────────────
    // Constrained rather than left dangling: an unconstrained public signal can
    // be optimised out of the R1CS, and this one must stay in the statement to
    // be tamper-evident. BabyCheck is the honest constraint to spend here —
    // it keeps the signals and rejects a malformed R at proving time.
    component ephOnCurve = BabyCheck();
    ephOnCurve.x <== ephemeral_x;
    ephOnCurve.y <== ephemeral_y;
}

component main {
    public [root, nullifier, commitment_out, ephemeral_x, ephemeral_y]
} = TransferV2(20);
