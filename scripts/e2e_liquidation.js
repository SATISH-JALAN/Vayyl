/**
 * Vayyl Sprint 1 — Position Vertical E2E on Testnet
 *
 * Full lifecycle:
 *   1. Set mock oracle price (entry price for the position)
 *   2. Deposit collateral into the pool (reuses deposit circuit)
 *   3. open_position — consumes the deposited note as collateral
 *   4. attest_health — proves solvency at a new oracle price
 *   5. close_or_modify_position — settles PnL, inserts output note into pool
 *
 * Usage:
 *   pnpm exec node scripts/e2e_position.js
 *
 * Environment:
 *   E2E_SKIP_DEPOSIT=1    — skip the deposit step (resume with existing pool leaf)
 *   POOL_ID               — override pool contract address
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NETWORK = "testnet";
const SOURCE = "deployer";

// Load deployments
const deployPath = path.join(__dirname, '../deployments', `${NETWORK}.json`);
const deployments = JSON.parse(fs.readFileSync(deployPath, 'utf8'));
const POOL_ID = process.env.POOL_ID || deployments.pool;
const ASP_MEMBERSHIP_ID = deployments.asp_membership;
const POSITION_MANAGER_ID = deployments.manager;
const ORACLE_ID = deployments.oracle;
const VERIFIER_ID = deployments.verifier;

// ---------------------------------------------------------
// CLI Helpers
// ---------------------------------------------------------
function runCmd(cmd, opts = {}) {
    console.log(`\x1b[36mRunning:\x1b[0m ${cmd.slice(0, 200)}${cmd.length > 200 ? '…' : ''}`);
    try {
        const out = execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
        return { success: true, output: out };
    } catch (e) {
        const out = (e.stdout || "") + "\n" + (e.stderr || "");
        if (out.includes("Transaction submitted successfully!")) {
            return { success: true, output: out };
        }
        return { success: false, output: out };
    }
}

function checkError(res, expectFail) {
    if (res.success && expectFail) {
        console.error(`\x1b[31m❌ Expected failure but transaction succeeded!\x1b[0m`);
        process.exit(1);
    }
    if (!res.success && !expectFail) {
        console.error(`\x1b[31m❌ Transaction failed unexpectedly:\x1b[0m`);
        console.error(res.output);
        process.exit(1);
    }
    if (res.success) {
        console.log(`\x1b[32m✅ Transaction succeeded!\x1b[0m`);
    } else {
        console.log(`\x1b[32m✅ Transaction failed as expected.\x1b[0m`);
    }
}

function parseInvokeOutput(output) {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        const quoted = line.match(/^"([a-f0-9]{64})"$/i);
        if (quoted) return quoted[1];
        const rootMatch = line.match(/root\(\)\s*:\s*"([a-f0-9]+)"/i);
        if (rootMatch) return rootMatch[1];
        if (/^\d+$/.test(line)) return line;
    }
    return null;
}

// ---------------------------------------------------------
// Proof Formatting  (Groth16 → Stellar contract args)
// ---------------------------------------------------------
function formatG1(pt) {
    let x = BigInt(pt[0]).toString(16).padStart(64, '0');
    let y = BigInt(pt[1]).toString(16).padStart(64, '0');
    return x + y;
}

function formatG2(pt) {
    let x_c1 = BigInt(pt[0][1]).toString(16).padStart(64, '0');
    let x_c0 = BigInt(pt[0][0]).toString(16).padStart(64, '0');
    let y_c1 = BigInt(pt[1][1]).toString(16).padStart(64, '0');
    let y_c0 = BigInt(pt[1][0]).toString(16).padStart(64, '0');
    return x_c1 + x_c0 + y_c1 + y_c0;
}

function formatFr(scalar) {
    return BigInt(scalar).toString(16).padStart(64, '0');
}

function getProofArgs(proofJsonPath, publicJsonPath) {
    const proof = JSON.parse(fs.readFileSync(proofJsonPath, 'utf8'));
    const publicInputs = JSON.parse(fs.readFileSync(publicJsonPath, 'utf8'));
    const proof_a = formatG1(proof.pi_a);
    const proof_b = formatG2(proof.pi_b);
    const proof_c = formatG1(proof.pi_c);
    const proofStr = `{"a": {"bytes": "${proof_a}"}, "b": {"bytes": "${proof_b}"}, "c": {"bytes": "${proof_c}"}}`;
    return { proofStr, publicInputs };
}

// ---------------------------------------------------------
// Poseidon2 JS wrappers (via WASM circuit)
// ---------------------------------------------------------
function calculateHash4(inputs) {
    const cwd = path.join(__dirname, '../circuits');
    fs.writeFileSync(path.join(cwd, 'test/hash4_input.json'), JSON.stringify({ in: inputs }));
    execSync(`snarkjs wtns calculate build/hash4_js/hash4.wasm test/hash4_input.json build/hash4.wtns`, { cwd, stdio: 'ignore' });
    execSync(`snarkjs wtns export json build/hash4.wtns build/hash4_witness.json`, { cwd, stdio: 'ignore' });
    const witness = JSON.parse(fs.readFileSync(path.join(cwd, 'build/hash4_witness.json'), 'utf8'));
    return witness[1];
}

function calculateHash2(inputs) {
    const cwd = path.join(__dirname, '../circuits');
    fs.writeFileSync(path.join(cwd, 'test/hash2_input.json'), JSON.stringify({ in: inputs }));
    execSync(`snarkjs wtns calculate build/hash2_js/hash2.wasm test/hash2_input.json build/hash2.wtns`, { cwd, stdio: 'ignore' });
    execSync(`snarkjs wtns export json build/hash2.wtns build/hash2_witness.json`, { cwd, stdio: 'ignore' });
    const witness = JSON.parse(fs.readFileSync(path.join(cwd, 'build/hash2_witness.json'), 'utf8'));
    return witness[1];
}

// ---------------------------------------------------------
// Merkle Tree (identical to e2e_testnet.js)
// ---------------------------------------------------------
const TREE_DEPTH = 20;
let emptyLadder = ["0"];
for (let i = 1; i <= TREE_DEPTH; i++) {
    emptyLadder[i] = calculateHash2([emptyLadder[i - 1], emptyLadder[i - 1]]);
}

class MerkleTree {
    constructor(depth) {
        this.depth = depth;
        this.leaves = [];
    }
    insert(leaf) {
        const index = this.leaves.length;
        this.leaves.push(leaf);
        return index;
    }
    getProof(index) {
        let pathElements = [];
        let pathIndices = [];
        let nodes = [...this.leaves];
        let pathIndex = index;
        for (let level = 0; level < this.depth; level++) {
            const isRight = pathIndex % 2 === 1;
            pathIndices.push(isRight ? 1 : 0);
            let siblingIndex = isRight ? pathIndex - 1 : pathIndex + 1;
            let sibling = siblingIndex < nodes.length ? nodes[siblingIndex] : emptyLadder[level];
            pathElements.push(sibling);
            let nextNodes = [];
            for (let i = 0; i < nodes.length; i += 2) {
                let left = nodes[i];
                let right = i + 1 < nodes.length ? nodes[i + 1] : emptyLadder[level];
                nextNodes.push(calculateHash2([left, right]));
            }
            nodes = nextNodes;
            pathIndex = Math.floor(pathIndex / 2);
        }
        return {
            root: nodes[0] || emptyLadder[this.depth],
            pathElements,
            pathIndices
        };
    }
}

// ---------------------------------------------------------
// Groth16 Proof Generation
// ---------------------------------------------------------
function generateProof(circuit, inputJson) {
    const cwd = path.join(__dirname, '../circuits');
    const inputPath = path.join(cwd, `test/input_${circuit}.json`);
    fs.writeFileSync(inputPath, JSON.stringify(inputJson, null, 2));

    console.log(`\x1b[35mGenerating proof for ${circuit}...\x1b[0m`);
    execSync(
        `snarkjs groth16 fullprove test/input_${circuit}.json build/wasm/${circuit}.wasm build/zkey/${circuit}_final.zkey build/${circuit}_proof.json build/${circuit}_public.json`,
        { cwd, stdio: 'inherit' }
    );

    return getProofArgs(
        path.join(cwd, `build/${circuit}_proof.json`),
        path.join(cwd, `build/${circuit}_public.json`)
    );
}

// ---------------------------------------------------------
// Position-specific Poseidon2 helpers
// ---------------------------------------------------------

/**
 * PositionCommitment = Hash4(collateral, pubX, pubY, Hash4(size, direction, entry_price, blindness))
 * Matches circuits/lib/position_primitives.circom PositionCommitment template.
 */
