'use client';

import { useEffect, useState } from 'react';

import OrderPanel from '../components/positions/OrderPanel';
import PositionsTable from '../components/positions/PositionsTable';
import ChartPanel from '../components/chart/ChartPanel';
import TradeHistory from '../components/positions/TradeHistory';
import VaultPanel from '../components/positions/VaultPanel';
import Unavailable from '../components/common/Unavailable';
import InfoPopover from '../components/common/InfoPopover';
import { UNAVAILABLE } from '../lib/unavailable';
import { usePositionsStore } from '../store/positions';
import { useWalletStore } from '../store/wallet';
import { getTier } from '../lib/tiers';

const xlm = (stroops: bigint, dp = 2) => (Number(stroops) / 1e7).toFixed(dp);

type Tab = 'positions' | 'history' | 'liquidity';

/**
 * The positions terminal.
 *
 * Laid out like a trading screen because that is the shape of the task, but
 * every figure on it is read from the chain, the indexer, or a public market
 * feed — and where those three disagree about a price, the page shows the
 * disagreement rather than picking one. The oracle price settles; the exchange
 * price is context.
 *
 * The page is sized TO the viewport above 981×700 (see `.dapp-main.is-terminal`)
 * so the positions table is never below the fold. What you are exposed to is
 * the one thing on a trading screen that should not require a scroll.
 *
 * The disclosure sits behind the (i) rather than in a banner. It is not
 * boilerplate — positions leak more than payments do, and a trader who assumes
 * otherwise is making decisions on a guarantee this product does not offer — so
 * it stays one click away and is never removed.
 */
export default function Positions() {
  const { positions, history, fetchState, vault, configured } = usePositionsStore();
  const { address } = useWalletStore();
  const [tab, setTab] = useState<Tab>('positions');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    // Runs with or without a wallet: the mark price, the vault capacity and the
    // tier bounds are public, and a visitor who has not connected should see
    // real numbers rather than a page claiming the oracle is unavailable.
    void fetchState();
    // Positions move with the price and with the liquidation clock, so a static
    // snapshot goes stale while the user is looking at it. Thirty seconds sits
    // well inside the contract's five-minute oracle window.
    const timer = globalThis.setInterval(() => void fetchState(), 30_000);
    return () => globalThis.clearInterval(timer);
  }, [address, fetchState]);

  // A position that closed or was liquidated must not leave a selection behind
  // pointing at a row that no longer exists, or the footer would offer to close
  // something already gone.
  useEffect(() => {
    if (selectedId && !positions.some((p) => p.positionId === selectedId)) setSelectedId(null);
  }, [positions, selectedId]);

  const totalMargin = positions.reduce((sum, p) => sum + getTier(p.tierId).marginStroops, 0n);
  const totalValue = positions.reduce((sum, p) => sum + (p.currentValue ?? 0n), 0n);
  const netPnl = totalValue - totalMargin;

  return (
    <div className="vy-terminal">
      <p className="vy-subtitle">
        Commit collateral and prove position health without publishing the full position.
        <InfoPopover label="What a position makes public">
          <strong>Private:</strong> which shielded note funded this position, and which note the
          payout became — neither links to your deposit or withdrawal history.{' '}
          <strong>Public:</strong> your address, the tier (so collateral and size), the direction,
          the entry price and the settlement price. On testnet the counterparty vault is
          faucet-funded: proofs, collateral, liquidation and settlement are real, the counterparty
          is not a market.
        </InfoPopover>
      </p>

      <div className="vy-terminal__main">
        <section className="vy-terminal__chart" aria-label="Price chart">
          <ChartPanel />
        </section>
        <OrderPanel />
      </div>

      <section className="vy-terminal__ledger" aria-label="Your positions">
        <div className="vy-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'positions'}
            className={`vy-tabs__tab ${tab === 'positions' ? 'is-active' : ''}`}
            onClick={() => setTab('positions')}
          >
            Private Positions
            <span className="vy-tabs__count">{positions.length}</span>
          </button>

          {/* In the circulated design but not in the protocol: there are no
              resting orders to list until limit orders exist. Rendered so the
              tab row matches, disabled so nobody clicks into an empty promise. */}
          <Unavailable reason={UNAVAILABLE.openOrders}>
            <button type="button" className="vy-tabs__tab" disabled aria-disabled="true">
              Open Orders
            </button>
          </Unavailable>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'history'}
            className={`vy-tabs__tab ${tab === 'history' ? 'is-active' : ''}`}
            onClick={() => setTab('history')}
          >
            Trade History
            <span className="vy-tabs__count">{history.length}</span>
          </button>

          <div className="vy-tabs__right">
            {positions.length > 0 && (
              <div className="vy-tabs__summary">
                <span>
                  Committed <strong className="dapp-mono">{xlm(totalMargin)} XLM</strong>
                </span>
                <span>
                  Settles for <strong className="dapp-mono">{xlm(totalValue)} XLM</strong>
                </span>
                <span className={netPnl >= 0n ? 'is-up' : 'is-down'}>
                  {netPnl >= 0n ? '+' : '−'}
                  <strong className="dapp-mono">{xlm(netPnl < 0n ? -netPnl : netPnl)} XLM</strong>
                </span>
              </div>
            )}

            {/* Not in the design, but the counterparty vault's free balance is
                what decides whether a position can open at all. Kept reachable
                rather than deleted to match a picture. */}
            <button
              type="button"
              className={`vy-tabs__aux ${tab === 'liquidity' ? 'is-active' : ''}`}
              onClick={() => setTab(tab === 'liquidity' ? 'positions' : 'liquidity')}
              aria-pressed={tab === 'liquidity'}
            >
              Counterparty Vault
            </button>
          </div>
        </div>

        <div className="vy-tabs__panel">
          {!configured ? (
            <div className="vy-empty">
              <strong>Positions are not configured in this build</strong>
              <span>
                No PositionManager or counterparty vault address is set. The shielded vault is
                unaffected.
              </span>
            </div>
          ) : tab === 'positions' ? (
            <PositionsTable selectedId={selectedId} onSelect={setSelectedId} />
          ) : tab === 'history' ? (
            <TradeHistory />
          ) : vault ? (
            <VaultPanel />
          ) : (
            <div className="vy-empty">
              <strong>Vault unavailable</strong>
              <span>The counterparty vault did not respond. Try again in a moment.</span>
            </div>
          )}
        </div>

        {tab === 'positions' && configured && (
          <PositionActions selectedId={selectedId} />
        )}
      </section>
    </div>
  );
}

