/**
 * Test all Sprint 4 circuits: generate proofs and verify locally.
 */
const snarkjs = require('snarkjs');
const fs = require('fs');
const path = require('path');

const CIRCUITS = [
    'position_open',
    'position_health', 
    'position_close',
    'liquidation_heartbeat'
];

async function main() {
    console.log('=== Sprint 4 — Full Proof Test Suite ===\n');
    
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const circuit of CIRCUITS) {
        const wasmPath = path.join(__dirname, `../build/wasm/${circuit}.wasm`);
        const zkeyPath = path.join(__dirname, `../build/zkey/${circuit}_final.zkey`);
        const inputPath = path.join(__dirname, `../test/input_${circuit}.json`);
        const vkeyPath = path.join(__dirname, `../build/vkey/${circuit}_vkey.json`);

        if (!fs.existsSync(wasmPath) || !fs.existsSync(zkeyPath) || !fs.existsSync(inputPath)) {
            console.log(`  [SKIP] ${circuit} — missing build artifacts`);
            skipped++;
            continue;
        }

        const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

        try {
            process.stdout.write(`  ${circuit}... `);
            const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
            
            const vkey = JSON.parse(fs.readFileSync(vkeyPath, 'utf8'));
            const isValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
            
            if (isValid) {
                console.log(`✅ PASS (${publicSignals.length} public signals)`);
                passed++;
                
                // Save proof
                fs.writeFileSync(
                    path.join(__dirname, `../build/${circuit}_proof.json`),
                    JSON.stringify(proof, null, 2)
                );
                fs.writeFileSync(
                    path.join(__dirname, `../build/${circuit}_public.json`),
                    JSON.stringify(publicSignals, null, 2)
                );
            } else {
                console.log(`❌ FAIL — proof verification returned false`);
                failed++;
            }
        } catch (err) {
            console.log(`❌ FAIL — ${err.message}`);
            failed++;
        }
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
