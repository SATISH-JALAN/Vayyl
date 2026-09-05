// ============================================================
// Indicator registry
// ============================================================
// Same contract as `chart-tools.ts`: these are KLineChart indicator names, and
// a name the library no longer knows makes `createIndicator` return null with
// no error. `chart-indicators.test.ts` checks every one against the installed
// library.
//
// `pane` decides where it draws. Getting it wrong is not a silent failure but
// it is an ugly one: RSI stacked onto the price axis compresses the candles
// into a band a few pixels tall, because a 0-100 oscillator and a $0.18 price
// share one scale.

export interface IndicatorDef {
  name: string;
  label: string;
  /** 'main' overlays the candles; 'sub' gets its own pane below. */
  pane: 'main' | 'sub';
}

export const INDICATORS: IndicatorDef[] = [
  // Overlaid on price -- these are all quoted in the price's own unit.
  { name: 'MA', label: 'Moving Average', pane: 'main' },
  { name: 'EMA', label: 'Exponential Moving Average', pane: 'main' },
  { name: 'SMA', label: 'Smoothed Moving Average', pane: 'main' },
  { name: 'BOLL', label: 'Bollinger Bands', pane: 'main' },
  { name: 'BBI', label: 'Bull and Bear Index', pane: 'main' },
  { name: 'SAR', label: 'Parabolic SAR', pane: 'main' },
  { name: 'AVP', label: 'Average Price', pane: 'main' },

  // Own pane -- different units entirely.
  { name: 'VOL', label: 'Volume', pane: 'sub' },
  { name: 'MACD', label: 'MACD', pane: 'sub' },
  { name: 'RSI', label: 'Relative Strength Index', pane: 'sub' },
  { name: 'KDJ', label: 'KDJ', pane: 'sub' },
  { name: 'CCI', label: 'Commodity Channel Index', pane: 'sub' },
  { name: 'DMI', label: 'Directional Movement Index', pane: 'sub' },
  { name: 'OBV', label: 'On Balance Volume', pane: 'sub' },
  { name: 'WR', label: 'Williams %R', pane: 'sub' },
  { name: 'BIAS', label: 'Bias Ratio', pane: 'sub' },
  { name: 'BRAR', label: 'BRAR', pane: 'sub' },
  { name: 'CR', label: 'CR', pane: 'sub' },
  { name: 'PSY', label: 'Psychological Line', pane: 'sub' },
  { name: 'DMA', label: 'Different of Moving Average', pane: 'sub' },
  { name: 'TRIX', label: 'TRIX', pane: 'sub' },
  { name: 'VR', label: 'Volume Ratio', pane: 'sub' },
  { name: 'MTM', label: 'Momentum', pane: 'sub' },
  { name: 'EMV', label: 'Ease of Movement', pane: 'sub' },
  { name: 'ROC', label: 'Rate of Change', pane: 'sub' },
  { name: 'PVT', label: 'Price Volume Trend', pane: 'sub' },
  { name: 'AO', label: 'Awesome Oscillator', pane: 'sub' },
];

/** On by default, because the design shows a volume pane under the candles. */
export const DEFAULT_INDICATORS = ['VOL'];

export function findIndicator(name: string): IndicatorDef | null {
  return INDICATORS.find((i) => i.name === name) ?? null;
}
