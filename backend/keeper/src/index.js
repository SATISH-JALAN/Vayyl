import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
const NETWORK = "testnet";
const SOURCE = "deployer"; // Assuming keeper has its keys configured locally
const deployPath = path.join(__dirname, '../../../deployments', `${NETWORK}.json`);
const deployments = JSON.parse(fs.readFileSync(deployPath, 'utf8'));
const LIQUIDATION_ENGINE_ID = deployments.liquidation;
const WATCHED_POSITIONS_FILE = path.join(__dirname, 'watched_positions.json');
async function getWatchedPositions() {
    try {
        if (fs.existsSync(WATCHED_POSITIONS_FILE)) {
            return JSON.parse(fs.readFileSync(WATCHED_POSITIONS_FILE, 'utf8'));
        }
    }
    catch (e) {
        console.error("Error reading watched positions:", e);
    }
    return [];
}
function isStale(positionIdHex) {
    try {
        const cmd = `stellar contract invoke --id ${LIQUIDATION_ENGINE_ID} --network ${NETWORK} --source ${SOURCE} -- is_stale --position_id "{\\"bytes\\":\\"${positionIdHex}\\"}"`;
        const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
        return out.includes("true");
    }
    catch (e) {
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
            }
            else {
                console.log(`Position ${position_id} is healthy/not stale.`);
            }
        }
    }, 5000);
}
main().catch(console.error);
//# sourceMappingURL=index.js.map