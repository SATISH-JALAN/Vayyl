#!/usr/bin/env node

/**
 * Poseidon2 Parameter Converter
 * =============================
 * Reads the hex round constants from rs-soroban-poseidon/src/poseidon2/params.rs
 * and converts them to decimal strings for use in Circom circuits.
 *
 * Usage: node scripts/generate-circom-params.js <path-to-params.rs> <output-dir>
 *
 * Output: generates poseidon2_constants_t2.circom, poseidon2_constants_t3.circom, 
 * and poseidon2_constants_t4.circom with decimal round constants.
 */

const fs = require('fs');
const path = require('path');

/**
 * Convert a hex string (with or without 0x prefix) to a decimal string.
 * Handles big integers that don't fit in JavaScript's Number type.
 */
function hexToDecimal(hexStr) {
    const cleaned = hexStr.replace(/^0x/i, '').replace(/[_\s]/g, '');
    return BigInt('0x' + cleaned).toString(10);
}

/**
 * Parse round constants from params.rs for a given state width.
 * Looks for functions like `get_rc_bn254_t_2()` and extracts hex values.
 */
function parseRoundConstants(paramsContent, stateWidth) {
    const funcName = `get_rc_bn254_t_${stateWidth}`;
    const funcStart = paramsContent.indexOf(funcName);
    if (funcStart === -1) {
        console.error(`Function ${funcName} not found in params.rs`);
        process.exit(1);
    }

    // Extract the function body
    const vecStart = paramsContent.indexOf('vec![', funcStart);
    if (vecStart === -1) {
        console.error(`Could not find vec![ in ${funcName}`);
        process.exit(1);
    }

    // Find matching bracket
    let depth = 0;
    let i = vecStart;
    let vecEnd = -1;
    for (; i < paramsContent.length; i++) {
        if (paramsContent[i] === '[') depth++;
        if (paramsContent[i] === ']') {
            depth--;
            if (depth === 0) {
                vecEnd = i;
                break;
            }
        }
    }

    if (vecEnd === -1) {
        console.error(`Could not find closing bracket for vec![ in ${funcName}`);
        process.exit(1);
    }

    const body = paramsContent.substring(vecStart, vecEnd + 1);

    // Extract all hex values (BN254 field elements start with 0x)
    const hexPattern = /0x[0-9a-fA-F_]+/g;
    const matches = [...body.matchAll(hexPattern)];
    const values = matches.map(m => hexToDecimal(m[0]));

    console.log(`  ${funcName}: found ${values.length} constants (expected ${64 * stateWidth})`);
    return values;
}

/**
 * Parse the internal matrix diagonal for a given state width.
 */
function parseMatInternalDiag(paramsContent, stateWidth) {
    // For t=2 and t=3, values are canonical small numbers
    if (stateWidth === 2) return ['1', '2'];
    if (stateWidth === 3) return ['1', '1', '2'];

    // For t=4, extract from the params file
    const funcName = `get_mat_internal_diag_m_1_bn254_t_4`;
    const funcStart = paramsContent.indexOf(funcName);
    if (funcStart === -1) {
        // Fall back to hardcoded values from POSEIDON2_PARAMS.md
        return [
            hexToDecimal('0x10dc6e9c006ea38b04b1e03b4bd9490c0d03f98929ca1d7fb56821fd19d3b6e7'),
            hexToDecimal('0x0c28145b6a44df3e0149b3d0a30b3bb599df9756d4dd9b84a86b38cfb45a740b'),
            hexToDecimal('0x00544b8338791518b2c7645a50392798b21f75bb60e3596170067d00141cac15'),
            hexToDecimal('0x222c01175718386f2e2e82eb122789e352e105a3b8fa852613bc534433ee428b'),
        ];
    }

    const vecStart = paramsContent.indexOf('vec![', funcStart);
    const body = paramsContent.substring(vecStart, paramsContent.indexOf(']', vecStart) + 1);
    const hexPattern = /0x[0-9a-fA-F_]+/g;
    const matches = [...body.matchAll(hexPattern)];
    return matches.map(m => hexToDecimal(m[0]));
}

/**
 * Generate a Circom file with round constants for a given state width.
 */
function generateCircomConstants(roundConstants, matDiag, stateWidth, outputPath) {
    const numRounds = 64;
    const rate = stateWidth - 1;

    let circom = `pragma circom 2.1.0;\n\n`;
    circom += `// ============================================================\n`;
    circom += `// AUTO-GENERATED — do not edit manually\n`;
    circom += `// Source: rs-soroban-poseidon/src/poseidon2/params.rs\n`;
    circom += `// State width: t=${stateWidth}, Rate: ${rate}\n`;
    circom += `// Full rounds: 8 (4+4), Partial rounds: 56, Total: 64\n`;
    circom += `// ============================================================\n\n`;

    // Round constants as a function
    circom += `function poseidon2_rc_t${stateWidth}(round, idx) {\n`;
    circom += `    var RC[${numRounds}][${stateWidth}];\n\n`;

    for (let r = 0; r < numRounds; r++) {
        circom += `    // Round ${r}\n`;
        for (let j = 0; j < stateWidth; j++) {
            const idx = r * stateWidth + j;
            if (idx < roundConstants.length) {
                circom += `    RC[${r}][${j}] = ${roundConstants[idx]};\n`;
            } else {
                circom += `    RC[${r}][${j}] = 0;\n`;
            }
        }
        circom += `\n`;
    }

    circom += `    return RC[round][idx];\n`;
    circom += `}\n\n`;

    // Internal matrix diagonal
    circom += `function poseidon2_mat_diag_t${stateWidth}(idx) {\n`;
    circom += `    var DIAG[${stateWidth}];\n`;
    for (let j = 0; j < stateWidth; j++) {
        circom += `    DIAG[${j}] = ${matDiag[j]};\n`;
    }
    circom += `    return DIAG[idx];\n`;
    circom += `}\n`;

    fs.writeFileSync(outputPath, circom);
    console.log(`  Written: ${outputPath}`);
}

// Main
function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log('Usage: node generate-circom-params.js <path-to-params.rs> <output-dir>');
        console.log('');
        console.log('Example:');
        console.log('  node scripts/generate-circom-params.js rs-soroban-poseidon/src/poseidon2/params.rs circuits/lib/');
        process.exit(1);
    }

    const paramsPath = args[0];
    const outputDir = args[1];

    if (!fs.existsSync(paramsPath)) {
        console.error(`Error: ${paramsPath} not found.`);
        console.error('Clone rs-soroban-poseidon first:');
        console.error('  git clone https://github.com/AKStmpfli/rs-soroban-poseidon.git');
        process.exit(1);
    }

    console.log(`Reading Poseidon2 parameters from: ${paramsPath}`);
    const content = fs.readFileSync(paramsPath, 'utf8');

    for (const t of [2, 3, 4]) {
        console.log(`\nProcessing t=${t}:`);
        const rc = parseRoundConstants(content, t);
        const diag = parseMatInternalDiag(content, t);
        const outputPath = path.join(outputDir, `poseidon2_constants_t${t}.circom`);
        generateCircomConstants(rc, diag, t, outputPath);
    }

    console.log('\nDone! Generated Circom constant files for all state widths.');
    console.log('Next: implement the Poseidon2 permutation template in circuits/lib/poseidon2.circom');
}

main();
