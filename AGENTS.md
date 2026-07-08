# Vayyl Agent Guide

## Scope

This repo contains four independent toolchains:

- `frontend/`: Next.js App Router marketing page plus client-only React DApp.
- `contracts/`: Soroban contracts.
- `circuits/`: Circom/snarkjs circuits.
- `backend/`: indexer, relayer, keeper, oracle, and proof bridge.

For landing-page work, stay inside `frontend/src/app/`, `frontend/src/styles/`, `frontend/src/animations/`, and `frontend/public/` unless the user asks for DApp changes.

## Context7

Use Context7 MCP to fetch current documentation whenever a task asks about a library, framework, SDK, API, CLI tool, or cloud service. Start with `resolve-library-id`, then `query-docs` with the selected `/org/project` library ID and the full user question.

Do not use Context7 for refactoring, scripts from scratch, business-logic debugging, code review, or general programming concepts.

## Frontend Workflow

- Use `pnpm`, not `npm`, for project scripts and dependencies.
- Run frontend commands from `frontend/`.
- Use `pnpm build` as the default verification after landing-page changes.
- Use `pnpm dev` plus browser screenshots for visual work.
- Verify at least desktop `1440x900`, tablet `768x1024`, and mobile `390x844` for landing-page polish.
- Keep proof generation in a Web Worker. Do not move proving onto the main thread.
- The DApp route is `/app`; `/app.html` redirects there for old links.

## Design Workflow

- Use the repo-local Impeccable skill for frontend design work: `$impeccable critique landing`, `$impeccable polish landing`, `$impeccable layout landing`, `$impeccable typeset landing`, and `$impeccable live`.
- Treat `PRODUCT.md` as the strategic brief and `DESIGN.md` as the current visual-system capture.
- For Vayyl, the default landing-page register is `brand`: the page must communicate confidential settlement infrastructure, not just render a product UI.
- Prefer a mechanism-led narrative: shielded pools, commitments, nullifiers, Groth16 verification, native Stellar/Soroban BN254 host functions, and private positions.
- Avoid generic crypto/SaaS template tells: purple gradients, decorative orbs, endless icon-card grids, vague "platform" copy, glassmorphism by default, and unverified trust claims.

## Honesty Boundaries

- Do not overclaim production readiness. This project targets testnet unless the user provides current deployment evidence.
- Do not expose or persist secrets, wallet payloads, signatures, private keys, proof witness data, or raw delegation/permission payloads.
- Distinguish live functionality from roadmap items.

## Done Criteria

For frontend landing-page changes:

1. `pnpm build` passes in `frontend/`.
2. Rendered screenshots have been checked on desktop, tablet, and mobile.
3. No text overflow, blank animation-gated content, broken image/video assets, or incoherent overlap.
4. The final response reports what was changed and any verification that could not be run.
