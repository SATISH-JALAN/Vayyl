#!/usr/bin/env node
// ============================================================
// Poseidon2 constants verifier  (Phase 0, Task 4.2)
// ============================================================
// Source of truth: rs-soroban-poseidon/src/poseidon2/params.rs
// Verifies that the committed circom constant files
//   lib/poseidon2_constants_t{2,3,4}.circom
// exactly reproduce the BN254 round constants + internal-matrix
// diagonal from params.rs (hex -> decimal).
//
// This is deterministic and needs no circom compilation. Run it
// before trusting the differential harness — if constants are
// wrong, the harness fails for a reason unrelated to the matrices.
//
// Usage:  node scripts/poseidon2_verify_constants.mjs
// Exit 0 = all match; exit 1 = mismatch (details printed).
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = resolve(__dirname, '..');
const PARAMS_RS = resolve(CIRCUITS, 'reference/rs-soroban-poseidon/params.rs');

// ---- helpers ---------------------------------------------------------------

/** Slice the body of a Rust fn `fn <name>(...` up to the first line that is a
 *  bare `}` at column 0 (the fn's closing brace). */
function sliceFn(src, name) {
  const start = src.indexOf(`fn ${name}(`);
  if (start < 0) throw new Error(`params.rs: fn ${name} not found`);
  const rest = src.slice(start);
  const end = rest.search(/\n\}/); // first line beginning with a close brace (col 0)
  if (end < 0) throw new Error(`params.rs: could not find end of fn ${name}`);
  return rest.slice(0, end);
}

/** Extract all hex field elements (0x...) from a slice, in order, as BigInt. */
function hexes(slice) {
  const out = [];
  const re = /0x([0-9a-fA-F]+)/g;
  let m;
  while ((m = re.exec(slice)) !== null) out.push(BigInt('0x' + m[1]));
  return out;
}

/** Parse a circom `function poseidon2_rc_tN(round, idx)` body into RC[round][idx]. */
function parseCircomRC(src, t) {
  const rc = Array.from({ length: 64 }, () => new Array(t).fill(null));
  const re = /RC\[(\d+)\]\[(\d+)\]\s*=\s*(\d+);/g;
  let m, count = 0;
  while ((m = re.exec(src)) !== null) {
    rc[+m[1]][+m[2]] = BigInt(m[3]);
    count++;
  }
  if (count !== 64 * t) throw new Error(`circom t${t}: expected ${64 * t} RC entries, got ${count}`);
  return rc;
}

/** Parse a circom `function poseidon2_mat_diag_tN(idx)` body into DIAG[idx]. */
function parseCircomDiag(src, t) {
  const diag = new Array(t).fill(null);
  const re = /DIAG\[(\d+)\]\s*=\s*(\d+);/g;
  let m, count = 0;
  while ((m = re.exec(src)) !== null) {
    diag[+m[1]] = BigInt(m[2]);
    count++;
  }
  if (count !== t) throw new Error(`circom t${t}: expected ${t} DIAG entries, got ${count}`);
  return diag;
}

// ---- load params.rs (BN254 only) -------------------------------------------

const rs = readFileSync(PARAMS_RS, 'utf8');

let failures = 0;
const note = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

for (const t of [2, 3, 4]) {
  console.log(`\n=== t=${t} (BN254) ===`);

  // --- round constants ---
  const rcSlice = sliceFn(rs, `get_rc_bn254_t_${t}`);
  const rcFlatRust = hexes(rcSlice);            // 64 rounds * t values, row-major
  if (rcFlatRust.length !== 64 * t) {
    note(false, `params.rs get_rc_bn254_t_${t}: expected ${64 * t} values, got ${rcFlatRust.length}`);
    continue;
  }
  const circomRC = parseCircomRC(
    readFileSync(resolve(CIRCUITS, `lib/poseidon2_constants_t${t}.circom`), 'utf8'), t);

  let rcOk = true, firstBad = null;
  for (let r = 0; r < 64; r++) {
    for (let i = 0; i < t; i++) {
      const want = rcFlatRust[r * t + i];
      if (circomRC[r][i] !== want) { rcOk = false; if (!firstBad) firstBad = { r, i, want, got: circomRC[r][i] }; }
    }
  }
  note(rcOk, `round constants (${64 * t} values)`);
  if (!rcOk) console.log(`        first mismatch RC[${firstBad.r}][${firstBad.i}]: want ${firstBad.want}, got ${firstBad.got}`);

  // --- internal matrix diagonal ---
  const diagSlice = sliceFn(rs, `get_mat_diag_bn254_t_${t}`);
  const diagRust = hexes(diagSlice);
  const circomDiag = parseCircomDiag(
    readFileSync(resolve(CIRCUITS, `lib/poseidon2_constants_t${t}.circom`), 'utf8'), t);

  let diagOk = diagRust.length === t;
  for (let i = 0; i < t && diagOk; i++) if (circomDiag[i] !== diagRust[i]) diagOk = false;
  note(diagOk, `internal-matrix diagonal (${t} values)`);
  if (!diagOk) {
    for (let i = 0; i < t; i++) {
      if (circomDiag[i] !== diagRust[i]) console.log(`        DIAG[${i}]: want ${diagRust[i]}, got ${circomDiag[i]}`);
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL CONSTANTS MATCH ✅' : `${failures} MISMATCH GROUP(S) ❌`}`);
process.exit(failures === 0 ? 0 : 1);
