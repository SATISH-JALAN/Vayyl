pragma circom 2.1.0;

include "lib/note.circom";
include "lib/merkle.circom";

// Vault V3 shielded transfer: 2-in / 2-out, arbitrary amounts.
// ============================================================
// Replaces TransferV2, which was 1-in / 1-out with BOTH amounts hard-coded to
// 10,000,000 stroops. That made value conservation structural rather than
// arithmetic: there was no balance equation to satisfy because there was no
// freedom in the amounts, and consequently no way to pay anything other than
// exactly 1 XLM.
//
// Here the amounts are private free witnesses and conservation is a real
// constraint:
//
//     in_amount1 + in_amount2 === out_amount1 + out_amount2
//
// Everything below exists to make that one line mean what it appears to mean.
//
// Why not fixed denominations
// ---------------------------
// The obvious alternative is a set of 1 / 10 / 100 XLM pools. Rejected. Three
// pools is three anonymity sets instead of one, and at this stage splitting a
// single-digit crowd into thirds is not a privacy trade, it is a privacy
// deletion. It also puts a floor under linkability that no amount of later work
// removes: the denomination a user picks is public forever. Amount privacy comes
// from hiding the value inside one pool, which is what this circuit does.
//
// Overflow is the whole game
// --------------------------
// A balance equation over an unbounded field is not a balance equation. With
// amounts free to reach p-1, a prover could pick values that wrap the modulus
// and satisfy the sum while creating money from nothing. So every one of the
// four amounts is constrained to 64 bits BEFORE it participates: inputs via
// Note(), which range-checks internally, and outputs via explicit RangeCheck64
// below. Two 64-bit values sum to less than 2^65, which is nowhere near the
// BN254 modulus, so neither side can wrap. This is exactly the defect the
// retired V1 transfer carried (audit F10): it range-checked its outputs and its
// fee but not its inputs, and relied on an inductive argument that
// `execute_settlement` had already broken.
//
// Both outputs always exist
// -------------------------
// Even an exact payment with no change emits two commitments. The count of
// outputs is public, so making it vary with whether change was needed would
// leak whether the sender spent their balance exactly. Every transfer has the
// same shape.
//
// Both outputs carry an ephemeral point
// -------------------------------------
// Output 1 goes to the recipient, output 2 is change returning to the sender,
// and BOTH get a one-time point R with blindness derived from the ECDH secret
// (see TransferV2 for the agreement itself). It would be cheaper to derive
// change blindness locally and publish nothing, and that is a trap: a sender who
// later restores their wallet on a clean device could rediscover notes sent TO
// them but not the change they sent themselves, silently losing most of their
// balance in precisely the scenario recovery exists for. Uniform treatment means
// one rescan algorithm covers every note a wallet can own.
//
// A second input is optional
// --------------------------
// Requiring two real notes would make a wallet holding exactly one note unable
// to pay at all. `isDummy2` marks input 2 as absent: it forces that amount to
// zero and waives the membership check, so the note contributes nothing to the
// balance and needs to exist nowhere. It still produces a nullifier, which the
// pool will mark spent. That is harmless because the blindness is fresh random
// so the value cannot collide with any real note's nullifier, but it does mean
// the client MUST draw a new dummy blindness per transfer; reusing one makes the
// second transfer fail on-chain as a double spend.
//
// The amounts have to be transmitted, not just hidden
// ---------------------------------------------------
// At a fixed denomination a recipient could find their note by recomputing
// `commitment = Poseidon2(amount, pubX, pubY, blindness)` — they knew `amount`,
// because there was only one. With arbitrary amounts they do not, and a
// commitment cannot be searched for without it. Hiding the amount from everyone
// including the recipient makes the payment undiscoverable, which is not
// privacy, it is loss.
//
// So each output also publishes its amount encrypted to the party who owns it:
//
//     amount_ct = amount + Poseidon2(S.x, TAG_AMOUNT)   (mod p)
//
// a one-time pad in the scalar field, using the same ECDH secret S that already
// produces the blindness under a different tag. The pad is uniform over the
// field and each S is fresh per transfer, so the ciphertext leaks nothing; the
// owner recomputes the pad from their own key and subtracts. Output 2's pad uses
// the SENDER's key, so a wallet restored on a clean device recovers the value of
// its own change as well as its receipts.
//
// These are bound into the proof for the same reason the ephemeral points are:
// a relayer able to rewrite `amount_ct` in flight would leave the owner deriving
// a wrong amount, hence a wrong commitment, hence a note they can never locate
// or spend. The circuit does NOT verify the encryption is correct — that would
// need an in-circuit variable-base scalar multiplication for no soundness gain,
// since a sender who encrypts wrongly only strands their own payment.
//
// Public: [root, nullifier1, nullifier2, commitment_out1, commitment_out2,
//          eph1_x, eph1_y, eph2_x, eph2_y, amount_ct1, amount_ct2]
template TransferV3(depth) {
    // ── public ────────────────────────────────────────────────
    signal input root;
    signal input nullifier1;
    signal input nullifier2;
    signal input commitment_out1;   // to the recipient
    signal input commitment_out2;   // change, back to the sender
    signal input eph1_x;
    signal input eph1_y;
    signal input eph2_x;
    signal input eph2_y;
    signal input amount_ct1;        // amount of output 1, padded to the recipient
    signal input amount_ct2;        // amount of output 2, padded to the sender

    // ── private ───────────────────────────────────────────────
    signal input privKey;           // sender's spend key; owns BOTH inputs
    signal input in_amount1;
    signal input in_blindness1;
    signal input in_pathElements1[depth];
    signal input in_pathIndices1[depth];

    signal input in_amount2;
    signal input in_blindness2;
    signal input in_pathElements2[depth];
    signal input in_pathIndices2[depth];
    signal input isDummy2;          // 1 when the wallet holds only one note

    signal input out_amount1;
    signal input out_pubX1;
    signal input out_pubY1;
    signal input out_blindness1;

    signal input out_amount2;
    signal input out_pubX2;
    signal input out_pubY2;
    signal input out_blindness2;

    // ── input 1 ───────────────────────────────────────────────
    // Note() derives the public key from privKey on BabyJubjub and constrains
    // the key to [1, l), so one note yields exactly one nullifier. It also
    // range-checks in_amount1 to 64 bits. Both properties are load-bearing: the
    // first is audit F1 (unbound key => unlimited nullifiers => pool drain), the
    // second is what keeps the balance equation from wrapping.
    component note1 = Note();
    note1.privKey <== privKey;
    note1.amount <== in_amount1;
    note1.blindness <== in_blindness1;
    note1.nullifier === nullifier1;

    component tree1 = MerkleProof(depth);
    tree1.leaf <== note1.commitment;
    for (var i = 0; i < depth; i++) {
        tree1.pathElements[i] <== in_pathElements1[i];
        tree1.pathIndices[i] <== in_pathIndices1[i];
    }
    tree1.root === root;

    // ── input 2 (optionally a dummy) ──────────────────────────
    isDummy2 * (1 - isDummy2) === 0;      // boolean, pinned
    isDummy2 * in_amount2 === 0;          // a dummy carries no value

    component note2 = Note();
    note2.privKey <== privKey;
    note2.amount <== in_amount2;
    note2.blindness <== in_blindness2;
    note2.nullifier === nullifier2;

    component tree2 = MerkleProof(depth);
    tree2.leaf <== note2.commitment;
    for (var i = 0; i < depth; i++) {
        tree2.pathElements[i] <== in_pathElements2[i];
        tree2.pathIndices[i] <== in_pathIndices2[i];
    }
    // Membership is required only for a real input. A dummy contributes zero to
    // the balance, so waiving its path cannot create value; the worst a prover
    // achieves is spending a nullifier that corresponds to no note.
    (tree2.root - root) * (1 - isDummy2) === 0;

    // ── the same note cannot be both inputs ───────────────────
    // Without this, a wallet could present one note twice and double its
    // spendable balance in a single transfer. The inverse witness is the
    // standard idiom: an inverse of (n1 - n2) exists only when they differ.
    signal diff_inv;
    diff_inv <-- 1 / (nullifier1 - nullifier2);
    (nullifier1 - nullifier2) * diff_inv === 1;

    // ── output 1: to the recipient ────────────────────────────
    // The recipient's key is a free witness, since the sender does not hold its
    // private half. BabyCheck rejects an off-curve point, which would otherwise
    // yield a commitment nobody can ever open: a silent burn of real value. It
    // does not prove subgroup membership; an on-curve, off-subgroup key would
    // still only burn the sender's own funds, and checking costs a scalar mul.
    component out1KeyOnCurve = BabyCheck();
    out1KeyOnCurve.x <== out_pubX1;
    out1KeyOnCurve.y <== out_pubY1;

    component out1Range = RangeCheck64();
    out1Range.in <== out_amount1;

    component out1Note = NoteCommitment();
    out1Note.amount <== out_amount1;
    out1Note.pubX <== out_pubX1;
    out1Note.pubY <== out_pubY1;
    out1Note.blindness <== out_blindness1;
    out1Note.commitment === commitment_out1;

    // ── output 2: change, back to the sender ──────────────────
    component out2KeyOnCurve = BabyCheck();
    out2KeyOnCurve.x <== out_pubX2;
    out2KeyOnCurve.y <== out_pubY2;

    component out2Range = RangeCheck64();
    out2Range.in <== out_amount2;

    component out2Note = NoteCommitment();
    out2Note.amount <== out_amount2;
    out2Note.pubX <== out_pubX2;
    out2Note.pubY <== out_pubY2;
    out2Note.blindness <== out_blindness2;
    out2Note.commitment === commitment_out2;

    // ── conservation ──────────────────────────────────────────
    // Every term is 64-bit bounded above, so this cannot wrap the field and
    // means exactly what it reads as. No fee term: the relayer pays the network
    // fee from its own balance, as it already does for withdraw and transfer.
    in_amount1 + in_amount2 === out_amount1 + out_amount2;

    // ── ephemeral points ──────────────────────────────────────
    // Constrained rather than left dangling: an unconstrained public signal can
    // be optimised out of the R1CS, and these must stay in the statement to be
    // tamper-evident. A relayer able to swap R in flight would leave the
    // recipient unable to ever locate their note.
    component eph1OnCurve = BabyCheck();
    eph1OnCurve.x <== eph1_x;
    eph1OnCurve.y <== eph1_y;

    component eph2OnCurve = BabyCheck();
    eph2OnCurve.x <== eph2_x;
    eph2OnCurve.y <== eph2_y;

    // ── encrypted amounts ─────────────────────────────────────
    // Same reason the ephemeral points are constrained: an unconstrained public
    // signal is optimised out of the R1CS and stops being bound by the
    // verification key, which would let a relayer rewrite it and strand the
    // note. Squaring is the cheapest constraint that keeps the signal.
    signal amount_ct1_sq <== amount_ct1 * amount_ct1;
    signal amount_ct2_sq <== amount_ct2 * amount_ct2;
}

component main {
    public [
        root, nullifier1, nullifier2,
        commitment_out1, commitment_out2,
        eph1_x, eph1_y, eph2_x, eph2_y,
        amount_ct1, amount_ct2
    ]
} = TransferV3(20);