function calculatePositionCommitment(collateral, pubX, pubY, size, direction, entry_price, blindness) {
    const metaHash = calculateHash4([size, direction, entry_price, blindness]);
    return calculateHash4([collateral, pubX, pubY, metaHash]);
}

/**
 * PositionNullifier = Hash2(position_commitment, privKey)
 * Matches circuits/lib/position_primitives.circom PositionNullifier template.
 */
function calculatePositionNullifier(positionCommitment, privKey) {
    return calculateHash2([positionCommitment, privKey]);
}

// ---------------------------------------------------------
// Binding hashes (meta_hash, withdraw_binding)
// ---------------------------------------------------------
function getMetaHash(addressStr, fee) {
    const { xdr, StrKey } = require('@stellar/stellar-base');
    const crypto = require('crypto');
    const pubkey = StrKey.decodeEd25519PublicKey(addressStr);
    const scAddress = xdr.ScAddress.scAddressTypeAccount(
        xdr.PublicKey.publicKeyTypeEd25519(pubkey)
    );
    const scVal = xdr.ScVal.scvAddress(scAddress);
    const addressXdr = scVal.toXDR();
    const feeBuffer = Buffer.alloc(16);
    feeBuffer.writeBigUInt64BE(BigInt(fee), 8);
    const bytes = Buffer.concat([addressXdr, feeBuffer]);
    const hash = crypto.createHash('sha256').update(bytes).digest();
    hash[0] &= 0x1F;
    return BigInt("0x" + hash.toString('hex')).toString(10);
}

