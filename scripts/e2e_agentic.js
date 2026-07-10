/**
 * Vayyl Sprint 7 — Agentic Hub Verification
 *
 * Full lifecycle:
 *   1. create_quest (creator locks reward in pool)
 *   2. Generate SealedOrder proof (prove knowledge of quest preimage)
 *   3. claim_quest (reward paid to agent)
 *
 * Usage:
 *   pnpm exec node scripts/e2e_agentic.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const NETWORK = "testnet";
const SOURCE = "deployer";

const deployPath = path.join(__dirname, '../deployments', `${NETWORK}.json`);
const deployments = JSON.parse(fs.readFileSync(deployPath, 'utf8'));
const POOL_ID = process.env.POOL_ID || deployments.pool;
const AGENTIC_HUB_ID = deployments.agentic_hub;
const TOKEN_ID = deployments.token;

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

// Formatting functions
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

// Poseidon2 Hash3
function calculateHash3(inputs) {
    const cwd = path.join(__dirname, '../circuits');
    fs.writeFileSync(path.join(cwd, 'test/hash3_input.json'), JSON.stringify({ in: inputs }));
    execSync(`snarkjs wtns calculate build/diff_hash3_js/diff_hash3.wasm test/hash3_input.json build/hash3.wtns`, { cwd, stdio: 'ignore' });
    execSync(`snarkjs wtns export json build/hash3.wtns build/hash3_witness.json`, { cwd, stdio: 'ignore' });
    const witness = JSON.parse(fs.readFileSync(path.join(cwd, 'build/hash3_witness.json'), 'utf8'));
    return witness[1];
}

function generateProof(circuit, inputJson) {
    const cwd = path.join(__dirname, '../circuits');
    const inputPath = path.join(cwd, `test/input_${circuit}.json`);
    fs.writeFileSync(inputPath, JSON.stringify(inputJson, null, 2));

    console.log(`\x1b[35mGenerating proof for ${circuit}...\x1b[0m`);
    execSync(
        `snarkjs groth16 fullprove test/input_${circuit}.json build/wasm/${circuit}.wasm build/zkey/${circuit}_final.zkey build/${circuit}_proof.json build/${circuit}_public.json`,
        { cwd, stdio: 'ignore' }
    );

    return getProofArgs(
        path.join(cwd, `build/${circuit}_proof.json`),
        path.join(cwd, `build/${circuit}_public.json`)
    );
}

async function main() {
    console.log("=== Vayyl Sprint 7: Agentic Hub E2E ===");
    
    const deployerAddr = execSync(`stellar keys address ${SOURCE}`).toString().trim();
    console.log(`Deployer (Agent/Creator): ${deployerAddr}`);
    
    if (!AGENTIC_HUB_ID) throw new Error("AGENTIC_HUB_ID not set");

    // Mint tokens for the creator
    console.log("\n--- Minting 1000 tokens for deployer ---");
    let mintCmd = `stellar contract invoke --id ${TOKEN_ID} --network ${NETWORK} --source ${SOURCE} -- mint --to ${deployerAddr} --amount 1000`;
    runCmd(mintCmd);

    // ==========================================
    // 1. Create Quest
    // ==========================================
    console.log("\n--- Creating Quest ---");
    
    const bid_price = "100";
    const bid_size = "50";
    const salt = "987654321";
    const reward_amount = "250";
    const quest_id_hex = crypto.randomBytes(32).toString('hex');

    const quest_commitment = calculateHash3([bid_price, bid_size, salt]);
    console.log(`Quest Commitment: ${quest_commitment}`);

    let createCmd = `stellar contract invoke --id ${AGENTIC_HUB_ID} --network ${NETWORK} --source ${SOURCE} -- create_quest ` +
        `--quest_id "{\\"bytes\\":\\"${quest_id_hex}\\"}" ` +
        `--quest_commitment "{\\"bytes\\":\\"${formatFr(quest_commitment)}\\"}" ` +
        `--reward_amount ${reward_amount} ` +
        `--pool ${POOL_ID} ` +
        `--creator ${deployerAddr}`;
    
    checkError(runCmd(createCmd), false);

    // ==========================================
    // 2. Claim Quest
    // ==========================================
    console.log("\n--- Claiming Quest ---");
    
    const agent_nullifier = crypto.randomBytes(32).toString('hex');

    const { proofStr } = generateProof("sealed_order", {
        order_commitment: quest_commitment,
        bid_price: bid_price,
        bid_size: bid_size,
        salt: salt
    });

    let claimCmd = `stellar contract invoke --id ${AGENTIC_HUB_ID} --network ${NETWORK} --source ${SOURCE} -- claim_quest ` +
        `--quest_id "{\\"bytes\\":\\"${quest_id_hex}\\"}" ` +
        `--proof "${proofStr.replace(/"/g, '\\"')}" ` +
        `--agent_nullifier "{\\"bytes\\":\\"${agent_nullifier}\\"}" ` +
        `--recipient ${deployerAddr}`;

    checkError(runCmd(claimCmd), false);
    
    console.log("\n\x1b[32m=== E2E Agentic Hub Complete! ===\x1b[0m");
}

main().catch(console.error);
