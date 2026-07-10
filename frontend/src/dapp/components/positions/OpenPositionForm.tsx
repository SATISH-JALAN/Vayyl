import { useState, useEffect, type FormEvent } from 'react';

import Button from '../common/Button';
import Card from '../common/Card';
import Input from '../common/Input';
import { usePositionsStore } from '../../store/positions';
import { useWalletStore } from '../../store/wallet';
import { usePoolStore } from '../../store/pool';
import { useOracleStore } from '../../store/oracle';

const LEVERAGE_OPTIONS = [2, 5, 10, 20] as const;
type Direction = 'Long' | 'Short';

export default function OpenPositionForm() {
  const [collateral, setCollateral] = useState('');
  const [direction, setDirection] = useState<Direction>('Long');
  const [leverage, setLeverage] = useState<number>(10);
  const { openPosition, isProving, status } = usePositionsStore();
  const { address } = useWalletStore();
  const { shieldedBalance } = usePoolStore();
  const { startPolling, stopPolling, prices } = useOracleStore();
  const isError = !!status && /failed|error/i.test(status);

  useEffect(() => {
    startPolling('XLM');
    return () => stopPolling('XLM');
  }, [startPolling, stopPolling]);

  const livePrice = prices['XLM'];

  const computedSize = collateral ? Number(collateral) * leverage : 0;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!collateral || Number(collateral) <= 0) return;

    try {
      // size = collateral * leverage, matching the financial logic the contract expects
      const size = (Number(collateral) * leverage).toString();
      await openPosition('XLM', direction, `${leverage}x`, size);
      setCollateral('');
    } catch {
      // error already surfaced via toast
    }
  };

  return (
    <Card className="dapp-card--strong">
      <div className="dapp-card__header">
        <div>
          <h2 className="dapp-card__title">Open position</h2>
          <p className="dapp-card__description">
            Collateralize a shielded note and open leveraged exposure with a ZK proof.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className="dapp-badge dapp-badge--success">Trade</span>
          {livePrice ? (
            <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--dapp-text-muted)' }}>
              Mark: <strong style={{ color: 'var(--dapp-text-base)' }}>${(livePrice / 1e4).toFixed(4)}</strong>
            </div>
          ) : null}
        </div>
      </div>

      <form className="dapp-form" onSubmit={handleSubmit}>
        {/* Direction toggle */}
        <div className="dapp-direction-toggle" role="radiogroup" aria-label="Position direction">
          <button
            type="button"
            className={`dapp-direction-toggle__button dapp-direction-toggle__button--long ${direction === 'Long' ? 'is-active' : ''}`}
            onClick={() => setDirection('Long')}
            disabled={isProving}
            aria-checked={direction === 'Long'}
            role="radio"
          >
            Long
          </button>
          <button
            type="button"
            className={`dapp-direction-toggle__button dapp-direction-toggle__button--short ${direction === 'Short' ? 'is-active' : ''}`}
            onClick={() => setDirection('Short')}
            disabled={isProving}
            aria-checked={direction === 'Short'}
            role="radio"
          >
            Short
          </button>
        </div>

        {/* Collateral + Asset */}
        <div className="dapp-form-row">
          <Input
            label="Collateral"
            type="number"
            inputMode="decimal"
            min="0"
            step="1"
            placeholder="0"
            value={collateral}
            onChange={(e) => setCollateral(e.target.value)}
            disabled={isProving}
            helperText={`${shieldedBalance} XLM available in shielded pool.`}
          />
          <Input label="Asset" value="XLM" disabled readOnly />
        </div>

        {/* Leverage selector */}
        <div className="dapp-form-group">
          <label className="dapp-label">Leverage</label>
          <div className="dapp-leverage-group" role="radiogroup" aria-label="Leverage multiplier">
            {LEVERAGE_OPTIONS.map((lev) => (
              <button
                key={lev}
                type="button"
                className={`dapp-leverage-chip ${leverage === lev ? 'is-active' : ''}`}
                onClick={() => setLeverage(lev)}
                disabled={isProving}
                role="radio"
                aria-checked={leverage === lev}
              >
                {lev}×
              </button>
            ))}
          </div>
        </div>

        {/* Computed size readout */}
        {collateral && Number(collateral) > 0 && (
          <div className="dapp-position-summary">
            <div className="dapp-position-summary__row">
              <span className="dapp-label">Direction</span>
              <span className={`dapp-direction-badge dapp-direction-badge--${direction.toLowerCase()}`}>
                {direction}
              </span>
            </div>
            <div className="dapp-position-summary__row">
              <span className="dapp-label">Notional size</span>
              <strong className="dapp-mono">{computedSize.toLocaleString()} XLM</strong>
            </div>
            <div className="dapp-position-summary__row">
              <span className="dapp-label">Leverage</span>
              <strong className="dapp-mono">{leverage}×</strong>
            </div>
          </div>
        )}

        <Button type="submit" disabled={isProving || !collateral || Number(collateral) <= 0 || !address}>
          {!address
            ? 'Connect wallet first'
            : isProving
              ? status || 'Generating proof…'
              : `Open ${direction} ${leverage}×`}
        </Button>

        {status && !isProving && (
          <p className={`dapp-status ${isError ? 'dapp-status--error' : 'dapp-status--success'}`}>
            {status}
          </p>
        )}
      </form>
    </Card>
  );
}
