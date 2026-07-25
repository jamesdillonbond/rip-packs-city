# Handoff — Candy quality-audit fixes (troll-ask floor guard + minor)

**Date:** 2026-07-24 · **Author:** Cowork · **For:** Claude Code (Trevor's machine)

## Context

Ran a data-quality audit over the shipped Candy stack (still gated, `is_active=false`). **The foundation is clean** — see the verified list at the bottom. One go-live blocker + three minor items follow. All evidence is live from Supabase `bxcqstmqfzmuolpuynti` on 2026-07-24 (203 active listings, 127 sales, 46/125 FMV-priced).

## Item 1 — HIGH (go-live blocker): troll / moonshot asks pollute the displayed FLOOR

**Evidence.** 28 of 203 active listings exceed $100; 3 exceed $1,000; the max ask is **$19,740.88 on `munetaka-murakami` (COMMON /250), whose FMV is $4.41**. Others: `andy-pages` $589 vs $3.83 FMV, `mason-miller` $368 vs $2.13, `munetaka-murakami-pink` (Rainbow) $5,389 vs $85. **16 editions have only a single active listing that is a troll** (>$100), so their `floor_ask_usd` = the troll price with no lower ask to override it.

**Consequence.** `candy_secondary_board.floor_ask_usd` (the **Market tab** — the primary surface) and `candy_offer_spread_board` (`floor_usd` / `spread_usd` / `spread_pct`) render these as the floor: e.g. "$589 floor" on a card that FMVs at $3.83, spreads up to **29,762%**. On the cold-tail editions (no FMV, e.g. most Rainbows) there's no reference value to blunt it. It's the classic troll-ask pollution ([[ts-nodata-troll-asks]] / [[market-sniper-fake-deals-thin-fmv]] class). Because the surface is gated it's **pre-launch, not a live incident** — but it's a visible-embarrassment blocker that should be fixed before the go-live flip.

**Not affected:** the **deals board is immune** — deals require `ask < FMV`, and trolls are `ask ≫ FMV`, so they never appear there (verified: 14 legitimate deals, 1–30% discounts, all LOW-flagged).

**Fix (recommended).** Guard the floor **at its source**: in `candy_listing_floor`, compute floor = `min(ask)` **excluding** asks above a troll ceiling = `max(K × fmv_usd, K × tier_median_fmv)` with **K ≈ 10** (tunable). The `tier_median_fmv` fallback covers cold-tail (null-FMV) editions. Confirm `candy_secondary_board` and `candy_offer_spread_board` consume that cleaned floor rather than their own raw `min(price_usd)`, and recompute `spread_usd` / `spread_pct` off it. Expose `excluded_troll_count` (or a `floor_capped` boolean) so the UI can footnote it. K=10 removes only the egregious (murakami 4,478×, andy-pages 154×, mason-miller 173×) while leaving legitimate above-FMV asks in a thin market. **The exact K and the "all asks are trolls → show null vs flagged" behavior are a brand/UX call — confirm with Trevor.**

**Files:** the `candy_listing_floor` / `candy_secondary_board` / `candy_offer_spread_board` view definitions (the committed parity migration .sql). **Revert:** restore the prior view defs.

## Item 2 — LOW–MED: thin-FMV can overstate a few deals

The deals board logic is sound, but an FMV computed from a single sale can inflate the discount on a few rows (`jordan-walker` FMV $18.49, `shohei-ohtani` $84.67 — both ~1 sale). **Already mitigated** by the `confidence=LOW` column shown on every row. Optional hardening: suppress or flag deals whose FMV is backed by `< N` sales (N≈2). Low priority — the LOW flag is honest.

## Item 3 — LOW (watch): `candy_deals_board` latency

One `SELECT *` timed out (>60s); a narrow `ORDER BY discount_pct LIMIT 20` returned instantly moments later — so likely load-sensitive rather than always-slow. Keep an eye on it on the public route (service_role 30s budget). If it recurs, add an index supporting the listings×FMV join or simplify the view.

## Item 4 — COSMETIC: `fmv_usd` renders to 4 decimals ($3.2500) on the deals/spread boards vs 2 elsewhere. Round to 2 in the view or formatter.

## Verified CLEAN (no action)

- **Integrity:** editions 125 (0 null player/tier/circ, 0 dup external_id); wmc 25,375 (0 null serials, 0 orphan edition_keys, **0 serials over circulation, 0 double-owned serials** — the stale-transfer bug did not occur); sales 127 (0 null edition, 0 wash self-trade, 0 bad price, 0 dup tx hash).
- **Listings resolution:** 203/203 matched to an edition (0 unmatched), 0 expired-but-active. The mint→edition path is solid.
- **Scarcity:** treasury correctly isolated (18,684 sealed / 6,691 circulating / 246 holders — matches independent calc).
- **Deals board logic:** sound; trolls correctly excluded.

## Guardrails

Direct to `main`, no branches. PowerShell `git`, re-verify push (`git rev-list --count origin/main..HEAD` = 0). `npx tsc --noEmit` clean + Vercel READY. Log Item 1 to `docs/overnight/ledger.md` with its revert. **Claude Code's file inspection wins over this doc — confirm the floor wiring across the three views before editing.**

## End state

Floor surfaces (Market tab + spread board) show a troll-guarded floor with sane spreads; deals board unchanged (already correct); cosmetics tidied. Then the only thing between here and a clean public debut is Trevor's go-live flip.
