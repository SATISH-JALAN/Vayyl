'use client';

import { useRef, useState } from 'react';

import ChartIcon from './ChartIcons';
import { useDismiss } from '../common/useDismiss';
import { DEFAULT_INDICATORS, INDICATORS } from './chart-indicators';
import type { ChartApi } from './engine';

/**
 * The Indicators menu.
 *
 * Twenty-seven real indicators from KLineChart, split by where they can honestly
 * be drawn: the seven quoted in the price's own unit overlay the candles, and
 * the rest get their own pane. Stacking an oscillator onto the price axis is
 * not a crash — it just squashes a $0.18 candle series into a few pixels
 * against a 0–100 scale, which is why `chart-indicators.ts` pins the pane and
 * the tests assert it.
 */
export default function IndicatorMenu({ api }: { api: ChartApi | null }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string[]>(DEFAULT_INDICATORS);
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(open, ref, () => setOpen(false));

  const toggle = (name: string, pane: 'main' | 'sub') => {
    if (!api) return;
    if (active.includes(name)) {
      api.removeIndicator({ name });
      setActive((v) => v.filter((n) => n !== name));
    } else {
      const paneId = api.createIndicator({ name, calcParams: [] }, pane === 'main');
      // Same reason as the default VOL pane: left proportional, each added
      // oscillator takes a share of the height away from the candles until
      // they are unreadable.
      if (pane === 'sub' && typeof paneId === 'string') {
        api.setPaneOptions({ id: paneId, height: 72 });
      }
      setActive((v) => [...v, name]);
    }
  };

  const main = INDICATORS.filter((i) => i.pane === 'main');
  const sub = INDICATORS.filter((i) => i.pane === 'sub');

  return (
    <div className="vy-chart__menu" ref={ref}>
      <button
        type="button"
        className={`vy-chart__tool ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={api === null}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ChartIcon name="indicators" />
        <span>Indicators</span>
      </button>

      {open && (
        <div className="vy-chart__dropdown vy-chart__dropdown--indicators" role="menu">
          <section>
            <h4>On the price</h4>
            {main.map((i) => (
              <button
                key={i.name}
                type="button"
                role="menuitemcheckbox"
                aria-checked={active.includes(i.name)}
                className={active.includes(i.name) ? 'is-active' : ''}
                onClick={() => toggle(i.name, i.pane)}
              >
                <strong>{i.name}</strong>
                <span>{i.label}</span>
              </button>
            ))}
          </section>
          <section>
            <h4>Own pane</h4>
            {sub.map((i) => (
              <button
                key={i.name}
                type="button"
                role="menuitemcheckbox"
                aria-checked={active.includes(i.name)}
                className={active.includes(i.name) ? 'is-active' : ''}
                onClick={() => toggle(i.name, i.pane)}
              >
                <strong>{i.name}</strong>
                <span>{i.label}</span>
              </button>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
