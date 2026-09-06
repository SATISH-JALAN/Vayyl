'use client';

import { useRef, useState } from 'react';

import ChartIcon from './ChartIcons';
import { useDismiss } from '../common/useDismiss';
import { OVERLAY_GROUP } from './chart-tools';
import { CANDLE_STYLES, type CandleStyle, type ChartApi } from './engine';

/**
 * Candle style and chart settings.
 *
 * Both write through `setStyles`, which merges — so each control changes only
 * the keys it names and cannot silently reset the theme colours the engine set
 * from our CSS custom properties on init.
 */
export default function ChartSettingsMenu({ api }: { api: ChartApi | null }) {
  const [openMenu, setOpenMenu] = useState<'candle' | 'settings' | null>(null);
  const [candle, setCandle] = useState<CandleStyle>('candle_solid');
  const [grid, setGrid] = useState(true);
  const [lastPrice, setLastPrice] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(openMenu !== null, ref, () => setOpenMenu(null));

  const pickCandle = (id: CandleStyle) => {
    api?.setStyles({ candle: { type: id } });
    setCandle(id);
    setOpenMenu(null);
  };

  const toggleGrid = () => {
    const next = !grid;
    api?.setStyles({ grid: { show: next } });
    setGrid(next);
  };

  const toggleLastPrice = () => {
    const next = !lastPrice;
    api?.setStyles({ candle: { priceMark: { last: { show: next } } } });
    setLastPrice(next);
  };

  const disabled = api === null;

  return (
    <div className="vy-chart__menu vy-chart__menu--split" ref={ref}>
      <button
        type="button"
        className={`vy-chart__tool vy-chart__tool--icon ${openMenu === 'candle' ? 'is-open' : ''}`}
        onClick={() => setOpenMenu((v) => (v === 'candle' ? null : 'candle'))}
        disabled={disabled}
        title="Candle style"
        aria-haspopup="menu"
        aria-expanded={openMenu === 'candle'}
      >
        <ChartIcon name="candles" />
      </button>

      {openMenu === 'candle' && (
        <div className="vy-chart__dropdown" role="menu">
          {CANDLE_STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitemradio"
              aria-checked={candle === s.id}
              className={candle === s.id ? 'is-active' : ''}
              onClick={() => pickCandle(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className={`vy-chart__tool vy-chart__tool--icon vy-chart__tool--gear ${
          openMenu === 'settings' ? 'is-open' : ''
        }`}
        onClick={() => setOpenMenu((v) => (v === 'settings' ? null : 'settings'))}
        disabled={disabled}
        title="Chart settings"
        aria-haspopup="menu"
        aria-expanded={openMenu === 'settings'}
      >
        <ChartIcon name="settings" />
      </button>

      {openMenu === 'settings' && (
        <div className="vy-chart__dropdown vy-chart__dropdown--right" role="menu">
          <button type="button" role="menuitemcheckbox" aria-checked={grid} onClick={toggleGrid}>
            <span>Grid lines</span>
            <em>{grid ? 'On' : 'Off'}</em>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={lastPrice}
            onClick={toggleLastPrice}
          >
            <span>Last price line</span>
            <em>{lastPrice ? 'On' : 'Off'}</em>
          </button>

          {/* Lives here rather than on the rail, which the design fixes at nine
              icons. Scoped to the user's group: a bare removeOverlay() would
              also delete the oracle, entry and liquidation lines, which are not
              drawings. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              api?.removeOverlay({ groupId: OVERLAY_GROUP.USER });
              setOpenMenu(null);
            }}
          >
            <span>Clear my drawings</span>
          </button>
        </div>
      )}
    </div>
  );
}
