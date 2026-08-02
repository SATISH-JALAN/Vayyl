// Serve `/circuits/*` off frontend/public inside node.
//
// poseidon.ts (and anything else that loads a wasm artifact) fetches absolute
// paths like `/circuits/hash2.wasm`, which mean nothing outside a browser. This
// shim resolves them against the same files the app ships, so tests exercise the
// real wasm and the real hashing rather than a stand-in — a JS reimplementation
// that silently drifts from the circuit is exactly the failure these tests exist
// to catch.
//
// Import for side effects, before anything that hashes:
//     import '../../../test/public-fetch-shim';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '../public');

const upstreamFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url.startsWith('/')) {
    const file = path.join(PUBLIC_DIR, url);
    if (!existsSync(file)) throw new Error(`test fetch shim: missing ${file}`);
    return new Response(readFileSync(file), { status: 200 });
  }
  return upstreamFetch(input, init);
}) as typeof fetch;
