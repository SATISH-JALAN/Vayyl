'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useMarketStore } from '../../store/market';
import { INTERVALS } from '../../lib/market-data';
import ChartIcon from './ChartIcons';
import ChartSettingsMenu from './ChartSettingsMenu';
import DrawingToolbar from './DrawingToolbar';
import IndicatorMenu from './IndicatorMenu';
import KLineChartEngine from './KLineChartEngine';
import { useChartOverlays } from './useChartOverlays';
import type { ChartApi } from './engine';

/** What the read-out shows: the hovered candle, or the last one. */
interface Reading {
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
}

/**
 * Volume in the design's format: 1.82M, 940.3K, 512.
 *
 * Returns null rather than "0" when the source publishes no volume. The
 * CoinGecko fallback genuinely does not, and a zero reads as "nothing traded",
 * which is a different and false claim.
 */
function formatVolume(v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

/**
 * The chart panel: chrome, states, and the engine.
 *
 * The only chart thing `Positions.tsx` imports. Everything around the canvas —
 * the drawing rail, the indicator menu, the candle-style and settings popovers,
 * fullscreen and the screenshot — is our UI driving KLineChart's API through
 * the narrow `ChartApi` in `engine.ts`. No component here imports klinecharts,
 * which is what keeps the module-scope `window` access it performs away from
 * server rendering.
 *
 * The timeframe tabs live here rather than inside an engine, because the
 * selection drives the shared market store — which also feeds the header's 24h
 * figures. A timeframe owned by the chart would let the header describe a
 * different window than the one on screen.
 */
export default function ChartPanel() {
  const { candles, interval, setInterval, isLoading, error, startPolling, stopPolling } =
    useMarketStore();
  const overlays = useChartOverlays();
  const [api, setApi] = useState<ChartApi | null>(null);
  const [hovered, setHovered] = useState<Reading | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  // Follow the crosshair, as a trading chart does. Falls back to the last
  // candle when the pointer leaves, so the read-out is never blank.
  useEffect(() => {
    if (!api) return;
    const onCrosshair = (data: unknown) => {
      const k = (data as { kLineData?: Reading } | null)?.kLineData;
      setHovered(
        k ? { open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume } : null,
      );
    };
    api.subscribeAction('onCrosshairChange', onCrosshair);
    return () => api.unsubscribeAction('onCrosshairChange', onCrosshair);
  }, [api]);

  // Fullscreen is the browser's, on the whole panel, so the rail and the
  // toolbar come with it. `resize()` after the transition or the canvas keeps
  // the old dimensions and renders into a corner.
  useEffect(() => {
    const onChange = () => {
      const active = document.fullscreenElement === panelRef.current;
      setIsFullscreen(active);
      globalThis.setTimeout(() => api?.resize(), 60);
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [api]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void panelRef.current?.requestFullscreen().catch(() => undefined);
  }, []);

  const screenshot = useCallback(() => {
    if (!api) return;
    // Rendered from the canvas in this tab and downloaded straight from the
    // data URL. Nothing is uploaded, which is why this button is real here and
    // was not going to be with TradingView's — theirs posts the image to
    // snapshot.tradingview.com, an origin our connect-src does not allow.
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-surface').trim();
    const url = api.getConvertPictureUrl(true, 'png', bg || '#14100f');
    const a = document.createElement('a');
    a.href = url;
    a.download = `vayyl-xlm-usd-${interval}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.png`;
    a.click();
  }, [api, interval]);

  const last = candles.length > 0 ? candles[candles.length - 1] : null;
  const reading: Reading | null = hovered ?? last;
  const change = reading ? reading.close - reading.open : null;
  const volume = formatVolume(reading?.volume);

  return (
    <div className={`vy-chart ${isFullscreen ? 'is-fullscreen' : ''}`.trim()} ref={panelRef}>
      <div className="vy-chart__toolbar">
        <div className="vy-chart__intervals" role="tablist" aria-label="Chart interval">
          {INTERVALS.map((i) => (
            <button
              key={i.id}
              type="button"
              role="tab"
              aria-selected={interval === i.id}
              className={`vy-chip ${interval === i.id ? 'is-active' : ''}`}
              onClick={() => setInterval(i.id)}
            >
              {i.label}
            </button>
          ))}
        </div>

        <span className="vy-chart__divider" aria-hidden="true" />

        <ChartSettingsMenu api={api} />
        <IndicatorMenu api={api} />

        <div className="vy-chart__actions">
          {isLoading && <span className="vy-chart__loading">Refreshing…</span>}
          <button
            type="button"
            className="vy-chart__tool vy-chart__tool--icon"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            aria-pressed={isFullscreen}
          >
            <ChartIcon name="fullscreen" />
          </button>
          <button
            type="button"
            className="vy-chart__tool vy-chart__tool--icon"
            onClick={screenshot}
            disabled={api === null}
            title="Save a PNG of the chart — rendered here, uploaded nowhere"
          >
            <ChartIcon name="camera" />
          </button>
        </div>
      </div>

      <div className="vy-chart__body">
        <DrawingToolbar api={api} />

        <div className="vy-chart__stage">
          {/* The read-out the design shows, overlaying the canvas top-left and
              tracking the crosshair. KLineChart's own tooltip is switched off
              in the engine so this is the only one. */}
          {reading && (
            <div className="vy-chart__ohlc dapp-mono" aria-label="Candle values">
              <strong>XLM / USD</strong>
              <span>· {INTERVALS.find((i) => i.id === interval)?.label}</span>
              <span>O {reading.open.toFixed(4)}</span>
              <span>H {reading.high.toFixed(4)}</span>
              <span>L {reading.low.toFixed(4)}</span>
              <span>C {reading.close.toFixed(4)}</span>
              {change !== null && (
                <span className={change >= 0 ? 'is-up' : 'is-down'}>
                  {change >= 0 ? '+' : ''}
                  {change.toFixed(4)} (
                  {reading.open > 0 ? ((change / reading.open) * 100).toFixed(2) : '0.00'}%)
                </span>
              )}
            </div>
          )}

          {/* The design's volume label, over its own pane. KLineChart's built-in
              indicator legend is silenced in the engine because it reads
              "VOL(5,10,20) MA5: ... MA10: ... MA20: ..." and the design has a
              plain figure. */}
          {volume !== null && (
            <div className="vy-chart__volume dapp-mono" aria-label="Volume">
              <span>Volume</span>
              <strong>{volume}</strong>
            </div>
          )}

          <KLineChartEngine overlays={overlays} onReady={setApi} />

          {candles.length === 0 && (
            <div className="vy-chart__empty">
              {error ? (
                <>
                  <strong>Market data unavailable.</strong>
                  <span>
                    No public price feed responded, so there is nothing real to draw. Positions are
                    unaffected — they settle against the oracle, not this chart.
                  </span>
                  <code>{error}</code>
                </>
              ) : (
                <span>Loading market data…</span>
              )}
            </div>
          )}
        </div>
      </div>

      {candles.length > 0 && error && (
        <p className="vy-chart__stale" role="status">
          Chart is stale — the last refresh failed. Showing the most recent data that arrived.
        </p>
      )}
    </div>
  );
}
