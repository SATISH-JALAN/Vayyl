const { buildPoseidon } = require('circomlibjs');
const fs = require('fs');
const path = require('path');

async function main() {
    const poseidon = await buildPoseidon();
    
    // Deposit Inputs
    const amount = 1000n;
    const pubX = 12345n;
    const pubY = 67890n;
    const blindness = 99999n;

    // 1. Compute Note Commitment: Poseidon(amount, pubX, pubY, blindness)
    // Wait, let's check how lib/note.circom defines NoteCommitment
    // In note.circom: commitment <== Poseidon(4)([amount, pubX, pubY, blindness]);
    const commitmentHash = poseidon([amount, pubX, pubY, blindness]);
    const commitment = poseidon.F.toString(commitmentHash);

    // 2. Compute ASP Membership proof
    // We'll just construct a fake merkle tree of depth 20 with the pubKey at index 0.
    const depth = 20;
    
    // The leaf is Poseidon(pubX, pubY)
    const leafHash = poseidon([pubX, pubY]);
    
    let currentHash = leafHash;
    const asp_pathElements = [];
    const asp_pathIndices = [];

    // Assuming it's at index 0, all path indices are 0, and we hash with 0 (empty sibling)
    const zero = 0n;
    for (let i = 0; i < depth; i++) {
        asp_pathElements.push(zero.toString());
        asp_pathIndices.push(0);
        // If index is 0, sibling is right (element).
        // Hash(current, sibling)
        currentHash = poseidon([currentHash, zero]);
    }
    const asp_root = poseidon.F.toString(currentHash);

    const depositInput = {
        amount: amount.toString(),
        commitment: commitment,
        asp_root: asp_root,
        pubX: pubX.toString(),
        pubY: pubY.toString(),
        blindness: blindness.toString(),
        asp_pathElements: asp_pathElements,
        asp_pathIndices: asp_pathIndices
    };

    fs.writeFileSync(
        path.join(__dirname, '../test/input_deposit.json'),
        JSON.stringify(depositInput, null, 2)
    );
    console.log('Created test/input_deposit.json');
}

main().catch(console.error);
