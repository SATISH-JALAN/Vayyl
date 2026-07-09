// ============================================================
// ASP membership — insert an approved depositor key (Tier 1)
// ============================================================
// Unblocks the G4 deposit gate (Error #8 / is_known_root -> false). A deposit is
// rejected unless the note's ASP leaf `Poseidon2(pubX, pubY)` has been inserted
// into the on-chain ASP Merkle tree AND the frontend submits a root the tree has
// produced. This script does both halves of the compliance step:
//
//   1. derives `leaf = Poseidon2(pubX, pubY)` using the SAME Poseidon2 the circuit
//      and the browser worker use — the vendored `hash2.wasm` witness calculator
//      (byte-identical wasm; no bespoke hashing that could silently diverge), and
//   2. `insert_leaf`s it via `stellar contract invoke` (admin/deployer-gated).
//
// It also computes the expected `root()` for that leaf at index 0 (empty tree)
// via the same empty-subtree ladder the frontend uses, so `--dry` can be diffed
// against the live `asp_membership.root()` BEFORE anyone touches the UI. If those
// two disagree, the Poseidon2 params have drifted (the CLAUDE.md "silent mismatch"
// trap) and nothing on-chain will ever verify — fix that first.
//
// Usage:
//   node scripts/asp_insert.js --pubX <dec> --pubY <dec> [options]
//   node scripts/asp_insert.js --leaf <hex|dec>          [options]   # precomputed leaf
//
// Options:
//   --dry              compute + print leaf and expected root; do NOT invoke
//   --asp <ID>         ASP contract id (else ASP_ID env, else deployments/<net>.json)
//   --source <alias>   tx source key alias           (default: deployer / STELLAR_SOURCE)
//   --network <name>   stellar network               (default: testnet / STELLAR_NETWORK)
//
// After a live insert it reads back is_member / leaf_count / root for confirmation.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const buildWitnessCalculator = require('../circuits/build/hash2_js/witness_calculator.js');

const NETWORK = process.env.STELLAR_NETWORK || 'testnet';
const SOURCE = process.env.STELLAR_SOURCE || 'deployer';
const ASP_TREE_DEPTH = 20; // must equal asp-membership::ASP_TREE_DEPTH

// BN254 scalar field modulus — the field the circuit and contract operate in.
const FIELD_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const modP = (x) => ((x % FIELD_P) + FIELD_P) % FIELD_P;

// ---- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const out = { dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry': out.dry = true; break;
      case '--pubX': out.pubX = argv[++i]; break;
      case '--pubY': out.pubY = argv[++i]; break;
      case '--leaf': out.leaf = argv[++i]; break;
      case '--asp': out.asp = argv[++i]; break;
      case '--source': out.source = argv[++i]; break;
      case '--network': out.network = argv[++i]; break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(1);
    }
  }
  return out;
}

// A fresh deploy mints a NEW asp id, so resolve dynamically (never hardcode):
// explicit flag/env → deployments file written by the deploy script → error.
function resolveAspId(flag, network) {
  if (flag) return flag.trim();
  if (process.env.ASP_ID) return process.env.ASP_ID.trim();
  const deployFile = path.join(__dirname, '..', 'deployments', `${network}.json`);
  if (fs.existsSync(deployFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
      if (d.asp_membership) return d.asp_membership;
    } catch (e) {
      console.warn(`Could not parse ${deployFile}: ${e.message}`);
    }
  }
  console.error(
    'ASP contract id not found. Pass --asp <ID>, set ASP_ID, or add ' +
    `"asp_membership" to deployments/${network}.json.`,
  );
  process.exit(1);
}

// ---- Poseidon2 (identical to circuit / browser worker) ---------------------

let _wc;
async function poseidon2Hash2(a, b) {
  if (!_wc) {
    const wasm = fs.readFileSync(
      path.join(__dirname, '..', 'circuits', 'build', 'hash2_js', 'hash2.wasm'),
    );
    _wc = await buildWitnessCalculator(wasm);
  }
  const w = await _wc.calculateWitness(
    { in: [modP(a).toString(), modP(b).toString()] },
    false,
  );
  return w[1]; // signal 1 = the hash output, as a BigInt
}

/** Empty-subtree ladder: zeros[0]=0, zeros[l]=hash2(zeros[l-1], zeros[l-1]). */
async function zeroHashes(depth) {
  const zeros = [0n];
  for (let l = 1; l <= depth; l++) zeros[l] = await poseidon2Hash2(zeros[l - 1], zeros[l - 1]);
  return zeros;
}

/** Root for `leaf` at index 0 of an otherwise-empty tree (all-left climb). */
async function rootForIndexZero(leaf, depth) {
  const zeros = await zeroHashes(depth);
  let node = leaf;
  for (let l = 0; l < depth; l++) node = await poseidon2Hash2(node, zeros[l]);
  return node;
}

