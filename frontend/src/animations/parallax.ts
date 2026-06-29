/**
 * Parallax floating elements in the Trust section
 * + section entrance animations
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function initParallax(): void {
  // ── Floating orbs at different scroll speeds ──
  const float1 = document.getElementById('float-1');
  const float2 = document.getElementById('float-2');

  if (float1) {
    gsap.to(float1, {
      y: -120,
      x: 30,
      ease: 'none',
      scrollTrigger: {
        trigger: '.trust',
        start: 'top bottom',
        end: 'bottom top',
        scrub: true,
      },
    });
  }

  if (float2) {
    gsap.to(float2, {
      y: -80,
      x: -20,
      rotation: 15,
      ease: 'none',
      scrollTrigger: {
        trigger: '.trust',
        start: 'top bottom',
        end: 'bottom top',
        scrub: true,
      },
    });
  }

  // ── Section header entrance ──
  gsap.from('.trust__header', {
    autoAlpha: 0,
    y: 40,
    duration: 0.8,
    ease: 'power2.out',
    scrollTrigger: {
      trigger: '.trust',
      start: 'top 75%',
      toggleActions: 'play none none none',
    },
  });

  // ── Stats stagger entrance ──
  const stats = document.querySelectorAll<HTMLElement>('.stat');
  if (stats.length) {
    gsap.set(stats, { autoAlpha: 0, y: 30 });

    ScrollTrigger.batch(stats, {
      onEnter: (batch) => {
        gsap.to(batch, {
          autoAlpha: 1,
          y: 0,
          duration: 0.6,
          ease: 'power2.out',
          stagger: 0.12,
        });
      },
      start: 'top 85%',
      once: true,
    });
  }

  // ── Bottom text entrance ──
  gsap.from('.trust__bottom', {
    autoAlpha: 0,
    y: 30,
    duration: 0.7,
    ease: 'power2.out',
    scrollTrigger: {
      trigger: '.trust__bottom',
      start: 'top 85%',
      toggleActions: 'play none none none',
    },
  });
}
