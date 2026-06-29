/**
 * Architecture diagram — DrawSVG progressive reveal
 * Connector lines draw on scroll, then nodes + labels fade in.
 */
import gsap from 'gsap';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export function initDrawSVG(): void {
  const diagram = document.getElementById('arch-diagram');
  if (!diagram) return;

  const connectors = diagram.querySelectorAll<SVGPathElement>('.connector');
  const circles = diagram.querySelectorAll<SVGCircleElement>('.node-circle');
  const labels = diagram.querySelectorAll<SVGTextElement>('.node-label');

  if (!connectors.length) return;

  // ── Section header entrance ──
  gsap.from('.architecture__header', {
    autoAlpha: 0,
    y: 40,
    duration: 0.8,
    ease: 'power2.out',
    scrollTrigger: {
      trigger: '.architecture',
      start: 'top 75%',
      toggleActions: 'play none none none',
    },
  });

  // ── Main diagram timeline ──
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: diagram,
      start: 'top 70%',
      end: 'bottom 30%',
      scrub: 0.8,
    },
  });

  // Draw all connector lines
  tl.from(connectors, {
    drawSVG: '0%',
    duration: 1,
    stagger: 0.08,
    ease: 'none',
  });

  // Scale in the node circles
  tl.to(
    circles,
    {
      opacity: 1,
      scale: 1,
      duration: 0.4,
      stagger: 0.05,
      ease: 'back.out(1.7)',
    },
    '-=0.5'
  );

  // Fade in labels
  tl.to(
    labels,
    {
      opacity: 1,
      duration: 0.4,
      stagger: 0.04,
      ease: 'power2.out',
    },
    '-=0.3'
  );
}
