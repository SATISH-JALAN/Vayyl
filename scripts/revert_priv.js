const fs = require('fs');
let content = fs.readFileSync('scripts/e2e_liquidation.js', 'utf8');

// Revert the priv randomization and keep blindness randomization
content = content.replace(/const priv = "\d+";/, `const priv = "42";`);

fs.writeFileSync('scripts/e2e_liquidation.js', content);
