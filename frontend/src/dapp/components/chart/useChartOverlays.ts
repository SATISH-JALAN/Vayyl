// ============================================================
// Which lines belong on the chart
// ============================================================
// Engine-agnostic. Produces `ChartOverlay[]` in the chart's quote unit (USD)
// from the stores, so both the lightweight and TradingView engines draw exactly
// the same set from exactly the same numbers.
//
// The ordering rule here is load-bearing: ALL bigint arithmetic finishes before
// the USD conversion. `liquidationPrice` deliberately rounds toward the trader
// being liquidated sooner, and doing the conversion first would compute that
// boundary in floats and quietly erase the bias -- showing a liquidation price
// a shade more generous than the one a keeper will act on.

import { useMemo } from 'react';

import { useMarketStore } from '../../store/market';
import { usePositionsStore } from '../../store/positions';
import { markUsd } from '../../lib/mark-price';
import { liquidationPrice } from '../../lib/liquidation';
import { getTier } from '../../lib/tiers';
import type { ChartOverlay } from './engine';

export function useChartOverlays(): ChartOverlay[] {
  const anchor = useMarketStore((s) => s.anchor);
  const oraclePrice = usePositionsStore((s) => s.oraclePrice);
  const positions = usePositionsStore((s) => s.positions);

  return useMemo(() => {
    const out: ChartOverlay[] = [];

    // The settlement price. Absent when the publisher is not tracking a market,
    // in which case there is no honest USD figure and no line is drawn.
    const oracle = markUsd(oraclePrice, anchor);
    if (oracle !== null) {
      out.push({ id: 'oracle', price: oracle, label: 'Oracle', tone: 'oracle' });
    }

    for (const p of positions) {
      const tier = getTier(p.tierId);

      const entry = markUsd(p.entryPrice, anchor);
      if (entry !== null) {
        out.push({
          id: `entry:${p.positionId}`,
          price: entry,
          label: `Entry ${p.direction === 1 ? 'L' : 'S'}`,
          tone: 'entry',
        });
      }

      // bigint first, conversion last -- see the header note.
      const liqRaw = liquidationPrice(tier, p.direction, p.entryPrice);
      const liq = markUsd(liqRaw, anchor);
      // `liquidationPrice` returns null when no positive price triggers it (a
      // short healthy all the way down). That must render as no line, never as
      // zero, which would read as "about to be liquidated".
      if (liq !== null) {
        out.push({
          id: `liq:${p.positionId}`,
          price: liq,
          label: 'Liquidation',
          tone: 'liquidation',
        });
      }
    }

    return out;
  }, [anchor, oraclePrice, positions]);
}
