pragma circom 2.1.0;

include "lib/position_primitives.circom";
include "lib/note.circom";
include "lib/range_check.circom";

// Position Close / Modify Circuit
// Consumes a position, settles PnL against an oracle price, 
// and outputs a new position commitment and/or a shielded note.
template PositionClose(depth) {
    // Public Inputs
    signal input position_nullifier;
    signal input new_position_commitment;
    signal input output_note_commitment;
    signal input oracle_price;
    signal input fee;
    signal input meta_hash;

    // Private Inputs (Old Position)
    signal input old_collateral;
    signal input old_size;
    signal input old_direction;
    signal input old_entry_price;
    signal input old_pubX;
    signal input old_pubY;
    signal input old_blindness;
    signal input old_privKey;

    // Private Inputs (New Position)
    signal input new_collateral;
    signal input new_size;
    signal input new_direction;
    signal input new_entry_price;
    signal input new_pubX;
    signal input new_pubY;
    signal input new_blindness;

    // Private Inputs (Output Note)
    signal input note_amount;
    signal input note_pubX;
    signal input note_pubY;
    signal input note_blindness;

    // 1. Dummy constraint for meta_hash
    signal meta_hash_sq <== meta_hash * meta_hash;

    // 2. Old Position Nullifier
    component old_pos = PositionCommitment();
    old_pos.collateral_amount <== old_collateral;
    old_pos.size <== old_size;
    old_pos.direction <== old_direction;
    old_pos.entry_price <== old_entry_price;
    old_pos.pubX <== old_pubX;
    old_pos.pubY <== old_pubY;
    old_pos.blindness <== old_blindness;

    component old_nullifier = PositionNullifier();
    old_nullifier.commitment <== old_pos.commitment;
    old_nullifier.privKey <== old_privKey;
    old_nullifier.nullifier === position_nullifier;

    // 3. New Position Commitment
    // Direction must be boolean
    new_direction * (new_direction - 1) === 0;

    component new_pos = PositionCommitment();
    new_pos.collateral_amount <== new_collateral;
    new_pos.size <== new_size;
    new_pos.direction <== new_direction;
    new_pos.entry_price <== new_entry_price;
    new_pos.pubX <== new_pubX;
    new_pos.pubY <== new_pubY;
    new_pos.blindness <== new_blindness;
    new_pos.commitment === new_position_commitment;

    // 4. Output Note Commitment
    component out_note = NoteCommitment();
    out_note.amount <== note_amount;
    out_note.pubX <== note_pubX;
    out_note.pubY <== note_pubY;
    out_note.blindness <== note_blindness;
    out_note.commitment === output_note_commitment;

    // 5. Range checks for outputs
    component rc_new_col = Num2Bits(64);
    rc_new_col.in <== new_collateral;

    component rc_note_amt = Num2Bits(64);
    rc_note_amt.in <== note_amount;

    component rc_fee = Num2Bits(64);
    rc_fee.in <== fee;

    // 6. Balance & PnL Settlement
    // LHS = old_collateral + old_size * asset_val
    // RHS = new_collateral + note_amount + fee + old_size * debt_val

    signal asset_val;
    asset_val <== old_direction * (oracle_price - old_entry_price) + old_entry_price;

    signal debt_val;
    debt_val <== old_direction * (old_entry_price - oracle_price) + oracle_price;

    signal lhs;
    lhs <== old_collateral + (old_size * asset_val);

    signal rhs;
    rhs <== new_collateral + note_amount + fee + (old_size * debt_val);

    lhs === rhs;
}

component main { public [ position_nullifier, new_position_commitment, output_note_commitment, oracle_price, fee, meta_hash ] } = PositionClose(20);
