import { useEffect } from 'react';

import Card from '../components/common/Card';
import Button from '../components/common/Button';
import ActivityFeed from '../components/dashboard/ActivityFeed';
import { usePoolStore } from '../store/pool';
import { useWalletStore } from '../store/wallet';

function noteLabel(id: string): string {
  return `${id.slice(0, 10)}...${id.slice(-6)}`;
}

export default function Dashboard() {
  const { shieldedBalance, notes, activity, status, fetchState } = usePoolStore();
  const { address, keys, isConnecting, isUnlocking, connect, unlockShieldedKeys } = useWalletStore();
  const activeNotes = notes.filter((note) => !note.isSpent);

  useEffect(() => {
    if (address && keys) void fetchState();
  }, [address, keys, fetchState]);

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Overview</h1>
          <p className="dapp-page-subtitle">Your notes and recent activity.</p>
        </div>
        <div className="dapp-page-actions">
          <a className="dapp-button dapp-button--primary" href="/app?view=pool">
            Open vault
          </a>
        </div>
      </header>

      {!address ? (
        <Card className="dapp-card--strong dapp-arrival">
          <div className="dapp-arrival__copy">
            <span className="dapp-arrival__step">Start here</span>
            <h2>Connect your Stellar wallet</h2>
            <p>Your wallet signs transactions and derives the private workspace locally. Vayyl never receives its recovery phrase.</p>
          </div>
          <Button onClick={connect} disabled={isConnecting}>{isConnecting ? 'Connecting' : 'Connect wallet'}</Button>
        </Card>
      ) : !keys ? (
        <Card className="dapp-card--strong dapp-arrival">
          <div className="dapp-arrival__copy">
            <span className="dapp-arrival__step">Wallet connected</span>
            <h2>Unlock your private workspace</h2>
            <p>Sign one authentication message to recover the viewing key for this session. This does not move funds.</p>
          </div>
          <Button onClick={() => void unlockShieldedKeys().catch(() => undefined)} disabled={isUnlocking}>{isUnlocking ? 'Unlocking' : 'Unlock workspace'}</Button>
        </Card>
      ) : (
        <>
          <div className="dapp-grid dapp-grid--overview">
            <Card className="dapp-card--strong">
              <div className="dapp-metric">
                <span className="dapp-metric__label">Vault balance</span>
                <span className="dapp-metric__value">{shieldedBalance} XLM</span>
                <span className="dapp-metric__meta">
                  {activeNotes.length} active note{activeNotes.length === 1 ? '' : 's'} for this viewing key
                </span>
              </div>
            </Card>

            <Card>
              <div className="dapp-card__header">
                <div>
                  <h2 className="dapp-card__title">Notes</h2>
                  <p className="dapp-card__description">Spendable notes stored for this wallet.</p>
                </div>
                <span className="dapp-badge dapp-badge--muted">Private</span>
              </div>

              {activeNotes.length === 0 ? (
                <div className="dapp-empty">
                  <strong>No notes yet</strong>
                  <p>Shield 1 XLM to create your first note.</p>
                </div>
              ) : (
                <div className="dapp-note-list">
                  {activeNotes.map((note) => (
                    <div className="dapp-note" key={note.id}>
                      <span className="dapp-note__id">{noteLabel(note.id)}</span>
                      <span className="dapp-note__amount">
                        {note.amount} {note.asset}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <div className="dapp-grid dapp-grid--overview">
            <Card>
              <div className="dapp-card__header">
                <div>
                  <h2 className="dapp-card__title">Transaction status</h2>
                  <p className="dapp-card__description">Current vault operation.</p>
                </div>
                <span className={`dapp-badge ${status?.toLowerCase().includes('failed') ? 'dapp-badge--warning' : ''}`}>
                  {isUnlocking ? 'Unlocking' : 'Ready'}
                </span>
              </div>
              <p className={`dapp-status ${status?.toLowerCase().includes('failed') ? 'dapp-status--error' : ''}`}>
                {status ?? 'No active operation.'}
              </p>
            </Card>

            <ActivityFeed activityCount={activity.length} />
          </div>
        </>
      )}
    </div>
  );
}
