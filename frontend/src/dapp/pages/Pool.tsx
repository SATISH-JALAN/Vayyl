import { useState } from 'react';

import Card from '../components/common/Card';
import DepositForm from '../components/pool/DepositForm';
import WithdrawForm from '../components/pool/WithdrawForm';

type PoolMode = 'deposit' | 'withdraw';

export default function Pool() {
  const [activeMode, setActiveMode] = useState<PoolMode>('deposit');

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Shielded Pool</h1>
          <p className="dapp-page-subtitle">
            Create shielded XLM notes and unshield them to public Stellar addresses when settlement is ready.
          </p>
        </div>
        <span className="dapp-badge dapp-badge--success">Active</span>
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
              <h2 className="dapp-card__title">Proof flow</h2>
              <p className="dapp-card__description">Sensitive values stay client-side while proofs verify settlement state.</p>
            </div>
          </div>
          <div className="dapp-proof-steps">
            <div className="dapp-proof-step">Freighter authorizes shielded key derivation for the connected wallet.</div>
            <div className="dapp-proof-step">The proof worker creates a Groth16 proof off the main thread.</div>
            <div className="dapp-proof-step">Soroban verifies the proof against the pool contract.</div>
            <div className="dapp-proof-step">Spendable note state is kept with the connected shielded identity.</div>
          </div>
        </Card>
      </div>
    </div>
  );
}
