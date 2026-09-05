// ============================================================
// SEP-1 parsing and the SSRF guard
// ============================================================
// The guard is the reason this file exists. The image URL comes out of a file
// hosted by whoever issued the asset, and our server fetches it -- so an issuer
// gets to point our server somewhere. These tests pin what they cannot make it
// reach.

import assert from 'node:assert/strict';
import test from 'node:test';

import { findCurrency, isSafeImageUrl, parseCurrencies, tomlUrl } from './sep1.ts';
import { monogram, monogramHue, assetIconUrl, NATIVE } from './assets.ts';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const TOML = `
# A comment
VERSION="2.0.0"

[DOCUMENTATION]
ORG_NAME="Example"
code="not-a-currency"

[[CURRENCIES]]
code = "USDC"
issuer = "${USDC_ISSUER}"
image = "https://example.com/usdc.png"
display_decimals = 2

[[CURRENCIES]]
code='EURC'
issuer='GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO'
image='https://example.com/eurc.png'
`;

test('currencies parse, single or double quoted', () => {
  const c = parseCurrencies(TOML);
  assert.equal(c.length, 2);
  assert.equal(c[0].code, 'USDC');
  assert.equal(c[0].issuer, USDC_ISSUER);
  assert.equal(c[0].image, 'https://example.com/usdc.png');
  assert.equal(c[1].code, 'EURC');
  assert.equal(c[1].image, 'https://example.com/eurc.png');
});

test('a `code` outside a CURRENCIES block is not read as a currency', () => {
  // [DOCUMENTATION] above also has a `code` key. Without the section-close rule
  // it would be folded into the first currency and shadow the real code.
  const c = parseCurrencies(TOML);
  assert.ok(c.every((x) => x.code !== 'not-a-currency'));
});

test('lookup matches code case-insensitively but the issuer exactly', () => {
  const c = parseCurrencies(TOML);
  assert.ok(findCurrency(c, 'usdc', USDC_ISSUER));
  // A different issuer with the same code is a DIFFERENT asset -- anyone may
  // issue a token called USDC, and showing Circle's logo for it would be the
  // one mistake this lookup must never make.
  assert.equal(findCurrency(c, 'USDC', 'GDIFFERENT'), undefined);
});

test('a malformed toml yields nothing rather than throwing', () => {
  assert.deepEqual(parseCurrencies(''), []);
  assert.deepEqual(parseCurrencies('!!! not toml at all'), []);
  // A currency block with no fields is still an entry, just an empty one.
  assert.deepEqual(parseCurrencies('[[CURRENCIES]]'), [{}]);
});

test('the toml url is derived from the home domain', () => {
  assert.equal(tomlUrl('centre.io'), 'https://centre.io/.well-known/stellar.toml');
  assert.equal(tomlUrl('https://centre.io/'), 'https://centre.io/.well-known/stellar.toml');
});

// --- the guard -------------------------------------------------------------

test('a normal https image url is allowed', () => {
  assert.equal(isSafeImageUrl('https://example.com/logo.png'), true);
  assert.equal(isSafeImageUrl('https://cdn.example.com:443/a/b/logo.svg'), true);
});

test('loopback and link-local are refused', () => {
  for (const u of [
    'https://localhost/logo.png',
    'https://127.0.0.1/logo.png',
    'https://[::1]/logo.png',
    'https://169.254.169.254/latest/meta-data/',
    'https://metadata.google.internal/x.png',
    'https://something.localhost/x.png',
  ]) {
    assert.equal(isSafeImageUrl(u), false, `${u} must be refused`);
  }
});

test('RFC1918 addresses are refused', () => {
  for (const u of [
    'https://10.0.0.5/logo.png',
    'https://192.168.1.1/logo.png',
    'https://172.16.0.1/logo.png',
    'https://172.31.255.255/logo.png',
    'https://0.0.0.0/logo.png',
  ]) {
    assert.equal(isSafeImageUrl(u), false, `${u} must be refused`);
  }
});

test('172.32 is public and stays allowed', () => {
  // The RFC1918 block ends at 172.31. Over-blocking here would silently drop
  // logos for real hosts, so the boundary is worth pinning.
  assert.equal(isSafeImageUrl('https://172.32.0.1/logo.png'), true);
  assert.equal(isSafeImageUrl('https://172.15.0.1/logo.png'), true);
});

test('non-https, odd ports, and embedded credentials are refused', () => {
  assert.equal(isSafeImageUrl('http://example.com/logo.png'), false);
  assert.equal(isSafeImageUrl('file:///etc/passwd'), false);
  assert.equal(isSafeImageUrl('data:image/png;base64,AAAA'), false);
  assert.equal(isSafeImageUrl('https://example.com:8080/logo.png'), false);
  assert.equal(isSafeImageUrl('https://user:pass@example.com/logo.png'), false);
  assert.equal(isSafeImageUrl('not a url'), false);
});

// --- display fallbacks -----------------------------------------------------

test('a monogram is derived from the code alone', () => {
  // Never from a similar asset or the issuer domain: showing one project's
  // brand for another project's token is worse than showing no brand.
  assert.equal(monogram('XLM'), 'XLM');
  // Four-character codes are common (USDC, EURC, yXLM) and still fit the badge,
  // so they are shown whole rather than clipped to something ambiguous.
  assert.equal(monogram('USDC'), 'USDC');
  assert.equal(monogram('yXLM'), 'YXLM');
  // Beyond four, three is all that fits.
  assert.equal(monogram('LONGCODE'), 'LON');
  assert.equal(monogram('a-b c'), 'ABC');
  assert.equal(monogram(''), '?');
});

test('the same code always gets the same colour', () => {
  assert.equal(monogramHue('USDC'), monogramHue('USDC'));
  assert.notEqual(monogramHue('USDC'), monogramHue('XLM'));
  for (const c of ['XLM', 'USDC', 'EURC', 'BTC']) {
    const h = monogramHue(c);
    assert.ok(h >= 0 && h < 360, `${c} hue out of range: ${h}`);
  }
});

test('the icon url stays same-origin and omits the issuer for lumens', () => {
  // Same-origin is the whole point: `img-src 'self' data: blob:` blocks
  // external image hosts, and this must not be the thing that widens it.
  const native = assetIconUrl({ code: 'XLM', issuer: NATIVE });
  assert.ok(native.startsWith('/api/asset-icon?'));
  assert.ok(!native.includes('issuer='));

  const issued = assetIconUrl({ code: 'USDC', issuer: USDC_ISSUER });
  assert.ok(issued.includes(`issuer=${USDC_ISSUER}`));
});
