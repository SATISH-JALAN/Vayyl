// ============================================================
// Chart engine contract
// ============================================================
// One interface, two implementations: `LightweightChart` today and
// `TradingViewChart` once the licensed Advanced Charts drop is in place. The
// point of the seam is that everything Vayyl-specific -- which lines are drawn,
// what unit they are in, what the empty state says -- lives ABOVE it, in
// `ChartPanel` and `useChartOverlays`, and is therefore written once and tested
// once regardless of which engine renders.
//
// The engines receive prices already converted to the chart's quote currency.
// That is deliberate: unit conversion is where the last bug lived (an oracle
// level in stroops-per-unit drawn on a USD axis), so it happens in exactly one
// place and never inside a renderer.

import type { Interval } from '../../lib/market-data';

export type OverlayTone = 'oracle' | 'entry' | 'liquidation' | 'knockout';

export interface ChartOverlay {
  /**
   * Stable across renders: 'oracle', `entry:${positionId}`, `liq:${positionId}`.
   * The reconciler diffs on this, so an id that changes every render would
   * create a new line every refresh and leak them.
   */
  id: string;
  /** ALWAYS in the chart's quote unit (USD). Never a raw contract price. */
  price: number;
  label: string;
  tone: OverlayTone;
}

export interface ChartEngineProps {
  overlays: ChartOverlay[];
  className?: string;
}

export interface ChartPanelProps {
  interval: Interval;
  onIntervalChange: (interval: Interval) => void;
}

/**
 * Which engine to render.
 *
 * `tradingview` only when the licensed bundle is actually present. The library
 * is gitignored, so a contributor without a licence -- and CI -- must still get
 * a working chart rather than a broken build. `NEXT_PUBLIC_CHART_ENGINE` forces
 * the fallback for debugging.
 */
export type EngineName = 'lightweight' | 'tradingview';

export const FORCED_ENGINE: EngineName | null =
  process.env.NEXT_PUBLIC_CHART_ENGINE === 'lightweight' ? 'lightweight' : null;

/**
 * The slice of a chart engine the surrounding chrome is allowed to drive.
 *
 * The drawing rail, the indicator menu and the settings popover all act on
 * this, never on klinecharts directly. Two reasons, and the second is the one
 * that bites: klinecharts cannot be imported at module scope at all (it reads
 * `window.navigator` while loading), so any component importing it for a type
 * would break server rendering. Keeping the surface here means the chrome has
 * no import of it whatsoever.
 *
 * Deliberately narrow. Everything on it is something the UI genuinely calls.
 */
export interface ChartApi {
  /** Enters drawing mode for a klinecharts overlay template. */
  createOverlay: (value: unknown) => unknown;
  removeOverlay: (filter?: unknown) => unknown;
  createIndicator: (value: unknown, isStack?: boolean) => unknown;
  removeIndicator: (filter?: unknown) => unknown;
  overrideOverlay: (value: unknown) => unknown;
  setPaneOptions: (options: unknown) => void;
  setStyles: (styles: unknown) => void;
  /** Renders the chart to a data URL locally. Uploads nothing. */
  getConvertPictureUrl: (includeOverlay?: boolean, type?: string, background?: string) => string;
  resize: () => void;
  subscribeAction: (type: string, cb: (data: unknown) => void) => void;
  unsubscribeAction: (type: string, cb?: (data: unknown) => void) => void;
}

/** How the candles are drawn. Matches klinecharts' `CandleType`. */
export type CandleStyle = 'candle_solid' | 'candle_stroke' | 'ohlc' | 'area';

export const CANDLE_STYLES: Array<{ id: CandleStyle; label: string }> = [
  { id: 'candle_solid', label: 'Candles' },
  { id: 'candle_stroke', label: 'Hollow candles' },
  { id: 'ohlc', label: 'Bars' },
  { id: 'area', label: 'Area' },
];
