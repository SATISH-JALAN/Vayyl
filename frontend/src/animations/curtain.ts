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

  const textEl = curtain.querySelector('.reveal__curtain-text');
  let wordSpans: NodeListOf<HTMLSpanElement> | null = null;

  if (textEl) {
    const text = textEl.textContent?.trim() || '';
    const words = text.split(/\s+/);
    textEl.innerHTML = words
      .map((word) => `<span class="word" style="opacity: 0; transform: translateY(20px) scale(0.95); filter: blur(10px); display: inline-block; will-change: transform, opacity, filter;">${word}</span>`)
      .join(' ');
    wordSpans = textEl.querySelectorAll<HTMLSpanElement>('.word');
  }

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: section,
      start: 'top top',
      end: '+=190%', // Balanced scroll distance
      pin: true,
      scrub: 1, // Increased scrub smoothing so the animation feels more gradual and premium
    },
  });

  if (wordSpans && wordSpans.length > 0) {
    // Reveal text word by word (cinematic blur & scale)
    tl.to(wordSpans, {
      opacity: 1,
      y: 0,
      scale: 1,
      filter: 'blur(0px)',
      duration: 1.8,
      stagger: 0.08,
      ease: 'power3.out',
    });

    // Hold text so user can read it
    tl.to({}, { duration: 1.0 });

    // Removed text fade out to allow the clip-path to slice through it
  } else {
    // Fallback if no text element is found (just hold)
    tl.to({}, { duration: 0.5 });
  }

  // Wipe the curtain from right to left using an expanding circular slice
  tl.to(curtain, {
    clipPath: 'circle(0% at 0% 50%)',
    duration: 2,
    ease: 'power2.inOut',
  });

  // Animate the revealed content
  tl.from(
    '.reveal__text-block',
    {
      autoAlpha: 0,
      x: -60,
      duration: 1,
      ease: 'power2.out',
    },
    '-=1.2'
  );

  tl.from(
    '.reveal__visual',
    {
      autoAlpha: 0,
      scale: 0.95,
      duration: 1,
      ease: 'power2.out',
    },
    '-=1.2'
  );

  // Hold briefly before unpinning
  tl.to({}, { duration: 0.3 });
}
