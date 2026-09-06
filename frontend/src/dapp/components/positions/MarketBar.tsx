'use client';

import { useEffect, useRef, useState } from 'react';

import AssetLogo from '../common/AssetLogo';
import WalletControls from '../common/WalletControls';
import { useMarketStore } from '../../store/market';
import { usePositionsStore } from '../../store/positions';
import { MARKETS, getMarket } from '../../lib/assets';
import { NETWORK } from '../../lib/network';
import { MAX_ORACLE_AGE } from '../../lib/liquidation';
import { markUsd } from '../../lib/mark-price';

const usd = (v: number) => `$${v.toFixed(4)}`;

/**
 * The terminal's top row: market, price, oracle state, network, wallet.
 *
 * Occupies the shell's topbar slot on this route, because the design carries
 * market stats and the Connect button on one line.
 *
 * Mark price is quoted in USD and derived from the ORACLE, not from the
 * exchange. That distinction is the whole point: the oracle is what settles and
 * liquidates, and the publisher rebases it onto real XLM/USD so the USD figure
 * is genuinely the settlement price rather than a convenient approximation. The
 * contract's own unit sits underneath it, because that is the number the tier
 * arithmetic runs on and hiding it would obscure where leverage comes from.
 */
export default function MarketBar() {
  const { summary, anchor, source } = useMarketStore();
  const { oraclePrice, oracleTimestamp, configured } = usePositionsStore();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const market = getMarket('xlm-usd');

  useEffect(() => {
    const t = globalThis.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => globalThis.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!pickerOpen) return;
    const close = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [pickerOpen]);

  const age = oracleTimestamp === null ? null : Math.max(0, now - oracleTimestamp);
  const stale = age !== null && age > MAX_ORACLE_AGE;
  const markPrice = markUsd(oraclePrice, anchor);

  return (
    <div className="vy-marketbar">
      <div className="vy-marketbar__picker" ref={pickerRef}>
        <button
          type="button"
          className="vy-select"
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((v) => !v)}
        >
          <AssetLogo asset={market.base} size={24} />
          <strong>{market.label}</strong>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        {pickerOpen && (
          <ul className="vy-select__menu" role="listbox">
            {MARKETS.map((m) => (
              <li key={m.id}>
                <button type="button" role="option" aria-selected={m.id === market.id} className="is-active">
                  <AssetLogo asset={m.base} size={20} />
                  <span>
                    <strong>{m.label}</strong>
                    <small>{m.description}</small>
                  </span>
                </button>
              </li>
            ))}
            {/* One market today. Saying so beats listing pairs that do not
                trade, which is what a mocked-up selector would do. */}
            <li className="vy-select__note">
              The only market on this deployment. More need their own oracle feed
              and counterparty capacity.
            </li>
          </ul>
        )}
      </div>

      <dl className="vy-marketbar__stats">
        <div className="vy-stat">
          <dt>Mark Price</dt>
          {/* One line, as the design has it. The contract's own unit -- stroops
              of collateral per contract unit, the number the tier arithmetic
              actually runs on -- moves to the tooltip rather than being
              dropped: it is still the figure that settles. */}
          <dd
            className={`dapp-mono ${stale ? 'is-stale' : ''}`}
            title={
              oraclePrice === null
                ? 'No oracle reading'
                : `${(Number(oraclePrice) / 1e7).toFixed(4)} XLM per contract unit — the unit the contract settles in`
            }
          >
            {markPrice === null ? '—' : usd(markPrice)}
          </dd>
        </div>

        <div className="vy-stat">
          <dt>24h Change</dt>
          <dd
            className={`dapp-mono ${
              summary?.change24h == null ? '' : summary.change24h >= 0 ? 'is-up' : 'is-down'
            }`}
            title={source ? `Source: ${source}` : 'No market feed responded'}
          >
            {summary?.change24h == null
              ? '—'
              : `${summary.change24h >= 0 ? '+' : ''}${summary.change24h.toFixed(2)}%`}
          </dd>
        </div>

        <div className="vy-stat">
          <dt>24h Volume</dt>
          <dd className="dapp-mono" title={source ? `Source: ${source}` : undefined}>
            {summary?.volume24h == null
              ? '—'
              : `$${(summary.volume24h / 1_000_000).toFixed(2)}M`}
          </dd>
        </div>

        <div className="vy-stat vy-stat--oracle">
          <dt>Oracle</dt>
          <dd className={`dapp-mono ${stale ? 'is-stale' : ''}`}>
            {/* Named for what it is. The deployment runs Vayyl's own SEP-40
                publisher, not Reflector, and printing someone else's oracle
                name would be a claim about provenance that is not true. */}
            <span
              title={
                age === null
                  ? 'No price has been published'
                  : `Last published ${age}s ago`
              }
            >
              {configured ? 'Vayyl SEP-40' : 'offline'}
            </span>

            {/* Sits where the design puts its badge. Says the true thing: the
                proving system, verified by Soroban's native host functions. */}
            <span
              className="vy-badge"
              title="Groth16 over BN254, verified by Soroban's native host functions"
            >
              Groth16 · BN254
            </span>

            {/* Surfaced only when it matters. A fresh oracle needs no comment;
                a stale one stops every position write path with StaleOracle,
                and burying that in a tooltip would hide the reason the page
                had stopped working. */}
            {stale && age !== null && (
              <span className="vy-badge vy-badge--warn">stale {age}s</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="vy-marketbar__right">
        <span className="vy-badge vy-badge--network">
          <i aria-hidden="true" />
          {NETWORK.toLowerCase()}
        </span>
        <WalletControls compact />
      </div>
    </div>
  );
}