// ---------------------------------------------------------
// ASP helpers (from e2e_testnet.js)
// ---------------------------------------------------------
function queryAspField(field) {
    const res = runCmd(
        `stellar contract invoke --id ${ASP_MEMBERSHIP_ID} --network ${NETWORK} --source ${SOURCE} -- ${field}`
    );
    if (!res.success) throw new Error(`Failed to query ASP ${field}: ${res.output}`);
    const parsed = parseInvokeOutput(res.output);
    if (parsed == null) throw new Error(`Could not parse ASP ${field} from: ${res.output}`);
    return parsed;
}

function leafHexToDecimal(hex) {
    return BigInt("0x" + hex.replace(/^0x/i, "")).toString(10);
}

function loadBootstrapLeaves() {
    if (process.env.ASP_BOOTSTRAP_LEAVES) {
        return process.env.ASP_BOOTSTRAP_LEAVES.split(",")
            .map((s) => s.trim().replace(/^0x/i, ""))
            .filter(Boolean)
            .map(leafHexToDecimal);
    }
    const bootstrapPath = path.join(__dirname, "../deployments/asp_bootstrap.json");
    if (fs.existsSync(bootstrapPath)) {
        const data = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
        if (Array.isArray(data.leaves)) {
            return data.leaves.map((entry) => leafHexToDecimal(entry.hex));
        }
    }
    return [];
}

