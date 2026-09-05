'use client';

import { useEffect, useState } from 'react';

import { usePositionsStore, type Position } from '../../store/positions';
import { useWalletStore } from '../../store/wallet';
import { POSITION_MANAGER_ID } from '../../lib/position';
import AssetLogo from '../common/AssetLogo';
import { getMarket } from '../../lib/assets';
import { getTier, priceBounds } from '../../lib/tiers';
import {
  HEALTH_SCALE,
  HEALTH_THRESHOLD,
  MAX_ORACLE_AGE,
  liquidationPrice,
  marginHealth,
} from '../../lib/liquidation';

const xlm = (stroops: bigint, dp = 2) => (Number(stroops) / 1e7).toFixed(dp);
const px = (p: bigint) => (Number(p) / 1e7).toFixed(4);
const short = (hex: string) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

/**
 * How long since the last accepted health attestation, against the window a
 * keeper needs before it can act. The contract's grace period lives in
 * LiquidationEngine and is set at deploy time, so this shows the raw age and
 * the attestation state rather than a countdown it cannot honestly compute.
 */
function heartbeat(position: Position, now: number) {
  const age = now - position.lastHealthTimestamp;
  if (position.lastHealthTimestamp === 0) return { label: 'Never attested', warn: true, age };
  if (age > MAX_ORACLE_AGE) return { label: `Stale · ${age}s`, warn: true, age };
  return { label: `Attested ${age}s ago`, warn: false, age };
}

function PnlCell({ position, mark }: { position: Position; mark: bigint | null }) {
  const tier = getTier(position.tierId);
  if (position.currentValue === null || mark === null) return <td className="dapp-mono">—</td>;
  const pnl = position.currentValue - tier.marginStroops;
  const pct = (Number(pnl) / Number(tier.marginStroops)) * 100;
  const cls = pnl > 0n ? 'is-up' : pnl < 0n ? 'is-down' : '';
  return (
    <td className={`dapp-mono ${cls}`}>
      {pnl >= 0n ? '+' : ''}
      {xlm(pnl)} XLM
      <small>
        {pnl >= 0n ? '+' : ''}
        {pct.toFixed(1)}%
      </small>
    </td>
  );
}

function HealthCell({ position, mark }: { position: Position; mark: bigint | null }) {
  const tier = getTier(position.tierId);
  if (mark === null) return <td className="dapp-mono">—</td>;
  const h = marginHealth(tier, position.direction, position.entryPrice, mark);
  if (h.ratio === null) return <td className="dapp-mono">—</td>;

  // Ratio against the maintenance requirement, so 100% means "exactly at the
  // liquidation boundary" rather than "fully healthy". Capped for the bar only.
  const pctOfThreshold = Number(h.ratio) / Number(HEALTH_THRESHOLD);
  const fill = Math.max(0, Math.min(100, (1 - 1 / Math.max(pctOfThreshold, 1e-9)) * 100));
  return (
    <td>
      <div className={`vy-health ${h.healthy ? '' : 'is-critical'}`}>
        <div className="vy-health__bar">
          <span style={{ width: `${h.healthy ? fill : 0}%` }} />
        </div>
        <span className="dapp-mono vy-health__value">
          {(Number(h.ratio) / Number(HEALTH_SCALE) * 100).toFixed(2)}%
        </span>
      </div>
      {!h.healthy && <small className="vy-health__flag">Liquidatable</small>}
    </td>
  );
}

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export default function PositionsTable({ selectedId, onSelect }: Props) {
  const { positions, oraclePrice } = usePositionsStore();
  const { address } = useWalletStore();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const market = getMarket('xlm-usd');

  useEffect(() => {
    const t = globalThis.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => globalThis.clearInterval(t);
  }, []);

  return (
    <div className="vy-table-wrap">
      <table className="vy-table">
        <thead>
          <tr>
            <th>Market</th>
            <th>Commitment</th>
            <th>Size</th>
            <th>Collateral</th>
            <th>Entry price</th>
            <th>Mark price</th>
            <th>Liq. price</th>
            <th>Knock-out</th>
            <th>Margin health</th>
            <th>Unrealised PnL</th>
            <th>Verification</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const tier = getTier(p.tierId);
            const liq = liquidationPrice(tier, p.direction, p.entryPrice);
            const bounds = priceBounds(tier, p.direction, p.entryPrice);
            const hb = heartbeat(p, now);
            const isSelected = selectedId === p.positionId;
            return (
              <tr
                key={p.positionId}
                className={isSelected ? 'is-selected' : ''}
                aria-selected={isSelected}
                tabIndex={0}
                onClick={() => onSelect(isSelected ? null : p.positionId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(isSelected ? null : p.positionId);
                  }
                }}
              >
                <td>
                  <div className="vy-market-cell">
                    <AssetLogo asset={market.base} size={18} />
                    <strong>{market.label}</strong>
                    <span className={`vy-tag ${p.direction === 1 ? 'vy-tag--long' : 'vy-tag--short'}`}>
                      {p.direction === 1 ? 'Long' : 'Short'}
                    </span>
                    <small>{tier.name}</small>
                  </div>
                </td>
                <td className="dapp-mono">
                  {/* Links to the manager on the explorer rather than to the
                      commitment itself: a commitment is a storage value, not an
                      addressable object, and a link that 404s is worse than
                      none. The point is that the user can check what this app
                      claims against the ledger. */}
                  <a
                    className="vy-explorer"
                    href={`https://stellar.expert/explorer/testnet/contract/${POSITION_MANAGER_ID}`}
                    target="_blank"
                    rel="noreferrer"
                    title={`Position commitment ${p.commitment}`}
                  >
                    <img src="/brands/stellar-expert.png" alt="" />
                    {short(p.commitment)}
                  </a>
                </td>
                <td className="dapp-mono">{tier.size.toString()}u</td>
                <td className="dapp-mono">{xlm(tier.marginStroops)}</td>
                <td className="dapp-mono">{px(p.entryPrice)}</td>
                <td className="dapp-mono">{oraclePrice === null ? '—' : px(oraclePrice)}</td>
                <td className="dapp-mono">{liq === null ? 'none' : px(liq)}</td>
                <td className="dapp-mono">{px(bounds.knockOut)}</td>
                <HealthCell position={p} mark={oraclePrice} />
                <PnlCell position={p} mark={oraclePrice} />
                <td>
                  <span className={`vy-heartbeat ${hb.warn ? 'is-warn' : ''}`}>{hb.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* The column headers stay on screen with nothing to list, as the design
          has them. Replacing the whole table with a message -- which is what
          this did before -- hid what the table would even show. */}
      {positions.length === 0 && (
        <div className="vy-empty">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 7h18v12H3z" />
            <path d="M3 11h18" />
          </svg>
          <strong>No active positions</strong>
          <span>
            {address
              ? 'Your private positions appear here after you open one, read back from the chain rather than from this app.'
              : 'Connect a wallet to read your positions from the chain.'}
          </span>
        </div>
      )}

      {positions.length > 0 && (
        <p className="vy-table__note">
          There is no partial close. A tier fixes the size, so half a position would belong to no
          tier — closing settles the whole thing and pays out as a fresh shielded note.
        </p>
      )}
    </div>
  );
}
