pragma circom 2.1.0;

include "lib/note.circom";
include "lib/range_check.circom";
include "asp_membership.circom";

// Deposit Circuit
// Generates a note commitment, proves ASP membership of the destination public key, 
// and enforces a 64-bit range check on the deposit amount.
template Deposit(depth) {
    // Public Inputs
    signal input amount;
    signal input commitment;
    signal input asp_root;

    // Private Inputs
    signal input pubX;
    signal input pubY;
    signal input blindness;
    signal input asp_pathElements[depth];
    signal input asp_pathIndices[depth];

    // 1. Range check amount (64 bits)
    component amountCheck = Num2Bits(64);
    amountCheck.in <== amount;

    // 2. Generate Note Commitment
    component note = NoteCommitment();
    note.amount <== amount;
    note.pubX <== pubX;
    note.pubY <== pubY;
    note.blindness <== blindness;

    note.commitment === commitment;

    // 3. ASP Membership Proof
    component asp = ASPMembership(depth);
    asp.pubX <== pubX;
    asp.pubY <== pubY;
    for (var i = 0; i < depth; i++) {
        asp.pathElements[i] <== asp_pathElements[i];
        asp.pathIndices[i] <== asp_pathIndices[i];
    }

    asp.root === asp_root;
}

component main { public [ amount, commitment, asp_root ] } = Deposit(20);
