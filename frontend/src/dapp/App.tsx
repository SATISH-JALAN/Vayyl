import { useEffect, useState } from 'react';

import ToastContainer from './components/common/ToastContainer';
import WalletControls from './components/common/WalletControls';
import MarketBar from './components/positions/MarketBar';
import { useWalletStore } from './store/wallet';
import { usePoolStore } from './store/pool';
import { usePositionsStore } from './store/positions';

import Dashboard from './pages/Dashboard';
import Pool from './pages/Pool';
import Positions from './pages/Positions';
import Escrow from './pages/Escrow';
import Compliance from './pages/Compliance';
import Settings from './pages/Settings';
import { routeFromView, type RouteKey } from './routes';

// Re-exported so existing importers keep working; ./routes is the definition,
// and src/app/app/page.tsx imports it from there rather than through this
// module, which would pull every page component into the server bundle.
export type { RouteKey };

/** Stroke icons, sized to the 14px nav row. */
const icons: Record<RouteKey, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  pool: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M12 6V3" />
    </>
  ),
  positions: (
    <>
      <path d="M3 17l5-6 4 4 5-8" />
      <path d="M3 21h18" />
    </>
  ),
  escrow: (
    <>
      <path d="M4 5h16v14H4z" />
      <path d="M4 10h16M9 15h6" />
    </>
  ),
  compliance: (
    <>
      <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
};

const navItems: Array<{ route: RouteKey; href: string; label: string; status?: string }> = [
  { route: 'dashboard', href: '/app', label: 'Dashboard' },
  { route: 'pool', href: '/app?view=pool', label: 'Private Payments' },
  // "Preview" stays until the contracts behind a page are actually deployed. The
  // page itself reports the same thing, but the nav is where a user decides what
  // to click, and a label that oversells it wastes their time.
  //
  // Positions no longer carries one: the position contracts were deployed to testnet
  // on 5 September 2026 and every path on this page reaches a real contract.
  { route: 'positions', href: '/app?view=positions', label: 'Private Positions' },
  { route: 'escrow', href: '/app?view=escrow', label: 'Settlements', status: 'Preview' },
  { route: 'compliance', href: '/app?view=compliance', label: 'Compliance (ASP)' },
  { route: 'settings', href: '/app?view=settings', label: 'Settings' },
];

/** The terminal needs more width than the reading-width pages. */
const WIDE_ROUTES: RouteKey[] = ['positions'];

/**
 * Routes laid out to the viewport instead of growing the page.
 *
 * A trading terminal whose positions table is below the fold is the wrong
 * shape: the row telling you what you are exposed to should never need a
 * scroll. The CSS applies this only above 980px wide and 700px tall — below
 * either, the page reverts to normal flow, because a locked 100dvh layout on a
 * phone or a short laptop just clips content instead of fitting it.
 */
const FIXED_HEIGHT_ROUTES: RouteKey[] = ['positions'];

/** Routes that render their own topbar instead of the shell's. */
const OWN_TOPBAR_ROUTES: RouteKey[] = ['positions'];

function routeFromLocation(fallback: RouteKey): RouteKey {
  return routeFromView(new URLSearchParams(window.location.search).get('view') ?? undefined, fallback);
}

function renderRoute(route: RouteKey) {
  switch (route) {
    case 'pool':
      return <Pool />;
    case 'positions':
      return <Positions />;
    case 'escrow':
      return <Escrow />;
    case 'compliance':
      return <Compliance />;
    case 'settings':
      return <Settings />;
    default:
      return <Dashboard />;
  }
}

