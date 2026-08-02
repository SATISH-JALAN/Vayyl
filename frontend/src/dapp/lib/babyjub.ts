// ============================================================
// BabyJubjub point arithmetic  (Sprint 1, task 1.1)
// ============================================================
// Mirrors circuits/lib/babyjubjub.circom `DerivePublicKey()` exactly: the same
// twisted Edwards curve, the same base point, the same double-and-add ladder.
// The public key a client derives here MUST equal the circuit witness for the
// same privKey, or the note's commitment never matches its Merkle leaf and the
// proof fails on-chain with no useful error. `crypto.test.ts` pins that
// equality against the compiled circuit itself.
//
// Implemented in native BigInt rather than via circomlibjs: `buildBabyjub()`
// compiles the whole BN128 wasm curve just to borrow its scalar field, which is
// far too much machinery to run on the main thread during wallet unlock. The
// formulas below are transcribed from circomlibjs BabyJub.addPoint /
// mulPointEscalar, and the test asserts agreement with it.
//
// Curve (twisted Edwards over BN254 F_r):  A·x² + y² = 1 + D·x²·y²

/**
 * BabyJubjub's base field — the BN254 scalar field. A curve parameter, so it is
 * declared here rather than imported, keeping this module dependency-free.
 * crypto.test.ts asserts it still equals poseidon.ts's FIELD_P.
 */
export const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const A = 168700n;
const D = 168696n;

/** Base point G. Identical to `BASE` in circuits/lib/babyjubjub.circom. */
export const BASE8: readonly [bigint, bigint] = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
];

/**
 * Order of BASE8 — the prime-order subgroup. 251 bits.
 * A spend key MUST be reduced into [1, SUBORDER) before use: the circuit
 * constrains privKey < SUBORDER, and scalars differing by SUBORDER derive the
 * same public key while producing different nullifiers (the F1 double-spend).
 */
export const SUBORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export type Point = readonly [bigint, bigint];

const mod = (x: bigint) => ((x % FIELD_P) + FIELD_P) % FIELD_P;

/** Modular inverse via the extended Euclidean algorithm. */
function inv(a: bigint): bigint {
  let [t, newT] = [0n, 1n];
  let [r, newR] = [FIELD_P, mod(a)];
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r > 1n) throw new Error('BabyJubjub: value is not invertible');
  return mod(t);
}

const div = (a: bigint, b: bigint) => mod(a * inv(b));

/** Twisted Edwards addition. Complete for points in the prime-order subgroup. */
export function addPoint(a: Point, b: Point): Point {
  const beta = mod(a[0] * b[1]);
  const gamma = mod(a[1] * b[0]);
  const delta = mod(mod(a[1] - mod(A * a[0])) * mod(b[0] + b[1]));
  const dtau = mod(D * mod(beta * gamma));

  return [
    div(mod(beta + gamma), mod(1n + dtau)),
    div(mod(delta + mod(mod(A * beta) - gamma)), mod(1n - dtau)),
  ];
}

/** Scalar multiplication, LSB-first double-and-add. Identity is (0, 1). */
export function mulPointEscalar(base: Point, scalar: bigint): Point {
  let res: Point = [0n, 1n];
  let exp: Point = base;
  let rem = scalar;

  while (rem > 0n) {
    if (rem & 1n) res = addPoint(res, exp);
    exp = addPoint(exp, exp);
    rem >>= 1n;
  }
  return res;
}

/** Is the point on the curve? A·x² + y² == 1 + D·x²·y² */
export function inCurve(p: Point): boolean {
  const x2 = mod(p[0] * p[0]);
  const y2 = mod(p[1] * p[1]);
  return mod(A * x2 + y2) === mod(1n + mod(D * mod(x2 * y2)));
}

/**
 * Derive a note public key from a spend key — the client-side twin of
 * `DerivePublicKey()`. Rejects scalars the circuit would reject, so a bad key
 * fails here with a clear message instead of as an opaque witness failure.
 */
export function derivePublicKey(privKey: bigint): { pubX: bigint; pubY: bigint } {
  if (privKey <= 0n || privKey >= SUBORDER) {
    throw new Error(
      `BabyJubjub: spend key must be in [1, ${SUBORDER}); the circuit constrains privKey < l.`,
    );
  }
  const [pubX, pubY] = mulPointEscalar(BASE8, privKey);
  return { pubX, pubY };
}
