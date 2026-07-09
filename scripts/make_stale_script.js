const fs = require('fs');
let content = fs.readFileSync('scripts/e2e_liquidation.js', 'utf8');

const idx = content.indexOf('// 5. LIQUIDATION');
if (idx === -1) throw new Error('anchor not found');
const prefix = content.slice(0, idx);

const newLogic = `
    console.log("\\n\\x1b[32m=== Stale Position Created! Keeper should detect it now. ===\\x1b[0m");
}
main();
`;
fs.writeFileSync('scripts/e2e_stale_only.js', prefix + newLogic);