/**
 * The footer action bar, acting on the selected row.
 *
 * Placed here rather than on each row because that is where the circulated
 * design puts it. The trade-off is real — acting on several positions costs a
 * click each — but a selection model keeps one set of buttons whose enabled
 * state says plainly whether there is anything to act on.
 */
function PositionActions({ selectedId }: { selectedId: string | null }) {
  const { positions, closePosition, attestHealth, isProving } = usePositionsStore();
  const { address } = useWalletStore();
  const [busy, setBusy] = useState(false);

  const selected = positions.find((p) => p.positionId === selectedId) ?? null;
  const blocked = !selected || !address || isProving || busy;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // Surfaced by the store's status field and the toast.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vy-ledger__actions">
      <span className="vy-ledger__hint">
        {!address
          ? 'Connect a wallet to act on a position.'
          : selected
            ? `Selected ${selected.commitment.slice(0, 10)}…`
            : positions.length > 0
              ? 'Select a position to act on it.'
              : ''}
      </span>

      <button
        type="button"
        className="vy-mini"
        disabled={blocked}
        onClick={() => selected && run(() => attestHealth(selected.positionId))}
        title="Prove the position is still solvent and reset the liquidation clock"
      >
        Attest
      </button>

      <Unavailable reason={UNAVAILABLE.rageQuit}>
        <button type="button" className="vy-mini" disabled aria-disabled="true">
          Rage-Quit
        </button>
      </Unavailable>

      <button
        type="button"
        className="vy-mini vy-mini--primary"
        disabled={blocked}
        onClick={() => selected && run(() => closePosition(selected.positionId))}
      >
        Close
      </button>
    </div>
  );
}