// field element -> canonical 32-byte big-endian hex (BytesN<32>)
const toHex32 = (x) => modP(x).toString(16).padStart(64, '0');
// accept a leaf given as 0x-hex or decimal
const parseField = (s) =>
  /^0x/i.test(s) ? BigInt(s) : (/^[0-9]+$/.test(s) ? BigInt(s) : BigInt('0x' + s));

// ---- stellar invoke helpers ------------------------------------------------

function invoke(aspId, network, source, fnAndArgs) {
  const cmd = `stellar contract invoke --id ${aspId} --network ${network} --source ${source} -- ${fnAndArgs}`;
  console.log(`\n$ ${cmd}`);
  return execSync(cmd, { encoding: 'utf8' });
}

// ---- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const network = args.network || NETWORK;
  const source = args.source || SOURCE;

  // Derive the leaf. Prefer (pubX,pubY) so the hash is done here with the real
  // Poseidon2; a precomputed --leaf is accepted for convenience/re-inserts.
  let leaf;
  if (args.pubX != null && args.pubY != null) {
    leaf = await poseidon2Hash2(BigInt(args.pubX), BigInt(args.pubY));
  } else if (args.leaf != null) {
    leaf = modP(parseField(args.leaf));
  } else {
    console.error('Provide either --pubX <dec> --pubY <dec>, or --leaf <hex|dec>.');
    process.exit(1);
  }

  const leafHex = toHex32(leaf);
  const expectedRoot = await rootForIndexZero(leaf, ASP_TREE_DEPTH);
  const expectedRootHex = toHex32(expectedRoot);

  console.log('ASP leaf (Poseidon2(pubX,pubY)):');
  console.log(`  dec: ${leaf.toString()}`);
  console.log(`  hex: ${leafHex}`);
  console.log('Expected root() for this leaf at index 0 (empty tree):');
  console.log(`  hex: ${expectedRootHex}`);
  console.log(
    '\nNote: the expected root above only equals the on-chain root() if this leaf ' +
    'is inserted into an otherwise-empty tree (Tier 1, index 0).',
  );

  if (args.dry) {
    console.log('\n[dry] not inserting. Cross-check against on-chain root:');
    console.log(`  stellar contract invoke --id <ASP> --network ${network} --source ${source} -- root`);
    return;
  }

  const aspId = resolveAspId(args.asp, network);
  console.log(`\nTarget ASP contract: ${aspId} (network=${network}, source=${source})`);

  // Insert. leaf is a BytesN<32> — pass as the {"bytes": "<hex>"} JSON form the
  // other testnet scripts use (works through Git Bash / cmd.exe quoting).
  const leafArg = `"{\\"bytes\\":\\"${leafHex}\\"}"`;
  try {
    invoke(aspId, network, source, `insert_leaf --leaf ${leafArg}`);
  } catch (e) {
    // LeafAlreadyExists (Error #5) is fine — the key is already approved.
    const msg = (e.stderr || e.stdout || e.message || '').toString();
    if (/#5|LeafAlreadyExists/.test(msg)) {
      console.log('Leaf already present in the ASP tree (Error #5) — nothing to do.');
    } else {
      console.error('insert_leaf failed:\n' + msg);
      process.exit(1);
    }
  }

  // Read back for confirmation (the anti-silent-fail gate).
  const isMember = invoke(aspId, network, source, `is_member --leaf ${leafArg}`).trim();
  const leafCount = invoke(aspId, network, source, 'leaf_count').trim();
  const onchainRoot = invoke(aspId, network, source, 'root').trim();

  console.log('\n--- confirmation ---');
  console.log(`is_member : ${isMember}`);
  console.log(`leaf_count: ${leafCount}`);
  console.log(`root()    : ${onchainRoot}`);

  // Compare the on-chain root to what the frontend will compute. `root` returns a
  // JSON-quoted hex string; strip quotes/0x before comparing.
  const onchainHex = onchainRoot.replace(/^"|"$/g, '').replace(/^0x/i, '').toLowerCase();
  if (onchainHex === expectedRootHex.toLowerCase()) {
    console.log(
      '\n✅ On-chain root matches the frontend-computed root for this key at index 0. ' +
      'A deposit from this key should now clear the ASP gate.',
    );
  } else {
    console.log(
      '\n⚠️  On-chain root does NOT match the index-0 expected root.\n' +
      '    This is expected if the tree already holds other leaves (this key is not ' +
      'at index 0). For a single-depositor Tier-1 run it means the Poseidon2 params ' +
      'have drifted between this script and the contract — investigate before depositing.',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
