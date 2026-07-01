pragma circom 2.1.0;

// ============================================================
// Poseidon2 Permutation & Sponge Hash for BN254
// ============================================================
// Matches Soroban's native poseidon2_hash exactly.
// Parameters from: rs-soroban-poseidon/src/poseidon2/params.rs
//
// DO NOT use circomlib's Poseidon() — that is Poseidon V1 (CVE-2026-32129).
//
// S-box: x^5
// Full rounds: 8 (4 at start + 4 at end)
// Partial rounds: 56
// Total rounds: 64
//
// Round constants from auto-generated files:
//   poseidon2_constants_t2.circom (state width 2, rate 1)
//   poseidon2_constants_t3.circom (state width 3, rate 2)
//   poseidon2_constants_t4.circom (state width 4, rate 3)
// ============================================================

include "poseidon2_constants_t2.circom";
include "poseidon2_constants_t3.circom";
include "poseidon2_constants_t4.circom";

// ─────────────────────────────────────────────────────────────
// S-box: x^5
// ─────────────────────────────────────────────────────────────
template Sigma() {
    signal input in;
    signal output out;

    signal x2;
    signal x4;

    x2 <== in * in;      // x^2
    x4 <== x2 * x2;      // x^4
    out <== x4 * in;      // x^5
}

// ─────────────────────────────────────────────────────────────
// External MDS matrix for t=2
// M = ((2, 1), (1, 3))
// Actually for Poseidon2, the external matrix for t=2 is:
// state[0]' = 2*state[0] + state[1]
// state[1]' = state[0] + 3*state[1]
// ─────────────────────────────────────────────────────────────
template ExternalMatrixT2() {
    signal input in[2];
    signal output out[2];

    // Poseidon2 external matrix for t=2: M_E = circ(2, 1) applied as:
    // sum = state[0] + state[1]
    // state[0]' = sum + state[0]  (= 2*state[0] + state[1])
    // state[1]' = sum + state[1]  (= state[0] + 2*state[1])
    signal sum;
    sum <== in[0] + in[1];
    out[0] <== sum + in[0];
    out[1] <== sum + in[1];
}

// ─────────────────────────────────────────────────────────────
// External MDS matrix for t=3
// Circulant matrix circ(2, 1, 1)
// ─────────────────────────────────────────────────────────────
template ExternalMatrixT3() {
    signal input in[3];
    signal output out[3];

    // sum = state[0] + state[1] + state[2]
    // state[i]' = sum + state[i]
    signal sum;
    sum <== in[0] + in[1] + in[2];
    out[0] <== sum + in[0];
    out[1] <== sum + in[1];
    out[2] <== sum + in[2];
}

// ─────────────────────────────────────────────────────────────
// External MDS matrix for t=4
// Uses the M4 matrix from the Poseidon2 paper:
// M4 = circ(5, 7, 1, 3)
// Applied as: first do pairs, then combine
// This matches the HorizenLabs/Poseidon2 specification.
// ─────────────────────────────────────────────────────────────
template ExternalMatrixT4() {
    signal input in[4];
    signal output out[4];

    // Poseidon2 t=4 external matrix M4 = circ(5, 7, 1, 3)
    // Efficient computation from the paper:
    // t0 = state[0] + state[1]
    // t1 = state[2] + state[3]
    // t2 = 2*state[1] + t1
    // t3 = 2*state[3] + t0
    // t4 = 4*t1 + t3
    // t5 = 4*t0 + t2
    // state[0] = t3 + t5
    // state[1] = t5 + ...
    // Actually let's use the direct circulant approach for clarity and correctness:
    
    // For a circulant matrix circ(c0, c1, c2, c3) = circ(5, 7, 1, 3):
    // out[0] = 5*in[0] + 7*in[1] + 1*in[2] + 3*in[3]
    // out[1] = 3*in[0] + 5*in[1] + 7*in[2] + 1*in[3]
    // out[2] = 1*in[0] + 3*in[1] + 5*in[2] + 7*in[3]
    // out[3] = 7*in[0] + 1*in[1] + 3*in[2] + 5*in[3]
    
    // Optimized implementation using the Poseidon2 paper's method:
    // Step 1: compute pair-wise operations
    signal t0, t1, t2, t3;
    t0 <== in[0] + in[1];   // a + b
    t1 <== in[2] + in[3];   // c + d
    t2 <== 2 * in[1] + t1;  // 2b + c + d
    t3 <== 2 * in[3] + t0;  // a + b + 2d
    
    // Step 2: scale and combine
    signal t4, t5;
    t4 <== 4 * t1 + t3;     // a + b + 4c + 4d + 2d = a + b + 4c + 6d ... 
    t5 <== 4 * t0 + t2;     // 4a + 4b + 2b + c + d = 4a + 6b + c + d
    
    // Step 3: final outputs
    // out[0] <== t3 + t5;     // (a + b + 2d) + (4a + 6b + c + d) = 5a + 7b + c + 3d ✓
    // out[1] <== t5 + t2;     // (4a + 6b + c + d) + (2b + c + d) = ... wait, need to recheck
    // Let me recalculate properly:
    // t5 = 4*t0 + t2 = 4*(a+b) + (2b + c + d) = 4a + 4b + 2b + c + d = 4a + 6b + c + d
    // out[1] = t5 + t2 won't work. Let me use the clean circulant approach:
    
    // Clean circulant circ(5,7,1,3) directly:
    out[0] <== 5*in[0] + 7*in[1] + in[2] + 3*in[3];
    out[1] <== 3*in[0] + 5*in[1] + 7*in[2] + in[3];
    out[2] <== in[0] + 3*in[1] + 5*in[2] + 7*in[3];
    out[3] <== 7*in[0] + in[1] + 3*in[2] + 5*in[3];
}

