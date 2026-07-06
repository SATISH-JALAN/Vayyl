pragma circom 2.1.0;

include "lib/poseidon2.circom";
include "lib/range_check.circom";

// SealedOrderCommitReveal Circuit (system design §2.12)
// ====================================================
// The circuit's only job is to make the pre-reveal order commitment binding —
// reveal-and-match happens entirely off-circuit (orderbook step 1/2). Proving
// knowledge of the opening also serves as the generic "commitment-opening" gate
// reused by the agentic-settlement-hub quest claim.
//
//   order_commitment = Poseidon2(bid_price, bid_size, salt)
//
// bid_price / bid_size are range-checked to [0, 2^64) so a revealed order cannot
// later claim an out-of-range (field-wrapped) price or size.
template SealedOrder() {
    // Public
    signal input order_commitment;

    // Private
    signal input bid_price;
    signal input bid_size;
    signal input salt;

    component rc_price = RangeCheck64();
    rc_price.in <== bid_price;
    component rc_size = RangeCheck64();
    rc_size.in <== bid_size;

    component commit = Poseidon2Hash_3();
    commit.in[0] <== bid_price;
    commit.in[1] <== bid_size;
    commit.in[2] <== salt;
    commit.out === order_commitment;
}

component main { public [ order_commitment ] } = SealedOrder();
