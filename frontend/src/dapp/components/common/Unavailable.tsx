'use client';

import { useId, useState, type ReactNode } from 'react';

import type { UnavailableReason } from '../../lib/unavailable';

/**
 * Wraps a control that the design shows but the protocol does not back.
 *
 * The control stays visible and keyboard-reachable so the layout matches and a
 * screen-reader user learns the same thing a sighted one does — but it cannot
 * be activated, and the reason is one hover or one focus away.
 *
 * `title` is deliberately not used on its own: it never appears on touch, it is
 * slow on hover, and it is inconsistently announced. A real tooltip element
 * carries the text, with `title` kept only as a last-resort fallback.
 */
export default function Unavailable({
  reason,
  children,
  className = '',
}: {
  reason: UnavailableReason;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className={`vy-unavailable ${className}`.trim()}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="vy-unavailable__control">
        {children}
      </span>
      {open && (
        <span role="tooltip" id={id} className="vy-tooltip">
          <strong>{reason.label} is not available</strong>
          {reason.reason}
        </span>
      )}
    </span>
  );
}
