// ============================================================
// Market data proxy
// ============================================================
// The browser must not call a public price API directly. `connect-src` in
// src/proxy.ts is a strict allowlist, and it is the control standing between an
// XSS and every note in IndexedDB -- the viewing key is in memory and derives
// every spend key, so any origin the page may POST to is an exfiltration route.
// Adding api.binance.com to that list to draw a chart would trade the strongest
// guarantee in the app for decoration.
//
// So the fetch happens here instead. The page talks only to 'self', the policy
// is untouched, and CORS stops mattering.
//
// Two smaller wins fall out of it: one cache serves every open tab rather than
// each hammering the upstream, and the exchange never sees the visitor's IP.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { NextResponse } from 'next/server';

import { fetchMarket, INTERVALS, type Interval, type MarketSnapshot } from '../../../dapp/lib/market-data';
import { parseAnchor, type PriceAnchor } from '../../../dapp/lib/mark-price';

// The upstream URL is built from this list, never from user input -- a proxy
// that forwards a caller-supplied URL is an SSRF hole, and this endpoint is
// reachable by anyone who can load the page.
const ALLOWED = new Set<string>(INTERVALS.map((i) => i.id));

const MAX_LIMIT = 500;
const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { at: number; body: MarketSnapshot }>();

// Bounded, because the key now includes a caller-supplied range. An unbounded
// map on a route anyone can hit is a memory-exhaustion DoS.
const MAX_CACHE_ENTRIES = 256;
function evictOldest() {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Seconds per interval, for quantising the cache key. */
const INTERVAL_SECONDS: Record<Interval, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

/**
 * The price anchor the publisher wrote, forwarded to the browser.
 *
 * It is what turns an oracle price (stroops per contract unit) into the USD
 * figure the chart is drawn in -- see lib/mark-price.ts. Served from here
 * rather than duplicated into a NEXT_PUBLIC_ env var so there is one source of
 * truth: the file scripts/push_price.mjs actually writes.
 *
 * Absent when the publisher is running in --synthetic or --fixed mode, or on a
 * host that does not ship the repo. Absent must stay absent: the UI draws no
 * settlement line rather than an invented one.
 */
const ANCHOR_ENV = process.env.PRICE_ANCHOR_USD;
const ANCHOR_FILE = resolve(process.cwd(), '..', 'deployments', '.price-anchor.json');

// Re-read periodically rather than once at boot: the publisher can be restarted
// with a new anchor while the app keeps running, and a stale anchor silently
// mis-scales every price on the page.
const ANCHOR_TTL_MS = 60_000;
let anchorCache: { at: number; value: PriceAnchor | null } | null = null;

function priceAnchor(): PriceAnchor | null {
  if (anchorCache && Date.now() - anchorCache.at < ANCHOR_TTL_MS) return anchorCache.value;

  let value: PriceAnchor | null = null;
  if (ANCHOR_ENV) {
    value = parseAnchor({ market: Number(ANCHOR_ENV), anchoredAt: 'env' });
  } else if (existsSync(ANCHOR_FILE)) {
    try {
      value = parseAnchor(JSON.parse(readFileSync(ANCHOR_FILE, 'utf8')));
    } catch {
      value = null;
    }
  }
  anchorCache = { at: Date.now(), value };
  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);

  const interval = url.searchParams.get('interval') ?? '1h';
  if (!ALLOWED.has(interval)) {
    return NextResponse.json(
      { error: `Unsupported interval. Expected one of: ${[...ALLOWED].join(', ')}` },
      { status: 400 },
    );
  }

  const rawLimit = Number(url.searchParams.get('limit') ?? 200);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
    : 200;

  // `to` drives scroll-back pagination. Quantised DOWN to the interval
  // boundary before it reaches the cache key: the raw value is caller-supplied,
  // so an unquantised key would let anyone who can load the page mint unbounded
  // cache entries.
  const rawTo = Number(url.searchParams.get('to') ?? '');
  const now = Math.floor(Date.now() / 1000);
  const to =
    Number.isFinite(rawTo) && rawTo > 1_420_070_400 && rawTo < now + 86_400
      ? Math.floor(rawTo / INTERVAL_SECONDS[interval as Interval]) *
        INTERVAL_SECONDS[interval as Interval]
      : null;

  const key = `${interval}:${limit}:${to ?? 'live'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.body, {
      headers: { 'Cache-Control': 'no-store', 'X-Vayyl-Cache': 'hit' },
    });
  }

  try {
    const snapshot = {
      ...(await fetchMarket(interval as Interval, limit, undefined, to ? to * 1000 : undefined)),
      anchor: priceAnchor(),
    };
    cache.set(key, { at: Date.now(), body: snapshot });
    evictOldest();
    return NextResponse.json(snapshot, {
      headers: { 'Cache-Control': 'no-store', 'X-Vayyl-Cache': 'miss' },
    });
  } catch (e) {
    // Serve stale rather than nothing. A chart labelled stale beats an empty
    // panel, and this endpoint has no bearing on settlement -- positions price
    // off the oracle, not off here.
    if (hit) {
      return NextResponse.json(hit.body, {
        headers: { 'Cache-Control': 'no-store', 'X-Vayyl-Cache': 'stale' },
      });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
