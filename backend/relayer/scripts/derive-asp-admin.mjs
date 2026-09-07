// ============================================================
// Derive the ASP admin secret from a Stellar CLI identity
// ============================================================
// WHY THIS EXISTS. asp-membership.insert_leaf is admin-gated, so the relayer
// needs the deploying identity's secret key in ASP_ADMIN_SECRET or every
// /v2/enroll fails Unauthorized -- and therefore every first deposit from a
// fresh wallet fails the pool's ASP-root check, with an error that never
// mentions enrollment.
//
// The Stellar CLI stores that identity as a BIP-39 phrase in
// ~/.config/stellar/identity/<name>.toml, and `stellar keys show` is not
// available on every machine this project is developed on (Smart App Control
// blocks locally-built unsigned binaries on the Windows side). This script is
// the fallback: same derivation, no CLI.
//
// It prints ONLY the public key. The phrase and the secret are never written to
// stdout, so this is safe to run with the output visible.
//
// Usage, from backend/relayer:
//
//   PowerShell:  $env:MNEMONIC = "<24 words>"
//                node scripts/derive-asp-admin.mjs
//                $env:MNEMONIC = $null
//
//   bash:        MNEMONIC="<24 words>" node scripts/derive-asp-admin.mjs
//
// Set EXPECTED_ADMIN to the membership contract's admin (the Admin value in its
// instance storage). The script refuses to write .env unless the derived key
// matches, because a wrong-but-valid key is the worst outcome available here:
// startup logs "ASP enrollment enabled" and the failure only surfaces later, at
// a user's deposit.
//
// TESTNET ONLY. Handing a deployment admin key to a long-running service is a
// demo convenience. On mainnet, enrollment belongs behind a real approval
// process with its own signer.
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';

/** Admin of asp-membership CB5KJ3JW... (deployed 2026-09-05). */
const EXPECTED_ADMIN = process.env.EXPECTED_ADMIN ?? 'GCXH3SK5';
const ENV_PATH = new URL('../.env', import.meta.url);

const mnemonic = (process.env.MNEMONIC ?? '').normalize('NFKD').trim().replace(/\s+/g, ' ');
if (!mnemonic) {
  console.error('MNEMONIC is not set. See the usage note at the top of this file.');
  process.exit(1);
}

// BIP-39: phrase -> 64-byte seed. No wordlist is needed in this direction; the
// real check is whether the derived public key matches the on-chain admin.
const seed = pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512');

// SLIP-0010 ed25519, hardened-only, path m/44'/148'/0' -- what the Stellar CLI
// uses. ed25519 has no non-hardened derivation, so every step sets the high bit.
const hmac = (key, data) => createHmac('sha512', key).update(data).digest();
let I = hmac(Buffer.from('ed25519 seed', 'utf8'), seed);
let key = I.subarray(0, 32);
let chain = I.subarray(32);
for (const index of [44, 148, 0]) {
  const data = Buffer.alloc(37);
  data[0] = 0x00;
  key.copy(data, 1);
  data.writeUInt32BE((index | 0x80000000) >>> 0, 33);
  I = hmac(chain, data);
  key = I.subarray(0, 32);
  chain = I.subarray(32);
}

const kp = Keypair.fromRawEd25519Seed(key);
const pub = kp.publicKey();
console.log('derived public key :', pub);
console.log('expected           :', `${EXPECTED_ADMIN}…`);

if (!pub.startsWith(EXPECTED_ADMIN)) {
  console.error(
    'MISMATCH — refusing to write .env. This identity cannot authorise insert_leaf, ' +
      'so enrollment would fail at the first deposit rather than at startup.',
  );
  process.exit(1);
}

// Replaces the commented-out placeholder rather than appending, so the block
// comment above it — which explains why the key must be this one — stays
// attached to the value it describes.
const env = readFileSync(ENV_PATH, 'utf8');
const placeholder = /^#\s*ASP_ADMIN_SECRET=.*$/m;
if (!placeholder.test(env)) {
  console.error(
    'No commented ASP_ADMIN_SECRET placeholder found in backend/relayer/.env. ' +
      'Add one, or set the value by hand.',
  );
  process.exit(1);
}
writeFileSync(ENV_PATH, env.replace(placeholder, `ASP_ADMIN_SECRET=${kp.secret()}`));
console.log('wrote ASP_ADMIN_SECRET into backend/relayer/.env (the value itself is not printed)');
