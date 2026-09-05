'use client';

import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';

import { useMarketStore } from '../../store/market';
import type { ChartEngineProps, ChartOverlay } from './engine';

/**
 * The fallback chart engine.
 *
 * Renders candles, volume and Vayyl's overlay lines. It has no drawing tools
 * and no indicators, because lightweight-charts has none -- that is precisely
 * why the TradingView engine exists alongside it. This one is what runs when
 * the licensed bundle is absent, so it must stay fully functional rather than
 * degrading into a placeholder.
 *
 * Overlays are drawn with `createPriceLine` on the candlestick series rather
 * than as a separate flat series. The previous approach drew a one-value Area
 * across every candle timestamp, which fabricated a "history" for a level that
 * has none.
 */
export default function LightweightChart({ overlays, className }: ChartEngineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  // id -> line, so a refresh updates in place instead of stacking new lines.
  const linesRef = useRef<Map<string, IPriceLine>>(new Map());

  const candles = useMarketStore((s) => s.candles);

  // Created once. Re-creating on every data change would reset the viewer's
  // zoom and pan on each 60s refresh.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const styles = getComputedStyle(el);
    const read = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;

    const grid = read('--border-subtle', 'rgba(248,246,243,0.08)');
    const up = read('--success', '#8fc77e');
    const down = read('--coral', '#f46f73');

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: read('--text-muted', '#918780'),
        fontFamily: read('--font-ui', 'sans-serif'),
        attributionLogo: false,
      },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });

    candleSeriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
      priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
    });

    volumeSeriesRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      linesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const series = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!series || !volume || candles.length === 0) return;

    series.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    // Only candles that actually reported a volume. CoinGecko publishes none,
    // and zero bars would read as "nothing traded".
    volume.setData(
      candles
        .filter((c) => c.volume !== null)
        .map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.volume as number,
          color: c.close >= c.open ? 'rgba(143,199,126,0.35)' : 'rgba(244,111,115,0.35)',
        })),
    );
  }, [candles]);

  // Reconcile overlays: create the new, update the moved, remove the gone.
  // Anything else leaks a line per refresh, and after a few minutes the chart
  // is a ladder of stale liquidation prices.
  useEffect(() => {
    const series = candleSeriesRef.current;
    const el = containerRef.current;
    if (!series || !el) return;

    const styles = getComputedStyle(el);
    const colorFor = (tone: ChartOverlay['tone']) =>
      styles.getPropertyValue(
        tone === 'oracle' ? '--warning' : tone === 'liquidation' ? '--coral' : '--text-muted',
      ).trim() || '#d3a35f';

    const lines = linesRef.current;
    const wanted = new Set(overlays.map((o) => o.id));

    for (const [id, line] of lines) {
      if (!wanted.has(id)) {
        series.removePriceLine(line);
        lines.delete(id);
      }
    }

    for (const o of overlays) {
      const options = {
        price: o.price,
        color: colorFor(o.tone),
        lineWidth: 1 as const,
        lineStyle: o.tone === 'oracle' ? 2 : 0,
        axisLabelVisible: true,
        title: o.label,
      };
      const existing = lines.get(o.id);
      if (existing) existing.applyOptions(options);
      else lines.set(o.id, series.createPriceLine(options));
    }
  }, [overlays]);

  return <div className={`vy-chart__canvas ${className ?? ''}`.trim()} ref={containerRef} />;
}
