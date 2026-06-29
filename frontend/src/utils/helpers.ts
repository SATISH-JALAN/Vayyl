/**
 * Shared helpers
 */

/** Check if user prefers reduced motion */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Clamp a value between min and max */
export function clamp(min: number, max: number, value: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Linear interpolation */
export function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

/** Map a value from one range to another */
export function mapRange(
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  value: number
): number {
  return outMin + ((value - inMin) * (outMax - outMin)) / (inMax - inMin);
}
