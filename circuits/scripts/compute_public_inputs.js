/**
 * Two-pass witness computation for Sprint 4 circuits.
 * 
 * Problem: The circuits constrain public_input === computed_value.
 * We can't provide placeholder public inputs — they must match exactly.
 * 
 * Solution: Use snarkjs's wtns.calculate to get the witness, then
 * extract the public signal values. But wtns.calculate also fails on
 * assertion mismatches.
 * 
 * Real solution: We need to compute the Poseidon2 hashes in JavaScript
 * to pre-compute the correct public inputs. Since Poseidon2 is custom
 * (not circomlib's Poseidon V1), we use the circuit's own WASM via
 * a helper circuit approach.
 * 
 * Simplest approach: Use the existing hash test circuits to compute
 * intermediate Poseidon2 hashes, then assemble the full inputs.
 */

const snarkjs = require('snarkjs');
const fs = require('fs');
const path = require('path');

// We'll use the test hash circuits to compute Poseidon2 hashes
const HASH2_WASM = path.join(__dirname, '../build/test_poseidon2_hash_1_js/test_poseidon2_hash_1.wasm');
const HASH4_WASM = path.join(__dirname, '../build/hash4_witness.json'); // Not the right approach

// Actually, let's use the actual wasm files for hash computation
// Check what test circuits we have compiled:

async function poseidon2Hash4(a, b, c, d) {
    // Use the hash4 test circuit: test/hash4.circom
    const wasmPath = path.join(__dirname, '../build/hash4.wasm');
    const jsPath = path.join(__dirname, '../build/hash4_js/hash4.wasm');
    
    // Try both paths
    let finalPath = null;
    for (const p of [wasmPath, jsPath]) {
        if (fs.existsSync(p)) { finalPath = p; break; }
    }
    
    if (!finalPath) {
        // Compile hash4 first
        console.log('  Compiling hash4 test circuit...');
        const { execSync } = require('child_process');
        execSync('circom test/hash4.circom --r1cs --wasm -o build/', { 
            cwd: path.join(__dirname, '..'),
            stdio: 'pipe'
        });
        finalPath = path.join(__dirname, '../build/hash4_js/hash4.wasm');
    }

    const input = { in: [a.toString(), b.toString(), c.toString(), d.toString()] };
    const wtns = { type: "mem" };
    await snarkjs.wtns.calculate(input, finalPath, wtns);
    
    // Output is witness[1] (first output signal after the constant 1)
    const witness = wtns;
    // Actually snarkjs.wtns.calculate returns the witness in a buffer
    // Let's use a different approach - use the wasm directly
    
    // Use wc (witness calculator) approach
    const wc = require(path.join(__dirname, '../build/hash4_js/witness_calculator.js'));
    const wasmBuffer = fs.readFileSync(finalPath);
    const calculator = await wc(wasmBuffer);
    const w = await calculator.calculateWitness(input, true);
    
    return w[1].toString();
}

async function poseidon2Hash2(a, b) {
    const wasmPath = path.join(__dirname, '../build/hash2.wasm');
    const jsPath = path.join(__dirname, '../build/hash2_js/hash2.wasm');
    
    let finalPath = null;
    for (const p of [wasmPath, jsPath]) {
        if (fs.existsSync(p)) { finalPath = p; break; }
    }
    
    if (!finalPath) {
        console.log('  Compiling hash2 test circuit...');
        const { execSync } = require('child_process');
        execSync('circom test/hash2.circom --r1cs --wasm -o build/', { 
            cwd: path.join(__dirname, '..'),
            stdio: 'pipe'
        });
        finalPath = path.join(__dirname, '../build/hash2_js/hash2.wasm');
    }

    const input = { in: [a.toString(), b.toString()] };
    
    const wc = require(path.join(__dirname, '../build/hash2_js/witness_calculator.js'));
    const wasmBuffer = fs.readFileSync(finalPath);
    const calculator = await wc(wasmBuffer);
    const w = await calculator.calculateWitness(input, true);
    
    return w[1].toString();
}

