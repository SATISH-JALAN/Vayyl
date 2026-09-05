'use client';

import { useRef, useState, type ReactNode } from 'react';

import { useDismiss } from './useDismiss';

/**
 * An (i) button with a popover.
 *
 * Exists so text that must stay available can stop consuming vertical space.
 * On the terminal that matters: the disclosure explaining what a position leaks
 * is not boilerplate — the address, the tier, the direction and both prices are
 * all public — so it cannot be deleted, but it also cannot sit permanently
 * between the header and the chart on a page that has to fit one screen.
 */
export default function InfoPopover({
  label,
  align = 'left',
  children,
}: {
  /** Accessible name for the trigger. */
  label: string;
  align?: 'left' | 'right';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useDismiss(open, ref, () => setOpen(false));

  return (
    <span className="vy-info" ref={ref}>
      <button
        type="button"
        className={`vy-info__btn ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 7.6v.2" />
        </svg>
      </button>
      {open && (
        <div className={`vy-info__pop vy-info__pop--${align}`} role="note">
          {children}
        </div>
      )}
    </span>
  );
}
