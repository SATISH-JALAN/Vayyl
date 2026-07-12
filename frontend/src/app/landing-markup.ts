export const landingMarkup = String.raw`
  <div class="preloader" id="preloader" aria-hidden="true">
    <span class="preloader__text">Vayyl</span>
  </div>

  <nav class="nav" id="nav" role="navigation" aria-label="Main navigation">
    <div class="nav__inner">
      <a href="#" class="nav__logo">
        <img src="/images/vayyllogomain - Copy.png" alt="Vayyl" />
      </a>
      <div class="nav__links">
        <a href="https://vayyl.gitbook.io/vayyl-docs" class="nav__docs" target="_blank" rel="noreferrer">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"></path></svg>
          <span>Docs</span>
        </a>
        <a href="/app" class="nav__cta" id="nav-cta">Launch App</a>
      </div>
    </div>
  </nav>

  <section class="hero" id="hero">
    <video class="hero__video" src="/videos/hero-bg.mp4" poster="/images/hero-bg.webp" autoplay loop muted playsinline preload="metadata" aria-hidden="true"></video>
    <div class="hero__grain"></div>
    <div class="hero__gradient"></div>

    <div class="hero__content">
      <p class="hero__kicker">Shielded pools / Groth16 / Soroban BN254</p>
      <h1 class="hero__title display-hero" id="hero-title">Private notes.<br />Public proofs.</h1>

      <p class="hero__subtitle" id="hero-subtitle">
        Shield XLM into a private note, keep an encrypted backup, and settle through a proof verified on Stellar.
      </p>

      <div class="hero__actions">
        <a href="/app" class="btn btn--primary" id="hero-cta">
          <span>Launch App</span>
          <span class="btn__arrow">-&gt;</span>
        </a>
        <a href="#how-it-works" class="btn btn--ghost">
          <span>Trace the proof path</span>
          <span class="btn__arrow">-&gt;</span>
        </a>
      </div>
    </div>

    <svg class="hero__line" viewBox="0 0 1440 200" preserveAspectRatio="none" aria-hidden="true">
      <path id="hero-line-path" d="M0,180 C240,120 360,160 480,100 C600,40 720,140 960,80 C1200,20 1320,120 1440,60"></path>
    </svg>
  </section>

  <section class="problem" id="problem">
    <p class="problem__text" id="problem-text">
      Every on-chain transfer is a broadcast. Every open position is a public signal. Every strategy becomes a leak the moment it touches a ledger.
    </p>
  </section>

  <section class="reveal" id="about">
    <div class="reveal__beneath">
      <div class="reveal__beneath-inner">
        <div class="reveal__text-block">
          <span class="reveal__eyebrow">The Protocol</span>
          <h2 class="reveal__title">The settlement layer that keeps secrets</h2>
          <p class="reveal__body">
            Vayyl combines private notes, client-side proving, and Soroban verification in one self-custodied vault. The same foundation extends to positions, orders, and automated settlement.
          </p>
          <a href="#features" class="btn btn--ghost-dark">
            <span>See what's possible</span>
            <span class="btn__arrow">-&gt;</span>
          </a>
        </div>
        <div class="reveal__visual" id="reveal-visual">
          <img src="/images/reveal-visual.webp" alt="Abstract visualization of shielded value transfer" loading="lazy" />
        </div>
      </div>
    </div>

    <div class="reveal__curtain" id="reveal-curtain">
      <div class="reveal__curtain-bg"></div>
      <div class="reveal__curtain-content">
        <p class="reveal__curtain-text">Hold the note. Prove the spend. Settle on Stellar.</p>
      </div>
    </div>
  </section>

  <section class="how-it-works" id="how-it-works">
    <div class="how-it-works__header">
      <h2 class="display-h2">Three moves, one private note</h2>
      <p class="text-body-large">A simple path from deposit to recovery and settlement.</p>
    </div>

    <div class="how-it-works__track-wrapper" id="how-track-wrapper">
      <div class="how-it-works__track" id="how-track">
        <article class="process-card">
          <div>
            <span class="process-card__step">01</span>
            <h3 class="process-card__title">Shield</h3>
            <p class="process-card__text">Deposit 1 XLM and create a private note. The pool records its commitment while the note stays with your wallet.</p>
          </div>
          <div class="process-card__visual">
            <img src="/images/process-shield.webp" alt="Shield step visualization" loading="lazy" />
          </div>
        </article>

        <article class="process-card">
          <div>
            <span class="process-card__step">02</span>
            <h3 class="process-card__title">Keep</h3>
            <p class="process-card__text">Export an encrypted backup, clear the local copy, and restore it later with the same connected wallet.</p>
          </div>
          <div class="process-card__visual">
            <img src="/images/process-route.webp" alt="Route step visualization" loading="lazy" />
          </div>
        </article>

        <article class="process-card">
          <div>
            <span class="process-card__step">03</span>
            <h3 class="process-card__title">Settle</h3>
            <p class="process-card__text">Prove ownership locally and unshield through a relayer to any funded Stellar account.</p>
          </div>
          <div class="process-card__visual">
            <img src="/images/process-settle.webp" alt="Settle step visualization" loading="lazy" />
          </div>
        </article>
      </div>
    </div>
  </section>

  <section class="features" id="features">
    <div class="features__header">
      <h2 class="display-h2">What you can build on Vayyl</h2>
      <p class="text-body-large">Five primitives, one verification path.</p>
    </div>

    <div class="features__grid" id="features-grid">
      <article class="card" id="feature-payments">
        <div class="card__icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
        </div>
        <h3 class="card__title">Private Notes</h3>
        <p class="card__text">Create, back up, restore, and spend self-custodied notes through proof-verified settlement.</p>
      </article>

      <article class="card" id="feature-positions">
        <div class="card__icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2"></rect>
            <path d="M3 9h18"></path>
            <path d="M9 21V9"></path>
          </svg>
        </div>
        <h3 class="card__title">Private Positions</h3>
        <p class="card__text">Open leveraged positions with committed collateral. Prove health to any protocol on demand without revealing size, direction, or strategy.</p>
      </article>

      <article class="card" id="feature-orders">
        <div class="card__icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 6v6l4 2"></path>
          </svg>
        </div>
        <h3 class="card__title">Hidden Orders</h3>
        <p class="card__text">Commit sealed orders that trigger only when your hidden conditions are met. Failed trigger attempts reveal nothing, not even the direction.</p>
      </article>

      <article class="card" id="feature-liquidation">
        <div class="card__icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          </svg>
        </div>
        <h3 class="card__title">Liquidation Protection</h3>
        <p class="card__text">Heartbeat attestations prove solvency continuously. Forced reveals happen only after grace periods expire, and only for that one position.</p>
      </article>

      <article class="card" id="feature-agentic">
        <div class="card__icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8h1a4 4 0 010 8h-1"></path>
            <path d="M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"></path>
            <line x1="6" y1="1" x2="6" y2="4"></line>
            <line x1="10" y1="1" x2="10" y2="4"></line>
            <line x1="14" y1="1" x2="14" y2="4"></line>
          </svg>
        </div>
        <h3 class="card__title">Agentic Settlement</h3>
        <p class="card__text">Autonomous agents claim rewards through x402/MPP rails. Agent identity and exact reward amounts stay shielded from on-chain observers.</p>
      </article>
    </div>
  </section>

  <section class="architecture" id="architecture">
    <div class="architecture__header">
      <div class="architecture__network">
        <span>Built on</span>
        <img src="/brands/stellar-wordmark-white.png" alt="Stellar" />
      </div>
      <h2 class="display-h2">Nine contracts, one verification path</h2>
      <p>Every proof routes through a single Groth16 verifier using Stellar's native BN254 host functions.</p>
    </div>

    <div class="architecture__diagram" id="arch-diagram">
      <svg viewBox="0 0 960 520" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Vayyl smart contract architecture diagram">
        <path class="connector" d="M480,60 L280,160" id="conn-1"></path>
        <path class="connector" d="M480,60 L680,160" id="conn-2"></path>
        <path class="connector" d="M280,200 L160,300" id="conn-3"></path>
        <path class="connector" d="M280,200 L280,300" id="conn-4"></path>
        <path class="connector" d="M280,200 L400,300" id="conn-5"></path>
        <path class="connector" d="M680,200 L560,300" id="conn-6"></path>
        <path class="connector" d="M560,340 L480,420" id="conn-7"></path>
        <path class="connector" d="M560,340 L640,420" id="conn-8"></path>
        <path class="connector" d="M560,340 L800,420" id="conn-9"></path>
        <path class="connector" d="M160,340 L160,460 L480,460" stroke-dasharray="4 4" id="conn-verify-1"></path>
        <path class="connector" d="M480,420 L480,460" stroke-dasharray="4 4" id="conn-verify-2"></path>
        <path class="connector" d="M640,420 L640,460 L520,460" stroke-dasharray="4 4" id="conn-verify-3"></path>
        <path class="connector" d="M800,420 L800,460 L520,460" stroke-dasharray="4 4" id="conn-verify-4"></path>

        <circle class="node-circle" cx="480" cy="50" r="8"></circle>
        <text class="node-label" x="480" y="35" text-anchor="middle">VayylPoolFactory</text>
        <circle class="node-circle" cx="280" cy="180" r="8"></circle>
        <text class="node-label" x="280" y="165" text-anchor="middle">VayylPool (XLM)</text>
        <circle class="node-circle" cx="680" cy="180" r="8"></circle>
        <text class="node-label" x="680" y="165" text-anchor="middle">VayylPool (USDC)</text>
        <circle class="node-circle" cx="160" cy="320" r="8"></circle>
        <text class="node-label" x="160" y="360" text-anchor="middle">Groth16Verifier</text>
        <circle class="node-circle" cx="280" cy="320" r="8"></circle>
        <text class="node-label" x="280" y="360" text-anchor="middle">ASP Membership</text>
        <circle class="node-circle" cx="400" cy="320" r="8"></circle>
        <text class="node-label" x="400" y="360" text-anchor="middle">ASP Non-Membership</text>
        <circle class="node-circle" cx="560" cy="320" r="8"></circle>
        <text class="node-label" x="560" y="305" text-anchor="middle">PositionManager</text>
        <circle class="node-circle" cx="480" cy="440" r="8"></circle>
        <text class="node-label" x="480" y="475" text-anchor="middle">LiquidationEngine</text>
        <circle class="node-circle" cx="640" cy="440" r="8"></circle>
        <text class="node-label" x="640" y="475" text-anchor="middle">HiddenOrderRegistry</text>
        <circle class="node-circle" cx="800" cy="440" r="8"></circle>
        <text class="node-label" x="800" y="475" text-anchor="middle">AgenticSettlementHub</text>
        <text class="node-label" x="480" y="498" text-anchor="middle" fill="rgba(248,246,243,0.35)" font-size="9">all verify through Groth16Verifier</text>
      </svg>
    </div>
  </section>

  <section class="trust" id="trust">
    <div class="trust__inner">
      <div class="trust__lead">
        <h2 class="trust__title">Proven primitives,<br>production chain.</h2>
        <p class="trust__description">
          Vayyl settles on Stellar: fast finality, predictable costs, and an established validator network. The same chain already clearing billions in real-world assets.
        </p>
      </div>

      <div class="trust__grid" id="trust-stats">
        <div class="trust__item">
          <div class="trust__item-header">
            <span class="trust__item-value" data-target="100" data-prefix="&lt;" data-suffix="M">&lt; <span class="counter-value">0</span>M</span>
            <span class="trust__item-label">Instructions</span>
          </div>
          <p class="trust__item-text">Well within Soroban's transaction ceiling per proof.</p>
        </div>

        <div class="trust__item">
          <div class="trust__item-header">
            <span class="trust__item-value">BN254 + Groth16</span>
            <span class="trust__item-label">Cryptography</span>
          </div>
          <p class="trust__item-text">Battle-tested curve and proof system with native Stellar host function support.</p>
        </div>

        <div class="trust__item">
          <div class="trust__item-header">
            <span class="trust__item-value">9</span>
            <span class="trust__item-label">Smart Contracts</span>
          </div>
          <p class="trust__item-text">Modular architecture: per-asset pools, single verifier, composable settlement.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="cta" id="cta">
    <div class="cta__glow"></div>
    <div class="cta__content">
      <h2 class="cta__title" id="cta-title">Open your vault.</h2>
      <p class="cta__subtitle">Connect a Stellar wallet and create your first private note.</p>
      <div class="hero__actions">
        <a href="/app?view=pool" class="btn btn--primary"><span>Launch App</span><span class="btn__arrow">-&gt;</span></a>
        <a href="https://vayyl.gitbook.io/vayyl-docs" class="btn btn--ghost" target="_blank" rel="noreferrer"><span>Read Docs</span><span class="btn__arrow">-&gt;</span></a>
      </div>
    </div>
  </section>

  <footer class="footer" id="footer">
    <div class="footer__inner">
      <div class="footer__top">
        <div>
          <div class="footer__brand">Vayyl</div>
          <p class="footer__tagline">Confidential settlement infrastructure for the programmable economy.</p>
        </div>
        <div>
          <h4 class="footer__col-title">Product</h4>
          <a href="/app" class="footer__link">Open App</a>
          <a href="https://vayyl.gitbook.io/vayyl-docs" class="footer__link footer__link--icon" target="_blank" rel="noreferrer">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"></path></svg>
            <span>Documentation</span>
          </a>
        </div>
        <div>
          <h4 class="footer__col-title">Build</h4>
          <a href="https://github.com/akm2006/Vayyl" class="footer__link footer__link--icon" target="_blank" rel="noreferrer">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"></path></svg>
            <span>Source</span>
          </a>
          <a href="https://github.com/akm2006/Vayyl/tree/main/circuits" class="footer__link" target="_blank" rel="noreferrer">Circuits</a>
          <a href="https://github.com/akm2006/Vayyl/tree/main/deployments" class="footer__link" target="_blank" rel="noreferrer">Deployments</a>
        </div>
        <div>
          <h4 class="footer__col-title">Follow</h4>
          <a href="https://x.com/Vayylstellar" class="footer__link footer__link--icon" target="_blank" rel="noreferrer">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"></path></svg>
            <span>X / Twitter</span>
          </a>
          <a href="https://github.com/akm2006/Vayyl" class="footer__link footer__link--icon" target="_blank" rel="noreferrer">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"></path></svg>
            <span>GitHub</span>
          </a>
        </div>
      </div>
      <div class="footer__bottom">
        <span class="footer__copy">Copyright 2026 Vayyl. All rights reserved.</span>
        <div class="footer__socials">
          <a href="https://github.com/akm2006/Vayyl" class="footer__social" aria-label="GitHub" target="_blank" rel="noreferrer">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"></path></svg>
          </a>
          <a href="https://x.com/Vayylstellar" class="footer__social" aria-label="Vayyl on X" target="_blank" rel="noreferrer"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"></path></svg></a>
        </div>
      </div>
    </div>
  </footer>
`;
