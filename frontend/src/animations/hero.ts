/**
 * Hero section animations
 * - SplitText character reveal on headline
 * - Subtitle + buttons fade in
 * - SVG decorative line draw
 * - Parallax on scroll
 */
import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function initHeroAnimations(): gsap.core.Timeline {
  const tl = gsap.timeline({ delay: 0.2 });

  // ── Reveal content wrapper to prevent FOUC ──
  gsap.set('.hero__content', { autoAlpha: 1 });

  // ── Headline character reveal ──
  const heroTitle = document.getElementById('hero-title');
  if (heroTitle) {
    const split = SplitText.create(heroTitle, {
      type: 'chars',
    });

    tl.from(
      split.chars,
      {
        yPercent: 120,
        opacity: 0,
        filter: 'blur(10px)',
        duration: 1.2,
        ease: 'power4.out',
        stagger: 0.05,
      },
      0
    );
  }

  tl.from(
    '.hero__kicker',
    {
      autoAlpha: 0,
      y: 12,
      duration: 0.5,
      ease: 'power2.out',
    },
    0
  );

  // ── Subtitle ──
  tl.from(
    '.hero__subtitle',
    {
      autoAlpha: 0,
      y: 20,
      duration: 0.7,
      ease: 'power2.out',
    },
    '-=0.3'
  );

  // ── Action buttons ──
  tl.from(
    '.hero__actions .btn',
    {
      autoAlpha: 0,
      y: 16,
      duration: 0.5,
      ease: 'power2.out',
      stagger: 0.12,
    },
    '-=0.3'
  );

  // ── SVG line draw ──
  const heroLinePath = document.getElementById('hero-line-path');
  if (heroLinePath) {
    tl.from(
      heroLinePath,
      {
        drawSVG: '0%',
        duration: 1.5,
        ease: 'power1.inOut',
      },
      '-=0.8'
    );
  }

  // ── Hero parallax on scroll ──
  gsap.to('.hero__content', {
    y: -80,
    autoAlpha: 0,
    ease: 'none',
    scrollTrigger: {
      trigger: '.hero',
      start: 'top top',
      end: 'bottom top',
      scrub: 1,
    },
  });

  gsap.to('.hero__line', {
    y: 80,
    ease: 'none',
    scrollTrigger: {
      trigger: '.hero',
      start: 'top top',
      end: 'bottom top',
      scrub: 1,
    },
  });

  return tl;
}
