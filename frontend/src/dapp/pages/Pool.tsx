import { useEffect, useState } from 'react';

import Card from '../components/common/Card';
import DepositForm from '../components/pool/DepositForm';
import WithdrawForm from '../components/pool/WithdrawForm';
import { poseidon2Hash2 } from '../lib/poseidon';
import { useWalletStore } from '../store/wallet';

type PoolMode = 'deposit' | 'withdraw';

export default function Pool() {
  const [activeMode, setActiveMode] = useState<PoolMode>('deposit');
  const [aspLeaf, setAspLeaf] = useState('');
  const keys = useWalletStore((state) => state.keys);

  useEffect(() => {
    if (!keys) {
      setAspLeaf('');
      return;
    }
    void poseidon2Hash2(keys.pubX, keys.pubY).then((leaf) => setAspLeaf(leaf.toString()));
  }, [keys]);

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">Private XLM vault</h1>
          <p className="dapp-page-subtitle">
            Shield native XLM into a private note, then settle that exact note to a public Stellar address.
          </p>
        </div>
        <span className="dapp-badge dapp-badge--success">Active</span>
      </header>

      <section className="dapp-release dapp-release--quiet" aria-label="Vault eligibility">
        <div>
          <span className="dapp-release__signal" aria-hidden="true" />
          <div>
            <strong>{aspLeaf ? 'Shielded eligibility key ready' : 'Unlock your workspace first'}</strong>
            <p>{aspLeaf ? 'This public leaf is used once to enroll the demo wallet in the Vault v1 ASP.' : 'Freighter signs a fixed message locally to derive your shielded identity.'}</p>
          </div>
        </div>
        {aspLeaf && (
          <button className="dapp-copy" type="button" onClick={() => navigator.clipboard.writeText(aspLeaf)} title={aspLeaf}>
            Copy ASP leaf
          </button>
        )}
      </section>

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
