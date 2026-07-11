import { useEffect, useState } from 'react';

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
  const [indexerOnline, setIndexerOnline] = useState<boolean | null>(null);
  const poolId = process.env.NEXT_PUBLIC_POOL_XLM ?? '';
  const verifierId = process.env.NEXT_PUBLIC_VERIFIER ?? '';
  const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL ?? 'http://localhost:3001';

  useEffect(() => {
    if (address && keys) void fetchState();
  }, [address, keys, fetchState]);

  useEffect(() => {
    fetch(`${indexerUrl}/health`)
      .then((response) => setIndexerOnline(response.ok))
      .catch(() => setIndexerOnline(false));
  }, [indexerUrl]);

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

      <section className="dapp-release" aria-label="Mainnet release status">
        <div>
          <span className="dapp-release__signal" aria-hidden="true" />
          <div>
            <strong>Vault v1 is live on Mainnet</strong>
            <p>Deposit and whole-note withdrawal verification keys are registered.</p>
          </div>
        </div>
        <span className={`dapp-badge ${indexerOnline ? 'dapp-badge--success' : indexerOnline === false ? 'dapp-badge--warning' : 'dapp-badge--muted'}`}>
          Indexer {indexerOnline ? 'online' : indexerOnline === false ? 'offline' : 'checking'}
        </span>
      </section>

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

          <Card>
            <div className="dapp-card__header">
              <div>
                <h2 className="dapp-card__title">Mainnet evidence</h2>
                <p className="dapp-card__description">Frozen Vault v1 deployment used by this interface.</p>
              </div>
              <span className="dapp-badge dapp-badge--success">Verified</span>
            </div>
            <div className="dapp-contract-list">
              <a href={`https://stellar.expert/explorer/public/contract/${poolId}`} target="_blank" rel="noreferrer">
                <span>Shielded XLM pool</span><code>{noteLabel(poolId)}</code>
              </a>
              <a href={`https://stellar.expert/explorer/public/contract/${verifierId}`} target="_blank" rel="noreferrer">
                <span>Groth16 verifier</span><code>{noteLabel(verifierId)}</code>
              </a>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
