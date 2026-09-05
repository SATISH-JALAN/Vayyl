import { useState } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePositionsStore } from '../../store/positions';
import { useWalletStore } from '../../store/wallet';

const xlm = (stroops: bigint, dp = 2) => (Number(stroops) / 1e7).toFixed(dp);

/**
 * The counterparty vault.
 *
 * Worth showing to users rather than hiding as plumbing, for two reasons.
 *
 * First, it answers "who is on the other side of my trade?", which in a shielded
 * derivative is otherwise unanswerable. The invariant is printed here in the
 * same terms anyone can check on-chain: balance >= reserved.
 *
 * Second, LP deposits are PUBLIC on testnet. That is a real, accepted
 * limitation -- shielding the LP side needs its own circuit -- and it is stated
 * in the panel rather than left for someone to discover in a block explorer.
 */
export default function VaultPanel() {
  const { vault, lpShares, addLiquidity, removeLiquidity, status } = usePositionsStore();
  const { address } = useWalletStore();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  if (!vault) {
    return (
      <Card>
        <div className="dapp-card__header">
          <div>
            <h2 className="dapp-card__title">Counterparty vault</h2>
            <p className="dapp-card__description">Could not read the vault right now.</p>
          </div>
        </div>
      </Card>
    );
  }

  const utilisation =
    vault.balance > 0n ? Number((vault.totalReserved * 100n) / vault.balance) : 0;
  const solvent = vault.balance >= vault.totalReserved;
  const shareValue =
    vault.totalShares > 0n ? (vault.balance * lpShares) / vault.totalShares : 0n;

  const submit = async (kind: 'add' | 'remove') => {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    setBusy(true);
    try {
      if (kind === 'add') await addLiquidity(BigInt(Math.round(parsed * 1e7)));
      else await removeLiquidity(BigInt(Math.round(parsed * 1e7)));
      setAmount('');
    } catch {
      // Surfaced by the store.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="dapp-card__header">
        <div>
          <h2 className="dapp-card__title">Counterparty vault</h2>
          <p className="dapp-card__description">
            Every open position has its best case funded here in advance. A position cannot be
            opened unless the money to pay it already exists.
          </p>
        </div>
        <span className={`dapp-badge ${solvent ? 'dapp-badge--success' : 'dapp-badge--muted'}`}>
          {solvent ? 'Fully backed' : 'Under-reserved'}
        </span>
      </div>

      <div className="dapp-summary-strip">
        <div>
          <span>Total</span>
          <strong className="dapp-mono">{xlm(vault.balance)} XLM</strong>
        </div>
        <div>
          <span>Reserved</span>
          <strong className="dapp-mono">{xlm(vault.totalReserved)} XLM</strong>
        </div>
        <div>
          <span>Free</span>
          <strong className="dapp-mono">{xlm(vault.freeBalance)} XLM</strong>
        </div>
        <div>
          <span>Utilisation</span>
          <strong className="dapp-mono">{utilisation}%</strong>
        </div>
      </div>

      <progress
        className="dapp-health-track"
        aria-label={`Vault utilisation ${utilisation}%`}
        value={100 - utilisation}
        max="100"
      />

      <p className="dapp-helper">
        The invariant, checkable by anyone at any ledger:{' '}
        <strong className="dapp-mono">balance ≥ reserved</strong>. Reserved capital belongs to
        open positions and cannot be withdrawn by liquidity providers until those positions
        close.
      </p>

      <div className="dapp-setting-list" style={{ marginTop: '16px' }}>
        <div className="dapp-setting-row">
          <div>
            <strong>Your share</strong>
            <p className="dapp-helper">
              {lpShares > 0n ? (
                <>
                  {lpShares.toString()} shares, currently worth about{' '}
                  <strong className="dapp-mono">{xlm(shareValue)} XLM</strong>. You are the
                  counterparty: you gain when traders lose and pay when they win.
                </>
              ) : (
                'You have not provided liquidity. Doing so makes you the counterparty to ' +
                'traders in this pool.'
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="dapp-form-row" style={{ marginTop: '12px' }}>
        <Input
          label="Amount"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.1"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={busy || !address}
          helperText="XLM to add, or shares to redeem."
        />
      </div>

      <div className="dapp-setting-actions">
        <Button type="button" onClick={() => submit('add')} disabled={busy || !address || !amount}>
          {busy ? 'Working…' : 'Add liquidity'}
        </Button>
        <Button
          variant="ghost"
          type="button"
          onClick={() => submit('remove')}
          disabled={busy || !address || !amount || lpShares === 0n}
        >
          Redeem shares
        </Button>
      </div>

      <p className="dapp-helper" style={{ marginTop: '12px' }}>
        <strong>Liquidity here is public.</strong> Deposits and withdrawals are visible on-chain,
        including their size and timing. Only the trading side is shielded. Shielding the
        liquidity side needs its own circuit and is not built.
      </p>

      {status && <p className="dapp-status" role="status">{status}</p>}
    </Card>
  );
}
