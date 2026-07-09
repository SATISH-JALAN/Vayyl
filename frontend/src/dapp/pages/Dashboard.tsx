import { useEffect } from 'react';

import Card from '../components/common/Card';
import ActivityFeed from '../components/dashboard/ActivityFeed';
import { usePoolStore } from '../store/pool';
import { useWalletStore } from '../store/wallet';

function noteLabel(id: string): string {
  return `${id.slice(0, 10)}...${id.slice(-6)}`;
}

export default function Dashboard() {
  const { shieldedBalance, notes, activity, status, fetchState } = usePoolStore();
  const { address, keys, isUnlocking } = useWalletStore();
  const activeNotes = notes.filter((note) => !note.isSpent);

  useEffect(() => {
    if (address && keys) void fetchState();
  }, [address, keys, fetchState]);

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Dashboard</h1>
          <p className="dapp-page-subtitle">
            Monitor shielded balances, spendable notes, and recent private settlement activity.
          </p>
        </div>
        <div className="dapp-page-actions">
          <a className="dapp-button dapp-button--primary" href="/app?view=pool">
            Open shielded pool
          </a>
        </div>
      </header>

      {!address ? (
        <Card className="dapp-card--strong">
          <div className="dapp-empty">
            <strong>Wallet required</strong>
            <p>Connect Freighter to unlock shielded balances and private settlement activity.</p>
          </div>
        </Card>
      ) : (
        <>
          <div className="dapp-grid dapp-grid--overview">
            <Card className="dapp-card--strong">
              <div className="dapp-metric">
                <span className="dapp-metric__label">Shielded balance</span>
                <span className="dapp-metric__value">{shieldedBalance} XLM</span>
                <span className="dapp-metric__meta">
                  {activeNotes.length} active note{activeNotes.length === 1 ? '' : 's'} for this viewing key
                </span>
              </div>
            </Card>

            <Card>
              <div className="dapp-card__header">
                <div>
                  <h2 className="dapp-card__title">Shielded notes</h2>
                  <p className="dapp-card__description">
                    Spendable commitments associated with the connected shielded identity.
                  </p>
                </div>
                <span className="dapp-badge dapp-badge--muted">Private</span>
              </div>

              {activeNotes.length === 0 ? (
                <div className="dapp-empty">
                  <strong>No shielded notes</strong>
                  <p>Deposit XLM into the shielded pool to create the first spendable note.</p>
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
                  <p className="dapp-card__description">Proof generation and settlement state for the current session.</p>
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
