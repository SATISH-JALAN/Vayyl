/**
 * Preloader animation — logo fade in/out, then curtain wipe up
 */
import gsap from 'gsap';

export function initPreloader(): gsap.core.Timeline {
  const preloader = document.getElementById('preloader');
  if (!preloader) return gsap.timeline();

  const tl = gsap.timeline();

  // Fade in the logo text
  tl.to('.preloader__text', {
    opacity: 1,
    duration: 0.6,
    ease: 'power2.out',
  });

  // Hold
  tl.to({}, { duration: 0.6 });

  // Fade out text
  tl.to('.preloader__text', {
    opacity: 0,
    y: -20,
    duration: 0.4,
    ease: 'power2.in',
  });

  // Wipe the preloader up
  tl.to(preloader, {
    yPercent: -100,
    duration: 0.8,
    ease: 'power3.inOut',
    onComplete: () => {
      preloader.style.display = 'none';
    },
  });

  return tl;
}
