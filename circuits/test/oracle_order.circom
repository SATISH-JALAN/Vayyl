pragma circom 2.1.0;

// Test-only oracle for the order circuits (§2.9 / §2.12).
// Recomputes order commitments from the SAME Poseidon2 template the real
// circuits use, so a JS test can build byte-consistent VALID witnesses and
// MALFORMED ones (untriggered order, out-of-range magnitudes) that the new
// soundness constraints must reject at witness generation.
//
// Never compiled into production — lives under circuits/test/.

include "../lib/poseidon2.circom";

template OracleOrder() {
    signal input a;
    signal input b;
    signal input salt;

    // hash3(a, b, salt) — matches HiddenOrderTrigger(trigger_price,direction,salt)
    // and SealedOrder(bid_price,bid_size,salt): both are Poseidon2Hash_3.
    signal output commitment;

    component h = Poseidon2Hash_3();
    h.in[0] <== a;
    h.in[1] <== b;
    h.in[2] <== salt;
    commitment <== h.out;
}

component main = OracleOrder();
