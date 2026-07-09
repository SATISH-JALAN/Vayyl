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
      <h1 class="hero__title display-hero" id="hero-title">Private positions.<br />Public proofs.</h1>

      <p class="hero__subtitle" id="hero-subtitle">
        Vayyl turns deposits, positions, and orders into commitments and nullifiers, then verifies Groth16 proofs on Stellar Soroban so the chain sees validity, not strategy.
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
            Vayyl is a confidential settlement protocol on Stellar Soroban. Groth16 zero-knowledge proofs, Circom circuits, and Poseidon2 hashing, verified natively on-chain, let you move value, hold positions, and execute orders without exposing what matters.
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
        <p class="reveal__curtain-text">Move value and hold positions on Stellar without exposing amount, identity, or strategy.</p>
      </div>
    </div>
  </section>

  <section class="how-it-works" id="how-it-works">
    <div class="how-it-works__header">
      <h2 class="display-h2">Three moves, zero exposure</h2>
      <p class="text-body-large">From deposit to settlement, every step shielded by zero-knowledge proofs.</p>
    </div>

    <div class="how-it-works__track-wrapper" id="how-track-wrapper">
      <div class="how-it-works__track" id="how-track">
        <article class="process-card">
          <div>
            <span class="process-card__step">01</span>
            <h3 class="process-card__title">Shield</h3>
            <p class="process-card__text">Deposit assets into a shielded pool. Your commitment is recorded on-chain; your amount stays off it. Each pool isolates one asset, keeping costs proportional to activity, not system size.</p>
          </div>
          <div class="process-card__visual">
            <img src="/images/process-shield.webp" alt="Shield step visualization" loading="lazy" />
          </div>
        </article>

        <article class="process-card">
          <div>
            <span class="process-card__step">02</span>
            <h3 class="process-card__title">Route</h3>
            <p class="process-card__text">Transfer, position, or order: all proven in zero knowledge. Nullifiers prevent double-spending. Merkle paths prove inclusion. Amounts balance without being seen.</p>
          </div>
          <div class="process-card__visual">
            <img src="/images/process-route.webp" alt="Route step visualization" loading="lazy" />
          </div>
        </article>

        <article class="process-card">
          <div>
            <span class="process-card__step">03</span>
            <h3 class="process-card__title">Settle</h3>
            <p class="process-card__text">Withdraw to any address, or settle between protocols. Relayers submit fee-bumped transactions. The chain sees a valid proof. Nothing more.</p>
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
        <h3 class="card__title">Confidential Payments</h3>
        <p class="card__text">Two-in, two-out transfers where amounts balance in zero knowledge. The chain verifies the math without seeing the numbers.</p>
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
      <h2 class="cta__title" id="cta-title">Step behind the veil.</h2>
      <p class="cta__subtitle">Vayyl is in active development. Request early access to the testnet and developer documentation.</p>
      <form class="form-group" id="cta-form" action="#" method="POST">
        <input
          type="email"
          class="form-input"
          id="cta-email"
          placeholder="you@protocol.xyz"
          required
          autocomplete="email"
          aria-label="Email address"
        />
        <button type="submit" class="btn btn--primary" id="cta-submit">
          <span id="cta-submit-text">Request access</span>
          <span class="btn__arrow">-&gt;</span>
        </button>
      </form>
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
          <h4 class="footer__col-title">Protocol</h4>
          <a href="#about" class="footer__link">Overview</a>
          <a href="#how-it-works" class="footer__link">How it works</a>
          <a href="#features" class="footer__link">Features</a>
          <a href="#architecture" class="footer__link">Architecture</a>
        </div>
        <div>
          <h4 class="footer__col-title">Developers</h4>
          <a href="#" class="footer__link">Documentation</a>
          <a href="#" class="footer__link">SDK Reference</a>
          <a href="#" class="footer__link">Circuits</a>
          <a href="#" class="footer__link">Audits</a>
        </div>
        <div>
          <h4 class="footer__col-title">Community</h4>
          <a href="#" class="footer__link">Discord</a>
          <a href="#" class="footer__link">Twitter / X</a>
          <a href="#" class="footer__link">GitHub</a>
          <a href="#" class="footer__link">Blog</a>
        </div>
      </div>
      <div class="footer__bottom">
        <span class="footer__copy">Copyright 2026 Vayyl. All rights reserved.</span>
        <div class="footer__socials">
          <a href="#" class="footer__social" aria-label="Twitter">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path></svg>
          </a>
          <a href="#" class="footer__social" aria-label="GitHub">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"></path></svg>
          </a>
          <a href="#" class="footer__social" aria-label="Discord">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"></path></svg>
          </a>
        </div>
      </div>
    </div>
  </footer>
`;
