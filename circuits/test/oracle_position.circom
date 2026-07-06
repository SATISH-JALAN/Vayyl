pragma circom 2.1.0;

// Test-only oracle for the position circuits.
// Recomputes — from the SAME library templates the real circuits use — every
// interior value a valid position witness must agree with: the derived owner
// pubkey, the collateral note commitment / nullifier / Merkle root, the
// position commitment / nullifier, and the keeper public commitment.
//
// A JS test (scripts/position_circuits_test.mjs) reads these outputs to build
// byte-consistent VALID witnesses for position_open / position_health /
// position_close / liquidation_heartbeat, and to construct MALFORMED witnesses
// (out-of-range magnitudes, non-boolean direction) that the new soundness
// constraints must reject at witness generation.
//
// Never compiled into production — lives under circuits/test/.

include "../lib/note.circom";
include "../lib/merkle.circom";
include "../lib/position_primitives.circom";
include "../lib/babyjubjub.circom";
include "../lib/poseidon2.circom";

template OraclePosition(depth) {
    // Owner / collateral note
    signal input amount;          // note amount == position collateral
    signal input blindness;       // note blindness
    signal input privKey;         // owner key (derives the pubkey)
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // Position parameters
    signal input size;
    signal input direction;
    signal input entry_price;
    signal input position_blindness;

    // Keeper (liquidation heartbeat)
    signal input keeper_secret;

    signal output pubX;
    signal output pubY;
    signal output note_commitment;
    signal output note_nullifier;
    signal output note_root;
    signal output pos_commitment;
    signal output pos_nullifier;
    signal output keeper_commitment;

    // Derive owner pubkey from the private key (matches position_open's check).
    component dk = DerivePublicKey();
    dk.privKey <== privKey;
    pubX <== dk.pubX;
    pubY <== dk.pubY;

    // Collateral note commitment = Poseidon2(amount, pubX, pubY, blindness)
    component note = NoteCommitment();
    note.amount <== amount;
    note.pubX <== pubX;
    note.pubY <== pubY;
    note.blindness <== blindness;
    note_commitment <== note.commitment;

    // Note nullifier = Poseidon2(commitment, privKey)
    component nf = NoteNullifier();
    nf.commitment <== note.commitment;
    nf.privKey <== privKey;
    note_nullifier <== nf.nullifier;

    // Note-tree Merkle root from leaf=note_commitment along the supplied path.
    component tree = MerkleProof(depth);
    tree.leaf <== note.commitment;
    for (var i = 0; i < depth; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }
    note_root <== tree.root;

    // Position commitment (collateral == amount) and its nullifier.
    component pc = PositionCommitment();
    pc.collateral_amount <== amount;
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

    // Keeper public commitment = Poseidon2(keeper_secret, 0) — matches the
    // on-chain poseidon2_hash([secret, 0]) the heartbeat circuit checks.
    component kh = Poseidon2Hash_2();
    kh.in[0] <== keeper_secret;
    kh.in[1] <== 0;
    keeper_commitment <== kh.out;
}

component main = OraclePosition(20);
