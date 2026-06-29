/**
 * Staggered card entrance for the Features section
 * Uses ScrollTrigger.batch() for grouped reveal.
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function initStaggerCards(): void {
  const cards = document.querySelectorAll<HTMLElement>('.features__grid .card');
  if (!cards.length) return;

  // Set initial state
  gsap.set(cards, { autoAlpha: 0, y: 50 });

  // Batch entrance
  ScrollTrigger.batch(cards, {
    onEnter: (batch) => {
      gsap.to(batch, {
        autoAlpha: 1,
        y: 0,
        duration: 0.7,
        ease: 'power2.out',
        stagger: 0.1,
      });
    },
    start: 'top 85%',
    once: true,
  });

  // ── Section header entrance ──
  const header = document.querySelector('.features__header');
  if (header) {
    gsap.from(header, {
      autoAlpha: 0,
      y: 40,
      duration: 0.8,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: header,
        start: 'top 80%',
        toggleActions: 'play none none none',
      },
    });
  }

  // ── Card hover interactions ──
  cards.forEach((card) => {
    const icon = card.querySelector('.card__icon');

    card.addEventListener('mouseenter', () => {
      gsap.to(card, {
        y: -6,
        boxShadow: '0 12px 40px rgba(38, 35, 33, 0.08), 0 4px 12px rgba(38, 35, 33, 0.04)',
        borderColor: 'rgba(244, 111, 115, 0.15)',
        duration: 0.3,
        ease: 'power2.out',
      });
      if (icon) {
        gsap.to(icon, { scale: 1.1, duration: 0.3, ease: 'back.out(1.7)' });
      }
    });

    card.addEventListener('mouseleave', () => {
      gsap.to(card, {
        y: 0,
        boxShadow: '0 1px 3px rgba(38, 35, 33, 0.04), 0 1px 2px rgba(38, 35, 33, 0.06)',
        borderColor: 'rgba(147, 139, 133, 0.1)',
        duration: 0.3,
        ease: 'power2.out',
      });
      if (icon) {
        gsap.to(icon, { scale: 1, duration: 0.3, ease: 'power2.out' });
      }
    });
  });
}
