import React from 'react';
import Card from '../components/common/Card';
import ActivityFeed from '../components/dashboard/ActivityFeed';
import { usePoolStore } from '../store/pool';
import { useWalletStore } from '../store/wallet';

export default function Dashboard() {
  const { shieldedBalance, notes } = usePoolStore();
  const { address } = useWalletStore();

  return (
    <div>
      <header className="dapp-page-header">
        <h1 className="dapp-page-title">Dashboard</h1>
        <p className="dapp-page-subtitle">Your confidential portfolio overview.</p>
      </header>

      {!address ? (
        <Card>
          <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--text-muted)' }}>
            <p>Connect your wallet to view your shielded assets.</p>
          </div>
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '2rem' }}>
          {/* Balance Card */}
          <Card style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-caption)', letterSpacing: 'var(--tracking-caps)', textTransform: 'uppercase', marginBottom: '1rem' }}>Total Shielded Value</span>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(2.5rem, 4vw, 3.5rem)', color: 'var(--text-primary)', lineHeight: 1 }}>
              ${(shieldedBalance * 0.1).toFixed(2)} {/* Mock conversion rate */}
            </span>
            <span style={{ color: 'var(--coral)', marginTop: '0.5rem', fontFamily: 'var(--font-mono)' }}>{shieldedBalance} XLM</span>
          </Card>

          {/* Active Notes */}
          <Card>
            <h3 style={{ fontSize: 'var(--text-small)', letterSpacing: 'var(--tracking-caps)', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>Active Shielded Notes</h3>
            {notes.length === 0 ? (
              <p style={{ color: 'var(--text-muted)' }}>No active notes.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {notes.map(note => (
                  <div key={note.id} style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '1rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{note.id}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{note.amount} {note.asset}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
      
      {address && (
        <div style={{ marginTop: '2rem' }}>
          <ActivityFeed />
        </div>
      )}
    </div>
  );
}