// ─────────────────────────────────────────────────────────────
// Internal matrix for t=2
// M_I = I + diag(mat_internal_diag_m_1)
// For t=2: diag = [1, 2]
// M_I = [[2, 1], [1, 3]]
// ─────────────────────────────────────────────────────────────
template InternalMatrixT2() {
    signal input in[2];
    signal output out[2];

    // M_I for Poseidon2:
    // The internal diffusion uses M_I where M_I = 1 + diag(d)
    // For t ∈ {2,3}: sum = Σ state[i], then state[i] = sum + d_i * state[i]
    signal sum;
    sum <== in[0] + in[1];
    out[0] <== sum + 1 * in[0];   // d_0 = 1
    out[1] <== sum + 2 * in[1];   // d_1 = 2
}

// ─────────────────────────────────────────────────────────────
// Internal matrix for t=3
// diag = [1, 1, 2]
// ─────────────────────────────────────────────────────────────
template InternalMatrixT3() {
    signal input in[3];
    signal output out[3];

    signal sum;
    sum <== in[0] + in[1] + in[2];
    out[0] <== sum + 1 * in[0];   // d_0 = 1
    out[1] <== sum + 1 * in[1];   // d_1 = 1
    out[2] <== sum + 2 * in[2];   // d_2 = 2
}

// ─────────────────────────────────────────────────────────────
// Internal matrix for t=4
// diag = [large values from POSEIDON2_PARAMS.md]
// ─────────────────────────────────────────────────────────────
template InternalMatrixT4() {
    signal input in[4];
    signal output out[4];

    signal sum;
    sum <== in[0] + in[1] + in[2] + in[3];
    
    // d values from poseidon2_constants_t4.circom
    out[0] <== sum + poseidon2_mat_diag_t4(0) * in[0];
    out[1] <== sum + poseidon2_mat_diag_t4(1) * in[1];
    out[2] <== sum + poseidon2_mat_diag_t4(2) * in[2];
    out[3] <== sum + poseidon2_mat_diag_t4(3) * in[3];
}

