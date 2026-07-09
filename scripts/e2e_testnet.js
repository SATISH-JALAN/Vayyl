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

function runCmd(cmd, opts = {}) {
    console.log(`\x1b[36mRunning:\x1b[0m ${cmd}`);
    try {
        const out = execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts });
        return { success: true, output: out };
    } catch (e) {
        const out = (e.stdout || "") + "\n" + (e.stderr || "");
        // Workaround for soroban-spec-tools panic when parsing return values of successful txs
        if (out.includes("Transaction submitted successfully!")) {
            return { success: true, output: out };
        }
        return { success: false, output: out };
    }
}

// ---------------------------------------------------------
// Poseidon2 JS wrappers (calling WASM circuit out-of-band)
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
// Cryptography & Trees
// ---------------------------------------------------------
const TREE_DEPTH = 20;
let emptyLadder = ["0"];
for (let i = 1; i <= TREE_DEPTH; i++) {
    emptyLadder[i] = calculateHash2([emptyLadder[i-1], emptyLadder[i-1]]);
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
        let current = this.leaves[index];
        let pathElements = [];
        let pathIndices = [];
        
        // This is a naive recalculation for small trees.
        // For a full tree we'd cache nodes, but for E2E we only have a few leaves.
        let nodes = [...this.leaves];
        
        let pathIndex = index;
        for (let level = 0; level < this.depth; level++) {
            const isRight = pathIndex % 2 === 1;
            pathIndices.push(isRight ? 1 : 0);
            
            // Get sibling
            let siblingIndex = isRight ? pathIndex - 1 : pathIndex + 1;
            let sibling = siblingIndex < nodes.length ? nodes[siblingIndex] : emptyLadder[level];
            pathElements.push(sibling);

            // Compute next level nodes
            let nextNodes = [];
            for (let i = 0; i < nodes.length; i += 2) {
                let left = nodes[i];
                let right = i + 1 < nodes.length ? nodes[i+1] : emptyLadder[level];
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
    execSync(`snarkjs groth16 fullprove test/input_${circuit}.json build/wasm/${circuit}.wasm build/zkey/${circuit}_final.zkey build/${circuit}_proof.json build/${circuit}_public.json`, { cwd, stdio: 'ignore' });
    
    return getProofArgs(path.join(cwd, `build/${circuit}_proof.json`), path.join(cwd, `build/${circuit}_public.json`));
}

// ---------------------------------------------------------
// Soroban Invocation Helpers
// ---------------------------------------------------------
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
    const insertCmd = `stellar contract invoke --id ${ASP_MEMBERSHIP_ID} --network ${NETWORK} --source ${SOURCE} -- insert_leaf --leaf "{\\"bytes\\":\\"${leafHex}\\"}"`;
    const res = runCmd(insertCmd);
    if (!res.success && res.output.includes("Error(Contract, #5)")) {
        console.log(`ASP leaf ${leafHex.slice(0, 16)}... already exists, continuing...`);
        return;
    }
    checkError(res, false);
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

async function main() {
    console.log("=== Vayyl Integration Test on Testnet ===");
    
    const deployerAddr = execSync(`stellar keys address ${SOURCE}`).toString().trim();
    console.log(`Deployer: ${deployerAddr}`);
    
    if (!POOL_ID) throw new Error("POOL_ID not set");

    console.log(`\nSyncing ASP tree with on-chain state...`);
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
    const pubX1 = "12345", pubY1 = "67890", priv1 = "11111";
    const amount1 = "1000";
    const blindness1 = "99999";
    const commitment1 = calculateHash4([amount1, pubX1, pubY1, blindness1]);

    const skipDeposits = process.env.E2E_SKIP_DEPOSITS === "1";

    if (skipDeposits) {
        console.log("\nE2E_SKIP_DEPOSITS=1 — resuming after on-chain deposits");
        const poolLeafCount = Number(
            parseInvokeOutput(
                runCmd(
                    `stellar contract invoke --id ${POOL_ID} --network ${NETWORK} --source ${SOURCE} -- get_leaf_count`
                ).output
            )
        );
        if (poolLeafCount < 2) {
            throw new Error(`Expected at least 2 pool leaves for resume, got ${poolLeafCount}`);
        }
        poolTree.insert(commitment1);
        const pubX2 = "54321", pubY2 = "09876", priv2 = "22222";
        const amount2 = "500";
        const blindness2 = "88888";
        const commitment2 = calculateHash4([amount2, pubX2, pubY2, blindness2]);
        poolTree.insert(commitment2);
        // Fall through to transfer using the variables below.
        globalThis.__e2eResume = { pubX2, pubY2, priv2, amount2, blindness2, commitment2 };
    } else {

    // ==========================================
    // 1. DEPOSIT 1
    // ==========================================
    console.log(`\nRegistering Deposit 1 leaf in ASP contract...`);
    const leaf1 = calculateHash2([pubX1, pubY1]);
    insertAspLeafOnChain(leaf1);
    aspTree.insert(leaf1);
    const aspProof1 = aspTree.getProof(aspTree.leaves.length - 1);
    const aspRootAfter1 = BigInt("0x" + queryAspField("root")).toString(10);
    if (aspProof1.root !== aspRootAfter1) {
        throw new Error(
            `ASP root mismatch after deposit-1 leaf insert.\n` +
            `  local:  ${aspProof1.root}\n` +
            `  chain:  ${aspRootAfter1}`
        );
    }

    console.log("\n--- Executing Deposit 1 ---");
    let { proofStr, publicInputs } = generateProof("deposit", {
        amount: amount1,
        commitment: commitment1,
        asp_root: aspProof1.root,
        pubX: pubX1,
        pubY: pubY1,
        blindness: blindness1,
        asp_pathElements: aspProof1.pathElements,
        asp_pathIndices: aspProof1.pathIndices
    });

    let depositCmd = `stellar contract invoke --id ${POOL_ID} --network ${NETWORK} --source ${SOURCE} -- deposit --depositor ${deployerAddr} --proof "${proofStr.replace(/"/g, '\\"')}" --commitment "{\\"bytes\\":\\"${formatFr(publicInputs[1])}\\"}" --public_amount ${publicInputs[0]} --asp_root "{\\"bytes\\":\\"${formatFr(publicInputs[2])}\\"}"`;
    
    checkError(runCmd(depositCmd), false);
    poolTree.insert(commitment1);

    // ==========================================
    // 2. DEPOSIT 2
    // ==========================================
    console.log("\n--- Executing Deposit 2 ---");
    const pubX2Local = "54321", pubY2Local = "09876", priv2Local = "22222";
    const leaf2 = calculateHash2([pubX2Local, pubY2Local]);

    console.log(`Registering Deposit 2 leaf in ASP contract...`);
    insertAspLeafOnChain(leaf2);
    aspTree.insert(leaf2);
    const aspProof2 = aspTree.getProof(aspTree.leaves.length - 1);
    const aspRootAfter2 = BigInt("0x" + queryAspField("root")).toString(10);
    if (aspProof2.root !== aspRootAfter2) {
        throw new Error(
            `ASP root mismatch after deposit-2 leaf insert.\n` +
            `  local:  ${aspProof2.root}\n` +
            `  chain:  ${aspRootAfter2}`
        );
    }

    const amount2Local = "500";
    const blindness2Local = "88888";
    const commitment2Local = calculateHash4([amount2Local, pubX2Local, pubY2Local, blindness2Local]);
    
    let proof2 = generateProof("deposit", {
        amount: amount2Local,
        commitment: commitment2Local,
        asp_root: aspProof2.root,
        pubX: pubX2Local,
        pubY: pubY2Local,
        blindness: blindness2Local,
        asp_pathElements: aspProof2.pathElements,
        asp_pathIndices: aspProof2.pathIndices
    });

    depositCmd = `stellar contract invoke --id ${POOL_ID} --network ${NETWORK} --source ${SOURCE} -- deposit --depositor ${deployerAddr} --proof "${proof2.proofStr.replace(/"/g, '\\"')}" --commitment "{\\"bytes\\":\\"${formatFr(proof2.publicInputs[1])}\\"}" --public_amount ${proof2.publicInputs[0]} --asp_root "{\\"bytes\\":\\"${formatFr(proof2.publicInputs[2])}\\"}"`;
    checkError(runCmd(depositCmd), false);
    poolTree.insert(commitment2Local);

    } // end skipDeposits else

    const pubX2 = globalThis.__e2eResume?.pubX2 ?? "54321";
    const pubY2 = globalThis.__e2eResume?.pubY2 ?? "09876";
    const priv2 = globalThis.__e2eResume?.priv2 ?? "22222";
    const amount2 = globalThis.__e2eResume?.amount2 ?? "500";
    const blindness2 = globalThis.__e2eResume?.blindness2 ?? "88888";
    const commitment2 = globalThis.__e2eResume?.commitment2 ?? calculateHash4([amount2, pubX2, pubY2, blindness2]);

    // ==========================================
    // 3. TRANSFER
    // ==========================================
    console.log("\n--- Executing Transfer ---");
    // Send 1400 to new note, 100 to change note, 0 fee. (1000+500 = 1400+100+0)
    const out_amount1 = "1400";
    const out_blindness1 = "77777";
    const out_pubX1 = pubX1, out_pubY1 = pubY1;
    const out_commitment1 = calculateHash4([out_amount1, out_pubX1, out_pubY1, out_blindness1]);

    const out_amount2 = "100";
    const out_blindness2 = "66666";
    const out_pubX2 = pubX2, out_pubY2 = pubY2;
    const out_commitment2 = calculateHash4([out_amount2, out_pubX2, out_pubY2, out_blindness2]);

    const nullifier1 = calculateHash2([commitment1, priv1]);
    const nullifier2 = calculateHash2([commitment2, priv2]);
    
    const poolProof1 = poolTree.getProof(0);
    const poolProof2 = poolTree.getProof(1);
    const poolRoot = poolProof1.root; // Both have same root since tree is at 2 leaves
    
    // Calculate meta_hash: relayer + fee
    const { xdr, StrKey } = require('@stellar/stellar-base');
    const crypto = require('crypto');

    function getMetaHash(addressStr, fee) {
        const pubkey = StrKey.decodeEd25519PublicKey(addressStr);
        const scAddress = xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(pubkey)
        );
        // Soroban's Address::to_xdr() wraps in ScVal::Address envelope
        const scVal = xdr.ScVal.scvAddress(scAddress);
        const addressXdr = scVal.toXDR();
        const feeBuffer = Buffer.alloc(16);
        feeBuffer.writeBigUInt64BE(BigInt(fee), 8);
        const bytes = Buffer.concat([addressXdr, feeBuffer]);
        const hash = crypto.createHash('sha256').update(bytes).digest();
        hash[0] &= 0x1F;
        return BigInt("0x" + hash.toString('hex')).toString(10);
    }

    function getWithdrawBinding(addressStr, amount) {
        const pubkey = StrKey.decodeEd25519PublicKey(addressStr);
        const scAddress = xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(pubkey)
        );
        // Soroban's Address::to_xdr() wraps in ScVal::Address envelope
        const scVal = xdr.ScVal.scvAddress(scAddress);
        const addressXdr = scVal.toXDR();
        const amtBuffer = Buffer.alloc(16);
        amtBuffer.writeBigUInt64BE(BigInt(amount), 8);
        const bytes = Buffer.concat([addressXdr, amtBuffer]);
        const hash = crypto.createHash('sha256').update(bytes).digest();
        hash[0] &= 0x1F;
        return BigInt("0x" + hash.toString('hex')).toString(10);
    }

    const fee = "0";
    const meta_hash = getMetaHash(deployerAddr, fee);
    
    let transferInput = {
        root: poolRoot,
        nullifier1,
        nullifier2,
        commitment1: out_commitment1,
        commitment2: out_commitment2,
        fee: fee,
        meta_hash: meta_hash,
        
        in_amount1: amount1,
        in_pubX1: pubX1,
        in_pubY1: pubY1,
        in_blindness1: blindness1,
        in_privKey1: priv1,
        in_pathElements1: poolProof1.pathElements,
        in_pathIndices1: poolProof1.pathIndices,

        in_amount2: amount2,
        in_pubX2: pubX2,
        in_pubY2: pubY2,
        in_blindness2: blindness2,
        in_privKey2: priv2,
        in_pathElements2: poolProof2.pathElements,
        in_pathIndices2: poolProof2.pathIndices,

        out_amount1: out_amount1,
        out_pubX1: out_pubX1,
        out_pubY1: out_pubY1,
        out_blindness1: out_blindness1,

        out_amount2: out_amount2,
        out_pubX2: out_pubX2,
        out_pubY2: out_pubY2,
        out_blindness2: out_blindness2
    };
    
    let proofTransfer = generateProof("transfer", transferInput);

    let transferCmd = `stellar contract invoke --id ${POOL_ID} --network ${NETWORK} --source ${SOURCE} -- transfer --proof "${proofTransfer.proofStr.replace(/"/g, '\\"')}" --nullifier1 "{\\"bytes\\":\\"${formatFr(transferInput.nullifier1)}\\"}" --nullifier2 "{\\"bytes\\":\\"${formatFr(transferInput.nullifier2)}\\"}" --commitment1 "{\\"bytes\\":\\"${formatFr(transferInput.commitment1)}\\"}" --commitment2 "{\\"bytes\\":\\"${formatFr(transferInput.commitment2)}\\"}" --root "{\\"bytes\\":\\"${formatFr(transferInput.root)}\\"}" --fee ${fee} --relayer ${deployerAddr}`;
    checkError(runCmd(transferCmd), false);
    poolTree.insert(out_commitment1);
    poolTree.insert(out_commitment2);
    
    console.log("Checking double-spend rejection for transfer...");
    checkError(runCmd(transferCmd), true);

    // ==========================================
    // 4. WITHDRAW
    // ==========================================
    console.log("\n--- Executing Withdraw ---");
    // Withdraw from out_commitment1 (amount: 1400)
    const withdraw_amount = "1400";
    const withdraw_fee = "0";
    const withdraw_binding = getWithdrawBinding(deployerAddr, withdraw_amount);
    const withdraw_nullifier = calculateHash2([out_commitment1, priv1]);
    
    const poolProof3 = poolTree.getProof(2); // out_commitment1 is at index 2
    
    let withdrawInput = {
        root: poolProof3.root,
        nullifier: withdraw_nullifier,
        public_amount: withdraw_amount,
        fee: withdraw_fee,
        withdraw_binding: withdraw_binding,

        amount: out_amount1,
        pubX: out_pubX1,
        pubY: out_pubY1,
        blindness: out_blindness1,
        privKey: priv1,
        pathElements: poolProof3.pathElements,
        pathIndices: poolProof3.pathIndices
    };

    let proofWithdraw = generateProof("withdraw", withdrawInput);

    let withdrawCmd = `stellar contract invoke --id ${POOL_ID} --network ${NETWORK} --source ${SOURCE} -- withdraw --proof "${proofWithdraw.proofStr.replace(/"/g, '\\"')}" --nullifier "{\\"bytes\\":\\"${formatFr(withdrawInput.nullifier)}\\"}" --public_amount ${withdraw_amount} --recipient ${deployerAddr} --root "{\\"bytes\\":\\"${formatFr(withdrawInput.root)}\\"}" --fee ${withdraw_fee} --relayer ${deployerAddr}`;
    checkError(runCmd(withdrawCmd), false);

    console.log("Checking double-spend rejection for withdraw...");
    checkError(runCmd(withdrawCmd), true);

    console.log("\n\x1b[32m=== All Sprint 4 Payment Flow Tests Passed! ===\x1b[0m");
}

main();
