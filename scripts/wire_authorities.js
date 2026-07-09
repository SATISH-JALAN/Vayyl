const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NETWORK = process.env.STELLAR_NETWORK || 'testnet';
const SOURCE = process.env.STELLAR_SOURCE || 'deployer';
const DRY_RUN = process.env.DRY_RUN === '1';
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 4000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

function sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
}

function resolveDeployments(network) {
    const deployFile = path.join(__dirname, '..', 'deployments', `${network}.json`);
    if (!fs.existsSync(deployFile)) {
        console.error(`Deployments file not found: ${deployFile}`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(deployFile, 'utf8'));
}

function invokeWithRetry(contractId, fnAndArgs) {
    const cmd = `stellar contract invoke --id ${contractId} --network ${NETWORK} --source ${SOURCE} -- ${fnAndArgs}`;
    if (DRY_RUN) {
        console.log(`[dry-run] ${cmd}`);
        return;
    }
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`\n$ ${cmd}`);
            execSync(cmd, { stdio: 'inherit' });
            return;
        } catch (e) {
            if (attempt === MAX_RETRIES) throw e;
            console.warn(`Attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS}ms...`);
            sleepSync(RETRY_DELAY_MS);
        }
    }
}

function main() {
    const d = resolveDeployments(NETWORK);

    const poolId = d.pool || d.vayyl_pool || process.env.POOL_ID;
    const authorities = {
        PositionManager: d.manager || d.position_manager,
        LiquidationEngine: d.liquidation || d.liquidation_engine,
        HiddenOrderRegistry: d.order_registry || d.hidden_order_registry,
        AgenticSettlementHub: d.agentic_hub || d.agentic_settlement_hub,
    };

    if (!poolId) {
        console.error('pool address not found in deployments (expected key: pool).');
        process.exit(1);
    }

    console.log(`Target Pool: ${poolId} (network=${NETWORK}, source=${SOURCE})`);

    for (const [name, id] of Object.entries(authorities)) {
        if (!id) {
            console.warn(`Skipping ${name}: address not found in deployments.`);
            continue;
        }
        console.log(`Adding ${name} (${id}) as settlement authority...`);
        try {
            invokeWithRetry(poolId, `add_settlement_authority --authority ${id}`);
        } catch (e) {
            console.error(`Failed to add ${name} as authority: ${e.message}`);
        }
        sleepSync(RETRY_DELAY_MS);
    }

    console.log('\nDone wiring authorities.');
}

main();