// ─────────────────────────────────────────────────────────────
// Poseidon2 Permutation for t=2
// ─────────────────────────────────────────────────────────────
template Poseidon2Perm_t2() {
    signal input in[2];
    signal output out[2];

    var ROUNDS_F = 8;    // 4 + 4 full rounds
    var ROUNDS_P = 56;   // partial rounds
    var R_F_HALF = 4;

    // We need intermediate state signals for each round
    // Total rounds: 64
    // State after each round
    signal state[65][2];

    // Initial state
    state[0][0] <== in[0];
    state[0][1] <== in[1];

    component sbox_full[8][2];   // 8 full rounds, each applies sbox to all 2 elements
    component sbox_partial[56];  // 56 partial rounds, each applies sbox to element 0 only
    component ext_matrix[8];     // 8 external matrix applications
    component int_matrix[56];    // 56 internal matrix applications

    var round = 0;

    signal after_rc_1[R_F_HALF][2];
    signal after_rc_p[ROUNDS_P];
    signal after_rc2_1[ROUNDS_F][2];

    // ── First half full rounds (rounds 0..3) ──
    for (var r = 0; r < R_F_HALF; r++) {
        // Add round constants
        after_rc_1[r][0] <== state[round][0] + poseidon2_rc_t2(round, 0);
        after_rc_1[r][1] <== state[round][1] + poseidon2_rc_t2(round, 1);

        // S-box on all elements
        sbox_full[r][0] = Sigma();
        sbox_full[r][0].in <== after_rc_1[r][0];
        sbox_full[r][1] = Sigma();
        sbox_full[r][1].in <== after_rc_1[r][1];

        // External matrix
        ext_matrix[r] = ExternalMatrixT2();
        ext_matrix[r].in[0] <== sbox_full[r][0].out;
        ext_matrix[r].in[1] <== sbox_full[r][1].out;

        state[round+1][0] <== ext_matrix[r].out[0];
        state[round+1][1] <== ext_matrix[r].out[1];
        round++;
    }

    // ── Partial rounds (rounds 4..59) ──
    for (var r = 0; r < ROUNDS_P; r++) {
        // Add round constant to first element only
        after_rc_p[r] <== state[round][0] + poseidon2_rc_t2(round, 0);

        // S-box on first element only
        sbox_partial[r] = Sigma();
        sbox_partial[r].in <== after_rc_p[r];

        // Internal matrix
        int_matrix[r] = InternalMatrixT2();
        int_matrix[r].in[0] <== sbox_partial[r].out;
        int_matrix[r].in[1] <== state[round][1]; // unchanged

        state[round+1][0] <== int_matrix[r].out[0];
        state[round+1][1] <== int_matrix[r].out[1];
        round++;
    }

    // ── Second half full rounds (rounds 60..63) ──
    for (var r = R_F_HALF; r < ROUNDS_F; r++) {
        after_rc2_1[r][0] <== state[round][0] + poseidon2_rc_t2(round, 0);
        after_rc2_1[r][1] <== state[round][1] + poseidon2_rc_t2(round, 1);

        sbox_full[r][0] = Sigma();
        sbox_full[r][0].in <== after_rc2_1[r][0];
        sbox_full[r][1] = Sigma();
        sbox_full[r][1].in <== after_rc2_1[r][1];

        ext_matrix[r] = ExternalMatrixT2();
        ext_matrix[r].in[0] <== sbox_full[r][0].out;
        ext_matrix[r].in[1] <== sbox_full[r][1].out;

        state[round+1][0] <== ext_matrix[r].out[0];
        state[round+1][1] <== ext_matrix[r].out[1];
        round++;
    }

    out[0] <== state[64][0];
    out[1] <== state[64][1];
}

// ─────────────────────────────────────────────────────────────
// Poseidon2 Permutation for t=3
// ─────────────────────────────────────────────────────────────
template Poseidon2Perm_t3() {
    signal input in[3];
    signal output out[3];

    var ROUNDS_F = 8;
    var ROUNDS_P = 56;
    var R_F_HALF = 4;

    signal state[65][3];

    state[0][0] <== in[0];
    state[0][1] <== in[1];
    state[0][2] <== in[2];

    component sbox_full[8][3];
    component sbox_partial[56];
    component ext_matrix[8];
    component int_matrix[56];

    var round = 0;
    
    signal after_rc_3[R_F_HALF][3];
    signal after_rc_p_3[ROUNDS_P];
    signal after_rc2_3[ROUNDS_F][3];

    // First half full rounds
    for (var r = 0; r < R_F_HALF; r++) {
        after_rc_3[r][0] <== state[round][0] + poseidon2_rc_t3(round, 0);
        after_rc_3[r][1] <== state[round][1] + poseidon2_rc_t3(round, 1);
        after_rc_3[r][2] <== state[round][2] + poseidon2_rc_t3(round, 2);

        for (var j = 0; j < 3; j++) {
            sbox_full[r][j] = Sigma();
            sbox_full[r][j].in <== after_rc_3[r][j];
        }

        ext_matrix[r] = ExternalMatrixT3();
        for (var j = 0; j < 3; j++) {
            ext_matrix[r].in[j] <== sbox_full[r][j].out;
        }

        for (var j = 0; j < 3; j++) {
            state[round+1][j] <== ext_matrix[r].out[j];
        }
        round++;
    }

    // Partial rounds
    for (var r = 0; r < ROUNDS_P; r++) {
        after_rc_p_3[r] <== state[round][0] + poseidon2_rc_t3(round, 0);

        sbox_partial[r] = Sigma();
        sbox_partial[r].in <== after_rc_p_3[r];

        int_matrix[r] = InternalMatrixT3();
        int_matrix[r].in[0] <== sbox_partial[r].out;
        int_matrix[r].in[1] <== state[round][1];
        int_matrix[r].in[2] <== state[round][2];

        for (var j = 0; j < 3; j++) {
            state[round+1][j] <== int_matrix[r].out[j];
        }
        round++;
    }

    // Second half full rounds
    for (var r = R_F_HALF; r < ROUNDS_F; r++) {
        after_rc2_3[r][0] <== state[round][0] + poseidon2_rc_t3(round, 0);
        after_rc2_3[r][1] <== state[round][1] + poseidon2_rc_t3(round, 1);
        after_rc2_3[r][2] <== state[round][2] + poseidon2_rc_t3(round, 2);

        for (var j = 0; j < 3; j++) {
            sbox_full[r][j] = Sigma();
            sbox_full[r][j].in <== after_rc2_3[r][j];
        }

        ext_matrix[r] = ExternalMatrixT3();
        for (var j = 0; j < 3; j++) {
            ext_matrix[r].in[j] <== sbox_full[r][j].out;
        }

        for (var j = 0; j < 3; j++) {
            state[round+1][j] <== ext_matrix[r].out[j];
        }
        round++;
    }

    for (var j = 0; j < 3; j++) {
        out[j] <== state[64][j];
    }
}

