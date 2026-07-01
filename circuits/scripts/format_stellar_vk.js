const fs = require('fs');

const vk = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

function formatG1(pt) {
    let x = BigInt(pt[0]).toString(16).padStart(64, '0');
    let y = BigInt(pt[1]).toString(16).padStart(64, '0');
    return x + y;
}

function formatG2(pt) {
    let x_c1 = BigInt(pt[0][1]).toString(16).padStart(64, '0');
    let x_c0 = BigInt(pt[0][0]).toString(16).padStart(64, '0');
    let y_c1 = BigInt(pt[1][1]).toString(16).padStart(64, '0');
    let y_c0 = BigInt(pt[1][0]).toString(16).padStart(64, '0');
    return x_c1 + x_c0 + y_c1 + y_c0;
}

const alpha_g1 = formatG1(vk.vk_alpha_1);
const beta_g2 = formatG2(vk.vk_beta_2);
const gamma_g2 = formatG2(vk.vk_gamma_2);
const delta_g2 = formatG2(vk.vk_delta_2);

const ic = vk.IC.map(pt => ({ bytes: formatG1(pt) }));

const stellarVk = {
    alpha_g1: { bytes: alpha_g1 },
    beta_g2: { bytes: beta_g2 },
    gamma_g2: { bytes: gamma_g2 },
    delta_g2: { bytes: delta_g2 },
    ic: ic
};

console.log(JSON.stringify(stellarVk, null, 2));
