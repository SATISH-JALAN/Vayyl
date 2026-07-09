const fs = require('fs');
let content = fs.readFileSync('scripts/e2e_position.js', 'utf8');

const rnd = Math.floor(Math.random() * 100000);
content = content.replace(/const noteBlindness = "99999";/, `const noteBlindness = "${99999 + rnd}";`);
content = content.replace(/const posBlindness = "77777";/, `const posBlindness = "${77777 + rnd}";`);

const idx = content.indexOf('// 4. ATTEST HEALTH');
if (idx === -1) throw new Error('anchor not found');
const prefix = content.slice(0, idx - 45);

const newLogic = `
    // ===================================================
    // 4. MAKE STALE (ATTEST HEALTH WITH PAST TIMESTAMP)
    // ===================================================
    console.log("\\n--- Making position stale (attest with past oracle) ---");

    const pastTimestamp = Math.floor(Date.now() / 1000) - 4000;
    const setPastCmd = \`stellar contract invoke --id \${ORACLE_ID} --network \${NETWORK} --source \${SOURCE} -- set_price --price 2500 --timestamp \${pastTimestamp}\`;
    checkError(runCmd(setPastCmd), false);
    console.log(\`Oracle updated in past: price=2500, timestamp=\${pastTimestamp}\`);

    const healthThreshold = "500";
    const healthProofResult = generateProof("position_health", {
        position_commitment: posCommitment,
        oracle_price: "2500",
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

    const keeperSecret = "123456789";
    const keeperCommitment = calculateHash2([keeperSecret, "0"]);
    console.log(\`Keeper secret: \${keeperSecret}\`);
    console.log(\`Keeper commitment: \${keeperCommitment}\`);

    console.log("Initiating liquidation...");
    const initCmd = \`stellar contract invoke --id \${KEEPER_ID} --network \${NETWORK} --source \${SOURCE}\` +
        \` -- initiate_liquidation\` +
        \` --position_id "{\\\\\\"bytes\\\\\\":\\\\\\"\${positionIdHex}\\\\\\"}"\` +
        \` --keeper_commitment "{\\\\\\"bytes\\\\\\":\\\\\\"\${formatFr(keeperCommitment)}\\\\\\"}"\`;
    checkError(runCmd(initCmd), false);
    console.log("\\x1b[32m✅ Liquidation initiated.\\x1b[0m");

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

    const seizeAmount = "500"; 
    const keeperAddr = deployerAddr; 

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

    console.log("\\n\\x1b[32m=== Sprint 2 — Liquidation Vertical E2E PASSED! ===\\x1b[0m");
    console.log(\`Position lifecycle: deposit → open → (stale) → initiate_liquidation → reveal_and_seize\`);
}

main();
`;

fs.writeFileSync('scripts/e2e_liquidation.js', prefix + newLogic);
