// ============================================================
// Content-Security-Policy (H10)
// ============================================================
// The threat model here is unusually sharp. The viewing key sits in memory and
// derives every spend key; the note store is in IndexedDB. Any XSS, or any
// compromised dependency that can reach the DOM, exfiltrates every note the
// wallet owns — there is no second factor and no server-side check to catch it.
// The app shipped with no CSP and no security headers at all.
//
// A per-request nonce is used rather than `'unsafe-inline'`, because
// `'unsafe-inline'` on script-src would leave exactly the injection hole this
// exists to close. Next injects its own hydration/flight scripts inline, and it
// attaches the nonce to them automatically when it finds one in the request's
// CSP header — hence setting the header on the REQUEST as well as the response.
//
// Cost, stated plainly: consuming a nonce opts pages out of static rendering.
// For an app whose landing page is a marketing surface and whose `/app` route
// was already dynamic, that is a fair trade for not having an XSS-to-drained-
// wallet path.

import { NextResponse, type NextRequest } from 'next/server';

/** Origins the DApp legitimately talks to. Anything else is blocked. */
function connectSources(): string[] {
  const urls = [
    process.env.NEXT_PUBLIC_RPC_URL,
    process.env.NEXT_PUBLIC_HORIZON_URL,
    process.env.NEXT_PUBLIC_INDEXER_URL,
    process.env.NEXT_PUBLIC_RELAYER_URL,
    // The multi-relayer set is a comma-separated list; each entry is an origin
    // the client may submit a withdrawal through.
    ...(process.env.NEXT_PUBLIC_RELAYER_SET ?? '').split(','),
  ];

  const origins = new Set<string>(["'self'"]);
  for (const raw of urls) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // A malformed env value must not silently widen the policy.
    }
  }
  return [...origins];
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  const sources = connectSources();
  const directives = [
    `default-src 'self'`,
    // 'wasm-unsafe-eval' is required: snarkjs compiles the circuit wasm to
    // generate witnesses. 'strict-dynamic' lets the nonce'd bootstrap load the
    // rest of Next's chunks without enumerating them.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    // Next and GSAP set element styles at runtime. Style injection cannot read
    // the note store, so this is the one relaxation worth making.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src ${sources.join(' ')}`,
    // Proof generation must stay in a Worker (iOS Safari kills workers over
    // ~1-2GB, and running it on the main thread is a hard rule elsewhere in
    // this codebase). Bundled workers are same-origin; blob: covers the dev
    // server's worker shim.
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];

  // Only upgrade when every endpoint is already https. With a local indexer or
  // relayer on plain http, `upgrade-insecure-requests` rewrites those calls to
  // https and the DApp silently loses its data sources. Browsers exempt
  // localhost, but an indexer on a LAN address is not exempt -- so decide from
  // the actual configuration rather than relying on that carve-out.
  if (!sources.some((s) => s.startsWith('http://'))) {
    directives.push('upgrade-insecure-requests');
  }
  const csp = directives.join('; ');

  // Next reads the nonce off the REQUEST headers to stamp its inline scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and the favicon: those are served from
    // 'self' and carry no inline script, so a nonce would only cost renders.
    {
      source: '/((?!_next/static|_next/image|favicon.ico|circuits/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
