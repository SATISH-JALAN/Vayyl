import React, { useEffect, useRef } from 'react';
import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import gsap from 'gsap';
import { useWalletStore } from './store/wallet';
import Button from './components/common/Button';
import ToastContainer from './components/common/ToastContainer';

// Pages
import Dashboard from './pages/Dashboard';
import Pool from './pages/Pool';
import Positions from './pages/Positions';
import Settings from './pages/Settings';

export default function App() {
  const { address, network, setNetwork, isConnecting, connect, disconnect } = useWalletStore();
  const location = useLocation();
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Initial load animation
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo('.dapp-sidebar', 
        { x: -50, opacity: 0 }, 
        { x: 0, opacity: 1, duration: 1, ease: 'power3.out' }
      );
      gsap.fromTo('.dapp-main',
        { y: 30, opacity: 0 },
        { y: 0, opacity: 1, duration: 1, delay: 0.2, ease: 'power3.out' }
      );
    }, shellRef);

    return () => ctx.revert();
  }, []);

  // Page transition animation
  useEffect(() => {
    if (!contentRef.current) return;
    
    gsap.fromTo(contentRef.current,
      { opacity: 0, y: 15 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }
    );
  }, [location.pathname]);

  const toggleNetwork = () => {
    setNetwork(network === 'TESTNET' ? 'MAINNET' : 'TESTNET');
  };

  return (
    <div className="dapp-shell" ref={shellRef}>
      {/* Sidebar Navigation */}
      <aside className="dapp-sidebar">
        <div className="dapp-sidebar__header">
          <a href="/" className="dapp-sidebar__logo">Vayyl</a>
        </div>
        
        <nav className="dapp-sidebar__nav">
          <NavLink to="/" className={({ isActive }) => `dapp-sidebar__link ${isActive ? 'is-active' : ''}`}>
            Dashboard
          </NavLink>
          <NavLink to="/pool" className={({ isActive }) => `dapp-sidebar__link ${isActive ? 'is-active' : ''}`}>
            Shielded Pool
          </NavLink>
          <NavLink to="/positions" className={({ isActive }) => `dapp-sidebar__link ${isActive ? 'is-active' : ''}`}>
            Positions
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `dapp-sidebar__link ${isActive ? 'is-active' : ''}`}>
            Settings
          </NavLink>
        </nav>

        <div className="dapp-sidebar__footer">
          <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Network:</span>
            <button 
              onClick={toggleNetwork}
              style={{ 
                background: 'transparent', 
                border: '1px solid var(--color-border)', 
                color: 'var(--text-primary)',
                padding: '4px 8px',
                borderRadius: '4px',
                fontSize: '10px',
                cursor: 'pointer'
              }}
            >
              {network}
            </button>
          </div>
          {address ? (
            <div>
              <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '8px' }}>
                {address.substring(0, 6)}...{address.substring(50)}
              </p>
              <Button variant="ghost" onClick={disconnect} style={{ width: '100%', fontSize: '12px', padding: '8px' }}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button onClick={connect} style={{ width: '100%' }}>
              {isConnecting ? 'Connecting...' : 'Connect Wallet'}
            </Button>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="dapp-main">
        <div ref={contentRef} className="page-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pool" element={<Pool />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>
      <ToastContainer />
    </div>
  );
}
