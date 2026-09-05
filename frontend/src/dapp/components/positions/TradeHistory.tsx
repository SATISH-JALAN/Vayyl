'use client';

import { usePositionsStore } from '../../store/positions';
import AssetLogo from '../common/AssetLogo';
import { getMarket } from '../../lib/assets';
import { getTier } from '../../lib/tiers';

const xlm = (stroops: bigint, dp = 2) => (Number(stroops) / 1e7).toFixed(dp);
const px = (p: bigint) => (Number(p) / 1e7).toFixed(4);
const short = (hex: string) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

/**
 * Settled positions.
 *
 * This is the one table on the page that is NOT chain-verified, and it says so.
 * Closing deletes the position record on-chain, so after settlement the only
 * surviving account of what happened is the indexer's copy of the
 * `PositionClose` event. When the indexer is unreachable the answer is
 * "unknown", never "none" — an empty history where the user has closed
 * positions would read as data loss.
 */
export default function TradeHistory() {
  const { history, historyUnavailable } = usePositionsStore();
  const market = getMarket('xlm-usd');

  if (historyUnavailable) {
    return (
      <div className="vy-empty">
        <strong>History unavailable</strong>
        <span>
          The indexer did not respond. Settled positions exist only in its record — the contract
          deletes them on close — so this list is unknown rather than empty.
        </span>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="vy-empty">
        <strong>Nothing settled yet</strong>
        <span>Closed and liquidated positions appear here once the indexer has seen them.</span>
      </div>
    );
  }

  return (
    <div className="vy-table-wrap">
      <table className="vy-table">
        <thead>
          <tr>
            <th>Market</th>
            <th>Tier</th>
            <th>Entry</th>
            <th>Close</th>
            <th>Payout</th>
            <th>Fee</th>
            <th>Result</th>
            <th>Payout note</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => {
            const tier = getTier(h.tierId);
            const pnl = h.payout === null ? null : h.payout - tier.marginStroops;
            return (
              <tr key={h.positionId}>
                <td>
                  <div className="vy-market-cell">
                    <AssetLogo asset={market.base} size={18} />
                    <strong>{market.label}</strong>
                    <span className={`vy-tag ${h.direction === 1 ? 'vy-tag--long' : 'vy-tag--short'}`}>
                      {h.direction === 1 ? 'Long' : 'Short'}
                    </span>
                  </div>
                </td>
                <td>{tier.name}</td>
                <td className="dapp-mono">{px(h.entryPrice)}</td>
                <td className="dapp-mono">{h.closePrice === null ? '—' : px(h.closePrice)}</td>
                <td className="dapp-mono">{h.payout === null ? '—' : `${xlm(h.payout)} XLM`}</td>
                <td className="dapp-mono">{h.fee === null ? '—' : xlm(h.fee, 4)}</td>
                <td className={`dapp-mono ${pnl === null ? '' : pnl >= 0n ? 'is-up' : 'is-down'}`}>
                  {pnl === null ? '—' : `${pnl >= 0n ? '+' : ''}${xlm(pnl)} XLM`}
                </td>
                <td className="dapp-mono" title={h.outputNoteCommitment ?? undefined}>
                  {h.outputNoteCommitment ? short(h.outputNoteCommitment) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="vy-table__note">
        Settled positions are reported by the indexer, not read back from the chain — the
        contract deletes the record on close. Every other table on this page is chain-verified.
      </p>
    </div>
  );
}