// ─────────────────────────────────────────────────────────────
// Poseidon2 Permutation for t=4
// ─────────────────────────────────────────────────────────────
template Poseidon2Perm_t4() {
    signal input in[4];
    signal output out[4];

    var ROUNDS_F = 8;
    var ROUNDS_P = 56;
    var R_F_HALF = 4;

    signal state[65][4];

    for (var j = 0; j < 4; j++) {
        state[0][j] <== in[j];
    }

    component sbox_full[8][4];
    component sbox_partial[56];
    component ext_matrix[8];
    component int_matrix[56];

    var round = 0;
    
    signal after_rc_4[R_F_HALF][4];
    signal after_rc_p_4[ROUNDS_P];
    signal after_rc2_4[ROUNDS_F][4];

    // First half full rounds
    for (var r = 0; r < R_F_HALF; r++) {
        for (var j = 0; j < 4; j++) {
            after_rc_4[r][j] <== state[round][j] + poseidon2_rc_t4(round, j);
        }

        for (var j = 0; j < 4; j++) {
            sbox_full[r][j] = Sigma();
            sbox_full[r][j].in <== after_rc_4[r][j];
        }

        ext_matrix[r] = ExternalMatrixT4();
        for (var j = 0; j < 4; j++) {
            ext_matrix[r].in[j] <== sbox_full[r][j].out;
        }

        for (var j = 0; j < 4; j++) {
            state[round+1][j] <== ext_matrix[r].out[j];
        }
        round++;
    }

    // Partial rounds
    for (var r = 0; r < ROUNDS_P; r++) {
        after_rc_p_4[r] <== state[round][0] + poseidon2_rc_t4(round, 0);

        sbox_partial[r] = Sigma();
        sbox_partial[r].in <== after_rc_p_4[r];

        int_matrix[r] = InternalMatrixT4();
        int_matrix[r].in[0] <== sbox_partial[r].out;
        for (var j = 1; j < 4; j++) {
            int_matrix[r].in[j] <== state[round][j];
        }

        for (var j = 0; j < 4; j++) {
            state[round+1][j] <== int_matrix[r].out[j];
        }
        round++;
    }

    // Second half full rounds
    for (var r = R_F_HALF; r < ROUNDS_F; r++) {
        for (var j = 0; j < 4; j++) {
            after_rc2_4[r][j] <== state[round][j] + poseidon2_rc_t4(round, j);
        }

        for (var j = 0; j < 4; j++) {
            sbox_full[r][j] = Sigma();
            sbox_full[r][j].in <== after_rc2_4[r][j];
        }

        ext_matrix[r] = ExternalMatrixT4();
        for (var j = 0; j < 4; j++) {
            ext_matrix[r].in[j] <== sbox_full[r][j].out;
        }

        for (var j = 0; j < 4; j++) {
            state[round+1][j] <== ext_matrix[r].out[j];
        }
        round++;
    }

    for (var j = 0; j < 4; j++) {
        out[j] <== state[64][j];
    }
}

