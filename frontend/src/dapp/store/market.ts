// ============================================================
// Market store
// ============================================================
// Holds the public XLM/USD price history that the chart draws. This is NOT the
// settlement price -- `usePositionsStore().oraclePrice` is, and the two are
// separate on purpose (see `lib/market-data.ts`).
//
// When the feed fails the store keeps whatever it last had and records the
// error, rather than clearing to an empty chart or substituting a value. A
// stale chart that says it is stale is more useful than a blank one, and much
// more useful than an invented one.

import { create } from 'zustand';

import {
  fetchMarketViaProxy,
  type Candle,
  type Interval,
  type MarketSummary,
} from '../lib/market-data';
import type { PriceAnchor } from '../lib/mark-price';

interface MarketState {
  candles: Candle[];
  summary: MarketSummary | null;
  /**
   * The publisher's price anchor, needed to express the oracle price in the USD
   * the chart is drawn in. Null means no USD figure is meaningful -- the
   * publisher is not tracking a market -- and the UI must show none rather than
   * a converted-from-nothing number.
   */
  anchor: PriceAnchor | null;
  interval: Interval;
  source: string | null;
  isLoading: boolean;
  /** Set when the most recent fetch failed. Cleared by the next success. */
  error: string | null;
  /** Epoch seconds of the last successful fetch. Null before the first one. */
  fetchedAt: number | null;

  setInterval: (interval: Interval) => void;
  load: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

// Module-level so a remount cannot leave a second timer running behind the
// first -- a leak that shows up as the chart refreshing faster and faster.
let timer: ReturnType<typeof globalThis.setInterval> | null = null;
let inFlight: AbortController | null = null;

const REFRESH_MS = 60_000;

export const useMarketStore = create<MarketState>((set, get) => ({
  candles: [],
  summary: null,
  anchor: null,
  interval: '1h',
  source: null,
  isLoading: false,
  error: null,
  fetchedAt: null,

  setInterval: (interval) => {
    if (get().interval === interval) return;
    set({ interval });
    void get().load();
  },

  load: async () => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    set({ isLoading: true });
    try {
      const { candles, summary, source, anchor } = await fetchMarketViaProxy(
        get().interval,
        200,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      set({
        candles,
        summary,
        source,
        anchor: anchor ?? null,
        error: null,
        isLoading: false,
        fetchedAt: Math.floor(Date.now() / 1000),
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      // Existing candles are left in place deliberately.
      set({ isLoading: false, error: (e as Error).message });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  },

  startPolling: () => {
    void get().load();
    if (timer) return;
    timer = globalThis.setInterval(() => void get().load(), REFRESH_MS);
  },

  stopPolling: () => {
    if (timer) {
      globalThis.clearInterval(timer);
      timer = null;
    }
    inFlight?.abort();
    inFlight = null;
  },
}));
