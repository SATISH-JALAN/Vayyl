/**
 * Navigation scroll behavior
 * - Show/hide based on scroll direction
 * - Glassmorphism background on scroll
 * - Smooth scroll to sections on link click
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';
import { getLenis } from './lenis';

export function initNavigation(): void {
  const nav = document.getElementById('nav');
  if (!nav) return;

  // ── Scroll-direction show/hide ──
  ScrollTrigger.create({
    start: 'top -100',
    end: 'max',
    onUpdate: (self) => {
      if (self.direction === -1) {
        // Scrolling up — show nav
        nav.classList.remove('is-hidden');
      } else {
        // Scrolling down — hide nav
        nav.classList.add('is-hidden');
      }
    },
  });

  // ── Glassmorphism background after scrolling past hero ──
  ScrollTrigger.create({
    trigger: '.hero',
    start: 'bottom top',
    onEnter: () => nav.classList.add('is-scrolled'),
    onLeaveBack: () => nav.classList.remove('is-scrolled'),
  });

  // ── Smooth scroll on nav link click ──
  const navLinks = nav.querySelectorAll<HTMLAnchorElement>('a[href^="#"]');
  navLinks.forEach((link) => {
    link.addEventListener('click', (e: Event) => {
      e.preventDefault();
      const href = link.getAttribute('href');
      if (!href || href === '#') return;

      const target = document.querySelector(href);
      if (!target) return;

      const lenis = getLenis();
      if (lenis) {
        lenis.scrollTo(target as HTMLElement, { offset: 0, duration: 1.2 });
      } else {
        gsap.to(window, { scrollTo: { y: href, offsetY: 0 }, duration: 1, ease: 'power2.inOut' });
      }
    });
  });
}
