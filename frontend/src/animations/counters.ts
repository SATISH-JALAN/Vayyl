/**
 * Animated number counters for the Trust section
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function initCounters(): void {
  const counterEl = document.querySelector<HTMLElement>('.counter-value');
  if (!counterEl) return;

  const target = 100;

  const obj = { value: 0 };

  gsap.to(obj, {
    value: target,
    duration: 2,
    ease: 'power2.out',
    snap: { value: 1 },
    scrollTrigger: {
      trigger: '#trust-stats',
      start: 'top 75%',
      toggleActions: 'play none none none',
    },
    onUpdate: () => {
      counterEl.textContent = Math.round(obj.value).toString();
    },
  });
}
