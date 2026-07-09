const fs = require('fs');
let content = fs.readFileSync('scripts/e2e_liquidation.js', 'utf8');

const randomSuffix = Math.floor(Math.random() * 100000);
content = content.replace(/const priv = "42";/, `const priv = "${42 + randomSuffix}";`);
content = content.replace(/const noteBlindness = "99999";/, `const noteBlindness = "${99999 + randomSuffix}";`);
content = content.replace(/const posBlindness = "77777";/, `const posBlindness = "${77777 + randomSuffix}";`);

fs.writeFileSync('scripts/e2e_liquidation.js', content);
