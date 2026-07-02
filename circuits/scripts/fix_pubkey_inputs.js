/**
 * Compute the BabyJubjub public key for a given private key.
 * Uses the DerivePublicKey test circuit approach.
 */
const fs = require('fs');
const path = require('path');

async function main() {
    // First, compile a derive_pubkey test circuit
    const testCircuit = `
pragma circom 2.1.0;
include "../lib/babyjubjub.circom";

template TestDeriveKey() {
    signal input privKey;
    signal output pubX;
    signal output pubY;
    
    component dk = DerivePublicKey();
    dk.privKey <== privKey;
    pubX <== dk.pubX;
    pubY <== dk.pubY;
}

component main = TestDeriveKey();
`;
    
    const testPath = path.join(__dirname, '../test/test_derive_key.circom');
    fs.writeFileSync(testPath, testCircuit);

    console.log('Compiling DerivePublicKey test circuit...');
    const { execSync } = require('child_process');
    execSync('circom test/test_derive_key.circom --r1cs --wasm -o build/', { 
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
    });

    // Now compute the public key for privKey=42
    const wasmPath = path.join(__dirname, '../build/test_derive_key_js/test_derive_key.wasm');
    const wc = require(path.join(__dirname, '../build/test_derive_key_js/witness_calculator.js'));
    const wasmBuffer = fs.readFileSync(wasmPath);
    const calculator = await wc(wasmBuffer);
    
    const w = await calculator.calculateWitness({ privKey: '42' }, true);
    const pubX = w[1].toString();
    const pubY = w[2].toString();

    console.log(`\nDerived BabyJubjub public key for privKey=42:`);
    console.log(`  pubX = ${pubX}`);
    console.log(`  pubY = ${pubY}`);

    // Now recompute all hashes with the real pubkey
    const hash2Wasm = path.join(__dirname, '../build/hash2_js/hash2.wasm');
    const hash4Wasm = path.join(__dirname, '../build/hash4_js/hash4.wasm');
    
    const wc2 = require(path.join(__dirname, '../build/hash2_js/witness_calculator.js'));
    const calc2 = await wc2(fs.readFileSync(hash2Wasm));
    
    const wc4 = require(path.join(__dirname, '../build/hash4_js/witness_calculator.js'));
    const calc4 = await wc4(fs.readFileSync(hash4Wasm));

    async function hash2(a, b) {
        const w = await calc2.calculateWitness({ in: [a, b] }, true);
        return w[1].toString();
    }
    async function hash4(a, b, c, d) {
        const w = await calc4.calculateWitness({ in: [a, b, c, d] }, true);
        return w[1].toString();
    }

    const amount = '1000';
    const blindness = '99999';
    const privKey = '42';
    const size = '500';
    const direction = '1';
    const entry_price = '2000';
    const position_blindness = '77777';
    const oracle_price = '2500';
    const oracle_timestamp = '1720000000';
    const keeper_secret = '314159265';
    const depth = 20;

    // NoteCommitment with real pubkey
    console.log('\nRecomputing all hashes with real pubkey...');
    const note_commitment = await hash4(amount, pubX, pubY, blindness);
    console.log(`  note_commitment = ${note_commitment}`);

    const note_nullifier = await hash2(note_commitment, privKey);
    console.log(`  note_nullifier = ${note_nullifier}`);

    // Merkle root
    let current = note_commitment;
    for (let i = 0; i < depth; i++) {
        current = await hash2(current, '0');
    }
    const merkle_root = current;
    console.log(`  merkle_root = ${merkle_root}`);

    // Position commitment
    const pos_meta = await hash4(size, direction, entry_price, position_blindness);
    const position_commitment = await hash4(amount, pubX, pubY, pos_meta);
    console.log(`  position_commitment = ${position_commitment}`);

    // Keeper commitment
    const keeper_public_commitment = await hash2(keeper_secret, '0');
    console.log(`  keeper_public_commitment = ${keeper_public_commitment}`);

    // Position nullifier
    const pos_nullifier = await hash2(position_commitment, privKey);
    console.log(`  pos_nullifier = ${pos_nullifier}`);

    // New position (closed)
    const new_pos_meta = await hash4('0', '0', '0', '55555');
    const new_position_commitment = await hash4('0', pubX, pubY, new_pos_meta);
    console.log(`  new_position_commitment = ${new_position_commitment}`);

    // Output note
    const output_note_commitment = await hash4('250900', pubX, pubY, '33333');
    console.log(`  output_note_commitment = ${output_note_commitment}`);

    // ─── Update ALL test input files ───
    console.log('\nUpdating all test input files with real pubkey...');

    // PositionOpen
    const posOpenPath = path.join(__dirname, '../test/input_position_open.json');
    const posOpen = JSON.parse(fs.readFileSync(posOpenPath, 'utf8'));
    posOpen.pubX = pubX;
    posOpen.pubY = pubY;
    posOpen.root = merkle_root;
    posOpen.nullifier = note_nullifier;
    posOpen.position_commitment = position_commitment;
    fs.writeFileSync(posOpenPath, JSON.stringify(posOpen, null, 2));
    console.log('  ✅ input_position_open.json');

    // PositionHealth
    const posHealthPath = path.join(__dirname, '../test/input_position_health.json');
    const posHealth = JSON.parse(fs.readFileSync(posHealthPath, 'utf8'));
    posHealth.pubX = pubX;
    posHealth.pubY = pubY;
    posHealth.position_commitment = position_commitment;
    fs.writeFileSync(posHealthPath, JSON.stringify(posHealth, null, 2));
    console.log('  ✅ input_position_health.json');

    // PositionClose
    const posClosePath = path.join(__dirname, '../test/input_position_close.json');
    const posClose = JSON.parse(fs.readFileSync(posClosePath, 'utf8'));
    posClose.old_pubX = pubX;
    posClose.old_pubY = pubY;
    posClose.new_pubX = pubX;
    posClose.new_pubY = pubY;
    posClose.note_pubX = pubX;
    posClose.note_pubY = pubY;
    posClose.position_nullifier = pos_nullifier;
    posClose.new_position_commitment = new_position_commitment;
    posClose.output_note_commitment = output_note_commitment;
    fs.writeFileSync(posClosePath, JSON.stringify(posClose, null, 2));
    console.log('  ✅ input_position_close.json');

    // LiquidationHeartbeat
    const liqPath = path.join(__dirname, '../test/input_liquidation_heartbeat.json');
    const liq = JSON.parse(fs.readFileSync(liqPath, 'utf8'));
    liq.pubX = pubX;
    liq.pubY = pubY;
    liq.position_commitment = position_commitment;
    liq.keeper_public_commitment = keeper_public_commitment;
    fs.writeFileSync(liqPath, JSON.stringify(liq, null, 2));
    console.log('  ✅ input_liquidation_heartbeat.json');

    console.log('\n=== Done — re-run test_sprint4_proofs.js to verify all 4 pass ===');
}

main().catch(err => { console.error(err); process.exit(1); });
