'use client';

import { useMemo, useState, type FormEvent } from 'react';

import Unavailable from '../common/Unavailable';
import InfoPopover from '../common/InfoPopover';
import { usePositionsStore } from '../../store/positions';
import { useWalletStore } from '../../store/wallet';
import { useMarketStore } from '../../store/market';
import { markUsd } from '../../lib/mark-price';
import { getTier, leverageAt, priceBounds, TIERS } from '../../lib/tiers';
import { liquidationPrice } from '../../lib/liquidation';
import { vaultCanCover } from '../../lib/position';
import { UNAVAILABLE } from '../../lib/unavailable';

const xlm = (stroops: bigint, dp = 2) => (Number(stroops) / 1e7).toFixed(dp);
const px = (p: bigint) => (Number(p) / 1e7).toFixed(4);

/**
 * A contract price, shown in the unit the rest of the screen uses.
 *
 * The contract's own unit is STROOPS OF COLLATERAL PER CONTRACT UNIT — around
 * 1.0 while the chart's axis is around $0.18. Printing the raw figure put two
 * different quantities side by side with nothing saying so, which is the same
 * confusion that once had the oracle line drawn off-scale. USD leads because
 * that is what the chart, the header and the trader are all working in; the
 * contract unit stays underneath because it is what actually settles.
 */
function Price({ value }: { value: bigint | null }) {
  const anchor = useMarketStore((s) => s.anchor);
  if (value === null) return <span className="dapp-mono">—</span>;
  const usd = markUsd(value, anchor);
  return (
    <span className="dapp-mono vy-price">
      {usd === null ? px(value) : `$${usd.toFixed(4)}`}
      <small>{px(value)} XLM/unit</small>
    </span>
  );
}

/**
 * The order ticket.
 *
 * It has the shape of a size field and a leverage slider, and it is neither,
 * because neither is a choice this protocol offers:
 *
 *   - Collateral and size come from the tier table. They are public constants,
 *     identical for everyone in a tier, and that sameness IS the anonymity set.
 *     A free-form amount would make every position uniquely identifiable by its
 *     own numbers, and would leave the vault unable to reserve against a worst
 *     case it cannot predict.
 *   - Leverage is not an input at all. A tier fixes the SIZE, so the notional --
 *     and therefore the leverage -- moves with the price. A slider would imply a
 *     control that does not exist; a fixed "3x" label would be wrong at every
 *     price except the one the table was designed at.
 *
 * So the slider is real but STEPPED: it selects a tier, and its stops are
 * labelled with the collateral each one actually locks rather than percentages
 * of a balance the protocol never reads. Everything under "Order summary" is a
 * real limit the trader would otherwise meet for the first time at settlement.
 */
