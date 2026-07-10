/**
 * Vayyl Sprint 7 — Hidden Orders Verification
 *
 * Full lifecycle:
 *   1. commit_order (depositor locks escrow in pool)
 *   2. Generate HiddenOrderTrigger proof (simulate oracle condition met)
 *   3. reveal_and_execute (escrow paid to recipient)
 *
 * Usage:
 *   pnpm exec node scripts/e2e_hidden_order.js
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
const ORDER_REGISTRY_ID = deployments.order_registry;
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

// Poseidon2 Hash3 (for trigger commitment)
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

function getMetaHash(addressStr, fee) {
    const { xdr, StrKey } = require('@stellar/stellar-base');
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

async function main() {
    console.log("=== Vayyl Sprint 7: Hidden Order E2E ===");
    
    const deployerAddr = execSync(`stellar keys address ${SOURCE}`).toString().trim();
    console.log(`Deployer: ${deployerAddr}`);
    
    if (!ORDER_REGISTRY_ID) throw new Error("ORDER_REGISTRY_ID not set");

    // Let's make sure the deployer has enough tokens.
    // We will just mint some in case.
    console.log("\n--- Minting 1000 tokens for deployer ---");
    let mintCmd = `stellar contract invoke --id ${TOKEN_ID} --network ${NETWORK} --source ${SOURCE} -- mint --to ${deployerAddr} --amount 1000`;
    runCmd(mintCmd); // Ignore errors if already minted or not admin

    // ==========================================
    // 1. Commit Order
    // ==========================================
    console.log("\n--- Committing Hidden Order ---");
    
    // Order_commitment = Hash3(trigger_price, order_direction, salt)
    const trigger_price = "1500";
    const order_direction = "1"; // fire on price >= trigger
    const salt = "123456789";
    const escrow_amount = "500";
    const order_id_hex = crypto.randomBytes(32).toString('hex');

    const order_commitment = calculateHash3([trigger_price, order_direction, salt]);
    console.log(`Order Commitment: ${order_commitment}`);

    let commitCmd = `stellar contract invoke --id ${ORDER_REGISTRY_ID} --network ${NETWORK} --source ${SOURCE} -- commit_order ` +
        `--order_id "{\\"bytes\\":\\"${order_id_hex}\\"}" ` +
        `--commitment "{\\"bytes\\":\\"${formatFr(order_commitment)}\\"}" ` +
        `--escrow_amount ${escrow_amount} ` +
        `--pool ${POOL_ID} ` +
        `--depositor ${deployerAddr}`;
    
    checkError(runCmd(commitCmd), false);

    // ==========================================
    // 2. Reveal and Execute
    // ==========================================
    console.log("\n--- Revealing and Executing Order ---");
    
    const oracle_price = "2000"; // Trigger condition met (2000 >= 1500)
    const meta_hash = getMetaHash(deployerAddr, 0);

    const { proofStr, publicInputs } = generateProof("hidden_order_trigger", {
        order_commitment: order_commitment,
        oracle_price: oracle_price,
        meta_hash: meta_hash,
        trigger_price: trigger_price,
        order_direction: order_direction,
        salt: salt
    });

    let executeCmd = `stellar contract invoke --id ${ORDER_REGISTRY_ID} --network ${NETWORK} --source ${SOURCE} -- reveal_and_execute ` +
        `--order_id "{\\"bytes\\":\\"${order_id_hex}\\"}" ` +
        `--proof "${proofStr.replace(/"/g, '\\"')}" ` +
        `--oracle_price ${oracle_price} ` +
        `--meta_hash "{\\"bytes\\":\\"${formatFr(meta_hash)}\\"}" ` +
        `--recipient ${deployerAddr}`;

    checkError(runCmd(executeCmd), false);
    
    console.log("\n\x1b[32m=== E2E Hidden Order Complete! ===\x1b[0m");
}

main().catch(console.error);
