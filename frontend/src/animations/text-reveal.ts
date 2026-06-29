/**
 * Scroll-scrubbed text reveal
 * Each word fades from 0.12 opacity to 1 as scroll progresses.
 * The section is pinned while the reveal completes.
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function initTextReveal(): void {
  const textEl = document.getElementById('problem-text');
  if (!textEl) return;

  // Wrap each word in a span
  const text = textEl.textContent?.trim() || '';
  const words = text.split(/\s+/);
  textEl.innerHTML = words
    .map((word) => `<span class="word">${word}</span>`)
    .join(' ');

  const wordSpans = textEl.querySelectorAll<HTMLSpanElement>('.word');

  // Create a timeline scrubbed to scroll
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: '.problem',
      start: 'top top',
      end: '+=150%',
      pin: true,
      scrub: 0.8,
    },
  });

  // Stagger each word from low to full opacity
  tl.to(wordSpans, {
    opacity: 1,
    duration: 1,
    stagger: 0.08,
    ease: 'none',
  });

  // Hold at full opacity for a beat before unpinning
  tl.to({}, { duration: 0.5 });
}
