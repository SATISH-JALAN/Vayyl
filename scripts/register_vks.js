const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const SOURCE = process.env.STELLAR_SOURCE || "deployer";

// When set, print the invoke commands instead of running them — lets you (and CI)
// sanity-check the exact registration calls without a live CLI/network.
const DRY_RUN = process.env.DRY_RUN === "1";
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 5000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

function sleepSync(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
}

// A fresh `stellar contract deploy` mints a NEW verifier id, so a hardcoded
// constant is a footgun — it silently registers VKs against a stale contract.
// Resolve in priority order: explicit env → V2 vault deployment → older
// single-stack deployment. There is deliberately NO baked-in fallback: guessing
// an id registers VKs somewhere unknown, which is strictly worse than stopping.
//
// `<network>-vault-v2.json` MUST come first. It describes the live V2 vault; the
// plain `<network>.json` describes the older stack and carries a DIFFERENT
// verifier. Registering V1 keys over the Deposit/Withdraw slots the V2 pool reads
// makes every deposit fail proof verification with no obvious cause.
function resolveVerifierId() {
    if (process.env.VERIFIER_ID) return process.env.VERIFIER_ID.trim();
    const tried = [];
    for (const name of [`${NETWORK}-vault-v2.json`, `${NETWORK}.json`]) {
        const deployFile = path.join(__dirname, "..", "deployments", name);
        tried.push(deployFile);
        if (!fs.existsSync(deployFile)) continue;
        try {
            const d = JSON.parse(fs.readFileSync(deployFile, "utf8"));
            if (d.verifier) return d.verifier;
        } catch (e) {
            console.warn(`Could not parse ${deployFile}: ${e.message}`);
        }
    }
    throw new Error(
        `Verifier id not found for ${NETWORK}. Looked in:\n  ${tried.join("\n  ")}\n` +
        `Set VERIFIER_ID explicitly, or deploy first.`,
    );
}
const VERIFIER_ID = resolveVerifierId();

// Pull the raw hex bytes out of a Groth16 G2 point in the Stellar VK format,
// which encodes each point as { "bytes": "<hex>" }. Tolerates a few shapes so
// the guard never silently no-ops on a format tweak.
function g2Bytes(point) {
    if (point == null) return null;
    if (typeof point === "string") return point;
    if (typeof point.bytes === "string") return point.bytes;
    return JSON.stringify(point); // fall back to structural comparison
}

// The Groth16 verifier MUST reject any VK where gamma == delta (the Veil Cash /
// FoomCash bug: it lets a forged proof verify). The on-chain verifier already
// enforces this (Error::GammaEqualsDelta), but registering such a VK wastes a
// testnet round-trip and would be a silent footgun if that on-chain check ever
// regressed. Catch it here, before submission.
function assertGammaNeDelta(vkeyObj, name) {
    const gamma = g2Bytes(vkeyObj.gamma_g2);
    const delta = g2Bytes(vkeyObj.delta_g2);
    if (gamma == null || delta == null) {
        console.error(`Refusing to register ${name}: VK is missing gamma_g2/delta_g2.`);
        process.exit(1);
    }
    if (gamma.replace(/^0x/i, "").toLowerCase() === delta.replace(/^0x/i, "").toLowerCase()) {
        console.error(`Refusing to register ${name}: gamma_g2 == delta_g2 (Veil Cash / FoomCash bug). Regenerate this VK.`);
        process.exit(1);
    }
}

// `dir` defaults to the V1 build output. Deposit and Withdraw deliberately point
// at the V2 build: the V2 pool verifies against the CircuitId::Deposit and
// CircuitId::Withdraw slots but its proofs come from deposit_v2/withdraw_v2, so
// writing the V1 keys into those slots makes every deposit fail verification with
// no on-chain error to explain it. This must stay in sync with the registration
// that scripts/deploy_testnet_vault_v2.ps1 performs.
const V1_VKEY_DIR = "circuits/build/vkey";
const V2_VKEY_DIR = "circuits/build/v2/vkey";