function insertAspLeafOnChain(leafDecimal) {
    const leafHex = formatFr(leafDecimal);
    const insertCmd = `stellar contract invoke --id ${ASP_MEMBERSHIP_ID} --network ${NETWORK} --source ${SOURCE} -- insert_leaf --leaf "{\\\"bytes\\\":\\\"${leafHex}\\\"}"`;
    const res = runCmd(insertCmd);
    if (!res.success && res.output.includes("Error(Contract, #5)")) {
        console.log(`ASP leaf ${leafHex.slice(0, 16)}... already exists, continuing...`);
        return;
    }
    checkError(res, false);
}

// ---------------------------------------------------------
// i128 → 32-byte field element encoding (matches contract)
// ---------------------------------------------------------
function i128ToFieldHex(value) {
    // i128 non-negative: zero-pad to 32 bytes, big-endian.
    // The contract puts the i128 be_bytes in [16..32].
    const v = BigInt(value);
    return v.toString(16).padStart(64, '0');
}

// u64 → 32-byte field element (goes in [24..32])
function u64ToFieldHex(value) {
    const v = BigInt(value);
    return v.toString(16).padStart(64, '0');
}


// ==========================================================
// MAIN
// ==========================================================
async function main() {
    console.log("=== Vayyl Sprint 1 — Position Vertical E2E ===\n");

    const deployerAddr = execSync(`stellar keys address ${SOURCE}`).toString().trim();
    console.log(`Deployer: ${deployerAddr}`);
    console.log(`Pool:     ${POOL_ID}`);
    console.log(`PM:       ${POSITION_MANAGER_ID}`);
    console.log(`Oracle:   ${ORACLE_ID}`);
    console.log(`Verifier: ${VERIFIER_ID}\n`);

    if (!POOL_ID) throw new Error("POOL_ID not set");
    if (!POSITION_MANAGER_ID) throw new Error("POSITION_MANAGER_ID not set");

    // ===================================================
    // Test parameters
    // ===================================================
    // "User" keys and note params for the collateral deposit
    const pubX = "2756817265436308373152970980469407708639447434621224209076647801443201833641";
    const pubY = "16414789158706146034337677946720139175629582444207655085744951462751993091228";
    const priv = "42";
    const collateralAmount = "1000";
    const noteBlindness = "191949";
    const noteCommitment = calculateHash4([collateralAmount, pubX, pubY, noteBlindness]);

    // Position params
    const posSize = "500";
    const posDirection = "1";      // 1 = Long
    const posEntryPrice = "2000";
    const posBlindness = "169727";

    // Oracle prices
    const entryOraclePrice = 2000;    // set at open
    const healthOraclePrice = 2500;   // set at attest (price went up — good for long)
    const closeOraclePrice = 2500;    // same for close settlement

    // Position commitment/nullifier (computed via Poseidon2 wasm)
    const posCommitment = calculatePositionCommitment(
        collateralAmount, pubX, pubY, posSize, posDirection, posEntryPrice, posBlindness
    );
    console.log(`Position commitment: ${posCommitment}`);

    const posNullifier = calculatePositionNullifier(posCommitment, priv);
    console.log(`Position nullifier:  ${posNullifier}\n`);

    // ===================================================
    // 0. SYNC ASP TREE
    // ===================================================
    console.log("--- Syncing ASP tree ---");
    const onChainLeafCount = Number(queryAspField("leaf_count"));
    const onChainRootHex = queryAspField("root");
    const onChainRoot = BigInt("0x" + onChainRootHex).toString(10);
    console.log(`ASP leaf_count: ${onChainLeafCount}`);
    console.log(`ASP root: ${onChainRoot}`);

    let aspTree = new MerkleTree(20);
    const bootstrapLeaves = loadBootstrapLeaves();
    for (const leaf of bootstrapLeaves) {
        aspTree.insert(leaf);
    }
    if (bootstrapLeaves.length !== onChainLeafCount) {
        console.warn(
            `Warning: bootstrap has ${bootstrapLeaves.length} leaves but chain has ${onChainLeafCount}. ` +
            `Update deployments/asp_bootstrap.json or ASP_BOOTSTRAP_LEAVES.`
        );
    }

    const poolTree = new MerkleTree(20);

    // ===================================================
    // 1. SET MOCK ORACLE PRICE (entry price)
    // ===================================================
    console.log("\n--- Setting mock oracle price (entry) ---");
    const entryTimestamp = Math.floor(Date.now() / 1000);
    const setEntryCmd = `stellar contract invoke --id ${ORACLE_ID} --network ${NETWORK} --source ${SOURCE} -- set_price --price ${entryOraclePrice} --timestamp ${entryTimestamp}`;
    checkError(runCmd(setEntryCmd), false);
    console.log(`Oracle set: price=${entryOraclePrice}, timestamp=${entryTimestamp}`);

    // ===================================================
    // 2. DEPOSIT COLLATERAL INTO POOL
    // ===================================================
    const skipDeposit = process.env.E2E_SKIP_DEPOSIT === "1";

    if (skipDeposit) {
        console.log("\nE2E_SKIP_DEPOSIT=1 — resuming with existing pool leaves");
        const poolLeafCount = Number(
            parseInvokeOutput(
                runCmd(
                    `stellar contract invoke --id ${POOL_ID} --network ${NETWORK} --source ${SOURCE} -- get_leaf_count`
                ).output
            )
        );
        console.log(`Pool leaf count: ${poolLeafCount}`);
        if (poolLeafCount < 1) {
            throw new Error("Expected at least 1 pool leaf for resume, got " + poolLeafCount);
        }
        poolTree.insert(noteCommitment);
    } else {
        console.log("\n--- Depositing collateral ---");

        // Register ASP leaf for this user
        const aspLeaf = calculateHash2([pubX, pubY]);
        console.log(`ASP leaf: ${formatFr(aspLeaf).slice(0, 16)}...`);

        // Check if this leaf is already in the local tree (from bootstrap)
        const existingIndex = aspTree.leaves.indexOf(aspLeaf);
        if (existingIndex >= 0) {
            console.log(`ASP leaf already in local tree at index ${existingIndex}, skipping insert.`);
        } else {
            // New leaf — insert on-chain and into local tree
            insertAspLeafOnChain(aspLeaf);
            aspTree.insert(aspLeaf);
        }

        const aspLeafIndex = existingIndex >= 0 ? existingIndex : aspTree.leaves.length - 1;
        const aspProof = aspTree.getProof(aspLeafIndex);
        const aspRootAfter = BigInt("0x" + queryAspField("root")).toString(10);
        if (aspProof.root !== aspRootAfter) {
            throw new Error(
                `ASP root mismatch after leaf insert.\n` +
                `  local:  ${aspProof.root}\n` +
                `  chain:  ${aspRootAfter}`
            );
        }

        // Generate deposit proof
        let { proofStr, publicInputs } = generateProof("deposit", {
            amount: collateralAmount,
            commitment: noteCommitment,
            asp_root: aspProof.root,
            pubX: pubX,
            pubY: pubY,
            blindness: noteBlindness,
            asp_pathElements: aspProof.pathElements,
            asp_pathIndices: aspProof.pathIndices
        });

        let depositCmd = `stellar contract invoke --id ${POOL_ID} --network ${NETWORK} --source ${SOURCE} -- deposit --depositor ${deployerAddr} --proof "${proofStr.replace(/"/g, '\\"')}" --commitment "{\\\"bytes\\\":\\\"${formatFr(publicInputs[1])}\\\"}" --public_amount ${publicInputs[0]} --asp_root "{\\\"bytes\\\":\\\"${formatFr(publicInputs[2])}\\\"}"`
        checkError(runCmd(depositCmd), false);
        poolTree.insert(noteCommitment);
        console.log("Collateral deposited into pool.");
    }

    // ===================================================
    // 3. OPEN POSITION
    // ===================================================
    console.log("\n--- Opening position ---");

    // The collateral note is at pool index (poolTree.leaves.length - 1)
    const collateralIndex = poolTree.leaves.length - 1;
    const poolProof = poolTree.getProof(collateralIndex);
    const poolRoot = poolProof.root;

    // Note nullifier (consumes the deposited collateral note)
    const noteNullifier = calculateHash2([noteCommitment, priv]);

    // meta_hash for the open tx
    const openMetaHash = getMetaHash(deployerAddr, "0");

    // Position ID — a unique 32-byte identifier for this position
    const positionIdHex = "01".repeat(32);  // 0x0101...01

    // Generate position_open proof
    const openProofResult = generateProof("position_open", {
        root: poolRoot,
        nullifier: noteNullifier,
        position_commitment: posCommitment,
        meta_hash: openMetaHash,
        amount: collateralAmount,
        pubX: pubX,
        pubY: pubY,
        blindness: noteBlindness,
        privKey: priv,
        pathElements: poolProof.pathElements,
        pathIndices: poolProof.pathIndices,
        size: posSize,
        direction: posDirection,
        entry_price: posEntryPrice,
        position_blindness: posBlindness
    });

    // Call open_position on the position manager
    const openCmd = `stellar contract invoke --id ${POSITION_MANAGER_ID} --network ${NETWORK} --source ${SOURCE}` +
        ` -- open_position` +
        ` --position_id "{\\\"bytes\\\":\\\"${positionIdHex}\\\"}"` +
        ` --owner ${deployerAddr}` +
        ` --proof "${openProofResult.proofStr.replace(/"/g, '\\"')}"` +
        ` --root "{\\\"bytes\\\":\\\"${formatFr(openProofResult.publicInputs[0])}\\\"}"` +
        ` --nullifier "{\\\"bytes\\\":\\\"${formatFr(openProofResult.publicInputs[1])}\\\"}"` +
        ` --position_commitment "{\\\"bytes\\\":\\\"${formatFr(openProofResult.publicInputs[2])}\\\"}"` +
        ` --meta_hash "{\\\"bytes\\\":\\\"${formatFr(openProofResult.publicInputs[3])}\\\"}"`
    ;

    checkError(runCmd(openCmd), false);
    console.log(`\x1b[32m✅ Position opened! ID: ${positionIdHex.slice(0, 16)}...\x1b[0m`);

    // Verify position state on-chain
    console.log("Verifying position state on-chain...");
    const stateRes = runCmd(
        `stellar contract invoke --id ${POSITION_MANAGER_ID} --network ${NETWORK} --source ${SOURCE} -- get_position_state --position_id "{\\\"bytes\\\":\\\"${positionIdHex}\\\"}"`
    );
    if (!stateRes.success) {
        console.error("❌ Failed to read position state:", stateRes.output);
        process.exit(1);
    }
    console.log("Position state:", stateRes.output.trim().split('\n').slice(0, 5).join('\n'));

    // ===========
    // ===================================================
    // 4. MAKE STALE (ATTEST HEALTH WITH PAST TIMESTAMP)
    // ===================================================
    console.log("\n--- Making position stale (attest with past oracle) ---");

    const pastTimestamp = Math.floor(Date.now() / 1000) - 4000;
    const setPastCmd = `stellar contract invoke --id ${ORACLE_ID} --network ${NETWORK} --source ${SOURCE} -- set_price --price 2500 --timestamp ${pastTimestamp}`;
    checkError(runCmd(setPastCmd), false);
    console.log(`Oracle updated in past: price=2500, timestamp=${pastTimestamp}`);

    const healthThreshold = "500";
    const healthProofResult = generateProof("position_health", {
        position_commitment: posCommitment,
        oracle_price: "2500",
        oracle_timestamp: String(pastTimestamp),
        health_threshold: healthThreshold,
        collateral_amount: collateralAmount,
        size: posSize,
        direction: posDirection,
        entry_price: posEntryPrice,
        pubX: pubX,
        pubY: pubY,
        position_blindness: posBlindness,
        price_ge_entry: "1"
    });

    const attestCmd = `stellar contract invoke --id ${POSITION_MANAGER_ID} --network ${NETWORK} --source ${SOURCE}` +
        ` -- attest_health` +
        ` --position_id "{\\\"bytes\\\":\\\"${positionIdHex}\\\"}"` +
        ` --proof "${healthProofResult.proofStr.replace(/"/g, '\\"')}"`;

    checkError(runCmd(attestCmd), false);
    console.log(`\x1b[32m✅ Health attested in the past! (heartbeat = ${pastTimestamp})\x1b[0m`);

    // ===================================================
    // 5. LIQUIDATION (KEEPER)
    // ===================================================
    console.log("\n--- Keeper Liquidates Position ---");

    const KEEPER_ID = deployments.liquidation;
    if (!KEEPER_ID) throw new Error("Liquidation engine ID not found");

    const keeperSecret = "123456789";
    const keeperCommitment = calculateHash2([keeperSecret, "0"]);
    console.log(`Keeper secret: ${keeperSecret}`);
    console.log(`Keeper commitment: ${keeperCommitment}`);

    console.log("Initiating liquidation...");
    const initCmd = `stellar contract invoke --id ${KEEPER_ID} --network ${NETWORK} --source ${SOURCE}` +
        ` -- initiate_liquidation` +
        ` --position_id "{\\\"bytes\\\":\\\"${positionIdHex}\\\"}"` +
        ` --keeper_commitment "{\\\"bytes\\\":\\\"${formatFr(keeperCommitment)}\\\"}"`;
    checkError(runCmd(initCmd), false);
    console.log("\x1b[32m✅ Liquidation initiated.\x1b[0m");

    console.log("Generating liquidation proof...");
    const liqTimestamp = Math.floor(Date.now() / 1000);
    const liqProofResult = generateProof("liquidation_heartbeat", {
        position_commitment: posCommitment,
        keeper_public_commitment: keeperCommitment,
        timestamp: String(liqTimestamp),
        collateral_amount: collateralAmount,
        size: posSize,
        direction: posDirection,
        entry_price: posEntryPrice,
        pubX: pubX,
        pubY: pubY,
        position_blindness: posBlindness,
        keeper_secret: keeperSecret
    });

    const seizeAmount = "500"; 
    const keeperAddr = deployerAddr; 

    const seizeCmd = `stellar contract invoke --id ${KEEPER_ID} --network ${NETWORK} --source ${SOURCE}` +
        ` -- reveal_and_seize` +
        ` --position_id "{\\\"bytes\\\":\\\"${positionIdHex}\\\"}"` +
        ` --proof "${liqProofResult.proofStr.replace(/"/g, '\\"')}"` +
        ` --position_commitment "{\\\"bytes\\\":\\\"${formatFr(liqProofResult.publicInputs[0])}\\\"}"` +
        ` --keeper_public_commitment "{\\\"bytes\\\":\\\"${formatFr(liqProofResult.publicInputs[1])}\\\"}"` +
        ` --timestamp "{\\\"bytes\\\":\\\"${formatFr(liqProofResult.publicInputs[2])}\\\"}"` +
        ` --receiver ${keeperAddr}` +
        ` --seize_amount ${seizeAmount}`;
    
    checkError(runCmd(seizeCmd), false);
    console.log(`\x1b[32m✅ Position seized! Amount: ${seizeAmount}\x1b[0m`);

    console.log("\n\x1b[32m=== Sprint 2 — Liquidation Vertical E2E PASSED! ===\x1b[0m");
    console.log(`Position lifecycle: deposit → open → (stale) → initiate_liquidation → reveal_and_seize`);
}

main();