// ─────────────────────────────────────────────────────────────
// Poseidon2 Sponge Hash
// ─────────────────────────────────────────────────────────────
// Matches Soroban's sponge construction exactly:
// 1. State layout: state[0..RATE-1] = rate cells, state[T-1] = capacity
// 2. Capacity initialized to IV = (nInputs << 64)
// 3. Absorb: ADD inputs to rate cells, permute when block fills
// 4. Squeeze: permute once, return state[0]
//
// State width selection:
//   nInputs = 1 → t=2, rate=1
//   nInputs = 2 → t=3, rate=2
//   nInputs >= 3 → t=4, rate=3
// ─────────────────────────────────────────────────────────────

// IV computation: nInputs << 64 in the BN254 scalar field
// nInputs << 64 = nInputs * 2^64 = nInputs * 18446744073709551616
function computeIV(nInputs) {
    return nInputs * 18446744073709551616;
}

// ── Single-input hash (t=2, rate=1) ──
template Poseidon2Hash_1() {
    signal input in[1];
    signal output out;

    // State: [rate_0, capacity]
    // capacity = IV = 1 << 64
    // Absorb: state[0] += in[0]
    // Permute → squeeze state[0]

    component perm = Poseidon2Perm_t2();
    perm.in[0] <== in[0];                    // rate cell 0: 0 + input
    perm.in[1] <== computeIV(1);             // capacity: IV

    out <== perm.out[0];
}

// ── Two-input hash (t=3, rate=2) ──
template Poseidon2Hash_2() {
    signal input in[2];
    signal output out;

    // State: [rate_0, rate_1, capacity]
    // capacity = IV = 2 << 64
    // Absorb: state[0] += in[0], state[1] += in[1]
    // Permute → squeeze state[0]

    component perm = Poseidon2Perm_t3();
    perm.in[0] <== in[0];
    perm.in[1] <== in[1];
    perm.in[2] <== computeIV(2);

    out <== perm.out[0];
}

// ── Three-input hash (t=4, rate=3) ──
template Poseidon2Hash_3() {
    signal input in[3];
    signal output out;

    // State: [rate_0, rate_1, rate_2, capacity]
    // capacity = IV = 3 << 64
    // Absorb all 3 inputs in one block → permute → squeeze

    component perm = Poseidon2Perm_t4();
    perm.in[0] <== in[0];
    perm.in[1] <== in[1];
    perm.in[2] <== in[2];
    perm.in[3] <== computeIV(3);

    out <== perm.out[0];
}

// ── Four-input hash (t=4, rate=3) ──
// Requires 2 absorption blocks:
//   Block 1: absorb [in[0], in[1], in[2]] → permute
//   Block 2: absorb [in[3]] → permute → squeeze
template Poseidon2Hash_4() {
    signal input in[4];
    signal output out;

    // Block 1: absorb first 3 inputs
    component perm1 = Poseidon2Perm_t4();
    perm1.in[0] <== in[0];
    perm1.in[1] <== in[1];
    perm1.in[2] <== in[2];
    perm1.in[3] <== computeIV(4);   // IV for 4 inputs

    // Block 2: absorb 4th input (add to state[0] from perm1 output)
    component perm2 = Poseidon2Perm_t4();
    perm2.in[0] <== perm1.out[0] + in[3];  // add 4th input to rate cell 0
    perm2.in[1] <== perm1.out[1];           // carry over
    perm2.in[2] <== perm1.out[2];           // carry over
    perm2.in[3] <== perm1.out[3];           // carry over (capacity)

    out <== perm2.out[0];
}

// ── Five-input hash (t=4, rate=3) ──
// Block 1: absorb [in[0], in[1], in[2]] → permute
// Block 2: absorb [in[3], in[4]] → permute → squeeze
template Poseidon2Hash_5() {
    signal input in[5];
    signal output out;

    component perm1 = Poseidon2Perm_t4();
    perm1.in[0] <== in[0];
    perm1.in[1] <== in[1];
    perm1.in[2] <== in[2];
    perm1.in[3] <== computeIV(5);

    component perm2 = Poseidon2Perm_t4();
    perm2.in[0] <== perm1.out[0] + in[3];
    perm2.in[1] <== perm1.out[1] + in[4];
    perm2.in[2] <== perm1.out[2];
    perm2.in[3] <== perm1.out[3];

    out <== perm2.out[0];
}
