// ============================================================
// Controls that exist in the design but not in the protocol
// ============================================================
// Every "why is this greyed out" sentence lives here rather than scattered
// through JSX, so the whole set can be reviewed at once and none of them can
// quietly become untrue as the contracts change.
//
// These are rendered, disabled, with the reason attached — not hidden. Hiding
// them would drift from the design that was circulated publicly; enabling them
// would be worse, because a control that appears to work and silently does
// nothing is how a demo starts lying.
//
// When one of these ships for real, delete its entry and the compiler finds
// every place that referenced it. That promise rests on the "satisfies" below
// rather than a type annotation: annotating the object Record<string, ...>
// would widen its key type to string, and an index access on a string-keyed
// Record NEVER errors -- so a deleted entry would compile fine everywhere and
// render an empty tooltip at runtime. "satisfies" checks each value against
// UnavailableReason while keeping the keys literal, so UNAVAILABLE.rageQuit is
// a compile error the moment rageQuit is gone.

export interface UnavailableReason {
  /** What the control is called in the UI. */
  label: string;
  /** Shown on hover and focus. One sentence, naming what is actually missing. */
  reason: string;
}

export const UNAVAILABLE = {
  limitOrders: {
    label: 'Limit',
    reason:
      'Limit orders need a keeper that can open a position at a price the trader has not signed for. The hidden-order-registry contract exists, but nothing wires it to positions yet.',
  },

  openOrders: {
    label: 'Open Orders',
    reason: 'There are no resting orders to list until limit orders exist.',
  },

  rageQuit: {
    label: 'Rage-Quit',
    reason:
      'Rage-quit is a shielded-pool escape hatch (ragequit_v2) for exiting a note without ASP screening. There is no position-level equivalent: closing a position already settles it in full.',
  },

  shieldedToggle: {
    label: 'Shielded Position (ZK-SNARK)',
    reason:
      'Funding is always shielded here. There is no unshielded path to switch off, so this reports state rather than offering a choice.',
  },

  leverageSlider: {
    label: 'Leverage',
    reason:
      'Leverage is derived, not chosen. A tier fixes the position size, so the notional — and therefore the leverage — moves with the mark price.',
  },
} satisfies Record<string, UnavailableReason>;

/** The keys that actually exist, for anything that stores one. */
export type UnavailableKey = keyof typeof UNAVAILABLE;

// chartScreenshot was here. It described TradingView's screenshot button, which
// posts the image to snapshot.tradingview.com. KLineChart renders to a data URL
// in the tab and uploads nothing, so the button is real and the entry is gone.
