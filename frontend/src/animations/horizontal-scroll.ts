/**
 * Horizontal scroll section — "How It Works"
 * Pins the section, scrolls process cards horizontally on vertical scroll.
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function initHorizontalScroll(): void {
  const wrapper = document.getElementById('how-track-wrapper');
  const track = document.getElementById('how-track');
  if (!wrapper || !track) return;

  // Calculate how far to scroll
  const getScrollAmount = (): number => {
    return -(track.scrollWidth - wrapper.offsetWidth);
  };

  // Horizontal scroll tween — MUST use ease: "none"
  const scrollTween = gsap.to(track, {
    x: getScrollAmount,
    ease: 'none',
    scrollTrigger: {
      trigger: '.how-it-works',
      start: 'top top',
      end: () => `+=${track.scrollWidth - wrapper.offsetWidth}`,
      pin: true,
      scrub: 1,
      invalidateOnRefresh: true,
      snap: {
        snapTo: 1 / 2, // 3 cards = 2 intervals
        duration: { min: 0.2, max: 0.4 },
        ease: 'power1.inOut',
      },
    },
  });

  // Individual card entrance animations
  const cards = track.querySelectorAll<HTMLElement>('.process-card');
  cards.forEach((card, i) => {
    gsap.from(card, {
      autoAlpha: 0.4,
      scale: 0.94,
      duration: 0.5,
      ease: 'power2.out',
      scrollTrigger: {
        trigger: card,
        start: 'left 80%',
        end: 'left 40%',
        scrub: true,
        containerAnimation: scrollTween,
      },
    });

    // Stagger the step number reveal
    const step = card.querySelector('.process-card__step');
    if (step) {
      gsap.from(step, {
        autoAlpha: 0,
        x: -20,
        duration: 0.4,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: '.how-it-works',
          start: () => `top+=${i * 30}% top`,
          toggleActions: 'play none none reverse',
        },
      });
    }
  });
}
