/**
 * Curtain reveal — the signature "veil lift" effect
 * A clip-path wipe reveals the content underneath.
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function initCurtainReveal(): void {
  const curtain = document.getElementById('reveal-curtain');
  if (!curtain) return;

  const section = document.getElementById('about');
  if (!section) return;

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: section,
      start: 'top top',
      end: '+=120%',
      pin: true,
      scrub: 0.6,
    },
  });

  // Fade out the curtain text first
  tl.to('.reveal__curtain-text', {
    autoAlpha: 0,
    y: -30,
    duration: 0.3,
    ease: 'power2.in',
  });

  // Wipe the curtain from left to right using clip-path
  tl.to(curtain, {
    clipPath: 'inset(0 0 0 100%)',
    duration: 1,
    ease: 'power2.inOut',
  });

  // Animate the revealed content
  tl.from(
    '.reveal__text-block',
    {
      autoAlpha: 0,
      x: -40,
      duration: 0.6,
      ease: 'power2.out',
    },
    '-=0.4'
  );

  tl.from(
    '.reveal__visual',
    {
      autoAlpha: 0,
      scale: 0.95,
      duration: 0.6,
      ease: 'power2.out',
    },
    '-=0.4'
  );

  // Hold briefly
  tl.to({}, { duration: 0.3 });
}
