const { execSync } = require('child_process');
const fs = require('fs');

const NETWORK = "testnet";
const SOURCE = "deployer";
const VERIFIER_ID = "CAITE7BPXCMYW2I5GKJIV5PKYFNYUBZOJX2PS467EPXSTJO45YFQZIBQ";

const CIRCUITS = {
    "Deposit": { id: 0, file: "deposit" },
    "Transfer": { id: 1, file: "transfer" },
    "Withdraw": { id: 2, file: "withdraw" },
    "PositionOpen": { id: 3, file: "position_open" },
    "PositionHealth": { id: 4, file: "position_health" },
    "PositionClose": { id: 5, file: "position_close" }
};

for (const [name, config] of Object.entries(CIRCUITS)) {
    const vkeyPath = `circuits/build/vkey/${config.file}_stellar_vkey.json`;
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
    try {
        const vkeyObj = JSON.parse(vkeyStrRaw);
        vkeyStr = JSON.stringify(vkeyObj);
    } catch (e) {
        console.error(`Failed to parse ${vkeyPath}:`, e);
        process.exit(1);
    }

    console.log(`Registering VK for ${name}...`);
    // Escape double quotes for cmd.exe
    const escapedVkey = vkeyStr.replace(/"/g, '\\"');
    const cmd = `stellar contract invoke --id ${VERIFIER_ID} --network ${NETWORK} --source ${SOURCE} -- set_vk --circuit_id "{\\"${name}\\": []}" --vk "${escapedVkey}"`;
    
    try {
        execSync(cmd, { stdio: 'inherit' });
    } catch (error) {
        console.error(`Failed to register VK for ${name}`);
        process.exit(1);
    }
}

console.log("All VKs registered successfully!");
