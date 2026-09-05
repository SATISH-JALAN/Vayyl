'use client';

/**
 * Stroke icons for the chart chrome.
 *
 * Separated from the toolbar so `chart-tools.ts` stays a plain data file with
 * no JSX in it — that is what lets the registry be tested in a runner with no
 * DOM. The `icon` string on each tool group indexes into this map.
 */
const paths: Record<string, React.ReactNode> = {
  cursor: (
    <>
      <path d="M12 3v18M3 12h18" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  trend: <path d="M4 19L20 5M20 5h-6M20 5v6" />,
  horizontal: (
    <>
      <path d="M3 12h18" />
      <circle cx="7" cy="12" r="1.6" />
      <circle cx="17" cy="12" r="1.6" />
    </>
  ),
  vertical: (
    <>
      <path d="M12 3v18" />
      <circle cx="12" cy="7" r="1.6" />
      <circle cx="12" cy="17" r="1.6" />
    </>
  ),
  fib: <path d="M3 5h18M3 10h18M3 14h18M3 19h18M6 5v14" />,
  channel: <path d="M3 16L15 4M9 20L21 8M3 16l6 4M15 4l6 4" />,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  brush: (
    <>
      <path d="M3 21c3 0 4-2 4-4a3 3 0 1 0-4 4Z" />
      <path d="M8.5 15.5 19 5a2.1 2.1 0 0 0-3-3L5.5 12.5" />
    </>
  ),
  clear: <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5" />,
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
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.6v.2" />
    </>
  ),
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
