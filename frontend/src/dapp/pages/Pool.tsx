import { useEffect, useState } from 'react';

import Card from '../components/common/Card';
import DepositForm from '../components/pool/DepositForm';
import WithdrawForm from '../components/pool/WithdrawForm';
import { usePoolStore } from '../store/pool';
import { useWalletStore } from '../store/wallet';

type PoolMode = 'deposit' | 'withdraw';

export default function Pool() {
  const [activeMode, setActiveMode] = useState<PoolMode>('deposit');
  const keys = useWalletStore((state) => state.keys);
  const { fetchState } = usePoolStore();

  useEffect(() => {
    if (keys) void fetchState();
  }, [keys, fetchState]);

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">XLM Vault</h1>
          <p className="dapp-page-subtitle">Shield, back up, and restore a 1 XLM note.</p>
        </div>
        <span className="dapp-badge">1 XLM note</span>
      </header>

      <div className="dapp-grid dapp-grid--pool">
        <div className="dapp-stack">
          <div className="dapp-segment" role="tablist" aria-label="Shielded pool action">
            <button
              className={`dapp-segment__button ${activeMode === 'deposit' ? 'is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={activeMode === 'deposit'}
              onClick={() => setActiveMode('deposit')}
            >
              Shield
            </button>
            <button
              className={`dapp-segment__button ${activeMode === 'withdraw' ? 'is-active' : ''}`}
              type="button"
              role="tab"
              aria-selected={activeMode === 'withdraw'}
              onClick={() => setActiveMode('withdraw')}
            >
              Unshield
            </button>
          </div>

          {activeMode === 'deposit' ? <DepositForm /> : <WithdrawForm />}
        </div>

        <Card>
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Your note</h2>
              <p className="dapp-card__description">Everything needed to recover the note stays with your encrypted backup.</p>
            </div>
          </div>
          <div className="dapp-proof-steps">
            <div className="dapp-proof-step">Create a note from the connected wallet.</div>
            <div className="dapp-proof-step">Export an encrypted backup from Settings.</div>
            <div className="dapp-proof-step">Import it later with the same wallet.</div>
            <div className="dapp-proof-step">Unshield to any funded Stellar account.</div>
          </div>
          <a className="dapp-button dapp-button--ghost dapp-card-action" href="/app?view=settings">Manage backup</a>
        </Card>
      </div>
    </div>
  );
}
