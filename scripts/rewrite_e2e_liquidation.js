const fs = require('fs');
const content = fs.readFileSync('scripts/e2e_liquidation.js', 'utf8');
const idx = content.indexOf('// 4. ATTEST HEALTH');
if (idx === -1) throw new Error('anchor not found');
const prefix = content.slice(0, idx - 45);

const newLogic = `
    // ===================================================
    // 4. MAKE STALE (ATTEST HEALTH WITH PAST TIMESTAMP)
    // ===================================================
    console.log("\\n--- Making position stale (attest with past oracle) ---");

    // We set oracle time to 4000 seconds ago so that when attest_health registers
    // the heartbeat, it registers it far in the past.
    // The grace period is 3600 seconds, so is_stale will be instantly true.
    const pastTimestamp = Math.floor(Date.now() / 1000) - 4000;
    const setPastCmd = \`stellar contract invoke --id \${ORACLE_ID} --network \${NETWORK} --source \${SOURCE} -- set_price --price \${entryOraclePrice} --timestamp \${pastTimestamp}\`;
    checkError(runCmd(setPastCmd), false);
    console.log(\`Oracle updated in past: price=\${entryOraclePrice}, timestamp=\${pastTimestamp}\`);

    const healthThreshold = "500";
    const healthProofResult = generateProof("position_health", {
        position_commitment: posCommitment,
        oracle_price: String(entryOraclePrice),
        oracle_timestamp: String(pastTimestamp),
        health_threshold: healthThreshold,
        collateral_amount: collateralAmount,
        size: posSize,
        direction: posDirection,
        entry_price: posEntryPrice,
        pubX: pubX,
        pubY: pubY,
        position_blindness: posBlindness,
        price_ge_entry: "1"
    });

    const attestCmd = \`stellar contract invoke --id \${POSITION_MANAGER_ID} --network \${NETWORK} --source \${SOURCE}\` +
        \` -- attest_health\` +
        \` --position_id "{\\\\\\"bytes\\\\\\":\\\\\\"\${positionIdHex}\\\\\\"}"\` +
        \` --proof "\${healthProofResult.proofStr.replace(/"/g, '\\\\"')}"\`;

    checkError(runCmd(attestCmd), false);
    console.log(\`\\x1b[32m✅ Health attested in the past! (heartbeat = \${pastTimestamp})\\x1b[0m\`);

    // ===================================================
    // 5. LIQUIDATION (KEEPER)
    // ===================================================
    console.log("\\n--- Keeper Liquidates Position ---");

    const KEEPER_ID = deployments.liquidation;
    if (!KEEPER_ID) throw new Error("Liquidation engine ID not found");

    // Keeper secret and commitment
    const keeperSecret = "123456789";
    // keeper_public_commitment = Poseidon2(keeperSecret, 0)
    const keeperCommitment = calculateHash2([keeperSecret, "0"]);
    console.log(\`Keeper secret: \${keeperSecret}\`);
    console.log(\`Keeper commitment: \${keeperCommitment}\`);

    // Initiate liquidation
    console.log("Initiating liquidation...");
    const initCmd = \`stellar contract invoke --id \${KEEPER_ID} --network \${NETWORK} --source \${SOURCE}\` +
        \` -- initiate_liquidation\` +
        \` --position_id "{\\\\\\"bytes\\\\\\":\\\\\\"\${positionIdHex}\\\\\\"}"\` +
        \` --keeper_commitment "{\\\\\\"bytes\\\\\\":\\\\\\"\${formatFr(keeperCommitment)}\\\\\\"}"\`;
    checkError(runCmd(initCmd), false);
    console.log("\\x1b[32m✅ Liquidation initiated.\\x1b[0m");

    // Generate liquidation heartbeat proof
    console.log("Generating liquidation proof...");
    const liqTimestamp = Math.floor(Date.now() / 1000);
    const liqProofResult = generateProof("liquidation_heartbeat", {
        position_commitment: posCommitment,
        keeper_public_commitment: keeperCommitment,
        timestamp: String(liqTimestamp),
        collateral_amount: collateralAmount,
        size: posSize,
        direction: posDirection,
        entry_price: posEntryPrice,
        pubX: pubX,
        pubY: pubY,
        position_blindness: posBlindness,
        keeper_secret: keeperSecret
    });

    // Reveal and seize
    const seizeAmount = "500"; // Take 500 of the 1000 collateral
    const keeperAddr = deployerAddr; // Receive to deployer for test

    const seizeCmd = \`stellar contract invoke --id \${KEEPER_ID} --network \${NETWORK} --source \${SOURCE}\` +
        \` -- reveal_and_seize\` +
        \` --position_id "{\\\\\\"bytes\\\\\\":\\\\\\"\${positionIdHex}\\\\\\"}"\` +
        \` --proof "\${liqProofResult.proofStr.replace(/"/g, '\\\\"')}"\` +
        \` --position_commitment "{\\\\\\"bytes\\\\\\":\\\\\\"\${formatFr(liqProofResult.publicInputs[0])}\\\\\\"}"\` +
        \` --keeper_public_commitment "{\\\\\\"bytes\\\\\\":\\\\\\"\${formatFr(liqProofResult.publicInputs[1])}\\\\\\"}"\` +
        \` --timestamp "{\\\\\\"bytes\\\\\\":\\\\\\"\${formatFr(liqProofResult.publicInputs[2])}\\\\\\"}"\` +
        \` --receiver \${keeperAddr}\` +
        \` --seize_amount \${seizeAmount}\`;
    
    checkError(runCmd(seizeCmd), false);
    console.log(\`\\x1b[32m✅ Position seized! Amount: \${seizeAmount}\\x1b[0m\`);

    // ===================================================
    // SUMMARY
    // ===================================================
    console.log("\\n\\x1b[32m=== Sprint 2 — Liquidation Vertical E2E PASSED! ===\\x1b[0m");
    console.log(\`Position lifecycle: deposit → open → (stale) → initiate_liquidation → reveal_and_seize\`);
}

main();
`;

fs.writeFileSync('scripts/e2e_liquidation.js', prefix + newLogic);
