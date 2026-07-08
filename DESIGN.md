---
name: Vayyl
description: Confidential settlement on Stellar using zero-knowledge proofs verified on Soroban.
colors:
  coral: "#F46F73"
  burnt-coral: "#E35C63"
  dusty-rose: "#CF5059"
  terracotta: "#B96858"
  clay-brown: "#8B5E52"
  ivory: "#F8F6F3"
  linen: "#F2EEEA"
  white: "#FFFFFF"
  charcoal: "#262321"
  taupe: "#655D58"
  stone: "#938B85"
  sand: "#DED5CF"
  beige: "#C8BCB4"
typography:
  display:
    fontFamily: "Cormorant Garamond, Georgia, Times New Roman, serif"
    fontSize: "clamp(3.5rem, 8vw, 8.5rem)"
    fontWeight: 300
    lineHeight: 1.05
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Cormorant Garamond, Georgia, Times New Roman, serif"
    fontSize: "clamp(2.5rem, 5vw, 4.5rem)"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  body:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(1rem, 1.125vw, 1.125rem)"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Manrope, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    letterSpacing: "0.15em"
  mono:
    fontFamily: "JetBrains Mono, Fira Code, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
rounded:
  sm: "6px"
  md: "12px"
  lg: "24px"
  xl: "32px"
  pill: "9999px"
spacing:
  xs: "0.5rem"
  sm: "1rem"
  md: "1.5rem"
  lg: "2.5rem"
  xl: "4rem"
  section: "6rem"
components:
  button-primary:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.white}"
    rounded: "{rounded.pill}"
    padding: "1rem 2.5rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ivory}"
    rounded: "{rounded.pill}"
    padding: "1rem 2.5rem"
  card:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.lg}"
    padding: "2.5rem"
  input-dark:
    backgroundColor: "#302D2B"
    textColor: "{colors.ivory}"
    rounded: "{rounded.pill}"
    padding: "1rem 1.5rem"
---

# Design System: Vayyl

## Overview

**Creative North Star: "The Confidential Ledger Room"**

The current system presents Vayyl as a quiet, high-trust privacy protocol with editorial typography, warm dark surfaces, coral accents, and cinematic scroll motion. The strongest visual assets are the dark hero/video layer, the proof-mechanism illustrations, and the contract architecture diagram. The weakest inherited traits are generic premium-template signals: soft glow orbs, broad warm-neutral surfaces, oversized rounded cards, and repeated section scaffolding.

The design should evolve toward mechanism-led infrastructure: more proof path, less decorative mystique. It should feel private, exact, and operational rather than vague or theatrical.

**Key Characteristics:**

- Dark confidential hero surfaces with coral as the primary action color.
- Warm off-white body sections for long-form technical explanation.
- Serif display type for brand voice and Manrope for readable explanation.
- Next.js App Router shell with GSAP-driven page choreography and reduced-motion fallbacks preserved.
- Diagrams and proof-flow visuals should carry more weight than generic card grids.

## Colors

The palette is warm, muted, and editorial today: charcoal and ivory provide the main contrast, while coral marks action, proof highlights, and state changes.

### Primary

- **Proof Coral**: The action and highlight color. Use for primary CTAs, verifier nodes, active strokes, and sparse proof-path emphasis.
- **Deep Charcoal**: The confidential surface. Use for hero, architecture, CTA, footer, and any high-conviction protocol moment.

### Secondary

- **Dusty Rose**: Hover and pressed state for coral actions.
- **Terracotta**: Secondary warmth for depth, not a competing CTA color.

### Neutral

- **Ivory Surface**: Primary light background for explanation sections.
- **Linen Surface**: Subtle alternate band background.
- **Taupe Body**: Main long-form body copy on light surfaces.
- **Stone Muted**: Labels and secondary text only when contrast remains readable.

### Named Rules

**The Coral Scarcity Rule.** Coral is strongest when rare. Use it for action and proof emphasis, not as ambient decoration.

**The No Privacy Fog Rule.** If a dark/glow treatment does not clarify privacy, proof, or settlement, remove it.

## Typography

**Display Font:** Cormorant Garamond with Georgia fallback.
**Body Font:** Manrope with system sans fallback.
**Label/Mono Font:** JetBrains Mono with code-font fallback.

