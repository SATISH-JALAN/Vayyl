/**
 * Vayyl — Main Entry Point
 *
 * Registers all GSAP plugins, initializes Lenis smooth scroll,
 * runs the preloader, then orchestrates all section animations.
 */

// ── Styles ──
import './styles/index.css';
import 'lenis/dist/lenis.css';

// ── GSAP Core + Plugins ──
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';

// ── Animation modules ──
import { initLenis } from './animations/lenis';
import { initPreloader } from './animations/preloader';
import { initHeroAnimations } from './animations/hero';
import { initTextReveal } from './animations/text-reveal';
import { initCurtainReveal } from './animations/curtain';
import { initHorizontalScroll } from './animations/horizontal-scroll';
import { initStaggerCards } from './animations/stagger-cards';
import { initDrawSVG } from './animations/draw-svg';
import { initParallax } from './animations/parallax';
import { initMagneticButtons, initCtaAnimations } from './animations/magnetic';
import { initCounters } from './animations/counters';
import { initNavigation } from './animations/navigation';

// ── Register all GSAP plugins ──
gsap.registerPlugin(
  ScrollTrigger,
  SplitText,
  DrawSVGPlugin,
  ScrambleTextPlugin,
  ScrollToPlugin
);

// ── Boot sequence ──
function init(): void {
  // 1. Initialize smooth scroll
  initLenis();

  // 2. Run preloader, then fire all animations
  const preloaderTl = initPreloader();

  preloaderTl.then(() => {
    // 3. Hero animations (character reveal, SVG draw, parallax)
    initHeroAnimations();

    // 4. Navigation behavior (show/hide, glassmorphism, smooth scroll)
    initNavigation();

    // 5. Scroll-driven section animations
    initTextReveal();
    initCurtainReveal();
    initHorizontalScroll();
    initStaggerCards();
    initDrawSVG();
    initParallax();
    initCounters();
    initMagneticButtons();
    initCtaAnimations();

    // 6. Refresh ScrollTrigger after everything is initialized
    ScrollTrigger.refresh();
  });
}

// ── Reduced motion fallback ──
function initReducedMotion(): void {
  initLenis();

  // Skip preloader
  const preloader = document.getElementById('preloader');
  if (preloader) preloader.style.display = 'none';

  // Make everything visible immediately
  gsap.set('.hero__badge, .hero__subtitle, .hero__actions .btn, .scroll-indicator', {
    autoAlpha: 1,
  });

  // Just set up navigation (no animations)
  initNavigation();

  // Show feature cards
  gsap.set('.features__grid .card', { autoAlpha: 1, y: 0 });
  gsap.set('.stat', { autoAlpha: 1, y: 0 });
}

// ── Entry ──
document.addEventListener('DOMContentLoaded', () => {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (prefersReduced) {
    initReducedMotion();
  } else {
    init();
  }
});
