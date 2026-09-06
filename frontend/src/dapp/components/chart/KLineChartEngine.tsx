'use client';

import { useEffect, useRef } from 'react';

import { useMarketStore } from '../../store/market';
import { loadBars, moreFor, planLoad, proxyTransport } from '../../lib/chart-datafeed';
import { OVERLAY_GROUP } from './chart-tools';
import { DEFAULT_INDICATORS, findIndicator } from './chart-indicators';
import { VAYYL_LINE, registerVayylLine } from './vayyl-line';
import type { ChartApi, ChartEngineProps } from './engine';

/** Height for an indicator's own pane, in px. See the note where VOL is added. */
const SUB_PANE_HEIGHT = 72;

interface Props extends ChartEngineProps {
  /** Handed the chart once it exists, and null when it is torn down. */
  onReady?: (api: ChartApi | null) => void;
}

/**
 * KLineChart engine — drawing tools and indicators, Apache-2.0, in our bundle.
 *
 * WHY IT IS IMPORTED DYNAMICALLY. klinecharts reads `window.navigator.userAgent`
 * at MODULE SCOPE, so a top-level import crashes server rendering before any
 * component runs. `next/dynamic` with `ssr: false` would also work; an import
 * inside the effect keeps the decision next to the reason.
 *
 * Data arrives through v10's `DataLoader`, which is deliberately close in shape
 * to TradingView's Datafeed API — `getBars`, `subscribeBar`, `unsubscribeBar`.
 * Both call into the same `loadBars`, so swapping engines does not mean
 * rewriting the fetching.
 */