async function main() {
    console.log('=== Computing Poseidon2 hashes for Sprint 4 test inputs ===\n');

    // Shared test values (must match generate_position_inputs.js)
    const amount = '1000';
    const pubX = '12345';
    const pubY = '67890';
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

    // ─────────────────────────────────────────────────
    // Step 1: Compute NoteCommitment = Poseidon2Hash_4(amount, pubX, pubY, blindness)
    // ─────────────────────────────────────────────────
    console.log('Computing NoteCommitment...');
    const note_commitment = await poseidon2Hash4(amount, pubX, pubY, blindness);
    console.log(`  note_commitment = ${note_commitment}`);

    // Step 2: Compute NoteNullifier = Poseidon2Hash_2(commitment, privKey)
    console.log('Computing NoteNullifier...');
    const note_nullifier = await poseidon2Hash2(note_commitment, privKey);
    console.log(`  note_nullifier = ${note_nullifier}`);

    // Step 3: Compute Merkle root (all-zero path at index 0)
    console.log('Computing Merkle root...');
    let current = note_commitment;
    for (let i = 0; i < depth; i++) {
        current = await poseidon2Hash2(current, '0');
    }
    const merkle_root = current;
    console.log(`  merkle_root = ${merkle_root}`);

    // Step 4: Compute PositionCommitment
    // position_primitives.circom does:
    //   meta_hash = Poseidon2Hash_4(size, direction, entry_price, blindness)
    //   commitment = Poseidon2Hash_4(collateral_amount, pubX, pubY, meta_hash)
    console.log('Computing PositionCommitment...');
    const pos_meta = await poseidon2Hash4(size, direction, entry_price, position_blindness);
    console.log(`  pos_meta = ${pos_meta}`);
    const position_commitment = await poseidon2Hash4(amount, pubX, pubY, pos_meta);
    console.log(`  position_commitment = ${position_commitment}`);

    // Step 5: Compute KeeperPublicCommitment = Poseidon2Hash_2(keeper_secret, 0)
    console.log('Computing KeeperPublicCommitment...');
    const keeper_public_commitment = await poseidon2Hash2(keeper_secret, '0');
    console.log(`  keeper_public_commitment = ${keeper_public_commitment}`);

    // ─────────────────────────────────────────────────
    // Now update the test input files with correct public inputs
    // ─────────────────────────────────────────────────
    console.log('\nUpdating test input files...\n');

    // PositionOpen
    const posOpenInput = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/input_position_open.json'), 'utf8'));
    posOpenInput.root = merkle_root;
    posOpenInput.nullifier = note_nullifier;
    posOpenInput.position_commitment = position_commitment;
    fs.writeFileSync(
        path.join(__dirname, '../test/input_position_open.json'),
        JSON.stringify(posOpenInput, null, 2)
    );
    console.log('  ✅ Updated input_position_open.json');

    // PositionHealth
    const posHealthInput = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/input_position_health.json'), 'utf8'));
    posHealthInput.position_commitment = position_commitment;
    fs.writeFileSync(
        path.join(__dirname, '../test/input_position_health.json'),
        JSON.stringify(posHealthInput, null, 2)
    );
    console.log('  ✅ Updated input_position_health.json');

    // PositionClose — compute old position nullifier + new commitments
    console.log('\nComputing PositionClose values...');
    const old_pos_nullifier = await poseidon2Hash2(position_commitment, privKey);
    console.log(`  old_pos_nullifier = ${old_pos_nullifier}`);

    // New position (fully closed: all zeros except pubX/pubY/blindness)
    const new_pos_meta = await poseidon2Hash4('0', '0', '0', '55555');
    const new_position_commitment = await poseidon2Hash4('0', pubX, pubY, new_pos_meta);
    console.log(`  new_position_commitment = ${new_position_commitment}`);

    // Output note commitment
    const output_note_commitment = await poseidon2Hash4('250900', pubX, pubY, '33333');
    console.log(`  output_note_commitment = ${output_note_commitment}`);

    const posCloseInput = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/input_position_close.json'), 'utf8'));
    posCloseInput.position_nullifier = old_pos_nullifier;
    posCloseInput.new_position_commitment = new_position_commitment;
    posCloseInput.output_note_commitment = output_note_commitment;
    fs.writeFileSync(
        path.join(__dirname, '../test/input_position_close.json'),
        JSON.stringify(posCloseInput, null, 2)
    );
    console.log('  ✅ Updated input_position_close.json');

    // LiquidationHeartbeat
    const liqInput = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/input_liquidation_heartbeat.json'), 'utf8'));
    liqInput.position_commitment = position_commitment;
    liqInput.keeper_public_commitment = keeper_public_commitment;
    fs.writeFileSync(
        path.join(__dirname, '../test/input_liquidation_heartbeat.json'),
        JSON.stringify(liqInput, null, 2)
    );
    console.log('  ✅ Updated input_liquidation_heartbeat.json');

    console.log('\n=== All test inputs updated with correct public values ===');
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
