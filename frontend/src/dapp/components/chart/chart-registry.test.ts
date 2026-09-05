// ============================================================
// Chart registries vs. the installed library
// ============================================================
// Every id in `chart-tools.ts` and `chart-indicators.ts` is a string handed to
// KLineChart. A string it does not recognise is not an error: `createOverlay`
// and `createIndicator` return null, the button does nothing, and there is no
// throw, no console message and nothing on screen to notice. That failure mode
// is why these registries are data and why this file exists -- it asks the
// installed library what it actually supports and compares.
//
// Same shape as `lib/tiers.test.ts`, which reads the tier table out of three
// separate files and compares them for exactly the same reason.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_TOOLS, TOOL_GROUPS, OVERLAY_GROUP, findTool } from './chart-tools.ts';
import { INDICATORS, DEFAULT_INDICATORS, findIndicator } from './chart-indicators.ts';

// klinecharts reads `window.navigator.userAgent` at MODULE SCOPE, which is why
// the app imports it dynamically inside an effect. Here we give it just enough
// to load; nothing below touches a canvas or renders anything.
(globalThis as Record<string, unknown>).window = { navigator: { userAgent: 'node' } };
(globalThis as Record<string, unknown>).document = {
  createElement: () => ({ style: {}, getContext: () => null }),
};

const kc = await import('klinecharts');
const supportedOverlays: string[] = kc.getSupportedOverlays();
const supportedIndicators: string[] = kc.getSupportedIndicators();

test('the library reports a non-empty template list', () => {
  // If this ever comes back empty the two tests below would pass vacuously,
  // asserting nothing while claiming to guard everything.
  assert.ok(supportedOverlays.length > 0, 'klinecharts reported no overlays');
  assert.ok(supportedIndicators.length > 0, 'klinecharts reported no indicators');
});

test('every drawing tool names an overlay the library supports', () => {
  const missing = ALL_TOOLS.filter((t) => !supportedOverlays.includes(t.overlay));
  assert.deepEqual(
    missing.map((t) => `${t.id} -> ${t.overlay}`),
    [],
    'these toolbar buttons would silently do nothing',
  );
});

test('every indicator names one the library supports', () => {
  const missing = INDICATORS.filter((i) => !supportedIndicators.includes(i.name));
  assert.deepEqual(missing.map((i) => i.name), [], 'these menu entries would silently do nothing');
});

test('rect and circle are not offered as drawing tools', () => {
  // They are FIGURES in klinecharts, not overlays, so `createOverlay('rect')`
  // fails. Worth pinning: they are the obvious things to reach for when adding
  // a "shapes" button, and adding them would look correct in review.
  assert.ok(!supportedOverlays.includes('rect'));
  assert.ok(!supportedOverlays.includes('circle'));
  assert.ok(!ALL_TOOLS.some((t) => t.overlay === 'rect' || t.overlay === 'circle'));
});

test('the default indicators are real', () => {
  for (const name of DEFAULT_INDICATORS) {
    assert.ok(findIndicator(name), `${name} is switched on at startup but is not registered`);
    assert.ok(supportedIndicators.includes(name), `${name} is not a klinecharts indicator`);
  }
});

test('tool ids are unique', () => {
  // A duplicate id makes `findTool` return the first match, so one rail button
  // would quietly select a different tool than its label says.
  const ids = ALL_TOOLS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  const groupIds = TOOL_GROUPS.map((g) => g.id);
  assert.equal(new Set(groupIds).size, groupIds.length);
});

test('indicator names are unique', () => {
  const names = INDICATORS.map((i) => i.name);
  assert.equal(new Set(names).size, names.length);
});

test('findTool resolves a real tool and rejects an unknown one', () => {
  assert.equal(findTool('fibonacciLine')?.overlay, 'fibonacciLine');
  assert.equal(findTool('not-a-tool'), null);
});

test('the two overlay groups are distinct', () => {
  // Clear-all removes USER only. If these two strings were ever equal, clearing
  // drawings would also delete the oracle and liquidation lines.
  assert.notEqual(OVERLAY_GROUP.USER, OVERLAY_GROUP.VAYYL);
});

test('oscillators are not stacked onto the price axis', () => {
  // A 0-100 oscillator sharing a scale with a $0.18 price flattens the candles
  // into a few pixels. This is a real misconfiguration, not a hypothetical.
  for (const name of ['RSI', 'MACD', 'KDJ', 'VOL', 'WR', 'CCI']) {
    assert.equal(findIndicator(name)?.pane, 'sub', `${name} must get its own pane`);
  }
});

test('price-unit indicators overlay the candles', () => {
  for (const name of ['MA', 'EMA', 'BOLL', 'SAR']) {
    assert.equal(findIndicator(name)?.pane, 'main', `${name} belongs on the price axis`);
  }
});
