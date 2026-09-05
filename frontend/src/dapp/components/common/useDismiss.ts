'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Close a popover on outside click or Escape.
 *
 * Escape matters as much as the click: several of these popovers sit inside a
 * chart that captures pointer events, so "click somewhere else" can land on the
 * canvas and start a drawing instead of dismissing the menu. The keyboard route
 * always works, and it is also the only route for anyone not using a mouse.
 *
 * `mousedown` rather than `click`, so the menu is gone before a click that
 * lands on the chart is interpreted as a drawing point.
 */
export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;

    const onPointer = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };

    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, close]);
}
