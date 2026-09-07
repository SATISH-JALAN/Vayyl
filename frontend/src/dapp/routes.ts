// ============================================================
// The route table
// ============================================================
// Its own module, holding no React and no store imports, because BOTH sides of
// the app need it:
//
//   - src/dapp/App.tsx reads ?view= on the client, on mount and on popstate.
//   - src/app/app/page.tsx reads the SAME parameter on the server to choose
//     what to render before hydration.
//
// Those two lists were written out by hand and drifted: page.tsx omitted
// 'compliance', so /app?view=compliance server-rendered the Dashboard and only
// flipped to Compliance after hydration -- a visible flash on a link that is in
// the sidebar. Declaring the routes once means the next one added cannot
// desync them.
//
// page.tsx cannot simply import this from App.tsx: App.tsx pulls in every page
// component and Zustand store, and a server component importing it would drag
// all of that into the server bundle. Hence a separate, dependency-free module.

export const ROUTE_KEYS = [
  'dashboard',
  'pool',
  'positions',
  'escrow',
  'compliance',
  'settings',
] as const;

export type RouteKey = (typeof ROUTE_KEYS)[number];

export function isRouteKey(value: unknown): value is RouteKey {
  return typeof value === 'string' && (ROUTE_KEYS as readonly string[]).includes(value);
}

/**
 * Resolve a ?view= parameter to a route.
 *
 * An unrecognised value falls back rather than erroring: ?view= comes from the
 * address bar, so a typo should land somewhere sensible, not on a crash.
 */
export function routeFromView(
  value: string | string[] | undefined,
  fallback: RouteKey = 'dashboard',
): RouteKey {
  const view = Array.isArray(value) ? value[0] : value;
  return isRouteKey(view) ? view : fallback;
}
