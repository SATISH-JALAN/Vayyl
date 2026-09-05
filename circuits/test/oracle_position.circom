pragma circom 2.1.0;

// Test-only oracle for the position circuits.
//
// Recomputes -- from the SAME library templates the real circuits use -- every
// interior value a valid position witness must agree with: the derived owner
// pubkey, the collateral note's commitment / nullifier / Merkle root, the
// change note, the position commitment and nullifier, and the settled output
// note.
//
// This is what makes the soundness tests mean something. A JS test builds
// VALID witnesses from these outputs, so "valid" is byte-consistent with the
// real Poseidon2 by construction rather than by a hand-rolled JS
// reimplementation that could silently drift. It then builds MALFORMED
// witnesses whose interior values are ALSO recomputed under the malformation --
// so the only thing that can reject them is the constraint under test, never a
// stale commitment left over from the honest case. Without that property a
// soundness test passes for the wrong reason and keeps passing after the
// constraint is deleted.
//
// The collateral (`margin`) is a separate input from the note amount because
// the two genuinely differ now: a note funds the tier margin and returns the
// remainder as change.
//
// Never compiled into production -- lives under circuits/test/.

include "../lib/note.circom";
include "../lib/merkle.circom";
include "../lib/position_primitives.circom";
include "../lib/babyjubjub.circom";
include "../lib/poseidon2.circom";

template OraclePosition(depth) {
    // Owner / collateral note
    signal input note_amount;       // the whole note being spent
    signal input note_blindness;
    signal input privKey;           // owner key (derives the pubkey)
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // Change returning to the owner
    signal input change_amount;
    signal input change_blindness;

    // Position parameters (margin and size come from the tier table)
    signal input margin;
    signal input size;
    signal input direction;
    signal input entry_price;
    signal input position_blindness;

    // The settled output note produced at close
    signal input out_amount;
    signal input out_blindness;

    // Keeper (retained for the hidden-order / heartbeat helpers)
    signal input keeper_secret;

    signal output pubX;
    signal output pubY;
    signal output note_commitment;
    signal output note_nullifier;
    signal output note_root;
    signal output change_commitment;
    signal output pos_commitment;
    signal output pos_nullifier;
    signal output out_commitment;
    signal output keeper_commitment;

    // Derive the owner pubkey from the private key, exactly as Note() does.
    component dk = DerivePublicKey();
    dk.privKey <== privKey;
    pubX <== dk.pubX;
    pubY <== dk.pubY;

    // Collateral note = Poseidon2(amount, pubX, pubY, blindness)
    component note = NoteCommitment();
    note.amount <== note_amount;
    note.pubX <== pubX;
    note.pubY <== pubY;
    note.blindness <== note_blindness;
    note_commitment <== note.commitment;

    component nf = NoteNullifier();
    nf.commitment <== note.commitment;
    nf.privKey <== privKey;
    note_nullifier <== nf.nullifier;

    component tree = MerkleProof(depth);
    tree.leaf <== note.commitment;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    note_root <== tree.root;

    // Change note, back to the same key.
    component change = NoteCommitment();
    change.amount <== change_amount;
    change.pubX <== pubX;
    change.pubY <== pubY;
    change.blindness <== change_blindness;
    change_commitment <== change.commitment;

    // The position: collateral is the tier margin, not the note amount.
    component pc = PositionCommitment();
    pc.collateral_amount <== margin;
    pc.size <== size;
    pc.direction <== direction;
    pc.entry_price <== entry_price;
    pc.pubX <== pubX;
    pc.pubY <== pubY;
    pc.blindness <== position_blindness;
    pos_commitment <== pc.commitment;

    component pn = PositionNullifier();
    pn.commitment <== pc.commitment;
    pn.privKey <== privKey;
    pos_nullifier <== pn.nullifier;

    // The settled note minted at close.
    component out = NoteCommitment();
    out.amount <== out_amount;
    out.pubX <== pubX;
    out.pubY <== pubY;
    out.blindness <== out_blindness;
    out_commitment <== out.commitment;

    // Keeper public commitment = Poseidon2(keeper_secret, 0) -- matches the
    // on-chain poseidon2_hash([secret, 0]) that LiquidationEngine now checks
    // directly, since the heartbeat circuit was retired.
    component kh = Poseidon2Hash_2();
    kh.in[0] <== keeper_secret;
    kh.in[1] <== 0;
    keeper_commitment <== kh.out;
}

component main = OraclePosition(20);
