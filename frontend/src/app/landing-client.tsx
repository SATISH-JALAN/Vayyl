'use client';

import { useEffect } from 'react';
import 'lenis/dist/lenis.css';

import gsap from 'gsap';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';
import { ScrambleTextPlugin } from 'gsap/ScrambleTextPlugin';
import { ScrollToPlugin } from 'gsap/ScrollToPlugin';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';

import { initCounters } from '../animations/counters';
import { initCurtainReveal } from '../animations/curtain';
import { initDrawSVG } from '../animations/draw-svg';
import { initHeroAnimations } from '../animations/hero';
import { initHorizontalScroll } from '../animations/horizontal-scroll';
import { destroyLenis, initLenis } from '../animations/lenis';
import { initCtaAnimations, initMagneticButtons } from '../animations/magnetic';
import { initNavigation } from '../animations/navigation';
import { initParallax } from '../animations/parallax';
import { initPreloader } from '../animations/preloader';
import { initStaggerCards } from '../animations/stagger-cards';
import { initTextReveal } from '../animations/text-reveal';

gsap.registerPlugin(ScrollTrigger, SplitText, DrawSVGPlugin, ScrambleTextPlugin, ScrollToPlugin);

export function LandingClient() {
  useEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    initLenis();

    if (prefersReduced) {
      const preloader = document.getElementById('preloader');
      if (preloader) preloader.style.display = 'none';

      gsap.set('.hero__content, .hero__subtitle, .hero__actions .btn, .scroll-indicator', {
        autoAlpha: 1,
      });
      gsap.set('.features__grid .card', { autoAlpha: 1, y: 0 });
      gsap.set('.trust__item', { autoAlpha: 1, y: 0 });
      initNavigation();
    } else {
      const preloaderTl = initPreloader();

      preloaderTl.then(() => {
        initHeroAnimations();
        initNavigation();
        initTextReveal();
        initCurtainReveal();
        initHorizontalScroll();
        initStaggerCards();
        initDrawSVG();
        initParallax();
        initCounters();
        initMagneticButtons();
        initCtaAnimations();
        ScrollTrigger.refresh();
      });
    }

    return () => {
      ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
      gsap.killTweensOf('*');
      destroyLenis();
    };
  }, []);

  return null;
}