export default function App({ initialRoute = 'dashboard' }: { initialRoute?: RouteKey }) {
  const error = useWalletStore((s) => s.error);
  const [route, setRoute] = useState<RouteKey>(() =>
    typeof window === 'undefined' ? initialRoute : routeFromLocation(initialRoute),
  );

  useEffect(() => {
    const syncRoute = () => setRoute(routeFromLocation(initialRoute));
    syncRoute();
    window.addEventListener('popstate', syncRoute);
    return () => {
      window.removeEventListener('popstate', syncRoute);
    };
  }, [initialRoute]);

  useEffect(() => {
    useWalletStore.getState().autoConnect();
  }, []);

  const currentPage = navItems.find((item) => item.route === route)?.label ?? 'Dashboard';

  // Reported rather than assumed. Proof generation must stay off the main
  // thread -- iOS Safari kills workers over roughly 1-2GB and some circuits
  // will not run at all there -- so a browser without Worker support cannot
  // prove, and saying "Ready" in that case would be a lie the user only
  // discovers after filling in a form.
  //
  // Resolved in an effect rather than during render because `Worker` never
  // exists on the server. Deciding at render time made the server emit
  // "unavailable" and the client "Ready", which is a hydration mismatch --
  // React throws #418 and discards the server markup for that subtree.
  const [workerSupported, setWorkerSupported] = useState<boolean | null>(null);
  useEffect(() => setWorkerSupported(typeof Worker !== 'undefined'), []);

  const poolProving = usePoolStore((s) => s.isProving);
  const positionsProving = usePositionsStore((s) => s.isProving);
  const proverState =
    workerSupported === null
      ? { label: 'Web Worker Prover: checking…', tone: '' }
      : !workerSupported
        ? { label: 'Web Worker Prover: unavailable', tone: 'is-error' }
        : poolProving || positionsProving
          ? { label: 'Web Worker Prover: proving…', tone: 'is-busy' }
          : { label: 'Web Worker Prover: Ready', tone: 'is-ok' };

  const fixedHeight = FIXED_HEIGHT_ROUTES.includes(route);

  return (
    <div className={`dapp-shell ${fixedHeight ? 'is-fixed' : ''}`.trim()}>
      <aside className="dapp-sidebar" aria-label="Vayyl app navigation">
        <div className="dapp-sidebar__header">
          <a href="/" className="dapp-sidebar__logo" aria-label="Back to Vayyl landing page">
            <img src="/images/vayyllogomain - Copy.png" alt="Vayyl" />
          </a>
        </div>

        <nav className="dapp-sidebar__nav">
          {navItems.map((item) => (
            <a
              key={item.route}
              href={item.href}
              onClick={(event) => {
                event.preventDefault();
                window.history.pushState(null, '', item.href);
                setRoute(item.route);
              }}
              className={`dapp-sidebar__link ${route === item.route ? 'is-active' : ''}`}
              aria-current={route === item.route ? 'page' : undefined}
            >
              <svg
                aria-hidden="true"
                className="dapp-sidebar__icon"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {icons[item.route]}
              </svg>
              <span>{item.label}</span>
              {item.status && <small>{item.status}</small>}
            </a>
          ))}
        </nav>

        <div className="dapp-prover" title="Proofs are generated in a Web Worker, never on the main thread">
          <i className={`dapp-prover__dot ${proverState.tone}`} aria-hidden="true" />
          <span>{proverState.label}</span>
        </div>

        <div className="dapp-sidebar__footer">
          <a href="https://vayyl.gitbook.io/vayyl-docs" target="_blank" rel="noreferrer">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" /></svg>
            <span>Docs</span>
          </a>
          <a href="https://x.com/Vayylstellar" target="_blank" rel="noreferrer">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" /></svg>
            <span>X</span>
          </a>
        </div>

      </aside>

      <main
        className={`dapp-main ${WIDE_ROUTES.includes(route) ? 'is-wide' : ''} ${
          fixedHeight ? 'is-terminal' : ''
        }`.trim()}
      >
        {/* The terminal owns its own top row: the design carries market stats
            and the wallet button on one line, so the shell steps aside rather
            than stacking a second header above it. */}
        {OWN_TOPBAR_ROUTES.includes(route) ? (
          <MarketBar />
        ) : (
          <header className="dapp-topbar">
            <div className="dapp-topbar__context">
              <span>Private workspace</span>
              <strong>{currentPage}</strong>
            </div>
            <WalletControls />
          </header>
        )}

        {error && <div className="dapp-alert dapp-alert--error">{error}</div>}

        <div className="page-content">{renderRoute(route)}</div>
      </main>

      <ToastContainer />
    </div>
  );
}
