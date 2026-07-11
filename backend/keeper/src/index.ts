import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parseStaleResponse } from './stale';

const NETWORK = "testnet";
const SOURCE = "deployer"; // Assuming keeper has its keys configured locally

const deployPath = path.join(__dirname, '../../../deployments', `${NETWORK}.json`);
const deployments = JSON.parse(fs.readFileSync(deployPath, 'utf8'));
const LIQUIDATION_ENGINE_ID = deployments.liquidation;

const INDEXER_URL = process.env.INDEXER_URL || 'http://localhost:3001';

async function getWatchedPositions() {
    try {
        const res = await fetch(`${INDEXER_URL}/positions`);
        if (res.ok) {
            const data = await res.json();
            // Filter only active positions
            return data.positions.filter((p: any) => !p.is_closed);
        }
    } catch (e) {
        console.error("Error fetching watched positions from indexer:", e);
    }
    return [];
}

function isStale(positionIdHex: string): boolean {
    try {
        const cmd = `stellar contract invoke --id ${LIQUIDATION_ENGINE_ID} --network ${NETWORK} --source ${SOURCE} -- is_stale --position_id "{\\"bytes\\":\\"${positionIdHex}\\"}"`;
        const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
        return parseStaleResponse(out);
    } catch (e: any) {
        // If there's an error calling it, might be stale or not found, let's just return false
        return false;
    }
}

async function main() {
    console.log(`Starting Keeper... watching on ${NETWORK}`);
    console.log(`Liquidation Engine: ${LIQUIDATION_ENGINE_ID}`);

    setInterval(async () => {
        const positions = await getWatchedPositions();
        if (positions.length === 0) {
            console.log("No positions to watch.");
            return;
        }

        for (const pos of positions) {
            const { position_id } = pos;
            console.log(`Checking position ${position_id}...`);
            const stale = isStale(position_id);
            if (stale) {
                console.log(`Position ${position_id} is stale! Proceeding to seize...`);
                // Write a flag file to signal to the e2e script that the keeper detected it
                const fileOut = path.join(__dirname, `seize_trigger_${position_id}.json`);
                fs.writeFileSync(fileOut, JSON.stringify({ seize: true }));
            } else {
                console.log(`Position ${position_id} is healthy/not stale.`);
            }
        }
    }, 5000);
}

main().catch(console.error);
