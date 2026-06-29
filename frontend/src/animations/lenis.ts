/**
 * Lenis smooth scroll setup + GSAP ScrollTrigger integration
 */
import Lenis from 'lenis';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

let lenisInstance: Lenis | null = null;

export function initLenis(): Lenis {
  lenisInstance = new Lenis({
    lerp: 0.1,
    smoothWheel: true,
    syncTouch: false,
  });

  // Sync Lenis scroll position with GSAP ScrollTrigger
  lenisInstance.on('scroll', ScrollTrigger.update);

  // Use GSAP ticker for the Lenis RAF loop (keeps everything in sync)
  gsap.ticker.add((time: number) => {
    lenisInstance?.raf(time * 1000);
  });

  gsap.ticker.lagSmoothing(0);

  return lenisInstance;
}

export function getLenis(): Lenis | null {
  return lenisInstance;
}

export function destroyLenis(): void {
  if (lenisInstance) {
    lenisInstance.destroy();
    lenisInstance = null;
  }
}
