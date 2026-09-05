// ============================================================
// Asset identity
// ============================================================
// Everything needed to display an asset -- its label, and where its logo comes
// from -- without hardcoding a list of logos.
//
// The logo source is SEP-1. Every issuer publishes a `stellar.toml` at their
// home domain with an `image` for each currency they issue, so an asset that
// follows the standard brings its own logo and nothing here has to be updated
// when a new one is listed. Resolution happens server-side in
// /api/asset-icon -- `img-src 'self' data: blob:` in src/proxy.ts blocks
// external image hosts, and widening it for decoration is not a trade worth
// making when the note store is what sits behind that policy.
//
// When an asset publishes no image, the UI draws a monogram rather than a
// broken image or a stand-in belonging to someone else.

/** The native lumen has no issuer, and no issuer TOML to look one up in. */
export const NATIVE = 'native';

export interface AssetRef {
  /** Asset code as it appears on-chain: "XLM", "USDC", ... */
  code: string;
  /** Issuer account, or NATIVE for lumens. */
  issuer: string;
}

export interface Market {
  /** Stable id used in URLs and storage. */
  id: string;
  /** What the pair is called in the UI. */
  label: string;
  /** The asset a position is denominated in. */
  base: AssetRef;
  /** What it is quoted against. Display only -- settlement is in collateral. */
  quote: string;
  /** Human note shown under the pair name. */
  description: string;
}

/**
 * Markets this build offers.
 *
 * One entry today. It is a list rather than a constant because adding a market
 * should be a data change, not a component change -- and because the logo for
 * a new entry resolves on its own through SEP-1.
 */
export const MARKETS: Market[] = [
  {
    id: 'xlm-usd',
    label: 'XLM / USD',
    base: { code: 'XLM', issuer: NATIVE },
    quote: 'USD',
    description: 'Stellar Lumens · capped perp',
  },
];

export const getMarket = (id: string): Market =>
  MARKETS.find((m) => m.id === id) ?? MARKETS[0];

/**
 * The URL the browser asks for an asset's logo.
 *
 * Always same-origin. The route resolves the real image server-side and
 * answers 404 when the asset publishes none, which is the signal to draw a
 * monogram.
 */
export function assetIconUrl(asset: AssetRef): string {
  const params = new URLSearchParams({ code: asset.code });
  if (asset.issuer && asset.issuer !== NATIVE) params.set('issuer', asset.issuer);
  return `/api/asset-icon?${params.toString()}`;
}

/**
 * Up to three letters to stand in for a missing logo.
 *
 * Deliberately derived from the code alone. Anything cleverer -- borrowing a
 * similar asset's mark, or guessing from the issuer's domain -- risks showing
 * one project's brand for another project's token, which is worse than showing
 * no brand at all.
 */
export function monogram(code: string): string {
  const cleaned = code.replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length === 0) return '?';
  return cleaned.slice(0, cleaned.length <= 4 ? cleaned.length : 3).toUpperCase();
}

/**
 * A stable colour for an asset with no logo, from its code.
 *
 * Same code always gets the same hue, so an asset looks like itself between
 * sessions and between users, without a colour having to be assigned anywhere.
 */
export function monogramHue(code: string): number {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    hash = (hash * 31 + code.charCodeAt(i)) % 360;
  }
  return hash;
}
