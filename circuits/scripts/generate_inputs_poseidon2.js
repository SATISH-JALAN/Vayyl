const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function runCmd(cmd) {
    execSync(cmd, { stdio: 'pipe' });
}

function calculateHash4(inputs) {
    const inputPath = path.join(__dirname, '../test/hash4_input.json');
    const wtnsPath = path.join(__dirname, '../build/hash4.wtns');
    const jsonPath = path.join(__dirname, '../build/hash4_witness.json');
    
    fs.writeFileSync(inputPath, JSON.stringify({ in: inputs }));
    runCmd(`snarkjs wtns calculate build/wasm/hash4_js/hash4.wasm test/hash4_input.json build/hash4.wtns`);
    runCmd(`snarkjs wtns export json build/hash4.wtns build/hash4_witness.json`);
    
    const witness = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    // out is the second element (witness[1])
    return witness[1];
}

function calculateHash2(inputs) {
    const inputPath = path.join(__dirname, '../test/hash2_input.json');
    const wtnsPath = path.join(__dirname, '../build/hash2.wtns');
    const jsonPath = path.join(__dirname, '../build/hash2_witness.json');
    
    fs.writeFileSync(inputPath, JSON.stringify({ in: inputs }));
    runCmd(`snarkjs wtns calculate build/wasm/hash2_js/hash2.wasm test/hash2_input.json build/hash2.wtns`);
    runCmd(`snarkjs wtns export json build/hash2.wtns build/hash2_witness.json`);
    
    const witness = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return witness[1];
}

function main() {
    console.log("Generating Deposit Inputs...");
    const amount = "1000";
    const pubX = "12345";
    const pubY = "67890";
    const blindness = "99999";

    // 1. Commitment = Poseidon2_4(amount, pubX, pubY, blindness)
    const commitment = calculateHash4([amount, pubX, pubY, blindness]);
    console.log("Commitment:", commitment);

    // 2. ASP Root. Tree depth 20. Leaf = Poseidon2_2(pubX, pubY)
    const leaf = calculateHash2([pubX, pubY]);
    
    const depth = 20;
    let current = leaf;
    const asp_pathElements = [];
    const asp_pathIndices = [];
    
    for (let i = 0; i < depth; i++) {
        asp_pathElements.push("0");
        asp_pathIndices.push(0);
        current = calculateHash2([current, "0"]);
    }
    const asp_root = current;
    console.log("ASP Root:", asp_root);

    const depositInput = {
        amount,
        commitment,
        asp_root,
        pubX,
        pubY,
        blindness,
        asp_pathElements,
        asp_pathIndices
    };

    fs.writeFileSync(
        path.join(__dirname, '../test/input_deposit.json'),
        JSON.stringify(depositInput, null, 2)
    );
    console.log("Wrote test/input_deposit.json");
}

main();
