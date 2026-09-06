'use client';

/**
 * Stroke icons for the chart chrome.
 *
 * Separated from `chart-tools.ts` so that stays a plain data file with no JSX
 * in it — which is what lets the tool registry be tested in a runner with no
 * DOM. The `icon` string on each tool group indexes into this map.
 *
 * The rail set matches the circulated design one-for-one, in order:
 * cursor, trend, lines, channel, fib, text, emoji, brush, zoom.
 */
const paths: Record<string, React.ReactNode> = {
  // Crosshair.
  cursor: (
    <>
      <path d="M12 3v5M12 16v5M3 12h5M16 12h5" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),

  // Trend line with endpoint handles.
  trend: (
    <>
      <path d="M6.5 17.5 17.5 6.5" />
      <circle cx="5" cy="19" r="1.9" />
      <circle cx="19" cy="5" r="1.9" />
    </>
  ),

  // Stacked horizontal levels with handles.
  lines: (
    <>
      <path d="M3 7h18M3 12h18M3 17h18" />
      <circle cx="8" cy="7" r="1.5" />
      <circle cx="16" cy="12" r="1.5" />
      <circle cx="8" cy="17" r="1.5" />
    </>
  ),

  // Parallel channel — two crossing rails with corner handles.
  channel: (
    <>
      <path d="M5 18 19 6M5 12 19 18" />
      <circle cx="4" cy="19" r="1.6" />
      <circle cx="20" cy="5" r="1.6" />
      <circle cx="4" cy="11" r="1.6" />
      <circle cx="20" cy="19" r="1.6" />
    </>
  ),

  // Fibonacci retracement — unevenly spaced levels.
  fib: (
    <>
      <path d="M3 5h18M3 10h18M3 14h18M3 19h18" />
      <circle cx="6" cy="5" r="1.4" />
      <circle cx="14" cy="10" r="1.4" />
      <circle cx="10" cy="14" r="1.4" />
      <circle cx="17" cy="19" r="1.4" />
    </>
  ),

  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,

  emoji: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5v.2M15 9.5v.2" />
    </>
  ),

  brush: (
    <>
      <path d="M3 21c3 0 4-2 4-4a3 3 0 1 0-4 4Z" />
      <path d="M8.5 15.5 19 5a2.1 2.1 0 0 0-3-3L5.5 12.5" />
    </>
  ),

  zoom: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5 21 21M8 10.5h5M10.5 8v5" />
    </>
  ),

  // Toolbar chrome.
  candles: (
    <>
      <path d="M7 4v16M17 4v16" />
      <rect x="4.5" y="8" width="5" height="8" rx="1" />
      <rect x="14.5" y="6" width="5" height="7" rx="1" />
    </>
  ),
  indicators: <path d="M3 17l4-5 3 3 4-7 3 4 4-6" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  camera: (
    <>
      <path d="M3 8h3.5L8 6h8l1.5 2H21v11H3z" />
      <circle cx="12" cy="13" r="3.4" />
    </>
  ),
  clear: <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5" />,
};

export default function ChartIcon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] ?? paths.cursor}
    </svg>
  );
}
