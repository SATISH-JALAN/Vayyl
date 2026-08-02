import { useEffect, useMemo, useState } from 'react';

import Card from '../components/common/Card';
import DepositForm from '../components/pool/DepositForm';
import TransferForm from '../components/pool/TransferForm';
import WithdrawForm from '../components/pool/WithdrawForm';
import { usePoolStore } from '../store/pool';
import { useWalletStore } from '../store/wallet';
import { encodeShieldedAddress } from '../lib/address';

type PoolMode = 'deposit' | 'transfer' | 'withdraw';

const MODES: Array<{ id: PoolMode; label: string }> = [
  { id: 'deposit', label: 'Shield' },
  { id: 'transfer', label: 'Send' },
  { id: 'withdraw', label: 'Unshield' },
];

export default function Pool() {
  const [activeMode, setActiveMode] = useState<PoolMode>('deposit');
  const [copied, setCopied] = useState(false);
  const keys = useWalletStore((state) => state.keys);
  const { fetchState } = usePoolStore();

  useEffect(() => {
    if (keys) void fetchState();
  }, [keys, fetchState]);

  // Derived from the wallet's shielded key, so it appears only after unlock and
  // is never something the user has to create or remember.
  const shieldedAddress = useMemo(() => {
    if (!keys) return null;
    try {
      return encodeShieldedAddress({ pubX: keys.pubX, pubY: keys.pubY });
    } catch {
      return null;
    }
  }, [keys]);

  const copyAddress = async () => {
    if (!shieldedAddress) return;
    await navigator.clipboard.writeText(shieldedAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="dapp-stack">
      <header className="dapp-page-header">
        <div>
          <h1 className="dapp-page-title">XLM Vault</h1>
          <p className="dapp-page-subtitle">Shield, send privately, and unshield a 1 XLM note.</p>
        </div>
        <span className="dapp-badge">1 XLM note</span>
      </header>

      <div className="dapp-grid dapp-grid--pool">
        <div className="dapp-stack">
          <div className="dapp-segment" role="tablist" aria-label="Shielded pool action">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                className={`dapp-segment__button ${activeMode === mode.id ? 'is-active' : ''}`}
                type="button"
                role="tab"
                aria-selected={activeMode === mode.id}
                onClick={() => setActiveMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>

          {activeMode === 'deposit' ? <DepositForm />
            : activeMode === 'transfer' ? <TransferForm />
              : <WithdrawForm />}
        </div>

        <Card>
          <div className="dapp-card__header">
            <div>
              <h2 className="dapp-card__title">Your shielded address</h2>
              <p className="dapp-card__description">
                Share this to receive private payments. It is not a Stellar
                account and never appears on the ledger.
              </p>
            </div>
          </div>

          {shieldedAddress ? (
            <>
              <div className="dapp-transaction-confirmation">
                <code style={{ wordBreak: 'break-all' }}>{shieldedAddress}</code>
              </div>
              <button className="dapp-button dapp-button--ghost dapp-card-action" type="button" onClick={copyAddress}>
                {copied ? 'Copied' : 'Copy address'}
              </button>
            </>
          ) : (
            <div className="dapp-empty">
              <strong>Unlock your wallet</strong>
              <p>Connect and unlock to derive your shielded address.</p>
            </div>
          )}

          <div className="dapp-proof-steps">
            <div className="dapp-proof-step">Payments to this address arrive automatically.</div>
            <div className="dapp-proof-step">Export an encrypted backup from Settings.</div>
            <div className="dapp-proof-step">Unshield to any funded Stellar account.</div>
          </div>
          <a className="dapp-button dapp-button--ghost dapp-card-action" href="/app?view=settings">Manage backup</a>
        </Card>
      </div>
    </div>
  );
}
