import { useEffect, useState } from 'react';

import Button from './components/common/Button';
import ToastContainer from './components/common/ToastContainer';
import { useWalletStore } from './store/wallet';
import { usePoolStore } from './store/pool';
import { usePositionsStore } from './store/positions';

import Dashboard from './pages/Dashboard';
import Pool from './pages/Pool';
import Positions from './pages/Positions';
import Escrow from './pages/Escrow';
import Settings from './pages/Settings';

export type RouteKey = 'dashboard' | 'pool' | 'positions' | 'escrow' | 'settings';

const navItems: Array<{ route: RouteKey; href: string; label: string; status?: string }> = [
  { route: 'dashboard', href: '/app', label: 'Dashboard' },
  { route: 'pool', href: '/app?view=pool', label: 'XLM Vault' },
  { route: 'positions', href: '/app?view=positions', label: 'Positions', status: 'Preview' },
  { route: 'escrow', href: '/app?view=escrow', label: 'Settlements', status: 'Preview' },
  { route: 'settings', href: '/app?view=settings', label: 'Settings' },
];

function routeFromLocation(fallback: RouteKey): RouteKey {
  const view = new URLSearchParams(window.location.search).get('view');
  if (view === 'pool' || view === 'positions' || view === 'escrow' || view === 'settings') return view;
  return fallback;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function renderRoute(route: RouteKey) {
  switch (route) {
    case 'pool':
      return <Pool />;
    case 'positions':
      return <Positions />;
    case 'escrow':
      return <Escrow />;
    case 'settings':
      return <Settings />;
    default:
      return <Dashboard />;
  }
}

export default function App({ initialRoute = 'dashboard' }: { initialRoute?: RouteKey }) {
  const { address, keys, isConnecting, isUnlocking, error, connect, disconnect, unlockShieldedKeys } = useWalletStore();
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

  const handleUnlock = async () => {
    try {
      await unlockShieldedKeys();
      usePoolStore.getState().fetchState();
      usePositionsStore.getState().fetchState();
    } catch (e) {
      console.error('Failed to unlock keys:', e);
    }
  };

  const currentPage = navItems.find((item) => item.route === route)?.label ?? 'Dashboard';

  return (
    <div className="dapp-shell">
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
              <span>{item.label}</span>
              {item.status && <small>{item.status}</small>}
            </a>
          ))}
        </nav>

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

      <main className="dapp-main">
        <header className="dapp-topbar">
          <div className="dapp-topbar__context">
            <span>Private workspace</span>
            <strong>{currentPage}</strong>
          </div>
          <div className="dapp-wallet">
            {address ? (
              <>
                <div className="dapp-wallet__identity">
                  <span className="dapp-label-text"><i aria-hidden="true" /> Connected</span>
                  <strong>{shortAddress(address)}</strong>
                </div>
                {!keys && (
                  <Button onClick={handleUnlock} disabled={isUnlocking}>
                    {isUnlocking ? 'Unlocking...' : 'Unlock Workspace'}
                  </Button>
                )}
                <Button variant="ghost" onClick={disconnect}>
                  Disconnect
                </Button>
              </>
            ) : (
              <Button onClick={connect} disabled={isConnecting || isUnlocking}>
                {isConnecting ? 'Connecting' : 'Connect wallet'}
              </Button>
            )}
          </div>
        </header>

        {error && <div className="dapp-alert dapp-alert--error">{error}</div>}

        <div className="page-content">{renderRoute(route)}</div>
      </main>

      <ToastContainer />
    </div>
  );
}
