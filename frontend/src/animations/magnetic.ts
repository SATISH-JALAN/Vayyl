/**
 * Magnetic button effect + ScrambleText on CTA hover
 * Buttons follow the cursor within a radius and spring back.
 */
import gsap from 'gsap';
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin';

export function initMagneticButtons(): void {
  const ctaBtn = document.getElementById('cta-submit');
  const ctaText = document.getElementById('cta-submit-text');
  if (!ctaBtn || !ctaText) return;

  const originalText = ctaText.textContent || 'Request access';
  const magnetStrength = 0.3;
  const magnetRadius = 100;

  // ── Magnetic pull ──
  const xTo = gsap.quickTo(ctaBtn, 'x', { duration: 0.4, ease: 'power3' });
  const yTo = gsap.quickTo(ctaBtn, 'y', { duration: 0.4, ease: 'power3' });

  ctaBtn.addEventListener('mousemove', (e: MouseEvent) => {
    const rect = ctaBtn.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const deltaX = e.clientX - centerX;
    const deltaY = e.clientY - centerY;
    const dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    if (dist < magnetRadius) {
      xTo(deltaX * magnetStrength);
      yTo(deltaY * magnetStrength);
    }
  });

  ctaBtn.addEventListener('mouseleave', () => {
    xTo(0);
    yTo(0);
  });


  // ── Also apply to hero CTA ──
  const heroCta = document.getElementById('hero-cta');
  if (heroCta) {
    const heroXTo = gsap.quickTo(heroCta, 'x', { duration: 0.4, ease: 'power3' });
    const heroYTo = gsap.quickTo(heroCta, 'y', { duration: 0.4, ease: 'power3' });

    heroCta.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = heroCta.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const deltaX = e.clientX - centerX;
      const deltaY = e.clientY - centerY;
      const dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (dist < magnetRadius) {
        heroXTo(deltaX * magnetStrength);
        heroYTo(deltaY * magnetStrength);
      }
    });

    heroCta.addEventListener('mouseleave', () => {
      heroXTo(0);
      heroYTo(0);
    });
  }
}

/**
 * CTA section entrance animations
 */
export function initCtaAnimations(): void {
  gsap.from('#cta-title', {
    autoAlpha: 0,
    y: 40,
    duration: 0.8,
    ease: 'power2.out',
    scrollTrigger: {
      trigger: '.cta',
      start: 'top 70%',
      toggleActions: 'play none none none',
    },
  });

  gsap.from('.cta__subtitle', {
    autoAlpha: 0,
    y: 30,
    duration: 0.7,
    ease: 'power2.out',
    scrollTrigger: {
      trigger: '.cta',
      start: 'top 65%',
      toggleActions: 'play none none none',
    },
  });

  gsap.from('.form-group', {
    autoAlpha: 0,
    y: 20,
    duration: 0.6,
    ease: 'power2.out',
    scrollTrigger: {
      trigger: '.cta',
      start: 'top 60%',
      toggleActions: 'play none none none',
    },
  });
}
