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

  return (
    <div className="dapp-shell">
      <aside className="dapp-sidebar" aria-label="Vayyl app navigation">
        <div className="dapp-sidebar__header">
          <a href="/" className="dapp-sidebar__logo" aria-label="Back to Vayyl landing page">
            Vayyl
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
            >
              <span>{item.label}</span>
              {item.status && <small>{item.status}</small>}
            </a>
          ))}
        </nav>

      </aside>

      <main className="dapp-main">
        <header className="dapp-topbar">
          <div className="dapp-wallet">
            {address ? (
              <>
                <div className="dapp-wallet__identity">
                  <span className="dapp-label-text">Wallet</span>
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