export default function KLineChartEngine({ overlays, className, onReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Typed loosely on purpose: importing klinecharts' types at module scope
  // would drag the module in and break SSR, which is the bug this avoids.
  const chartRef = useRef<any>(null);
  const overlayIdsRef = useRef<Map<string, string>>(new Map());
  const interval = useMarketStore((s) => s.interval);
  // Held in a ref so the mount effect never lists it as a dependency. A new
  // function identity from the parent would otherwise tear the chart down and
  // rebuild it, losing every drawing the user had made.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let disposed = false;
    const el = containerRef.current;
    if (!el) return;

    void (async () => {
      const kc = await import('klinecharts');
      if (disposed || !containerRef.current) return;

      // Registered here, not at module scope: `registerOverlay` is a
      // klinecharts export, and importing it any earlier would run the
      // library's `window.navigator` access during server rendering.
      // Re-registering the same name is a no-op overwrite, so remounting is
      // safe.
      registerVayylLine(kc.registerOverlay as (t: unknown) => void);

      const styles = getComputedStyle(el);
      const read = (name: string, fallback: string) =>
        styles.getPropertyValue(name).trim() || fallback;

      const up = read('--success', '#8fc77e');
      const down = read('--coral', '#f46f73');
      const grid = read('--border-subtle', 'rgba(248,246,243,0.08)');
      const text = read('--text-muted', '#918780');

      const chart = kc.init(el, {
        // Axis labels in the design's format: a day name where the day turns
        // over, clock time everywhere else. KLineChart's default stamps the
        // date onto every tick ("09-02 14:30"), which reads as noise once the
        // ticks are close together.
        formatter: {
          // Axis labels in the design's format: the date where the day turns
          // over, clock time everywhere else. KLineChart's default stamps the
          // date onto every tick ("09-02 14:30"), which is noise once the ticks
          // are close together.
          //
          // The day boundary is detected by COMPARING WITH THE PREVIOUS TICK,
          // not by testing the clock. Ticks are placed by the chart at whatever
          // spacing fits, so they land on times like 14:30 and 22:30 -- an
          // equality test against midnight fires on none of them, which is
          // exactly the bug this replaced. Labels are formatted left to right,
          // so a timestamp going backwards means a new pass has started.
          formatDate: formatAxisDate(),
        },
        styles: {
          grid: {
            horizontal: { color: grid },
            vertical: { color: grid },
          },
          candle: {
            bar: {
              upColor: up,
              downColor: down,
              upBorderColor: up,
              downBorderColor: down,
              upWickColor: up,
              downWickColor: down,
            },
            priceMark: {
              last: {
                upColor: up,
                downColor: down,
              },
            },
            // Silenced deliberately. The panel draws its own OHLC read-out, in
            // the design's position and format; leaving this on rendered a
            // SECOND read-out stacked on top of it.
            tooltip: { showRule: 'none' },
          },
          indicator: {
            bars: [{ upColor: `${up}55`, downColor: `${down}55` }],
            // The green value badge on the volume axis, as the design has it.
            lastValueMark: { show: true },
            // KLineChart's own indicator legend reads
            // "VOL(5,10,20) MA5: ... MA10: ... MA20: ...". The panel renders a
            // plain "Volume 1.82M" over the pane instead, so this is silenced
            // for the same reason as the candle tooltip.
            tooltip: { showRule: 'none' },
          },
          xAxis: { axisLine: { color: grid }, tickText: { color: text } },
          yAxis: { axisLine: { color: grid }, tickText: { color: text } },
          crosshair: {
            horizontal: { line: { color: text }, text: { backgroundColor: down } },
            vertical: { line: { color: text }, text: { backgroundColor: down } },
          },
        },
      });
      if (!chart) return;
      chartRef.current = chart;

      chart.setSymbol({ ticker: 'XLMUSD', pricePrecision: 4, volumePrecision: 0 });
      chart.setPeriod(periodFor(interval));

      chart.setDataLoader({
        getBars: async ({ type, timestamp, callback }: any) => {
          // What to fetch, and whether to fetch at all, is decided by `planLoad`
          // -- a pure function with tests, because getting it wrong here draws a
          // wrong chart rather than raising anything.
          const plan = planLoad(type, timestamp);
          if (!plan.fetch) {
            callback([], moreFor(type, 0));
            return;
          }
          try {
            const { bars } = await loadBars(proxyTransport, {
              interval: useMarketStore.getState().interval,
              to: plan.to,
              countBack: 200,
            });
            callback(bars, moreFor(type, bars.length));
          } catch {
            // An empty page with no directions left stops the chart asking. The
            // panel's own error state explains what happened; a chart that
            // retries forever against a dead feed would not.
            callback([], { forward: false, backward: false });
          }
        },
      });

      // Volume in its own pane, as the design shows.
      //
      // Its height is pinned rather than left proportional. KLineChart splits
      // the available space between panes, so on a short window -- a laptop, or
      // a zoomed browser -- the volume pane claimed roughly half of it and the
      // candles were squeezed into a band about sixty pixels tall. Volume is
      // context; the candles are the chart.
      for (const name of DEFAULT_INDICATORS) {
        const onMain = findIndicator(name)?.pane === 'main';
        // `calcParams: []` drops VOL's 5/10/20 moving averages. They are on by
        // default and draw three coloured lines across the volume bars, which
        // the design does not have and which obscure the bars at this height.
        const paneId = chart.createIndicator({ name, calcParams: [] }, onMain);
        if (!onMain && typeof paneId === 'string') {
          chart.setPaneOptions({ id: paneId, height: SUB_PANE_HEIGHT });
        }
      }

      onReadyRef.current?.(chart as unknown as ChartApi);
    })();

    return () => {
      disposed = true;
      onReadyRef.current?.(null);
      if (chartRef.current) {
        void import('klinecharts').then((kc) => kc.dispose(el));
        chartRef.current = null;
        overlayIdsRef.current.clear();
      }
    };
  }, []);

  // Timeframe changes re-drive the loader rather than rebuilding the chart, so
  // any drawings the user has made survive.
  useEffect(() => {
    chartRef.current?.setPeriod(periodFor(interval));
  }, [interval]);

  // Reconcile Vayyl's own lines: create the new, move the changed, remove the
  // gone. Anything else stacks a fresh line every 30s refresh until the chart
  // is a ladder of stale liquidation prices.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const ids = overlayIdsRef.current;
    const wanted = new Set(overlays.map((o) => o.id));

    for (const [key, overlayId] of ids) {
      if (!wanted.has(key)) {
        chart.removeOverlay({ id: overlayId });
        ids.delete(key);
      }
    }

    const el = containerRef.current;
    const styles = el ? getComputedStyle(el) : null;
    const colorFor = (tone: string) =>
      styles?.getPropertyValue(
        tone === 'oracle' ? '--warning' : tone === 'liquidation' ? '--coral' : '--text-muted',
      ).trim() || '#d3a35f';

    for (const o of overlays) {
      const existing = ids.get(o.id);
      if (existing) {
        chart.overrideOverlay({ id: existing, points: [{ value: o.price }] });
        continue;
      }
      const created = chart.createOverlay({
        name: VAYYL_LINE,
        // Tagged so the rail's clear button can remove the user's drawings
        // WITHOUT removing these. Oracle, entry and liquidation are the three
        // lines on this chart that are not decoration.
        groupId: OVERLAY_GROUP.VAYYL,
        points: [{ value: o.price }],
        lock: true,
        styles: {
          line: { color: colorFor(o.tone), style: o.tone === 'oracle' ? 'dashed' : 'solid' },
          text: { color: colorFor(o.tone) },
        },
        extendData: `${o.label} ${o.price.toFixed(4)}`,
      });
      if (typeof created === 'string') ids.set(o.id, created);
    }
  }, [overlays]);

  return <div className={`vy-chart__canvas ${className ?? ''}`.trim()} ref={containerRef} />;
}

/**
 * A stateful x-axis label formatter.
 *
 * Holds the previous tick so it can tell when the day changes. One instance per
 * chart -- sharing it between charts would interleave two passes and drop
 * dates.
 */
function formatAxisDate() {
  let prevTimestamp = Number.POSITIVE_INFINITY;
  let prevDay = '';

  return ({ timestamp, type }: { timestamp: number; type: string }) => {
    const d = new Date(timestamp);

    if (type !== 'xAxis') {
      return d.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }

    // Time running backwards means the chart restarted its left-to-right pass.
    if (timestamp < prevTimestamp) prevDay = '';
    prevTimestamp = timestamp;

    const day = d.toDateString();
    const dayChanged = day !== prevDay;
    prevDay = day;

    // On a daily timeframe every tick is a different day, so this yields dates
    // throughout without needing to know the interval.
    return dayChanged
      ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  };
}

/** Map our interval union onto KLineChart's {type, span}. */
function periodFor(interval: string): { type: 'minute' | 'hour' | 'day'; span: number } {
  switch (interval) {
    case '5m':
      return { type: 'minute', span: 5 };
    case '15m':
      return { type: 'minute', span: 15 };
    case '1h':
      return { type: 'hour', span: 1 };
    case '4h':
      return { type: 'hour', span: 4 };
    case '1d':
      return { type: 'day', span: 1 };
    default:
      // Never silently default to a different timeframe than the one selected:
      // the chart would draw hourly candles under a "1D" label.
      throw new Error(`Unmapped chart interval: ${interval}`);
  }
}