**Character:** The current pairing is editorial and refined, but it risks reading template-like for a technical privacy protocol. Preserve it while polishing the current page; reassess the display family during a larger visual redesign.

### Hierarchy

- **Display** (300 italic, `clamp(3.5rem, 8vw, 8.5rem)`, 1.05): Current hero headline. Watch mobile overflow and avoid tighter tracking than `-0.04em`.
- **Headline** (400, `clamp(2.5rem, 5vw, 4.5rem)`, 1.1): Section-level statements.
- **Title** (500-600, `clamp(1.25rem, 2vw, 1.5rem)`, 1.3): Card and component titles.
- **Body** (400, `clamp(1rem, 1.125vw, 1.125rem)`, 1.6): Explanatory product copy. Keep line length under 75ch.
- **Label** (600, `0.8125rem`, `0.15em`, uppercase): Use sparingly. Repeated tiny uppercase labels are a known AI-template tell.

### Named Rules

**The Mechanism Before Mood Rule.** Headlines can be poetic, but supporting copy must name the actual protocol mechanism.

## Elevation

The current system uses soft ambient shadows, glow shadows, borders, and backdrop blur. This should be tightened: most protocol surfaces should be flat or structurally bordered; shadows should appear only for clear interactive lift or focus.

### Shadow Vocabulary

- **Subtle Surface** (`0 1px 3px rgba(38, 35, 33, 0.04), 0 1px 2px rgba(38, 35, 33, 0.06)`): Low depth for quiet surfaces.
- **Lifted Card** (`0 12px 40px rgba(38, 35, 33, 0.08), 0 4px 12px rgba(38, 35, 33, 0.04)`): Existing hover elevation. Use sparingly.
- **Coral Glow** (`0 0 40px rgba(244, 111, 115, 0.15)`): CTA emphasis only.

### Named Rules

**The Border Or Shadow Rule.** Do not pair a decorative 1px border with a wide soft shadow on the same card unless the state change earns it.

## Components

### Buttons

- **Shape:** Pill buttons (`9999px`) are the current command shape.
- **Primary:** Proof Coral background, white text, Manrope, medium weight, generous horizontal padding.
- **Hover / Focus:** Darken to Dusty Rose, translate slightly on hover, keep a visible focus state.
- **Ghost:** Transparent with light border on dark surfaces or charcoal border on light surfaces.

### Cards / Containers

- **Corner Style:** Current feature cards use large rounded corners (`24px`) and process cards use extra-large corners (`32px`).
- **Background:** Ivory or linen on light sections.
- **Shadow Strategy:** Flat at rest; hover lift only when the card is an actual interactive affordance.
- **Border:** Low-contrast taupe/stone border. Avoid colored side-stripes.
- **Internal Padding:** Large (`2.5rem`) on desktop; reduce on mobile.

### Inputs / Fields

- **Style:** Dark translucent field with pill radius, light border, ivory text.
- **Focus:** Coral border with subtle darkened background.
- **Placeholder:** Must meet readable contrast; do not leave it at washed-out gray if the CTA remains active.

### Navigation

The nav is fixed, sparse, and logo-forward. It starts over the dark hero and switches to a translucent ivory bar on scroll. Keep the nav quiet: one primary app launch action is enough for the landing page.

### Signature Components

The architecture SVG diagram and the horizontal Shield / Route / Settle cards are the current signature mechanisms. Future polish should make them feel less like decorative content blocks and more like evidence of the proof path.

## Do's and Don'ts

### Do:

- **Do** lead with Vayyl's proof path: commitments, nullifiers, Merkle inclusion, Groth16, and Soroban BN254 verification.
- **Do** keep reduced-motion behavior and ensure content is visible when animations are skipped.
- **Do** use Proof Coral for primary action and proof emphasis only.
- **Do** show testnet/project status honestly when making trust claims.
- **Do** verify mobile text wrapping and CTA/input sizing on narrow screens.

### Don't:

- **Don't** ship copied SaaS landing-page templates with interchangeable hero copy and icon-card grids.
- **Don't** use generic crypto neon, purple gradients, decorative glow orbs, or glassmorphism by default.
- **Don't** make vague privacy claims without showing the mechanism.
- **Don't** overclaim production readiness beyond current evidence.
- **Don't** add repeated tiny uppercase tracked labels above every section.
- **Don't** hide important content behind animation-only visibility states.
