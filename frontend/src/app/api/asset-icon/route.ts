// ============================================================
// Asset icon resolver
// ============================================================
// Serves the logo for any Stellar asset, without a hardcoded list.
//
// The chain of custody is SEP-1, the ecosystem's own standard:
//
//   issuer account -> home_domain -> /.well-known/stellar.toml
//                  -> [[CURRENCIES]] matching code AND issuer -> image
//
// So a newly listed asset brings its own logo and nothing here changes. An
// asset that publishes none gets a 404, which the client renders as a monogram
// rather than a broken image or somebody else's mark.
//
// Why this is a server route rather than an <img src> pointing at the issuer:
// `img-src 'self' data: blob:` in src/proxy.ts blocks external image hosts, and
// that policy is part of what protects the note store. Fetching here keeps the
// page same-origin and the policy untouched.
//
// The cost is that our server now fetches a URL chosen by a third party, which
// is an SSRF primitive by construction. `isSafeImageUrl` narrows what an issuer
// can reach, and everything below bounds what a hostile response can do:
// redirects are not followed, the content type must be an image, the body is
// size-capped, and every hop has a timeout.

import { NextResponse } from 'next/server';

import { findCurrency, isSafeImageUrl, parseCurrencies, tomlUrl } from '../../../dapp/lib/sep1';

const HORIZON = process.env.NEXT_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org';

/** Bundled marks for assets with no issuer TOML to consult. */
const BUNDLED: Record<string, string> = {
  XLM: '/brands/stellar-wordmark-white.png',
};

const FETCH_TIMEOUT_MS = 4_000;
const MAX_IMAGE_BYTES = 512 * 1024;

// Resolution is several network hops, so the answer is cached hard -- including
// the misses. Without caching failures, an asset with no logo would re-walk
// Horizon and someone's TOML on every render of every row.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;

interface Entry {
  at: number;
  body: ArrayBuffer | null;
  contentType: string | null;
}

const cache = new Map<string, Entry>();

async function getWithTimeout(url: string, accept: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      // A redirect could land somewhere the guard already rejected, so the
      // guard would be checking a URL that is not the one finally fetched.
      redirect: 'error',
      headers: { accept },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** issuer account -> home domain, via Horizon. */
async function homeDomain(issuer: string): Promise<string | null> {
  const res = await getWithTimeout(`${HORIZON}/accounts/${issuer}`, 'application/json');
  if (!res.ok) return null;
  const account = (await res.json()) as { home_domain?: string };
  return account.home_domain ?? null;
}

async function resolveImageUrl(code: string, issuer: string): Promise<string | null> {
  const domain = await homeDomain(issuer);
  if (!domain) return null;

  const tomlAddress = tomlUrl(domain);
  if (!isSafeImageUrl(tomlAddress)) return null;

  const res = await getWithTimeout(tomlAddress, 'text/plain');
  if (!res.ok) return null;

  const image = findCurrency(parseCurrencies(await res.text()), code, issuer)?.image;
  return image && isSafeImageUrl(image) ? image : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') ?? '').trim();
  const issuer = (url.searchParams.get('issuer') ?? '').trim();

  // Stellar asset codes are 1-12 alphanumerics; issuers are 56-char G-keys.
  // Validated before either value reaches a URL.
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    return NextResponse.json({ error: 'Invalid asset code' }, { status: 400 });
  }
  if (issuer && !/^G[A-Z2-7]{55}$/.test(issuer)) {
    return NextResponse.json({ error: 'Invalid issuer' }, { status: 400 });
  }

  // Native and other bundled marks never touch the network.
  const bundled = !issuer ? BUNDLED[code.toUpperCase()] : undefined;
  if (bundled) {
    return NextResponse.redirect(new URL(bundled, url.origin), 302);
  }

  if (!issuer) {
    return NextResponse.json({ error: 'No icon for this asset' }, { status: 404 });
  }

  const key = `${code.toUpperCase()}:${issuer}`;
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.body ? CACHE_TTL_MS : MISS_TTL_MS;
    if (Date.now() - hit.at < ttl) {
      if (!hit.body) {
        return NextResponse.json({ error: 'No icon published' }, { status: 404 });
      }
      return new NextResponse(hit.body, {
        headers: {
          'Content-Type': hit.contentType ?? 'image/png',
          'Cache-Control': 'public, max-age=21600',
          'X-Vayyl-Cache': 'hit',
        },
      });
    }
  }

  try {
    const image = await resolveImageUrl(code, issuer);
    if (!image) {
      cache.set(key, { at: Date.now(), body: null, contentType: null });
      return NextResponse.json({ error: 'No icon published' }, { status: 404 });
    }

    const res = await getWithTimeout(image, 'image/*');
    const contentType = res.headers.get('content-type') ?? '';
    // An issuer must not be able to serve HTML or a script through our origin.
    if (!res.ok || !contentType.startsWith('image/')) {
      cache.set(key, { at: Date.now(), body: null, contentType: null });
      return NextResponse.json({ error: 'Icon is not an image' }, { status: 404 });
    }

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      cache.set(key, { at: Date.now(), body: null, contentType: null });
      return NextResponse.json({ error: 'Icon too large' }, { status: 404 });
    }

    cache.set(key, { at: Date.now(), body: buffer, contentType });
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=21600',
        'X-Vayyl-Cache': 'miss',
        // The bytes come from a third party. Even though the content type is
        // checked, this stops a browser second-guessing it.
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    // A timeout, a refused redirect, a dead domain. Cached as a miss so one
    // unreachable issuer does not slow every render.
    cache.set(key, { at: Date.now(), body: null, contentType: null });
    return NextResponse.json({ error: 'Icon unavailable' }, { status: 404 });
  }
}
