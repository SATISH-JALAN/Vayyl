// ============================================================
// SEP-1 (stellar.toml) currency lookup
// ============================================================
// Pure helpers for turning an issuer's `stellar.toml` into an icon URL, plus
// the guard that decides whether that URL is safe to fetch.
//
// The guard matters more than the parser. The URL comes out of a file hosted by
// a third party, and the server fetches it -- that is a server-side request
// forgery primitive by construction. Everything below narrows what an issuer
// can make our server do.

/** One `[[CURRENCIES]]` entry, reduced to the fields we use. */
export interface TomlCurrency {
  code?: string;
  issuer?: string;
  image?: string;
}

/**
 * Extract `[[CURRENCIES]]` blocks from a stellar.toml.
 *
 * A deliberately small parser rather than a TOML dependency: three string
 * fields are needed, the shape is fixed by SEP-1, and a parser that throws on
 * an unrelated malformed section elsewhere in someone's TOML would lose a logo
 * for a reason that has nothing to do with the logo.
 *
 * Values may be single- or double-quoted. Anything it cannot read is simply
 * absent, never guessed.
 */
export function parseCurrencies(toml: string): TomlCurrency[] {
  const out: TomlCurrency[] = [];
  let current: TomlCurrency | null = null;

  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;

    if (/^\[\[\s*CURRENCIES\s*\]\]$/i.test(line)) {
      if (current) out.push(current);
      current = {};
      continue;
    }

    // Any other section header closes the current currency block. Without this
    // a `code` in a later [DOCUMENTATION] table would be read as a currency's.
    if (/^\[/.test(line)) {
      if (current) out.push(current);
      current = null;
      continue;
    }

    if (!current) continue;

    const m = line.match(/^(code|issuer|image)\s*=\s*(.+)$/i);
    if (!m) continue;
    let value = m[2].trim();
    // Strip a trailing inline comment only when the value is quoted, so a `#`
    // inside an unquoted value is not silently truncated.
    const quoted = value.match(/^"([^"]*)"|^'([^']*)'/);
    value = quoted ? (quoted[1] ?? quoted[2] ?? '') : value.split('#')[0].trim();
    current[m[1].toLowerCase() as keyof TomlCurrency] = value;
  }

  if (current) out.push(current);
  return out;
}

/** Find the entry for one asset. Code match is case-insensitive; issuer is not. */
export function findCurrency(
  currencies: TomlCurrency[],
  code: string,
  issuer: string,
): TomlCurrency | undefined {
  return currencies.find(
    (c) => c.code?.toUpperCase() === code.toUpperCase() && c.issuer === issuer,
  );
}

/**
 * Hostnames the server must never be talked into fetching.
 *
 * 169.254.169.254 is the cloud metadata endpoint -- on most hosts, reachable
 * credentials. The rest keep an issuer from using our server to probe whatever
 * is listening on its own loopback or private network.
 */
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',
  '[::1]',
  '::1',
]);

const PRIVATE_IPV4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;

/**
 * Whether a URL from someone else's TOML may be fetched.
 *
 * HONEST LIMIT: this is hostname-level filtering. A public name that resolves
 * to a private address still passes, because checking that properly means
 * resolving DNS here and pinning the resolved address for the actual
 * connection, which Node's fetch does not expose. What this does buy is that a
 * TOML cannot name loopback, a link-local metadata endpoint, an RFC1918
 * address, a non-HTTPS scheme, or a non-standard port outright. Combined with
 * the response caps in the route -- content-type must be an image, size is
 * bounded, redirects are not followed by default -- the remaining exposure is a
 * blind request to an internal host, with no response returned to the caller.
 */
export function isSafeImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  // https only. An http image would also be blocked by the browser on an https
  // deployment, so allowing it here would produce a logo that works locally and
  // vanishes in production.
  if (url.protocol !== 'https:') return false;

  // Credentials in a URL are never legitimate for a public logo, and would be
  // forwarded by fetch.
  if (url.username || url.password) return false;

  // Default port only.
  if (url.port && url.port !== '443') return false;

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return false;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  if (PRIVATE_IPV4.test(host)) return false;
  // Any IPv6 literal. Public ones exist, but no issuer needs one for a logo,
  // and enumerating the private ranges correctly is easy to get subtly wrong.
  if (host.startsWith('[')) return false;

  return true;
}

/** The SEP-1 location for a home domain. */
export function tomlUrl(homeDomain: string): string {
  return `https://${homeDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/.well-known/stellar.toml`;
}
