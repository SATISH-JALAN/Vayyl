const fs = require('fs');

const vk = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const proof = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const publicInputs = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));

// Format to uncompressed 64-byte or 128-byte hex
function formatG1(pt) {
    let x = BigInt(pt[0]).toString(16).padStart(64, '0');
    let y = BigInt(pt[1]).toString(16).padStart(64, '0');
    return x + y;
}

function formatG2(pt) {
    // G2 in BN254 is typically represented as [x_c0, x_c1], [y_c0, y_c1] 
    // In uncompressed format it is X (c1 || c0), Y (c1 || c0)
    let x_c1 = BigInt(pt[0][1]).toString(16).padStart(64, '0');
    let x_c0 = BigInt(pt[0][0]).toString(16).padStart(64, '0');
    let y_c1 = BigInt(pt[1][1]).toString(16).padStart(64, '0');
    let y_c0 = BigInt(pt[1][0]).toString(16).padStart(64, '0');
    return x_c1 + x_c0 + y_c1 + y_c0;
}

function formatFr(scalar) {
    return BigInt(scalar).toString(16).padStart(64, '0');
}

const alpha_g1 = formatG1(vk.vk_alpha_1);
const beta_g2 = formatG2(vk.vk_beta_2);
const gamma_g2 = formatG2(vk.vk_gamma_2);
const delta_g2 = formatG2(vk.vk_delta_2);

let icStr = `[`;
for(let i = 0; i < vk.IC.length; i++) {
    icStr += `{"bytes": "${formatG1(vk.IC[i])}"}`;
    if(i < vk.IC.length - 1) icStr += `, `;
}
icStr += `]`;

const proof_a = formatG1(proof.pi_a);
const proof_b = formatG2(proof.pi_b);
const proof_c = formatG1(proof.pi_c);

let piStr = `[`;
for(let i = 0; i < publicInputs.length; i++) {
    piStr += `{"bytes": "${formatFr(publicInputs[i])}"}`;
    if(i < publicInputs.length - 1) piStr += `, `;
}
piStr += `]`;

const CONTRACT_ID = "CAF66DJHFFBMWQMCSD5IQPJS4ZOISWKABTTNERZGL7EVMLA554RPVKLO";

console.log("=== Set VK ===");
console.log(`stellar contract invoke --id ${CONTRACT_ID} --network testnet --source deployer -- set_vk \\`);
console.log(`--circuit_id Deposit \\`);
console.log(`--vk '{"alpha_g1": {"bytes": "${alpha_g1}"}, "beta_g2": {"bytes": "${beta_g2}"}, "gamma_g2": {"bytes": "${gamma_g2}"}, "delta_g2": {"bytes": "${delta_g2}"}, "ic": ${icStr}}'`);
console.log("\n");
console.log("=== Verify Proof ===");
console.log(`stellar contract invoke --id ${CONTRACT_ID} --network testnet --source deployer -- verify \\`);
console.log(`--circuit_id Deposit \\`);
console.log(`--proof '{"a": {"bytes": "${proof_a}"}, "b": {"bytes": "${proof_b}"}, "c": {"bytes": "${proof_c}"}}' \\`);
console.log(`--public_inputs '${piStr}'`);
