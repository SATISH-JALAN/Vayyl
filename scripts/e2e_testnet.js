const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const NETWORK = "testnet";
const SOURCE = "deployer";
const POOL_ID = process.env.POOL_ID || "CBRSJT5DZEFEYCYB4JFEHWDZJTIFOYAMRHECLSD7AYIKKYPGJT6RUYQA";

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

    let piStr = '[';
    for(let i = 0; i < publicInputs.length; i++) {
        piStr += `{"bytes": "${formatFr(publicInputs[i])}"}`;
        if(i < publicInputs.length - 1) piStr += ', ';
    }
    piStr += ']';

    const proofStr = `{"a": {"bytes": "${proof_a}"}, "b": {"bytes": "${proof_b}"}, "c": {"bytes": "${proof_c}"}}`;
    return { proofStr, piStr, publicInputs };
}

function runCmd(cmd) {
    console.log(`Running: ${cmd}`);
    try {
        execSync(cmd, { stdio: 'inherit' });
    } catch (e) {
        console.error(`Command failed`);
        process.exit(1);
    }
}

async function main() {
    console.log("=== Vayyl Integration Test on Testnet ===");
    
    // We need the Vayyl Pool ID and Deployer Address
    const deployerAddr = execSync(`stellar keys address ${SOURCE}`).toString().trim();
    console.log(`Deployer: ${deployerAddr}`);
    
    // 1. DEPOSIT
    console.log("--- Executing Deposit ---");
    const { proofStr, piStr, publicInputs } = getProofArgs(
        path.join(__dirname, '../circuits/build/deposit_proof.json'),
        path.join(__dirname, '../circuits/build/deposit_public.json')
    );
    
    // In deposit circuit public inputs: [amount, commitment, asp_root]
    // But wait, the pool contract expects: (depositor: Address, proof: Groth16Proof, commitment: BytesN<32>, public_amount: i128, asp_root: BytesN<32>)
    // So we don't pass public inputs array to `deposit`, we pass the parameters directly!
    // amount is publicInputs[0], commitment is publicInputs[1], asp_root is publicInputs[2]
    
    const amount = publicInputs[0];
    const commitment = formatFr(publicInputs[1]); // Wait, BytesN<32> needs 64 hex characters
    const asp_root = formatFr(publicInputs[2]);

    // const POOL_ID = process.env.POOL_ID; // handled at top
    if (!POOL_ID) throw new Error("POOL_ID not set");

    const escapedProof = proofStr.replace(/"/g, '\\"');
    const depositCmd = `stellar contract invoke --id ${POOL_ID} --network ${NETWORK} --source ${SOURCE} -- deposit --depositor ${deployerAddr} --proof "${escapedProof}" --commitment "{\\"bytes\\":\\"${commitment}\\"}" --public_amount ${amount} --asp_root "{\\"bytes\\":\\"${asp_root}\\"}"`;
    
    runCmd(depositCmd);
}

main();