const CIRCUITS = {
    "Deposit": { id: 0, file: "deposit_v2", dir: V2_VKEY_DIR },
    "Transfer": { id: 1, file: "transfer" },
    "Withdraw": { id: 2, file: "withdraw_v2", dir: V2_VKEY_DIR },
    "PositionOpen": { id: 3, file: "position_open" },
    "PositionHealth": { id: 4, file: "position_health" },
    "PositionClose": { id: 5, file: "position_close" },
    // LiquidationEngine::reveal_and_seize verifies against this circuit, so its
    // VK MUST be registered or seize fails on-chain. id 6 = CircuitId enum order.
    "LiquidationHeartbeat": { id: 6, file: "liquidation_heartbeat" },
    // Order/agentic circuits — HiddenOrderTrigger=7, SealedOrder=11 in CircuitId enum.
    "HiddenOrderTrigger": { id: 7, file: "hidden_order_trigger" },
    "SealedOrder": { id: 11, file: "sealed_order" }
};

// Default: register every circuit below that has a built VK. Set REGISTER_ALL=0
// to skip circuits not in this set (legacy narrow scope).
const V1_CIRCUITS = new Set([
    "Deposit",
    "Transfer",
    "Withdraw",
    "PositionOpen",
    "PositionHealth",
    "PositionClose",
    "LiquidationHeartbeat",
    "HiddenOrderTrigger",
    "SealedOrder",
]);
const registerAll = process.env.REGISTER_ALL === "1";
const vaultOnly = process.env.REGISTER_VAULT_ONLY === "1";

console.log(`Target verifier: ${VERIFIER_ID} (network=${NETWORK}${DRY_RUN ? ", DRY_RUN" : ""})`);

for (const [name, config] of Object.entries(CIRCUITS)) {
    if (vaultOnly && name !== 'Deposit' && name !== 'Withdraw') {
        console.log(`Skipping ${name}: outside Vault v1 scope.`);
        continue;
    }
    if (!registerAll && !V1_CIRCUITS.has(name)) {
        console.log(`Skipping ${name}: outside V1 scope (set REGISTER_ALL=1 to include).`);
        continue;
    }
    // Resolve from the script's own location, not the caller's cwd — a relative
    // path silently "finds no vkeys" and skips every circuit when run from
    // anywhere but the repo root.
    const vkeyPath = path.join(
        __dirname, "..", config.dir || V1_VKEY_DIR, `${config.file}_stellar_vkey.json`,
    );
    if (!fs.existsSync(vkeyPath)) {
        console.warn(`Skipping ${name}: vkey not found at ${vkeyPath}`);
        continue;
    }
    
    // Read and format as single-line string to avoid shell escaping issues
    let vkeyRaw = fs.readFileSync(vkeyPath);
    // Check for UTF-16LE BOM (FF FE) or UTF-8 BOM (EF BB BF)
    if (vkeyRaw.length >= 2 && vkeyRaw[0] === 0xFF && vkeyRaw[1] === 0xFE) {
        vkeyStrRaw = vkeyRaw.toString('utf16le');
        if (vkeyStrRaw.charCodeAt(0) === 0xFEFF) vkeyStrRaw = vkeyStrRaw.slice(1);
    } else {
        vkeyStrRaw = vkeyRaw.toString('utf8');
        if (vkeyStrRaw.charCodeAt(0) === 0xFEFF) vkeyStrRaw = vkeyStrRaw.slice(1);
    }

    let vkeyStr;
    let vkeyObj;
    try {
        vkeyObj = JSON.parse(vkeyStrRaw);
        vkeyStr = JSON.stringify(vkeyObj);
    } catch (e) {
        console.error(`Failed to parse ${vkeyPath}:`, e);
        process.exit(1);
    }

    // Pre-registration safety gate: never submit a gamma == delta VK.
    assertGammaNeDelta(vkeyObj, name);

    console.log(`Registering VK for ${name}...`);
    // Escape double quotes for cmd.exe
    const escapedVkey = vkeyStr.replace(/"/g, '\\"');
    const cmd = `stellar contract invoke --id ${VERIFIER_ID} --network ${NETWORK} --source ${SOURCE} -- set_vk --circuit_id "{\\"${name}\\": []}" --vk "${escapedVkey}"`;

    if (DRY_RUN) {
        console.log(`[dry-run] ${cmd.slice(0, 160)}… (${escapedVkey.length} bytes VK)`);
        continue;
    }

    try {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                execSync(cmd, { stdio: 'inherit' });
                break;
            } catch (error) {
                if (attempt === MAX_RETRIES) throw error;
                console.warn(`Register ${name} attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS}ms...`);
                sleepSync(RETRY_DELAY_MS);
            }
        }
    } catch (error) {
        console.error(`Failed to register VK for ${name}`);
        process.exit(1);
    }
}

console.log("All VKs registered successfully!");