export default function OrderPanel() {
  const [tierId, setTierId] = useState(0);
  const [direction, setDirection] = useState<0 | 1>(1);
  const {
    openPosition,
    isProving,
    status,
    vault,
    oraclePrice,
    tierMismatch,
    configured,
    hasFetched,
  } = usePositionsStore();
  const { address, keys } = useWalletStore();

  const tier = getTier(tierId);
  const isError = !!status && /fail|error|cannot|stale|full|no single/i.test(status);

  const bounds = useMemo(
    () => (oraclePrice ? priceBounds(tier, direction, oraclePrice) : null),
    [tier, direction, oraclePrice],
  );
  const liq = useMemo(
    () => (oraclePrice ? liquidationPrice(tier, direction, oraclePrice) : null),
    [tier, direction, oraclePrice],
  );

  const capacityOk = vault ? vaultCanCover(vault, tier) : false;
  const reserve = tier.maxPayoutStroops - tier.marginStroops;
  const blocked =
    !address || !keys || !oraclePrice || !capacityOk || tierMismatch || isProving || !configured;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!configured) return;
    try {
      await openPosition(tierId, direction);
    } catch {
      // Surfaced through `status` and the toast store.
    }
  };

  return (
    <aside className={`vy-ticket ${configured ? '' : 'is-offline'}`.trim()}>
      {!configured && (
        <div className="vy-ticket__offline" role="note">
          <strong>Not deployed yet</strong>
          <p>
            No PositionManager or counterparty vault address is configured, so nothing here can
            be submitted. The tier figures below are real. The shielded vault is unaffected.
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} aria-disabled={!configured}>
        {/* Scrolls; the submit button below does not. On a short window the
            ticket is taller than its column, and the one control that must
            never be the thing pushed off-screen is the primary action. */}
        <div className="vy-ticket__scroll">
          <div className="vy-side" role="radiogroup" aria-label="Direction">
            <button
              type="button"
              role="radio"
              aria-checked={direction === 1}
              className={`vy-side__btn vy-side__btn--long ${direction === 1 ? 'is-active' : ''}`}
              onClick={() => setDirection(1)}
              disabled={isProving || !configured}
            >
              Long
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={direction === 0}
              className={`vy-side__btn vy-side__btn--short ${direction === 0 ? 'is-active' : ''}`}
              onClick={() => setDirection(0)}
              disabled={isProving || !configured}
            >
              Short
            </button>
          </div>

          {/* Reports state, does not offer a choice — there is no unshielded path. */}
          <Unavailable reason={UNAVAILABLE.shieldedToggle} className="vy-shield-row">
            <div className="vy-shield">
              <span className="vy-shield__icon" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z" />
                  <path d="M9 12l2 2 4-4" />
                </svg>
              </span>
              <strong>Shielded Position (ZK-SNARK)</strong>
              <span className="vy-switch is-on" role="img" aria-label="Always on" />
            </div>
          </Unavailable>

          <div className="vy-ordertype" role="tablist" aria-label="Order type">
            <button type="button" role="tab" aria-selected className="vy-ordertype__tab is-active">
              Market
            </button>
            <Unavailable reason={UNAVAILABLE.limitOrders}>
              <button type="button" className="vy-ordertype__tab" disabled aria-disabled="true">
                Limit
              </button>
            </Unavailable>
          </div>

          <div className="vy-field">
            <label className="vy-field__label">
              Collateral
              <span className="vy-field__hint">fixed per tier</span>
            </label>
            <div className="vy-amount">
              <output className="dapp-mono vy-amount__value">{xlm(tier.marginStroops)}</output>
              <span className="vy-amount__unit">XLM</span>
            </div>

            <input
              className="vy-slider"
              type="range"
              min={0}
              max={TIERS.length - 1}
              step={1}
              value={tierId}
              onChange={(e) => setTierId(Number(e.target.value))}
              disabled={isProving || !configured}
              aria-label="Size tier"
            />
            <div className="vy-slider__stops">
              {TIERS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`vy-slider__stop ${tierId === t.id ? 'is-active' : ''}`}
                  onClick={() => setTierId(t.id)}
                  disabled={isProving || !configured}
                >
                  {xlm(t.marginStroops, 0)} XLM
                </button>
              ))}
            </div>
            <p className="vy-note">
              Sizes are public and identical inside a tier. That sameness is what hides yours.
            </p>
          </div>

          <div className="vy-field">
            <label className="vy-field__label">
              Leverage
              <span className="vy-field__hint">derived, not chosen</span>
            </label>
            <Unavailable reason={UNAVAILABLE.leverageSlider} className="vy-lev-row">
              <div className="vy-lev">
                <strong className="dapp-mono">
                  {oraclePrice ? `${leverageAt(tier, oraclePrice).toFixed(2)}×` : '—'}
                </strong>
                <span className="vy-lev__detail">{tier.size.toString()} units at the mark</span>
              </div>
            </Unavailable>
          </div>

          <div className="vy-summary">
            <div className="vy-summary__head">
              <span>Order summary (confidential)</span>
              <InfoPopover label="How these figures are derived" align="right">
                <strong>Every figure here is a real limit</strong>, computed from the tier table and
                the current mark — not an estimate. This is a <strong>capped</strong> position: past
                the knock-out it stops earning, and that cap is exactly what lets the counterparty
                vault prove on-chain that it can pay you. Collateral and size are public constants
                per tier; leverage is whatever the size works out to at the current price.
              </InfoPopover>
            </div>
            <dl>
              <div>
                <dt>Margin mode</dt>
                <dd>Isolated</dd>
              </div>
              <div>
                <dt>Est. liquidation</dt>
                <dd><Price value={liq} /></dd>
              </div>
              <div>
                <dt>Knocks out at</dt>
                <dd><Price value={bounds?.knockOut ?? null} /></dd>
              </div>
              <div>
                <dt>Wiped out at</dt>
                <dd><Price value={bounds?.wipeOut ?? null} /></dd>
              </div>
              <div>
                <dt>Max payout</dt>
                <dd className="dapp-mono">{xlm(tier.maxPayoutStroops)} XLM</dd>
              </div>
              <div>
                <dt>Proof output</dt>
                <dd>Position commitment</dd>
              </div>
              <div>
                <dt>Verifier</dt>
                <dd>Native Soroban BN254</dd>
              </div>
            </dl>
            <p className="vy-note">
              Capped position: past the knock-out it stops earning. The cap is what lets the
              counterparty prove on-chain that it can pay you.
            </p>
          </div>

          {tierMismatch && (
            <p className="vy-alert vy-alert--error" role="alert">
              This build and the deployed contract disagree about the tier table. Any proof made
              here would be rejected on-chain.
            </p>
          )}

          {configured && !hasFetched && !oraclePrice && (
            <p className="vy-alert">Reading the mark price from the chain…</p>
          )}

          {configured && hasFetched && !oraclePrice && (
            <p className="vy-alert vy-alert--error" role="alert">
              The oracle price is stale or unavailable, so the contract will refuse to open a
              position. Existing positions are unaffected. If this persists, the price publisher has
              stopped — see scripts/push_price.mjs.
            </p>
          )}

          {vault && !capacityOk && (
            <p className="vy-alert vy-alert--error" role="alert">
              The counterparty is full. This tier needs {xlm(reserve)} XLM set aside and only{' '}
              {xlm(vault.freeBalance)} XLM is free. This is a normal state — it frees up as
              positions close, or anyone can add liquidity.
            </p>
          )}

          {vault && capacityOk && (
            <p className="vy-alert">
              Opening reserves <strong className="dapp-mono">{xlm(reserve)} XLM</strong> of the{' '}
              <strong className="dapp-mono">{xlm(vault.freeBalance)} XLM</strong> free in the
              counterparty vault.
            </p>
          )}
        </div>

        <div className="vy-ticket__footer">
          <button
            type="submit"
            className={`vy-submit ${direction === 1 ? 'vy-submit--long' : 'vy-submit--short'}`}
            disabled={blocked}
          >
            {!configured
              ? 'Positions not deployed'
              : !address
                ? 'Connect wallet first'
                : !keys
                  ? 'Unlock your shielded keys'
                  : isProving
                    ? status || 'Generating proof…'
                    : 'Generate Proof & Review'}
          </button>

          {status && !isProving && (
            <p className={`vy-alert ${isError ? 'vy-alert--error' : 'vy-alert--ok'}`} role="status">
              {status}
            </p>
          )}
        </div>
      </form>
    </aside>
  );
}
